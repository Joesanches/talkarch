/**
 * Интеграционный тест «чата случая» на настоящем Synapse: сервис контекста + песочница РИС/ЛИС по HTTP.
 * Перед запуском: cd infra && docker compose up -d   (см. infra/README.md)
 * Запуск: pnpm test:it
 */
import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHostMock, type HostMock } from '@konsilium/host-mock';
import { EventType, MsgType, NotificationField, RoomType } from '@konsilium/protocol';
import { loadConfig } from '../../src/config.ts';
import { createService } from '../../src/index.ts';

const HS = process.env.HS_URL ?? 'http://localhost:8008';
const SHARED_SECRET = process.env.SYNAPSE_REGISTRATION_SECRET ?? 'dev-only-registration-shared-secret';
const PASSWORD = 'dev-only-password-1';
const CCS_PORT = 8080;
const CCS = `http://127.0.0.1:${CCS_PORT}`;
const MOCK_PORT = 8090;
const LIS_CASE = 'Г26-04512';
const RIS_CASE = 'A26-118734';
const enc = encodeURIComponent;

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
  return { status: res.status, json: (await res.json()) as any, headers: res.headers };
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

const timeline = async (token: string, roomId: string) =>
  (await cs(token, 'GET', `/rooms/${enc(roomId)}/messages?dir=b&limit=50`)).json.chunk as any[];
const membership = async (token: string, roomId: string, userId: string) =>
  (await cs(token, 'GET', `/rooms/${enc(roomId)}/state/m.room.member/${enc(userId)}`)).json.membership as string | undefined;

