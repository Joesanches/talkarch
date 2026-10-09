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
  /** Консилиум: повестка из нескольких случаев, состав с ролями, звонок и протоколы по случаям. */
  Consilium: `${NS}.consilium`,
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
  /** Принятие или отклонение черновика (протокола ИИ) врачом — ссылка на сообщение-черновик. */
  ReportStatus: `${NS}.report.status`,
  /** Подтверждение получения критической находки — ссылка `m.reference` на неё. Засчитывает сервис контекста. */
  Ack: `${NS}.ack`,
  /**
   * Статус критической находки — state-событие, state_key = ID сообщения-находки. Пишет только сервис контекста
   * (уровень 100): адресаты, срок, эскалации, кто и когда подтвердил. Клиенты верят ему, а не сырым `ru.vendor.ack`.
   */
  CriticalStatus: `${NS}.critical.status`,
  /**
   * Архив чата случая — state-событие (state_key = ""). Пишет только сервис контекста: случай закрыт и давно без
   * активности → комната только для чтения, участники выведены, история сохранена (docs/03-architecture.md, 3.4).
   */
  CaseArchive: `${NS}.case.archive`,
  Call: `${NS}.call`,
  CallInvite: `${NS}.call.invite`,
  /** Консилиум — state-событие (state_key = ""): название, время, состав с ролями, повестка. Пишет только сервис. */
  Consilium: `${NS}.consilium`,
  /**
   * Текущий случай повестки — state-событие (state_key = ""). Переключают председатель и секретарь (уровень 50);
   * по этим отметкам «Секретарь» делит стенограмму консилиума по случаям.
   */
  ConsiliumCurrent: `${NS}.consilium.current`,
  /** Принятый протокол передан в МИС: сервис отвечает ссылкой `m.reference` на черновик (уровень 100). */
  ReportDelivery: `${NS}.report.delivery`,
} as const;

/** Собственные `msgtype` для `m.room.message` (у каждого обязателен текстовый `body`). */
export const MsgType = {
  KeyImage: `${NS}.key_image`,
  SlideRoi: `${NS}.slide_roi`,
  Request: `${NS}.request`,
  Critical: `${NS}.critical`,
  Report: `${NS}.report`,
  Incident: `${NS}.incident`,
  Transcript: `${NS}.transcript`,
} as const;

/** Ключи реакций-статусов (`m.reaction` → `m.relates_to.key`). */
export const ReactionKey = {
  Accepted: 'принято',
  Agree: 'согласен',
  Seen: 'видел',
  Question: 'вопрос',
  Urgent: 'срочно',
} as const;

/**
 * Поле служебного уведомления из РИС/ЛИС в `m.notice`: категория и кнопки-ссылки.
 * Клиенты, не знающие поля, показывают обычный текст из `body`.
 */
export const NotificationField = `${NS}.notification` as const;

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

/**
 * Идентификатор подключения — конкретного экземпляра РИС, ЛИС или ТМК («lis», «ris-gkb1», «tmk-vendorx»).
 * Тип системы (RIS/LIS/TMK) — свойство подключения: в одной организации могут работать две РИС разных производителей.
 */
export const ConnectorId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, 'Идентификатор подключения: a–z, 0–9, «_», «-», до 32 символов');
export type ConnectorId = z.infer<typeof ConnectorId>;

/** Ссылка на случай: подключение + номер случая (исследования, заказа) в нём. */
export const CaseRef = z.object({
  connector: ConnectorId,
  caseId: z.string().trim().min(1).max(128),
});
export type CaseRef = z.infer<typeof CaseRef>;

/**
 * Канонический ключ случая: «подключение + номер».
 * Номер сравнивается без учёта регистра и пробелов по краям: «г26-04512» и «Г26-04512» — один случай.
 */
export function caseKey(ref: CaseRef): string {
  const parsed = CaseRef.parse(ref);
  return [parsed.connector, parsed.caseId.toUpperCase()].join(':');
}

export const Priority = z.enum(['routine', 'urgent', 'cito']);
export type Priority = z.infer<typeof Priority>;

/** Состояние случая в системе-источнике. */
export const CaseStatus = z.enum(['open', 'closed', 'cancelled']);
export type CaseStatus = z.infer<typeof CaseStatus>;

