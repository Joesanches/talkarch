/**
 * Шлюз с настоящим сервером сообщений (Synapse или Tuwunel из infra/): pusher и правила push ставятся так же, как это
 * будет делать мобильное приложение; сервер сообщений ходит к шлюзу через host.docker.internal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerUser } from '@konsilium/host-mock/users';
import { EventType, MsgType } from '@konsilium/protocol';
import { PUSH_EXTERNAL_KEY, PUSH_RULES, PushAppId, PushSignal } from '@konsilium/protocol/push';
import { buildApp } from '../../src/app.ts';
import { connect, FakeProvider, newPushkey } from '../unit/helpers.ts';

const HS = process.env.HS_URL ?? 'http://localhost:8008';
const SHARED_SECRET = process.env.SYNAPSE_REGISTRATION_SECRET ?? 'dev-only-registration-shared-secret';
const PORT = Number(process.env.PUSH_IT_PORT ?? 8076);
/** Адрес шлюза для сервера сообщений (он в Docker, шлюз — на хосте). */
const NOTIFY_URL = process.env.PUSH_IT_NOTIFY_URL ?? `http://host.docker.internal:${PORT}/_matrix/push/v1/notify`;
const enc = encodeURIComponent;

async function cs<T = any>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${HS}/_matrix/client/v3${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T;
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const rustore = new FakeProvider('rustore');
const { app } = buildApp({ config: { external: 'all', ackTimeoutMs: 1500, heartbeatMs: 60_000 }, providers: { rustore } });
const base = `http://127.0.0.1:${PORT}`;
let sender: string;
let doctor: string;
let roomId: string;
const pushkey = newPushkey();

beforeAll(async () => {
  await app.listen({ host: '0.0.0.0', port: PORT });
  const t = Date.now().toString(36);
  sender = (await registerUser(HS, SHARED_SECRET, `push-a-${t}`, 'dev-only-password-1')).access_token!;
  doctor = (await registerUser(HS, SHARED_SECRET, `push-b-${t}`, 'dev-only-password-1')).access_token!;
  const doctorId = (await cs<{ user_id: string }>(doctor, 'GET', '/account/whoami')).user_id;
  roomId = (await cs<{ room_id: string }>(sender, 'POST', '/createRoom', { preset: 'private_chat', invite: [doctorId] })).room_id;
  await cs(doctor, 'POST', `/join/${enc(roomId)}`, {});
  // Как приложение: pusher с прямым каналом и внешним токеном, правила push для находок и звонков.
  await cs(doctor, 'POST', '/pushers/set', {
    kind: 'http',
    app_id: PushAppId.Android,
    pushkey,
    app_display_name: 'Консилиум',
    device_display_name: 'Тестовый телефон',
    lang: 'ru',
    data: { url: NOTIFY_URL, [PUSH_EXTERNAL_KEY]: { provider: 'rustore', token: 'rustore-device-token' } },
  });
  for (const rule of PUSH_RULES) await cs(doctor, 'PUT', `/pushrules/global/override/${enc(rule.rule_id)}`, { conditions: rule.conditions, actions: rule.actions });
});

afterAll(async () => {
  await app.close();
});

const send = (type: string, content: Record<string, unknown>) => cs<{ event_id: string }>(sender, 'PUT', `/rooms/${enc(roomId)}/send/${enc(type)}/t${Date.now()}${Math.random()}`, content);

describe('push-шлюз и сервер сообщений', () => {
  it('сообщение, критическая находка и звонок приходят по прямому соединению — без содержимого, с видом и приоритетом', async () => {
    const conn = await connect(base, pushkey);
    const wait = async (eventId: string) => {
      for (;;) {
        const s = PushSignal.parse(await conn.next('push', 15_000));
        expect((await fetch(`${base}/v1/ack`, { method: 'POST', headers: { authorization: `Bearer ${pushkey}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: s.id }) })).status).toBe(204);
        if (s.event_id === eventId) return s;
      }
    };

    const text = await send('m.room.message', { msgtype: 'm.text', body: 'Пациентка Н***: блок 1А готов' });
    const s1 = await wait(text.event_id);
    expect(s1).toMatchObject({ kind: 'message', room_id: roomId });
    expect(JSON.stringify(s1)).not.toMatch(/Пациентка/);
    expect(typeof s1.unread).toBe('number');

    const crit = await send('m.room.message', { msgtype: MsgType.Critical, body: 'Критическая находка: пневмоторакс', [MsgType.Critical]: { finding: 'пневмоторакс' } });
    expect(await wait(crit.event_id)).toMatchObject({ kind: 'critical', prio: 'high' });

    const call = await send(EventType.CallInvite, { call_id: 'main', kind: 'direct', lifetime: 60_000 });
    expect(await wait(call.event_id)).toMatchObject({ kind: 'call', prio: 'high' });
    expect(rustore.sent).toHaveLength(0);
    conn.close();
  });

  it('прямого соединения нет — сигнал уходит внешним каналом устройства', async () => {
    await new Promise((r) => setTimeout(r, 300));
    const text = await send('m.room.message', { msgtype: 'm.text', body: 'Вне сети организации' });
    const until = Date.now() + 15_000;
    while (!rustore.sent.some((s) => s.signal.event_id === text.event_id) && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
    expect(rustore.sent.find((s) => s.signal.event_id === text.event_id)).toMatchObject({ token: 'rustore-device-token', signal: { kind: 'message', room_id: roomId } });
  });
});
