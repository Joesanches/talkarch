/**
 * Хранилище сервиса контекста в PostgreSQL: реестр случаев, связь «случай → комната», заявки из чата,
 * обработанные события интеграции. Память (InMemory*) остаётся для модульных тестов.
 */
import pg from 'pg';
import { caseKey, type CaseRef } from '@konsilium/protocol';
import type { ArchiveStore, ArchivedRoom, CaseInfo } from './archive.ts';
import type { CaseRegistry, HostCase } from './cases.ts';
import type { CaseRoomStore } from './caseRooms.ts';
import type { CriticalFinding, CriticalStore, Escalation } from './critical.ts';
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
  // Критические находки: без текста находки (он в чате) — адресаты, сроки, журнал эскалаций и подтверждения.
  `create table critical_findings (
     event_id text primary key,
     room_id text not null,
     connector text not null,
     case_id text not null,
     host_finding_id text,
     reported_by text not null,
     raised_at timestamptz not null,
     deadline_at timestamptz not null,
     recipients jsonb not null,
     plan jsonb not null,
     escalations jsonb not null default '[]',
     status text not null,
     ack_by text,
     ack_at timestamptz,
     next_at timestamptz
   );
   create unique index critical_findings_host on critical_findings (connector, host_finding_id) where host_finding_id is not null;
   create index critical_findings_due on critical_findings (next_at) where status = 'pending' and next_at is not null;
   create index critical_findings_connector on critical_findings (connector, raised_at);`,
  // Архив чатов случаев: состояние случая и активность по комнатам, выведенные участники и их возвраты.
  `create table case_lifecycle (
     room_id text primary key,
     case_key text not null,
     connector text not null,
     case_id text not null,
     title text not null,
     source text not null,
     -- Номер и название в нижнем регистре для поиска в папке «Архив»: база с ctype C не сравнивает кириллицу без учёта регистра.
     search text not null,
     closed_at timestamptz,
     last_activity_at timestamptz not null,
     archived_at timestamptz
   );
   create index case_lifecycle_due on case_lifecycle (closed_at) where closed_at is not null and archived_at is null;
   create table case_archive_members (
     room_id text not null references case_lifecycle (room_id) on delete cascade,
     user_id text not null,
     returned_at timestamptz,
     primary key (room_id, user_id)
   );
   create index case_archive_members_user on case_archive_members (user_id);
   create index case_archive_members_returned on case_archive_members (returned_at) where returned_at is not null;
   create index critical_findings_room_pending on critical_findings (room_id) where status = 'pending';`,
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

interface CriticalRow {
  event_id: string;
  room_id: string;
  connector: string;
  case_id: string;
  host_finding_id: string | null;
  reported_by: string;
  raised_at: Date;
  deadline_at: Date;
  recipients: string[];
  plan: CriticalFinding['plan'];
  escalations: Escalation[];
  status: CriticalFinding['status'];
  ack_by: string | null;
  ack_at: Date | null;
  next_at: Date | null;
}

const toFinding = (r: CriticalRow): CriticalFinding => ({
  eventId: r.event_id,
  roomId: r.room_id,
  connector: r.connector,
  caseId: r.case_id,
  ...(r.host_finding_id ? { hostFindingId: r.host_finding_id } : {}),
  reportedBy: r.reported_by,
  raisedAt: r.raised_at.getTime(),
  deadlineAt: r.deadline_at.getTime(),
  recipients: r.recipients,
  plan: r.plan,
  escalations: r.escalations,
  status: r.status,
  ...(r.ack_by ? { ackBy: r.ack_by } : {}),
  ...(r.ack_at ? { ackAt: r.ack_at.getTime() } : {}),
  nextAt: r.next_at ? r.next_at.getTime() : null,
});

const ts = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms));

export class PgCriticalStore implements CriticalStore {
  constructor(private readonly pool: pg.Pool) {}

