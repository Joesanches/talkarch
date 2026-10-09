import { generateKeyPairSync, verify, createVerify } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createH2Server, type IncomingHttpHeaders } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { PushSignal } from '@konsilium/protocol/push';
import { ApnsProvider } from '../../src/providers/apns.ts';
import { FcmProvider } from '../../src/providers/fcm.ts';
import { RuStoreProvider } from '../../src/providers/rustore.ts';

const texts = { title: 'Консилиум', message: 'Новое сообщение', critical: 'Критическая находка — требуется подтверждение', call: 'Входящий звонок' };
const critical: PushSignal = { id: 's1', kind: 'critical', prio: 'high', room_id: '!r:konsilium.test', event_id: '$e1', unread: 3 };
const message: PushSignal = { id: 's2', kind: 'message', prio: 'low', room_id: '!r:konsilium.test', event_id: '$e2' };
const DEVICE = 'a'.repeat(64);

const closers: Array<() => void> = [];
afterEach(() => closers.splice(0).forEach((c) => c()));

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<string, unknown>;

type Http1Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
async function http1(handler: Http1Handler): Promise<string> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => handler(req, body, res));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('APNs', () => {
  it('HTTP/2 с токеном провайдера ES256: общий текст по виду, time-sensitive для находки; 410 — недействительный токен', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const seen: Array<{ headers: IncomingHttpHeaders; body: Record<string, any> }> = [];
    const server = createH2Server();
    server.on('stream', (stream, headers) => {
      let body = '';
      stream.on('data', (c) => (body += c));
      stream.on('end', () => {
        seen.push({ headers, body: JSON.parse(body) });
        const dead = String(headers[':path']).includes('/3/device/b');
        stream.respond({ ':status': dead ? 410 : 200 });
        stream.end(dead ? JSON.stringify({ reason: 'Unregistered' }) : '');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    closers.push(() => server.close());
    const apns = new ApnsProvider({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      keyId: 'KEY1234567',
      teamId: 'TEAM123456',
      topic: 'ru.vendor.konsilium',
      texts,
    });
    closers.push(() => apns.close());

    expect(await apns.send(DEVICE, critical)).toBe('ok');
    expect(await apns.send(DEVICE, message)).toBe('ok');
    expect(await apns.send('b'.repeat(64), message)).toBe('invalid');
    expect(await apns.send('не-токен', message)).toBe('invalid'); // без запроса

    const [first, second] = seen;
    expect(first!.headers).toMatchObject({ ':path': `/3/device/${DEVICE}`, 'apns-topic': 'ru.vendor.konsilium', 'apns-push-type': 'alert', 'apns-priority': '10' });
    expect(second!.headers['apns-priority']).toBe('5');
    expect(first!.body).toEqual({
      aps: { alert: { title: 'Консилиум', body: texts.critical }, sound: 'default', badge: 3, 'interruption-level': 'time-sensitive' },
      kind: 'critical',
      room_id: '!r:konsilium.test',
      event_id: '$e1',
    });
    expect(second!.body.aps.alert.body).toBe('Новое сообщение');
    // Токен провайдера: ES256, kid и iss из настроек; один на несколько запросов.
    const jwt = String(first!.headers.authorization).replace(/^bearer /, '');
    const [h, p, sig] = jwt.split('.');
    expect(decode(h!)).toMatchObject({ alg: 'ES256', kid: 'KEY1234567' });
    expect(decode(p!)).toMatchObject({ iss: 'TEAM123456' });
    expect(verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig!, 'base64url'))).toBe(true);
    expect(second!.headers.authorization).toBe(first!.headers.authorization);
    expect(seen).toHaveLength(3);
  });
});

describe('FCM HTTP v1', () => {
  it('токен доступа по ключу сервисного аккаунта (кешируется), только данные, приоритет HIGH для находки; 404 и UNREGISTERED — недействительный токен', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    let tokenRequests = 0;
    const sends: Array<{ auth?: string; body: any }> = [];
    let base = '';
    base = await http1((req, body, res) => {
      if (req.url === '/token') {
        tokenRequests++;
        const assertion = new URLSearchParams(body).get('assertion')!;
        const [h, p, sig] = assertion.split('.');
        const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig!, 'base64url'));
        const claims = decode(p!);
        if (!ok || claims.aud !== `${base}/token` || claims.scope !== 'https://www.googleapis.com/auth/firebase.messaging') {
          res.writeHead(401).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'at-1', expires_in: 3600 }));
        return;
      }
      const parsed = JSON.parse(body);
      sends.push({ auth: req.headers.authorization, body: parsed });
      const token = parsed.message.token as string;
      if (token === 'gone') res.writeHead(404).end('{}');
      else if (token === 'unreg') res.writeHead(400).end(JSON.stringify({ error: { details: [{ errorCode: 'UNREGISTERED' }] } }));
      else if (token === 'broken') res.writeHead(500).end('{}');
      else res.writeHead(200).end('{}');
    });
    const fcm = new FcmProvider({
      url: base,
      account: { client_email: 'push@konsilium-test.iam.example', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), token_uri: `${base}/token`, project_id: 'p1' },
    });
    expect(await fcm.send('device-1', critical)).toBe('ok');
    expect(await fcm.send('device-1', message)).toBe('ok');
    expect(await fcm.send('gone', message)).toBe('invalid');
    expect(await fcm.send('unreg', message)).toBe('invalid');
    expect(await fcm.send('broken', message)).toBe('failed');
    expect(tokenRequests).toBe(1);
    expect(sends[0]).toEqual({
      auth: 'Bearer at-1',
      body: { message: { token: 'device-1', data: { id: 's1', kind: 'critical', prio: 'high', room_id: '!r:konsilium.test', event_id: '$e1', unread: '3' }, android: { priority: 'HIGH', ttl: '3600s' } } },
    });
    expect(sends[1]!.body.message.android.priority).toBe('NORMAL');
  });
});

describe('RuStore Push', () => {
  it('сервисный токен, только данные; 404 — недействительный токен, прочие ошибки — не удалось', async () => {
    const sends: Array<{ url?: string; auth?: string; body: any }> = [];
    const base = await http1((req, body, res) => {
      const parsed = JSON.parse(body);
      sends.push({ url: req.url, auth: req.headers.authorization, body: parsed });
      const token = parsed.message.token as string;
      res.writeHead(token === 'gone' ? 404 : token === 'bad' ? 400 : 200).end(token === 'bad' ? JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT' } }) : '');
    });
    const rustore = new RuStoreProvider({ url: base, projectId: 'proj-1', serviceToken: 'svc-token' });
    expect(await rustore.send('device-1', message)).toBe('ok');
    expect(await rustore.send('gone', message)).toBe('invalid');
    expect(await rustore.send('bad', message)).toBe('failed');
    expect(sends[0]).toEqual({
      url: '/v1/projects/proj-1/messages:send',
      auth: 'Bearer svc-token',
      body: { message: { token: 'device-1', data: { id: 's2', kind: 'message', prio: 'low', room_id: '!r:konsilium.test', event_id: '$e2' } } },
    });
  });
});
