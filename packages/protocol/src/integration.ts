/**
 * API интеграции с РИС, ЛИС и ТМК (версия 1): схемы событий и обратных вызовов.
 * Контракт для других команд — docs/10-integration-api.md и apps/ccs/openapi/*.yaml.
 * Схемы здесь и OpenAPI сверяются тестом apps/ccs/test/unit/contract.test.ts.
 */
import { z } from 'zod';
import {
  CaseLinks,
  CaseRole,
  CaseStatus,
  NS,
  NotificationCategory,
  NotificationLink,
  PatientRef,
  Priority,
  RequestKind,
  RequestStep,
} from './index.ts';

/** Типы событий системы-источника → сервис контекста (атрибут CloudEvents `type`). */
export const IntegrationEventType = {
  CaseUpserted: `${NS}.case.upserted`,
  RequestStatusChanged: `${NS}.request.status.changed`,
  NotificationPosted: `${NS}.notification.posted`,
} as const;
export type IntegrationEventType = (typeof IntegrationEventType)[keyof typeof IntegrationEventType];

/** Максимум событий в одном пакете. */
export const MAX_BATCH = 100;

/**
 * Пользователь глазами системы-источника. Нужен хотя бы один идентификатор.
 * Порядок сопоставления с Matrix ID: `mxid` → `login` → `idp_sub` → `employee_id`.
 */
export const UserRef = z
  .object({
    mxid: z.string().regex(/^@[^:\s]+:\S+$/).optional(),
    login: z.string().trim().min(1).max(255).optional(),
    idp_sub: z.string().min(1).max(255).optional(),
    employee_id: z.string().min(1).max(64).optional(),
    display_name: z.string().max(200).optional(),
  })
  .refine((u) => u.mxid || u.login || u.idp_sub || u.employee_id, {
    message: 'Нужен хотя бы один идентификатор: mxid, login, idp_sub или employee_id',
  });
export type UserRef = z.infer<typeof UserRef>;

export const Participant = z.object({ user: UserRef, role: CaseRole });
export type Participant = z.infer<typeof Participant>;

const CaseId = z.string().trim().min(1).max(128);
const Timestamp = z.string().datetime({ offset: true });

/**
 * Снимок случая — данные события `case.upserted` и ответа `GET /cases/{case_id}`.
 * Всегда полный: что не передано, то сброшено. Исключение — `revoked`: это явная команда.
 */
export const CaseSnapshot = z.object({
  case_id: CaseId,
  /** Монотонно растущая версия случая: номер ревизии, rowversion или время изменения в мс. */
  version: z.number().int().nonnegative(),
  status: CaseStatus.default('open'),
  title: z.string().trim().min(1).max(200),
  patient: PatientRef,
  order_id: z.string().max(128).optional(),
  accession_number: z.string().max(64).optional(),
  study_instance_uid: z.string().regex(/^[0-9]+(\.[0-9]+)*$/).max(64).optional(),
  stage: z.string().max(64).optional(),
  priority: Priority.optional(),
  due: Timestamp.optional(),
  links: CaseLinks.optional(),
  /** Участники по ролям: их приглашают в чат случая. */
  participants: z.array(Participant).max(50).default([]),
  /** Кому ещё можно открыть чат (уровень 1, без обратных вызовов). На уровне 2 права проверяет `POST /access-checks`. */
  access: z.array(UserRef).max(500).optional(),
  /** Отозвать доступ: пользователь будет выведен из чата. */
  revoked: z.array(UserRef).max(50).optional(),
  updated_at: Timestamp,
});
export type CaseSnapshot = z.infer<typeof CaseSnapshot>;
export type CaseSnapshotInput = z.input<typeof CaseSnapshot>;

/** Данные `request.status.changed`: статус заявки, созданной из чата. */
export const RequestStatusChanged = z.object({
  case_id: CaseId,
  external_id: z.string().min(1).max(64),
  status: RequestStep,
  /** Шаги для полосы прогресса; если не переданы — остаются прежние. */
  steps: z.array(RequestStep).max(10).optional(),
  note: z.string().max(500).optional(),
  changed_at: Timestamp,
});
export type RequestStatusChanged = z.infer<typeof RequestStatusChanged>;

