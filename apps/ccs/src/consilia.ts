/**
 * Консилиумы (docs/01-concept.md, типы чатов; docs/08-video-ai.md, 5.4): комната с повесткой из нескольких случаев,
 * составом с ролями, звонком и протоколом по каждому случаю.
 *
 * Консилиум назначает МИС или онкорегистр (`consilium.upserted`): сервис создаёт комнату, приглашает состав и пишет
 * повестку. Председатель и секретарь (уровень 50) переключают текущий случай — по этим отметкам «Секретарь» делит
 * стенограмму. Черновики по случаям приходят в комнату консилиума; принятый протокол уходит в МИС на подпись и копией —
 * в чат случая.
 */
import { createHmac } from 'node:crypto';
import {
  ConsiliumContent,
  EventType,
  MsgType,
  ProtocolDraft,
  ReportStatusContent,
  RoomType,
  type AgendaItem,
  type ConsiliumMember,
  type ReportDeliveryContent,
} from '@konsilium/protocol';
import type { ConsiliumProtocolRequest, ConsiliumUpserted, EventResult } from '@konsilium/protocol/integration';
import type { CaseDirectory } from './cases.ts';
import type { CaseRoomService } from './caseRooms.ts';
import type { Connector, UserResolver } from './connectors.ts';
import { RetryLaterError, type Logger, type MatrixEvent } from './events.ts';
import { HostError } from './host.ts';
import { isTransient } from './integration.ts';
import { MatrixError, type MatrixApi } from './matrix.ts';
import { protocolBody } from './secretary.ts';

type Outcome = Omit<EventResult, 'id'>;

/** Уровни прав в комнате консилиума: ведущие переключают случай и принимают протоколы. */
const LEAD_LEVEL = 50;

export class ConsiliumService {
  constructor(
    private readonly deps: {
      matrix: MatrixApi;
      directory: CaseDirectory;
      caseRooms: CaseRoomService;
      users: UserResolver;
      log: Logger;
      aliasSecret: string;
      serverName: string;
    },
  ) {}

  /** Псевдоним комнаты: HMAC от подключения и номера консилиума (в пространстве имён сервиса `#c-…`). */
  aliasFor(connector: string, consiliumId: string): { localpart: string; alias: string } {
    const digest = createHmac('sha256', this.deps.aliasSecret).update(`consilium\n${connector}\n${consiliumId.trim().toUpperCase()}`).digest('hex').slice(0, 24);
    const localpart = `c-${digest}`;
    return { localpart, alias: `#${localpart}:${this.deps.serverName}` };
  }

  roomFor(connector: string, consiliumId: string): Promise<string | null> {
    return this.deps.matrix.resolveAlias(this.aliasFor(connector, consiliumId).alias);
  }

