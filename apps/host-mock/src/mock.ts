/**
 * Песочница системы-источника (РИС/ЛИС): эталон того, что делает сторона РИС/ЛИС в интеграции с «Консилиумом».
 *
 * 1. Отправляет события в сервис контекста: `case.upserted`, `request.status.changed`, `notification.posted`, `critical.raised`.
 * 2. Отвечает на обратные вызовы (уровень 2): снимок случая, проверка прав, заявка из чата, раскрытие пациента,
 *    события критических находок (журнал: отправлена, эскалация, подтверждена).
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
  CreateRequestRequest,
  CriticalFindingEvent,
  CriticalRaised,
  IntegrationEventType,
  PatientRevealRequest,
  PatientRevealResponse,
  type CaseSnapshotInput,
  type CloudEvent,
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
const Fixture = z.object({ connectors: z.record(z.object({ cases: z.array(MockCase) })) });

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
  logger?: boolean;
}

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

  app.addHook('onClose', async () => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
  });

  return { app, cases, requests, audit, criticalEvents, push, pushCases, updateCase, notify, raiseCritical, setRequestStatus };
}

export type HostMock = ReturnType<typeof createHostMock>;
