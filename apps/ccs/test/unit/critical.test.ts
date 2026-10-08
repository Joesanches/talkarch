import { afterEach, describe, expect, it } from 'vitest';
import { CriticalStatusContent, EventType, MsgType } from '@konsilium/protocol';
import { IntegrationEventType } from '@konsilium/protocol/integration';
import { InMemoryCriticalStore, type CriticalFinding } from '../../src/critical.ts';
import { LIS_CASE, RIS_CASE, TOKENS, mx, setup, type Harness } from './harness.ts';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const T0 = Date.parse('2026-10-08T10:00:00Z');
let now = T0;
const clock = () => now;
const MIN = 60_000;

const critical = (eventId: string, roomId: string, sender = mx('smirnova'), extra: Record<string, unknown> = {}) => ({
  event_id: eventId,
  room_id: roomId,
  sender,
  type: 'm.room.message',
  content: {
    msgtype: MsgType.Critical,
    body: 'Критическая находка: метастаз в подмышечном лимфоузле',
    [MsgType.Critical]: { finding: 'Метастаз в подмышечном лимфоузле', recipient: { role: 'attending' }, ack_deadline: 'PT10M', ...extra },
  },
});
const ack = (eventId: string, roomId: string, target: string, sender: string) => ({
  event_id: eventId,
  room_id: roomId,
  sender,
  type: EventType.Ack,
  content: { 'm.relates_to': { rel_type: 'm.reference', event_id: target } },
});

const status = async (roomId: string, eventId: string) => CriticalStatusContent.parse(await h.matrix.getState(roomId, EventType.CriticalStatus, eventId));
const notices = (roomId: string) => h.matrix.messages(roomId).filter((m) => m.content.msgtype === 'm.notice').map((m) => String(m.content.body));
const hostEvents = () => [...h.mock.criticalEvents.values()];

async function lisRoom() {
  h = await setup({ now: clock });
  for (const [u, n] of [
    ['smirnova', 'Смирнова А. В.'],
    ['kolesnikov', 'Колесников Д. А.'],
    ['ershova', 'Ершова Т. Н.'],
    ['gusev', 'Гусев П. Р.'],
  ]) h.matrix.profiles.set(mx(u!), n!);
  const { roomId } = (await h.open('smirnova', { connector: 'lis', caseId: LIS_CASE })).json();
  return roomId as string;
}