  /** Консилиум из МИС: создать комнату или привести её к новой версии (состав, роли, повестка). */
  async upsert(connector: Connector, data: ConsiliumUpserted): Promise<Outcome> {
    const warnings: string[] = [];
    const users = this.deps.users;
    const resolve = (u: Parameters<UserResolver['toMxid']>[0]) => {
      const id = users.toMxid(u);
      if (!id) warnings.push(`Пользователь ${users.describe(u)} не сопоставлен с учётной записью мессенджера`);
      return id;
    };

    const members: Record<string, ConsiliumMember> = {};
    for (const m of data.members) {
      const id = resolve(m.user);
      if (id) members[id] = { role: m.role, ...(m.title ? { title: m.title } : {}), ...(m.remote ? { remote: true } : {}) };
    }
    if (!Object.values(members).some((m) => m.role === 'chair')) return { status: 'rejected', detail: 'Председатель не сопоставлен с учётной записью мессенджера', warnings };

    const agenda: AgendaItem[] = [];
    for (const item of data.agenda) {
      const ref = { connector: item.connector ?? connector.id, caseId: item.case_id };
      const hostCase = await this.deps.directory.find(ref);
      if (!hostCase) return { status: 'rejected', detail: `Случай ${ref.connector}:${item.case_id} неизвестен: сначала отправьте case.upserted` };
      const presenter = item.presenter ? resolve(item.presenter) : null;
      agenda.push({
        connector: ref.connector,
        case_id: hostCase.snapshot.case_id,
        source: hostCase.source,
        title: hostCase.snapshot.title,
        patient: hostCase.snapshot.patient,
        ...(presenter ? { presenter } : {}),
        ...(item.purpose ? { purpose: item.purpose } : {}),
      });
    }

    const content = ConsiliumContent.parse({
      connector: connector.id,
      consilium_id: data.consilium_id,
      title: data.title,
      scheduled_at: data.scheduled_at,
      form: data.form,
      members,
      agenda,
      sync: { version: data.version, updated_at: data.updated_at },
    });
    const ok = (): Outcome => ({ status: 'accepted', ...(warnings.length ? { warnings } : {}) });

    const { localpart, alias } = this.aliasFor(connector.id, data.consilium_id);
    let roomId = await this.deps.matrix.resolveAlias(alias);
    if (!roomId) {
      try {
        await this.deps.matrix.createRoom(this.buildCreateRequest(content, localpart));
        return ok();
      } catch (e) {
        // Гонка между экземплярами сервиса: комнату создал другой — обновляем её как существующую.
        if (!(e instanceof MatrixError && e.errcode === 'M_ROOM_IN_USE')) throw e;
        roomId = await this.deps.matrix.resolveAlias(alias);
        if (!roomId) throw e;
      }
    }

    const current = ConsiliumContent.safeParse(await this.deps.matrix.getState(roomId, EventType.Consilium));
    if (current.success && current.data.sync.version > data.version) return { status: 'stale', detail: 'Версия консилиума меньше уже полученной' };
    if (current.success && current.data.sync.version === data.version) return ok();
    await this.deps.matrix.sendState(roomId, EventType.Consilium, '', content as unknown as Record<string, unknown>);
    if (!current.success || current.data.title !== content.title) await this.deps.matrix.sendState(roomId, 'm.room.name', '', { name: content.title });
    const pl = (await this.deps.matrix.getState<Record<string, unknown>>(roomId, 'm.room.power_levels')) ?? {};
    await this.deps.matrix.sendState(roomId, 'm.room.power_levels', '', { ...pl, users: this.leadLevels(content) });
    for (const userId of Object.keys(members)) {
      const m = await this.deps.matrix.getMembership(roomId, userId);
      if (m !== 'join' && m !== 'invite' && m !== 'ban') await this.deps.matrix.invite(roomId, userId, 'Состав консилиума');
    }
    for (const userId of Object.keys(current.success ? current.data.members : {})) {
      if (members[userId]) continue;
      const m = await this.deps.matrix.getMembership(roomId, userId);
      if (m === 'join' || m === 'invite') await this.deps.matrix.kick(roomId, userId, 'Исключён из состава консилиума');
    }
    return ok();
  }

  /** Права в комнате: председатель и секретарь — уровень 50. Создатель-сервис в комнатах версии 12 сюда не входит. */
  private leadLevels(c: ConsiliumContent): Record<string, number> {
    return Object.fromEntries(Object.entries(c.members).filter(([, m]) => m.role !== 'member').map(([id]) => [id, LEAD_LEVEL]));
  }

