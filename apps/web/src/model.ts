/**
 * Чистые функции модели клиента: папки, карточки заявок, подписи. Без React и matrix-js-sdk — их легко тестировать.
 */
import { CaseContext, CaseRole, EventType, MsgType, NotificationField, NotificationInfo, RoomType, type RequestStep } from '@konsilium/protocol';

export type Folder = 'all' | 'cases' | 'direct' | 'channels' | 'service';

export const FOLDERS: ReadonlyArray<{ id: Folder; label: string }> = [
  { id: 'all', label: 'Все' },
  { id: 'cases', label: 'Случаи' },
  { id: 'direct', label: 'Личные' },
  { id: 'channels', label: 'Каналы' },
  { id: 'service', label: 'Сервис' },
];

/** Папки, в которые попадает комната. «Все» — всегда. */
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
  if (e.type !== 'm.room.message') return '';
  const body = String(e.content.body ?? '').split('\n')[0] ?? '';
  if (e.content.msgtype === 'm.notice') return body;
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