describe('Чат случая на Synapse с песочницей РИС/ЛИС', () => {
  let app: FastifyInstance;
  let mock: HostMock;
  const tok: Record<string, string> = {};
  let roomId = '';

  beforeAll(async () => {
    const versions = await fetch(`${HS}/_matrix/client/versions`).catch(() => null);
    if (!versions?.ok) throw new Error(`Synapse недоступен на ${HS}. Запустите: cd infra && docker compose up -d`);

    for (const u of ['smirnova', 'ershova', 'kolesnikov', 'gusev', 'outsider', 'orlov', 'belova', 'petrov']) tok[u] = await ensureUser(u);

    // Подключения — из конфигурации разработчика (fixtures/connectors.json). Секрет псевдонимов свой на каждый
    // прогон: новые псевдонимы, а значит, новые комнаты в той же базе Synapse.
    const config = loadConfig({
      ...process.env,
      CCS_HOST: '0.0.0.0',
      CCS_PORT: String(CCS_PORT),
      HS_URL: HS,
      AS_TOKEN: 'dev-only-as-token-0123456789abcdef',
      HS_TOKEN: 'dev-only-hs-token-0123456789abcdef',
      ALIAS_SECRET: `dev-only-alias-secret-it-${Date.now()}`,
      CONNECTORS_FILE: resolve(import.meta.dirname, '../../fixtures/connectors.json'),
      LIVEKIT_API_KEY: 'devkey',
      LIVEKIT_API_SECRET: 'secret',
    });
    mock = createHostMock({
      ccsUrl: CCS,
      stepMs: 300,
      connectors: [
        { id: 'lis', token: 'dev-only-lis-token-0123456789abcdef', callbackToken: 'dev-only-lis-callback-token-0123456789' },
        { id: 'ris', token: 'dev-only-ris-token-0123456789abcdef' },
      ],
    });
    // Песочница стартует первой: при старте сервис контекста просит Synapse дослать накопленные события,
    // и заявки из прошлых прогонов должны найти ЛИС.
    await mock.app.listen({ host: '127.0.0.1', port: MOCK_PORT });
    app = createService(config, { logger: false, log: { info() {}, warn() {}, error: console.error } }).app;
    await app.listen({ host: config.host, port: config.port });
  });

  afterAll(async () => {
    await mock?.app.close();
    await app?.close();
  });

  it('система-источник отправляет снимки случаев; чаты при этом не создаются', async () => {
    const sent = await mock.pushCases();
    for (const r of Object.values(sent)) {
      expect(r.status).toBe(200);
      expect(r.body.results.every((x) => x.status === 'accepted')).toBe(true);
    }
  });

  it('первое открытие создаёт комнату случая и приглашает участников по ролям', async () => {
    const res = await api(tok.smirnova!, '/api/v1/cases/open', { connector: 'lis', caseId: LIS_CASE });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ created: true, membership: 'invite', connector: 'lis' });
    roomId = res.json.roomId;
    const sync = await cs(tok.ershova!, 'GET', `/sync?timeout=0&filter=${enc(JSON.stringify({ room: { timeline: { limit: 1 } } }))}`);
    expect(Object.keys(sync.json.rooms?.invite ?? {})).toContain(roomId);
  });

  it('повторные и параллельные открытия дают ту же комнату', async () => {
    const results = await Promise.all(['smirnova', 'kolesnikov', 'ershova'].map((u) => api(tok[u]!, '/api/v1/cases/open', { connector: 'lis', caseId: LIS_CASE })));
    for (const r of results) expect(r.json).toMatchObject({ roomId, created: false });
  });

  it('в комнате тип «чат случая», контекст из ЛИС и только маска ФИО', async () => {
    expect((await cs(tok.smirnova!, 'POST', `/join/${enc(roomId)}`, {})).status).toBe(200);
    const create = await cs(tok.smirnova!, 'GET', `/rooms/${enc(roomId)}/state/m.room.create/`);
    expect(create.json.type).toBe(RoomType.Case);
    const ctx = await cs(tok.smirnova!, 'GET', `/rooms/${enc(roomId)}/state/${EventType.CaseContext}/`);
    expect(ctx.json).toMatchObject({ source: 'LIS', connector: 'lis', case_id: LIS_CASE, patient: { masked: 'Н*** О. В.' } });
    expect(JSON.stringify(ctx.json)).not.toMatch(/Нестерова/);
    const pl = await cs(tok.smirnova!, 'GET', `/rooms/${enc(roomId)}/state/m.room.power_levels/`);
    expect(pl.json.invite).toBe(100);
  });

  it('участник не может сам пригласить постороннего — состав задаёт система-источник', async () => {
    const res = await cs(tok.smirnova!, 'POST', `/rooms/${enc(roomId)}/invite`, { user_id: '@outsider:konsilium.test' });
    expect(res.status).toBe(403);
  });

  it('доступ по требованию через обратный вызов ЛИС: заведующий — да, посторонний — нет', async () => {
    expect((await api(tok.gusev!, '/api/v1/cases/open', { connector: 'lis', caseId: LIS_CASE })).json).toMatchObject({ roomId, membership: 'invite' });
    expect((await api(tok.outsider!, '/api/v1/cases/open', { connector: 'lis', caseId: LIS_CASE })).status).toBe(403);
  });

  it('заявка ИГХ из чата уходит в ЛИС, статусы приходят в чат до «готово»', async () => {
    const send = await cs(tok.smirnova!, 'PUT', `/rooms/${enc(roomId)}/send/m.room.message/it-req-${Date.now()}`, {
      msgtype: MsgType.Request,
      body: 'Запрос ИГХ: блок 1А — ER, PR, HER2/neu, Ki-67 (срочно)',
      [MsgType.Request]: { kind: 'ihc', block: '1А', items: ['ER', 'PR', 'HER2/neu', 'Ki-67'], priority: 'urgent' },
    });
    expect(send.status).toBe(200);
    const requestEventId = send.json.event_id as string;

    const all = await waitFor(async () => {
      const s = (await timeline(tok.smirnova!, roomId)).filter(
        (e) => e.type === EventType.RequestStatus && e.content?.['m.relates_to']?.event_id === requestEventId,
      );
      return s.length === 4 ? s.reverse() : undefined;
    });
    expect(all.every((e) => e.sender === '@ccs:konsilium.test')).toBe(true);
    expect(all.map((e) => e.content.status)).toEqual(['accepted', 'staining', 'scanning', 'done']);
    expect(all[0].content).toMatchObject({ external_id: expect.stringMatching(/^ИГХ-\d+$/), source: 'LIS' });
  });

  it('изменение случая в ЛИС: новый участник приглашён, отозванный выведен, название обновлено', async () => {
    const participants = mock.cases.get('lis')![0]!.snapshot.participants;
    const res = await mock.updateCase('lis', LIS_CASE, {
      title: 'Биопсия молочной железы, слева (пересмотр)',
      participants: [...participants.filter((p) => p.user.login !== 'kolesnikov'), { user: { login: 'petrov' }, role: 'lab_tech' }],
      revoked: [{ login: 'kolesnikov' }],
    });
    expect(res.body.results[0]).toMatchObject({ status: 'accepted' });
    expect(await membership(tok.smirnova!, roomId, '@petrov:konsilium.test')).toBe('invite');
    expect(await membership(tok.smirnova!, roomId, '@kolesnikov:konsilium.test')).toBe('leave');
    const name = await cs(tok.smirnova!, 'GET', `/rooms/${enc(roomId)}/state/m.room.name/`);
    expect(name.json.name).toBe('Г26-04512 · Биопсия молочной железы, слева (пересмотр)');
  });

  it('уведомление из ЛИС приходит в чат служебным сообщением с кнопкой', async () => {
    const res = await mock.notify('lis', LIS_CASE, 'Стёкла ИГХ отсканированы', {
      category: 'ready',
      links: [{ label: 'Открыть во вьюере', url: 'https://wsi.clinic.local/case/G26-04512' }],
    });
    expect(res.body.results[0]).toMatchObject({ status: 'accepted' });
    const notice = await waitFor(async () => (await timeline(tok.smirnova!, roomId)).find((e) => e.content?.[NotificationField]?.category === 'ready'));
    expect(notice.content).toMatchObject({ msgtype: 'm.notice', body: expect.stringMatching(/^Стёкла ИГХ отсканированы/) });
  });

  it('данные пациента — участнику по запросу, мимо Matrix, с журналом в ЛИС', async () => {
    const res = await api(tok.smirnova!, '/api/v1/cases/patient', { roomId, reason: 'сверка перед описанием' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.json.patient.display_name).toBe('Нестерова Ольга Викторовна');
    expect(mock.audit.at(-1)).toMatchObject({ login: 'smirnova', action: 'patient_reveal' });
    expect(JSON.stringify(await timeline(tok.smirnova!, roomId))).not.toMatch(/Нестерова/);
  });

  it('РИС уровня 1: доступ по списку access из события, без обратных вызовов', async () => {
    const res = await api(tok.belova!, '/api/v1/cases/open', { system: 'RIS', caseId: RIS_CASE });
    expect(res.json).toMatchObject({ connector: 'ris', created: true, membership: 'invite' });
    expect((await api(tok.gusev!, '/api/v1/cases/open', { connector: 'ris', caseId: RIS_CASE })).status).toBe(403);
  });

  it('токен видеосвязи — только вошедшему участнику комнаты', async () => {
    const ok = await api(tok.smirnova!, '/api/v1/calls/token', { roomId });
    expect(ok.status).toBe(200);
    const payload = JSON.parse(Buffer.from(ok.json.token.split('.')[1], 'base64url').toString());
    expect(payload.video).toMatchObject({ roomJoin: true, room: ok.json.room });
    expect((await api(tok.ershova!, '/api/v1/calls/token', { roomId })).status).toBe(403); // приглашена, но не вошла
    expect((await api(tok.outsider!, '/api/v1/calls/token', { roomId })).status).toBe(403);
  });
});
