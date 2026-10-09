import type { PushSignal } from '@konsilium/protocol/push';
import type { ServiceAccount } from '../config.ts';
import { signJwt, signalData, type PushProvider, type SendResult } from './types.ts';

export interface FcmOptions {
  url: string;
  account: ServiceAccount;
  now?: () => number;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/**
 * FCM HTTP v1. Только сообщение с данными (`data`): уведомление с общим текстом строит само приложение — так политика
 * экрана блокировки остаётся на устройстве, а Google не видит даже общий текст. Звонок и находка — высокий приоритет.
 */
export class FcmProvider implements PushProvider {
  readonly name = 'fcm' as const;
  private access: { token: string; until: number } | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: FcmOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Токен доступа OAuth 2.0 по ключу сервисного аккаунта (JWT bearer), с запасом в минуту до истечения. */
  private async accessToken(): Promise<string> {
    if (this.access && this.now() < this.access.until) return this.access.token;
    const iat = Math.floor(this.now() / 1000);
    const { client_email, private_key, token_uri } = this.opts.account;
    const assertion = signJwt('RS256', {}, { iss: client_email, scope: SCOPE, aud: token_uri, iat, exp: iat + 3600 }, private_key);
    const res = await fetch(token_uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    if (!res.ok) throw new Error(`FCM: токен доступа не получен (${res.status})`);
    const json = (await res.json()) as { access_token: string; expires_in?: number };
    this.access = { token: json.access_token, until: this.now() + ((json.expires_in ?? 3600) - 60) * 1000 };
    return json.access_token;
  }

  async send(token: string, s: PushSignal): Promise<SendResult> {
    let access: string;
    try {
      access = await this.accessToken();
    } catch {
      return 'failed';
    }
    const res = await fetch(`${this.opts.url}/v1/projects/${encodeURIComponent(this.opts.account.project_id)}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          token,
          data: signalData(s),
          android: { priority: s.prio === 'high' && s.kind !== 'badge' ? 'HIGH' : 'NORMAL', ttl: s.kind === 'call' ? '60s' : '3600s' },
        },
      }),
    }).catch(() => null);
    if (!res) return 'failed';
    if (res.ok) return 'ok';
    if (res.status === 401) this.access = null;
    const err = (await res.json().catch(() => ({}))) as { error?: { details?: Array<{ errorCode?: string }> } };
    if (res.status === 404 || err.error?.details?.some((d) => d.errorCode === 'UNREGISTERED')) return 'invalid';
    return 'failed';
  }
}