export const CaseLinks = z.object({ record: z.string().url().optional(), viewer: z.string().url().optional() });

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
  /** Тип системы-источника — для подписи и иконки в клиенте. */
  source: SourceSystem,
  /** Подключение, из которого пришёл случай. */
  connector: ConnectorId,
  case_id: z.string().min(1),
  status: CaseStatus.optional(),
  order_id: z.string().nullish(),
  accession_number: z.string().nullish(),
  study_instance_uid: z.string().nullish(),
  title: z.string().min(1),
  patient: PatientRef,
  stage: z.string().optional(),
  priority: Priority.optional(),
  due: z.string().datetime({ offset: true }).optional(),
  links: CaseLinks.optional(),
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

/**
 * Причина, с которой сервис выводит участников архивного чата. По ней клиент узнаёт архив и тогда, когда сервер не
 * прислал изменение состояния перед выводом (Tuwunel — docs/11-load-test.md, 7.4).
 */
export const ARCHIVE_KICK_REASON = 'Случай в архиве';

/**
 * Снимок состояния в приглашении. Клиенту нужны контекст случая, статусы критических находок и архив ещё до входа в
 * чат (карточка, счётчики РИС/ЛИС, «!» в списке). Synapse добавляет их в приглашение сам (`room_prejoin_state`), Tuwunel —
 * нет (docs/11-load-test.md, 7.4). Поэтому сервис контекста кладёт снимок этих событий в само приглашение
 * (`m.room.member`, поле `ru.vendor.prejoin_state`), а клиент дополняет им то, чего нет в `invite_state`.
 */
export const PREJOIN_STATE_KEY = `${NS}.prejoin_state` as const;
export const PREJOIN_STATE_TYPES: readonly string[] = [EventType.CaseContext, EventType.CriticalStatus, EventType.CaseArchive];

export const PrejoinStateEvent = z.object({ type: z.string(), state_key: z.string(), content: z.record(z.unknown()) });
export type PrejoinStateEvent = z.infer<typeof PrejoinStateEvent>;

/** События снимка из содержимого приглашения: только типы из `PREJOIN_STATE_TYPES`, неразборчивое — пропускается. */
export function parsePrejoinState(memberContent: unknown): PrejoinStateEvent[] {
  const raw = (memberContent as Record<string, unknown> | null | undefined)?.[PREJOIN_STATE_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e) => {
    const r = PrejoinStateEvent.safeParse(e);
    return r.success && PREJOIN_STATE_TYPES.includes(r.data.type) ? [r.data] : [];
  });
}

/** `ru.vendor.case.archive`: в архиве (только чтение) или снова активен (случай открыт заново в системе-источнике). */
export const CaseArchiveContent = z.object({
  status: z.enum(['archived', 'active']),
  archived_at: z.string().datetime({ offset: true }).optional(),
  restored_at: z.string().datetime({ offset: true }).optional(),
});
export type CaseArchiveContent = z.infer<typeof CaseArchiveContent>;

/** Архивный случай пользователя в папке «Архив»: `GET /api/v1/archive` сервиса контекста. */
export const ArchivedCase = z.object({
  room_id: z.string().startsWith('!'),
  connector: ConnectorId,
  case_id: z.string().min(1),
  title: z.string(),
  source: SourceSystem,
  archived_at: z.string().datetime({ offset: true }),
});
export type ArchivedCase = z.infer<typeof ArchivedCase>;

/** Роль в консилиуме. Докладчик — свой у каждого случая повестки (`presenter`). */
export const ConsiliumRole = z.enum(['chair', 'secretary', 'member']);
export type ConsiliumRole = z.infer<typeof ConsiliumRole>;

export const ConsiliumMember = z.object({
  role: ConsiliumRole,
  /** Должность или специальность: «онколог», «химиотерапевт». */
  title: z.string().max(100).optional(),
  /** Участвует дистанционно (например, из другой МО). */
  remote: z.boolean().optional(),
});
export type ConsiliumMember = z.infer<typeof ConsiliumMember>;

