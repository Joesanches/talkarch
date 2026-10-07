import { EventType, MsgType, RequestMessage, type CaseRef, type RequestStatusContent } from '@konsilium/protocol';
import type { CaseRoomStore } from './caseRooms.ts';
import type { HostDirectory } from './host.ts';
import type { MatrixApi } from './matrix.ts';

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
 * Обработка событий из транзакций Application Service.
 * Сейчас: заявка в чате случая → создание в системе-источнике → статус обратно в чат.
 */
export class EventProcessor {
  private readonly seen = new Set<string>();

  constructor(
    private readonly deps: { matrix: MatrixApi; store: CaseRoomStore; host: HostDirectory; org: string; log: Logger },
  ) {}

  async handle(event: MatrixEvent): Promise<void> {
    if (this.seen.has(event.event_id)) return;
    this.remember(event.event_id);
    if (event.sender === this.deps.matrix.botUserId) return;
    if (event.type === 'm.room.message' && event.content.msgtype === MsgType.Request) {
      await this.onRequest(event);
    }
  }

  private remember(eventId: string) {
    this.seen.add(eventId);
    if (this.seen.size > 10_000) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  private async onRequest(event: MatrixEvent) {
    const key = await this.deps.store.keyByRoom(event.room_id);
    if (!key) return; // не чат случая — заявки здесь не обрабатываем
    const parsed = RequestMessage.safeParse(event.content);
    if (!parsed.success) {
      this.deps.log.warn({ eventId: event.event_id, issues: parsed.error.issues }, 'Некорректная заявка');
      return;
    }
    const [, system, ...rest] = key.split(':') as [string, CaseRef['system'], ...string[]];
    const ref: CaseRef = { org: this.deps.org, system, caseId: rest.join(':') };
    const request = parsed.data[MsgType.Request];
    const created = await this.deps.host.createRequest(ref, request);
    const status: RequestStatusContent = {
      'm.relates_to': { rel_type: 'm.reference', event_id: event.event_id },
      external_id: created.externalId,
      status: created.status,
      steps: request.kind === 'ihc' ? ['accepted', 'staining', 'scanning', 'done'] : ['accepted', 'done'],
      source: system,
    };
    await this.deps.matrix.sendEvent(event.room_id, EventType.RequestStatus, status as unknown as Record<string, unknown>, `status-${event.event_id}`);
    this.deps.log.info({ roomId: event.room_id, externalId: created.externalId }, 'Заявка создана в системе-источнике');
  }
}
