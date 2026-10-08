/**
 * Хранилище сервиса контекста в PostgreSQL: реестр случаев, связь «случай → комната», заявки из чата,
 * обработанные события интеграции. Память (InMemory*) остаётся для модульных тестов.
 */
import pg from 'pg';
import { caseKey, type CaseRef } from '@konsilium/protocol';
import type { CaseRegistry, HostCase } from './cases.ts';
import type { CaseRoomStore } from './caseRooms.ts';
import type { Logger } from './events.ts';
import type { ProcessedEvents } from './integration.ts';
import type { RequestStore, TrackedRequest } from './requests.ts';

/** Миграции по порядку; применённые записываются в ccs_migrations. Менять уже выпущенные нельзя — только добавлять. */
const MIGRATIONS: string[] = [
  `create table case_snapshots (
     case_key text primary key,
     connector text not null,
     case_id text not null,
     version bigint not null,
     host_case jsonb not null,
     updated_at timestamptz not null default now()
   );
   create table case_rooms (
     case_key text primary key,
     room_id text not null unique,
     created_at timestamptz not null default now()
   );
   create table chat_requests (
     connector text not null,
     external_id text not null,
     case_id text not null,
     room_id text not null,
     event_id text not null,
     steps jsonb not null,
     created_at timestamptz not null default now(),
     primary key (connector, external_id)
   );
   create table integration_events (
     connector text not null,
     event_id text not null,
     status text not null,
     processed_at timestamptz not null default now(),
     primary key (connector, event_id)
   );
   create index integration_events_processed_at on integration_events (processed_at);`,
];

export function createPool(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 10, idleTimeoutMillis: 30_000 });
}

