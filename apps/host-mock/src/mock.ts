/**
 * Песочница системы-источника (РИС/ЛИС): эталон того, что делает сторона РИС/ЛИС в интеграции с «Консилиумом».
 *
 * 1. Отправляет события в сервис контекста: `case.upserted`, `request.status.changed`, `notification.posted`, `critical.raised`,
 *    `consilium.upserted` (как МИС: консилиум с повесткой).
 * 2. Отвечает на обратные вызовы (уровень 2): снимок случая, проверка прав, заявка из чата, раскрытие пациента,
 *    события критических находок (журнал: отправлена, эскалация, подтверждена), протокол консилиума («МИС» на подпись).
 * 3. Демо-агент ИИ-«Секретаря» (`/demo/secretary`): вместо распознавания речи отдаёт сценарий реплик — чтобы проверить
 *    консилиум и протоколы без профиля ai.
 *
 * Контракт — docs/10-integration-api.md. Данные — fixtures/cases.json (вымышленные).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CaseRole, type RequestStep } from '@konsilium/protocol';
import { renderRisDemo } from './demo.ts';
import { renderLisDemo } from './lis-demo.ts';
import {
  AccessCheckRequest,
  CaseSnapshot,
  ConsiliumProtocolRequest,
  ConsiliumUpserted,
  CreateRequestRequest,
  CriticalFindingEvent,
  CriticalRaised,
  IntegrationEventType,
  PatientRevealRequest,
  PatientRevealResponse,
  type CaseSnapshotInput,
  type CloudEvent,
  type ConsiliumProtocolResponse,
  type CreateRequestResponse,
  type EventsResponse,
  type UserRef,
} from '@konsilium/protocol/integration';

const MockCase = z.object({
  push_on_start: z.boolean().default(true),
  snapshot: CaseSnapshot,
  host_only: z
    .object({
      access: z.array(z.object({ login: z.string(), role: CaseRole })).default([]),
      patient: PatientRevealResponse.optional(),
    })
    .default({}),
});
type MockCase = z.infer<typeof MockCase>;
/** Консилиум «МИС»: номер и дата подставляются при отправке — на сегодня, в `time` по Москве. */
const MockConsilium = z.object({
  consilium_id: z.string(),
  title: z.string(),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  form: z.enum(['remote', 'in_person', 'mixed']).default('mixed'),
  members: z.array(z.unknown()),
  agenda: z.array(z.unknown()),
});
type MockConsilium = z.infer<typeof MockConsilium>;
const Fixture = z.object({ connectors: z.record(z.object({ cases: z.array(MockCase), consilia: z.array(MockConsilium).default([]) })) });

export const defaultFixture = () => JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/cases.json'), 'utf8')) as unknown;

export interface MockConnector {
  id: string;
  /** Токен, с которым песочница отправляет события в сервис контекста. */
  token: string;
  /** Токен, который сервис контекста предъявляет в обратных вызовах. Нет — подключение уровня 1. */
  callbackToken?: string;
}

export type Deliver = (connector: MockConnector, events: CloudEvent[]) => Promise<{ status: number; body: unknown }>;

export interface HostMockOptions {
  connectors: MockConnector[];
  /** Куда слать события. По умолчанию — HTTP POST на `${ccsUrl}/integration/v1/events`. */
  ccsUrl?: string;
  deliver?: Deliver;
  /** Пауза между шагами заявки (мс). 0 — шаги не продвигаются сами. */
  stepMs?: number;
  fixture?: unknown;
  /** Адрес веб-клиента «Консилиума» для демо-страницы РИС (SDK встраивания). */
  chatUrl?: string;
  /** Имя сервера Matrix — для Matrix ID говорящих в демо-агенте «Секретаря». */
  serverName?: string;
  /** Токен, с которым сервис контекста вызывает агента «Секретаря» (SECRETARY_TOKEN). Не задан — демо-агент выключен. */
  secretaryToken?: string;
  logger?: boolean;
}

/** Реплика сценария демо-агента «Секретаря». `at` — когда сказана (ISO); без него реплики делят время сессии поровну. */
export const ScriptLine = z.object({ login: z.string(), name: z.string(), text: z.string().min(1), at: z.string().datetime({ offset: true }).optional() });
export type ScriptLine = z.infer<typeof ScriptLine>;

