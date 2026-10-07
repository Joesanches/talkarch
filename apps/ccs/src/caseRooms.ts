import { createHmac } from 'node:crypto';
import { CaseContext, EventType, RoomType, caseKey, type CaseRef, type CaseRolesContent } from '@konsilium/protocol';
import type { HostCase } from './host.ts';
import { MatrixError, type MatrixApi, type Membership, type StateEventInit } from './matrix.ts';

/** Сопоставление «случай ↔ комната». В PoC — память; в продукте — PostgreSQL с уникальным ключом. */
export interface CaseRoomStore {
  get(key: string): Promise<string | null>;
  set(key: string, roomId: string): Promise<void>;
  keyByRoom(roomId: string): Promise<string | null>;
}

export class InMemoryCaseRoomStore implements CaseRoomStore {
  private readonly byKey = new Map<string, string>();
  private readonly byRoom = new Map<string, string>();
  async get(key: string) {
    return this.byKey.get(key) ?? null;
  }
  async set(key: string, roomId: string) {
    this.byKey.set(key, roomId);
    this.byRoom.set(roomId, key);
  }
  async keyByRoom(roomId: string) {
    return this.byRoom.get(roomId) ?? null;
  }
}

export interface OpenResult {
  roomId: string;
  alias: string;
  created: boolean;
}

/**
 * Чаты случаев: ленивое и идемпотентное создание, участники по ролям, доступ по требованию.
 * Правила — docs/03-architecture.md, раздел 9.
 */
export class CaseRoomService {
  private readonly inflight = new Map<string, Promise<OpenResult>>();

  constructor(
    private readonly matrix: MatrixApi,
    private readonly store: CaseRoomStore,
    private readonly opts: { aliasSecret: string; serverName: string; now?: () => Date },
  ) {}

  /** Служебный псевдоним `#c-<HMAC>`: уникален для случая и не раскрывает номер исследования. */
  aliasFor(ref: CaseRef): { localpart: string; alias: string } {
    const digest = createHmac('sha256', this.opts.aliasSecret).update(caseKey(ref)).digest('hex').slice(0, 24);
    const localpart = `c-${digest}`;
    return { localpart, alias: `#${localpart}:${this.opts.serverName}` };
  }

  async roomFor(ref: CaseRef): Promise<string | null> {
    const key = caseKey(ref);
    const known = await this.store.get(key);
    if (known) return known;
    const resolved = await this.matrix.resolveAlias(this.aliasFor(ref).alias);
    if (resolved) await this.store.set(key, resolved);
    return resolved;
  }

  /**
   * createRoom в Synapse не атомарен: при сбое посередине псевдоним может уже указывать на комнату
   * без контекста и ролей. Такую комнату достраиваем, а не создаём вторую.
   */
  private async repairIfIncomplete(roomId: string, hostCase: HostCase): Promise<void> {
    if (await this.matrix.getState(roomId, EventType.CaseContext)) return;
    const req = this.buildCreateRequest(hostCase, this.aliasFor(hostCase.ref).localpart);
    for (const s of req.initial_state) await this.matrix.sendState(roomId, s.type, s.state_key, s.content);
    for (const userId of req.invite) await this.ensureMember(roomId, userId);
  }

  /** Вернуть комнату случая, создав её при первом обращении. Параллельные вызовы получают одну комнату. */
  getOrCreate(hostCase: HostCase): Promise<OpenResult> {
    const key = caseKey(hostCase.ref);
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.doGetOrCreate(hostCase).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async doGetOrCreate(hostCase: HostCase): Promise<OpenResult> {
    const { localpart, alias } = this.aliasFor(hostCase.ref);
    const fromStore = await this.store.get(caseKey(hostCase.ref));
    if (fromStore) return { roomId: fromStore, alias, created: false };
    const existing = await this.roomFor(hostCase.ref);
    if (existing) {
      await this.repairIfIncomplete(existing, hostCase);
      return { roomId: existing, alias, created: false };
    }

    try {
      const roomId = await this.matrix.createRoom(this.buildCreateRequest(hostCase, localpart));
      await this.store.set(caseKey(hostCase.ref), roomId);
      return { roomId, alias, created: true };
    } catch (e) {
      // Гонка с другим экземпляром сервиса: псевдоним уже занят — берём существующую комнату.
      if (e instanceof MatrixError && e.errcode === 'M_ROOM_IN_USE') {
        const roomId = await this.matrix.resolveAlias(alias);
        if (roomId) {
          await this.store.set(caseKey(hostCase.ref), roomId);
          return { roomId, alias, created: false };
        }
      }
      throw e;
    }
  }

  private buildCreateRequest(hostCase: HostCase, aliasLocalpart: string) {
    const now = (this.opts.now ?? (() => new Date()))().toISOString();
    const context = CaseContext.parse({
      source: hostCase.ref.system,
      case_id: hostCase.ref.caseId,
      order_id: hostCase.orderId,
      accession_number: hostCase.accessionNumber,
      study_instance_uid: hostCase.studyUid,
      title: hostCase.title,
      patient: hostCase.patient,
      stage: hostCase.stage,
      priority: hostCase.priority,
      due: hostCase.due,
      links: hostCase.links,
      sync: { version: hostCase.version, updated_at: hostCase.updatedAt },
    });

    const roles: CaseRolesContent = {
      members: Object.fromEntries(
        hostCase.participants.map((p) => [p.userId, { role: p.role, source: hostCase.ref.system, assigned_at: now }]),
      ),
    };

    const bot = this.matrix.botUserId;
    return {
      name: `${hostCase.ref.caseId} · ${hostCase.title}`,
      room_alias_name: aliasLocalpart,
      preset: 'private_chat' as const,
      visibility: 'private' as const,
      creation_content: { type: RoomType.Case },
      initial_state: [
        { type: EventType.CaseContext, state_key: '', content: context as Record<string, unknown> },
        // Вернувшийся в комнату участник видит всю историю (архив → возврат по требованию).
        { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'shared' } },
        { type: 'm.room.guest_access', state_key: '', content: { guest_access: 'forbidden' } },
        { type: EventType.CaseRoles, state_key: '', content: roles as unknown as Record<string, unknown> },
      ] satisfies StateEventInit[],
      invite: [...new Set(hostCase.participants.map((p) => p.userId))].filter((u) => u !== bot),
      // Состав и контекст меняет только сервис: доступ определяется РИС/ЛИС, а не участниками чата.
      // Сервис — создатель комнаты: в комнатах версии 12 у создателя неограниченные права и его нельзя
      // указывать в `users` (Synapse отклонит запрос); в версиях до 12 пресет сам даёт создателю 100.
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
          [EventType.Call]: 0,
          'm.room.name': 100,
          'm.room.power_levels': 100,
          'm.room.history_visibility': 100,
        },
      },
    };
  }

  /** Доступ по требованию: пригласить пользователя, если его ещё нет в комнате. */
  async ensureMember(roomId: string, userId: string): Promise<Membership> {
    const current = await this.matrix.getMembership(roomId, userId);
    if (current === 'join' || current === 'invite') return current;
    if (current === 'ban') throw new MatrixError(403, 'M_FORBIDDEN', 'Пользователь заблокирован в комнате случая');
    await this.matrix.invite(roomId, userId, 'Доступ к случаю подтверждён системой-источником');
    return 'invite';
  }
}
