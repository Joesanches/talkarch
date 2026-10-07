import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IntegrationEventType, type CloudEvent } from '@konsilium/protocol/integration';
import { createHostMock, type HostMock } from '../src/mock.ts';

const CB = 'callback-token-0123456789';
let mock: HostMock;
let sent: Array<{ connector: string; events: CloudEvent[] }>;

beforeEach(() => {
  sent = [];
  mock = createHostMock({
    connectors: [{ id: 'lis', token: 't-lis', callbackToken: CB }, { id: 'ris', token: 't-ris' }],
    deliver: async (c, events) => {
      sent.push({ connector: c.id, events });
      return { status: 200, body: { results: events.map((e) => ({ id: e.id, status: 'accepted' })) } };
    },
  });
});
afterEach(async () => {
  await mock.app.close();
});

const call = (method: 'GET' | 'POST', url: string, payload?: object, headers: Record<string, string> = {}) =>
  mock.app.inject({ method, url, payload, headers: { authorization: `Bearer ${CB}`, ...headers } });

describe('Песочница РИС/ЛИС', () => {
  it('отправляет снимки случаев CloudEvents с детерминированным id', async () => {
    await mock.pushCases();
    const lis = sent.find((s) => s.connector === 'lis')!;
    expect(lis.events.map((e) => e.id)).toEqual(['lis:Г26-04512:v1']); // Г26-04530 — только по запросу
    expect(lis.events[0]).toMatchObject({ specversion: '1.0', source: 'lis', type: IntegrationEventType.CaseUpserted });
    expect(JSON.stringify(sent)).not.toMatch(/Нестерова/); // данные пациента остаются в системе-источнике
  });

  it('проверяет токен сервиса контекста и обслуживает обратные вызовы только для уровня 2', async () => {
    expect((await call('GET', '/lis/cases/Г26-04512', undefined, { authorization: 'Bearer wrong' })).statusCode).toBe(401);
    expect((await call('GET', '/ris/cases/A26-118734')).statusCode).toBe(404);
    expect((await call('GET', `/lis/cases/${encodeURIComponent('г26-04512')}`)).json()).toMatchObject({ case_id: 'Г26-04512' });
  });

  it('права: участники и заведующий — да, посторонний — нет', async () => {
    const check = async (login: string) => (await call('POST', '/lis/access-checks', { case_id: 'Г26-04512', user: { login } })).json();
    expect(await check('gusev')).toEqual({ allowed: true, role: 'head' });
    expect(await check('ershova')).toEqual({ allowed: true, role: 'lab_tech' });
    expect(await check('outsider')).toEqual({ allowed: false });
  });

  it('заявка идемпотентна по Idempotency-Key', async () => {
    const body = { case_id: 'Г26-04512', request: { kind: 'ihc', items: ['ER'] }, requested_by: { login: 'smirnova' }, chat: { room_id: '!r', event_id: '$e' } };
    const first = await call('POST', '/lis/requests', body, { 'idempotency-key': '$e' });
    const again = await call('POST', '/lis/requests', body, { 'idempotency-key': '$e' });
    expect(first.statusCode).toBe(201);
    expect(again.json()).toEqual(first.json());
    expect(mock.requests.size).toBe(1);
    expect((await call('POST', '/lis/requests', body)).statusCode).toBe(400);
    const stranger = await call('POST', '/lis/requests', { ...body, requested_by: { login: 'outsider' } }, { 'idempotency-key': '$x' });
    expect(stranger.statusCode).toBe(403);
  });

  it('раскрытие пациента пишет журнал и отказывает посторонним', async () => {
    const ok = await call('POST', '/lis/patient-reveals', { case_id: 'Г26-04512', user: { login: 'smirnova' } });
    expect(ok.json()).toMatchObject({ display_name: 'Нестерова Ольга Викторовна' });
    expect(mock.audit).toHaveLength(1);
    expect((await call('POST', '/lis/patient-reveals', { case_id: 'Г26-04512', user: { login: 'outsider' } })).statusCode).toBe(403);
    expect(mock.audit).toHaveLength(1);
  });
});
