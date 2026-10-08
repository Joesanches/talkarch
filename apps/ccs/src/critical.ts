/**
 * Критические находки: адресат по роли, срок подтверждения, эскалация, журнал (docs/03-architecture.md, 5.3).
 *
 * Находку отправляет врач-диагност в чате случая (`ru.vendor.critical`) или система-источник событием `critical.raised`.
 * Сервис определяет адресатов, ведёт таймер и пишет статус state-событием `ru.vendor.critical.status` — его может
 * писать только сервис, поэтому клиенты верят ему, а не сырым подтверждениям. Подтверждение (`ru.vendor.ack`)
 * засчитывается только от адресата или подключённого эскалацией. Итог уходит в систему-источник обратным вызовом.
 */
import { createHash } from 'node:crypto';
import {
  AckContent,
  CaseContext,
  CaseRole,
  CriticalMessage,
  EventType,
  MsgType,
  durationSeconds,
  type CaseRolesContent,
  type CriticalStatusContent,
} from '@konsilium/protocol';
import type { CriticalFindingEvent, CriticalFindingSummary, CriticalRaised } from '@konsilium/protocol/integration';
import type { CaseDirectory } from './cases.ts';
import type { CaseRoomService } from './caseRooms.ts';
import type { Connector, ConnectorRegistry, UserResolver } from './connectors.ts';
import type { Logger, MatrixEvent } from './events.ts';
import { formatDelay, roleName } from './labels.ts';
import { MatrixError, type MatrixApi } from './matrix.ts';

export interface PlanStep {
  afterS: number;
  action: 'notify' | 'call';
  target: string;
  users: string[];
}

export interface Escalation {
  step: number;
  at: number;
  action: 'notify' | 'call';
  target: string;
  users: string[];
  delivered?: boolean;
}

export interface CriticalFinding {
  eventId: string;
  roomId: string;
  connector: string;
  caseId: string;
  hostFindingId?: string;
  reportedBy: string;
  raisedAt: number;
  deadlineAt: number;
  recipients: string[];
  plan: PlanStep[];
  escalations: Escalation[];
  status: 'pending' | 'acknowledged';
  ackBy?: string;
  ackAt?: number;
  /** Когда выполнить следующий шаг эскалации; `null` — шагов не осталось или находка подтверждена. */
  nextAt: number | null;
}

/** Хранилище находок. Текст находки не хранится — он в чате; здесь только адресаты, сроки и журнал. */
export interface CriticalStore {
  /** `false` — такая находка уже есть (повтор события). */
  add(f: CriticalFinding): Promise<boolean>;
  get(eventId: string): Promise<CriticalFinding | null>;
  byHostId(connector: string, hostFindingId: string): Promise<CriticalFinding | null>;
  /**
   * Взять находки, у которых подошёл срок шага, — с арендой на `leaseMs`: другой экземпляр сервиса их не возьмёт,
   * а если этот упадёт, шаг повторится после аренды.
   */
  claimDue(now: number, leaseMs: number, limit: number): Promise<CriticalFinding[]>;
  /** Записать шаг эскалации, если находка ещё не подтверждена. `false` — уже подтверждена. */
  recordEscalation(eventId: string, escalation: Escalation, recipients: string[], nextAt: number | null): Promise<boolean>;
  /** Шагов эскалации не осталось — больше не проверять. */
  clearNext(eventId: string): Promise<void>;
  /** Подтвердить, если ещё не подтверждена (атомарно). `null` — уже подтверждена или нет такой. */
  acknowledge(eventId: string, by: string, at: number): Promise<CriticalFinding | null>;
  list(connector: string, since: number): Promise<CriticalFinding[]>;
  /** Есть ли в комнате неподтверждённая находка (такой чат не уходит в архив). */
  pendingInRoom(roomId: string): Promise<boolean>;
}

export class InMemoryCriticalStore implements CriticalStore {
  private readonly items = new Map<string, CriticalFinding>();

