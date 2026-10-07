import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventType, NotificationField } from '@konsilium/protocol';
import { IntegrationEventType } from '@konsilium/protocol/integration';
import { MatrixError } from '../../src/matrix.ts';
import { LIS_CASE, TOKENS, mx, setup, type Harness } from './harness.ts';

let h: Harness;
beforeEach(async () => {
  h = await setup({ pushCases: false });
});
afterEach(async () => {
  await h.close();
});

const snapshot = (over: Record<string, unknown> = {}) => ({
  case_id: 'Г26-05001',
  version: 1,
  title: 'Биопсия желудка',
  patient: { ref: 'pseudo:0a1b2c3d', masked: 'К*** А. Б.' },
  participants: [{ user: { login: 'smirnova' }, role: 'pathologist' }],
  updated_at: '2026-10-07T12:00:00+03:00',
  ...over,
});
const ev = (id: string, data: unknown, type: string = IntegrationEventType.CaseUpserted, source = 'lis') => ({ specversion: '1.0', id, source, type, data });

describe('POST /integration/v1/events: приём', () => {
  it('без токена подключения — 401 в формате Problem Details', async () => {
    const res = await h.events('lis', ev('e1', snapshot()), 'wrong-token');
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.json()).toMatchObject({ status: 401, title: expect.any(String) });
  });

  it('GET /connector сообщает, кто подключён и какой уровень', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/integration/v1/connector', headers: { authorization: `Bearer ${TOKENS.ris}` } });
    expect(res.json()).toEqual({ id: 'ris', kind: 'RIS', org: 'clinic', title: 'РИС', level: 1 });
  });

  it('пакет: каждое событие получает свой итог, порядок сохраняется', async () => {
    const res = await h.events('lis', [
      ev('e1', snapshot()),
      ev('e1', snapshot()), // повтор того же id
      ev('e2', snapshot({ version: 3 })),
      ev('e3', snapshot({ version: 2 })), // устарело: уже есть версия 3
      ev('e4', snapshot({ title: '' })), // не по схеме
      ev('e5', snapshot(), IntegrationEventType.CaseUpserted, 'ris'), // чужой source
      ev('e6', {}, 'ru.vendor.case.deleted'),
      ev('e7', snapshot({ participants: [{ user: { employee_id: '000123' }, role: 'lab_tech' }], version: 4 })),
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json().results.map((r: { status: string }) => r.status)).toEqual([
      'accepted',
      'duplicate',
      'accepted',
      'stale',
      'rejected',
      'rejected',
      'rejected',
      'accepted',
    ]);
    const results = res.json().results;
    expect(results[4].detail).toMatch(/^title:/);
    expect(results[7].warnings[0]).toMatch(/не сопоставлен/);
  });

  it('принимает одно событие с типом application/cloudevents+json', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/integration/v1/events',
      headers: { authorization: `Bearer ${TOKENS.lis}`, 'content-type': 'application/cloudevents+json' },
      payload: JSON.stringify(ev('single', snapshot())),
    });
    expect(res.json().results).toEqual([{ id: 'single', status: 'accepted' }]);
  });

  it('пустой и слишком большой пакет отклоняются целиком', async () => {
    expect((await h.events('lis', [])).statusCode).toBe(400);
    const many = Array.from({ length: 101 }, (_, i) => ev(`m${i}`, snapshot({ version: i })));
    expect((await h.events('lis', many)).statusCode).toBe(413);
  });

  it('событие о случае не создаёт чат: чаты создаются лениво', async () => {
    await h.mock.pushCases();
    expect(h.matrix.createCalls).toBe(0);
  });

  it('временная ошибка сервера сообщений — 503 и failed; повтор пакета проходит', async () => {
    await h.mock.pushCases();
    await h.open('smirnova', { connector: 'lis', caseId: LIS_CASE });
    h.matrix.failNextWrite = new MatrixError(502, 'M_UNKNOWN', 'Bad gateway');
    const batch = [ev('n1', { case_id: LIS_CASE, text: 'Готовы препараты ИГХ' }, IntegrationEventType.NotificationPosted)];
    const first = await h.events('lis', batch);
    expect(first.statusCode).toBe(503);
    expect(first.headers['retry-after']).toBe('5');
    expect(first.json().results[0].status).toBe('failed');
    const second = await h.events('lis', batch);
    expect(second.json().results[0].status).toBe('accepted');
  });
});

