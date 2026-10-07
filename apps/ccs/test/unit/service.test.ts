import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { EventType, MsgType, RoomType } from '@konsilium/protocol';
import { buildApp } from '../../src/app.ts';
import { CallTokenService } from '../../src/calls.ts';
import { CaseRoomService, InMemoryCaseRoomStore } from '../../src/caseRooms.ts';
import { EventProcessor } from '../../src/events.ts';
import { JsonHostDirectory } from '../../src/host.ts';
import { FakeMatrix } from './fakeMatrix.ts';

const SERVER = 'konsilium.test';
const HS_TOKEN = 'hs-token-for-tests-0001';
const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../fixtures/host-directory.json'), 'utf8'));
const mx = (lp: string) => `@${lp}:${SERVER}`;

function setup() {
  const matrix = new FakeMatrix(mx('ccs'), SERVER);
  for (const u of ['smirnova', 'ershova', 'kolesnikov', 'gusev', 'outsider', 'orlov']) matrix.tokens.set(`tok-${u}`, mx(u));
  const store = new InMemoryCaseRoomStore();
  const host = new JsonHostDirectory(fixture, 'clinic', SERVER);
  const caseRooms = new CaseRoomService(matrix, store, { aliasSecret: 'alias-secret-for-tests', serverName: SERVER });
  const calls = new CallTokenService(matrix, { url: 'ws://lk', apiKey: 'devkey', apiSecret: 'secret-secret-secret-secret-1234', roomSecret: 'alias-secret-for-tests' });
  const silent = { info() {}, warn() {}, error() {} };
  const events = new EventProcessor({ matrix, store, host, org: 'clinic', log: silent });
  const app = buildApp({ org: 'clinic', hsToken: HS_TOKEN, matrix, host, caseRooms, calls, events });
  return { matrix, store, host, caseRooms, app };
}