/** Случай в повестке консилиума: данные — из системы-источника случая, как в контексте чата случая. */
export const AgendaItem = z.object({
  connector: ConnectorId,
  case_id: z.string().min(1),
  source: SourceSystem,
  title: z.string().min(1),
  patient: PatientRef,
  /** Докладчик (Matrix ID). */
  presenter: z.string().startsWith('@').optional(),
  /** Цель обсуждения, если её передала система-источник. */
  purpose: z.string().max(500).optional(),
});
export type AgendaItem = z.infer<typeof AgendaItem>;

export const MeetingForm = z.enum(['remote', 'in_person', 'mixed']);
export type MeetingForm = z.infer<typeof MeetingForm>;

/** State-событие `ru.vendor.consilium` (state_key = ""). */
export const ConsiliumContent = z.object({
  /** Подключение и номер консилиума в системе, которая его назначила (МИС, онкорегистр). */
  connector: ConnectorId,
  consilium_id: z.string().min(1),
  title: z.string().min(1),
  scheduled_at: z.string().datetime({ offset: true }),
  form: MeetingForm,
  members: z.record(z.string().startsWith('@'), ConsiliumMember),
  agenda: z.array(AgendaItem).min(1).max(30),
  sync: z.object({ version: z.number().int().nonnegative(), updated_at: z.string() }),
});
export type ConsiliumContent = z.infer<typeof ConsiliumContent>;

/** State-событие `ru.vendor.consilium.current`: номер текущего случая повестки (с нуля). */
export const ConsiliumCurrentContent = z.object({ index: z.number().int().nonnegative() });
export type ConsiliumCurrentContent = z.infer<typeof ConsiliumCurrentContent>;

/** Подписи ролей консилиума. */
export const consiliumRoleName = (role: ConsiliumRole) => ({ chair: 'председатель', secretary: 'секретарь', member: 'участник' })[role];

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
    /** Блок, из которого стекло (например, «1Б»). */
    block: z.string().min(1).optional(),
    stain: z.string().min(1),
    magnification: z.number().positive(),
    /** Область на скане; без неё — всё стекло. */
    region: z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive(), level: z.number().int().nonnegative() }).optional(),
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
    priority: Priority.default('routine'),
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
  note: z.string().max(500).optional(),
  source: z.union([SourceSystem, z.literal('CCS')]),
});
export type RequestStatusContent = z.infer<typeof RequestStatusContent>;

/** Длительность ISO 8601 в минутах и секундах: `PT10M`, `PT30S`, `PT1M30S`. */
export const IsoDuration = z
  .string()
  .regex(/^PT(?:\d+M)?(?:\d+S)?$/)
  .refine((v) => v !== 'PT', 'Пустая длительность');

/** Длительность `PT…` → секунды. */
export function durationSeconds(iso: string): number {
  const m = /^PT(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) throw new Error(`Не длительность ISO 8601: ${iso}`);
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}

const MatrixUserId = z.string().regex(/^@[^:\s]+:\S+$/);

/** Шаг эскалации: через `after` от отправки — уведомить и подключить (`notify`) или позвонить на пост (`call`). */
export const CriticalEscalationStep = z.object({
  after: IsoDuration,
  action: z.enum(['notify', 'call']),
  /** Роль в случае (`head`, `on_duty`…) или название поста для звонка. */
  target: z.string().trim().min(1).max(200),
  /** Кого подключить к чату (для `notify`), если роль в случае не назначена. */
  users: z.array(MatrixUserId).max(20).default([]),
});
export type CriticalEscalationStep = z.infer<typeof CriticalEscalationStep>;

/**
 * Критическая находка — `m.room.message` с msgtype `ru.vendor.critical`. Адресат — роль в случае и/или конкретные люди.
 * Пришла из РИС/ЛИС — отправитель сервис, врач — в `reported_by`.
 */
export const CriticalMessage = MessageBase.extend({
  msgtype: z.literal(MsgType.Critical),
  [MsgType.Critical]: z.object({
    finding: z.string().trim().min(1).max(1000),
    recipient: z
      .object({ role: CaseRole.optional(), users: z.array(MatrixUserId).max(10).default([]) })
      .refine((r) => r.role || r.users.length, 'Нужна роль адресата или пользователи'),
    ack_required: z.literal(true).default(true),
    ack_deadline: IsoDuration.default('PT10M'),
    /** Пусто — план эскалации подключения по умолчанию. */
    escalation: z.array(CriticalEscalationStep).max(5).default([]),
    reported_by: MatrixUserId.optional(),
    /** Номер находки в РИС/ЛИС (если пришла оттуда). */
    host_finding_id: z.string().max(128).optional(),
  }),
});
export type CriticalMessage = z.infer<typeof CriticalMessage>;

