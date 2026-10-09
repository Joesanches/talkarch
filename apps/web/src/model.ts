/**
 * Чистые функции модели клиента: папки, карточки заявок, подписи. Без React и matrix-js-sdk — их легко тестировать.
 */
import {
  CaseArchiveContent,
  CaseContext,
  CaseRole,
  CriticalStatusContent,
  EventType,
  MsgType,
  NotificationField,
  NotificationInfo,
  RoomType,
  type RequestStep,
} from '@konsilium/protocol';

export type Folder = 'all' | 'cases' | 'direct' | 'channels' | 'service' | 'archive';

export const FOLDERS: ReadonlyArray<{ id: Folder; label: string }> = [
  { id: 'all', label: 'Все' },
  { id: 'cases', label: 'Случаи' },
  { id: 'direct', label: 'Личные' },
  { id: 'channels', label: 'Каналы' },
  { id: 'service', label: 'Сервис' },
  // Строится не по комнатам синхронизации, а по данным сервиса контекста: из архивных чатов участники выведены.
  { id: 'archive', label: 'Архив' },
];

/** Папки, в которые попадает комната. «Все» — всегда; «Архив» — список сервиса контекста, не комнаты. */
export function foldersOf(room: { roomType?: string; isDirect: boolean }): Folder[] {
  const out: Folder[] = ['all'];
  if (room.roomType === RoomType.Case) out.push('cases');
  if (room.roomType === RoomType.Channel) out.push('channels');
  if (room.roomType === RoomType.Service) out.push('service');
  if (room.isDirect) out.push('direct');
  return out;
}

/** Событие ленты в упрощённом виде. */
export interface TimelineItem {
  eventId: string;
  type: string;
  sender: string;
  ts: number;
  content: Record<string, unknown>;
  stateKey?: string;
}

export interface RequestView {
  eventId: string;
  body: string;
  kind: string;
  items: string[];
  priority: string;
  externalId?: string;
  status?: RequestStep;
  steps: RequestStep[];
  note?: string;
}

/** Заявки в ленте и их последний статус из событий `ru.vendor.request.status` (ссылаются на заявку через m.reference). */
export function requestViews(items: TimelineItem[]): Map<string, RequestView> {
  const views = new Map<string, RequestView>();
  for (const e of items) {
    if (e.type === 'm.room.message' && e.content.msgtype === MsgType.Request) {
      const r = (e.content[MsgType.Request] ?? {}) as { kind?: string; items?: string[]; priority?: string };
      views.set(e.eventId, {
        eventId: e.eventId,
        body: String(e.content.body ?? ''),
        kind: r.kind ?? 'service',
        items: r.items ?? [],
        priority: r.priority ?? 'routine',
        steps: [],
      });
    }
  }
  for (const e of items) {
    if (e.type !== EventType.RequestStatus) continue;
    const rel = e.content['m.relates_to'] as { event_id?: string } | undefined;
    const view = rel?.event_id ? views.get(rel.event_id) : undefined;
    if (!view) continue;
    view.status = e.content.status as RequestStep;
    view.steps = (e.content.steps as RequestStep[] | undefined) ?? view.steps;
    view.externalId = String(e.content.external_id ?? view.externalId ?? '');
    view.note = (e.content.note as string | undefined) ?? undefined;
  }
  return views;
}

const stepLabels: Record<RequestStep, string> = {
  created: 'Создана',
  accepted: 'Принята',
  staining: 'Окраска',
  scanning: 'Сканирование',
  done: 'Готово',
  rejected: 'Отклонена',
};
export const stepLabel = (s: RequestStep) => stepLabels[s] ?? s;

const roleLabels: Record<CaseRole, string> = {
  pathologist: 'патоморфолог',
  radiologist: 'рентгенолог',
  attending: 'лечащий врач',
  lab_tech: 'лаборант',
  radiographer: 'рентгенолаборант',
  engineer: 'инженер',
  head: 'заведующий',
  external_consultant: 'консультант',
  on_duty: 'дежурный врач',
  viewer: 'наблюдатель',
};
export const roleLabel = (r: string) => roleLabels[r as CaseRole] ?? r;