/** Сценарий по умолчанию — к консилиуму песочницы (три случая повестки), по три реплики на случай. */
const DEMO_SCRIPT: ScriptLine[] = [
  { login: 'kolesnikov', name: 'Колесников Д. А.', text: 'Пациентка 54 лет, опухоль левой молочной железы около 2,8 сантиметра, по УЗИ подозрение на поражение одного подмышечного лимфоузла.' },
  { login: 'smirnova', name: 'Смирнова А. В.', text: 'Инвазивная карцинома неспецифического типа, G2. HER2 три плюс, Ki-67 около тридцати пяти процентов.' },
  { login: 'belova', name: 'Белова Л. Р.', text: 'Решение: биопсия и маркировка лимфоузла, затем неоадъювантная терапия с анти-HER2 препаратами.' },
  { login: 'orlov', name: 'Орлов К. М.', text: 'На КТ органов брюшной полости очаг в печени девятнадцать миллиметров, накапливает контраст по периферии.' },
  { login: 'gusev', name: 'Гусев П. Р.', text: 'Предлагаю МРТ печени с гепатоспецифическим контрастом до решения о тактике.' },
  { login: 'belova', name: 'Белова Л. Р.', text: 'Решение: МРТ печени с контрастом, повторное обсуждение после исследования.' },
  { login: 'smirnova', name: 'Смирнова А. В.', text: 'Аденокарцинома толстой кишки, в краях резекции опухоли нет, в лимфоузлах метастазы в двух из четырнадцати.' },
  { login: 'kolesnikov', name: 'Колесников Д. А.', text: 'Стадия три, показана адъювантная химиотерапия.' },
  { login: 'belova', name: 'Белова Л. Р.', text: 'Решение: адъювантная химиотерапия, контроль через три месяца.' },
];

interface MockRequest {
  connector: string;
  caseId: string;
  externalId: string;
  steps: RequestStep[];
  response: CreateRequestResponse;
}

const requestPrefix = { ihc: 'ИГХ', recut: 'ДР', review: 'ПС', second_opinion: 'ВМ', service: 'СД' } as const;

const loginOf = (u: UserRef) => (u.login ?? u.mxid?.slice(1, u.mxid.indexOf(':')) ?? '').toLowerCase();
const sameId = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();