  private buildCreateRequest(content: ConsiliumContent, aliasLocalpart: string) {
    return {
      name: content.title,
      room_alias_name: aliasLocalpart,
      preset: 'private_chat' as const,
      visibility: 'private' as const,
      creation_content: { type: RoomType.Consilium },
      initial_state: [
        { type: EventType.Consilium, state_key: '', content: content as unknown as Record<string, unknown> },
        { type: EventType.ConsiliumCurrent, state_key: '', content: { index: 0 } },
        { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'shared' } },
        { type: 'm.room.guest_access', state_key: '', content: { guest_access: 'forbidden' } },
      ],
      invite: Object.keys(content.members).filter((u) => u !== this.deps.matrix.botUserId),
      power_level_content_override: {
        users: this.leadLevels(content),
        users_default: 0,
        events_default: 0,
        state_default: 100,
        invite: 100,
        kick: 100,
        ban: 100,
        redact: 50,
        events: {
          [EventType.Consilium]: 100,
          [EventType.ConsiliumCurrent]: LEAD_LEVEL,
          // Принять или отклонить черновик протокола — только председатель и секретарь.
          [EventType.ReportStatus]: LEAD_LEVEL,
          [EventType.ReportDelivery]: 100,
          [EventType.Call]: 0,
          'm.room.name': 100,
          'm.room.power_levels': 100,
          'm.room.history_visibility': 100,
        },
      },
    };
  }

  /**
   * Черновик протокола принят в комнате консилиума: копия — в чат случая, протокол — в МИС на подпись,
   * итог передачи — событием `ru.vendor.report.delivery` рядом с черновиком. Права проверил сервер (уровень 50).
   */
  async onReportStatus(event: MatrixEvent): Promise<void> {
    const status = ReportStatusContent.safeParse(event.content);
    if (!status.success || status.data.status !== 'accepted') return;
    const consilium = ConsiliumContent.safeParse(await this.deps.matrix.getState(event.room_id, EventType.Consilium).catch(() => null));
    if (!consilium.success) return; // не консилиум: черновик звонка в чате случая — без передачи в МИС
    const draftId = status.data['m.relates_to'].event_id;
    const raw = await this.deps.matrix.getEvent(event.room_id, draftId);
    const draft = ProtocolDraft.safeParse(raw?.content);
    if (!draft.success || raw?.sender !== this.deps.matrix.botUserId) return;
    const d = draft.data[MsgType.Report];
    const item = d.agenda ? consilium.data.agenda[d.agenda.index] : undefined;
    if (!d.case || !item || item.case_id !== d.case.case_id) return;

    const acceptedAt = new Date().toISOString();
    const name = (await this.deps.matrix.displayName(event.sender).catch(() => null)) ?? event.sender;
    await this.copyToCaseChat(item, d, { by: event.sender, name, at: acceptedAt }, draftId);
    const delivery = await this.deliver(consilium.data, item, d, event, acceptedAt, draftId);
    await this.deps.matrix.sendEvent(event.room_id, EventType.ReportDelivery, delivery as unknown as Record<string, unknown>, `delivery.${draftId}`);
  }

  /** Копия принятого протокола в чат случая: команда случая видит решение. Без ссылок на стенограмму — она в консилиуме. */
  private async copyToCaseChat(item: AgendaItem, d: ProtocolDraft[typeof MsgType.Report], accepted: { by: string; name: string; at: string }, draftId: string) {
    const hostCase = await this.deps.directory.find({ connector: item.connector, caseId: item.case_id });
    if (!hostCase) return;
    const { roomId } = await this.deps.caseRooms.getOrCreate(hostCase);
    const strip = (xs: typeof d.sections.purpose) => xs.map(({ refs: _refs, ...rest }) => ({ ...rest, refs: [] }));
    const { transcript_event_id: _t, ...rest } = d;
    const copy: ProtocolDraft[typeof MsgType.Report] = {
      ...rest,
      status: 'accepted',
      accepted,
      sections: {
        purpose: strip(d.sections.purpose),
        clinical: strip(d.sections.clinical),
        discussion: strip(d.sections.discussion),
        decision: strip(d.sections.decision),
        dissent: strip(d.sections.dissent),
      },
    };
    const content = ProtocolDraft.parse({ msgtype: MsgType.Report, body: protocolBody(copy), [MsgType.Report]: copy });
    await this.deps.matrix.sendEvent(roomId, 'm.room.message', content as unknown as Record<string, unknown>, `protocol.${draftId}`);
  }

  /** Протокол — в систему, назначившую консилиум. Нет обратных вызовов — честно говорим, что переносить вручную. */
  private async deliver(
    consilium: ConsiliumContent,
    item: AgendaItem,
    d: ProtocolDraft[typeof MsgType.Report],
    event: MatrixEvent,
    acceptedAt: string,
    draftId: string,
  ): Promise<ReportDeliveryContent> {
    const relates = { rel_type: 'm.reference' as const, event_id: draftId };
    const callbacks = this.deps.directory.callbacks(consilium.connector);
    if (!callbacks) return { 'm.relates_to': relates, status: 'failed', note: 'Передача в МИС не подключена — перенесите протокол вручную («Копировать текст»)' };
    const statements = (xs: typeof d.sections.purpose) => xs.map((s) => ({ ...(s.speaker ? { speaker: s.speaker } : {}), text: s.text }));
    const req: ConsiliumProtocolRequest = {
      consilium_id: consilium.consilium_id,
      case: { connector: item.connector, case_id: item.case_id },
      meeting: d.meeting,
      participants: d.participants.map((p) => ({ user: this.deps.users.toRef(p.mxid), ...(p.role ? { role: p.role } : {}) })),
      sections: {
        purpose: statements(d.sections.purpose),
        clinical: statements(d.sections.clinical),
        discussion: statements(d.sections.discussion),
        decision: statements(d.sections.decision),
        dissent: statements(d.sections.dissent),
      },
      generated_by: d.generated_by,
      accepted_by: this.deps.users.toRef(event.sender),
      accepted_at: acceptedAt,
      chat: { room_id: event.room_id, event_id: draftId },
    };
    try {
      const r = await callbacks.consiliumProtocol(req, draftId);
      return { 'm.relates_to': relates, status: r.status, protocol_id: r.protocol_id, ...(r.signers !== undefined ? { signers: r.signers } : {}), system: 'МИС' };
    } catch (e) {
      // МИС недоступна — Synapse повторит транзакцию; копия в чате случая не задвоится (тот же txnId).
      if (isTransient(e)) throw new RetryLaterError(`МИС недоступна: ${(e as Error).message}`);
      this.deps.log.warn({ err: e, draftId }, 'МИС отклонила протокол консилиума');
      return { 'm.relates_to': relates, status: 'failed', system: 'МИС', note: e instanceof HostError ? `МИС ответила ${e.status}` : 'МИС отклонила протокол' };
    }
  }
}
