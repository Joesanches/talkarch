/**
 * Интеграционный тест «чата случая» на настоящем Synapse.
 * Перед запуском: cd infra && docker compose up -d   (см. infra/README.md)
 * Запуск: pnpm test:it
 */
import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventType, MsgType, RoomType } from '@konsilium/protocol';
import { loadConfig } from '../../src/config.ts';
import { createService } from '../../src/index.ts';

const HS = process.env.HS_URL ?? 'http://localhost:8008';
const SHARED_SECRET = process.env.SYNAPSE_REGISTRATION_SECRET ?? 'dev-only-registration-shared-secret';
const PASSWORD = 'dev-only-password-1';
const CCS_PORT = 8080;
const CCS = `http://127.0.0.1:${CCS_PORT}`;
// Своя «организация» на каждый прогон: новые псевдонимы, а значит, новые комнаты в той же БД.
const ORG = `it-${Date.now()}`;

async function cs<T = any>(token: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${HS}/_matrix/client/v3${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as T };
}

/** Пользователь через admin API с общим секретом; если уже есть — вход по паролю. */
async function ensureUser(localpart: string): Promise<string> {
  const nonceRes = await fetch(`${HS}/_synapse/admin/v1/register`);
  const { nonce } = (await nonceRes.json()) as { nonce: string };
  const mac = createHmac('sha1', SHARED_SECRET).update(`${nonce}\0${localpart}\0${PASSWORD}\0notadmin`).digest('hex');
  const reg = await fetch(`${HS}/_synapse/admin/v1/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonce, username: localpart, password: PASSWORD, admin: false, mac }),
  });
  const regJson = (await reg.json()) as { access_token?: string; errcode?: string };
  if (regJson.access_token) return regJson.access_token;
  if (regJson.errcode !== 'M_USER_IN_USE') throw new Error(`Регистрация ${localpart}: ${JSON.stringify(regJson)}`);
  const login = await cs<{ access_token: string }>(null, 'POST', '/login', {
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user: localpart },
    password: PASSWORD,
  });
  return login.json.access_token;
}

async function api(token: string | null, path: string, body: unknown) {
  const res = await fetch(`${CCS}${path}`, {
    method: 'POST',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Не дождались результата');
}

describe('Чат случая на Synapse', () => {
  let app: FastifyInstance;
  const tok: Record<string, string> = {};
  const CASE = { system: 'LIS', caseId: 'Г26-04512' };
  let roomId = '';

  beforeAll(async () => {
    const versions = await fetch(`${HS}/_matrix/client/versions`).catch(() => null);
    if (!versions?.ok) throw new Error(`Synapse недоступен на ${HS}. Запустите: cd infra && docker compose up -d`);

    for (const u of ['smirnova', 'ershova', 'kolesnikov', 'gusev', 'outsider']) tok[u] = await ensureUser(u);

    const config = loadConfig({
      ...process.env,
      CCS_HOST: '0.0.0.0',
      CCS_PORT: String(CCS_PORT),
      CCS_ORG: ORG,
      HS_URL: HS,
      AS_TOKEN: 'dev-only-as-token-0123456789abcdef',
      HS_TOKEN: 'dev-only-hs-token-0123456789abcdef',
      ALIAS_SECRET: 'dev-only-alias-secret-0123456789',
      HOST_DIRECTORY_FILE: resolve(import.meta.dirname, '../../fixtures/host-directory.json'),
      LIVEKIT_API_KEY: 'devkey',
      LIVEKIT_API_SECRET: 'secret',
    });
    app = createService(config, { logger: false }).app;
    await app.listen({ host: config.host, port: config.port });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('первое открытие создаёт комнату случая и приглашает участников по ролям', async () => {
    const res = await api(tok.smirnova!, '/api/v1/cases/open', CASE);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ created: true, membership: 'invite' });
    roomId = res.json.roomId;

    // Ершова (лаборант) приглашена автоматически — по роли из ЛИС.
    const sync = await cs(tok.ershova!, 'GET', `/sync?timeout=0&filter=${encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 1 } } }))}`);
    expect(Object.keys(sync.json.rooms?.invite ?? {})).toContain(roomId);
  });

  it('повторные и параллельные открытия дают ту же комнату', async () => {
    const results = await Promise.all(['smirnova', 'kolesnikov', 'ershova'].map((u) => api(tok[u]!, '/api/v1/cases/open', CASE)));
    for (const r of results) expect(r.json).toMatchObject({ roomId, created: false });
  });

  it('в комнате тип «чат случая», контекст из ЛИС и только маска ФИО', async () => {
    expect((await cs(tok.smirnova!, 'POST', `/join/${encodeURIComponent(roomId)}`, {})).status).toBe(200);
    const create = await cs(tok.smirnova!, 'GET', `/rooms/${encodeURIComponent(roomId)}/state/m.room.create/`);
    expect(create.json.type).toBe(RoomType.Case);
    const ctx = await cs(tok.smirnova!, 'GET', `/rooms/${encodeURIComponent(roomId)}/state/${EventType.CaseContext}/`);
    expect(ctx.json).toMatchObject({ source: 'LIS', case_id: 'Г26-04512', patient: { masked: 'Н*** О. В.' } });
    const pl = await cs(tok.smirnova!, 'GET', `/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels/`);
    expect(pl.json.invite).toBe(100);
  });

  it('участник не может сам пригласить постороннего — состав задаёт система-источник', async () => {
    const outsiderId = (await cs(tok.outsider!, 'GET', '/account/whoami')).json.user_id;
    const res = await cs(tok.smirnova!, 'POST', `/rooms/${encodeURIComponent(roomId)}/invite`, { user_id: outsiderId });
    expect(res.status).toBe(403);
  });

  it('доступ по требованию: заведующий получает приглашение, посторонний — отказ', async () => {
    expect((await api(tok.gusev!, '/api/v1/cases/open', CASE)).json).toMatchObject({ roomId, membership: 'invite' });
    expect((await api(tok.outsider!, '/api/v1/cases/open', CASE)).status).toBe(403);
  });

  it('заявка ИГХ из чата уходит в ЛИС, статус возвращается в чат', async () => {
    const send = await cs(tok.smirnova!, 'PUT', `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/it-req-${Date.now()}`, {
      msgtype: MsgType.Request,
      body: 'Запрос ИГХ: блок 1А — ER, PR, HER2/neu, Ki-67 (срочно)',
      [MsgType.Request]: { kind: 'ihc', block: '1А', items: ['ER', 'PR', 'HER2/neu', 'Ki-67'], priority: 'urgent' },
    });
    expect(send.status).toBe(200);
    const requestEventId = send.json.event_id as string;

    const status = await waitFor(async () => {
      const msgs = await cs(tok.smirnova!, 'GET', `/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=20`);
      return (msgs.json.chunk as any[]).find(
        (e) => e.type === EventType.RequestStatus && e.content?.['m.relates_to']?.event_id === requestEventId,
      );
    });
    expect(status.sender).toBe('@ccs:konsilium.test');
    expect(status.content).toMatchObject({ status: 'accepted', external_id: expect.stringMatching(/^ИГХ-\d+$/), source: 'LIS' });
  });

  it('токен видеосвязи — только вошедшему участнику комнаты', async () => {
    const ok = await api(tok.smirnova!, '/api/v1/calls/token', { roomId });
    expect(ok.status).toBe(200);
    const payload = JSON.parse(Buffer.from(ok.json.token.split('.')[1], 'base64url').toString());
    expect(payload.video).toMatchObject({ roomJoin: true, room: ok.json.room });
    // Приглашён, но не вошёл.
    expect((await api(tok.ershova!, '/api/v1/calls/token', { roomId })).status).toBe(403);
    expect((await api(tok.outsider!, '/api/v1/calls/token', { roomId })).status).toBe(403);
  });
});
