import { afterEach, describe, expect, it } from 'vitest';
import { ArchivedCase, CaseArchiveContent, EventType, MsgType } from '@konsilium/protocol';
import { ARCHIVED_NOTICE } from '../../src/archive.ts';
import { LIS_CASE, mx, setup, type Harness } from './harness.ts';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const T0 = Date.parse('2026-10-08T10:00:00Z');
const MIN = 60_000;
const DAY = 86_400_000;
let now = T0;
const clock = () => now;

const message = (eventId: string, roomId: string, sender: string) => ({
  event_id: eventId,
  room_id: roomId,
  sender,
  type: 'm.room.message',
  content: { msgtype: 'm.text', body: 'Заключение подписано, спасибо' },
});

const notices = (roomId: string) => h.matrix.messages(roomId).filter((m) => m.content.msgtype === 'm.notice').map((m) => String(m.content.body));
const archiveState = async (roomId: string) => CaseArchiveContent.parse(await h.matrix.getState(roomId, EventType.CaseArchive));
const powerLevels = async (roomId: string) => (await h.matrix.getState<{ events_default: number; events: Record<string, number> }>(roomId, 'm.room.power_levels'))!;
const archiveOf = async (user: string, q = '') => {
  const r = await h.app.inject({ method: 'GET', url: `/api/v1/archive${q ? `?q=${encodeURIComponent(q)}` : ''}`, headers: { authorization: `Bearer tok-${user}` } });
  expect(r.statusCode).toBe(200);
  return (r.json() as { cases: unknown[] }).cases.map((c) => ArchivedCase.parse(c));
};

/** Чат случая ЛИС: Смирнова открыла, Ершова и Колесников вошли по приглашению. */
async function lisRoom() {
  now = T0;
  h = await setup({ now: clock });
  const { roomId } = (await h.open('smirnova', { connector: 'lis', caseId: LIS_CASE })).json() as { roomId: string };
  for (const u of ['smirnova', 'ershova', 'kolesnikov']) h.matrix.join(roomId, mx(u));
  return roomId;
}

async function closeCase(at: number) {
  now = at;
  await h.mock.updateCase('lis', LIS_CASE, { status: 'closed' });
}

