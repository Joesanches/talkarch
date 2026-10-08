/**
 * Архив чатов случаев (docs/03-architecture.md, 3.4 и 9.1, правило 5).
 *
 * - Случай закрыт или отменён в системе-источнике, а в чате N дней нет активности → комната уходит в архив:
 *   состояние `ru.vendor.case.archive`, писать может только сервис, участники выводятся. История сохраняется
 *   (`history_visibility: shared`) — вернувшийся видит её целиком.
 * - Пока в чате есть неподтверждённая критическая находка, он в архив не уходит.
 * - Возврат по требованию: пользователь открыл архивный случай (папка «Архив», ссылка из РИС/ЛИС) — сервис снова
 *   приглашает его, только для чтения; возврат пишется в журнал. Через `returnMs` вернувшийся снова выводится.
 * - Случай снова открыт в системе-источнике → комната возвращается из архива, участников по ролям приглашает
 *   синхронизация (CaseRoomService).
 *
 * Выведенные остаются в комнате со статусом leave. Sliding Sync отдаёт такие комнаты в списке, пока пользователь
 * их не «забудет» (`/forget`), — это делает клиент (apps/web/src/matrix.ts, forgetArchived).
 */
import { EventType, caseKey, type ArchivedCase, type CaseArchiveContent, type SourceSystem } from '@konsilium/protocol';
import type { HostCase } from './cases.ts';
import type { Logger } from './events.ts';
import { MatrixError, type MatrixApi, type Membership } from './matrix.ts';

export interface CaseInfo {
  caseKey: string;
  connector: string;
  caseId: string;
  title: string;
  source: SourceSystem;
}

export interface ArchivedRoom extends CaseInfo {
  roomId: string;
  archivedAt: number;
}

/** Состояние чатов случаев для архива. В продукте — PostgreSQL (db.ts), в модульных тестах — память. */
export interface ArchiveStore {
  /** Случай комнаты и его состояние: закрыт — запоминается первое время закрытия, снова открыт — сбрасывается. */
  track(roomId: string, info: CaseInfo, closed: boolean, at: number): Promise<void>;
  /** Активность пользователей в чате (в архивном не учитывается). */
  touch(roomId: string, at: number): Promise<void>;
  /**
   * Взять комнаты, которым пора в архив: случай закрыт, комната не в архиве, активности не было с `idleBefore`.
   * Комнаты сразу помечаются архивными — параллельный экземпляр сервиса их не возьмёт.
   */
  claimDue(idleBefore: number, at: number, limit: number): Promise<string[]>;
  /** Архивирование не удалось или отложено: комната снова ждёт следующего прохода. */
  release(roomId: string): Promise<void>;
  /** Кого вывели из комнаты при архивировании — для папки «Архив» и возврата. */
  addMembers(roomId: string, userIds: string[]): Promise<void>;
  isArchived(roomId: string): Promise<boolean>;
  /**
   * Комната вернулась из архива — случай снова открыт: не в архиве, не закрыт (сразу, а не после синхронизации со
   * снимком — иначе проход архива успеет отправить её обратно), список выведенных больше не нужен.
   */
  restore(roomId: string): Promise<void>;
  wasMember(roomId: string, userId: string): Promise<boolean>;
  /** Доступ к случаю отозван: убрать из выведенных — случая не будет в папке «Архив», вернуться нельзя. */
  dropMembers(roomId: string, userIds: string[]): Promise<void>;
  /** Пользователь вернулся в архивный чат. */
  markReturned(roomId: string, userId: string, at: number): Promise<void>;
  /** Вернувшиеся раньше `before`: их пора снова вывести. Отметка о возврате снимается. */
  claimReturns(before: number, limit: number): Promise<Array<{ roomId: string; userId: string }>>;
  /** Архивные случаи пользователя, новые первыми; `q` — поиск по номеру случая и названию. */
  forUser(userId: string, opts: { q?: string; limit: number }): Promise<ArchivedRoom[]>;
}

