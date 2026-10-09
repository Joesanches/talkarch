/**
 * Пользователи стенда: регистрация через admin API Synapse (общий секрет из infra/synapse/homeserver.yaml) или,
 * на Tuwunel, по токену регистрации (tools/load/tuwunel), и имена, которые в продукте пришли бы из каталога
 * (Keycloak/AD). Все данные вымышлены.
 * Запуск: pnpm dev:users
 */
import { createHmac, randomBytes } from 'node:crypto';

/** Пароль демо-пользователей. На стенде, доступном снаружи, задаётся случайным (DEV_USERS_PASSWORD). */
export const DEV_PASSWORD = process.env.DEV_USERS_PASSWORD || 'dev-only-password-1';

export const DEV_USERS: Record<string, string> = {
  smirnova: 'Смирнова А. В.',
  ershova: 'Ершова Т. Н.',
  kolesnikov: 'Колесников Д. А.',
  gusev: 'Гусев П. Р.',
  petrov: 'Петров С. В.',
  orlov: 'Орлов К. М.',
  safonova: 'Сафонова Е. И.',
  melnikova: 'Мельникова Н. А.',
  belova: 'Белова Л. Р.',
  outsider: 'Посторонний пользователь',
};

/** POST/PUT с повтором при 429: у Synapse лимиты на вход и регистрацию. */
async function call(url: string, init: RequestInit = {}, attempts = 5): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429 || attempt >= attempts) return res;
    const body = (await res.json().catch(() => ({}))) as { retry_after_ms?: number };
    await new Promise((r) => setTimeout(r, Math.min(body.retry_after_ms ?? 1000, 30_000) + 100));
  }
}

const json = { 'content-type': 'application/json' };

export interface Registration {
  access_token?: string;
  user_id?: string;
  errcode?: string;
  error?: string;
}

/**
 * Регистрация пользователя с именем. У Synapse — admin API с общим секретом; у Tuwunel такого API нет —
 * обычная регистрация с токеном (registration_token, тот же dev-only-секрет), имя задаётся после.
 */
export async function registerUser(hs: string, sharedSecret: string, user: string, password: string, displayname?: string): Promise<Registration> {
  const nonceRes = await call(`${hs}/_synapse/admin/v1/register`);
  if (nonceRes.ok) {
    const { nonce } = (await nonceRes.json()) as { nonce: string };
    const mac = createHmac('sha1', sharedSecret).update(`${nonce}\0${user}\0${password}\0notadmin`).digest('hex');
    const reg = await call(`${hs}/_synapse/admin/v1/register`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ nonce, username: user, displayname, password, admin: false, mac }),
    });
    return (await reg.json()) as Registration;
  }
  const register = async (body: Record<string, unknown>) =>
    (await (await call(`${hs}/_matrix/client/v3/register`, { method: 'POST', headers: json, body: JSON.stringify(body) })).json()) as Registration & { session?: string };
  const body = { username: user, password };
  let reg = await register(body);
  if (reg.session) reg = await register({ ...body, auth: { type: 'm.login.registration_token', token: sharedSecret, session: reg.session } });
  if (reg.access_token && displayname) {
    const auth = { ...json, authorization: `Bearer ${reg.access_token}` };
    await call(`${hs}/_matrix/client/v3/profile/${encodeURIComponent(reg.user_id!)}/displayname`, { method: 'PUT', headers: auth, body: JSON.stringify({ displayname }) });
  }
  return reg;
}

export async function ensureDevUsers(
  hs = 'http://localhost:8008',
  sharedSecret = 'dev-only-registration-shared-secret',
  users: Record<string, string> = DEV_USERS,
  password = DEV_PASSWORD,
): Promise<void> {
  const versions = await fetch(`${hs}/_matrix/client/versions`).catch(() => null);
  if (!versions?.ok) throw new Error(`Сервер Matrix недоступен на ${hs}. Запустите: cd infra && docker compose up -d`);
  for (const [user, displayname] of Object.entries(users)) {
    // Имя задаётся сразу при регистрации — входить не нужно.
    const reg = await registerUser(hs, sharedSecret, user, password, displayname);
    if (reg.access_token) continue;
    if (reg.errcode !== 'M_USER_IN_USE') throw new Error(`Регистрация ${user}: ${JSON.stringify(reg)}`);

    // Пользователь уже был (например, его создали тесты) — обновляем имя от его лица.
    const login = await call(
      `${hs}/_matrix/client/v3/login`,
      { method: 'POST', headers: json, body: JSON.stringify({ type: 'm.login.password', identifier: { type: 'm.id.user', user }, password }) },
      2,
    );
    if (!login.ok) {
      // Учётная запись есть; имя не обновили (лимит входов Synapse или другой пароль) — это не повод останавливаться.
      console.warn(`${user}: учётная запись уже есть, имя не обновлено (${login.status === 429 ? 'лимит входов, повторите позже' : 'другой пароль'})`);
      continue;
    }
    const { access_token, user_id } = (await login.json()) as { access_token: string; user_id: string };
    const auth = { ...json, authorization: `Bearer ${access_token}` };
    await call(`${hs}/_matrix/client/v3/profile/${encodeURIComponent(user_id)}/displayname`, { method: 'PUT', headers: auth, body: JSON.stringify({ displayname }) });
    await call(`${hs}/_matrix/client/v3/logout`, { method: 'POST', headers: auth, body: '{}' });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , command, login, ...name] = process.argv;
  const hs = process.env.HS_URL || undefined;
  const secret = process.env.SYNAPSE_REGISTRATION_SECRET || undefined;
  if (command === 'add') {
    // Учётная запись для тестировщика: pnpm --filter @konsilium/host-mock users add ivanov "Иванов И. И."
    if (!login || !/^[a-z0-9._=-]+$/.test(login)) throw new Error('Укажите логин: латиница, цифры, «.», «_», «-»');
    // Пароль может задать вызывающий (stand.sh заводит тот же пароль и в Keycloak); иначе — случайный.
    const password = process.env.NEW_USER_PASSWORD || randomBytes(9).toString('base64url');
    await ensureDevUsers(hs, secret, { [login]: name.join(' ') || login }, password);
    console.log(`Пользователь ${login} создан. Пароль: ${password}`);
  } else {
    await ensureDevUsers(hs, secret);
    console.log(`Пользователи стенда готовы: ${Object.keys(DEV_USERS).join(', ')}. Пароль: ${DEV_PASSWORD}`);
  }
}