/** Создать базу, если её нет (например, на стенде с уже существующим томом PostgreSQL). */
export async function ensureDatabase(url: string, log: Logger): Promise<void> {
  const target = new URL(url);
  const name = decodeURIComponent(target.pathname.slice(1));
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Недопустимое имя базы: ${name}`);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  try {
    await client.connect();
    const exists = await client.query('select 1 from pg_database where datname = $1', [name]);
    if (exists.rowCount === 0) {
      // Synapse требует сортировку C — для единообразия создаём базу так же.
      await client.query(`create database "${name}" encoding 'UTF8' lc_collate 'C' lc_ctype 'C' template template0`);
      log.info({ database: name }, 'Создана база сервиса контекста');
    }
  } catch (e) {
    // Нет прав на создание базы — значит, её создаёт администратор; дальше подключимся к ней напрямую.
    log.warn({ err: e }, 'Не удалось проверить или создать базу сервиса контекста');
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function migrate(pool: pg.Pool): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock(727001)'); // несколько экземпляров сервиса не мигрируют одновременно
    await client.query('create table if not exists ccs_migrations (id int primary key, applied_at timestamptz not null default now())');
    const done = new Set((await client.query<{ id: number }>('select id from ccs_migrations')).rows.map((r) => r.id));
    let applied = 0;
    for (const [i, sql] of MIGRATIONS.entries()) {
      if (done.has(i + 1)) continue;
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into ccs_migrations (id) values ($1)', [i + 1]);
      await client.query('commit');
      applied += 1;
    }
    return applied;
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    await client.query('select pg_advisory_unlock(727001)').catch(() => undefined);
    client.release();
  }
}

export class PgCaseRegistry implements CaseRegistry {
  constructor(private readonly pool: pg.Pool) {}

  async get(ref: CaseRef): Promise<HostCase | null> {
    const r = await this.pool.query<{ host_case: HostCase }>('select host_case from case_snapshots where case_key = $1', [caseKey(ref)]);
    return r.rows[0]?.host_case ?? null;
  }

  /** Сравнение версий и запись — в одной транзакции с блокировкой строки. */
  async apply(hostCase: HostCase): Promise<{ status: 'accepted' | 'same' | 'stale'; previous: HostCase | null }> {
    const key = caseKey(hostCase.ref);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const cur = await client.query<{ version: string; host_case: HostCase }>('select version, host_case from case_snapshots where case_key = $1 for update', [key]);
      const previous = cur.rows[0]?.host_case ?? null;
      const prevVersion = cur.rows[0] ? Number(cur.rows[0].version) : null;
      const version = hostCase.snapshot.version;
      let status: 'accepted' | 'same' | 'stale' = 'accepted';
      if (prevVersion !== null && prevVersion > version) status = 'stale';
      else if (prevVersion === version) status = 'same';
      if (status === 'accepted') {
        await client.query(
          `insert into case_snapshots (case_key, connector, case_id, version, host_case) values ($1, $2, $3, $4, $5)
           on conflict (case_key) do update set version = excluded.version, host_case = excluded.host_case, case_id = excluded.case_id, updated_at = now()`,
          [key, hostCase.ref.connector, hostCase.snapshot.case_id, version, JSON.stringify(hostCase)],
        );
      }
      await client.query('commit');
      return { status, previous };
    } catch (e) {
      await client.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
}

export class PgCaseRoomStore implements CaseRoomStore {
  constructor(private readonly pool: pg.Pool) {}

  async get(key: string): Promise<string | null> {
    const r = await this.pool.query<{ room_id: string }>('select room_id from case_rooms where case_key = $1', [key]);
    return r.rows[0]?.room_id ?? null;
  }

  async set(key: string, roomId: string): Promise<void> {
    await this.pool.query('insert into case_rooms (case_key, room_id) values ($1, $2) on conflict (case_key) do update set room_id = excluded.room_id', [key, roomId]);
  }
}

export class PgRequestStore implements RequestStore {
  constructor(private readonly pool: pg.Pool) {}

  async add(r: TrackedRequest): Promise<void> {
    await this.pool.query(
      `insert into chat_requests (connector, external_id, case_id, room_id, event_id, steps) values ($1, $2, $3, $4, $5, $6)
       on conflict (connector, external_id) do update set room_id = excluded.room_id, event_id = excluded.event_id, steps = excluded.steps`,
      [r.connector, r.externalId, r.caseId, r.roomId, r.eventId, JSON.stringify(r.steps)],
    );
  }

  async find(connector: string, externalId: string): Promise<TrackedRequest | null> {
    const r = await this.pool.query<{ case_id: string; room_id: string; event_id: string; steps: TrackedRequest['steps'] }>(
      'select case_id, room_id, event_id, steps from chat_requests where connector = $1 and external_id = $2',
      [connector, externalId],
    );
    const row = r.rows[0];
    return row ? { connector, externalId, caseId: row.case_id, roomId: row.room_id, eventId: row.event_id, steps: row.steps } : null;
  }

  async updateSteps(connector: string, externalId: string, steps: TrackedRequest['steps']): Promise<void> {
    await this.pool.query('update chat_requests set steps = $3 where connector = $1 and external_id = $2', [connector, externalId, JSON.stringify(steps)]);
  }
}

export class PgProcessedEvents implements ProcessedEvents {
  constructor(private readonly pool: pg.Pool) {}

  async has(connector: string, eventId: string): Promise<boolean> {
    const r = await this.pool.query('select 1 from integration_events where connector = $1 and event_id = $2', [connector, eventId]);
    return (r.rowCount ?? 0) > 0;
  }

  async add(connector: string, eventId: string, status: string): Promise<void> {
    await this.pool.query('insert into integration_events (connector, event_id, status) values ($1, $2, $3) on conflict do nothing', [connector, eventId, status]);
  }

  /** Удалить записи старше срока идемпотентности (по контракту — 7 дней). */
  async prune(days = 7): Promise<number> {
    const r = await this.pool.query(`delete from integration_events where processed_at < now() - make_interval(days => $1)`, [days]);
    return r.rowCount ?? 0;
  }
}
