import { z } from 'zod';

/**
 * Пространство имён собственных событий Matrix.
 * `ru.vendor` — заглушка: заменить на обратный домен компании до первого внедрения
 * (после появления данных в продуктиве менять пространство имён дорого).
 */
export const NS = 'ru.vendor' as const;

/** Типы комнат (`m.room.create` → `content.type`). */
export const RoomType = {
  Case: `${NS}.case`,
  Service: `${NS}.service`,
  Channel: `${NS}.channel`,
  Tmk: `${NS}.tmk`,
} as const;

/** Типы state- и обычных событий. */
export const EventType = {
  CaseContext: `${NS}.case.context`,
  /**
   * Роли участников — одно state-событие (state_key = "") со словарём «Matrix ID → роль».
   * Не отдельные события с state_key = Matrix ID: по правилам авторизации Matrix такие ключи
   * («начинается с @») может писать только сам пользователь, а роли назначает сервис.
   */
  CaseRoles: `${NS}.case.roles`,
  RequestStatus: `${NS}.request.status`,
  Ack: `${NS}.ack`,
  Call: `${NS}.call`,
  CallInvite: `${NS}.call.invite`,
} as const;

/** Собственные `msgtype` для `m.room.message` (у каждого обязателен текстовый `body`). */
export const MsgType = {
  KeyImage: `${NS}.key_image`,
  SlideRoi: `${NS}.slide_roi`,
  Request: `${NS}.request`,
  Critical: `${NS}.critical`,
  Report: `${NS}.report`,
  Incident: `${NS}.incident`,
} as const;

/** Ключи реакций-статусов (`m.reaction` → `m.relates_to.key`). */
export const ReactionKey = {
  Accepted: 'принято',
  Agree: 'согласен',
  Seen: 'видел',
  Question: 'вопрос',
  Urgent: 'срочно',
} as const;

export const SourceSystem = z.enum(['RIS', 'LIS', 'TMK']);
export type SourceSystem = z.infer<typeof SourceSystem>;

export const CaseRole = z.enum([
  'pathologist',
  'radiologist',
  'attending',
  'lab_tech',
  'radiographer',
  'engineer',
  'head',
  'external_consultant',
  'on_duty',
  'viewer',
]);
export type CaseRole = z.infer<typeof CaseRole>;

/** Ссылка на случай во внешней системе. */
export const CaseRef = z.object({
  org: z.string().trim().min(1),
  system: SourceSystem,
  caseId: z.string().trim().min(1).max(128),
});
export type CaseRef = z.infer<typeof CaseRef>;

/**
 * Канонический ключ случая: «организация + система + номер».
 * Номер сравнивается без учёта регистра и пробелов по краям: «г26-04512» и «Г26-04512» — один случай.
 */
export function caseKey(ref: CaseRef): string {
  const parsed = CaseRef.parse(ref);
  return [parsed.org.toLowerCase(), parsed.system, parsed.caseId.toUpperCase()].join(':');
}

/**
 * Данные пациента в чате — только псевдоним и маска.
 * Полное ФИО в событиях не хранится: его по запросу отдаёт РИС/ЛИС с записью в журнал.
 */
export const PatientRef = z
  .object({
    ref: z.string().min(1),
    masked: z.string().min(1),
    age: z.number().int().min(0).max(130).optional(),
    sex: z.enum(['F', 'M', 'U']).optional(),
  })
  .strict();
export type PatientRef = z.infer<typeof PatientRef>;

/** State-событие `ru.vendor.case.context` (state_key = ""). */
export const CaseContext = z.object({
  source: SourceSystem,
  case_id: z.string().min(1),
  order_id: z.string().nullish(),
  accession_number: z.string().nullish(),
  study_instance_uid: z.string().nullish(),
  title: z.string().min(1),
  patient: PatientRef,
  stage: z.string().optional(),
  priority: z.enum(['routine', 'urgent', 'cito']).optional(),
  due: z.string().datetime({ offset: true }).optional(),
  links: z.object({ record: z.string().url().optional(), viewer: z.string().url().optional() }).optional(),
  sync: z.object({ version: z.number().int().nonnegative(), updated_at: z.string() }),
});
export type CaseContext = z.infer<typeof CaseContext>;

export const CaseRoleAssignment = z.object({
  role: CaseRole,
  source: z.union([SourceSystem, z.literal('CCS')]),
  assigned_at: z.string(),
});
export type CaseRoleAssignment = z.infer<typeof CaseRoleAssignment>;

/** State-событие `ru.vendor.case.roles` (state_key = ""): роли участников по Matrix ID. */
export const CaseRolesContent = z.object({
  members: z.record(z.string().startsWith('@'), CaseRoleAssignment),
});
export type CaseRolesContent = z.infer<typeof CaseRolesContent>;

const MessageBase = z.object({ body: z.string().min(1) });

