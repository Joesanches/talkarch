import { MatrixError, type CreateRoomRequest, type MatrixApi, type Membership } from '../../src/matrix.ts';

interface FakeRoom {
  id: string;
  req: CreateRoomRequest;
  state: Map<string, Record<string, unknown>>;
  events: Array<{ type: string; content: Record<string, unknown>; txnId?: string; eventId: string }>;
}

/** Поддельный homeserver в памяти для модульных тестов. */
export class FakeMatrix implements MatrixApi {
  readonly rooms = new Map<string, FakeRoom>();
  readonly aliases = new Map<string, string>();
  readonly tokens = new Map<string, string>();
  readonly profiles = new Map<string, string>();
  createCalls = 0;
  /** Искусственная задержка createRoom — чтобы проверить параллельные вызовы. */
  createDelayMs = 0;
  /** Задержка записи state-события (мс) — чтобы проверить параллельные синхронизации. */
  stateDelay: (type: string, content: Record<string, unknown>) => number = () => 0;
  /** Ошибка для следующей записи (sendState/sendEvent) — имитация сбоя сервера. */
  failNextWrite: MatrixError | null = null;

  private maybeFail() {
    const e = this.failNextWrite;
    if (e) {
      this.failNextWrite = null;
      throw e;
    }
  }

  constructor(readonly botUserId = '@ccs:konsilium.test', private readonly serverName = 'konsilium.test') {}

  private room(roomId: string): FakeRoom {
    const r = this.rooms.get(roomId);
    if (!r) throw new MatrixError(404, 'M_NOT_FOUND', 'Нет комнаты');
    return r;
  }

  private key(type: string, stateKey: string) {
    return `${type}\u0000${stateKey}`;
  }

  /** Канонический JSON Matrix: в событиях только целые числа (Synapse отвечает 400 M_BAD_JSON). */
  private checkCanonical(content: unknown) {
    const walk = (v: unknown): void => {
      if (typeof v === 'number' && !Number.isInteger(v)) throw new MatrixError(400, 'M_BAD_JSON', 'Bad JSON value: float');
      if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
    };
    walk(content);
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
    if (req.power_level_content_override) state.set(this.key('m.room.power_levels', ''), structuredClone(req.power_level_content_override));
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

  async kick(roomId: string, userId: string) {
    this.room(roomId).state.set(this.key('m.room.member', userId), { membership: 'leave' });
  }

  join(roomId: string, userId: string) {
    this.room(roomId).state.set(this.key('m.room.member', userId), { membership: 'join' });
  }

  async getMembership(roomId: string, userId: string) {
    const m = this.room(roomId).state.get(this.key('m.room.member', userId));
    return (m?.membership as Membership | undefined) ?? null;
  }

  async members(roomId: string) {
    return [...this.room(roomId).state.entries()]
      .filter(([k]) => k.startsWith('m.room.member\u0000'))
      .map(([k, v]) => ({ userId: k.split('\u0000')[1]!, membership: v.membership as Membership }));
  }

  /** Сообщения комнаты определённого типа (для проверок). */
  messages(roomId: string, type = 'm.room.message') {
    return this.room(roomId).events.filter((e) => e.type === type);
  }

  async getState<T>(roomId: string, type: string, stateKey = '') {
    return (this.room(roomId).state.get(this.key(type, stateKey)) as T | undefined) ?? null;
  }

  async sendState(roomId: string, type: string, stateKey: string, content: Record<string, unknown>) {
    this.maybeFail();
    this.checkStateKey(type, stateKey);
    this.checkCanonical(content);
    const delay = this.stateDelay(type, content);
    if (delay) await new Promise((r) => setTimeout(r, delay));
    this.room(roomId).state.set(this.key(type, stateKey), content);
    return `$state${Math.random()}`;
  }

  async sendEvent(roomId: string, type: string, content: Record<string, unknown>, txnId?: string) {
    this.maybeFail();
    this.checkCanonical(content);
    const room = this.room(roomId);
    const dup = txnId ? room.events.find((e) => e.txnId === txnId) : undefined;
    if (dup) return dup.eventId;
    const eventId = `$event${room.events.length + 1}.${room.id}`;
    room.events.push({ type, content, txnId, eventId });
    return eventId;
  }

  async displayName(userId: string) {
    return this.profiles.get(userId) ?? null;
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
