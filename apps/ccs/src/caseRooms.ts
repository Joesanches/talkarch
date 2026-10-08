import { createHmac } from 'node:crypto';
import { CaseContext, EventType, RoomType, caseKey, type CaseRef, type CaseRolesContent, type SourceSystem } from '@konsilium/protocol';
import type { ArchiveService } from './archive.ts';
import type { HostCase } from './cases.ts';
import { MatrixError, type MatrixApi, type Membership, type StateEventInit } from './matrix.ts';

/** Сопоставление «ключ случая → комната». В PoC — память; в продукте — таблица PostgreSQL с уникальным ключом. */
export interface CaseRoomStore {
  get(key: string): Promise<string | null>;
  set(key: string, roomId: string): Promise<void>;
}

export class InMemoryCaseRoomStore implements CaseRoomStore {
  private readonly byKey = new Map<string, string>();
  async get(key: string) {
    return this.byKey.get(key) ?? null;
  }
  async set(key: string, roomId: string) {
    this.byKey.set(key, roomId);
  }
}

export interface OpenResult {
  roomId: string;
  alias: string;
  created: boolean;
}

export interface SyncResult {
  updated: boolean;
  invited: string[];
  removed: string[];
  warnings: string[];
}

const systemLabel: Record<SourceSystem, string> = { RIS: 'РИС', LIS: 'ЛИС', TMK: 'ТМК' };

/**
 * Комнаты «чатов случаев»: ленивое и идемпотентное создание, синхронизация с системой-источником, доступ по требованию.
 * Подход описан в docs/03-architecture.md, раздел 9.
 */
export class CaseRoomService {
  private readonly inflight = new Map<string, Promise<OpenResult>>();
  /** Очередь синхронизаций по комнате: снимки одного случая применяются по одному, иначе старый может лечь поверх нового. */
  private readonly syncQueue = new Map<string, Promise<unknown>>();

  constructor(
    private readonly matrix: MatrixApi,
    private readonly store: CaseRoomStore,
    private readonly opts: { aliasSecret: string; serverName: string; now?: () => Date; archive?: ArchiveService },
  ) {}

  /** Служебный псевдоним: HMAC от ключа случая, чтобы номер исследования не был виден в псевдониме. */
  aliasFor(ref: CaseRef): { localpart: string; alias: string } {
    const digest = createHmac('sha256', this.opts.aliasSecret).update(caseKey(ref)).digest('hex').slice(0, 24);
    const localpart = `c-${digest}`;
    return { localpart, alias: `#${localpart}:${this.opts.serverName}` };
  }

  /** Комната случая, если уже есть. Ищет в своём хранилище, затем по псевдониму (после перезапуска сервиса). */
  async roomFor(ref: CaseRef): Promise<string | null> {
    const key = caseKey(ref);
    const cached = await this.store.get(key);
    if (cached) return cached;
    const roomId = await this.matrix.resolveAlias(this.aliasFor(ref).alias);
    if (roomId) await this.store.set(key, roomId);
    return roomId;
  }

