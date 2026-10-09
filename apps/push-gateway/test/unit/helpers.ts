import { randomBytes } from 'node:crypto';
import type { PushSignal } from '@konsilium/protocol/push';
import { buildApp } from '../../src/app.ts';
import type { ExternalPolicy } from '../../src/config.ts';
import type { PushProvider, SendResult } from '../../src/providers/types.ts';

export const newPushkey = () => randomBytes(32).toString('base64url');

/** Внешний сервис-заглушка: запоминает сигналы, отвечает заданным результатом. */
export class FakeProvider implements PushProvider {
  readonly sent: Array<{ token: string; signal: PushSignal }> = [];
  result: SendResult = 'ok';
  constructor(readonly name: PushProvider['name']) {}
  async send(token: string, signal: PushSignal) {
    this.sent.push({ token, signal });
    return this.result;
  }
}

export async function startGateway(external: ExternalPolicy, opts: { ackTimeoutMs?: number } = {}) {
  const providers = { rustore: new FakeProvider('rustore'), apns: new FakeProvider('apns') };
  const { app, counts } = buildApp({ config: { external, ackTimeoutMs: opts.ackTimeoutMs ?? 2000, heartbeatMs: 60_000 }, providers });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  return { app, base, providers, counts, close: () => app.close() };
}

/** Прямое соединение, как у приложения: поток SSE, события по очереди. */
export async function connect(base: string, pushkey: string) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/v1/connect`, { headers: { authorization: `Bearer ${pushkey}` }, signal: ctrl.signal });
  const queue: Array<{ event: string; data: unknown }> = [];
  const waiters: Array<() => void> = [];
  let ended = false;
  const done = (async () => {
    if (!res.body) return;
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk as Uint8Array, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (event) queue.push({ event, data: data ? JSON.parse(data) : null });
          waiters.splice(0).forEach((w) => w());
        }
      }
    } catch {
      /* соединение закрыто */
    }
    ended = true;
    waiters.splice(0).forEach((w) => w());
  })();
  async function next(event: string, timeoutMs = 5000): Promise<unknown> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const i = queue.findIndex((e) => e.event === event);
      if (i >= 0) return queue.splice(i, 1)[0]!.data;
      if (ended) throw new Error(`соединение закрыто, события ${event} нет`);
      if (Date.now() > until) throw new Error(`нет события ${event} за ${timeoutMs} мс`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }
  await next('ready');
  return { status: res.status, next, ended: () => ended, done, close: () => ctrl.abort() };
}

export function notify(base: string, body: unknown) {
  return fetch(`${base}/_matrix/push/v1/notify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

export const ack = (base: string, pushkey: string, id: string) =>
  fetch(`${base}/v1/ack`, { method: 'POST', headers: { authorization: `Bearer ${pushkey}`, 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