/** Данные `notification.posted`: служебное сообщение в чат случая. */
export const NotificationPosted = z.object({
  case_id: CaseId,
  text: z.string().trim().min(1).max(2000),
  category: NotificationCategory.default('info'),
  links: z.array(NotificationLink).max(3).default([]),
  /** Создать чат, если его ещё нет. По умолчанию уведомление по случаю без чата игнорируется. */
  ensure_chat: z.boolean().default(false),
});
export type NotificationPosted = z.infer<typeof NotificationPosted>;

export const eventDataSchemas = {
  [IntegrationEventType.CaseUpserted]: CaseSnapshot,
  [IntegrationEventType.RequestStatusChanged]: RequestStatusChanged,
  [IntegrationEventType.NotificationPosted]: NotificationPosted,
} as const;

/**
 * Конверт события — CloudEvents 1.0, структурированный режим JSON.
 * `source` — идентификатор подключения; он должен совпадать с подключением, от имени которого пришёл запрос.
 * `id` уникален в пределах подключения и служит ключом идемпотентности.
 */
export const CloudEvent = z
  .object({
    specversion: z.literal('1.0'),
    id: z.string().min(1).max(256),
    source: z.string().min(1).max(256),
    type: z.string().min(1).max(256),
    time: Timestamp.optional(),
    subject: z.string().max(256).optional(),
    datacontenttype: z.literal('application/json').optional(),
    data: z.unknown(),
  })
  .passthrough();
export type CloudEvent = z.infer<typeof CloudEvent>;

/** Итог обработки одного события. */
export const EventResultStatus = z.enum(['accepted', 'duplicate', 'stale', 'ignored', 'rejected', 'failed']);
export type EventResultStatus = z.infer<typeof EventResultStatus>;

export const EventResult = z.object({
  id: z.string(),
  status: EventResultStatus,
  detail: z.string().optional(),
  warnings: z.array(z.string()).optional(),
});
export type EventResult = z.infer<typeof EventResult>;

export const EventsResponse = z.object({ results: z.array(EventResult) });
export type EventsResponse = z.infer<typeof EventsResponse>;

/** Сведения о чате случая для системы-источника. */
export const ChatInfo = z.object({
  case_id: z.string(),
  chat: z
    .object({
      room_id: z.string(),
      alias: z.string(),
      url: z.string().url(),
    })
    .nullable(),
});
export type ChatInfo = z.infer<typeof ChatInfo>;

// ── Обратные вызовы: сервис контекста → система-источник ─────────────────────────

/** `POST {callbacks}/access-checks` */
export const AccessCheckRequest = z.object({
  case_id: CaseId,
  user: UserRef,
});
export type AccessCheckRequest = z.infer<typeof AccessCheckRequest>;

export const AccessCheckResponse = z.object({
  allowed: z.boolean(),
  /** Роль, с которой пользователь войдёт в чат (если система её знает). */
  role: CaseRole.optional(),
});
export type AccessCheckResponse = z.infer<typeof AccessCheckResponse>;

/** `POST {callbacks}/requests` — заявка из чата (заголовок `Idempotency-Key` = ID события Matrix). */
export const CreateRequestRequest = z.object({
  case_id: CaseId,
  request: z.object({
    kind: RequestKind,
    block: z.string().optional(),
    items: z.array(z.string().min(1)).default([]),
    priority: Priority.default('routine'),
    note: z.string().optional(),
    assignee_role: CaseRole.optional(),
  }),
  requested_by: UserRef,
  chat: z.object({ room_id: z.string(), event_id: z.string() }),
});
export type CreateRequestRequest = z.infer<typeof CreateRequestRequest>;

export const CreateRequestResponse = z.object({
  external_id: z.string().min(1).max(64),
  status: RequestStep,
  steps: z.array(RequestStep).max(10).optional(),
});
export type CreateRequestResponse = z.infer<typeof CreateRequestResponse>;

/** `POST {callbacks}/patient-reveals` — раскрыть данные пациента (система-источник пишет это в свой журнал). */
export const PatientRevealRequest = z.object({
  case_id: CaseId,
  user: UserRef,
  reason: z.string().max(200).optional(),
});
export type PatientRevealRequest = z.infer<typeof PatientRevealRequest>;

export const PatientRevealResponse = z.object({
  display_name: z.string().min(1).max(200),
  birth_date: z.string().date().optional(),
  mrn: z.string().max(64).optional(),
});
export type PatientRevealResponse = z.infer<typeof PatientRevealResponse>;

/** Ошибка в формате RFC 9457 (Problem Details). */
export const Problem = z.object({
  type: z.string().default('about:blank'),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
});
export type Problem = z.infer<typeof Problem>;