describe('Архив чатов случаев', () => {
  it('закрытый случай без активности уходит в архив: только чтение, участники выведены, уведомление в ленте', async () => {
    const roomId = await lisRoom();
    await closeCase(T0 + 10 * MIN);

    now = T0 + 10 * MIN + 14 * DAY - MIN;
    expect(await h.service.archive.tick()).toEqual({ archived: 0, removed: 0 });

    now = T0 + 10 * MIN + 14 * DAY + MIN;
    expect(await h.service.archive.tick()).toEqual({ archived: 1, removed: 0 });
    expect(await archiveState(roomId)).toMatchObject({ status: 'archived', archived_at: new Date(now).toISOString() });
    const pl = await powerLevels(roomId);
    expect(pl.events_default).toBe(100);
    expect(pl.events[EventType.Call]).toBe(100);
    expect(notices(roomId)).toContain(ARCHIVED_NOTICE);
    for (const u of ['smirnova', 'ershova', 'kolesnikov']) expect(await h.matrix.getMembership(roomId, mx(u))).toBe('leave');
    expect(await h.matrix.getMembership(roomId, mx('ccs'))).toBe('join');

    // Повторный проход ничего не делает.
    expect(await h.service.archive.tick()).toEqual({ archived: 0, removed: 0 });
    expect(await archiveOf('ershova')).toEqual([
      { room_id: roomId, connector: 'lis', case_id: LIS_CASE, title: expect.any(String), source: 'LIS', archived_at: new Date(now).toISOString() },
    ]);
    expect(await archiveOf('outsider')).toEqual([]);
  });

  it('активность в чате после закрытия отодвигает архив; открытый случай в архив не уходит', async () => {
    const roomId = await lisRoom();
    now = T0 + 30 * DAY;
    expect((await h.service.archive.tick()).archived).toBe(0); // случай открыт

    await closeCase(T0 + 30 * DAY);
    now = T0 + 40 * DAY;
    await h.transaction('t1', [message('$m1', roomId, mx('kolesnikov'))]);
    now = T0 + 45 * DAY;
    expect((await h.service.archive.tick()).archived).toBe(0); // 14 дней от закрытия прошли, от сообщения — нет
    now = T0 + 54 * DAY + MIN;
    expect((await h.service.archive.tick()).archived).toBe(1);
  });

  it('неподтверждённая критическая находка держит чат вне архива', async () => {
    const roomId = await lisRoom();
    await h.transaction('t1', [
      {
        event_id: '$crit',
        room_id: roomId,
        sender: mx('smirnova'),
        type: 'm.room.message',
        content: {
          msgtype: MsgType.Critical,
          body: 'Критическая находка: метастаз в лимфоузле',
          [MsgType.Critical]: { finding: 'Метастаз в лимфоузле', recipient: { role: 'attending' }, ack_deadline: 'PT10M' },
        },
      },
    ]);
    await h.service.critical.idle();
    await closeCase(T0 + MIN);
    now = T0 + 20 * DAY;
    expect((await h.service.archive.tick()).archived).toBe(0);
    expect(await h.service.archive.isArchived(roomId)).toBe(false);

    await h.transaction('t2', [
      { event_id: '$ack', room_id: roomId, sender: mx('kolesnikov'), type: EventType.Ack, content: { 'm.relates_to': { rel_type: 'm.reference', event_id: '$crit' } } },
    ]);
    await h.service.critical.idle();
    now = T0 + 34 * DAY + MIN;
    expect((await h.service.archive.tick()).archived).toBe(1);
  });

  it('возврат по требованию: участник и выведенный при архиве — да, посторонний — нет; через сутки снова выводится', async () => {
    const roomId = await lisRoom();
    // Петров попал в чат не из списков ЛИС (как при эскалации критической находки).
    await h.matrix.invite(roomId, mx('petrov'));
    h.matrix.join(roomId, mx('petrov'));
    await closeCase(T0);
    now = T0 + 15 * DAY;
    await h.service.archive.tick();

    const back = await h.open('ershova', { connector: 'lis', caseId: LIS_CASE });
    expect(back.statusCode).toBe(200);
    expect(back.json()).toMatchObject({ roomId, archived: true, membership: 'invite', created: false });
    h.matrix.join(roomId, mx('ershova'));
    // Повторное открытие не приглашает заново.
    expect((await h.open('ershova', { connector: 'lis', caseId: LIS_CASE })).json()).toMatchObject({ archived: true, membership: 'join' });

    expect((await h.open('petrov', { connector: 'lis', caseId: LIS_CASE })).json()).toMatchObject({ archived: true, membership: 'invite' });
    expect((await h.open('outsider', { connector: 'lis', caseId: LIS_CASE })).statusCode).toBe(403);
    // Гусеву доступ дала ЛИС (заведующий), в чате он не был — возвращается и видит случай в своём архиве.
    expect((await h.open('gusev', { connector: 'lis', caseId: LIS_CASE })).json()).toMatchObject({ archived: true, membership: 'invite' });
    expect((await archiveOf('gusev')).map((c) => c.case_id)).toEqual([LIS_CASE]);

    // Комната по-прежнему только для чтения, звонков нет.
    expect((await powerLevels(roomId)).events_default).toBe(100);
    const call = await h.app.inject({ method: 'POST', url: '/api/v1/calls/token', headers: { authorization: 'Bearer tok-ershova' }, payload: { roomId } });
    expect(call.statusCode).toBe(403);

    now = T0 + 15 * DAY + 23 * 3_600_000;
    expect((await h.service.archive.tick()).removed).toBe(0);
    now = T0 + 16 * DAY + MIN;
    expect((await h.service.archive.tick()).removed).toBe(3);
    for (const u of ['ershova', 'petrov', 'gusev']) expect(await h.matrix.getMembership(roomId, mx(u))).toBe('leave');
    expect((await h.service.archive.tick()).removed).toBe(0);
  });

  it('случай снова открыт в ЛИС: чат возвращается из архива, участники приглашаются; закрытый остаётся без приглашений', async () => {
    const roomId = await lisRoom();
    await closeCase(T0);
    now = T0 + 15 * DAY;
    await h.service.archive.tick();

    // Новый снимок закрытого случая (сменился этап) — участников не возвращаем.
    await h.mock.updateCase('lis', LIS_CASE, { stage: 'review' });
    expect(await h.matrix.getMembership(roomId, mx('ershova'))).toBe('leave');
    expect(await h.service.archive.isArchived(roomId)).toBe(true);

    now = T0 + 20 * DAY;
    await h.mock.updateCase('lis', LIS_CASE, { status: 'open' });
    expect(await archiveState(roomId)).toMatchObject({ status: 'active', restored_at: new Date(now).toISOString() });
    expect((await powerLevels(roomId)).events_default).toBe(0);
    expect((await powerLevels(roomId)).events[EventType.Call]).toBe(0);
    for (const u of ['smirnova', 'ershova', 'kolesnikov']) expect(await h.matrix.getMembership(roomId, mx(u))).toBe('invite');
    expect(notices(roomId).at(-1)).toBe('Случай снова открыт в ЛИС — чат вернулся из архива');
    expect(await archiveOf('ershova')).toEqual([]);
    expect(await h.service.archive.isArchived(roomId)).toBe(false);

    // Открытый случай больше в архив не уходит.
    now = T0 + 60 * DAY;
    expect((await h.service.archive.tick()).archived).toBe(0);
  });

  it('доступ отозван после архива: случая нет в папке «Архив», вернуться нельзя', async () => {
    const roomId = await lisRoom();
    await closeCase(T0);
    now = T0 + 15 * DAY;
    await h.service.archive.tick();
    expect(await archiveOf('ershova')).toHaveLength(1);
    await h.mock.updateCase('lis', LIS_CASE, { revoked: [{ login: 'ershova' }] });
    expect(await archiveOf('ershova')).toEqual([]);
    expect((await h.open('ershova', { connector: 'lis', caseId: LIS_CASE })).statusCode).toBe(403);
    expect(await h.matrix.getMembership(roomId, mx('ershova'))).toBe('leave');
    expect(await archiveOf('smirnova')).toHaveLength(1);
  });

  it('проход архива во время возврата из архива не отправляет чат обратно', async () => {
    const roomId = await lisRoom();
    await closeCase(T0);
    now = T0 + 15 * DAY;
    await h.service.archive.tick();
    // Синхронизация снимка «снова открыт» идёт медленно (запись контекста); проход архива — посередине.
    let ticked: Promise<unknown> | null = null;
    h.matrix.stateDelay = (type) => {
      if (type === EventType.CaseContext && !ticked) ticked = h.service.archive.tick();
      return type === EventType.CaseContext ? 20 : 0;
    };
    await h.mock.updateCase('lis', LIS_CASE, { status: 'open' });
    expect(await ticked).toEqual({ archived: 0, removed: 0 });
    expect(await archiveState(roomId)).toMatchObject({ status: 'active' });
    expect(await h.service.archive.isArchived(roomId)).toBe(false);
  });

  it('папка «Архив»: поиск по номеру и названию, без токена — 401', async () => {
    const roomId = await lisRoom();
    await closeCase(T0);
    now = T0 + 15 * DAY;
    await h.service.archive.tick();
    expect((await archiveOf('smirnova', 'г26-045')).map((c) => c.room_id)).toEqual([roomId]);
    expect(await archiveOf('smirnova', 'нет такого')).toEqual([]);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/archive' })).statusCode).toBe(401);
  });
});
