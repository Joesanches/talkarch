import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { CaseRole, PatientRef, SourceSystem, caseKey, type CaseRef, type RequestMessage, type RequestStep, type MsgType } from '@konsilium/protocol';

/** Случай в системе-источнике (РИС/ЛИС/ТМК) — то, что сервису контекста отдаёт адаптер интеграции. */
export interface HostCase {
  ref: CaseRef;
  title: string;
  patient: z.infer<typeof PatientRef>;
  orderId?: string;
  accessionNumber?: string;
  studyUid?: string;
  stage?: string;
  priority?: 'routine' | 'urgent' | 'cito';
  due?: string;
  links?: { record?: string; viewer?: string };
  /** Участники по ролям — их приглашают при создании комнаты. */
  participants: Array<{ userId: string; role: CaseRole }>;
  version: number;
  updatedAt: string;
}

export type RequestPayload = RequestMessage[typeof MsgType.Request];

/**
 * Граница с РИС/ЛИС. Права доступа — всегда из системы-источника, а не из мессенджера.
 * В PoC — JSON-справочник; в продукте — адаптеры HL7 v2 / FHIR / REST.
 */
export interface HostDirectory {
  getCase(ref: CaseRef): Promise<HostCase | null>;
  canAccess(userId: string, ref: CaseRef): Promise<boolean>;
  createRequest(ref: CaseRef, request: RequestPayload): Promise<{ externalId: string; status: RequestStep }>;
}

const Fixture = z.object({
  cases: z.array(
    z.object({
      system: SourceSystem,
      caseId: z.string().min(1),
      title: z.string().min(1),
      patient: PatientRef,
      orderId: z.string().optional(),
      accessionNumber: z.string().optional(),
      studyUid: z.string().optional(),
      stage: z.string().optional(),
      priority: z.enum(['routine', 'urgent', 'cito']).optional(),
      due: z.string().optional(),
      links: z.object({ record: z.string().url().optional(), viewer: z.string().url().optional() }).optional(),
      participants: z.array(z.object({ user: z.string().min(1), role: CaseRole })),
      access: z.array(z.string().min(1)),
    }),
  ),
});

const requestPrefix: Record<RequestPayload['kind'], string> = {
  ihc: 'ИГХ',
  recut: 'ДР',
  review: 'ПС',
  second_opinion: 'ВМ',
  service: 'СД',
};

/** Справочник случаев из JSON для PoC и тестов. Пользователи в файле — локальные части Matrix ID. */
export class JsonHostDirectory implements HostDirectory {
  private readonly cases = new Map<string, { data: HostCase; access: Set<string> }>();
  private requestSeq = 7780;

  constructor(raw: unknown, org: string, serverName: string) {
    const fixture = Fixture.parse(raw);
    const mxid = (localpart: string) => `@${localpart}:${serverName}`;
    for (const c of fixture.cases) {
      const ref: CaseRef = { org, system: c.system, caseId: c.caseId };
      this.cases.set(caseKey(ref), {
        data: {
          ref,
          title: c.title,
          patient: c.patient,
          orderId: c.orderId,
          accessionNumber: c.accessionNumber,
          studyUid: c.studyUid,
          stage: c.stage,
          priority: c.priority,
          due: c.due,
          links: c.links,
          participants: c.participants.map((p) => ({ userId: mxid(p.user), role: p.role })),
          version: 1,
          updatedAt: new Date(0).toISOString(),
        },
        access: new Set(c.access.map(mxid)),
      });
    }
  }

  static fromFile(path: string, org: string, serverName: string): JsonHostDirectory {
    return new JsonHostDirectory(JSON.parse(readFileSync(path, 'utf8')), org, serverName);
  }

  async getCase(ref: CaseRef): Promise<HostCase | null> {
    return this.cases.get(caseKey(ref))?.data ?? null;
  }

  async canAccess(userId: string, ref: CaseRef): Promise<boolean> {
    return this.cases.get(caseKey(ref))?.access.has(userId) ?? false;
  }

  async createRequest(_ref: CaseRef, request: RequestPayload): Promise<{ externalId: string; status: RequestStep }> {
    this.requestSeq += 1;
    return { externalId: `${requestPrefix[request.kind]}-${this.requestSeq}`, status: 'accepted' };
  }
}
