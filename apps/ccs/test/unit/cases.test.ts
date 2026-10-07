import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventType, RoomType } from '@konsilium/protocol';
import { CaseRoomService, InMemoryCaseRoomStore } from '../../src/caseRooms.ts';
import { LIS_CASE, RIS_CASE, SERVER, mx, setup, type Harness } from './harness.ts';

let h: Harness;
beforeEach(async () => {
  h = await setup();
});
afterEach(async () => {
  await h.close();
});

describe('POST /api/v1/cases/open', () => {
  it('создаёт комнату случая с контекстом, ролями и приглашениями по ролям', async () => {
    const res = await h.open('smirnova', { connector: 'lis', caseId: LIS_CASE });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ created: true, membership: 'invite', connector: 'lis', caseId: LIS_CASE });
    expect(body.alias).toMatch(/^#c-[0-9a-f]{24}:konsilium\.test$/);

    const room = h.matrix.rooms.get(body.roomId)!;
    expect(room.req.creation_content).toEqual({ type: RoomType.Case });
    expect(room.req.invite?.sort()).toEqual([mx('ershova'), mx('kolesnikov'), mx('smirnova')]);
    const context = await h.matrix.getState<Record<string, any>>(body.roomId, EventType.CaseContext);
    expect(context).toMatchObject({ source: 'LIS', connector: 'lis', case_id: LIS_CASE, status: 'open', patient: { masked: 'Н*** О. В.' } });
    expect(JSON.stringify(context)).not.toMatch(/Нестерова/);
    const roles = await h.matrix.getState<Record<string, any>>(body.roomId, EventType.CaseRoles);
    expect(roles?.members[mx('ershova')]).toMatchObject({ role: 'lab_tech', source: 'LIS' });
    const pl = room.req.power_level_content_override as Record<string, any>;
    expect(pl.invite).toBe(100);
    // Комнаты версии 12: создателя нельзя перечислять в users.
    expect(pl.users).toBeUndefined();
  });

  it('находит подключение по типу системы, если оно одно', async () => {
    const res = await h.open('orlov', { system: 'RIS', caseId: RIS_CASE });
    expect(res.json()).toMatchObject({ connector: 'ris', created: true });
  });

  it('достраивает комнату, если псевдоним есть, а контекста нет (сбой посреди createRoom)', async () => {
    const { localpart } = h.service.caseRooms.aliasFor({ connector: 'lis', caseId: LIS_CASE });
    const broken = await h.matrix.createRoom({ room_alias_name: localpart, creation_content: { type: RoomType.Case } });
    const res = (await h.open('smirnova', { connector: 'lis', caseId: LIS_CASE })).json();
    expect(res).toMatchObject({ roomId: broken, created: false });
    expect(await h.matrix.getState(broken, EventType.CaseContext)).toMatchObject({ case_id: LIS_CASE });
    expect(await h.matrix.getMembership(broken, mx('ershova'))).toBe('invite');
  });

  it('повторное и параллельное открытие возвращает ту же комнату', async () => {
    h.matrix.createDelayMs = 20;
    const results = await Promise.all(['smirnova', 'ershova', 'kolesnikov', 'smirnova'].map((u) => h.open(u, { connector: 'lis', caseId: LIS_CASE })));
    const ids = new Set(results.map((r) => r.json().roomId));
    expect(ids.size).toBe(1);
    expect(h.matrix.createCalls).toBe(1);
    const again = await h.open('smirnova', { connector: 'lis', caseId: 'г26-04512' });
    expect(again.json()).toMatchObject({ created: false, roomId: [...ids][0] });
  });

  it('после перезапуска сервиса находит комнату по псевдониму, а не создаёт новую', async () => {
    const first = (await h.open('smirnova', { connector: 'lis', caseId: LIS_CASE })).json();
    const restarted = new CaseRoomService(h.matrix, new InMemoryCaseRoomStore(), { aliasSecret: 'alias-secret-for-tests', serverName: SERVER });
    const hostCase = (await h.service.directory.find({ connector: 'lis', caseId: LIS_CASE }))!;
    expect(await restarted.getOrCreate(hostCase)).toMatchObject({ roomId: first.roomId, created: false });
  });

  it('уровень 2: пускает по требованию тех, кому система-источник разрешила (обратный вызов)', async () => {
    expect((await h.open('gusev', { connector: 'lis', caseId: LIS_CASE })).json()).toMatchObject({ membership: 'invite' });
    expect((await h.open('outsider', { connector: 'lis', caseId: LIS_CASE })).statusCode).toBe(403);
  });

  it('уровень 1: пускает по списку access из события, остальным отказывает', async () => {
    expect((await h.open('belova', { connector: 'ris', caseId: RIS_CASE })).json()).toMatchObject({ membership: 'invite' });
    expect((await h.open('gusev', { connector: 'ris', caseId: RIS_CASE })).statusCode).toBe(403);
  });

  it('запрашивает снимок у системы-источника, если события по случаю ещё не было', async () => {
    const res = await h.open('smirnova', { connector: 'lis', caseId: 'Г26-04530' });
    expect(res.json()).toMatchObject({ created: true, caseId: 'Г26-04530' });
  });

  it('отказывает без токена, для неизвестного случая и подключения, при некорректном запросе', async () => {
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/cases/open', payload: { connector: 'lis', caseId: 'x' } })).statusCode).toBe(401);
    expect((await h.open('smirnova', { connector: 'lis', caseId: 'НЕТ-1' })).statusCode).toBe(404);
    expect((await h.open('smirnova', { connector: 'pacs', caseId: LIS_CASE })).statusCode).toBe(404);
    expect((await h.open('smirnova', { system: 'XYZ', caseId: LIS_CASE })).statusCode).toBe(400);
    expect((await h.open('smirnova', { caseId: LIS_CASE })).statusCode).toBe(400);
  });

  it('отозванный доступ закрывает и вход по требованию', async () => {
    await h.mock.updateCase('lis', LIS_CASE, { revoked: [{ login: 'gusev' }] });
    expect((await h.open('gusev', { connector: 'lis', caseId: LIS_CASE })).statusCode).toBe(403);
  });
});

