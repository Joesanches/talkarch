/**
 * Нагрузочный тест PoC (docs/03-architecture.md, 9.4; отчёт — docs/11-load-test.md).
 *
 *   docker compose -p konsilium-load -f infra/docker-compose.yml -f tools/load/docker-compose.load.yml up -d synapse
 *   pnpm --filter @konsilium/load load
 *
 * Сценарии на одном стенде, по очереди:
 *   A. снимки случаев (case.upserted) пакетами и создание чатов случаев с постоянной частотой, затем — целевой пик;
 *   B. события интеграции в существующие чаты: уведомления и обновления случаев;
 *   C. доставка сообщений при сотнях клиентов синхронизации (long-poll /sync, как у веб-клиента) на нескольких частотах;
 *   D. холодный старт: первая синхронизация пользователя с 20 и с 200 комнатами (по одному и массовым переподключением);
 *      Simplified Sliding Sync, если доступен.
 * Сервис контекста тест запускает сам — с отдельной базой и подключением `load` (уровень 1).
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CLIENT_FILTER, Hs } from './hs.ts';
import { Recorder, paced, pool, sleep } from './stats.ts';

const env = process.env;
const num = (name: string, def: number) => (env[name] ? Number(env[name]) : def);
const HS_URL = env.HS_URL ?? 'http://localhost:18008';
const CCS_PORT = num('CCS_PORT', 8080);
const CCS_URL = `http://127.0.0.1:${CCS_PORT}`;
const PG_URL = env.LOAD_PG_URL ?? 'postgres://synapse:synapse-dev@localhost:55433/ccs_load';
const PG_CONTAINER = env.LOAD_PG_CONTAINER ?? 'konsilium-load-postgres-1';
const SYNAPSE_CONTAINER = env.LOAD_SYNAPSE_CONTAINER ?? 'konsilium-load-synapse-1';
const USERS = num('USERS', 300);
const ROOMS_PER_USER = num('ROOMS_PER_USER', 20);
const ROOM_SIZE = 3;
const CREATE_RATE = num('CREATE_RATE', 2.5);
const BURST = num('BURST', 300);
const BURST_RATE = num('BURST_RATE', 5);
const HEAVY = num('HEAVY_USERS', 5);
const HEAVY_ROOMS = num('HEAVY_ROOMS', 200);
const EVENTS = num('INTEGRATION_EVENTS', 1000);
const MSG_RATES = (env.MSG_RATES ?? '2,10,30').split(',').map(Number);
const STEP_S = num('STEP_S', 60);
const RUN = env.RUN_ID ?? Date.now().toString(36);
const ROOT = resolve(import.meta.dirname, '../../..');
const OUT = resolve(env.OUT ?? join(ROOT, 'tools/load/results', `load-${RUN}.json`));

const PASSWORD = 'dev-only-load-password-1';
const LOAD_TOKEN = 'dev-only-load-token-0123456789abcdef';
const hs = new Hs(HS_URL, env.SYNAPSE_REGISTRATION_SECRET ?? 'dev-only-registration-shared-secret');
const results: Record<string, unknown> = { run: RUN, started_at: new Date().toISOString(), params: { USERS, ROOMS_PER_USER, CREATE_RATE, BURST, BURST_RATE, HEAVY, HEAVY_ROOMS, EVENTS, MSG_RATES, STEP_S } };
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ── Ресурсы ──────────────────────────────────────────────────────────────────

function dockerStats(): Record<string, string> {
  try {
    const out = execFileSync('docker', ['stats', '--no-stream', '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}', SYNAPSE_CONTAINER, PG_CONTAINER], { encoding: 'utf8' });
    return Object.fromEntries(out.trim().split('\n').map((l) => { const [n, cpu, mem] = l.split('\t'); return [n!.replace(/^konsilium-load-|-1$/g, ''), `${cpu} · ${mem?.split(' / ')[0]}`]; }));
  } catch {
    return {};
  }
}

/** Процессорное время процесса (утилита + система), с — для загрузки сервиса контекста за шаг. */
function cpuSeconds(pid: number): number {
  try {
    const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ');
    return (Number(f[11]) + Number(f[12])) / 100;
  } catch {
    return NaN;
  }
}

function psql(sql: string): string {
  try {
    return execFileSync('docker', ['exec', PG_CONTAINER, 'psql', '-U', 'synapse', '-d', 'synapse', '-Atc', sql], { encoding: 'utf8' }).trim();
  } catch {
    return '?';
  }
}