  async add(f: CriticalFinding) {
    if (this.items.has(f.eventId)) return false;
    if (f.hostFindingId && (await this.byHostId(f.connector, f.hostFindingId))) return false;
    this.items.set(f.eventId, structuredClone(f));
    return true;
  }
  async get(eventId: string) {
    const f = this.items.get(eventId);
    return f ? structuredClone(f) : null;
  }
  async byHostId(connector: string, hostFindingId: string) {
    const f = [...this.items.values()].find((x) => x.connector === connector && x.hostFindingId === hostFindingId);
    return f ? structuredClone(f) : null;
  }
  async claimDue(now: number, leaseMs: number, limit: number) {
    const due = [...this.items.values()]
      .filter((f) => f.status === 'pending' && f.nextAt !== null && f.nextAt <= now)
      .sort((a, b) => a.nextAt! - b.nextAt!)
      .slice(0, limit);
    for (const f of due) f.nextAt = now + leaseMs;
    return due.map((f) => structuredClone(f));
  }
  async recordEscalation(eventId: string, escalation: Escalation, recipients: string[], nextAt: number | null) {
    const f = this.items.get(eventId);
    if (!f || f.status !== 'pending') return false;
    f.escalations.push(escalation);
    f.recipients = recipients;
    f.nextAt = nextAt;
    return true;
  }
  async clearNext(eventId: string) {
    const f = this.items.get(eventId);
    if (f) f.nextAt = null;
  }
  async acknowledge(eventId: string, by: string, at: number) {
    const f = this.items.get(eventId);
    if (!f || f.status !== 'pending') return null;
    Object.assign(f, { status: 'acknowledged', ackBy: by, ackAt: at, nextAt: null });
    return structuredClone(f);
  }
  async list(connector: string, since: number) {
    return [...this.items.values()].filter((f) => f.connector === connector && f.raisedAt >= since).map((f) => structuredClone(f));
  }
  async pendingInRoom(roomId: string) {
    return [...this.items.values()].some((f) => f.roomId === roomId && f.status === 'pending');
  }
}

/** Кто может отправить критическую находку: врачи-диагносты и заведующий. */
export const REPORTER_ROLES: ReadonlySet<CaseRole> = new Set(['radiologist', 'pathologist', 'head']);

const iso = (ms: number) => new Date(ms).toISOString();
const key = (...parts: string[]) => createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32);

