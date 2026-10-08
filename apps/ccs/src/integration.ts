import { createHash } from 'node:crypto';
import { EventType, NotificationField, type RequestStatusContent } from '@konsilium/protocol';
import {
  CloudEvent,
  IntegrationEventType,
  eventDataSchemas,
  type CaseSnapshot,
  type CriticalRaised,
  type EventResult,
  type NotificationPosted,
  type RequestStatusChanged,
} from '@konsilium/protocol/integration';
import type { ZodError } from 'zod';
import type { CaseDirectory, CaseRegistry } from './cases.ts';
import type { CaseRoomService } from './caseRooms.ts';
import type { Connector } from './connectors.ts';
import type { CriticalService } from './critical.ts';
import type { Logger } from './events.ts';
import { HostError } from './host.ts';
import { MatrixError, type MatrixApi } from './matrix.ts';
import type { RequestStore } from './requests.ts';

type Outcome = Omit<EventResult, 'id'>;

/** Идентификатор транзакции Matrix из события интеграции: повтор того же события не создаст второе сообщение. */
const txnId = (prefix: string, connector: string, eventId: string) =>
  `${prefix}.${createHash('sha256').update(`${connector}\n${eventId}`).digest('hex').slice(0, 32)}`;

const describeIssues = (e: ZodError) => e.issues.map((i) => `${i.path.join('.') || '(корень)'}: ${i.message}`).join('; ');

/** Временная ошибка — событие стоит повторить: сервер сообщений или система-источник недоступны. */
export function isTransient(e: unknown): boolean {
  if (e instanceof MatrixError) return e.status >= 500 || e.status === 429;
  if (e instanceof HostError) return e.transient;
  return true;
}

/** Обработанные события (подключение + id) — для идемпотентности. Контракт: помним не меньше 7 дней. */
export interface ProcessedEvents {
  has(connector: string, eventId: string): Promise<boolean>;
  add(connector: string, eventId: string, status: EventResult['status']): Promise<void>;
}

export class InMemoryProcessedEvents implements ProcessedEvents {
  private readonly items = new Set<string>();
  async has(connector: string, eventId: string) {
    return this.items.has(`${connector}\n${eventId}`);
  }
  async add(connector: string, eventId: string) {
    this.items.add(`${connector}\n${eventId}`);
    if (this.items.size > 50_000) {
      const oldest = this.items.values().next().value;
      if (oldest !== undefined) this.items.delete(oldest);
    }
  }
}

/** Сколько случаев пакета обрабатывать одновременно. */
const CASE_CONCURRENCY = 8;

/** Ключ порядка: события одного случая — строго по очереди, разных случаев — параллельно. */
function orderKey(item: unknown, index: number): string {
  const caseId = (item as { data?: { case_id?: unknown } } | null)?.data?.case_id;
  return typeof caseId === 'string' && caseId.trim() ? caseId.trim().toUpperCase() : `#${index}`;
}

/**
 * Приём событий от РИС, ЛИС и ТМК: `POST /integration/v1/events`.
 * Каждое событие обрабатывается отдельно и получает свой итог (в порядке пакета). События одного случая применяются
 * по порядку, разных случаев — параллельно: так пакет из сотни событий не ждёт каждое по очереди.
 * Контракт — docs/10-integration-api.md.
 */
export class IntegrationService {
  constructor(
    private readonly deps: {
      matrix: MatrixApi;
      directory: CaseDirectory;
      registry: CaseRegistry;
      caseRooms: CaseRoomService;
      requests: RequestStore;
      processed: ProcessedEvents;
      critical: CriticalService;
      log: Logger;
    },
  ) {}

  async process(connector: Connector, items: unknown[]): Promise<EventResult[]> {
    const results = new Array<EventResult>(items.length);
    const groups = new Map<string, number[]>();
    items.forEach((item, i) => {
      const k = orderKey(item, i);
      const g = groups.get(k);
      if (g) g.push(i);
      else groups.set(k, [i]);
    });
    const queue = [...groups.values()];
    const worker = async () => {
      for (let g = queue.shift(); g; g = queue.shift()) for (const i of g) results[i] = await this.processOne(connector, items[i]);
    };
    await Promise.all(Array.from({ length: Math.min(CASE_CONCURRENCY, queue.length) }, worker));
    return results;
  }