describe('Критическая находка из чата', () => {
  it('адресат по роли, срок, уведомление с упоминанием; событие «отправлена» уходит в ЛИС', async () => {
    now = T0;
    const roomId = await lisRoom();
    await h.transaction('t1', [critical('$c1', roomId)]);
    await h.transaction('t2', [critical('$c1', roomId)]); // повтор — без второй регистрации

    expect(await status(roomId, '$c1')).toMatchObject({
      status: 'pending',
      recipients: [mx('kolesnikov')],
      reported_by: mx('smirnova'),
      raised_at: new Date(T0).toISOString(),
      deadline_at: new Date(T0 + 10 * MIN).toISOString(),
      next_escalation_at: new Date(T0 + 10 * MIN).toISOString(),
    });
    const notice = h.matrix.messages(roomId).find((m) => String(m.content.body).startsWith('Критическая находка →'))!;
    expect(notice.content.body).toBe('Критическая находка → Колесников Д. А. (лечащий врач): требуется подтверждение получения в течение 10 мин.');
    expect(notice.content['m.mentions']).toEqual({ user_ids: [mx('kolesnikov')] });
    expect(notices(roomId).filter((b) => b.startsWith('Критическая находка →'))).toHaveLength(1);

    await h.service.critical.idle();
    expect(hostEvents()).toEqual([
      expect.objectContaining({
        type: 'raised',
        finding_id: '$c1',
        case_id: LIS_CASE,
        finding: 'Метастаз в подмышечном лимфоузле',
        reported_by: { mxid: mx('smirnova'), login: 'smirnova' },
        recipients: [{ mxid: mx('kolesnikov'), login: 'kolesnikov' }],
      }),
    ]);
  });

  it('отправить может только врач-диагност; статус «отклонена» пишет сервис', async () => {
    const roomId = await lisRoom();
    await h.transaction('t1', [critical('$c2', roomId, mx('ershova'))]);
    expect(await status(roomId, '$c2')).toMatchObject({ status: 'rejected', note: expect.stringMatching(/врач-диагност/) });
    expect(await h.service.critical.report('lis', 0)).toEqual([]);
  });

  it('подтверждает только адресат: чужое «подтверждаю» не засчитывается, повтор — без эффекта', async () => {
    now = T0;
    const roomId = await lisRoom();
    await h.transaction('t1', [critical('$c3', roomId)]);

    await h.transaction('t2', [ack('$a1', roomId, '$c3', mx('ershova'))]);
    expect((await status(roomId, '$c3')).status).toBe('pending');
    expect(notices(roomId).at(-1)).toBe('Подтверждение не засчитано: подтверждает адресат находки (Колесников Д. А. (лечащий врач)).');

    now = T0 + 2 * MIN + 13_000;
    await h.transaction('t3', [ack('$a2', roomId, '$c3', mx('kolesnikov'))]);
    await h.transaction('t4', [ack('$a3', roomId, '$c3', mx('kolesnikov'))]);
    const s = await status(roomId, '$c3');
    expect(s).toMatchObject({ status: 'acknowledged', acknowledged: { by: mx('kolesnikov'), seconds: 133 } });
    expect(s.next_escalation_at).toBeUndefined();
    expect(notices(roomId).filter((b) => b.startsWith('Получение критической находки подтверждено'))).toEqual([
      'Получение критической находки подтверждено: Колесников Д. А. (лечащий врач), через 2 мин 13 с.',
    ]);

    // После подтверждения эскалации нет.
    now = T0 + 30 * MIN;
    expect(await h.service.critical.tick()).toBe(0);
    await h.service.critical.idle();
    expect(hostEvents().map((e) => e.type)).toEqual(['raised', 'acknowledged']);
    expect(hostEvents()[1]).toMatchObject({ acknowledged_by: { login: 'kolesnikov' }, seconds_to_ack: 133 });
  });

  it('нет подтверждения — звонок на пост через ЛИС, затем подключается заведующий; он может подтвердить', async () => {
    now = T0;
    const roomId = await lisRoom();
    await h.transaction('t1', [critical('$c4', roomId)]);

    now = T0 + 9 * MIN;
    expect(await h.service.critical.tick()).toBe(0); // рано

    now = T0 + 10 * MIN;
    expect(await h.service.critical.tick()).toBe(1);
    expect(await h.service.critical.tick()).toBe(0); // шаг выполнен один раз
    let s = await status(roomId, '$c4');
    expect(s.escalations).toEqual([{ at: new Date(now).toISOString(), action: 'call', target: 'Пост 3 онкологии', users: [], delivered: true }]);
    expect(s.next_escalation_at).toBe(new Date(T0 + 15 * MIN).toISOString());
    expect(notices(roomId).at(-1)).toBe('Нет подтверждения критической находки 10 мин — звонок на «Пост 3 онкологии»: передан в систему-источник.');

    now = T0 + 15 * MIN;
    expect(await h.service.critical.tick()).toBe(1);
    s = await status(roomId, '$c4');
    expect(s.recipients).toEqual([mx('kolesnikov'), mx('gusev')]);
    expect(s.next_escalation_at).toBeUndefined();
    expect(await h.matrix.getMembership(roomId, mx('gusev'))).toBe('invite');
    const esc = h.matrix.messages(roomId).at(-1)!;
    expect(esc.content.body).toBe('Нет подтверждения критической находки 15 мин — эскалация: подключён Гусев П. Р. (заведующий). Подтвердить получение может любой адресат.');
    expect((esc.content['m.mentions'] as { user_ids: string[] }).user_ids).toEqual([mx('gusev'), mx('smirnova')]);

    now = T0 + 16 * MIN;
    await h.transaction('t2', [ack('$a4', roomId, '$c4', mx('gusev'))]);
    expect(await status(roomId, '$c4')).toMatchObject({ status: 'acknowledged', acknowledged: { by: mx('gusev'), seconds: 960 } });
    expect(notices(roomId).at(-1)).toMatch(/подтверждено: Гусев П\. Р\., через 16 мин \(позже срока\)\.$/);

    await h.service.critical.idle();
    expect(hostEvents().map((e) => `${e.type}${e.escalation ? `:${e.escalation.step}:${e.escalation.action}` : ''}`)).toEqual([
      'raised',
      'escalated:1:call',
      'escalated:2:notify',
      'acknowledged',
    ]);
    const report = await h.service.critical.report('lis', 0);
    expect(report[0]).toMatchObject({ status: 'acknowledged', seconds_to_ack: 960, overdue: true, escalations: [{ step: 1 }, { step: 2 }] });
  });

  it('из чата нельзя пригласить постороннего: явные адресаты — только участники случая, план — только подключения', async () => {
    now = T0;
    const roomId = await lisRoom();
    await h.transaction('t1', [
      critical('$c6', roomId, mx('smirnova'), {
        recipient: { role: 'attending', users: [mx('outsider')] },
        escalation: [{ after: 'PT1M', action: 'notify', target: 'head', users: [mx('outsider')] }],
      }),
    ]);
    expect((await status(roomId, '$c6')).recipients).toEqual([mx('kolesnikov')]);
    expect(await h.matrix.getMembership(roomId, mx('outsider'))).toBeNull();
    now = T0 + 60_000;
    expect(await h.service.critical.tick()).toBe(0); // своего плана у сообщения нет — первый шаг подключения через 10 мин
    now = T0 + 15 * MIN;
    await h.service.critical.tick();
    await h.service.critical.tick();
    expect(await h.matrix.getMembership(roomId, mx('outsider'))).toBeNull();
    expect((await status(roomId, '$c6')).recipients).toEqual([mx('kolesnikov'), mx('gusev')]);
  });

  it('роль адресата в случае не назначена — эскалация сразу', async () => {
    now = T0;
    const roomId = await lisRoom();
    await h.transaction('t1', [critical('$c5', roomId, mx('smirnova'), { recipient: { role: 'on_duty' } })]);
    expect(notices(roomId).at(-1)).toMatch(/адресат с ролью «дежурный врач» в случае не назначен/);
    expect(await h.service.critical.tick()).toBe(1);
    expect((await status(roomId, '$c5')).escalations[0]).toMatchObject({ action: 'call' });
  });
});