// ── Сервис контекста ─────────────────────────────────────────────────────────

async function startCcs(): Promise<ChildProcess> {
  const dir = mkdtempSync(join(tmpdir(), 'konsilium-load-'));
  const connectors = join(dir, 'connectors.json');
  writeFileSync(
    connectors,
    JSON.stringify({
      connectors: [{ id: 'load', kind: 'LIS', org: 'load', title: 'Нагрузочный тест', token_sha256: createHash('sha256').update(LOAD_TOKEN).digest('hex') }],
    }),
  );
  const out = openSync(join(dir, 'ccs.log'), 'a');
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/ccs/src/index.ts'], {
    cwd: ROOT,
    stdio: ['ignore', out, out],
    env: {
      ...env,
      CCS_HOST: '0.0.0.0',
      CCS_PORT: String(CCS_PORT),
      HS_URL: HS_URL,
      HS_SERVER_NAME: 'konsilium.test',
      AS_TOKEN: 'dev-only-as-token-0123456789abcdef',
      HS_TOKEN: 'dev-only-hs-token-0123456789abcdef',
      ALIAS_SECRET: `dev-only-load-alias-${RUN}`,
      CONNECTORS_FILE: connectors,
      DATABASE_URL: PG_URL,
      CHAT_WEB_URL: 'http://localhost:5173',
      LIVEKIT_API_KEY: 'devkey',
      LIVEKIT_API_SECRET: 'secret',
    },
  });
  for (let i = 0; i < 60; i++) {
    if ((await fetch(`${CCS_URL}/healthz`).catch(() => null))?.ok) {
      log(`сервис контекста запущен (журнал: ${join(dir, 'ccs.log')})`);
      return child;
    }
    await sleep(500);
  }
  throw new Error('Сервис контекста не запустился');
}

async function integration(events: unknown[]): Promise<{ ms: number; statuses: string[]; http: number }> {
  const t0 = performance.now();
  const res = await fetch(`${CCS_URL}/integration/v1/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${LOAD_TOKEN}`, 'content-type': 'application/cloudevents-batch+json' },
    body: JSON.stringify(events),
  });
  const json = (await res.json().catch(() => ({ results: [] }))) as { results: Array<{ status: string }> };
  return { ms: performance.now() - t0, statuses: json.results.map((r) => r.status), http: res.status };
}

const cloudEvent = (id: string, type: string, data: unknown) => ({ specversion: '1.0', id, source: 'load', type, data });

// ── Модель данных теста ──────────────────────────────────────────────────────

interface User {
  login: string;
  userId: string;
  token: string;
}
interface CaseRoom {
  caseId: string;
  members: number[]; // индексы обычных пользователей
  heavy: number | null;
  roomId?: string;
}

