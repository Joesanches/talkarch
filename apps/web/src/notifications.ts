/**
 * Уведомления браузера, пока вкладка открыта (docs/03-architecture.md, раздел 6.3). Строятся из собственной синхронизации
 * клиента, без push-шлюза: Web Push в браузерах идёт через сервисы их производителей и в закрытом контуре недоступен.
 *
 * По умолчанию — без имён и текста, как push на телефоне: «Новое сообщение», «Критическая находка — требуется
 * подтверждение», «Входящий звонок». Название чата, отправитель и текст — только если организация включила
 * `"notificationPreview": "full"` в config.json.
 */
import { ClientEvent, RoomEvent, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { EventType, MsgType, type CriticalStatusContent } from '@konsilium/protocol';
import { CallInviteContent } from '@konsilium/protocol/push';
import { roomCriticals, toItem } from './matrix.ts';
import { criticalWaitingFor, preview, type TimelineItem } from './model.ts';

export type NoticeKind = 'message' | 'critical' | 'call';
export type NotificationPreview = 'none' | 'full';

export const GENERIC = {
  title: 'Консилиум',
  message: 'Новое сообщение',
  critical: 'Критическая находка — требуется подтверждение',
  call: 'Входящий звонок',
} as const;

/**
 * Уведомляем о новом — о том, что случилось после открытия вкладки: первая синхронизация приносит и последние события.
 * Время событий — по часам сервера: если часы компьютера спешат, уведомления первых секунд могут не прийти. Сообщения
 * старше `MAX_AGE_MS` (переподключение после сна) тоже не уведомляют.
 */
const MAX_AGE_MS = 120_000;

/** Уведомить ли о событии ленты и как. Находки — не здесь: по статусу (`criticalNotices`), он есть и в приглашении. */
export function timelineNotice(e: TimelineItem, me: string, openedAt: number, now: number): NoticeKind | null {
  if (e.sender === me || e.ts < openedAt || now - e.ts > MAX_AGE_MS) return null;
  if (e.type === EventType.CallInvite) {
    const invite = CallInviteContent.safeParse(e.content);
    return invite.success && now - e.ts < invite.data.lifetime ? 'call' : null;
  }
  if (e.type !== 'm.room.message' || e.content.msgtype === 'm.notice' || e.content.msgtype === MsgType.Critical) return null;
  return 'message';
}

/**
 * Находки, которые стали ждать меня после открытия вкладки: адресата — с отправки, подключённого эскалацией — с момента
 * эскалации. Висевшие до открытия не уведомляют: их видно в списке и полосой над лентой.
 */
export function criticalNotices(statuses: Map<string, CriticalStatusContent>, me: string, openedAt: number): string[] {
  return criticalWaitingFor(statuses, me).filter((id) => {
    const s = statuses.get(id)!;
    const escalated = s.escalations.find((x) => x.users.includes(me));
    return Date.parse(escalated?.at ?? s.raised_at) >= openedAt;
  });
}

/** Заголовок и текст уведомления. */
export function noticeText(kind: NoticeKind, mode: NotificationPreview, ctx: { roomName?: string; line?: string; caller?: string } = {}) {
  if (mode === 'none' || !ctx.roomName) return { title: GENERIC.title, body: GENERIC[kind] };
  if (kind === 'message') return { title: ctx.roomName, body: ctx.line || GENERIC.message };
  if (kind === 'call') return { title: ctx.roomName, body: ctx.caller ? `${GENERIC.call}: ${ctx.caller}` : GENERIC.call };
  return { title: ctx.roomName, body: GENERIC.critical };
}

export interface NotifierOptions {
  me: string;
  preview: NotificationPreview;
  /** Вкладка на экране и в фокусе. */
  attending: () => boolean;
  /** Открытый сейчас чат. */
  selected: () => string | null;
  /** Открыть чат по щелчку на уведомлении. */
  open: (roomId: string) => void;
  now?: () => number;
}

/**
 * Показывать уведомления: о сообщении — если вкладка не на экране или не в фокусе; о находке и звонке — ещё и если
 * открыт другой чат. Каждое событие — не больше одного раза. Возвращает функцию отключения.
 */
export function installNotifications(client: MatrixClient, opts: NotifierOptions): () => void {
  if (typeof Notification === 'undefined') return () => {};
  const now = opts.now ?? Date.now;
  const openedAt = now();
  const shown = new Set<string>();

  const show = (key: string, roomId: string, kind: NoticeKind, ctx: Parameters<typeof noticeText>[2]) => {
    if (shown.has(key)) return;
    shown.add(key);
    if (Notification.permission !== 'granted') return;
    if (opts.attending() && (kind === 'message' || opts.selected() === roomId)) return;
    const { title, body } = noticeText(kind, opts.preview, ctx);
    const n = new Notification(title, { body, tag: `${kind}:${roomId}`, requireInteraction: kind !== 'message' });
    n.onclick = () => {
      window.focus();
      opts.open(roomId);
      n.close();
    };
  };

  const onTimeline = (ev: MatrixEvent, room: Room | undefined, toStartOfTimeline: boolean | undefined) => {
    if (toStartOfTimeline || !room || !ev.getId()) return;
    const item = toItem(ev);
    const kind = timelineNotice(item, opts.me, openedAt, now());
    if (!kind) return;
    const sender = room.getMember(item.sender)?.name ?? item.sender;
    show(item.eventId, room.roomId, kind, { roomName: room.name, line: preview(item, sender, false), caller: sender });
  };
  const onSync = () => {
    for (const room of client.getRooms()) {
      const m = room.getMyMembership();
      if (m !== 'join' && m !== 'invite') continue;
      for (const id of criticalNotices(roomCriticals(room), opts.me, openedAt)) show(`critical:${id}`, room.roomId, 'critical', { roomName: room.name });
    }
  };
  client.on(RoomEvent.Timeline, onTimeline);
  client.on(ClientEvent.Sync, onSync);
  return () => {
    client.off(RoomEvent.Timeline, onTimeline);
    client.off(ClientEvent.Sync, onSync);
  };
}