describe('Критическая находка из РИС (critical.raised)', () => {
  const raised = (id: string, findingId: string) => ({
    specversion: '1.0',
    id,
    source: 'ris',
    type: IntegrationEventType.CriticalRaised,
    data: {
      case_id: RIS_CASE,
      finding_id: findingId,
      finding: 'Двусторонняя ТЭЛА: долевые и сегментарные ветви',
      reported_by: { login: 'orlov' },
      recipient: { role: 'on_duty' },
      ack_deadline: 'PT5M',
      escalation: [{ after: 'PT5M', action: 'notify', target: 'head', users: [{ login: 'gusev' }] }],
    },
  });

  it('чат создаётся, находка — от сервиса с автором; дубль по номеру РИС; итог — в GET /critical-findings', async () => {
    now = T0;
    h = await setup({ now: clock });
    const r = await h.events('ris', raised('e1', 'КН-77'));
    expect(r.json().results[0]).toMatchObject({ status: 'accepted' });
    expect((await h.events('ris', raised('e2', 'КН-77'))).json().results[0]).toMatchObject({ status: 'duplicate' });

    const roomId = (await h.service.caseRooms.roomFor({ connector: 'ris', caseId: RIS_CASE }))!;
    const msg = h.matrix.messages(roomId).find((m) => m.content.msgtype === MsgType.Critical)!;
    expect(msg.content[MsgType.Critical]).toMatchObject({ reported_by: mx('orlov'), host_finding_id: 'КН-77', recipient: { role: 'on_duty' } });
    expect(await status(roomId, msg.eventId)).toMatchObject({ status: 'pending', recipients: [mx('melnikova')], reported_by: mx('orlov') });

    const list = async () =>
      (await h.app.inject({ method: 'GET', url: '/integration/v1/critical-findings?since=2026-10-01T00:00:00Z', headers: { authorization: `Bearer ${TOKENS.ris}` } })).json()
        .findings;
    expect(await list()).toEqual([expect.objectContaining({ host_finding_id: 'КН-77', status: 'pending', overdue: false })]);

    // У заведующего нет доступа к случаю РИС — до эскалации чат ему не открыть.
    expect((await h.open('gusev', { connector: 'ris', caseId: RIS_CASE })).statusCode).toBe(403);
    now = T0 + 5 * MIN;
    await h.service.critical.tick();
    expect((await status(roomId, msg.eventId)).recipients).toEqual([mx('melnikova'), mx('gusev')]);
    // Эскалация пустила его в чат — теперь открывается и по ссылке из РИС.
    expect((await h.open('gusev', { connector: 'ris', caseId: RIS_CASE })).json()).toMatchObject({ roomId, membership: 'invite' });

    now = T0 + 6 * MIN;
    await h.transaction('t1', [ack('$r1', roomId, msg.eventId, mx('melnikova'))]);
    expect(await list()).toEqual([
      expect.objectContaining({
        host_finding_id: 'КН-77',
        status: 'acknowledged',
        acknowledged_by: { mxid: mx('melnikova'), login: 'melnikova' },
        seconds_to_ack: 360,
        overdue: true,
        escalations: [expect.objectContaining({ step: 1, action: 'notify', target: 'head' })],
      }),
    ]);
    // Чужое подключение находок РИС не видит.
    const lis = await h.app.inject({ method: 'GET', url: '/integration/v1/critical-findings', headers: { authorization: `Bearer ${TOKENS.lis}` } });
    expect(lis.json().findings).toEqual([]);
  });

  it('некорректные данные и неизвестный случай отклоняются', async () => {
    h = await setup({ now: clock });
    const bad = raised('e3', 'КН-78');
    (bad.data as Record<string, unknown>).ack_deadline = '10 минут';
    expect((await h.events('ris', bad)).json().results[0].status).toBe('rejected');
    const unknown = raised('e4', 'КН-79');
    unknown.data.case_id = 'A00-000000';
    expect((await h.events('ris', unknown)).json().results[0]).toMatchObject({ status: 'rejected', detail: expect.stringMatching(/Случай неизвестен/) });
    const since = await h.app.inject({ method: 'GET', url: '/integration/v1/critical-findings?since=вчера', headers: { authorization: `Bearer ${TOKENS.ris}` } });
    expect(since.statusCode).toBe(400);
  });
});