export class CriticalService {
  /** Обратные вызовы в работе — тесты дожидаются их через `idle()`. */
  private readonly inflight = new Set<Promise<void>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(
    private readonly deps: {
      matrix: MatrixApi;
      store: CriticalStore;
      directory: CaseDirectory;
      caseRooms: CaseRoomService;
      connectors: ConnectorRegistry;
      users: UserResolver;
      log: Logger;
      now?: () => number;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  // ── Отправка ─────────────────────────────────────────────────────────────

  /** Находка из чата: сообщение `ru.vendor.critical` от участника. */
  async onMessage(event: MatrixEvent): Promise<void> {
    const ctx = await this.caseContext(event.room_id);
    if (!ctx) return;
    const parsed = CriticalMessage.safeParse(event.content);
    const roles = await this.roles(event.room_id);
    const reject = (note: string) =>
      this.writeStatus(event.room_id, event.event_id, {
        status: 'rejected',
        raised_at: iso(this.now()),
        deadline_at: iso(this.now()),
        recipients: [],
        reported_by: event.sender,
        escalations: [],
        note,
      });
    if (!parsed.success) {
      this.deps.log.warn({ eventId: event.event_id }, 'Некорректная критическая находка');
      return reject('Сообщение не по формату критической находки');
    }
    const role = roles[event.sender]?.role;
    if (!role || !REPORTER_ROLES.has(role)) {
      return reject('Критическую находку отправляет врач-диагност (рентгенолог, патоморфолог) или заведующий');
    }
    const c = parsed.data[MsgType.Critical];
    // Сообщение формирует клиент, поэтому из него берём только то, что не расширяет доступ: явные адресаты —
    // лишь участники случая (иначе отправитель приглашал бы в чат кого угодно), план эскалации — только организации.
    if (c.escalation.length) this.deps.log.warn({ eventId: event.event_id }, 'План эскалации из чата не принимается — используется план подключения');
    await this.register({
      eventId: event.event_id,
      roomId: event.room_id,
      connector: ctx.connector,
      caseId: ctx.case_id,
      reportedBy: event.sender,
      finding: c.finding,
      recipientRole: c.recipient.role,
      recipientUsers: c.recipient.users.filter((u) => u in roles),
      deadlineS: durationSeconds(c.ack_deadline),
      plan: null,
      roles,
    });
  }

  /** Находка из РИС/ЛИС (`critical.raised`): сообщение в чат случая от имени сервиса, дальше — как из чата. */
  async onRaised(connector: Connector, data: CriticalRaised, integrationEventId: string): Promise<{ status: 'accepted' | 'duplicate' | 'rejected'; detail?: string }> {
    if (await this.deps.store.byHostId(connector.id, data.finding_id)) return { status: 'duplicate', detail: `Находка ${data.finding_id} уже отправлена` };
    const hostCase = await this.deps.directory.find({ connector: connector.id, caseId: data.case_id });
    if (!hostCase) return { status: 'rejected', detail: 'Случай неизвестен: сначала отправьте case.upserted' };
    const reportedBy = this.deps.users.toMxid(data.reported_by);
    if (!reportedBy) return { status: 'rejected', detail: 'Не удалось сопоставить reported_by с учётной записью' };
    const recipientUsers = data.recipient.users.flatMap((u) => this.deps.users.toMxid(u) ?? []);
    const { roomId } = await this.deps.caseRooms.getOrCreate(hostCase);
    const roles = await this.roles(roomId);
    const reporterName = await this.name(reportedBy, roles);
    const eventId = await this.deps.matrix.sendEvent(
      roomId,
      'm.room.message',
      {
        msgtype: MsgType.Critical,
        body: `Критическая находка: ${data.finding}\n(${reporterName}, ${connector.title})`,
        [MsgType.Critical]: {
          finding: data.finding,
          recipient: { ...(data.recipient.role ? { role: data.recipient.role } : {}), users: recipientUsers },
          ack_required: true,
          ack_deadline: data.ack_deadline,
          escalation: [],
          reported_by: reportedBy,
          host_finding_id: data.finding_id,
        },
      },
      `crit.${key(connector.id, integrationEventId)}`,
    );
    const plan = data.escalation?.map((s) => ({
      afterS: durationSeconds(s.after),
      action: s.action,
      target: s.target,
      users: s.users.flatMap((u) => this.deps.users.toMxid(u) ?? []),
    }));
    await this.register({
      eventId,
      roomId,
      connector: connector.id,
      caseId: hostCase.snapshot.case_id,
      hostFindingId: data.finding_id,
      reportedBy,
      finding: data.finding,
      recipientRole: data.recipient.role,
      recipientUsers,
      deadlineS: durationSeconds(data.ack_deadline),
      plan: plan ?? null,
      roles,
      fromHost: true,
    });
    return { status: 'accepted' };
  }

  private async register(r: {
    eventId: string;
    roomId: string;
    connector: string;
    caseId: string;
    hostFindingId?: string;
    reportedBy: string;
    finding: string;
    recipientRole?: CaseRole;
    recipientUsers: string[];
    deadlineS: number;
    plan: PlanStep[] | null;
    roles: CaseRolesContent['members'];
    fromHost?: boolean;
  }) {
    const now = this.now();
    const byRole = r.recipientRole ? Object.entries(r.roles).filter(([, a]) => a.role === r.recipientRole).map(([id]) => id) : [];
    const recipients = [...new Set([...r.recipientUsers, ...byRole])].filter((u) => u !== r.reportedBy);
    const plan = r.plan ?? this.defaultPlan(r.connector, r.deadlineS);
    // Адресата нет (роль в случае не назначена) — сразу к первому шагу эскалации. Пустой план — без эскалации.
    const nextAt = !plan[0] ? null : !recipients.length ? now : now + plan[0].afterS * 1000;
    const finding: CriticalFinding = {
      eventId: r.eventId,
      roomId: r.roomId,
      connector: r.connector,
      caseId: r.caseId,
      ...(r.hostFindingId ? { hostFindingId: r.hostFindingId } : {}),
      reportedBy: r.reportedBy,
      raisedAt: now,
      deadlineAt: now + r.deadlineS * 1000,
      recipients,
      plan,
      escalations: [],
      status: 'pending',
      nextAt,
    };
    if (!(await this.deps.store.add(finding))) return; // повтор транзакции или события

    await this.writeStatus(r.roomId, r.eventId, this.statusOf(finding));
    for (const u of recipients) await this.deps.caseRooms.ensureMember(r.roomId, u).catch((err) => this.deps.log.warn({ err }, 'Не удалось пригласить адресата'));
    const names = await Promise.all(recipients.map((u) => this.name(u, r.roles)));
    await this.notice(
      r.roomId,
      recipients.length
        ? `Критическая находка → ${names.join(', ')}: требуется подтверждение получения в течение ${formatDelay(r.deadlineS)}.`
        : `Критическая находка: адресат с ролью «${roleName(r.recipientRole ?? '—')}» в случае не назначен — сразу эскалация.`,
      recipients,
      `crit-raised.${r.eventId}`,
    );
    this.deps.log.info({ roomId: r.roomId, eventId: r.eventId, recipients: recipients.length }, 'Критическая находка зарегистрирована');
    if (!r.fromHost) {
      this.toHost(r.connector, {
        type: 'raised',
        finding_id: r.eventId,
        case_id: r.caseId,
        at: iso(now),
        finding: r.finding,
        reported_by: this.deps.users.toRef(r.reportedBy),
        recipients: recipients.map((u) => this.deps.users.toRef(u)),
        deadline_at: iso(finding.deadlineAt),
      });
    }
  }

  /** План подключения или, если его нет, — «по истечении срока подключить заведующего». */
  private defaultPlan(connectorId: string, deadlineS: number): PlanStep[] {
    const configured = this.deps.connectors.get(connectorId)?.critical?.escalation ?? [];
    if (configured.length) {
      return configured.map((s) => ({
        afterS: durationSeconds(s.after),
        action: s.action,
        target: s.target,
        users: s.users.flatMap((login) => this.deps.users.toMxid({ login }) ?? []),
      }));
    }
    return [{ afterS: deadlineS, action: 'notify', target: 'head', users: [] }];
  }

  // ── Подтверждение ────────────────────────────────────────────────────────

  async onAck(event: MatrixEvent): Promise<void> {
    const parsed = AckContent.safeParse(event.content);
    if (!parsed.success) return;
    const target = parsed.data['m.relates_to'].event_id;
    const f = await this.deps.store.get(target);
    if (!f || f.roomId !== event.room_id || f.status !== 'pending') return;
    if (!f.recipients.includes(event.sender)) {
      const roles = await this.roles(f.roomId);
      const names = await Promise.all(f.recipients.map((u) => this.name(u, roles)));
      await this.notice(f.roomId, `Подтверждение не засчитано: подтверждает адресат находки${names.length ? ` (${names.join(', ')})` : ''}.`, [event.sender], `crit-ack-denied.${event.event_id}`);
      return;
    }
    const at = this.now();
    const done = await this.deps.store.acknowledge(f.eventId, event.sender, at);
    if (!done) return;
    const seconds = Math.round((at - done.raisedAt) / 1000);
    await this.writeStatus(done.roomId, done.eventId, this.statusOf(done));
    const roles = await this.roles(done.roomId);
    const late = at > done.deadlineAt ? ' (позже срока)' : '';
    await this.notice(
      done.roomId,
      `Получение критической находки подтверждено: ${await this.name(event.sender, roles)}, через ${formatDelay(seconds)}${late}.`,
      [done.reportedBy],
      `crit-ack.${done.eventId}`,
    );
    this.deps.log.info({ eventId: done.eventId, seconds }, 'Критическая находка подтверждена');
    this.toHost(done.connector, {
      type: 'acknowledged',
      finding_id: done.eventId,
      ...(done.hostFindingId ? { host_finding_id: done.hostFindingId } : {}),
      case_id: done.caseId,
      at: iso(at),
      acknowledged_by: this.deps.users.toRef(event.sender),
      seconds_to_ack: seconds,
    });
  }

  // ── Эскалация ────────────────────────────────────────────────────────────

  /** Запустить проверку сроков. `intervalMs` — шаг таймера (точность эскалации). */
  start(intervalMs: number) {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Один проход: выполнить шаги эскалации, срок которых подошёл. Возвращает число выполненных шагов. */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    let done = 0;
    try {
      const due = await this.deps.store.claimDue(this.now(), 60_000, 20);
      for (const f of due) {
        try {
          if (await this.escalate(f)) done += 1;
        } catch (err) {
          // Аренда истечёт, и шаг повторится; сообщения в чат идемпотентны по txnId.
          this.deps.log.error({ err, eventId: f.eventId }, 'Шаг эскалации не выполнен');
        }
      }
    } catch (err) {
      this.deps.log.error({ err }, 'Проверка сроков критических находок не удалась');
    } finally {
      this.ticking = false;
    }
    return done;
  }

  private async escalate(f: CriticalFinding): Promise<boolean> {
    const index = f.escalations.length;
    const step = f.plan[index];
    if (!step) {
      await this.deps.store.clearNext(f.eventId);
      return false;
    }
    const now = this.now();
    const roles = await this.roles(f.roomId);
    const byRole = CaseRole.safeParse(step.target).success ? Object.entries(roles).filter(([, a]) => a.role === step.target).map(([id]) => id) : [];
    const users = step.action === 'notify' ? [...new Set([...step.users, ...byRole])].filter((u) => u !== f.reportedBy) : [];
    let delivered: boolean | undefined;
    if (step.action === 'call') delivered = !!this.deps.directory.callbacks(f.connector);
    const escalation: Escalation = { step: index + 1, at: now, action: step.action, target: step.target, users, ...(delivered !== undefined ? { delivered } : {}) };
    const recipients = [...new Set([...f.recipients, ...users])];
    const next = f.plan[index + 1];
    const nextAt = next ? Math.max(now, f.raisedAt + next.afterS * 1000) : null;
    if (!(await this.deps.store.recordEscalation(f.eventId, escalation, recipients, nextAt))) return false; // успели подтвердить

    // Сначала статус, затем приглашение: в приглашение попадает уже обновлённый статус (room_prejoin_state),
    // и подключённый эскалацией видит «!» в списке чатов до входа. Доступ к чату — смысл шага (запись — в журнале комнаты).
    const updated: CriticalFinding = { ...f, escalations: [...f.escalations, escalation], recipients, nextAt };
    await this.writeStatus(f.roomId, f.eventId, this.statusOf(updated));
    for (const u of users) await this.deps.caseRooms.ensureMember(f.roomId, u).catch((err) => this.deps.log.warn({ err }, 'Не удалось пригласить по эскалации'));

    const waited = formatDelay((now - f.raisedAt) / 1000);
    const names = await Promise.all(users.map((u) => this.name(u, roles)));
    const text =
      step.action === 'call'
        ? `Нет подтверждения критической находки ${waited} — звонок на «${step.target}»: ${delivered ? 'передан в систему-источник' : 'телефония не подключена, позвоните вручную'}.`
        : names.length
          ? `Нет подтверждения критической находки ${waited} — эскалация: подключён ${names.join(', ')} (${roleName(step.target)}). Подтвердить получение может любой адресат.`
          : `Нет подтверждения критической находки ${waited} — эскалация на «${roleName(step.target)}», но в случае такой роли нет. Нужна реакция отделения.`;
    await this.notice(f.roomId, text, [...users, f.reportedBy], `crit-esc.${f.eventId}.${index + 1}`);
    this.deps.log.warn({ eventId: f.eventId, step: index + 1, action: step.action }, 'Эскалация критической находки');
    this.toHost(f.connector, {
      type: 'escalated',
      finding_id: f.eventId,
      ...(f.hostFindingId ? { host_finding_id: f.hostFindingId } : {}),
      case_id: f.caseId,
      at: iso(now),
      escalation: { step: index + 1, action: step.action, target: step.target, users: users.map((u) => this.deps.users.toRef(u)) },
    });
    return true;
  }

  // ── Отчёт ────────────────────────────────────────────────────────────────

  async report(connector: string, since: number): Promise<CriticalFindingSummary[]> {
    const items = await this.deps.store.list(connector, since);
    return items
      .sort((a, b) => a.raisedAt - b.raisedAt)
      .map((f) => ({
        finding_id: f.eventId,
        ...(f.hostFindingId ? { host_finding_id: f.hostFindingId } : {}),
        case_id: f.caseId,
        status: f.status,
        raised_at: iso(f.raisedAt),
        deadline_at: iso(f.deadlineAt),
        reported_by: this.deps.users.toRef(f.reportedBy),
        ...(f.ackBy && f.ackAt
          ? { acknowledged_by: this.deps.users.toRef(f.ackBy), acknowledged_at: iso(f.ackAt), seconds_to_ack: Math.round((f.ackAt - f.raisedAt) / 1000) }
          : {}),
        overdue: (f.ackAt ?? this.now()) > f.deadlineAt,
        escalations: f.escalations.map((e) => ({ step: e.step, at: iso(e.at), action: e.action, target: e.target })),
      }));
  }

  /** Дождаться отправки обратных вызовов (тесты). */
  async idle() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  // ── Вспомогательное ──────────────────────────────────────────────────────

  statusOf(f: CriticalFinding): CriticalStatusContent {
    const next = f.status === 'pending' && f.nextAt !== null ? f.nextAt : null;
    return {
      status: f.status,
      raised_at: iso(f.raisedAt),
      deadline_at: iso(f.deadlineAt),
      recipients: f.recipients,
      reported_by: f.reportedBy,
      escalations: f.escalations.map((e) => ({
        at: iso(e.at),
        action: e.action,
        target: e.target,
        users: e.users,
        ...(e.delivered !== undefined ? { delivered: e.delivered } : {}),
      })),
      ...(next !== null && f.plan[f.escalations.length] ? { next_escalation_at: iso(next) } : {}),
      ...(f.ackBy && f.ackAt ? { acknowledged: { by: f.ackBy, at: iso(f.ackAt), seconds: Math.round((f.ackAt - f.raisedAt) / 1000) } } : {}),
    };
  }

  private async writeStatus(roomId: string, eventId: string, content: CriticalStatusContent) {
    await this.deps.matrix.sendState(roomId, EventType.CriticalStatus, eventId, content as unknown as Record<string, unknown>);
  }

  /** Служебное сообщение с упоминаниями: у упомянутых сработают уведомления (push-правило упоминания). */
  private async notice(roomId: string, body: string, mentions: string[], txnId: string) {
    await this.deps.matrix.sendEvent(roomId, 'm.room.message', { msgtype: 'm.notice', body, 'm.mentions': { user_ids: [...new Set(mentions)] } }, txnId);
  }

  private async caseContext(roomId: string): Promise<CaseContext | null> {
    try {
      const parsed = CaseContext.safeParse(await this.deps.matrix.getState(roomId, EventType.CaseContext));
      return parsed.success ? parsed.data : null;
    } catch (e) {
      if (e instanceof MatrixError && e.status < 500) return null;
      throw e;
    }
  }

  private async roles(roomId: string): Promise<CaseRolesContent['members']> {
    const r = await this.deps.matrix.getState<CaseRolesContent>(roomId, EventType.CaseRoles).catch(() => null);
    return r?.members ?? {};
  }

  private async name(userId: string, roles: CaseRolesContent['members']): Promise<string> {
    const display = (await this.deps.matrix.displayName(userId).catch(() => null)) ?? userId.slice(1, userId.indexOf(':'));
    const role = roles[userId]?.role;
    return role ? `${display} (${roleName(role)})` : display;
  }

  /** Обратный вызов в систему-источник: в фоне, три попытки. В продукте — исходящая очередь (outbox). */
  private toHost(connectorId: string, event: CriticalFindingEvent) {
    const callbacks = this.deps.directory.callbacks(connectorId);
    if (!callbacks) return; // уровень 1: система заберёт итоги через GET /integration/v1/critical-findings
    const idem = `${event.finding_id}:${event.type}:${event.escalation?.step ?? 0}`;
    const run = (async () => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await callbacks.criticalEvent(event, idem);
          return;
        } catch (err) {
          this.deps.log.warn({ err, attempt, type: event.type }, 'Система-источник не приняла событие критической находки');
          if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1000));
        }
      }
    })();
    this.inflight.add(run);
    void run.finally(() => this.inflight.delete(run));
  }
}