async function main() {
  const versions = await fetch(`${HS_URL}/_matrix/client/versions`).catch(() => null);
  if (!versions?.ok) throw new Error(`Synapse недоступен на ${HS_URL}. См. tools/load/docker-compose.load.yml`);
  const ccs = await startCcs();
  const ccsPid = ccs.pid!;

  // Пользователи.
  log(`пользователи: ${USERS} обычных, ${HEAVY} «тяжёлых»`);
  const regular: User[] = [];
  const heavy: User[] = [];
  const reg = new Recorder();
  await pool([...Array(USERS + HEAVY).keys()], 4, async (i) => {
    const login = i < USERS ? `load-u${String(i).padStart(4, '0')}` : `load-h${String(i - USERS).padStart(2, '0')}`;
    const t0 = performance.now();
    const u = await hs.user(login, PASSWORD, i < USERS ? `Врач ${i}` : `Заведующий ${i - USERS}`);
    reg.ok(performance.now() - t0);
    (i < USERS ? regular : heavy)[i < USERS ? i : i - USERS] = { login, ...u };
  });
  results.users = { registration: reg.summary() };

  // Случаи: каждый обычный пользователь — в ROOMS_PER_USER комнатах по 3 участника; «тяжёлые» — ещё в HEAVY_ROOMS каждый.
  const paced_n = Math.ceil((USERS * ROOMS_PER_USER) / ROOM_SIZE);
  const cases: CaseRoom[] = [...Array(paced_n + BURST).keys()].map((i) => ({
    caseId: `L-${RUN}-${i}`,
    members: [0, 1, 2].map((k) => (i * ROOM_SIZE + k) % USERS),
    heavy: i < HEAVY * HEAVY_ROOMS ? i % HEAVY : null,
  }));
  const roles = ['pathologist', 'lab_tech', 'attending'] as const;
  const snapshot = (c: CaseRoom, version: number, stage: string) => ({
    case_id: c.caseId,
    version,
    title: 'Биопсия, нагрузочный тест',
    patient: { ref: `pseudo:${c.caseId}`, masked: 'Т*** Т. Т.' },
    stage,
    participants: [
      ...c.members.map((m, k) => ({ user: { login: regular[m]!.login }, role: roles[k] })),
      ...(c.heavy !== null ? [{ user: { login: heavy[c.heavy]!.login }, role: 'head' }] : []),
    ],
    updated_at: new Date().toISOString(),
  });

  // A1. Снимки случаев пакетами по 100.
  log(`A1: ${cases.length} снимков случаев пакетами по 100`);
  const ingest = new Recorder();
  const t1 = performance.now();
  for (let i = 0; i < cases.length; i += 100) {
    const r = await integration(cases.slice(i, i + 100).map((c) => cloudEvent(`${c.caseId}:v1`, 'ru.vendor.case.upserted', snapshot(c, 1, 'grossing'))));
    if (r.http === 200 && r.statuses.every((s) => s === 'accepted')) ingest.ok(r.ms);
    else ingest.fail(`http ${r.http}`);
  }
  results.A1_case_snapshots = { batch_of_100: ingest.summary(), events_per_s: Math.round((cases.length / (performance.now() - t1)) * 1000) };

  // A2. Создание чатов с постоянной частотой.
  log(`A2: ${paced_n} чатов с частотой ${CREATE_RATE}/с (~${Math.round(paced_n / CREATE_RATE)} с)`);
  const create = new Recorder();
  const createFirst = new Recorder();
  const createLast = new Recorder();
  const cpuA0 = cpuSeconds(ccsPid);
  let statsA: Record<string, string> = {};
  const createChat = async (c: CaseRoom, rec: Recorder[]) => {
    const t0 = performance.now();
    try {
      const res = await fetch(`${CCS_URL}/integration/v1/cases/${encodeURIComponent(c.caseId)}/chat`, { method: 'PUT', headers: { authorization: `Bearer ${LOAD_TOKEN}` } });
      const json = (await res.json()) as { chat?: { room_id: string } };
      if (res.status !== 201 || !json.chat) throw new Error(`http ${res.status}`);
      c.roomId = json.chat.room_id;
      for (const r of rec) r.ok(performance.now() - t0);
    } catch (e) {
      for (const r of rec) r.fail((e as Error).message);
    }
  };
  const tenth = Math.ceil(paced_n / 10);
  const elapsedA = await paced(paced_n, CREATE_RATE, async (i) => {
    if (i === Math.floor(paced_n / 2)) statsA = dockerStats();
    const rec = [create, ...(i < tenth ? [createFirst] : []), ...(i >= paced_n - tenth ? [createLast] : [])];
    await createChat(cases[i]!, rec);
  });
  results.A2_chat_creation_paced = {
    rate_per_s: CREATE_RATE,
    duration_s: Math.round(elapsedA),
    all: create.summary(),
    first_10pct: createFirst.summary(),
    last_10pct: createLast.summary(),
    ccs_cpu_pct: Math.round(((cpuSeconds(ccsPid) - cpuA0) / elapsedA) * 100),
    containers_mid: statsA,
  };

  // A3. Целевой пик: BURST чатов с частотой BURST_RATE. Если она выше пропускной способности — растёт очередь.
  log(`A3: пик — ${BURST} чатов с частотой ${BURST_RATE}/с`);
  const burst = new Recorder();
  const burstFirst = new Recorder();
  const burstLast = new Recorder();
  const t3 = performance.now();
  let statsB: Record<string, string> = {};
  const offeredS = await paced(BURST, BURST_RATE, async (i) => {
    if (i === Math.floor(BURST / 2)) statsB = dockerStats();
    await createChat(cases[paced_n + i]!, [burst, ...(i < BURST / 10 ? [burstFirst] : []), ...(i >= BURST * 0.9 ? [burstLast] : [])]);
  });
  const burstS = (performance.now() - t3) / 1000;
  results.A3_chat_creation_peak = {
    offered_rate_per_s: BURST_RATE,
    achieved_rooms_per_s: Math.round((BURST / burstS) * 10) / 10,
    offered_s: Math.round(offeredS),
    all: burst.summary(),
    first_10pct: burstFirst.summary(),
    last_10pct: burstLast.summary(),
    containers_mid: statsB,
  };

  // Вход в комнаты (приглашения от сервиса).
  log('вход участников в чаты');
  const joins = new Recorder();
  const toJoin: Array<{ token: string; roomId: string }> = [];
  for (const c of cases) {
    if (!c.roomId) continue;
    for (const m of c.members) toJoin.push({ token: regular[m]!.token, roomId: c.roomId });
    if (c.heavy !== null) toJoin.push({ token: heavy[c.heavy]!.token, roomId: c.roomId });
  }
  await pool(toJoin, 16, async ({ token, roomId }) => {
    const r = await hs.call('POST', `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, token, {});
    if (r.status === 200) joins.ok(r.ms);
    else joins.fail(`http ${r.status}`);
  });
  results.joins = joins.summary();

  // B. События интеграции в существующие чаты.
  const withChat = cases.filter((c) => c.roomId);
  const pick = (i: number) => withChat[(i * 7919) % withChat.length]!;
  log(`B: ${EVENTS} уведомлений и ${EVENTS} обновлений случаев пакетами по 50`);
  for (const [name, make] of [
    ['B1_notifications', (i: number) => cloudEvent(`n-${RUN}-${i}`, 'ru.vendor.notification.posted', { case_id: pick(i).caseId, text: `Препараты готовы (${i})`, category: 'ready' })],
    ['B2_case_updates', (i: number) => cloudEvent(`${withChat[i % withChat.length]!.caseId}:v2`, 'ru.vendor.case.upserted', snapshot(withChat[i % withChat.length]!, 2, 'ihc'))],
  ] as const) {
    const rec = new Recorder();
    const n = name === 'B2_case_updates' ? Math.min(EVENTS, withChat.length) : EVENTS;
    const t0 = performance.now();
    for (let i = 0; i < n; i += 50) {
      const r = await integration([...Array(Math.min(50, n - i)).keys()].map((k) => make(i + k)));
      if (r.http === 200 && r.statuses.every((s) => s === 'accepted')) rec.ok(r.ms);
      else rec.fail(`http ${r.http}: ${[...new Set(r.statuses)].join(',')}`);
    }
    results[name] = { batch_of_50: rec.summary(), events_per_s: Math.round((n / (performance.now() - t0)) * 1000) };
  }

  // D1. Холодный старт по одному (стенд без нагрузки): первая синхронизация с фильтром веб-клиента.
  const coldIdle = new Recorder();
  for (let i = 0; i < 20; i++) {
    const u = regular[(i * 37) % USERS]!;
    const r = await hs.call('GET', `/_matrix/client/v3/sync?filter=${encodeURIComponent(CLIENT_FILTER)}&timeout=0`, u.token);
    if (r.status === 200) coldIdle.ok(r.ms);
    else coldIdle.fail(`http ${r.status}`);
  }

  // C. Клиенты синхронизации и доставка сообщений. Все стартуют разом — это и замер массового переподключения.
  log(`C: ${USERS} клиентов синхронизации (long-poll, фильтр веб-клиента)`);
  const abort = new AbortController();
  const sentAt = new Map<string, { t: number; sender: number; step: number }>();
  const delivery = MSG_RATES.map(() => new Recorder());
  const deliveredCount = MSG_RATES.map(() => 0);
  const coldRegular = new Recorder();
  let ready = 0;
  const loops = regular.map(async (u, idx) => {
    let since: string | undefined;
    while (!abort.signal.aborted) {
      const path = `/_matrix/client/v3/sync?filter=${encodeURIComponent(CLIENT_FILTER)}&timeout=${since ? 30000 : 0}${since ? `&since=${since}` : ''}`;
      try {
        const r = await hs.call<any>('GET', path, u.token, undefined, abort.signal);
        if (r.status !== 200) {
          await sleep(1000);
          continue;
        }
        const now = performance.now();
        if (!since) {
          coldRegular.ok(r.ms);
          ready += 1;
        }
        since = r.json.next_batch;
        for (const room of Object.values<any>(r.json.rooms?.join ?? {})) {
          for (const ev of room.timeline?.events ?? []) {
            const body = ev.content?.body;
            if (typeof body !== 'string' || !body.startsWith('load:')) continue;
            const sent = sentAt.get(body);
            if (!sent || sent.sender === idx) continue;
            delivery[sent.step]!.ok(now - sent.t);
            deliveredCount[sent.step]! += 1;
          }
        }
      } catch {
        if (!abort.signal.aborted) await sleep(500);
      }
    }
  });
  while (ready < USERS) await sleep(200);
  results.D1_cold_start_regular = { rooms_per_user: ROOMS_PER_USER, one_by_one: coldIdle.summary(), all_at_once: coldRegular.summary() };

  const regularRooms = withChat;
  let seq = 0;
  const steps: unknown[] = [];
  for (const [step, rate] of MSG_RATES.entries()) {
    const count = rate * STEP_S;
    log(`C${step + 1}: ${rate} сообщений/с, ${STEP_S} с`);
    const send = new Recorder();
    const cpu0 = cpuSeconds(ccsPid);
    let mid: Record<string, string> = {};
    const elapsed = await paced(count, rate, async (i) => {
      if (i === Math.floor(count / 2)) mid = dockerStats();
      const c = regularRooms[(seq * 104729) % regularRooms.length]!;
      const senderIdx = c.members[seq % ROOM_SIZE]!;
      const body = `load:${RUN}:${seq++}`;
      sentAt.set(body, { t: performance.now(), sender: senderIdx, step });
      const r = await hs
        .call('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(c.roomId!)}/send/m.room.message/${encodeURIComponent(body)}`, regular[senderIdx]!.token, {
          msgtype: 'm.text',
          body,
        })
        .catch(() => ({ status: 0, ms: 0 }));
      if (r.status === 200) send.ok(r.ms);
      else send.fail(`http ${r.status}`);
    });
    await sleep(5000); // досылка хвоста
    const expected = (count - send.errors) * (ROOM_SIZE - 1);
    steps.push({
      rate_per_s: rate,
      duration_s: Math.round(elapsed),
      send: send.summary(),
      delivery: delivery[step]!.summary(),
      delivered_pct: Math.round((deliveredCount[step]! / expected) * 1000) / 10,
      ccs_cpu_pct: Math.round(((cpuSeconds(ccsPid) - cpu0) / (elapsed + 5)) * 100),
      containers_mid: mid,
    });
  }
  results.C_message_delivery = { clients: USERS, steps };
  abort.abort();
  await Promise.allSettled(loops);

  // D2. Холодный старт пользователя с HEAVY_ROOMS комнатами: обычная синхронизация и Simplified Sliding Sync.
  log(`D2: холодный старт «тяжёлых» пользователей (${HEAVY_ROOMS} комнат)`);
  const coldHeavy = new Recorder();
  const sizes: number[] = [];
  const sss = new Recorder();
  let sssStatus = 0;
  for (let rep = 0; rep < 3; rep++) {
    for (const u of heavy) {
      const r = await hs.call<any>('GET', `/_matrix/client/v3/sync?filter=${encodeURIComponent(CLIENT_FILTER)}&timeout=0`, u.token);
      if (r.status === 200) {
        coldHeavy.ok(r.ms);
        sizes.push(Object.keys(r.json.rooms?.join ?? {}).length);
      } else coldHeavy.fail(`http ${r.status}`);
      const s = await hs.call<any>('POST', '/_matrix/client/unstable/org.matrix.simplified_msc3575/sync?timeout=0', u.token, {
        lists: { all: { ranges: [[0, 19]], timeline_limit: 1, required_state: [['m.room.name', ''], ['ru.vendor.case.context', ''], ['ru.vendor.critical.status', '*']] } },
      });
      sssStatus = s.status;
      if (s.status === 200) sss.ok(s.ms);
      else sss.fail(`http ${s.status}`);
    }
  }
  results.D2_cold_start_heavy = {
    rooms_per_user: Math.max(...sizes),
    initial_sync: coldHeavy.summary(),
    sliding_sync_first_20: sssStatus === 200 ? sss.summary() : { unsupported: sssStatus },
  };

  results.database = {
    synapse_db: psql("select pg_size_pretty(pg_database_size('synapse'))"),
    rooms: psql('select count(*) from rooms'),
    events: psql('select count(*) from events'),
    users: psql('select count(*) from users'),
  };
  results.finished_at = new Date().toISOString();
  ccs.kill('SIGTERM');
  mkdirSync(resolve(OUT, '..'), { recursive: true });
  writeFileSync(OUT, JSON.stringify(results, null, 2));
  log(`готово: ${OUT}`);
  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
