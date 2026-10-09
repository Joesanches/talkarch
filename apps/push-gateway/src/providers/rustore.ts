import type { PushSignal } from '@konsilium/protocol/push';
import { signalData, type PushProvider, type SendResult } from './types.ts';

export interface RuStoreOptions {
  url: string;
  projectId: string;
  serviceToken: string;
}

/**
 * RuStore Push: `POST /v1/projects/{project_id}/messages:send` с сервисным токеном — запрос по образцу FCM v1. Только
 * данные (`data`), уведомление с общим текстом строит приложение. Недействительный токен RuStore возвращает как
 * 400 INVALID_ARGUMENT — тот же ответ бывает и при ошибке в запросе, поэтому недействительным считаем только 404:
 * лишний pusher хуже, чем потерянный.
 */
export class RuStoreProvider implements PushProvider {
  readonly name = 'rustore' as const;

  constructor(private readonly opts: RuStoreOptions) {}

  async send(token: string, s: PushSignal): Promise<SendResult> {
    const res = await fetch(`${this.opts.url}/v1/projects/${encodeURIComponent(this.opts.projectId)}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.opts.serviceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { token, data: signalData(s) } }),
    }).catch(() => null);
    if (!res) return 'failed';
    if (res.ok) return 'ok';
    return res.status === 404 ? 'invalid' : 'failed';
  }
}
