import { createHmac } from 'node:crypto';

/** Минимальный клиент Matrix для генератора нагрузки. */
export class Hs {
  /** Synapse с admin API регистрации; иначе (Tuwunel) — регистрация по токену. */
  private synapseAdmin?: boolean;

  constructor(
    readonly url: string,
    private readonly sharedSecret: string,
  ) {}

  async call<T = any>(method: string, path: string, token: string | null, body?: unknown, signal?: AbortSignal): Promise<{ status: number; json: T; ms: number }> {
    const t0 = performance.now();
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : {}) as T, ms: performance.now() - t0 };
  }

  /**
   * Пользователь: у Synapse — через admin API с общим секретом, у Tuwunel — обычная регистрация с токеном
   * (registration_token, тот же dev-only-секрет). Уже есть — вход по паролю.
   */
  async user(localpart: string, password: string, displayname: string): Promise<{ userId: string; token: string }> {
    this.synapseAdmin ??= (await this.call('GET', '/_synapse/admin/v1/register', null)).status === 200;
    const reg = this.synapseAdmin ? await this.registerSynapse(localpart, password, displayname) : await this.registerWithToken(localpart, password, displayname);
    if (reg.json.access_token) return { userId: reg.json.user_id!, token: reg.json.access_token };
    if (reg.json.errcode !== 'M_USER_IN_USE') throw new Error(`Регистрация ${localpart}: ${JSON.stringify(reg.json)}`);
    const login = await this.call<{ access_token: string; user_id: string }>('POST', '/_matrix/client/v3/login', null, {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: localpart },
      password,
    });
    if (!login.json.access_token) throw new Error(`Вход ${localpart}: ${login.status}`);
    return { userId: login.json.user_id, token: login.json.access_token };
  }

  private async registerSynapse(localpart: string, password: string, displayname: string) {
    const nonce = (await this.call<{ nonce: string }>('GET', '/_synapse/admin/v1/register', null)).json.nonce;
    const mac = createHmac('sha1', this.sharedSecret).update(`${nonce}\0${localpart}\0${password}\0notadmin`).digest('hex');
    return this.call<RegisterResult>('POST', '/_synapse/admin/v1/register', null, { nonce, username: localpart, password, displayname, admin: false, mac });
  }

  /** Регистрация с интерактивной авторизацией: первый запрос даёт сессию, второй — с токеном регистрации. */
  private async registerWithToken(localpart: string, password: string, displayname: string) {
    const body = { username: localpart, password, initial_device_display_name: 'load' };
    const first = await this.call<RegisterResult & { session?: string }>('POST', '/_matrix/client/v3/register', null, body);
    if (!first.json.session) return first;
    const reg = await this.call<RegisterResult>('POST', '/_matrix/client/v3/register', null, {
      ...body,
      auth: { type: 'm.login.registration_token', token: this.sharedSecret, session: first.json.session },
    });
    if (reg.json.access_token) {
      await this.call('PUT', `/_matrix/client/v3/profile/${encodeURIComponent(reg.json.user_id!)}/displayname`, reg.json.access_token, { displayname });
    }
    return reg;
  }
}

type RegisterResult = { access_token?: string; user_id?: string; errcode?: string };

/** Фильтр синхронизации как у веб-клиента: ленивая загрузка участников, 30 событий ленты на комнату. */
export const CLIENT_FILTER = JSON.stringify({ room: { state: { lazy_load_members: true }, timeline: { limit: 30, lazy_load_members: true } } });

/** Список Simplified Sliding Sync как у веб-клиента (apps/web/src/sync.ts): окно 20 комнат, 3 события ленты. */
export const SLIDING_LIST = {
  ranges: [[0, 19]],
  timeline_limit: 3,
  required_state: [
    ['m.room.create', ''],
    ['m.room.name', ''],
    ['ru.vendor.case.context', ''],
    ['ru.vendor.critical.status', '*'],
    ['ru.vendor.call', '*'],
    ['m.room.member', '$ME'],
    ['m.room.member', '$LAZY'],
  ],
};