export const systemLabel: Record<string, string> = { RIS: 'РИС', LIS: 'ЛИС', TMK: 'ТМК' };
export const priorityLabel: Record<string, string> = { routine: '', urgent: 'Срочно', cito: 'CITO' };

/** Контекст случая из state-события; битый или чужой — `null`. */
export function parseCaseContext(raw: unknown): CaseContext | null {
  const r = CaseContext.safeParse(raw);
  return r.success ? r.data : null;
}

/** Чат случая в архиве (state `ru.vendor.case.archive` от сервиса): только чтение. */
export function isArchivedState(raw: unknown): boolean {
  const r = CaseArchiveContent.safeParse(raw);
  return r.success && r.data.status === 'archived';
}

/** «в архиве с 8 окт.» */
export const archivedLabel = (iso: string) => `в архиве с ${short.format(new Date(iso))}`;

export function parseNotification(content: Record<string, unknown>): NotificationInfo | null {
  const r = NotificationInfo.safeParse(content[NotificationField]);
  return r.success ? r.data : null;
}

/** Код на аватаре случая: модальность для РИС, вид исследования для ЛИС. */
export function caseCode(ctx: Pick<CaseContext, 'source' | 'title' | 'stage'>): string {
  if (ctx.source === 'LIS') return ctx.stage === 'ihc' ? 'ИГХ' : 'ГИСТ';
  const m = ctx.title.match(/^(КТ|МРТ|ПЭТ|УЗИ|РГ|ММГ|ФЛГ)/i);
  return m ? m[1]!.toUpperCase() : ctx.source === 'TMK' ? 'ТМК' : 'ИССЛ';
}

export function initials(name: string): string {
  const parts = name.replace(/^@/, '').split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

/** Цвет аватара человека — стабильный по идентификатору (8 цветов из дизайн-системы). */
export function avatarColor(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return `var(--color-avatar-${(h % 8) + 1})`;
}

const time = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const day = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const short = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });

export const formatTime = (ts: number) => time.format(ts);
export const formatDay = (ts: number, now = Date.now()) => {
  const d = new Date(ts).toDateString();
  if (d === new Date(now).toDateString()) return 'Сегодня';
  if (d === new Date(now - 86_400_000).toDateString()) return 'Вчера';
  return day.format(ts);
};
/** Время в списке чатов: сегодня — часы, раньше — дата. */
export const formatListTime = (ts: number, now = Date.now()) =>
  new Date(ts).toDateString() === new Date(now).toDateString() ? time.format(ts) : short.format(ts);
export const formatDue = (iso: string) => `до ${short.format(new Date(iso))}, ${time.format(new Date(iso))}`;

/** Подпись последнего события в списке чатов. */
export function preview(e: TimelineItem | undefined, senderName: string, isMine: boolean): string {
  if (!e) return '';
  if (e.type === EventType.RequestStatus) return `Заявка ${e.content.external_id ?? ''}: ${stepLabel(e.content.status as RequestStep).toLowerCase()}`;
  if (e.type === 'm.room.message' && e.content.msgtype === MsgType.Critical) return `Критическая находка: ${String((e.content[MsgType.Critical] as { finding?: string } | undefined)?.finding ?? '')}`;
  if (e.type === EventType.ReportStatus) return e.content.status === 'accepted' ? 'Черновик протокола принят' : 'Черновик протокола отклонён';
  if (e.type !== 'm.room.message') return '';
  const first = String(e.content.body ?? '').split('\n')[0] ?? '';
  if (e.content.msgtype === 'm.notice') return first;
  const label: Record<string, string> = { 'm.image': 'Изображение', 'm.file': 'Файл', [MsgType.SlideRoi]: 'Препарат', [MsgType.KeyImage]: 'Ключевой снимок' };
  const kind = label[String(e.content.msgtype)];
  const body = kind ? `${kind}: ${first}` : stripReplyFallback(String(e.content.body ?? '')).split('\n')[0];
  return `${isMine ? 'Вы' : senderName.split(' ')[0]}: ${body}`;
}