describe('Хранилище: аренда шагов эскалации', () => {
  it('просроченный шаг берёт один обработчик; после аренды — снова доступен', async () => {
    const store = new InMemoryCriticalStore();
    const f: CriticalFinding = {
      eventId: '$x',
      roomId: '!r',
      connector: 'lis',
      caseId: 'C',
      reportedBy: mx('smirnova'),
      raisedAt: T0,
      deadlineAt: T0 + MIN,
      recipients: [],
      plan: [{ afterS: 60, action: 'call', target: 'Пост', users: [] }],
      escalations: [],
      status: 'pending',
      nextAt: T0 + MIN,
    };
    expect(await store.add(f)).toBe(true);
    expect(await store.add(f)).toBe(false);
    expect(await store.claimDue(T0 + MIN, 30_000, 10)).toHaveLength(1);
    expect(await store.claimDue(T0 + MIN, 30_000, 10)).toHaveLength(0);
    expect(await store.claimDue(T0 + MIN + 30_000, 30_000, 10)).toHaveLength(1);
    expect(await store.acknowledge('$x', mx('kolesnikov'), T0 + 2 * MIN)).toMatchObject({ status: 'acknowledged' });
    expect(await store.acknowledge('$x', mx('kolesnikov'), T0 + 3 * MIN)).toBeNull();
    expect(await store.recordEscalation('$x', { step: 1, at: T0, action: 'call', target: 'Пост', users: [] }, [], null)).toBe(false);
  });
});
