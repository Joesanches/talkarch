import type { RequestStep } from '@konsilium/protocol';

/** Заявка, созданная из чата: связывает номер в системе-источнике с сообщением-заявкой в комнате. */
export interface TrackedRequest {
  connector: string;
  caseId: string;
  externalId: string;
  roomId: string;
  eventId: string;
  steps: RequestStep[];
}

/** В PoC — память; в продукте — таблица PostgreSQL (иначе статусы после перезапуска не найдут свою заявку). */
export interface RequestStore {
  add(r: TrackedRequest): Promise<void>;
  find(connector: string, externalId: string): Promise<TrackedRequest | null>;
}

export class InMemoryRequestStore implements RequestStore {
  private readonly items = new Map<string, TrackedRequest>();
  async add(r: TrackedRequest) {
    this.items.set(`${r.connector}\n${r.externalId}`, r);
  }
  async find(connector: string, externalId: string) {
    return this.items.get(`${connector}\n${externalId}`) ?? null;
  }
}