  private async processOne(connector: Connector, item: unknown): Promise<EventResult> {
    const rawId = (item as { id?: unknown } | null)?.id;
    const id = typeof rawId === 'string' ? rawId : '';
    const envelope = CloudEvent.safeParse(item);
    if (!envelope.success) return { id, status: 'rejected', detail: describeIssues(envelope.error) };
    const event = envelope.data;
    if (event.source !== connector.id) {
      return { id, status: 'rejected', detail: `source «${event.source}» не совпадает с подключением «${connector.id}»` };
    }
    if (await this.deps.processed.has(connector.id, event.id)) return { id, status: 'duplicate' };

    const schema = eventDataSchemas[event.type as IntegrationEventType];
    if (!schema) return { id, status: 'rejected', detail: `Неизвестный тип события: ${event.type}` };
    const data = schema.safeParse(event.data);
    if (!data.success) return { id, status: 'rejected', detail: describeIssues(data.error) };

    try {
      let outcome: Outcome;
      switch (event.type) {
        case IntegrationEventType.CaseUpserted:
          outcome = await this.caseUpserted(connector, data.data as CaseSnapshot);
          break;
        case IntegrationEventType.RequestStatusChanged:
          outcome = await this.requestStatusChanged(connector, data.data as RequestStatusChanged, event.id);
          break;
        case IntegrationEventType.CriticalRaised:
          outcome = await this.deps.critical.onRaised(connector, data.data as CriticalRaised, event.id);
          break;
        default:
          outcome = await this.notificationPosted(connector, data.data as NotificationPosted, event.id);
      }
      await this.deps.processed.add(connector.id, event.id, outcome.status);
      return { id, ...outcome };
    } catch (e) {
      if (isTransient(e)) {
        this.deps.log.warn({ err: e, connector: connector.id, eventId: event.id }, 'Временная ошибка обработки события');
        return { id, status: 'failed', detail: 'Временная ошибка; повторите событие позже' };
      }
      this.deps.log.error({ err: e, connector: connector.id, eventId: event.id }, 'Событие отклонено');
      return { id, status: 'rejected', detail: (e as Error).message };
    }
  }


  /** Снимок случая: обновить реестр; если чат уже есть — привести комнату к снимку. Чат не создаётся. */
  private async caseUpserted(connector: Connector, snapshot: CaseSnapshot): Promise<Outcome> {
    const { hostCase, warnings } = this.deps.directory.toHostCase(connector, snapshot);
    const { status } = await this.deps.registry.apply(hostCase);
    if (status === 'stale') return { status: 'stale', detail: 'Версия случая меньше уже полученной' };
    const roomId = await this.deps.caseRooms.roomFor(hostCase.ref);
    if (roomId) {
      const sync = await this.deps.caseRooms.sync(roomId, hostCase);
      warnings.push(...sync.warnings);
    }
    return { status: 'accepted', ...(warnings.length ? { warnings } : {}) };
  }

  /** Статус заявки, созданной из чата, — новым событием `ru.vendor.request.status` со ссылкой на заявку. */
  private async requestStatusChanged(connector: Connector, data: RequestStatusChanged, eventId: string): Promise<Outcome> {
    const tracked = await this.deps.requests.find(connector.id, data.external_id);
    if (!tracked) return { status: 'ignored', detail: 'Заявка с таким номером не создавалась из чата' };
    if (tracked.caseId.toUpperCase() !== data.case_id.toUpperCase()) {
      return { status: 'rejected', detail: `Заявка ${data.external_id} относится к другому случаю` };
    }
    if (data.steps) {
      tracked.steps = data.steps;
      await this.deps.requests.updateSteps(connector.id, data.external_id, data.steps);
    }
    const content: RequestStatusContent = {
      'm.relates_to': { rel_type: 'm.reference', event_id: tracked.eventId },
      external_id: data.external_id,
      status: data.status,
      steps: tracked.steps,
      source: connector.kind,
      ...(data.note ? { note: data.note } : {}),
    };
    await this.deps.matrix.sendEvent(tracked.roomId, EventType.RequestStatus, content as unknown as Record<string, unknown>, txnId('rs', connector.id, eventId));
    return { status: 'accepted' };
  }

  /** Служебное уведомление в чат случая. Без чата — игнорируется, если не задан `ensure_chat`. */
  private async notificationPosted(connector: Connector, data: NotificationPosted, eventId: string): Promise<Outcome> {
    const ref = { connector: connector.id, caseId: data.case_id };
    let roomId = await this.deps.caseRooms.roomFor(ref);
    if (!roomId) {
      if (!data.ensure_chat) return { status: 'ignored', detail: 'Чата по случаю нет, а ensure_chat не задан' };
      const hostCase = await this.deps.directory.find(ref);
      if (!hostCase) return { status: 'rejected', detail: 'Случай неизвестен: сначала отправьте case.upserted' };
      roomId = (await this.deps.caseRooms.getOrCreate(hostCase)).roomId;
    }
    const body = [data.text, ...data.links.map((l) => `${l.label}: ${l.url}`)].join('\n');
    await this.deps.matrix.sendEvent(
      roomId,
      'm.room.message',
      { msgtype: 'm.notice', body, [NotificationField]: { category: data.category, links: data.links, connector: connector.id } },
      txnId('n', connector.id, eventId),
    );
    return { status: 'accepted' };
  }
}
