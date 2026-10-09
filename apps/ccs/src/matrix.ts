/**
 * Минимальный клиент Matrix Client-Server API для сервиса контекста.
 * Свой, а не mautrix/matrix-bot-sdk: меньше зависимостей и никаких copyleft-лицензий в ядре (см. docs/02-platforms.md).
 */
import { PREJOIN_STATE_KEY, PREJOIN_STATE_TYPES } from '@konsilium/protocol';

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
  /** Состав комнаты глазами сервиса: все, у кого есть членство (вошли, приглашены, вышли…). */
  members(roomId: string): Promise<Array<{ userId: string; membership: Membership }>>;
  getState<T = Record<string, unknown>>(roomId: string, type: string, stateKey?: string): Promise<T | null>;
  sendState(roomId: string, type: string, stateKey: string, content: Record<string, unknown>): Promise<string>;
  sendEvent(roomId: string, type: string, content: Record<string, unknown>, txnId?: string): Promise<string>;
  /** Событие комнаты по ID глазами сервиса; `null` — нет такого. */
  getEvent(roomId: string, eventId: string): Promise<{ sender: string; type: string; content: Record<string, unknown>; origin_server_ts: number } | null>;
  /** Отображаемое имя из профиля; `null`, если не задано. */
  displayName(userId: string): Promise<string | null>;
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

/** Снимок состояния в приглашении — не больше половины предела события Matrix (64 КБ), с запасом на кириллицу в UTF-8. */
const PREJOIN_MAX_CHARS = 16_000;

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

  /**
   * Приглашение со снимком состояния, нужного клиенту до входа (контекст случая, находки, архив): не каждый сервер кладёт
   * свои типы в `invite_state` (`PREJOIN_STATE_KEY`). Такое приглашение — то же событие `m.room.member`, отправленное
   * как состояние; имя и аватар приглашённого сервис кладёт сам, как это делает `/invite`. Без снимка (или если он не
   * помещается в событие — предел Matrix 64 КБ) — обычное `/invite`.
   */
  async invite(roomId: string, userId: string, reason?: string): Promise<void> {
    const state = await this.call<StateEventInit[]>('GET', `/rooms/${enc(roomId)}/state`);
    const prejoin = state.filter((e) => PREJOIN_STATE_TYPES.includes(e.type)).map(({ type, state_key, content }) => ({ type, state_key, content }));
    if (!prejoin.length || JSON.stringify(prejoin).length > PREJOIN_MAX_CHARS) {
      await this.call('POST', `/rooms/${enc(roomId)}/invite`, { user_id: userId, ...(reason ? { reason } : {}) });
      return;
    }
    type Profile = { displayname?: string; avatar_url?: string };
    const profile = await this.call<Profile>('GET', `/profile/${enc(userId)}`).catch((e: unknown): Profile => {
      if (e instanceof MatrixError && e.status === 404) return {};
      throw e;
    });
    await this.sendState(roomId, 'm.room.member', userId, {
      membership: 'invite',
      ...(profile.displayname ? { displayname: profile.displayname } : {}),
      ...(profile.avatar_url ? { avatar_url: profile.avatar_url } : {}),
      ...(reason ? { reason } : {}),
      [PREJOIN_STATE_KEY]: prejoin,
    });
  }

  async kick(roomId: string, userId: string, reason?: string): Promise<void> {
    await this.call('POST', `/rooms/${enc(roomId)}/kick`, { user_id: userId, ...(reason ? { reason } : {}) });
  }

  async getMembership(roomId: string, userId: string): Promise<Membership | null> {
    const m = await this.getState<{ membership?: Membership }>(roomId, 'm.room.member', userId);
    return m?.membership ?? null;
  }

  async members(roomId: string): Promise<Array<{ userId: string; membership: Membership }>> {
    const r = await this.call<{ chunk: Array<{ state_key: string; content: { membership?: Membership } }> }>('GET', `/rooms/${enc(roomId)}/members`);
    return r.chunk.flatMap((e) => (e.content.membership ? [{ userId: e.state_key, membership: e.content.membership }] : []));
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

  async getEvent(roomId: string, eventId: string) {
    try {
      return await this.call<{ sender: string; type: string; content: Record<string, unknown>; origin_server_ts: number }>('GET', `/rooms/${enc(roomId)}/event/${enc(eventId)}`);
    } catch (e) {
      if (e instanceof MatrixError && e.status === 404) return null;
      throw e;
    }
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

  async displayName(userId: string): Promise<string | null> {
    try {
      const r = await this.call<{ displayname?: string }>('GET', `/profile/${enc(userId)}/displayname`);
      return r.displayname ?? null;
    } catch (e) {
      if (e instanceof MatrixError && e.status === 404) return null;
      throw e;
    }
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
