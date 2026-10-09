/**
 * Push в контуре (docs/03-architecture.md, раздел 6): договорённости сервера сообщений, push-шлюза (apps/push-gateway)
 * и клиентов. Содержимого сообщений в push нет — только идентификаторы, вид и приоритет.
 */
import { z } from 'zod';
import { CallState, EventType, MsgType, NS } from './index.ts';

/** `app_id` pusher-а: по нему шлюз отличает платформу. */
export const PushAppId = {
  Android: `${NS}.konsilium.android`,
  Ios: `${NS}.konsilium.ios`,
} as const;

/**
 * Pushkey прямого канала — случайный секрет устройства (не меньше 32 символов base64url). Им приложение открывает
 * прямое соединение со шлюзом; знающий его получает сигналы этого устройства (без содержимого).
 */
export const PUSHKEY_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

/** Внешний канал устройства — в `data` pusher-а под этим ключом: сервис и токен устройства в нём. */
export const PUSH_EXTERNAL_KEY = `${NS}.external` as const;
export const ExternalTarget = z.object({ provider: z.enum(['apns', 'fcm', 'rustore']), token: z.string().min(8).max(4096) });
export type ExternalTarget = z.infer<typeof ExternalTarget>;

/**
 * Вид уведомления: критическую находку помечает настройка `sound` из правил push (содержимое сообщения шлюзу не
 * передаётся, `msgtype` ему не виден), звонок — тип события. Формат pusher-а — обычный, не `event_id_only`: в нём Synapse
 * не передаёт ни тип события, ни настройки правил. Содержимое сервер шлюзу не отдаёт (Synapse — `push.include_content:
 * false`), а шлюз пропускает дальше только идентификаторы, вид и приоритет.
 */
export const PushSound = {
  Critical: `${NS}.critical`,
  Call: `${NS}.call`,
} as const;

export const PushKind = z.enum(['message', 'critical', 'call', 'badge']);
export type PushKind = z.infer<typeof PushKind>;

/** Сигнал от шлюза приложению (прямой канал, а во внешних сервисах — те же поля в `data`). */
export const PushSignal = z.object({
  id: z.string().min(1),
  kind: PushKind,
  prio: z.enum(['high', 'low']),
  room_id: z.string().optional(),
  event_id: z.string().optional(),
  /** Непрочитанные — для значка на иконке приложения. */
  unread: z.number().int().nonnegative().optional(),
});
export type PushSignal = z.infer<typeof PushSignal>;

/** Вид уведомления по типу события и настройкам правила push; без события — только счётчик для значка. */
export function pushKind(n: { event_id?: string; type?: string; tweaks?: Record<string, unknown> | null }): PushKind {
  if (!n.event_id) return 'badge';
  if (n.tweaks?.sound === PushSound.Critical) return 'critical';
  if (n.type === EventType.CallInvite || n.tweaks?.sound === PushSound.Call) return 'call';
  return 'message';
}

export interface PushRule {
  rule_id: string;
  conditions: Array<{ kind: 'event_match'; key: string; pattern: string }>;
  actions: Array<string | { set_tweak: string; value?: string | boolean }>;
}

/**
 * Правила push, которые приложение ставит пользователю вместе с pusher-ом (`PUT /pushrules/global/override/{rule_id}`):
 * критическая находка и начало звонка помечаются своим `sound`, по нему шлюз выбирает высокий приоритет и текст.
 */
export const PUSH_RULES: readonly PushRule[] = [
  {
    rule_id: `${NS}.critical`,
    conditions: [
      { kind: 'event_match', key: 'type', pattern: 'm.room.message' },
      { kind: 'event_match', key: 'content.msgtype', pattern: MsgType.Critical },
    ],
    actions: ['notify', { set_tweak: 'sound', value: PushSound.Critical }, { set_tweak: 'highlight' }],
  },
  {
    rule_id: `${NS}.call`,
    conditions: [{ kind: 'event_match', key: 'type', pattern: EventType.CallInvite }],
    actions: ['notify', { set_tweak: 'sound', value: PushSound.Call }],
  },
];

/** `ru.vendor.call.invite` — начало звонка в ленте комнаты (по нему push «Входящий звонок»); состояние звонка — `ru.vendor.call`. */
export const CallInviteContent = z.object({
  call_id: z.string().min(1),
  kind: CallState.shape.kind,
  /** Сколько миллисекунд вызов актуален: позже приложение не показывает «Входящий звонок». */
  lifetime: z.number().int().positive(),
});
export type CallInviteContent = z.infer<typeof CallInviteContent>;