describe('CORS для веб-клиента', () => {
  it('разрешает запросы только с адреса веб-клиента', async () => {
    const preflight = (origin: string) =>
      h.app.inject({
        method: 'OPTIONS',
        url: '/api/v1/cases/open',
        headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
      });
    expect((await preflight('https://chat.clinic.local')).headers['access-control-allow-origin']).toBe('https://chat.clinic.local');
    expect((await preflight('https://evil.example')).headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('POST /api/v1/cases/patient', () => {
  const reveal = (user: string, roomId: string) =>
    h.app.inject({ method: 'POST', url: '/api/v1/cases/patient', headers: { authorization: `Bearer tok-${user}` }, payload: { roomId, reason: 'сверка перед описанием' } });

  it('раскрывает данные только вошедшему участнику; журнал ведёт система-источник', async () => {
    const { roomId } = (await h.open('smirnova', { connector: 'lis', caseId: LIS_CASE })).json();
    expect((await reveal('smirnova', roomId)).statusCode).toBe(403); // приглашена, но не вошла
    h.matrix.join(roomId, mx('smirnova'));
    const ok = await reveal('smirnova', roomId);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.json().patient).toMatchObject({ display_name: 'Нестерова Ольга Викторовна' });
    expect(h.mock.audit).toEqual([expect.objectContaining({ login: 'smirnova', action: 'patient_reveal', caseId: LIS_CASE })]);
    // В Matrix данные пациента не попали.
    expect(JSON.stringify([...h.matrix.rooms.get(roomId)!.state.values(), ...h.matrix.rooms.get(roomId)!.events])).not.toMatch(/Нестерова/);
    expect((await reveal('outsider', roomId)).statusCode).toBe(403);
  });

  it('для системы без обратных вызовов — 501', async () => {
    const { roomId } = (await h.open('orlov', { connector: 'ris', caseId: RIS_CASE })).json();
    h.matrix.join(roomId, mx('orlov'));
    expect((await reveal('orlov', roomId)).statusCode).toBe(501);
  });
});

describe('POST /api/v1/calls/token', () => {
  it('выдаёт токен LiveKit только вошедшему участнику комнаты', async () => {
    const { roomId } = (await h.open('smirnova', { connector: 'lis', caseId: LIS_CASE })).json();
    const call = (user: string) =>
      h.app.inject({ method: 'POST', url: '/api/v1/calls/token', headers: { authorization: `Bearer tok-${user}` }, payload: { roomId } });

    expect((await call('smirnova')).statusCode).toBe(403); // приглашена, но ещё не вошла
    h.matrix.join(roomId, mx('smirnova'));
    h.matrix.profiles.set(mx('smirnova'), 'Смирнова А. В.');
    const ok = await call('smirnova');
    expect(ok.statusCode).toBe(200);
    const { token, room } = ok.json();
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    expect(payload.sub).toBe(mx('smirnova'));
    expect(payload.name).toBe('Смирнова А. В.');
    expect(payload.video).toMatchObject({ roomJoin: true, room });
    expect(room).toMatch(/^call-[0-9a-f]{24}$/);
    expect((await call('outsider')).statusCode).toBe(403);
  });
});
