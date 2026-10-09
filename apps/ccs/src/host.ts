import { z } from 'zod';
import {
  AccessCheckResponse,
  CaseSnapshot,
  ConsiliumProtocolResponse,
  CreateRequestResponse,
  PatientRevealResponse,
  type AccessCheckRequest,
  type ConsiliumProtocolRequest,
  type CriticalFindingEvent,
  type CreateRequestRequest,
  type PatientRevealRequest,
} from '@konsilium/protocol/integration';

/**
 * Обратные вызовы в систему-источник (уровень 2). Права доступа и данные пациента — всегда из неё, а не из мессенджера.
 * Контракт — apps/ccs/openapi/host-callbacks-v1.yaml.
 */
export interface HostCallbacks {
  /** Снимок случая по запросу — если события `case.upserted` по нему ещё не было. `null` — случая нет. */
  getCase(caseId: string): Promise<CaseSnapshot | null>;
  checkAccess(req: AccessCheckRequest): Promise<AccessCheckResponse>;
  createRequest(req: CreateRequestRequest, idempotencyKey: string): Promise<CreateRequestResponse>;
  revealPatient(req: PatientRevealRequest): Promise<PatientRevealResponse>;
  /** Жизненный цикл критической находки — в журнал системы-источника. Повтор с тем же ключом безопасен. */
  criticalEvent(event: CriticalFindingEvent, idempotencyKey: string): Promise<void>;
  /** Принятый протокол консилиума по случаю — в МИС на подпись. Повтор с тем же ключом даёт тот же ответ. */
  consiliumProtocol(req: ConsiliumProtocolRequest, idempotencyKey: string): Promise<ConsiliumProtocolResponse>;
}

/** Ошибка обратного вызова. `transient` — стоит повторить позже (сеть, 5xx, 429, тайм-аут). */
export class HostError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
  }
}

export class HttpHostCallbacks implements HostCallbacks {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 3000,
  ) {}

  private async call<T>(method: string, path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, body?: unknown, headers: Record<string, string> = {}): Promise<T | null> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new HostError(0, `Система-источник недоступна: ${(e as Error).name}`, true);
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new HostError(res.status, `Система-источник ответила ${res.status}`, res.status >= 500 || res.status === 429);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new HostError(res.status, `Ответ системы-источника не по контракту: ${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`, false);
    }
    return parsed.data;
  }

  async criticalEvent(event: CriticalFindingEvent, idempotencyKey: string): Promise<void> {
    // Ответ без тела (202/204) — достаточно кода.
    await this.call('POST', '/critical-findings/events', z.unknown(), event, { 'idempotency-key': idempotencyKey });
  }

  async consiliumProtocol(req: ConsiliumProtocolRequest, idempotencyKey: string): Promise<ConsiliumProtocolResponse> {
    const r = await this.call('POST', '/consilium-protocols', ConsiliumProtocolResponse, req, { 'idempotency-key': idempotencyKey });
    if (!r) throw new HostError(404, 'Консилиум не найден в системе-источнике', false);
    return r;
  }

  async getCase(caseId: string): Promise<CaseSnapshot | null> {
    return this.call('GET', `/cases/${encodeURIComponent(caseId)}`, CaseSnapshot);
  }

  async checkAccess(req: AccessCheckRequest): Promise<AccessCheckResponse> {
    return (await this.call('POST', '/access-checks', AccessCheckResponse, req)) ?? { allowed: false };
  }

  async createRequest(req: CreateRequestRequest, idempotencyKey: string): Promise<CreateRequestResponse> {
    const r = await this.call('POST', '/requests', CreateRequestResponse, req, { 'idempotency-key': idempotencyKey });
    if (!r) throw new HostError(404, 'Случай не найден в системе-источнике', false);
    return r;
  }

  async revealPatient(req: PatientRevealRequest): Promise<PatientRevealResponse> {
    const r = await this.call('POST', '/patient-reveals', PatientRevealResponse, req);
    if (!r) throw new HostError(404, 'Случай не найден в системе-источнике', false);
    return r;
  }
}

/** Отказ в доступе со стороны системы-источника приходит как 403. */
export const isForbidden = (e: unknown) => e instanceof HostError && e.status === 403;
