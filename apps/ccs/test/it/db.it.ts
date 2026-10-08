/**
 * Хранилище сервиса контекста на настоящем PostgreSQL (из infra/: порт 55432).
 * Каждый прогон — своя временная база, удаляется в конце.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HostCase } from '../../src/cases.ts';
import type { CriticalFinding } from '../../src/critical.ts';
import { PgArchiveStore, PgCaseRegistry, PgCaseRoomStore, PgCriticalStore, PgProcessedEvents, PgRequestStore, createPool, ensureDatabase, migrate } from '../../src/db.ts';

const ADMIN = process.env.IT_PG_URL ?? 'postgres://synapse:synapse-dev@localhost:55432/postgres';
const DB = `ccs_it_db_${Date.now()}`;
const url = ADMIN.replace(/\/postgres$/, `/${DB}`);
const silent = { info() {}, warn() {}, error() {} };

const hostCase = (version: number, stage = 'ihc'): HostCase => ({
  ref: { connector: 'lis', caseId: 'Г26-04512' },
  source: 'LIS',
  snapshot: {
    case_id: 'Г26-04512',
    version,
    status: 'open',
    title: 'Биопсия',
    patient: { ref: 'pseudo:1', masked: 'Н*** О. В.' },
    stage,
    participants: [],
    updated_at: '2026-10-08T10:00:00+03:00',
  },
  participants: [{ userId: '@smirnova:konsilium.test', role: 'pathologist' }],
  access: [],
  revoked: [],
});

describe('Хранилище сервиса контекста в PostgreSQL', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    await ensureDatabase(url, silent);
    pool = createPool(url);
    expect(await migrate(pool)).toBe(3);
    expect(await migrate(pool)).toBe(0); // повторный запуск ничего не делает
  });

  afterAll(async () => {
    await pool?.end();
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`drop database if exists "${DB}"`);
    await admin.end();
  });

  it('реестр случаев: новая версия принимается, та же — same, старая — stale', async () => {
    const registry = new PgCaseRegistry(pool);
    expect((await registry.apply(hostCase(2))).status).toBe('accepted');
    expect((await registry.apply(hostCase(2))).status).toBe('same');
    expect((await registry.apply(hostCase(1, 'grossing'))).status).toBe('stale');
    const r = await registry.apply(hostCase(3, 'reporting'));
    expect(r).toMatchObject({ status: 'accepted', previous: { snapshot: { version: 2 } } });
    // Ключ случая не зависит от регистра номера; данные переживают «перезапуск» (новый экземпляр).
    expect(await new PgCaseRegistry(pool).get({ connector: 'lis', caseId: 'г26-04512' })).toMatchObject({ snapshot: { version: 3, stage: 'reporting' } });
  });

  it('параллельные снимки одного случая: остаётся новейший', async () => {
    const registry = new PgCaseRegistry(pool);
    await Promise.all([4, 7, 5, 6].map((v) => registry.apply(hostCase(v))));
    expect((await registry.get({ connector: 'lis', caseId: 'Г26-04512' }))?.snapshot.version).toBe(7);
  });

  it('связь «случай → комната» и заявки из чата', async () => {
    const rooms = new PgCaseRoomStore(pool);
    await rooms.set('lis:Г26-04512', '!room:konsilium.test');
    expect(await rooms.get('lis:Г26-04512')).toBe('!room:konsilium.test');

    const requests = new PgRequestStore(pool);
    await requests.add({ connector: 'lis', caseId: 'Г26-04512', externalId: 'ИГХ-1', roomId: '!room:konsilium.test', eventId: '$req', steps: ['accepted', 'done'] });
    await requests.updateSteps('lis', 'ИГХ-1', ['accepted', 'staining', 'done']);
    expect(await requests.find('lis', 'ИГХ-1')).toMatchObject({ eventId: '$req', steps: ['accepted', 'staining', 'done'] });
    expect(await requests.find('ris', 'ИГХ-1')).toBeNull();
  });

  it('обработанные события: идемпотентность и очистка по сроку', async () => {
    const processed = new PgProcessedEvents(pool);
    await processed.add('lis', 'e1', 'accepted');
    await processed.add('lis', 'e1', 'accepted');
    expect(await processed.has('lis', 'e1')).toBe(true);
    expect(await processed.has('ris', 'e1')).toBe(false);
    await pool.query(`update integration_events set processed_at = now() - interval '8 days' where event_id = 'e1'`);
    expect(await processed.prune()).toBe(1);
    expect(await processed.has('lis', 'e1')).toBe(false);
  });

  it('критические находки: дубли, аренда шагов при параллельной проверке, подтверждение — ровно одно', async () => {
    const store = new PgCriticalStore(pool);
    const t0 = Date.parse('2026-10-08T10:00:00Z');
    const f: CriticalFinding = {
      eventId: '$crit1',
      roomId: '!room:konsilium.test',
      connector: 'ris',
      caseId: 'A26-118734',
      hostFindingId: 'КН-1',
      reportedBy: '@orlov:konsilium.test',
      raisedAt: t0,
      deadlineAt: t0 + 600_000,
      recipients: ['@melnikova:konsilium.test'],
      plan: [{ afterS: 600, action: 'call', target: 'Пост', users: [] }],
      escalations: [],
      status: 'pending',
      nextAt: t0 + 600_000,
    };
    expect(await store.add(f)).toBe(true);
    expect(await store.add(f)).toBe(false);
    expect(await store.add({ ...f, eventId: '$crit2' })).toBe(false); // тот же номер находки РИС
    expect(await store.byHostId('ris', 'КН-1')).toMatchObject({ eventId: '$crit1', recipients: ['@melnikova:konsilium.test'] });

    // Два экземпляра сервиса проверяют сроки одновременно — шаг достаётся одному.
    const due = t0 + 600_000;
    const claims = await Promise.all([store.claimDue(due, 60_000, 10), store.claimDue(due, 60_000, 10)]);
    expect(claims.map((c) => c.length).sort()).toEqual([0, 1]);
    expect(await store.recordEscalation('$crit1', { step: 1, at: due, action: 'call', target: 'Пост', users: [] }, f.recipients, null)).toBe(true);
    expect((await store.get('$crit1'))?.escalations).toHaveLength(1);

    const acks = await Promise.all([
      store.acknowledge('$crit1', '@melnikova:konsilium.test', due + 1000),
      store.acknowledge('$crit1', '@gusev:konsilium.test', due + 1000),
    ]);
    expect(acks.filter(Boolean)).toHaveLength(1);
    expect(await store.recordEscalation('$crit1', { step: 2, at: due, action: 'notify', target: 'head', users: [] }, [], null)).toBe(false);
    const [listed] = await store.list('ris', t0);
    expect(listed).toMatchObject({ status: 'acknowledged', ackAt: due + 1000, nextAt: null });
  });

  it('архив: закрытые без активности, аренда при параллельных проходах, возвраты, поиск, возврат из архива', async () => {
    const store = new PgArchiveStore(pool);
    const t0 = Date.parse('2026-10-08T10:00:00Z');
    const DAY = 86_400_000;
    const info = (caseId: string, title: string) => ({ caseKey: `lis:${caseId}`, connector: 'lis', caseId, title, source: 'LIS' as const });
    await store.track('!a:t', info('Г26-1', 'Биопсия желудка'), false, t0);
    await store.track('!b:t', info('Г26-2', 'Биопсия кожи'), true, t0);
    await store.track('!c:t', info('Г26-3', 'Резекция'), true, t0);
    await store.track('!c:t', info('Г26-3', 'Резекция'), true, t0 + 5 * DAY); // повторный снимок закрытого: время закрытия прежнее
    await store.touch('!b:t', t0 + 10 * DAY);
    await store.touch('!b:t', t0 + 2 * DAY); // старое событие не отодвигает назад

    // Два экземпляра сервиса — комната достаётся одному.
    const claims = await Promise.all([store.claimDue(t0 + 7 * DAY, t0 + 21 * DAY, 10), store.claimDue(t0 + 7 * DAY, t0 + 21 * DAY, 10)]);
    expect(claims.flat()).toEqual(['!c:t']);
    expect(await store.isArchived('!c:t')).toBe(true);
    expect(await store.claimDue(t0 + 30 * DAY, t0 + 30 * DAY, 10)).toEqual(['!b:t']);
    await store.release('!b:t');
    expect(await store.isArchived('!b:t')).toBe(false);

    await store.addMembers('!c:t', ['@smirnova:t', '@ershova:t']);
    await store.addMembers('!c:t', ['@smirnova:t']);
    expect(await store.wasMember('!c:t', '@ershova:t')).toBe(true);
    expect(await store.wasMember('!c:t', '@outsider:t')).toBe(false);
    expect((await store.forUser('@smirnova:t', { limit: 10 })).map((r) => r.caseId)).toEqual(['Г26-3']);
    expect(await store.forUser('@smirnova:t', { q: 'резек', limit: 10 })).toHaveLength(1);
    expect(await store.forUser('@smirnova:t', { q: '100%', limit: 10 })).toHaveLength(0);

    await store.markReturned('!c:t', '@ershova:t', t0 + 15 * DAY);
    await store.markReturned('!c:t', '@gusev:t', t0 + 15 * DAY); // вернулся, не будучи в чате до архива
    expect(await store.claimReturns(t0 + 15 * DAY, 10)).toEqual([]);
    const back = await Promise.all([store.claimReturns(t0 + 16 * DAY, 10), store.claimReturns(t0 + 16 * DAY, 10)]);
    expect(back.flat().map((r) => r.userId).sort()).toEqual(['@ershova:t', '@gusev:t']);
    expect((await store.forUser('@gusev:t', { limit: 10 })).map((r) => r.roomId)).toEqual(['!c:t']);
    await store.dropMembers('!c:t', ['@gusev:t']);
    expect(await store.forUser('@gusev:t', { limit: 10 })).toEqual([]);

    await store.restore('!c:t');
    expect(await store.isArchived('!c:t')).toBe(false);
    expect(await store.wasMember('!c:t', '@ershova:t')).toBe(false);
    await store.track('!c:t', info('Г26-3', 'Резекция'), false, t0 + 20 * DAY);
    expect(await store.claimDue(t0 + 100 * DAY, t0 + 100 * DAY, 10)).toEqual(['!b:t']); // открытый случай в архив не уходит
  });
});