/** Подтверждение получения: `ru.vendor.ack` со ссылкой на находку. */
export const AckContent = z.object({
  'm.relates_to': z.object({ rel_type: z.literal('m.reference'), event_id: z.string().min(1) }),
});
export type AckContent = z.infer<typeof AckContent>;

/** `ru.vendor.critical.status` — состояние находки глазами сервиса контекста. */
export const CriticalStatusContent = z.object({
  /** `rejected` — находку отправил тот, кому это не положено, или адресата нет. */
  status: z.enum(['pending', 'acknowledged', 'rejected']),
  raised_at: z.string(),
  /** Срок подтверждения. */
  deadline_at: z.string(),
  /** Кто может подтвердить: адресаты и подключённые эскалацией. */
  recipients: z.array(MatrixUserId).default([]),
  reported_by: MatrixUserId,
  escalations: z
    .array(
      z.object({
        at: z.string(),
        action: z.enum(['notify', 'call']),
        target: z.string(),
        users: z.array(MatrixUserId).default([]),
        /** Звонок передан в систему-источник (телефония — на её стороне). */
        delivered: z.boolean().optional(),
      }),
    )
    .default([]),
  next_escalation_at: z.string().optional(),
  acknowledged: z.object({ by: MatrixUserId, at: z.string(), seconds: z.number().int().nonnegative() }).optional(),
  note: z.string().max(300).optional(),
});
export type CriticalStatusContent = z.infer<typeof CriticalStatusContent>;

export const NotificationCategory = z.enum(['info', 'ready', 'report', 'warning']);
export type NotificationCategory = z.infer<typeof NotificationCategory>;

export const NotificationLink = z.object({ label: z.string().min(1).max(40), url: z.string().url() });

/** Содержимое поля `ru.vendor.notification` в `m.notice` от сервиса. */
export const NotificationInfo = z.object({
  category: NotificationCategory,
  links: z.array(NotificationLink).max(3).default([]),
  connector: ConnectorId,
});
export type NotificationInfo = z.infer<typeof NotificationInfo>;

/** State-событие `ru.vendor.call` — идущий звонок или консилиум в комнате (state_key = call_id). */
export const CallState = z.object({
  call_id: z.string().min(1),
  kind: z.enum(['direct', 'consilium', 'tmk', 'webinar']),
  started_by: z.string().min(1),
  started_at: z.string(),
  ended_at: z.string().optional(),
  /** Идёт стенограмма (ИИ-«Секретарь»): все участники видят индикатор. */
  transcription: z
    .object({ started_by: z.string().min(1), started_at: z.string(), profile: z.enum(['gpu', 'cpu', 'external']) })
    .optional(),
});
export type CallState = z.infer<typeof CallState>;

/**
 * Фрагмент стенограммы: у каждого говорящего своя дорожка, поэтому атрибуция точная.
 * Время — миллисекунды от начала стенограммы, целые: канонический JSON Matrix не допускает дробных чисел.
 */