interface MemRoom {
  info: CaseInfo;
  closedAt: number | null;
  lastActivityAt: number;
  archivedAt: number | null;
  members: Map<string, number | null>;
}

export class InMemoryArchiveStore implements ArchiveStore {
  private readonly rooms = new Map<string, MemRoom>();

  async track(roomId: string, info: CaseInfo, closed: boolean, at: number) {
    const r = this.rooms.get(roomId);
    if (!r) {
      this.rooms.set(roomId, { info, closedAt: closed ? at : null, lastActivityAt: at, archivedAt: null, members: new Map() });
      return;
    }
    r.info = info;
    r.closedAt = closed ? (r.closedAt ?? at) : null;
  }
  async touch(roomId: string, at: number) {
    const r = this.rooms.get(roomId);
    if (r && r.archivedAt === null) r.lastActivityAt = Math.max(r.lastActivityAt, at);
  }
  async claimDue(idleBefore: number, at: number, limit: number) {
    const due = [...this.rooms.entries()]
      .filter(([, r]) => r.archivedAt === null && r.closedAt !== null && Math.max(r.closedAt, r.lastActivityAt) < idleBefore)
      .sort(([, a], [, b]) => a.closedAt! - b.closedAt!)
      .slice(0, limit);
    for (const [, r] of due) r.archivedAt = at;
    return due.map(([id]) => id);
  }
  async release(roomId: string) {
    const r = this.rooms.get(roomId);
    if (r) r.archivedAt = null;
  }
  async addMembers(roomId: string, userIds: string[]) {
    const r = this.rooms.get(roomId);
    if (r) for (const u of userIds) if (!r.members.has(u)) r.members.set(u, null);
  }
  async isArchived(roomId: string) {
    return (this.rooms.get(roomId)?.archivedAt ?? null) !== null;
  }
  async restore(roomId: string) {
    const r = this.rooms.get(roomId);
    if (!r) return;
    r.archivedAt = null;
    r.closedAt = null;
    r.members.clear();
  }
  async wasMember(roomId: string, userId: string) {
    return this.rooms.get(roomId)?.members.has(userId) ?? false;
  }
  async dropMembers(roomId: string, userIds: string[]) {
    for (const u of userIds) this.rooms.get(roomId)?.members.delete(u);
  }
  async markReturned(roomId: string, userId: string, at: number) {
    this.rooms.get(roomId)?.members.set(userId, at);
  }
  async claimReturns(before: number, limit: number) {
    const out: Array<{ roomId: string; userId: string }> = [];
    for (const [roomId, r] of this.rooms) {
      for (const [userId, returnedAt] of r.members) {
        if (out.length >= limit) return out;
        if (returnedAt !== null && returnedAt < before) {
          r.members.set(userId, null);
          out.push({ roomId, userId });
        }
      }
    }
    return out;
  }
  async forUser(userId: string, opts: { q?: string; limit: number }) {
    const q = opts.q?.trim().toLowerCase();
    return [...this.rooms.entries()]
      .filter(([, r]) => r.archivedAt !== null && r.members.has(userId))
      .filter(([, r]) => !q || r.info.caseId.toLowerCase().includes(q) || r.info.title.toLowerCase().includes(q))
      .sort(([, a], [, b]) => b.archivedAt! - a.archivedAt!)
      .slice(0, opts.limit)
      .map(([roomId, r]) => ({ ...r.info, roomId, archivedAt: r.archivedAt! }));
  }
}

const iso = (ms: number) => new Date(ms).toISOString();
const ACTIVE: ReadonlySet<Membership> = new Set(['join', 'invite']);
/** Активность в одной комнате пишется в хранилище не чаще раза в минуту. */
const TOUCH_EVERY_MS = 60_000;

