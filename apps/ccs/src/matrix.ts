/**
 * Минимальный клиент Matrix Client-Server API для сервиса контекста.
 * Свой, а не mautrix/matrix-bot-sdk: меньше зависимостей и никаких copyleft-лицензий в ядре (см. docs/02-platforms.md).
 */

export type Membership = 'join' | 'invite' | 'leave' | 'ban' | 'knock';

export interface StateEventInit {
  type: string;
  state_key: string;
  content: Record<string, unknown>;
}

export interface CreateRoomRequest {
  name?: string;
  topic?: string;
  room_alias_name?: string;
  preset?: 'private_chat' | 'trusted_private_chat' | 'public_chat';
  visibility?: 'private' | 'public';
  creation_content?: Record<string, unknown>;
  initial_state?: StateEventInit[];
  invite?: string[];
  power_level_content_override?: Record<string, unknown>;
}

export interface MatrixApi {
  readonly botUserId: string;
  createRoom(req: CreateRoomRequest): Promise<string>;
  resolveAlias(alias: string): Promise<string | null>;
  invite(roomId: string, userId: string, reason?: string): Promise<void>;
  kick(roomId: string, userId: string, reason?: string): Promise<void>;
  getMembership(roomId: string, userId: string): Promise<Membership | null>;
  getState<T = Record<string, unknown>>(roomId: string, type: string, stateKey?: string): Promise<T | null>;
  sendState(roomId: string, type: string, stateKey: string, content: Record<string, unknown>): Promise<string>;
  sendEvent(roomId: string, type: string, content: Record<string, unknown>, txnId?: string): Promise<string>;
  /** Matrix ID владельца пользовательского токена. */
  whoami(userAccessToken: string): Promise<string>;
  /** Участники комнаты (join) глазами пользователя — проверка членства его же токеном. */
  joinedMembersAs(userAccessToken: string, roomId: string): Promise<string[]>;
}

export class MatrixError extends Error {
  constructor(
    readonly status: number,
    readonly errcode: string,
    message: string,
  ) {
    super(`${status} ${errcode}: ${message}`);
  }
}

let txnCounter = 0;
const newTxnId = () => `ccs.${Date.now()}.${++txnCounter}`;
const enc = encodeURIComponent;

export class HttpMatrixApi implements MatrixApi {
  constructor(
    private readonly hsUrl: string,
    private readonly asToken: string,
    readonly botUserId: string,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown, token = this.asToken): Promise<T> {
    const res = await fetch(`${this.hsUrl}/_matrix/client/v3${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      throw new MatrixError(res.status, String(json.errcode ?? 'M_UNKNOWN'), String(json.error ?? res.statusText));
    }
    return json as T;
  }

  async createRoom(req: CreateRoomRequest): Promise<string> {
    const r = await this.call<{ room_id: string }>('POST', '/createRoom', req);
    return r.room_id;
  }

  async resolveAlias(alias: string): Promise<string | null> {
    try {
      const r = await this.call<{ room_id: string }>('GET', `/directory/room/${enc(alias)}`);
      return r.room_id;
    } catch (e) {
      if (e instanceof MatrixError && e.status === 404) return null;
      throw e;
    }
  }

  async invite(roomId: string, userId: string, reason?: string): Promise<void> {
    await this.call('POST', `/rooms/${enc(roomId)}/invite`, { user_id: userId, ...(reason ? { reason } : {}) });
  }

  async kick(roomId: string, userId: string, reason?: string): Promise<void> {
    await this.call('POST', `/rooms/${enc(roomId)}/kick`, { user_id: userId, ...(reason ? { reason } : {}) });
  }

  async getMembership(roomId: string, userId: string): Promise<Membership | null> {
    const m = await this.getState<{ membership?: Membership }>(roomId, 'm.room.member', userId);
    return m?.membership ?? null;
  }

  async getState<T>(roomId: string, type: string, stateKey = ''): Promise<T | null> {
    try {
      return await this.call<T>('GET', `/rooms/${enc(roomId)}/state/${enc(type)}/${enc(stateKey)}`);
    } catch (e) {
      if (e instanceof MatrixError && e.status === 404) return null;
      throw e;
    }
  }

  async sendState(roomId: string, type: string, stateKey: string, content: Record<string, unknown>): Promise<string> {
    const r = await this.call<{ event_id: string }>('PUT', `/rooms/${enc(roomId)}/state/${enc(type)}/${enc(stateKey)}`, content);
    return r.event_id;
  }

  async sendEvent(roomId: string, type: string, content: Record<string, unknown>, txnId = newTxnId()): Promise<string> {
    const r = await this.call<{ event_id: string }>('PUT', `/rooms/${enc(roomId)}/send/${enc(type)}/${enc(txnId)}`, content);
    return r.event_id;
  }

  /**
   * Ping Application Service (`/_matrix/client/v1/appservice/{id}/ping`): Synapse вызывает наш `/_matrix/app/v1/ping`
   * и при успехе сразу досылает накопленные транзакции. Без этого после простоя сервиса Synapse ждёт паузу
   * повторов — до 512 с. Возвращает время ответа в мс.
   */
  async pingAppservice(appserviceId: string): Promise<number> {
    const res = await fetch(`${this.hsUrl}/_matrix/client/v1/appservice/${enc(appserviceId)}/ping`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.asToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ transaction_id: newTxnId() }),
    });
    const json = (await res.json().catch(() => ({}))) as { duration_ms?: number; errcode?: string; error?: string };
    if (!res.ok) throw new MatrixError(res.status, json.errcode ?? 'M_UNKNOWN', json.error ?? res.statusText);
    return json.duration_ms ?? 0;
  }

  async setBotDisplayName(name: string): Promise<void> {
    await this.call('PUT', `/profile/${enc(this.botUserId)}/displayname`, { displayname: name });
  }

  async whoami(userAccessToken: string): Promise<string> {
    const r = await this.call<{ user_id: string }>('GET', '/account/whoami', undefined, userAccessToken);
    return r.user_id;
  }

  async joinedMembersAs(userAccessToken: string, roomId: string): Promise<string[]> {
    const r = await this.call<{ joined: Record<string, unknown> }>('GET', `/rooms/${enc(roomId)}/joined_members`, undefined, userAccessToken);
    return Object.keys(r.joined);
  }
}