const open = (app: ReturnType<typeof setup>['app'], user: string, body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/v1/cases/open', headers: { authorization: `Bearer tok-${user}` }, payload: body });

describe('POST /api/v1/cases/open', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('создаёт комнату случая с контекстом, ролями и приглашениями по ролям', async () => {
    const res = await open(ctx.app, 'smirnova', { system: 'LIS', caseId: 'Г26-04512' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ created: true, membership: 'invite' });
    expect(body.alias).toMatch(/^#c-[0-9a-f]{24}:konsilium\.test$/);

    const room = ctx.matrix.rooms.get(body.roomId)!;
    expect(room.req.creation_content).toEqual({ type: RoomType.Case });
    expect(room.req.invite?.sort()).toEqual([mx('ershova'), mx('kolesnikov'), mx('smirnova')]);
    const context = await ctx.matrix.getState<Record<string, any>>(body.roomId, EventType.CaseContext);
    expect(context).toMatchObject({ source: 'LIS', case_id: 'Г26-04512', patient: { masked: 'Н*** О. В.' } });
    expect(JSON.stringify(context)).not.toMatch(/Нестерова/);
    const roles = await ctx.matrix.getState<Record<string, any>>(body.roomId, EventType.CaseRoles);
    expect(roles?.members[mx('ershova')]).toMatchObject({ role: 'lab_tech', source: 'LIS' });
    const pl = room.req.power_level_content_override as Record<string, any>;
    expect(pl.invite).toBe(100);
    // Комнаты версии 12: создателя нельзя перечислять в users.
    expect(pl.users).toBeUndefined();
  });

  it('достраивает комнату, если псевдоним есть, а контекста нет (сбой посреди createRoom)', async () => {
    const { localpart } = ctx.caseRooms.aliasFor({ org: 'clinic', system: 'LIS', caseId: 'Г26-04512' });
    const broken = await ctx.matrix.createRoom({ room_alias_name: localpart, creation_content: { type: RoomType.Case } });
    const res = (await open(ctx.app, 'smirnova', { system: 'LIS', caseId: 'Г26-04512' })).json();
    expect(res).toMatchObject({ roomId: broken, created: false });
    expect(await ctx.matrix.getState(broken, EventType.CaseContext)).toMatchObject({ case_id: 'Г26-04512' });
    expect(await ctx.matrix.getMembership(broken, mx('ershova'))).toBe('invite');
  });

  it('повторное и параллельное открытие возвращает ту же комнату', async () => {
    ctx.matrix.createDelayMs = 20;
    const results = await Promise.all(
      ['smirnova', 'ershova', 'kolesnikov', 'smirnova'].map((u) => open(ctx.app, u, { system: 'LIS', caseId: 'Г26-04512' })),
    );
    const ids = new Set(results.map((r) => r.json().roomId));
    expect(ids.size).toBe(1);
    expect(ctx.matrix.createCalls).toBe(1);
    const again = await open(ctx.app, 'smirnova', { system: 'LIS', caseId: 'г26-04512' });
    expect(again.json()).toMatchObject({ created: false, roomId: [...ids][0] });
  });

  it('после перезапуска сервиса находит комнату по псевдониму, а не создаёт новую', async () => {
    const first = (await open(ctx.app, 'smirnova', { system: 'LIS', caseId: 'Г26-04512' })).json();
    const restarted = new CaseRoomService(ctx.matrix, new InMemoryCaseRoomStore(), { aliasSecret: 'alias-secret-for-tests', serverName: SERVER });
    const hostCase = (await ctx.host.getCase({ org: 'clinic', system: 'LIS', caseId: 'Г26-04512' }))!;
    const second = await restarted.getOrCreate(hostCase);
    expect(second).toMatchObject({ roomId: first.roomId, created: false });
  });

  it('пускает по требованию тех, у кого есть доступ в системе-источнике', async () => {
    const res = await open(ctx.app, 'gusev', { system: 'LIS', caseId: 'Г26-04512' });
    expect(res.json()).toMatchObject({ membership: 'invite' });
  });

  it('отказывает без доступа в системе-источнике, без токена и для неизвестного случая', async () => {
    expect((await open(ctx.app, 'outsider', { system: 'LIS', caseId: 'Г26-04512' })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/cases/open', payload: { system: 'LIS', caseId: 'x' } })).statusCode).toBe(401);
    expect((await open(ctx.app, 'smirnova', { system: 'LIS', caseId: 'НЕТ-1' })).statusCode).toBe(404);
    expect((await open(ctx.app, 'smirnova', { system: 'XYZ', caseId: 'Г26-04512' })).statusCode).toBe(400);
  });
});

describe('Application Service: транзакции и заявки', () => {
  it('проверяет токен homeserver', async () => {
    const { app } = setup();
    const url = '/_matrix/app/v1/transactions/1';
    expect((await app.inject({ method: 'PUT', url, payload: { events: [] } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url, headers: { authorization: 'Bearer wrong' }, payload: { events: [] } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url, headers: { authorization: `Bearer ${HS_TOKEN}` }, payload: { events: [] } })).statusCode).toBe(200);
  });

  it('заявка в чате случая создаётся в ЛИС, статус возвращается в чат один раз', async () => {
    const ctx = setup();
    const { roomId } = (await open(ctx.app, 'smirnova', { system: 'LIS', caseId: 'Г26-04512' })).json();
    const event = {
      event_id: '$req1',
      room_id: roomId,
      sender: mx('smirnova'),
      type: 'm.room.message',
      content: { msgtype: MsgType.Request, body: 'Запрос ИГХ', [MsgType.Request]: { kind: 'ihc', block: '1А', items: ['ER', 'HER2/neu'] } },
    };
    const send = (txn: string) =>
      ctx.app.inject({ method: 'PUT', url: `/_matrix/app/v1/transactions/${txn}`, headers: { authorization: `Bearer ${HS_TOKEN}` }, payload: { events: [event] } });
    await send('t1');
    await send('t1'); // повтор той же транзакции
    await send('t2'); // то же событие в другой транзакции
    const statuses = ctx.matrix.rooms.get(roomId)!.events.filter((e) => e.type === EventType.RequestStatus);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.content).toMatchObject({
      'm.relates_to': { rel_type: 'm.reference', event_id: '$req1' },
      status: 'accepted',
      external_id: expect.stringMatching(/^ИГХ-\d+$/),
    });
  });
});

describe('POST /api/v1/calls/token', () => {
  it('выдаёт токен LiveKit только вошедшему участнику комнаты', async () => {
    const ctx = setup();
    const { roomId } = (await open(ctx.app, 'smirnova', { system: 'LIS', caseId: 'Г26-04512' })).json();
    const call = (user: string) =>
      ctx.app.inject({ method: 'POST', url: '/api/v1/calls/token', headers: { authorization: `Bearer tok-${user}` }, payload: { roomId } });

    expect((await call('smirnova')).statusCode).toBe(403); // приглашена, но ещё не вошла
    ctx.matrix.join(roomId, mx('smirnova'));
    const ok = await call('smirnova');
    expect(ok.statusCode).toBe(200);
    const { token, room } = ok.json();
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    expect(payload.sub).toBe(mx('smirnova'));
    expect(payload.video).toMatchObject({ roomJoin: true, room });
    expect(room).toMatch(/^call-[0-9a-f]{24}$/);
    expect((await call('outsider')).statusCode).toBe(403);
  });
});
