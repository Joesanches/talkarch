import { MatrixError, type CreateRoomRequest, type MatrixApi, type Membership } from '../../src/matrix.ts';

interface FakeRoom {
  id: string;
  req: CreateRoomRequest;
  state: Map<string, Record<string, unknown>>;
  events: Array<{ type: string; content: Record<string, unknown>; txnId?: string }>;
}

/** Поддельный homeserver в памяти для модульных тестов. */
export class FakeMatrix implements MatrixApi {
  readonly rooms = new Map<string, FakeRoom>();
  readonly aliases = new Map<string, string>();
  readonly tokens = new Map<string, string>();
  createCalls = 0;
  /** Искусственная задержка createRoom — чтобы проверить параллельные вызовы. */
  createDelayMs = 0;

  constructor(readonly botUserId = '@ccs:konsilium.test', private readonly serverName = 'konsilium.test') {}

  private room(roomId: string): FakeRoom {
    const r = this.rooms.get(roomId);
    if (!r) throw new MatrixError(404, 'M_NOT_FOUND', 'Нет комнаты');
    return r;
  }

  private key(type: string, stateKey: string) {
    return `${type}\u0000${stateKey}`;
  }

  /** Правила настоящего сервера, на которых уже спотыкались (см. интеграционный тест). */
  private checkStateKey(type: string, stateKey: string) {
    if (type !== 'm.room.member' && stateKey.startsWith('@') && stateKey !== this.botUserId) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'You are not allowed to set others state');
    }
  }

  async createRoom(req: CreateRoomRequest): Promise<string> {
    this.createCalls += 1;
    const users = (req.power_level_content_override as { users?: Record<string, number> } | undefined)?.users;
    if (users && this.botUserId in users) {
      throw new MatrixError(400, 'M_BAD_JSON', `Creator user ${this.botUserId} must not appear in content.users`);
    }
    for (const s of req.initial_state ?? []) this.checkStateKey(s.type, s.state_key);
    if (this.createDelayMs) await new Promise((r) => setTimeout(r, this.createDelayMs));
    const alias = req.room_alias_name ? `#${req.room_alias_name}:${this.serverName}` : null;
    if (alias && this.aliases.has(alias)) throw new MatrixError(400, 'M_ROOM_IN_USE', 'Псевдоним занят');
    const id = `!room${this.rooms.size + 1}:${this.serverName}`;
    const state = new Map<string, Record<string, unknown>>();
    state.set(this.key('m.room.create', ''), { creator: this.botUserId, ...(req.creation_content ?? {}) });
    state.set(this.key('m.room.member', this.botUserId), { membership: 'join' });
    for (const s of req.initial_state ?? []) state.set(this.key(s.type, s.state_key), s.content);
    for (const u of req.invite ?? []) state.set(this.key('m.room.member', u), { membership: 'invite' });
    this.rooms.set(id, { id, req, state, events: [] });
    if (alias) this.aliases.set(alias, id);
    return id;
  }

  async resolveAlias(alias: string) {
    return this.aliases.get(alias) ?? null;
  }

  async invite(roomId: string, userId: string) {
    this.room(roomId).state.set(this.key('m.room.member', userId), { membership: 'invite' });
  }

  join(roomId: string, userId: string) {
    this.room(roomId).state.set(this.key('m.room.member', userId), { membership: 'join' });
  }

  async getMembership(roomId: string, userId: string) {
    const m = this.room(roomId).state.get(this.key('m.room.member', userId));
    return (m?.membership as Membership | undefined) ?? null;
  }

  async getState<T>(roomId: string, type: string, stateKey = '') {
    return (this.room(roomId).state.get(this.key(type, stateKey)) as T | undefined) ?? null;
  }

  async sendState(roomId: string, type: string, stateKey: string, content: Record<string, unknown>) {
    this.checkStateKey(type, stateKey);
    this.room(roomId).state.set(this.key(type, stateKey), content);
    return `$state${Math.random()}`;
  }

  async sendEvent(roomId: string, type: string, content: Record<string, unknown>, txnId?: string) {
    const room = this.room(roomId);
    const dup = txnId ? room.events.find((e) => e.txnId === txnId) : undefined;
    if (!dup) room.events.push({ type, content, txnId });
    return `$event${room.events.length}`;
  }

  async whoami(token: string) {
    const user = this.tokens.get(token);
    if (!user) throw new MatrixError(401, 'M_UNKNOWN_TOKEN', 'Неизвестный токен');
    return user;
  }

  async joinedMembersAs(token: string, roomId: string) {
    const user = await this.whoami(token);
    const room = this.room(roomId);
    const joined = [...room.state.entries()]
      .filter(([k, v]) => k.startsWith('m.room.member\u0000') && v.membership === 'join')
      .map(([k]) => k.split('\u0000')[1]!);
    if (!joined.includes(user)) throw new MatrixError(403, 'M_FORBIDDEN', 'Не участник');
    return joined;
  }
}
