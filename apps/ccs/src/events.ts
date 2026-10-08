import { CaseContext, EventType, MsgType, RequestMessage, type RequestStatusContent } from '@konsilium/protocol';
import type { ArchiveService } from './archive.ts';
import type { CaseDirectory } from './cases.ts';
import type { CriticalService } from './critical.ts';
import type { UserResolver } from './connectors.ts';
import { HostError } from './host.ts';
import { isTransient } from './integration.ts';
import { MatrixError, type MatrixApi } from './matrix.ts';
import type { RequestStore } from './requests.ts';

export interface MatrixEvent {
  event_id: string;
  room_id: string;
  sender: string;
  type: string;
  state_key?: string;
  content: Record<string, unknown>;
}

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/**
 * Ошибка, после которой транзакцию нужно повторить: Synapse получит 503 и пришлёт её снова (с паузами).
 * Так заявка не теряется, пока ЛИС недоступна. В продукте — исходящая очередь (outbox), чтобы не задерживать другие события.
 */
export class RetryLaterError extends Error {}

/**
 * Обработка событий из транзакций Application Service.
 * Заявка в чате случая → обратный вызов в систему-источник → статус обратно в чат.
 * Критическая находка и подтверждение её получения → CriticalService. Активность пользователей → ArchiveService.
 */
export class EventProcessor {
  private readonly done = new Set<string>();

  constructor(
    private readonly deps: {
      matrix: MatrixApi;
      directory: CaseDirectory;
      requests: RequestStore;
      users: UserResolver;
      critical: CriticalService;
      archive: ArchiveService;
      log: Logger;
    },
  ) {}

  async handle(event: MatrixEvent): Promise<void> {
    if (this.done.has(event.event_id)) return;
    const fromUser = event.sender !== this.deps.matrix.botUserId;
    if (fromUser && event.type === 'm.room.message' && event.content.msgtype === MsgType.Request) await this.onRequest(event);
    if (fromUser && event.type === 'm.room.message' && event.content.msgtype === MsgType.Critical) await this.deps.critical.onMessage(event);
    if (fromUser && event.type === EventType.Ack) await this.deps.critical.onAck(event);
    // Активность пользователей отодвигает архив закрытого случая.
    if (fromUser) await this.deps.archive.onActivity(event.room_id).catch((err) => this.deps.log.warn({ err }, 'Активность чата не записана'));
    // Отмечаем только после успешной обработки: при повторе транзакции событие обработается снова.
    this.done.add(event.event_id);
    if (this.done.size > 10_000) {
      const oldest = this.done.values().next().value;
      if (oldest !== undefined) this.done.delete(oldest);
    }
  }

  /** Контекст случая из состояния комнаты: его пишет только сервис, поэтому ему можно верить. */
  private async caseContext(roomId: string): Promise<CaseContext | null> {
    try {
      const raw = await this.deps.matrix.getState(roomId, EventType.CaseContext);
      const parsed = CaseContext.safeParse(raw);
      return parsed.success ? parsed.data : null;
    } catch (e) {
      if (e instanceof MatrixError && e.status < 500) return null; // не наша комната
      throw e;
    }
  }

  private async onRequest(event: MatrixEvent) {
    const ctx = await this.caseContext(event.room_id);
    if (!ctx) return; // не чат случая — заявки здесь не обрабатываем
    const parsed = RequestMessage.safeParse(event.content);
    if (!parsed.success) {
      this.deps.log.warn({ eventId: event.event_id, issues: parsed.error.issues }, 'Некорректная заявка');
      return;
    }
    const callbacks = this.deps.directory.callbacks(ctx.connector);
    if (!callbacks) {
      await this.deps.matrix.sendEvent(
        event.room_id,
        'm.room.message',
        { msgtype: 'm.notice', body: 'Заявки из чата для этой системы не подключены. Оформите заявку в системе-источнике.' },
        `noreq.${event.event_id}`,
      );
      return;
    }

    const request = parsed.data[MsgType.Request];
    let created;
    try {
      created = await callbacks.createRequest(
        {
          case_id: ctx.case_id,
          request,
          requested_by: this.deps.users.toRef(event.sender),
          chat: { room_id: event.room_id, event_id: event.event_id },
        },
        event.event_id,
      );
    } catch (e) {
      if (isTransient(e)) throw new RetryLaterError(`Система-источник недоступна: ${(e as Error).message}`);
      const reason = e instanceof HostError && e.status === 403 ? 'нет прав на заявку' : 'система-источник отклонила заявку';
      await this.deps.matrix.sendEvent(
        event.room_id,
        EventType.RequestStatus,
        {
          'm.relates_to': { rel_type: 'm.reference', event_id: event.event_id },
          external_id: '—',
          status: 'rejected',
          steps: ['rejected'],
          source: 'CCS',
          note: reason,
        } satisfies RequestStatusContent,
        `status-${event.event_id}`,
      );
      return;
    }

    const steps = created.steps ?? (request.kind === 'ihc' ? ['accepted', 'staining', 'scanning', 'done'] : ['accepted', 'done']);
    await this.deps.requests.add({
      connector: ctx.connector,
      caseId: ctx.case_id,
      externalId: created.external_id,
      roomId: event.room_id,
      eventId: event.event_id,
      steps,
    });
    const status: RequestStatusContent = {
      'm.relates_to': { rel_type: 'm.reference', event_id: event.event_id },
      external_id: created.external_id,
      status: created.status,
      steps,
      source: ctx.source,
    };
    await this.deps.matrix.sendEvent(event.room_id, EventType.RequestStatus, status as unknown as Record<string, unknown>, `status-${event.event_id}`);
    this.deps.log.info({ roomId: event.room_id, externalId: created.external_id }, 'Заявка создана в системе-источнике');
  }
}