describe('Синхронизация чата с системой-источником', () => {
  beforeEach(async () => {
    await h.mock.pushCases();
  });

  it('изменения случая приходят в существующий чат: контекст, название, роли, новые участники, отзыв доступа', async () => {
    const { roomId } = (await h.open('smirnova', { connector: 'lis', caseId: LIS_CASE })).json();
    const before = h.mock.cases.get('lis')![0]!.snapshot.participants;
    const res = await h.mock.updateCase('lis', LIS_CASE, {
      stage: 'reporting',
      title: 'Биопсия молочной железы, слева (пересмотр)',
      participants: [...before.filter((p) => p.user.login !== 'kolesnikov'), { user: { login: 'petrov' }, role: 'lab_tech' }],
      revoked: [{ login: 'kolesnikov' }],
    });
    expect(res.body.results[0]!.status).toBe('accepted');

    expect(await h.matrix.getState(roomId, EventType.CaseContext)).toMatchObject({ stage: 'reporting', sync: { version: 2 } });
    expect(await h.matrix.getState(roomId, 'm.room.name')).toEqual({ name: 'Г26-04512 · Биопсия молочной железы, слева (пересмотр)' });
    const roles = await h.matrix.getState<{ members: Record<string, unknown> }>(roomId, EventType.CaseRoles);
    expect(Object.keys(roles!.members).sort()).toEqual([mx('ershova'), mx('petrov'), mx('smirnova')]);
    expect(await h.matrix.getMembership(roomId, mx('petrov'))).toBe('invite');
    expect(await h.matrix.getMembership(roomId, mx('kolesnikov'))).toBe('leave');
  });

  it('параллельные снимки одного случая: в комнате остаётся новейший', async () => {
    const { roomId } = (await h.open('smirnova', { connector: 'lis', caseId: LIS_CASE })).json();
    const base = h.mock.cases.get('lis')![0]!.snapshot;
    // Запись версии 2 «застревает» в сети, версия 3 приходит следом и записывается быстрее.
    h.matrix.stateDelay = (_type, content) => ((content.sync as { version?: number } | undefined)?.version === 2 ? 30 : 0);
    const results = await Promise.all([
      h.events('lis', ev('p2', { ...base, version: 2, stage: 'staining' })),
      h.events('lis', ev('p3', { ...base, version: 3, stage: 'reporting' })),
    ]);
    expect(results.map((r) => r.json().results[0].status)).toEqual(['accepted', 'accepted']);
    expect(await h.matrix.getState(roomId, EventType.CaseContext)).toMatchObject({ stage: 'reporting', sync: { version: 3 } });
  });

  it('закрытие случая — служебное сообщение в чате, один раз', async () => {
    const { roomId } = (await h.open('smirnova', { connector: 'lis', caseId: LIS_CASE })).json();
    await h.mock.updateCase('lis', LIS_CASE, { status: 'closed' });
    await h.mock.updateCase('lis', LIS_CASE, { stage: 'archived', status: 'closed' });
    const notices = h.matrix.messages(roomId).filter((m) => m.content.msgtype === 'm.notice');
    expect(notices.map((n) => n.content.body)).toEqual(['Случай закрыт в ЛИС']);
  });
});

describe('Чат по запросу системы-источника и уведомления', () => {
  beforeEach(async () => {
    await h.mock.pushCases();
  });

  const lis = { authorization: `Bearer ${TOKENS.lis}` };

  it('PUT /cases/{id}/chat создаёт чат (201), повтор — тот же чат (200); GET показывает ссылку', async () => {
    const url = `/integration/v1/cases/${encodeURIComponent(LIS_CASE)}/chat`;
    expect((await h.app.inject({ method: 'GET', url, headers: lis })).json()).toEqual({ case_id: LIS_CASE, chat: null });
    const created = await h.app.inject({ method: 'PUT', url, headers: lis });
    expect(created.statusCode).toBe(201);
    expect(created.json().chat).toMatchObject({
      room_id: expect.stringMatching(/^!/),
      url: `https://chat.clinic.local/c/lis/${encodeURIComponent(LIS_CASE)}`,
    });
    expect((await h.app.inject({ method: 'PUT', url, headers: lis })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url, headers: lis })).json().chat.room_id).toBe(created.json().chat.room_id);
    const unknown = await h.app.inject({ method: 'PUT', url: '/integration/v1/cases/NOPE/chat', headers: lis });
    expect(unknown.statusCode).toBe(404);
  });

  it('уведомление без чата игнорируется, в чат — приходит с кнопками, с ensure_chat — создаёт чат', async () => {
    const ignored = await h.mock.notify('lis', LIS_CASE, 'Материал принят в лабораторию');
    expect(ignored.body.results[0]).toMatchObject({ status: 'ignored' });
    expect(h.matrix.createCalls).toBe(0);

    const ensured = await h.mock.notify('lis', LIS_CASE, 'Готовы препараты ИГХ', {
      category: 'ready',
      links: [{ label: 'Открыть в ЛИС', url: 'https://lis.clinic.local/cases/G26-04512' }],
      ensure_chat: true,
    });
    expect(ensured.body.results[0]).toMatchObject({ status: 'accepted' });
    const roomId = (await h.service.caseRooms.roomFor({ connector: 'lis', caseId: LIS_CASE }))!;
    const [notice] = h.matrix.messages(roomId);
    expect(notice!.content).toMatchObject({
      msgtype: 'm.notice',
      body: 'Готовы препараты ИГХ\nОткрыть в ЛИС: https://lis.clinic.local/cases/G26-04512',
      [NotificationField]: { category: 'ready', connector: 'lis' },
    });
  });
});
