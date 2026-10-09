import { createSign, sign } from 'node:crypto';
import type { PushKind, PushSignal } from '@konsilium/protocol/push';
import type { Texts } from '../config.ts';

/** `invalid` — токен устройства больше не действует: шлюз вернёт pushkey серверу сообщений в `rejected`. */
export type SendResult = 'ok' | 'invalid' | 'failed';

export interface PushProvider {
  readonly name: 'apns' | 'fcm' | 'rustore';
  send(token: string, signal: PushSignal): Promise<SendResult>;
}

export const textFor = (texts: Texts, kind: PushKind) => (kind === 'critical' ? texts.critical : kind === 'call' ? texts.call : texts.message);

/** Сигнал как словарь строк — так данные принимают FCM и RuStore. Содержимого сообщения в нём нет. */
export function signalData(s: PushSignal): Record<string, string> {
  return {
    id: s.id,
    kind: s.kind,
    prio: s.prio,
    ...(s.room_id ? { room_id: s.room_id } : {}),
    ...(s.event_id ? { event_id: s.event_id } : {}),
    ...(s.unread !== undefined ? { unread: String(s.unread) } : {}),
  };
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** JWT, подписанный ES256 (APNs) или RS256 (сервисный аккаунт Google). */
export function signJwt(alg: 'ES256' | 'RS256', header: Record<string, string>, claims: Record<string, unknown>, keyPem: string): string {
  const input = `${b64url(JSON.stringify({ alg, typ: 'JWT', ...header }))}.${b64url(JSON.stringify(claims))}`;
  const signature =
    alg === 'ES256' ? sign('sha256', Buffer.from(input), { key: keyPem, dsaEncoding: 'ieee-p1363' }) : createSign('RSA-SHA256').update(input).sign(keyPem);
  return `${input}.${b64url(signature)}`;
}
