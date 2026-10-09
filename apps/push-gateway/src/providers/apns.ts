import { connect, constants, type ClientHttp2Session } from 'node:http2';
import type { PushSignal } from '@konsilium/protocol/push';
import type { Texts } from '../config.ts';
import { signJwt, textFor, type PushProvider, type SendResult } from './types.ts';

export interface ApnsOptions {
  url: string;
  keyPem: string;
  keyId: string;
  teamId: string;
  /** bundle ID приложения. */
  topic: string;
  texts: Texts;
  now?: () => number;
}

/** Токен провайдера APNs живёт до часа; Apple просит обновлять не чаще раза в 20 минут. */
const JWT_TTL_MS = 40 * 60_000;
const DEVICE_TOKEN = /^[0-9a-fA-F]{64,200}$/;

/**
 * APNs по HTTP/2 с токеном провайдера (ключ .p8). Уведомление — общий текст по виду сигнала, без отправителя и текста
 * сообщения; критическая находка и звонок — `time-sensitive`. Значок — число непрочитанных.
 */
export class ApnsProvider implements PushProvider {
  readonly name = 'apns' as const;
  private session: ClientHttp2Session | null = null;
  private jwt: { value: string; at: number } | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: ApnsOptions) {
    this.now = opts.now ?? Date.now;
  }

  private token(): string {
    if (!this.jwt || this.now() - this.jwt.at > JWT_TTL_MS) {
      const at = this.now();
      this.jwt = { value: signJwt('ES256', { kid: this.opts.keyId }, { iss: this.opts.teamId, iat: Math.floor(at / 1000) }, this.opts.keyPem), at };
    }
    return this.jwt.value;
  }

  private client(): ClientHttp2Session {
    if (!this.session || this.session.closed || this.session.destroyed) {
      const s = connect(this.opts.url);
      s.on('error', () => s.destroy());
      s.on('goaway', () => s.close());
      s.unref();
      this.session = s;
    }
    return this.session;
  }

  payload(s: PushSignal): Record<string, unknown> {
    const badge = s.unread !== undefined ? { badge: s.unread } : {};
    if (s.kind === 'badge') return { aps: badge };
    const urgent = s.kind === 'critical' || s.kind === 'call';
    return {
      aps: {
        alert: { title: this.opts.texts.title, body: textFor(this.opts.texts, s.kind) },
        sound: 'default',
        ...badge,
        'interruption-level': urgent ? 'time-sensitive' : 'active',
      },
      kind: s.kind,
      ...(s.room_id ? { room_id: s.room_id } : {}),
      ...(s.event_id ? { event_id: s.event_id } : {}),
    };
  }

  send(token: string, s: PushSignal): Promise<SendResult> {
    if (!DEVICE_TOKEN.test(token)) return Promise.resolve('invalid');
    const body = JSON.stringify(this.payload(s));
    // Вызов устаревает за минуту, сообщение — за час: позже такое уведомление уже не нужно.
    const expiration = Math.floor(this.now() / 1000) + (s.kind === 'call' ? 60 : 3600);
    return new Promise((resolve) => {
      let req;
      try {
        req = this.client().request({
          [constants.HTTP2_HEADER_METHOD]: 'POST',
          [constants.HTTP2_HEADER_PATH]: `/3/device/${token}`,
          authorization: `bearer ${this.token()}`,
          'apns-topic': this.opts.topic,
          'apns-push-type': 'alert',
          'apns-priority': s.prio === 'high' && s.kind !== 'badge' ? '10' : '5',
          'apns-expiration': String(expiration),
          'content-type': 'application/json',
        });
      } catch {
        resolve('failed');
        return;
      }
      let status = 0;
      let text = '';
      req.setEncoding('utf8');
      req.on('response', (h) => (status = Number(h[constants.HTTP2_HEADER_STATUS])));
      req.on('data', (c: string) => (text += c));
      req.on('error', () => resolve('failed'));
      req.on('end', () => {
        if (status === 200) return resolve('ok');
        const reason = (() => {
          try {
            return String((JSON.parse(text) as { reason?: string }).reason ?? '');
          } catch {
            return '';
          }
        })();
        if (status === 410 || reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic' || reason === 'Unregistered') return resolve('invalid');
        if (reason === 'ExpiredProviderToken') this.jwt = null;
        resolve('failed');
      });
      req.end(body);
    });
  }

  close() {
    this.session?.close();
  }
}
