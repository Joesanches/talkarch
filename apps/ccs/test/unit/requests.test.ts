import { afterEach, describe, expect, it } from 'vitest';
import { EventType, MsgType } from '@konsilium/protocol';
import { IntegrationEventType } from '@konsilium/protocol/integration';
import { HS_TOKEN, LIS_CASE, RIS_CASE, mx, setup, waitFor, type Harness } from './harness.ts';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const requestEvent = (eventId: string, roomId: string, sender = mx('smirnova')) => ({
  event_id: eventId,
  room_id: roomId,
  sender,
  type: 'm.room.message',
  content: { msgtype: MsgType.Request, body: 'Запрос ИГХ: блок 1А — ER, HER2/neu', [MsgType.Request]: { kind: 'ihc', block: '1А', items: ['ER', 'HER2/neu'] } },
});

const statuses = (roomId: string) => h.matrix.messages(roomId, EventType.RequestStatus).map((e) => e.content);

describe('Application Service', () => {
  it('проверяет токен homeserver', async () => {
    h = await setup();
    const url = '/_matrix/app/v1/transactions/1';
    expect((await h.app.inject({ method: 'PUT', url, payload: { events: [] } })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'PUT', url, headers: { authorization: 'Bearer wrong' }, payload: { events: [] } })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'PUT', url, headers: { authorization: `Bearer ${HS_TOKEN}` }, payload: { events: [] } })).statusCode).toBe(200);
  });
});

describe('Заявка из чата → система-источник → статусы в чат', () => {
  it('заявка создаётся в ЛИС один раз, статус возвращается в чат один раз', async () => {
    h = await setup();
    const { roomId } = (await h.open('smirnova', { connector: 'lis', caseId: LIS_CASE })).json();
    const event = requestEvent('$req1', roomId);
    await h.transaction('t1', [event]);
    await h.transaction('t1', [event]); // повтор той же транзакции
    await h.transaction('t2', [event]); // то же событие в другой транзакции
    expect(h.mock.requests.size).toBe(1);
    expect(statuses(roomId)).toEqual([
      expect.objectContaining({
        'm.relates_to': { rel_type: 'm.reference', event_id: '$req1' },
        status: 'accepted',
        steps: ['accepted', 'staining', 'scanning', 'done'],
        external_id: expect.stringMatching(/^ИГХ-\d+$/),
        source: 'LIS',
      }),
    ]);
  });

  it('дальнейшие шаги приходят событиями request.status.changed', async () => {
    h = await setup({ stepMs: 5 });
    const { roomId } = (await h.open('smirnova', { connector: 'lis', caseId: LIS_CASE })).json();
    await h.transaction('t1', [requestEvent('$req2', roomId)]);
    const all = await waitFor(() => {
      const s = statuses(roomId);
      return s.length === 4 ? s : undefined;
    });
    expect(all.map((s) => s.status)).toEqual(['accepted', 'staining', 'scanning', 'done']);
    expect(all.every((s) => (s['m.relates_to'] as { event_id: string }).event_id === '$req2')).toBe(true);
  });

  it('статус заявки, которой не было в чате, игнорируется', async () => {
    h = await setup();
    const res = await h.events('lis', {
      specversion: '1.0',
      id: 'rs-x',
      source: 'lis',
      type: IntegrationEventType.RequestStatusChanged,
      data: { case_id: LIS_CASE, external_id: 'ИГХ-1', status: 'done', changed_at: '2026-10-07T12:00:00+03:00' },
    });
    expect(res.json().results[0]).toMatchObject({ status: 'ignored' });
  });

  it('ЛИС недоступна — транзакция получает 503, Synapse её повторит', async () => {
    h = await setup();
    const { roomId } = (await h.open('smirnova', { connector: 'lis', caseId: LIS_CASE })).json();
    await h.mock.app.close();
    const res = await h.transaction('t-down', [requestEvent('$req3', roomId)]);
    expect(res.statusCode).toBe(503);
    expect(statuses(roomId)).toEqual([]);
  });

  it('в системе без обратных вызовов — подсказка в чате вместо заявки', async () => {
    h = await setup();
    const { roomId } = (await h.open('orlov', { connector: 'ris', caseId: RIS_CASE })).json();
    await h.transaction('t1', [requestEvent('$req4', roomId, mx('orlov'))]);
    expect(h.matrix.messages(roomId).map((m) => m.content.body)).toEqual([expect.stringMatching(/не подключены/)]);
  });
});