  /** Найти или создать комнату. Параллельные вызовы для одного случая ждут одно создание. */
  getOrCreate(hostCase: HostCase): Promise<OpenResult> {
    const key = caseKey(hostCase.ref);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = this.doGetOrCreate(key, hostCase).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async doGetOrCreate(key: string, hostCase: HostCase): Promise<OpenResult> {
    const { localpart, alias } = this.aliasFor(hostCase.ref);
    const stored = await this.store.get(key);
    if (stored) return { roomId: stored, alias, created: false };

    const existing = await this.matrix.resolveAlias(alias);
    if (existing) {
      await this.repairIfIncomplete(existing, hostCase);
      await this.store.set(key, existing);
      await this.opts.archive?.track(existing, hostCase);
      return { roomId: existing, alias, created: false };
    }

    try {
      const roomId = await this.matrix.createRoom(this.buildCreateRequest(hostCase, localpart));
      await this.store.set(key, roomId);
      await this.opts.archive?.track(roomId, hostCase);
      return { roomId, alias, created: true };
    } catch (e) {
      // Гонка между экземплярами сервиса: псевдоним уже занят — значит, комнату создал другой экземпляр.
      if (e instanceof MatrixError && e.errcode === 'M_ROOM_IN_USE') {
        const roomId = await this.matrix.resolveAlias(alias);
        if (roomId) {
          await this.store.set(key, roomId);
          return { roomId, alias, created: false };
        }
      }
      throw e;
    }
  }

  /**
   * Synapse при ошибке посреди createRoom может оставить комнату с псевдонимом, но без нашего состояния.
   * Такую комнату достраиваем, а не создаём вторую.
   */
  private async repairIfIncomplete(roomId: string, hostCase: HostCase) {
    if (await this.matrix.getState(roomId, EventType.CaseContext)) return;
    for (const s of this.initialState(hostCase)) await this.matrix.sendState(roomId, s.type, s.state_key, s.content);
    for (const p of hostCase.participants) await this.ensureMember(roomId, p.userId);
  }

  /**
   * Привести существующую комнату к новому снимку случая: контекст, название, роли, новые участники,
   * отзыв доступа, сообщение о закрытии. Устаревший снимок (версия не больше записанной в комнате) пропускается.
   * Архивный чат: участников не приглашаем (вернуться можно по требованию); случай снова открыт — чат возвращается
   * из архива.
   */
  sync(roomId: string, hostCase: HostCase): Promise<SyncResult> {
    const prev = this.syncQueue.get(roomId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.doSync(roomId, hostCase));
    this.syncQueue.set(roomId, next);
    const cleanup = () => {
      if (this.syncQueue.get(roomId) === next) this.syncQueue.delete(roomId);
    };
    next.then(cleanup, cleanup);
    return next;
  }

  private async doSync(roomId: string, hostCase: HostCase): Promise<SyncResult> {
    const result: SyncResult = { updated: false, invited: [], removed: [], warnings: [] };
    const current = await this.matrix.getState<CaseContext>(roomId, EventType.CaseContext);
    if (current && current.sync.version >= hostCase.snapshot.version) return result;

    const status = hostCase.snapshot.status;
    const archive = this.opts.archive;
    let archived = archive ? await archive.isArchived(roomId) : false;
    if (archived && status === 'open') {
      await archive!.restore(roomId);
      archived = false;
      await this.matrix.sendEvent(
        roomId,
        'm.room.message',
        { msgtype: 'm.notice', body: `Случай снова открыт в ${systemLabel[hostCase.source]} — чат вернулся из архива` },
        `restore.${roomId}.${hostCase.snapshot.version}`,
      );
    }

    const next = this.buildContext(hostCase);
    await this.matrix.sendState(roomId, EventType.CaseContext, '', next);
    if (!current || current.title !== next.title) {
      await this.matrix.sendState(roomId, 'm.room.name', '', { name: this.roomName(hostCase) });
    }
    const roles = await this.matrix.getState<CaseRolesContent>(roomId, EventType.CaseRoles);
    await this.matrix.sendState(roomId, EventType.CaseRoles, '', this.buildRoles(hostCase, roles));
    result.updated = true;

    for (const p of archived ? [] : hostCase.participants) {
      const m = await this.matrix.getMembership(roomId, p.userId);
      if (m === 'join' || m === 'invite') continue;
      if (m === 'ban') {
        result.warnings.push(`Участник ${p.userId} заблокирован в комнате и не приглашён`);
        continue;
      }
      await this.matrix.invite(roomId, p.userId, 'Участник случая в системе-источнике');
      result.invited.push(p.userId);
    }
    await archive?.revoke(roomId, hostCase.revoked);
    for (const userId of hostCase.revoked) {
      const m = await this.matrix.getMembership(roomId, userId);
      if (m === 'join' || m === 'invite') {
        await this.matrix.kick(roomId, userId, 'Доступ к случаю отозван в системе-источнике');
        result.removed.push(userId);
      }
    }

    if ((current?.status ?? 'open') !== status && status !== 'open') {
      const what = status === 'closed' ? 'закрыт' : 'отменён';
      await this.matrix.sendEvent(
        roomId,
        'm.room.message',
        { msgtype: 'm.notice', body: `Случай ${what} в ${systemLabel[hostCase.source]}` },
        `status.${roomId}.${hostCase.snapshot.version}`,
      );
    }
    await archive?.track(roomId, hostCase);
    return result;
  }

  roomName(hostCase: HostCase): string {
    return `${hostCase.snapshot.case_id} · ${hostCase.snapshot.title}`;
  }

  buildContext(hostCase: HostCase): CaseContext {
    const s = hostCase.snapshot;
    return CaseContext.parse({
      source: hostCase.source,
      connector: hostCase.ref.connector,
      case_id: s.case_id,
      status: s.status,
      order_id: s.order_id,
      accession_number: s.accession_number,
      study_instance_uid: s.study_instance_uid,
      title: s.title,
      patient: s.patient,
      stage: s.stage,
      priority: s.priority,
      due: s.due,
      links: s.links,
      sync: { version: s.version, updated_at: s.updated_at },
    });
  }

  /** Роли из системы-источника. Время назначения сохраняется, если роль не изменилась. */
  buildRoles(hostCase: HostCase, previous?: CaseRolesContent | null): CaseRolesContent {
    const now = (this.opts.now?.() ?? new Date()).toISOString();
    const members: CaseRolesContent['members'] = {};
    for (const p of hostCase.participants) {
      const before = previous?.members[p.userId];
      members[p.userId] =
        before && before.role === p.role ? before : { role: p.role, source: hostCase.source, assigned_at: now };
    }
    return { members };
  }

  private initialState(hostCase: HostCase): StateEventInit[] {
    return [
      { type: EventType.CaseContext, state_key: '', content: this.buildContext(hostCase) },
      { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'shared' } },
      { type: 'm.room.guest_access', state_key: '', content: { guest_access: 'forbidden' } },
      { type: EventType.CaseRoles, state_key: '', content: this.buildRoles(hostCase) },
    ];
  }