/** «54 года», «61 год», «67 лет». */
export function ageLabel(n: number): string {
  const d = n % 10;
  const h = n % 100;
  const word = d === 1 && h !== 11 ? 'год' : d >= 2 && d <= 4 && (h < 12 || h > 14) ? 'года' : 'лет';
  return `${n} ${word}`;
}

const stageLabels: Record<string, string> = {
  grossing: 'Вырезка',
  processing: 'Проводка',
  staining: 'Окраска',
  ihc: 'ИГХ',
  reporting: 'Описание',
  review: 'Пересмотр',
  scheduled: 'Запланировано',
  acquired: 'Выполнено',
  archived: 'Архив',
};
export const stageLabel = (s: string) => stageLabels[s] ?? s;

export type MembershipKind = 'invite' | 'join' | 'leave' | 'revoked' | 'ban';

/** Вид изменения состава; `null` — не показывать (например, вход и профиль сервисного пользователя). */
export function membershipKind(e: TimelineItem, botUserId?: string): MembershipKind | null {
  if (e.type !== 'm.room.member' || !e.stateKey || e.stateKey === botUserId) return null;
  switch (e.content.membership) {
    case 'invite':
      return 'invite';
    case 'join':
      return 'join';
    case 'leave':
      return e.sender === e.stateKey ? 'leave' : 'revoked';
    case 'ban':
      return 'ban';
    default:
      return null;
  }
}

const membershipTitles: Record<MembershipKind, string> = {
  invite: 'Приглашение в чат',
  join: 'В чате',
  leave: 'Вышли из чата',
  revoked: 'Доступ отозван',
  ban: 'Заблокированы',
};

/** Одна строка на подряд идущие однотипные изменения: «Приглашение в чат: Смирнова А. В., Ершова Т. Н.». */
export const membershipText = (kind: MembershipKind, names: string[]) => `${membershipTitles[kind]}: ${[...new Set(names)].join(', ')}`;

/** Реакции-статусы в порядке показа (docs/05-ux.md): однозначный смысл вместо эмодзи. */
export const REACTIONS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'принято', label: 'Принято' },
  { key: 'согласен', label: 'Согласен' },
  { key: 'видел', label: 'Видел' },
  { key: 'вопрос', label: 'Вопрос' },
  { key: 'срочно', label: 'Срочно' },
];

export interface ReactionSummary {
  key: string;
  label: string;
  count: number;
  /** ID моей реакции с этим ключом — чтобы снять её. */
  mine: string | null;
}

/** Сводка реакций (m.reaction, m.annotation) по сообщениям: ключ → число отметивших и моя отметка. */
export function reactionSummaries(items: TimelineItem[], me: string): Map<string, ReactionSummary[]> {
  const byTarget = new Map<string, Map<string, { senders: Set<string>; mine: string | null }>>();
  for (const e of items) {
    if (e.type !== 'm.reaction') continue;
    const rel = e.content['m.relates_to'] as { rel_type?: string; event_id?: string; key?: string } | undefined;
    if (rel?.rel_type !== 'm.annotation' || !rel.event_id || !rel.key) continue;
    const keys = byTarget.get(rel.event_id) ?? new Map();
    const entry = keys.get(rel.key) ?? { senders: new Set<string>(), mine: null };
    entry.senders.add(e.sender);
    if (e.sender === me) entry.mine = e.eventId;
    keys.set(rel.key, entry);
    byTarget.set(rel.event_id, keys);
  }
  const order = (k: string) => {
    const i = REACTIONS.findIndex((r) => r.key === k);
    return i < 0 ? REACTIONS.length : i;
  };
  const out = new Map<string, ReactionSummary[]>();
  for (const [target, keys] of byTarget) {
    out.set(
      target,
      [...keys.entries()]
        .sort(([a], [b]) => order(a) - order(b))
        .map(([key, v]) => ({ key, label: REACTIONS.find((r) => r.key === key)?.label ?? key, count: v.senders.size, mine: v.mine })),
    );
  }
  return out;
}

export interface ReportDecision {
  status: 'accepted' | 'rejected';
  sender: string;
  ts: number;
}

