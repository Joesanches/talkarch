/**
 * Интеграционный тест «чата случая» на настоящем сервере Matrix (Synapse; Tuwunel — tools/load/tuwunel):
 * сервис контекста + песочница РИС/ЛИС по HTTP.
 * Перед запуском: cd infra && docker compose up -d   (см. infra/README.md)
 * Запуск: pnpm test:it
 */
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHostMock, type HostMock } from '@konsilium/host-mock';
import { registerUser } from '@konsilium/host-mock/users';
import { EventType, MsgType, NotificationField, PREJOIN_STATE_KEY, RoomType } from '@konsilium/protocol';
import { loadConfig } from '../../src/config.ts';
import { createService } from '../../src/index.ts';

const HS = process.env.HS_URL ?? 'http://localhost:8008';
const SHARED_SECRET = process.env.SYNAPSE_REGISTRATION_SECRET ?? 'dev-only-registration-shared-secret';
const PASSWORD = 'dev-only-password-1';
const CCS_PORT = 8080;
const CCS = `http://127.0.0.1:${CCS_PORT}`;
const MOCK_PORT = 8090;
const LIS_CASE = 'Г26-04512';
// Хранилище — настоящий PostgreSQL из infra/ (своя база на прогон, удаляется в конце).
const PG_ADMIN = process.env.IT_PG_URL ?? 'postgres://synapse:synapse-dev@localhost:55432/postgres';
const PG_DB = `ccs_it_${Date.now()}`;
const RIS_CASE = 'A26-118734';
const enc = encodeURIComponent;
// Токен сервиса контекста (appservice) окружения разработчика: читать состояние комнаты глазами сервиса.
const AS = 'dev-only-as-token-0123456789abcdef';