export const TranscriptSegment = z.object({
  i: z.number().int().nonnegative(),
  speaker: z.string().min(1),
  name: z.string().min(1),
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().nonnegative(),
  text: z.string().min(1),
  /** Стенограмма консилиума: номер случая повестки (с нуля), который обсуждали в этот момент. */
  case: z.number().int().nonnegative().optional(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegment>;

/** Стенограмма звонка — `m.room.message` с msgtype `ru.vendor.transcript`. */
export const TranscriptMessage = MessageBase.extend({
  msgtype: z.literal(MsgType.Transcript),
  [MsgType.Transcript]: z.object({
    call_id: z.string().min(1),
    started_at: z.string(),
    ended_at: z.string(),
    segments: z.array(TranscriptSegment),
    /** Стенограмма длиннее предела события — в сообщении начало, полный текст — файлом (план). */
    truncated: z.boolean().default(false),
    asr: z.object({ engine: z.string(), profile: z.enum(['gpu', 'cpu', 'external']) }),
  }),
});
export type TranscriptMessage = z.infer<typeof TranscriptMessage>;

/** Утверждение черновика со ссылками на фрагменты стенограммы (номера `i`). */
export const DraftStatement = z.object({ speaker: z.string().optional(), text: z.string().min(1), refs: z.array(z.number().int().nonnegative()).default([]) });
export type DraftStatement = z.infer<typeof DraftStatement>;

/**
 * Черновик протокола консилиума — msgtype `ru.vendor.report`, kind consilium_protocol.
 * Пациент, случай, состав и время — из систем, а не от ИИ (docs/08-video-ai.md, 5.4).
 */
export const ProtocolDraft = MessageBase.extend({
  msgtype: z.literal(MsgType.Report),
  [MsgType.Report]: z.object({
    kind: z.literal('consilium_protocol'),
    /** `accepted` — копия принятого протокола в чате случая (сервис присылает её после принятия на консилиуме). */
    status: z.enum(['draft', 'accepted']),
    generated_by: z.enum(['llm', 'template']),
    model: z.string().optional(),
    transcript_event_id: z.string().optional(),
    meeting: z.object({ date: z.string(), start: z.string(), end: z.string(), form: MeetingForm }),
    participants: z.array(z.object({ name: z.string(), mxid: z.string(), role: z.string().optional(), remote: z.boolean().optional() })),
    case: z.object({ connector: z.string(), case_id: z.string(), title: z.string(), patient: z.string() }).nullable(),
    /** Консилиум: место случая в повестке и название встречи. */
    agenda: z.object({ index: z.number().int().nonnegative(), total: z.number().int().positive(), consilium: z.string() }).optional(),
    /** Копия принятого протокола: кто принял и когда. */
    accepted: z.object({ by: z.string(), name: z.string(), at: z.string() }).optional(),
    sections: z.object({
      purpose: z.array(DraftStatement).default([]),
      clinical: z.array(DraftStatement).default([]),
      discussion: z.array(DraftStatement).default([]),
      decision: z.array(DraftStatement).default([]),
      dissent: z.array(DraftStatement).default([]),
    }),
  }),
});
export type ProtocolDraft = z.infer<typeof ProtocolDraft>;

/** `ru.vendor.report.status`: врач принял или отклонил черновик. Кто и когда — в событии (журнал). */
export const ReportStatusContent = z.object({
  'm.relates_to': z.object({ rel_type: z.literal('m.reference'), event_id: z.string().min(1) }),
  status: z.enum(['accepted', 'rejected']),
});
export type ReportStatusContent = z.infer<typeof ReportStatusContent>;

/** `ru.vendor.report.delivery`: принятый протокол передан в МИС (пишет сервис) — подписывают участники там. */
export const ReportDeliveryContent = z.object({
  'm.relates_to': z.object({ rel_type: z.literal('m.reference'), event_id: z.string().min(1) }),
  status: z.enum(['awaiting_signatures', 'signed', 'failed']),
  /** Номер протокола в МИС. */
  protocol_id: z.string().optional(),
  signers: z.number().int().nonnegative().optional(),
  /** Куда передан: «МИС», «ЛИС». */
  system: z.string().optional(),
  note: z.string().max(300).optional(),
});
export type ReportDeliveryContent = z.infer<typeof ReportDeliveryContent>;

/** Разбор `m.room.message` в один из структурированных типов; остальное — `null`. */
export function parseStructured(
  content: unknown,
): KeyImage | SlideRoi | RequestMessage | CriticalMessage | TranscriptMessage | ProtocolDraft | null {
  const msgtype = (content as { msgtype?: unknown } | null)?.msgtype;
  const schema = {
    [MsgType.KeyImage]: KeyImage,
    [MsgType.SlideRoi]: SlideRoi,
    [MsgType.Request]: RequestMessage,
    [MsgType.Critical]: CriticalMessage,
    [MsgType.Transcript]: TranscriptMessage,
    [MsgType.Report]: ProtocolDraft,
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
