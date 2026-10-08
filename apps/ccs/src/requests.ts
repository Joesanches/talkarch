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

/** Память — для тестов; PostgreSQL (db.ts) — чтобы статусы после перезапуска находили свою заявку. */
export interface RequestStore {
  add(r: TrackedRequest): Promise<void>;
  find(connector: string, externalId: string): Promise<TrackedRequest | null>;
  updateSteps(connector: string, externalId: string, steps: TrackedRequest['steps']): Promise<void>;
}

export class InMemoryRequestStore implements RequestStore {
  private readonly items = new Map<string, TrackedRequest>();
  async add(r: TrackedRequest) {
    this.items.set(`${r.connector}\n${r.externalId}`, r);
  }
  async find(connector: string, externalId: string) {
    const r = this.items.get(`${connector}\n${externalId}`);
    return r ? { ...r } : null;
  }
  async updateSteps(connector: string, externalId: string, steps: TrackedRequest['steps']) {
    const r = this.items.get(`${connector}\n${externalId}`);
    if (r) r.steps = steps;
  }
}