async function cs<T = any>(token: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(`${HS}/_matrix/client/v3${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as T };
}

/** Пользователь (admin API Synapse или токен регистрации Tuwunel — registerUser); если уже есть — вход по паролю. */
async function ensureUser(localpart: string): Promise<string> {
  const regJson = await registerUser(HS, SHARED_SECRET, localpart, PASSWORD);
  if (regJson.access_token) return regJson.access_token;
  if (regJson.errcode !== 'M_USER_IN_USE') throw new Error(`Регистрация ${localpart}: ${JSON.stringify(regJson)}`);
  const login = await cs<{ access_token: string }>(null, 'POST', '/login', {
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user: localpart },
    password: PASSWORD,
  });
  return login.json.access_token;
}

const isTuwunel = async () => (await fetch(`${HS}/_tuwunel/server_version`).catch(() => null))?.ok === true;

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

describe('Чат случая на сервере Matrix с песочницей РИС/ЛИС', () => {
  let app: FastifyInstance;
  let svc: ReturnType<typeof createService>;
  let mock: HostMock;
  const tok: Record<string, string> = {};
  let roomId = '';
  let serviceConfig: ReturnType<typeof loadConfig>;
  let ihcExternalId = '';

  beforeAll(async () => {
    const versions = await fetch(`${HS}/_matrix/client/versions`).catch(() => null);
    if (!versions?.ok) throw new Error(`Сервер Matrix недоступен на ${HS}. Запустите: cd infra && docker compose up -d`);

    for (const u of ['smirnova', 'ershova', 'kolesnikov', 'gusev', 'outsider', 'orlov', 'belova', 'petrov', 'melnikova']) tok[u] = await ensureUser(u);

    // Подключения — из конфигурации разработчика (fixtures/connectors.json). Секрет псевдонимов свой на каждый
    // прогон: новые псевдонимы, а значит, новые комнаты в той же базе Synapse.
    const config = loadConfig({
      ...process.env,
      CCS_HOST: '0.0.0.0',
      CCS_PORT: String(CCS_PORT),
      HS_URL: HS,
      AS_TOKEN: AS,
      HS_TOKEN: 'dev-only-hs-token-0123456789abcdef',
      ALIAS_SECRET: `dev-only-alias-secret-it-${Date.now()}`,
      CONNECTORS_FILE: resolve(import.meta.dirname, '../../fixtures/connectors.json'),
      DATABASE_URL: PG_ADMIN.replace(/\/postgres$/, `/${PG_DB}`),
      LIVEKIT_API_KEY: 'devkey',
      LIVEKIT_API_SECRET: 'secret',
      CRITICAL_TICK_MS: '300',
      // Архив: закрытый случай уходит в архив на первом же проходе; проход тест вызывает сам.
      ARCHIVE_AFTER_DAYS: '0',
      ARCHIVE_TICK_MS: '0',
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
    serviceConfig = config;
    svc = createService(config, { logger: false, log: { info() {}, warn() {}, error: console.error } });
    app = svc.app;
    await app.listen({ host: config.host, port: config.port });
  });

  afterAll(async () => {
    await mock?.app.close();
    await app?.close();
    const admin = new pg.Client({ connectionString: PG_ADMIN });
    await admin.connect();
    await admin.query(`drop database if exists "${PG_DB}"`);
    await admin.end();
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
    // Снимок контекста случая — в самом приглашении: клиент покажет карточку и счётчики до входа на любом сервере.
    const invite = await cs(AS, 'GET', `/rooms/${enc(roomId)}/state/m.room.member/${enc('@ershova:konsilium.test')}`);
    expect(invite.json.displayname).toBeTruthy(); // имя приглашённого — как у обычного /invite
    expect(invite.json[PREJOIN_STATE_KEY]).toEqual([expect.objectContaining({ type: EventType.CaseContext, state_key: '', content: expect.objectContaining({ case_id: LIS_CASE }) })]);
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
    ihcExternalId = all[0].content.external_id;
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

  it('критическая находка: из чата и из РИС, статус пишет только сервис, эскалация, подтверждение адресатом', async () => {
    const ris = (await api(tok.orlov!, '/api/v1/cases/open', { connector: 'ris', caseId: RIS_CASE })).json.roomId as string;
    for (const u of ['orlov', 'melnikova']) expect((await cs(tok[u]!, 'POST', `/join/${enc(ris)}`, {})).status).toBe(200);
    const statusOf = async (eventId: string) => (await cs(tok.melnikova!, 'GET', `/rooms/${enc(ris)}/state/${EventType.CriticalStatus}/${enc(eventId)}`)).json;

    // Из чата: рентгенолог → дежурный врач (роль из РИС). Событие проходит через Synapse и Application Service.
    const sent = await cs(tok.orlov!, 'PUT', `/rooms/${enc(ris)}/send/m.room.message/it-crit-${Date.now()}`, {
      msgtype: MsgType.Critical,
      body: 'Критическая находка: двусторонняя ТЭЛА',
      [MsgType.Critical]: { finding: 'Двусторонняя ТЭЛА', recipient: { role: 'on_duty' }, ack_deadline: 'PT10M' },
    });
    const chatFinding = sent.json.event_id as string;
    expect(await waitFor(async () => ((await statusOf(chatFinding)).status ? statusOf(chatFinding) : undefined))).toMatchObject({
      status: 'pending',
      recipients: ['@melnikova:konsilium.test'],
      reported_by: '@orlov:konsilium.test',
    });
    // Участник не может сам «подтвердить» в статусе — его пишет только сервис (уровень 100).
    const forged = await cs(tok.melnikova!, 'PUT', `/rooms/${enc(ris)}/state/${EventType.CriticalStatus}/${enc(chatFinding)}`, { status: 'acknowledged' });
    expect(forged.status).toBe(403);

    // Из РИС: короткий срок и эскалация на заведующего.
    const raised = await mock.raiseCritical('ris', {
      case_id: RIS_CASE,
      finding_id: `КН-IT-${Date.now()}`,
      finding: 'Свободный газ в брюшной полости',
      reported_by: { login: 'orlov' },
      recipient: { role: 'on_duty' },
      ack_deadline: 'PT2S',
      escalation: [{ after: 'PT2S', action: 'notify', target: 'head', users: [{ login: 'gusev' }] }],
    });
    expect(raised.body.results[0]).toMatchObject({ status: 'accepted' });
    const hostFinding = await waitFor(async () =>
      (await timeline(tok.melnikova!, ris)).find((e) => e.content?.msgtype === MsgType.Critical && e.content[MsgType.Critical]?.host_finding_id),
    );
    expect(hostFinding.sender).toBe('@ccs:konsilium.test');
    const escalated = await waitFor(async () => {
      const st = await statusOf(hostFinding.event_id);
      return st.escalations?.length ? st : undefined;
    });
    expect(escalated.recipients).toEqual(['@melnikova:konsilium.test', '@gusev:konsilium.test']);
    // Статус пишется до приглашения (чтобы попасть в приглашение) — приглашение догоняет.
    await waitFor(async () => ((await membership(tok.melnikova!, ris, '@gusev:konsilium.test')) === 'invite' ? true : undefined));

    // Подтверждения — событием ru.vendor.ack; чужое не засчитывается.
    const ackFor = (token: string, target: string) =>
      cs(token, 'PUT', `/rooms/${enc(ris)}/send/${EventType.Ack}/it-ack-${Date.now()}-${Math.random()}`, { 'm.relates_to': { rel_type: 'm.reference', event_id: target } });
    expect((await ackFor(tok.orlov!, chatFinding)).status).toBe(200);
    await waitFor(async () => ((await timeline(tok.melnikova!, ris)).some((e) => String(e.content?.body ?? '').startsWith('Подтверждение не засчитано')) ? true : undefined));
    expect((await statusOf(chatFinding)).status).toBe('pending');
    for (const f of [chatFinding, hostFinding.event_id]) await ackFor(tok.melnikova!, f);
    for (const f of [chatFinding, hostFinding.event_id]) {
      const st = await waitFor(async () => ((await statusOf(f)).status === 'acknowledged' ? statusOf(f) : undefined));
      expect(st.acknowledged.by).toBe('@melnikova:konsilium.test');
    }
  });

  it('после перезапуска сервиса статус старой заявки доходит до чата (хранилище в PostgreSQL)', async () => {
    await app.close();
    svc = createService(serviceConfig, { logger: false, log: { info() {}, warn() {}, error: console.error } });
    app = svc.app;
    await app.listen({ host: serviceConfig.host, port: serviceConfig.port });
    const res = await mock.setRequestStatus('lis', ihcExternalId, 'rejected', 'Блок 1А исчерпан — нужен повторный забор');
    expect(res.body.results[0]).toMatchObject({ status: 'accepted' });
    const status = await waitFor(async () =>
      (await timeline(tok.smirnova!, roomId)).find((e) => e.type === EventType.RequestStatus && e.content?.status === 'rejected'),
    );
    expect(status.content).toMatchObject({ external_id: ihcExternalId, note: 'Блок 1А исчерпан — нужен повторный забор' });
    // Повтор того же события после перезапуска — дубликат (идемпотентность тоже в базе).
    const again = await mock.setRequestStatus('lis', ihcExternalId, 'rejected', 'Блок 1А исчерпан — нужен повторный забор');
    expect(again.body.results[0]).toMatchObject({ status: 'duplicate' });
    // Журнал критических находок тоже пережил перезапуск — отчёт для РИС.
    const report = await fetch(`${CCS}/integration/v1/critical-findings`, { headers: { authorization: 'Bearer dev-only-ris-token-0123456789abcdef' } });
    const findings = ((await report.json()) as { findings: Array<{ status: string; escalations: unknown[] }> }).findings;
    expect(findings.map((f) => f.status)).toEqual(['acknowledged', 'acknowledged']);
    expect(findings[1]!.escalations).toHaveLength(1);
  });

  it('токен видеосвязи — только вошедшему участнику комнаты', async () => {
    const ok = await api(tok.smirnova!, '/api/v1/calls/token', { roomId });
    expect(ok.status).toBe(200);
    const payload = JSON.parse(Buffer.from(ok.json.token.split('.')[1], 'base64url').toString());
    expect(payload.video).toMatchObject({ roomJoin: true, room: ok.json.room });
    expect((await api(tok.ershova!, '/api/v1/calls/token', { roomId })).status).toBe(403); // приглашена, но не вошла
    expect((await api(tok.outsider!, '/api/v1/calls/token', { roomId })).status).toBe(403);
  });

  it('архив: закрытый случай — только чтение, участники выведены и после /forget пропадают из Sliding Sync; возврат с полной историей', async () => {
    const CASE = 'A26-118736';
    const opened = await api(tok.orlov!, '/api/v1/cases/open', { connector: 'ris', caseId: CASE });
    const archRoom = opened.json.roomId as string;
    for (const u of ['orlov', 'melnikova']) expect((await cs(tok[u]!, 'POST', `/rooms/${enc(archRoom)}/join`, {})).status).toBe(200);
    await cs(tok.orlov!, 'PUT', `/rooms/${enc(archRoom)}/send/m.room.message/arch-1`, { msgtype: 'm.text', body: 'Описание готово, заключение в РИС' });

    await mock.updateCase('ris', CASE, { status: 'closed' });
    expect(await svc.archive.tick()).toEqual({ archived: 1, removed: 0 });
    for (const u of ['orlov', 'melnikova']) expect(await membership(AS, archRoom, `@${u}:konsilium.test`)).toBe('leave');
    expect((await cs(AS, 'GET', `/rooms/${enc(archRoom)}/state/${EventType.CaseArchive}/`)).json).toMatchObject({ status: 'archived' });

    // Sliding Sync отдаёт комнату, из которой вывели, пока пользователь её не «забудет» — это делает клиент.
    const sss = async (token: string) =>
      (
        await fetch(`${HS}/_matrix/client/unstable/org.matrix.simplified_msc3575/sync?timeout=0`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ lists: { all: { ranges: [[0, 199]], timeline_limit: 1, required_state: [[EventType.CaseArchive, '']] } } }),
        }).then((r) => r.json() as Promise<any>)
      ).rooms as Record<string, { required_state?: Array<{ type: string; content: { status?: string } }> }>;
    // Tuwunel в новом соединении комнату, из которой вывели, не отдаёт вовсе (docs/11-load-test.md, раздел 7).
    const before = (await sss(tok.melnikova!))[archRoom];
    if (before || !(await isTuwunel())) expect(before?.required_state?.find((e) => e.type === EventType.CaseArchive)?.content.status).toBe('archived');
    expect((await cs(tok.melnikova!, 'POST', `/rooms/${enc(archRoom)}/forget`, {})).status).toBe(200);
    // С воркерами «забыл» доходит до воркера синхронизации репликацией — с небольшой задержкой.
    await waitFor(async () => (Object.keys(await sss(tok.melnikova!)).includes(archRoom) ? undefined : true));

    // Папка «Архив» — у обоих участников.
    const list = await fetch(`${CCS}/api/v1/archive?q=${enc(CASE)}`, { headers: { authorization: `Bearer ${tok.melnikova}` } }).then((r) => r.json() as Promise<any>);
    expect(list.cases).toEqual([expect.objectContaining({ room_id: archRoom, case_id: CASE, source: 'RIS' })]);

    // Возврат: открыть случай → войти → история целиком. Цель — ≤ 1 с.
    const t0 = performance.now();
    const back = await api(tok.melnikova!, '/api/v1/cases/open', { connector: 'ris', caseId: CASE });
    expect(back.json).toMatchObject({ roomId: archRoom, archived: true, membership: 'invite' });
    expect((await cs(tok.melnikova!, 'POST', `/rooms/${enc(archRoom)}/join`, {})).status).toBe(200);
    const history = await timeline(tok.melnikova!, archRoom);
    const returnMs = performance.now() - t0;
    console.log(`Возврат в архивный чат: ${Math.round(returnMs)} мс`);
    expect(returnMs).toBeLessThan(2000);
    expect(history.map((e) => e.content?.body)).toContain('Описание готово, заключение в РИС');

    // Только чтение: ни сообщения, ни звонка.
    const send = await cs(tok.melnikova!, 'PUT', `/rooms/${enc(archRoom)}/send/m.room.message/arch-2`, { msgtype: 'm.text', body: 'Вопрос' });
    expect(send.status).toBe(403);
    expect((await cs(tok.melnikova!, 'PUT', `/rooms/${enc(archRoom)}/state/${EventType.Call}/c1`, { kind: 'call' })).status).toBe(403);

    // Случай снова открыт в РИС — писать можно, участники приглашены.
    await mock.updateCase('ris', CASE, { status: 'open' });
    expect(await membership(AS, archRoom, '@orlov:konsilium.test')).toBe('invite');
    expect((await cs(tok.melnikova!, 'PUT', `/rooms/${enc(archRoom)}/send/m.room.message/arch-3`, { msgtype: 'm.text', body: 'Нужен пересмотр' })).status).toBe(200);
  });
});