export function createHostMock(opts: HostMockOptions) {
  const fixture = Fixture.parse(opts.fixture ?? defaultFixture());
  const cases = new Map<string, MockCase[]>(Object.entries(fixture.connectors).map(([id, c]) => [id, c.cases]));
  const requests = new Map<string, MockRequest>(); // Idempotency-Key → заявка
  const audit: Array<{ connector: string; caseId: string; login: string; action: string; at: string }> = [];
  const consilia = new Map<string, MockConsilium[]>(Object.entries(fixture.connectors).map(([id, c]) => [id, c.consilia]));
  /** Протоколы консилиумов, принятые в «МИС» (ключ идемпотентности → запрос и ответ). */
  const protocols = new Map<string, { connector: string; request: ConsiliumProtocolRequest; response: ConsiliumProtocolResponse }>();
  /** Сессии демо-агента «Секретаря» и сценарий для ближайшей остановленной сессии. */
  const agentSessions = new Map<string, { callbackUrl: string; callbackToken: string; startedAt: number }>();
  let nextScript: ScriptLine[] | null = null;
  const startedAt = Date.now().toString(36);
  /** Журнал критических находок «системы-источника»: что пришло обратными вызовами (ключ идемпотентности → событие). */
  const criticalEvents = new Map<string, CriticalFindingEvent & { connector: string }>();
  const timers = new Set<NodeJS.Timeout>();
  // Номера заявок не повторяются между перезапусками песочницы: сервис контекста помнит обработанные события 7 дней,
  // и статусы «новой» заявки с прежним номером он отбросил бы как повтор.
  let requestSeq = 10_000 + (Math.floor(Date.now() / 1000) % 90_000) * 10;

  const deliver: Deliver =
    opts.deliver ??
    (async (connector, events) => {
      const res = await fetch(`${opts.ccsUrl ?? 'http://localhost:8080'}/integration/v1/events`, {
        method: 'POST',
        headers: { authorization: `Bearer ${connector.token}`, 'content-type': 'application/cloudevents-batch+json' },
        body: JSON.stringify(events),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    });

  const connector = (id: string) => {
    const c = opts.connectors.find((x) => x.id === id);
    if (!c) throw new Error(`Нет подключения ${id}`);
    return c;
  };

  const findCase = (connectorId: string, caseId: string) => cases.get(connectorId)?.find((c) => sameId(c.snapshot.case_id, caseId)) ?? null;

  /** Права в «системе-источнике»: участники случая и те, кому доступ дан отдельно. */
  const accessOf = (c: MockCase, login: string): { allowed: boolean; role?: z.infer<typeof CaseRole> } => {
    const p = c.snapshot.participants.find((x) => loginOf(x.user) === login);
    if (p) return { allowed: true, role: p.role };
    const extra = c.host_only.access.find((x) => x.login === login);
    return extra ? { allowed: true, role: extra.role } : { allowed: false };
  };

  const event = (connectorId: string, type: string, id: string, data: unknown): CloudEvent => ({
    specversion: '1.0',
    id,
    source: connectorId,
    type,
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    data,
  });

  async function push(connectorId: string, events: CloudEvent[]) {
    const r = await deliver(connector(connectorId), events);
    return r as { status: number; body: EventsResponse };
  }

  /** Отправить снимки случаев (при старте — все, кроме помеченных `push_on_start: false`). */
  async function pushCases(filter: (c: MockCase) => boolean = (c) => c.push_on_start) {
    const out: Record<string, { status: number; body: EventsResponse }> = {};
    for (const c of opts.connectors) {
      const list = (cases.get(c.id) ?? []).filter(filter);
      if (list.length) {
        out[c.id] = await push(
          c.id,
          list.map((x) => event(c.id, IntegrationEventType.CaseUpserted, `${c.id}:${x.snapshot.case_id}:v${x.snapshot.version}`, x.snapshot)),
        );
      }
    }
    return out;
  }

  /** Данные консилиума на сегодня: номер — с датой, начало — в `time` по Москве. */
  function consiliumData(c: MockConsilium, day = new Date()) {
    const msk = new Date(day.getTime() + 3 * 3600_000);
    const ymd = msk.toISOString().slice(0, 10);
    const label = msk.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });
    return ConsiliumUpserted.parse({
      consilium_id: `${c.consilium_id}-${ymd.replaceAll('-', '')}`,
      version: 1,
      title: `${c.title} · ${label}`,
      scheduled_at: `${ymd}T${c.time}:00+03:00`,
      form: c.form,
      members: c.members,
      agenda: c.agenda,
      updated_at: new Date().toISOString(),
    });
  }

  /** Отправить консилиумы «МИС» (после снимков случаев: случаи повестки сервису уже известны). */
  async function pushConsilia() {
    const out: Record<string, { status: number; body: EventsResponse }> = {};
    for (const c of opts.connectors) {
      const list = (consilia.get(c.id) ?? []).map((x) => consiliumData(x));
      // В ID события — метка запуска песочницы: сервис контекста помнит обработанные события 7 дней, а комнату консилиума
      // создаёт по событию. Перезапуск песочницы досылает консилиум (та же версия — без изменений, новый сервис — новая комната).
      if (list.length) out[c.id] = await push(c.id, list.map((x) => event(c.id, IntegrationEventType.ConsiliumUpserted, `${c.id}:consilium:${x.consilium_id}:v${x.version}:${startedAt}`, x)));
    }
    return out;
  }

  /** Изменить случай в «системе-источнике» и отправить новый снимок (версия растёт). */
  async function updateCase(connectorId: string, caseId: string, patch: Partial<CaseSnapshotInput>) {
    const c = findCase(connectorId, caseId);
    if (!c) throw new Error(`Нет случая ${caseId}`);
    c.snapshot = CaseSnapshot.parse({ ...c.snapshot, ...patch, version: c.snapshot.version + 1, updated_at: new Date().toISOString() });
    return push(connectorId, [event(connectorId, IntegrationEventType.CaseUpserted, `${connectorId}:${c.snapshot.case_id}:v${c.snapshot.version}`, c.snapshot)]);
  }

  async function notify(connectorId: string, caseId: string, text: string, extra: Record<string, unknown> = {}) {
    return push(connectorId, [event(connectorId, IntegrationEventType.NotificationPosted, randomUUID(), { case_id: caseId, text, ...extra })]);
  }

  /** Критическая находка из «системы-источника» (например, рентгенолог отметил её в РИС). */
  async function raiseCritical(connectorId: string, data: z.input<typeof CriticalRaised>) {
    return push(connectorId, [event(connectorId, IntegrationEventType.CriticalRaised, `crit:${data.finding_id}`, data)]);
  }

  async function setRequestStatus(connectorId: string, externalId: string, status: RequestStep, note?: string) {
    const r = [...requests.values()].find((x) => x.connector === connectorId && x.externalId === externalId);
    if (!r) throw new Error(`Нет заявки ${externalId}`);
    return push(connectorId, [
      event(connectorId, IntegrationEventType.RequestStatusChanged, `rs:${externalId}:${status}`, {
        case_id: r.caseId,
        external_id: externalId,
        status,
        ...(note ? { note } : {}),
        changed_at: new Date().toISOString(),
      }),
    ]);
  }

  // ── Обратные вызовы ──────────────────────────────────────────────────────────

  const app = Fastify({ logger: opts.logger ?? false });

  function authorize(req: FastifyRequest, reply: FastifyReply): MockConnector | null {
    const { connector: id } = req.params as { connector: string };
    const c = opts.connectors.find((x) => x.id === id && x.callbackToken);
    if (!c) {
      reply.code(404).send({ title: 'Подключение не поддерживает обратные вызовы', status: 404 });
      return null;
    }
    if (req.headers.authorization !== `Bearer ${c.callbackToken}`) {
      reply.code(401).type('application/problem+json').send({ title: 'Неверный токен', status: 401 });
      return null;
    }
    return c;
  }

  function parse<T>(schema: z.ZodType<T>, req: FastifyRequest, reply: FastifyReply): T | null {
    const r = schema.safeParse(req.body);
    if (r.success) return r.data;
    reply.code(400).type('application/problem+json').send({ title: 'Запрос не по контракту', status: 400, detail: r.error.message });
    return null;
  }

  app.get('/healthz', async () => ({ ok: true }));

  // Демо-страница РИС со встроенным чатом (не обратный вызов: без токена, только вымышленные данные).
  app.get('/demo/ris', async (_req, reply) => {
    const studies = (cases.get('ris') ?? []).map((c) => ({ snapshot: c.snapshot, patientName: c.host_only.patient?.display_name ?? c.snapshot.patient.masked }));
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store');
    return renderRisDemo((opts.chatUrl ?? 'http://localhost:5173').replace(/\/$/, ''), studies);
  });

  // Демо-страница ЛИС: форма случая с плавающим чатом и «В чат» у стекла (?case=Г26-04530 — другой случай).
  app.get('/demo/lis', async (req, reply) => {
    const selected = (req.query as { case?: string }).case;
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store');
    return renderLisDemo((opts.chatUrl ?? 'http://localhost:5173').replace(/\/$/, ''), (cases.get('lis') ?? []).map((c) => c.snapshot), selected);
  });

  app.get('/:connector/cases/:caseId', async (req, reply) => {
    const c = authorize(req, reply);
    if (!c) return reply;
    const found = findCase(c.id, (req.params as { caseId: string }).caseId);
    return found ? found.snapshot : reply.code(404).type('application/problem+json').send({ title: 'Случай не найден', status: 404 });
  });

  app.post('/:connector/access-checks', async (req, reply) => {
    const c = authorize(req, reply);
    if (!c) return reply;
    const body = parse(AccessCheckRequest, req, reply);
    if (!body) return reply;
    const found = findCase(c.id, body.case_id);
    return found ? accessOf(found, loginOf(body.user)) : { allowed: false };
  });

  app.post('/:connector/requests', async (req, reply) => {
    const c = authorize(req, reply);
    if (!c) return reply;
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !key) return reply.code(400).send({ title: 'Нужен заголовок Idempotency-Key', status: 400 });
    const body = parse(CreateRequestRequest, req, reply);
    if (!body) return reply;
    const existing = requests.get(key);
    if (existing) return existing.response; // повтор — та же заявка

    const found = findCase(c.id, body.case_id);
    if (!found) return reply.code(404).send({ title: 'Случай не найден', status: 404 });
    if (!accessOf(found, loginOf(body.requested_by)).allowed) return reply.code(403).send({ title: 'Нет прав на заявку', status: 403 });

    requestSeq += 1;
    const externalId = `${requestPrefix[body.request.kind]}-${requestSeq}`;
    const steps: RequestStep[] = body.request.kind === 'ihc' ? ['accepted', 'staining', 'scanning', 'done'] : ['accepted', 'done'];
    const response: CreateRequestResponse = { external_id: externalId, status: 'accepted', steps };
    requests.set(key, { connector: c.id, caseId: found.snapshot.case_id, externalId, steps, response });

    // «Лаборатория работает»: следующие шаги приходят событиями request.status.changed.
    if (opts.stepMs) {
      steps.slice(1).forEach((step, i) => {
        const t = setTimeout(() => {
          timers.delete(t);
          setRequestStatus(c.id, externalId, step).catch((err) => app.log.error({ err }, 'Не удалось отправить статус'));
        }, opts.stepMs! * (i + 1));
        timers.add(t);
      });
    }
    return reply.code(201).send(response);
  });

  app.post('/:connector/patient-reveals', async (req, reply) => {
    const c = authorize(req, reply);
    if (!c) return reply;
    const body = parse(PatientRevealRequest, req, reply);
    if (!body) return reply;
    const found = findCase(c.id, body.case_id);
    if (!found?.host_only.patient) return reply.code(404).send({ title: 'Случай не найден', status: 404 });
    const login = loginOf(body.user);
    if (!accessOf(found, login).allowed) return reply.code(403).send({ title: 'Нет доступа к данным пациента', status: 403 });
    // Журнал раскрытия ведёт система-источник: она владеет данными пациента.
    audit.push({ connector: c.id, caseId: found.snapshot.case_id, login, action: 'patient_reveal', at: new Date().toISOString() });
    return found.host_only.patient;
  });

  app.post('/:connector/critical-findings/events', async (req, reply) => {
    const c = authorize(req, reply);
    if (!c) return reply;
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !key) return reply.code(400).send({ title: 'Нужен заголовок Idempotency-Key', status: 400 });
    const body = parse(CriticalFindingEvent, req, reply);
    if (!body) return reply;
    if (!criticalEvents.has(key)) {
      criticalEvents.set(key, { ...(body as CriticalFindingEvent), connector: c.id });
      app.log.info({ type: body.type, finding: body.finding_id, case: body.case_id }, 'Критическая находка: событие в журнал');
    }
    return reply.code(202).send();
  });

  // «МИС»: протокол консилиума по случаю — заводим на подпись участникам. Повтор с тем же ключом — тот же ответ.
  app.post('/:connector/consilium-protocols', async (req, reply) => {
    const c = authorize(req, reply);
    if (!c) return reply;
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !key) return reply.code(400).send({ title: 'Нужен заголовок Idempotency-Key', status: 400 });
    const body = parse(ConsiliumProtocolRequest, req, reply);
    if (!body) return reply;
    let saved = protocols.get(key);
    if (!saved) {
      const response: ConsiliumProtocolResponse = { protocol_id: `ПК-${++requestSeq}`, status: 'awaiting_signatures', signers: body.participants.length };
      saved = { connector: c.id, request: body, response };
      protocols.set(key, saved);
      app.log.info({ consilium: body.consilium_id, case: body.case.case_id, protocol: response.protocol_id }, 'Протокол консилиума заведён на подпись');
    }
    return reply.code(201).send(saved.response);
  });

  // ── Демо-агент ИИ-«Секретаря» ────────────────────────────────────────────────
  // Тот же API, что у apps/secretary, но без LiveKit и распознавания: по остановке отдаёт сценарий реплик.

  /** Демо-агента вызывает только сервис контекста — с тем же токеном, что настоящего агента. */
  function agentAuthorized(req: FastifyRequest, reply: FastifyReply): boolean {
    if (opts.secretaryToken && req.headers.authorization === `Bearer ${opts.secretaryToken}`) return true;
    reply.code(opts.secretaryToken ? 401 : 404).send({ error: opts.secretaryToken ? 'Неверный токен агента' : 'Демо-агент выключен' });
    return false;
  }

  app.post('/demo/secretary/sessions', async (req, reply) => {
    if (!agentAuthorized(req, reply)) return reply;
    const body = z.object({ session_id: z.string(), callback_url: z.string().url(), callback_token: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'Нет session_id или callback_url' });
    agentSessions.set(body.data.session_id, { callbackUrl: body.data.callback_url, callbackToken: body.data.callback_token, startedAt: Date.now() });
    return reply.code(201).send({ ok: true });
  });

  app.delete('/demo/secretary/sessions/:id', async (req, reply) => {
    if (!agentAuthorized(req, reply)) return reply;
    const { id } = req.params as { id: string };
    const s = agentSessions.get(id);
    if (!s) return reply.code(404).send({ error: 'Нет сессии' });
    agentSessions.delete(id);
    const script = nextScript ?? DEMO_SCRIPT;
    nextScript = null;
    const endedAt = Date.now();
    const span = Math.max(endedAt - s.startedAt, 1000);
    const server = opts.serverName ?? 'konsilium.test';
    const segments = script.map((l, i) => {
      // Без времени — делим сессию поровну: реплика i в середине своего отрезка.
      const start = l.at ? Math.max(0, Date.parse(l.at) - s.startedAt) : Math.round(((i + 0.25) * span) / script.length);
      const end = l.at ? start + 2000 : Math.round(((i + 0.75) * span) / script.length);
      return { i, speaker: `@${l.login}:${server}`, name: l.name, start_ms: start, end_ms: Math.max(end, start + 1), text: l.text };
    });
    const result = {
      session_id: id,
      started_at: new Date(s.startedAt).toISOString(),
      ended_at: new Date(Math.max(endedAt, s.startedAt + Math.max(...segments.map((x) => x.end_ms)))).toISOString(),
      participants: [...new Map(segments.map((x) => [x.speaker, { identity: x.speaker, name: x.name }])).values()],
      segments,
      asr: { engine: 'демо-агент песочницы' },
    };
    // Результат — после ответа на DELETE, как у настоящего агента.
    const t = setTimeout(() => {
      timers.delete(t);
      fetch(s.callbackUrl, { method: 'POST', headers: { authorization: `Bearer ${s.callbackToken}`, 'content-type': 'application/json' }, body: JSON.stringify(result) })
        .then((r) => app.log.info({ status: r.status, segments: segments.length }, 'Демо-«Секретарь»: стенограмма отправлена'))
        .catch((err) => app.log.warn({ err }, 'Демо-«Секретарь»: сервис контекста недоступен'));
    }, 100);
    timers.add(t);
    return reply.code(202).send({ ok: true });
  });

  /**
   * Назначить консилиум песочницы ещё раз — с другим номером и, при желании, названием (повторный показ, сквозные тесты).
   * Как настоящая МИС — с токеном подключения.
   */
  app.post('/demo/consilium', async (req, reply) => {
    const body = z.object({ connector: z.string().default('lis'), title: z.string().trim().min(1).max(200).optional() }).safeParse(req.body ?? {});
    const template = body.success ? consilia.get(body.data.connector)?.[0] : undefined;
    if (!body.success || !template) return reply.code(404).send({ error: 'Нет консилиума в данных песочницы' });
    if (req.headers.authorization !== `Bearer ${connector(body.data.connector).token}`) return reply.code(401).send({ error: 'Нужен токен подключения' });
    const base = consiliumData(template);
    const data = { ...base, consilium_id: `${base.consilium_id}-${Date.now().toString(36)}`, ...(body.data.title ? { title: body.data.title } : {}) };
    const r = await push(body.data.connector, [event(body.data.connector, IntegrationEventType.ConsiliumUpserted, `${body.data.connector}:consilium:${data.consilium_id}:v1`, data)]);
    return reply.code(r.status === 200 ? 201 : 502).send({ consilium_id: data.consilium_id, title: data.title, results: r.body?.results });
  });

  /** Сценарий для ближайшей остановленной сессии (сквозные тесты задают реплики со временем). */
  app.post('/demo/secretary/script', async (req, reply) => {
    if (!agentAuthorized(req, reply)) return reply;
    const body = z.object({ lines: z.array(ScriptLine).min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.message });
    nextScript = body.data.lines;
    return { ok: true };
  });

  app.addHook('onClose', async () => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
  });

  return { app, cases, requests, audit, criticalEvents, protocols, consilia, push, pushCases, pushConsilia, consiliumData, updateCase, notify, raiseCritical, setRequestStatus };
}

export type HostMock = ReturnType<typeof createHostMock>;