/**
 * Решение по черновику (`ru.vendor.report.status` со ссылкой m.reference): действует первое.
 * Повторное решение после принятия не меняет итог — исправления оформляются новым документом.
 */
export function reportDecisions(items: TimelineItem[]): Map<string, ReportDecision> {
  const out = new Map<string, ReportDecision>();
  for (const e of items) {
    if (e.type !== EventType.ReportStatus) continue;
    const rel = e.content['m.relates_to'] as { rel_type?: string; event_id?: string } | undefined;
    const status = e.content.status;
    if (rel?.rel_type !== 'm.reference' || !rel.event_id || (status !== 'accepted' && status !== 'rejected')) continue;
    if (!out.has(rel.event_id)) out.set(rel.event_id, { status, sender: e.sender, ts: e.ts });
  }
  return out;
}

/** Смещение от начала звонка: «4:05». */
export function offsetLabel(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Кто может отправить критическую находку (так же проверяет сервис контекста). */
export const CRITICAL_REPORTER_ROLES: ReadonlySet<string> = new Set(['radiologist', 'pathologist', 'head']);

/**
 * Статусы критических находок комнаты (state `ru.vendor.critical.status`, ключ — ID находки).
 * Принимаются только от создателя комнаты — сервиса контекста: подтверждение от остальных ничего не значит.
 */
export function criticalStatuses(states: Array<{ stateKey: string; sender: string; content: unknown }>, service: string | null): Map<string, CriticalStatusContent> {
  const out = new Map<string, CriticalStatusContent>();
  for (const s of states) {
    if (!service || s.sender !== service) continue;
    const parsed = CriticalStatusContent.safeParse(s.content);
    if (parsed.success) out.set(s.stateKey, parsed.data);
  }
  return out;
}

/** Неподтверждённые находки, которые ждут именно меня. */
export function criticalWaitingFor(statuses: Map<string, CriticalStatusContent>, me: string): string[] {
  return [...statuses.entries()]
    .filter(([, s]) => s.status === 'pending' && s.recipients.includes(me))
    .sort(([, a], [, b]) => Date.parse(a.deadline_at) - Date.parse(b.deadline_at))
    .map(([id]) => id);
}

/** Обратный отсчёт до срока: «осталось 7:43» или «просрочено 2:10». */
export function countdown(deadlineIso: string, now = Date.now()): { text: string; overdue: boolean } {
  const ms = Date.parse(deadlineIso) - now;
  const total = Math.floor(Math.abs(ms) / 1000);
  const mm = Math.floor(total / 60);
  const ss = String(total % 60).padStart(2, '0');
  return ms >= 0 ? { text: `осталось ${mm}:${ss}`, overdue: false } : { text: `просрочено ${mm}:${ss}`, overdue: true };
}

/** «45 с», «2 мин 13 с», «1 ч 5 мин». */
export function delayLabel(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} с`;
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)} мин ${s % 60} с` : `${s / 60} мин`;
  const m = Math.round((s % 3600) / 60);
  return m ? `${Math.floor(s / 3600)} ч ${m} мин` : `${Math.floor(s / 3600)} ч`;
}

// ── Ответы, вложения, поиск ─────────────────────────────────────────────────

/** ID сообщения, на которое отвечают (`m.relates_to.m.in_reply_to`). */
export function replyTarget(content: Record<string, unknown>): string | null {
  const rel = content['m.relates_to'] as { 'm.in_reply_to'?: { event_id?: unknown } } | undefined;
  const id = rel?.['m.in_reply_to']?.event_id;
  return typeof id === 'string' && id ? id : null;
}

/** Старые клиенты дописывают цитату в начало текста («> <@user> …» и пустая строка) — её не показываем. */
export function stripReplyFallback(body: string): string {
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && lines[i]!.startsWith('> ')) i++;
  if (i === 0) return body;
  if (lines[i] === '') i++;
  return lines.slice(i).join('\n');
}

