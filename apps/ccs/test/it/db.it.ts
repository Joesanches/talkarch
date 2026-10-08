/**
 * Хранилище сервиса контекста на настоящем PostgreSQL (из infra/: порт 55432).
 * Каждый прогон — своя временная база, удаляется в конце.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HostCase } from '../../src/cases.ts';
import { PgCaseRegistry, PgCaseRoomStore, PgProcessedEvents, PgRequestStore, createPool, ensureDatabase, migrate } from '../../src/db.ts';

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
    expect(await migrate(pool)).toBe(1);
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
});