  private buildCreateRequest(hostCase: HostCase, aliasLocalpart: string) {
    const invite = [...new Set(hostCase.participants.map((p) => p.userId))].filter((u) => u !== this.matrix.botUserId);
    return {
      name: this.roomName(hostCase),
      room_alias_name: aliasLocalpart,
      preset: 'private_chat' as const,
      visibility: 'private' as const,
      creation_content: { type: RoomType.Case },
      initial_state: this.initialState(hostCase),
      invite,
      // Комнаты версии 12: создатель (сервисный пользователь) имеет неограниченные права и не указывается в users.
      // Приглашают и меняют контекст только сервис и система-источник через него; участники пишут сообщения.
      power_level_content_override: {
        users_default: 0,
        events_default: 0,
        state_default: 100,
        invite: 100,
        kick: 100,
        ban: 100,
        redact: 50,
        events: {
          [EventType.CaseContext]: 100,
          [EventType.CaseRoles]: 100,
          [EventType.RequestStatus]: 100,
          [EventType.CriticalStatus]: 100,
          [EventType.Call]: 0,
          'm.room.name': 100,
          'm.room.power_levels': 100,
          'm.room.history_visibility': 100,
        },
      },
    };
  }

  /** Пустить пользователя в комнату: уже участник — ничего не делаем; иначе — приглашение. */
  async ensureMember(roomId: string, userId: string): Promise<Membership | 'invite'> {
    const m = await this.matrix.getMembership(roomId, userId);
    if (m === 'join' || m === 'invite') return m;
    if (m === 'ban') throw new MatrixError(403, 'M_FORBIDDEN', 'Пользователь заблокирован в комнате');
    await this.matrix.invite(roomId, userId, 'Доступ к случаю в системе-источнике');
    return 'invite';
  }
}