/** Текст цитаты: первая строка сообщения; вложения и структурные сообщения — понятной подписью. */
export function quoteText(e: TimelineItem | undefined): string {
  if (!e) return 'Сообщение недоступно';
  if (e.type !== 'm.room.message') return preview(e, '', false) || 'Событие';
  const body = stripReplyFallback(String(e.content.body ?? '')).split('\n')[0] ?? '';
  switch (e.content.msgtype) {
    case 'm.image':
      return `Изображение: ${body}`;
    case 'm.file':
      return `Файл: ${body}`;
    case MsgType.SlideRoi:
      return `Препарат: ${body}`;
    case MsgType.KeyImage:
      return `Ключевой снимок: ${body}`;
    case MsgType.Critical:
      return preview(e, '', false);
    default:
      return body;
  }
}

/** «12 Б», «340 КБ», «1,2 МБ». */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} КБ`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1).replace('.', ',') : Math.round(mb)} МБ`;
}

/** Исполняемые файлы и скрипты в клинический чат не отправляются. */
const BLOCKED_EXT = /\.(exe|msi|bat|cmd|com|scr|pif|ps1|vbs|vbe|js|jse|wsf|jar|sh|dll|lnk|hta|reg)$/i;

/** Почему файл нельзя отправить; `null` — можно. */
export function attachmentProblem(file: { name: string; size: number }, maxBytes: number): string | null {
  if (BLOCKED_EXT.test(file.name)) return `«${file.name}»: исполняемые файлы и скрипты отправлять нельзя`;
  if (file.size === 0) return `«${file.name}»: пустой файл`;
  if (file.size > maxBytes) return `«${file.name}»: больше ${formatSize(maxBytes)}`;
  return null;
}

/** Части текста с подсветкой найденных слов (поиск по сообщениям). Совпадение — по началу слова, без учёта регистра. */
export function highlightParts(text: string, terms: string[]): Array<{ text: string; hit: boolean }> {
  const words = [...new Set(terms.map((t) => t.trim()).filter((t) => t.length > 0))].sort((a, b) => b.length - a.length);
  if (!words.length) return [{ text, hit: false }];
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${escaped.join('|')})[\\p{L}\\p{N}]*`, 'giu');
  const out: Array<{ text: string; hit: boolean }> = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index), hit: false });
    out.push({ text: m[0], hit: true });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out;
}

/** Фрагмент длинного сообщения вокруг первого совпадения — для строки результата поиска. */
export function snippet(text: string, terms: string[], width = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= width) return flat;
  const lower = flat.toLowerCase();
  const at = Math.min(...terms.map((t) => lower.indexOf(t.toLowerCase())).filter((i) => i >= 0), Number.MAX_SAFE_INTEGER);
  if (at === Number.MAX_SAFE_INTEGER || at < width / 2) return `${flat.slice(0, width - 1)}…`;
  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(flat.length, start + width - 2);
  return `…${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/** «Колесников Д. А. печатает…», «Смирнова А. В. и Ершова Т. Н. печатают…», «3 участника печатают…». */
export function typingText(names: string[]): string | null {
  if (!names.length) return null;
  if (names.length === 1) return `${names[0]} печатает…`;
  if (names.length === 2) return `${names[0]} и ${names[1]} печатают…`;
  return `${names.length} участника печатают…`;
}

/**
 * Где поставить разделитель «Непрочитанные сообщения»: перед первым чужим сообщением после отметки о прочтении.
 * Отметки нет в загруженной ленте — по счётчику непрочитанного с конца. `null` — разделитель не нужен.
 */
export function firstUnreadIndex(items: TimelineItem[], me: string, readUpTo: string | null, unreadCount: number): number | null {
  const isUnreadCandidate = (e: TimelineItem) => e.type === 'm.room.message' && e.sender !== me;
  const at = readUpTo ? items.findIndex((e) => e.eventId === readUpTo) : -1;
  if (at >= 0) {
    const i = items.findIndex((e, k) => k > at && isUnreadCandidate(e));
    return i >= 0 ? i : null;
  }
  if (unreadCount <= 0) return null;
  let left = unreadCount;
  for (let i = items.length - 1; i >= 0; i--) {
    if (!isUnreadCandidate(items[i]!)) continue;
    if (--left === 0) return i;
  }
  return null;
}