export const KeyImage = MessageBase.extend({
  msgtype: z.literal(MsgType.KeyImage),
  [MsgType.KeyImage]: z.object({
    study_uid: z.string().min(1),
    series_uid: z.string().min(1),
    sop_uid: z.string().min(1),
    frame: z.number().int().positive().default(1),
    presentation: z.object({ ww: z.number(), wc: z.number(), zoom: z.number().positive().optional() }).optional(),
    annotations: z.array(z.record(z.unknown())).optional(),
    thumbnail: z.string().startsWith('mxc://').optional(),
    kos_uid: z.string().optional(),
    link: z.object({ kind: z.enum(['iid', 'viewer']), url: z.string().url() }).optional(),
  }),
});
export type KeyImage = z.infer<typeof KeyImage>;

export const SlideRoi = MessageBase.extend({
  msgtype: z.literal(MsgType.SlideRoi),
  [MsgType.SlideRoi]: z.object({
    slide_id: z.string().min(1),
    stain: z.string().min(1),
    magnification: z.number().positive(),
    region: z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive(), level: z.number().int().nonnegative() }),
    thumbnail: z.string().startsWith('mxc://').optional(),
    link: z.object({ kind: z.literal('viewer'), url: z.string().url() }).optional(),
  }),
});
export type SlideRoi = z.infer<typeof SlideRoi>;

export const RequestKind = z.enum(['ihc', 'recut', 'review', 'second_opinion', 'service']);

export const RequestMessage = MessageBase.extend({
  msgtype: z.literal(MsgType.Request),
  [MsgType.Request]: z.object({
    kind: RequestKind,
    block: z.string().optional(),
    items: z.array(z.string().min(1)).default([]),
    priority: z.enum(['routine', 'urgent', 'cito']).default('routine'),
    note: z.string().optional(),
    assignee_role: CaseRole.optional(),
  }),
});
export type RequestMessage = z.infer<typeof RequestMessage>;

export const RequestStep = z.enum(['created', 'accepted', 'staining', 'scanning', 'done', 'rejected']);
export type RequestStep = z.infer<typeof RequestStep>;

/** Событие `ru.vendor.request.status` — статус заявки из внешней системы; ссылается на сообщение-заявку. */
export const RequestStatusContent = z.object({
  'm.relates_to': z.object({ rel_type: z.literal('m.reference'), event_id: z.string().min(1) }),
  external_id: z.string().min(1),
  status: RequestStep,
  steps: z.array(RequestStep),
  by: z.string().optional(),
  source: z.union([SourceSystem, z.literal('CCS')]),
});
export type RequestStatusContent = z.infer<typeof RequestStatusContent>;

export const CriticalMessage = MessageBase.extend({
  msgtype: z.literal(MsgType.Critical),
  [MsgType.Critical]: z.object({
    finding: z.string().min(1),
    recipient: z.object({ role: z.string().min(1), resolved_user: z.string().optional() }),
    ack_required: z.literal(true),
    ack_deadline: z.string().regex(/^PT\d+M$/),
    escalation: z.array(z.object({ after: z.string().regex(/^PT\d+M$/), action: z.enum(['call', 'notify']), target: z.string() })).default([]),
  }),
});
export type CriticalMessage = z.infer<typeof CriticalMessage>;

/** State-событие `ru.vendor.call` — идущий звонок или консилиум в комнате (state_key = call_id). */
export const CallState = z.object({
  call_id: z.string().min(1),
  kind: z.enum(['direct', 'consilium', 'tmk', 'webinar']),
  started_by: z.string().min(1),
  started_at: z.string(),
  ended_at: z.string().optional(),
});
export type CallState = z.infer<typeof CallState>;

/** Разбор `m.room.message` в один из структурированных типов; остальное — `null`. */
export function parseStructured(content: unknown): KeyImage | SlideRoi | RequestMessage | CriticalMessage | null {
  const msgtype = (content as { msgtype?: unknown } | null)?.msgtype;
  const schema = {
    [MsgType.KeyImage]: KeyImage,
    [MsgType.SlideRoi]: SlideRoi,
    [MsgType.Request]: RequestMessage,
    [MsgType.Critical]: CriticalMessage,
  }[msgtype as string];
  if (!schema) return null;
  const result = schema.safeParse(content);
  return result.success ? result.data : null;
}

/** Текст для `body` заявки: его покажет любой Matrix-клиент, не знающий наших типов. */
export function requestFallbackBody(r: RequestMessage[typeof MsgType.Request]): string {
  const kind = { ihc: 'Запрос ИГХ', recut: 'Запрос дорезки', review: 'Запрос пересмотра', second_opinion: 'Запрос второго мнения', service: 'Сервисная заявка' }[r.kind];
  const block = r.block ? `: блок ${r.block}` : '';
  const items = r.items.length ? ` — ${r.items.join(', ')}` : '';
  const priority = r.priority === 'routine' ? '' : r.priority === 'urgent' ? ' (срочно)' : ' (CITO)';
  return `${kind}${block}${items}${priority}`;
}