  async add(f: CriticalFinding): Promise<boolean> {
    const r = await this.pool.query(
      `insert into critical_findings (event_id, room_id, connector, case_id, host_finding_id, reported_by, raised_at, deadline_at, recipients, plan, escalations, status, next_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) on conflict do nothing`,
      [
        f.eventId,
        f.roomId,
        f.connector,
        f.caseId,
        f.hostFindingId ?? null,
        f.reportedBy,
        ts(f.raisedAt),
        ts(f.deadlineAt),
        JSON.stringify(f.recipients),
        JSON.stringify(f.plan),
        JSON.stringify(f.escalations),
        f.status,
        ts(f.nextAt),
      ],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async get(eventId: string): Promise<CriticalFinding | null> {
    const r = await this.pool.query<CriticalRow>('select * from critical_findings where event_id = $1', [eventId]);
    return r.rows[0] ? toFinding(r.rows[0]) : null;
  }

  async byHostId(connector: string, hostFindingId: string): Promise<CriticalFinding | null> {
    const r = await this.pool.query<CriticalRow>('select * from critical_findings where connector = $1 and host_finding_id = $2', [connector, hostFindingId]);
    return r.rows[0] ? toFinding(r.rows[0]) : null;
  }

  /** Аренда: next_at сдвигается вперёд в той же команде — параллельный экземпляр эти строки пропустит. */
  async claimDue(now: number, leaseMs: number, limit: number): Promise<CriticalFinding[]> {
    const r = await this.pool.query<CriticalRow>(
      `update critical_findings set next_at = $2 where event_id in (
         select event_id from critical_findings where status = 'pending' and next_at <= $1 order by next_at limit $3 for update skip locked
       ) returning *`,
      [ts(now), ts(now + leaseMs), limit],
    );
    return r.rows.map(toFinding);
  }

  async recordEscalation(eventId: string, escalation: Escalation, recipients: string[], nextAt: number | null): Promise<boolean> {
    const r = await this.pool.query(
      `update critical_findings set escalations = escalations || $2::jsonb, recipients = $3, next_at = $4 where event_id = $1 and status = 'pending'`,
      [eventId, JSON.stringify([escalation]), JSON.stringify(recipients), ts(nextAt)],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async clearNext(eventId: string): Promise<void> {
    await this.pool.query('update critical_findings set next_at = null where event_id = $1', [eventId]);
  }

  async acknowledge(eventId: string, by: string, at: number): Promise<CriticalFinding | null> {
    const r = await this.pool.query<CriticalRow>(
      `update critical_findings set status = 'acknowledged', ack_by = $2, ack_at = $3, next_at = null where event_id = $1 and status = 'pending' returning *`,
      [eventId, by, ts(at)],
    );
    return r.rows[0] ? toFinding(r.rows[0]) : null;
  }

  async list(connector: string, since: number): Promise<CriticalFinding[]> {
    const r = await this.pool.query<CriticalRow>('select * from critical_findings where connector = $1 and raised_at >= $2 order by raised_at', [connector, ts(since)]);
    return r.rows.map(toFinding);
  }

  async pendingInRoom(roomId: string): Promise<boolean> {
    const r = await this.pool.query(`select 1 from critical_findings where room_id = $1 and status = 'pending' limit 1`, [roomId]);
    return (r.rowCount ?? 0) > 0;
  }
}

export class PgArchiveStore implements ArchiveStore {
  constructor(private readonly pool: pg.Pool) {}

  async track(roomId: string, info: CaseInfo, closed: boolean, at: number): Promise<void> {
    await this.pool.query(
      `insert into case_lifecycle (room_id, case_key, connector, case_id, title, source, search, closed_at, last_activity_at)
       values ($1, $2, $3, $4, $5, $6, $7, case when $8 then $9::timestamptz end, $9)
       on conflict (room_id) do update set case_key = excluded.case_key, connector = excluded.connector, case_id = excluded.case_id,
         title = excluded.title, source = excluded.source, search = excluded.search,
         closed_at = case when $8 then coalesce(case_lifecycle.closed_at, $9) end`,
      [roomId, info.caseKey, info.connector, info.caseId, info.title, info.source, `${info.caseId}\n${info.title}`.toLowerCase(), closed, ts(at)],
    );
  }

  async touch(roomId: string, at: number): Promise<void> {
    await this.pool.query('update case_lifecycle set last_activity_at = greatest(last_activity_at, $2) where room_id = $1 and archived_at is null', [roomId, ts(at)]);
  }

  async claimDue(idleBefore: number, at: number, limit: number): Promise<string[]> {
    const r = await this.pool.query<{ room_id: string }>(
      `update case_lifecycle set archived_at = $2 where room_id in (
         select room_id from case_lifecycle
         where closed_at is not null and archived_at is null and greatest(closed_at, last_activity_at) < $1
         order by closed_at limit $3 for update skip locked
       ) returning room_id`,
      [ts(idleBefore), ts(at), limit],
    );
    return r.rows.map((x) => x.room_id);
  }

  async release(roomId: string): Promise<void> {
    await this.pool.query('update case_lifecycle set archived_at = null where room_id = $1', [roomId]);
  }

  async addMembers(roomId: string, userIds: string[]): Promise<void> {
    if (!userIds.length) return;
    await this.pool.query(
      'insert into case_archive_members (room_id, user_id) select $1, unnest($2::text[]) on conflict do nothing',
      [roomId, userIds],
    );
  }

  async isArchived(roomId: string): Promise<boolean> {
    const r = await this.pool.query('select 1 from case_lifecycle where room_id = $1 and archived_at is not null', [roomId]);
    return (r.rowCount ?? 0) > 0;
  }

  async restore(roomId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('update case_lifecycle set archived_at = null where room_id = $1', [roomId]);
      await client.query('delete from case_archive_members where room_id = $1', [roomId]);
      await client.query('commit');
    } catch (e) {
      await client.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async wasMember(roomId: string, userId: string): Promise<boolean> {
    const r = await this.pool.query('select 1 from case_archive_members where room_id = $1 and user_id = $2', [roomId, userId]);
    return (r.rowCount ?? 0) > 0;
  }

  async dropMembers(roomId: string, userIds: string[]): Promise<void> {
    await this.pool.query('delete from case_archive_members where room_id = $1 and user_id = any($2::text[])', [roomId, userIds]);
  }

  async markReturned(roomId: string, userId: string, at: number): Promise<void> {
    await this.pool.query(
      `insert into case_archive_members (room_id, user_id, returned_at) values ($1, $2, $3)
       on conflict (room_id, user_id) do update set returned_at = excluded.returned_at`,
      [roomId, userId, ts(at)],
    );
  }

  async claimReturns(before: number, limit: number): Promise<Array<{ roomId: string; userId: string }>> {
    const r = await this.pool.query<{ room_id: string; user_id: string }>(
      `update case_archive_members set returned_at = null where (room_id, user_id) in (
         select room_id, user_id from case_archive_members where returned_at < $1 order by returned_at limit $2 for update skip locked
       ) returning room_id, user_id`,
      [ts(before), limit],
    );
    return r.rows.map((x) => ({ roomId: x.room_id, userId: x.user_id }));
  }

  async forUser(userId: string, opts: { q?: string; limit: number }): Promise<ArchivedRoom[]> {
    const q = opts.q?.trim();
    const r = await this.pool.query<{ room_id: string; case_key: string; connector: string; case_id: string; title: string; source: CaseInfo['source']; archived_at: Date }>(
      `select l.room_id, l.case_key, l.connector, l.case_id, l.title, l.source, l.archived_at
       from case_archive_members m join case_lifecycle l on l.room_id = m.room_id
       where m.user_id = $1 and l.archived_at is not null
         and ($2::text is null or l.search like $2)
       order by l.archived_at desc limit $3`,
      [userId, q ? `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null, opts.limit],
    );
    return r.rows.map((x) => ({
      roomId: x.room_id,
      caseKey: x.case_key,
      connector: x.connector,
      caseId: x.case_id,
      title: x.title,
      source: x.source,
      archivedAt: x.archived_at.getTime(),
    }));
  }
}
