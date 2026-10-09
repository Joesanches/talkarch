import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ExternalTarget, PUSH_EXTERNAL_KEY, PUSHKEY_PATTERN, pushKind, type PushSignal } from '@konsilium/protocol/push';
import type { ExternalPolicy } from './config.ts';
import type { DirectHub } from './hub.ts';
import type { PushProvider } from './providers/types.ts';

/**
 * Запрос сервера сообщений по Matrix Push Gateway API (`POST /_matrix/push/v1/notify`). Из него берём только
 * идентификаторы, тип события, приоритет, счётчик и настройки правил; содержимое, имя отправителя и название комнаты,
 * если сервер их прислал, отбрасываются при разборе и никуда не уходят.
 */
const Device = z.object({
  app_id: z.string(),
  pushkey: z.string(),
  pushkey_ts: z.number().optional(),
  data: z.record(z.unknown()).nullish(),
  tweaks: z.record(z.unknown()).nullish(),
});
export const NotifyRequest = z.object({
  notification: z.object({
    event_id: z.string().optional(),
    room_id: z.string().optional(),
    type: z.string().optional(),
    prio: z.enum(['high', 'low']).optional(),
    counts: z.object({ unread: z.number().int().nonnegative().optional() }).passthrough().optional(),
    devices: z.array(Device).min(1),
  }),
});
export type NotifyRequest = z.infer<typeof NotifyRequest>;

export type Channel = 'direct' | 'apns' | 'fcm' | 'rustore' | 'dropped';

export interface DeliveryDeps {
  hub: DirectHub;
  providers: Partial<Record<PushProvider['name'], PushProvider>>;
  external: ExternalPolicy;
  ackTimeoutMs: number;
  onDelivered?: (channel: Channel, signal: PushSignal) => void;
}

/** Можно ли отправить сигнал внешним сервисом при этой политике организации. */
export function externalAllowed(policy: ExternalPolicy, s: PushSignal): boolean {
  if (policy === 'all') return true;
  return policy === 'critical' && (s.kind === 'critical' || s.kind === 'call');
}

/**
 * Доставить уведомление на устройства. Сначала — прямое соединение; нет его или нет подтверждения — внешний сервис
 * устройства, если политика разрешает. Возвращает pushkey устройств с недействительным токеном (`rejected`): сервер
 * сообщений удалит их pusher-ы, приложение зарегистрирует новый при следующем запуске.
 */
export async function deliver(req: NotifyRequest, deps: DeliveryDeps): Promise<string[]> {
  const n = req.notification;
  const rejected: string[] = [];
  await Promise.all(
    n.devices.map(async (d) => {
      const kind = pushKind({ event_id: n.event_id, type: n.type, tweaks: d.tweaks });
      const signal: PushSignal = {
        id: randomUUID(),
        kind,
        prio: kind === 'critical' || kind === 'call' || n.prio === 'high' ? 'high' : 'low',
        ...(n.room_id ? { room_id: n.room_id } : {}),
        ...(n.event_id ? { event_id: n.event_id } : {}),
        ...(n.counts?.unread !== undefined ? { unread: n.counts.unread } : {}),
      };
      if (PUSHKEY_PATTERN.test(d.pushkey) && (await deps.hub.deliver(d.pushkey, signal, deps.ackTimeoutMs)) === 'acked') {
        deps.onDelivered?.('direct', signal);
        return;
      }
      const target = ExternalTarget.safeParse(d.data?.[PUSH_EXTERNAL_KEY]);
      const provider = target.success ? deps.providers[target.data.provider] : undefined;
      if (!target.success || !provider || !externalAllowed(deps.external, signal)) {
        deps.onDelivered?.('dropped', signal);
        return;
      }
      const result = await provider.send(target.data.token, signal).catch(() => 'failed' as const);
      if (result === 'invalid') rejected.push(d.pushkey);
      deps.onDelivered?.(result === 'ok' ? provider.name : 'dropped', signal);
    }),
  );
  return rejected;
}
