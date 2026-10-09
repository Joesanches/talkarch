/**
 * Протокол между страницей хоста (РИС, ЛИС, ТМК) и фреймом чата — docs/04-embedding.md, раздел 3.
 * Файл без зависимостей: его используют SDK (в браузере хоста) и веб-клиент (во фрейме).
 */
export const PROTO = 'konsilium-chat' as const;
export const PROTO_VERSION = 1 as const;

export type Mode = 'panel' | 'launcher' | 'headless';

/** Контекст хоста: случай или исследование, открытое у пользователя. */
export interface ChatContext {
  /** Подключение РИС/ЛИС в «Консилиуме». Можно не указывать, если подключение такого типа одно — тогда нужен `system`. */
  connector?: string;
  system?: 'RIS' | 'LIS' | 'TMK';
  caseId: string;
  studyUid?: string;
}

/** Ключевой снимок из вьюера хоста («В чат исследования»). */
export interface KeyImageAttachment {
  kind: 'key_image';
  studyUid: string;
  seriesUid: string;
  sopUid: string;
  frame?: number;
  presentation?: { ww: number; wc: number; zoom?: number };
  caption?: string;
  /** Миниатюра как data:image/png;base64,… — чат загрузит её на сервер сообщений. */
  thumbnail?: string;
  /** Ссылка для открытия вне хоста (IHE IID или шаблон вьюера). */
  viewerUrl?: string;
}

/** Стекло или область препарата из ЛИС/вьюера цифровой патологии («В чат» у стекла). */
export interface SlideAttachment {
  kind: 'slide_roi';
  /** Номер или идентификатор стекла в ЛИС. */
  slideId: string;
  block?: string;
  /** Окраска: H&E, ER, HER2… */
  stain: string;
  /** Увеличение объектива для области, ×. */
  magnification: number;
  /** Область на скане (пиксели уровня `level`); без области — всё стекло. */
  region?: { x: number; y: number; w: number; h: number; level: number };
  caption?: string;
  /** Миниатюра как data:image/png;base64,… — чат загрузит её на сервер сообщений. */
  thumbnail?: string;
  /** Ссылка во вьюер вне хоста. */
  viewerUrl?: string;
}

export type Attachment = KeyImageAttachment | SlideAttachment;

export interface UnreadItem {
  connector: string;
  caseId: string;
  unread: number;
  /** Новое приглашение в чат случая, ещё не открытый. */
  invited: boolean;
  /** Критические находки, которые ждут подтверждения этого пользователя: хост показывает их отдельным, красным бейджем. */
  critical: number;
}

export type LinkOpen =
  | { kind: 'dicom'; studyUid: string; seriesUid: string; sopUid: string; frame: number; presentation?: KeyImageAttachment['presentation'] }
  | { kind: 'slide'; slideId: string; stain: string; magnification: number; region: NonNullable<SlideAttachment['region']> }
  | { kind: 'record' | 'url'; url: string };

/** Команды хоста → чат. */
export interface HostCommands {
  'context.set': ChatContext;
  'compose.attach': Attachment;
  'room.open': { focus?: 'composer' };
  'theme.set': { accent?: string };
  /** Токен доступа Matrix, полученный хостом (режим auth: token). */
  'auth.token': { accessToken: string };
  'unread.watch': { contexts: ChatContext[] };
  /** Режим launcher: окно чата открыто или свёрнуто. Свёрнутый чат не отмечает сообщения прочитанными. */
  'view.visible': { visible: boolean };
}

/** События чата → хост. */
export interface ChatEvents {
  ready: { mode: Mode; userId: string | null };
  'unread.changed': { total: number; byContext: UnreadItem[] };
  'link.open': LinkOpen;
  'auth.required': Record<string, never>;
  'context.opened': { connector: string; caseId: string; roomId: string };
  /** Пользователь свернул чат кнопкой в его заголовке (режим launcher). */
  'view.minimize': Record<string, never>;
  error: { message: string };
}

export interface Envelope<T extends string = string, P = unknown> {
  proto: typeof PROTO;
  v: typeof PROTO_VERSION;
  id: string;
  type: T;
  payload: P;
  /** Для `ack` и `error`: id команды, на которую это ответ. */
  re?: string;
}

/** Проверка формы конверта; неизвестные типы и чужие сообщения отбрасываются получателем. */
export function isEnvelope(data: unknown): data is Envelope {
  const e = data as Partial<Envelope> | null;
  return !!e && e.proto === PROTO && e.v === PROTO_VERSION && typeof e.id === 'string' && typeof e.type === 'string';
}

export function envelope<T extends string, P>(type: T, payload: P, re?: string): Envelope<T, P> {
  return { proto: PROTO, v: PROTO_VERSION, id: Math.random().toString(36).slice(2) + Date.now().toString(36), type, payload, ...(re ? { re } : {}) };
}

/** Ключ контекста для сопоставления счётчиков: «подключение:НОМЕР». */
export const contextKey = (connector: string, caseId: string) => `${connector}:${caseId.trim().toUpperCase()}`;