export const ARCHIVED_NOTICE =
  'Случай закрыт и давно без активности — чат перенесён в архив и доступен только для чтения. ' +
  'Открыть его снова можно из папки «Архив» или по ссылке из РИС/ЛИС.';

export function caseInfo(hostCase: HostCase): CaseInfo {
  return {
    caseKey: caseKey(hostCase.ref),
    connector: hostCase.ref.connector,
    caseId: hostCase.snapshot.case_id,
    title: hostCase.snapshot.title,
    source: hostCase.source,
  };
}

export class ArchiveService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private readonly touched = new Map<string, number>();

  constructor(
    private readonly deps: {
      matrix: MatrixApi;
      store: ArchiveStore;
      log: Logger;
      /** Сколько закрытый случай живёт без активности до архива. */
      afterMs: number;
      /** Сколько вернувшийся остаётся в архивном чате. */
      returnMs: number;
      /** Неподтверждённая критическая находка держит чат вне архива. */
      hasPendingCritical: (roomId: string) => Promise<boolean>;
      now?: () => number;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  /** Записать состояние случая комнаты (после создания чата и каждой синхронизации со снимком). */
  async track(roomId: string, hostCase: HostCase) {
    await this.deps.store.track(roomId, caseInfo(hostCase), hostCase.snapshot.status !== 'open', this.now());
  }

  /** Событие пользователя в комнате (из транзакции Synapse). */
  async onActivity(roomId: string) {
    const now = this.now();
    const last = this.touched.get(roomId);
    if (last !== undefined && now - last < TOUCH_EVERY_MS) return;
    this.touched.delete(roomId);
    this.touched.set(roomId, now);
    if (this.touched.size > 10_000) this.touched.delete(this.touched.keys().next().value!);
    await this.deps.store.touch(roomId, now);
  }

  isArchived(roomId: string) {
    return this.deps.store.isArchived(roomId);
  }

  wasMember(roomId: string, userId: string) {
    return this.deps.store.wasMember(roomId, userId);
  }

  /** Доступ к случаю отозван в системе-источнике — и к архиву тоже. */
  async revoke(roomId: string, userIds: string[]) {
    if (userIds.length) await this.deps.store.dropMembers(roomId, userIds);
  }

  // ── Проход по таймеру ────────────────────────────────────────────────────

  start(intervalMs: number) {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Один проход: отправить в архив закрытые чаты без активности и снова вывести вернувшихся, чей срок вышел. */
  async tick(): Promise<{ archived: number; removed: number }> {
    const out = { archived: 0, removed: 0 };
    if (this.ticking) return out;
    this.ticking = true;
    try {
      const now = this.now();
      for (const roomId of await this.deps.store.claimDue(now - this.deps.afterMs, now, 20)) {
        try {
          if (await this.deps.hasPendingCritical(roomId)) {
            await this.deps.store.release(roomId);
            continue;
          }
          await this.archive(roomId, now);
          out.archived += 1;
        } catch (err) {
          this.deps.log.error({ err, roomId }, 'Чат случая не перенесён в архив; повторим');
          await this.deps.store.release(roomId).catch(() => undefined);
        }
      }
      for (const r of await this.deps.store.claimReturns(now - this.deps.returnMs, 50)) {
        try {
          if (await this.remove(r.roomId, r.userId)) out.removed += 1;
        } catch (err) {
          this.deps.log.error({ err, roomId: r.roomId }, 'Вернувшийся не выведен из архивного чата; повторим');
          await this.deps.store.markReturned(r.roomId, r.userId, now - this.deps.returnMs - 1).catch(() => undefined);
        }
      }
    } finally {
      this.ticking = false;
    }
    return out;
  }

  /**
   * Перевести комнату в архив. Порядок важен: состояние архива и уведомление — до вывода участников, чтобы выведенные
   * увидели их последними событиями комнаты; список выведенных — до вывода, чтобы сбой посередине не потерял его.
   */
  private async archive(roomId: string, at: number) {
    const m = this.deps.matrix;
    await m.sendState(roomId, EventType.CaseArchive, '', { status: 'archived', archived_at: iso(at) } satisfies CaseArchiveContent);
    await this.setReadOnly(roomId, true);
    await m.sendEvent(roomId, 'm.room.message', { msgtype: 'm.notice', body: ARCHIVED_NOTICE }, `archive.${roomId}.${at}`);
    const members = (await m.members(roomId)).filter((x) => x.userId !== m.botUserId && ACTIVE.has(x.membership)).map((x) => x.userId);
    await this.deps.store.addMembers(roomId, members);
    for (const userId of members) await m.kick(roomId, userId, 'Случай в архиве');
    this.deps.log.info({ roomId, members: members.length }, 'Чат случая перенесён в архив');
  }

  /** Вывести из архивного чата (срок возврата вышел). `false` — пользователь уже вышел сам. */
  private async remove(roomId: string, userId: string): Promise<boolean> {
    if (!(await this.isArchived(roomId))) return false;
    const membership = await this.deps.matrix.getMembership(roomId, userId);
    if (!membership || !ACTIVE.has(membership)) return false;
    await this.deps.matrix.kick(roomId, userId, 'Случай в архиве');
    return true;
  }

  /**
   * Случай снова открыт в системе-источнике: комната возвращается из архива — снова можно писать.
   * Участников по ролям приглашает вызывающий (синхронизация со снимком).
   */
  async restore(roomId: string) {
    const prev = await this.deps.matrix.getState<CaseArchiveContent>(roomId, EventType.CaseArchive);
    await this.deps.matrix.sendState(roomId, EventType.CaseArchive, '', {
      status: 'active',
      ...(prev?.archived_at ? { archived_at: prev.archived_at } : {}),
      restored_at: iso(this.now()),
    } satisfies CaseArchiveContent);
    await this.setReadOnly(roomId, false);
    await this.deps.store.restore(roomId);
    this.deps.log.info({ roomId }, 'Чат случая вернулся из архива');
  }

  /**
   * Вернуть пользователя в архивный чат — только для чтения, с полной историей. Права проверяет вызывающий.
   * Возврат пишется в журнал; через `returnMs` пользователь снова выводится.
   */
  async returnUser(roomId: string, userId: string): Promise<'join' | 'invite'> {
    let membership = await this.deps.matrix.getMembership(roomId, userId);
    if (membership === 'ban') throw new MatrixError(403, 'M_FORBIDDEN', 'Пользователь заблокирован в комнате');
    if (membership !== 'join' && membership !== 'invite') {
      await this.deps.matrix.invite(roomId, userId, 'Возврат в архивный чат случая');
      membership = 'invite';
    }
    await this.deps.store.markReturned(roomId, userId, this.now());
    this.deps.log.info({ audit: 'archive_return', userId, roomId }, 'Возврат в архивный чат случая');
    return membership;
  }

  /** Папка «Архив»: случаи, в чатах которых пользователь участвовал. */
  async list(userId: string, opts: { q?: string; limit: number }): Promise<ArchivedCase[]> {
    const rows = await this.deps.store.forUser(userId, opts);
    return rows.map((r) => ({ room_id: r.roomId, connector: r.connector, case_id: r.caseId, title: r.title, source: r.source, archived_at: iso(r.archivedAt) }));
  }

  /** Только чтение: все события — уровень 100 (у участников 0). Звонки — тоже. Выйти из комнаты можно всегда. */
  private async setReadOnly(roomId: string, readOnly: boolean) {
    const pl = (await this.deps.matrix.getState<{ events_default?: number; events?: Record<string, number> }>(roomId, 'm.room.power_levels')) ?? {};
    const level = readOnly ? 100 : 0;
    await this.deps.matrix.sendState(roomId, 'm.room.power_levels', '', { ...pl, events_default: level, events: { ...(pl.events ?? {}), [EventType.Call]: level } });
  }
}
