/**
 * Пользователи стенда: регистрация через admin API Synapse (общий секрет из infra/synapse/homeserver.yaml)
 * и имена, которые в продукте пришли бы из каталога (Keycloak/AD). Все данные вымышлены.
 * Запуск: pnpm dev:users
 */
import { createHmac } from 'node:crypto';

export const DEV_PASSWORD = 'dev-only-password-1';

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

export async function ensureDevUsers(
  hs = 'http://localhost:8008',
  sharedSecret = 'dev-only-registration-shared-secret',
  users: Record<string, string> = DEV_USERS,
): Promise<void> {
  const versions = await fetch(`${hs}/_matrix/client/versions`).catch(() => null);
  if (!versions?.ok) throw new Error(`Synapse недоступен на ${hs}. Запустите: cd infra && docker compose up -d`);
  for (const [user, displayname] of Object.entries(users)) {
    const { nonce } = (await (await fetch(`${hs}/_synapse/admin/v1/register`)).json()) as { nonce: string };
    const mac = createHmac('sha1', sharedSecret).update(`${nonce}\0${user}\0${DEV_PASSWORD}\0notadmin`).digest('hex');
    const reg = await fetch(`${hs}/_synapse/admin/v1/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce, username: user, password: DEV_PASSWORD, admin: false, mac }),
    });
    const regJson = (await reg.json()) as { errcode?: string };
    if (!reg.ok && regJson.errcode !== 'M_USER_IN_USE') throw new Error(`Регистрация ${user}: ${JSON.stringify(regJson)}`);

    const login = await fetch(`${hs}/_matrix/client/v3/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'm.login.password', identifier: { type: 'm.id.user', user }, password: DEV_PASSWORD }),
    });
    const { access_token, user_id } = (await login.json()) as { access_token: string; user_id: string };
    const auth = { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' };
    await fetch(`${hs}/_matrix/client/v3/profile/${encodeURIComponent(user_id)}/displayname`, { method: 'PUT', headers: auth, body: JSON.stringify({ displayname }) });
    await fetch(`${hs}/_matrix/client/v3/logout`, { method: 'POST', headers: auth, body: '{}' });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await ensureDevUsers(process.env.HS_URL, process.env.SYNAPSE_REGISTRATION_SECRET);
  console.log(`Пользователи стенда готовы: ${Object.keys(DEV_USERS).join(', ')}. Пароль: ${DEV_PASSWORD}`);
}
