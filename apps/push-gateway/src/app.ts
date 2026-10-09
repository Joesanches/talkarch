import Fastify, { type FastifyRequest } from 'fastify';
import { PUSHKEY_PATTERN, type PushSignal } from '@konsilium/protocol/push';
import type { Config } from './config.ts';
import { DirectHub } from './hub.ts';
import { deliver, NotifyRequest, type Channel } from './notify.ts';
import type { PushProvider } from './providers/types.ts';

export interface AppDeps {
  config: Pick<Config, 'external' | 'ackTimeoutMs' | 'heartbeatMs'>;
  providers: Partial<Record<PushProvider['name'], PushProvider>>;
  hub?: DirectHub;
  logger?: boolean;
}

/** Pushkey устройства из `Authorization: Bearer …`. */
function pushkeyOf(req: FastifyRequest): string | null {
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
  return m && PUSHKEY_PATTERN.test(m[1]!) ? m[1]! : null;
}

/**
 * Маршруты шлюза:
 * - `POST /_matrix/push/v1/notify` — для сервера сообщений (только внутренняя сеть, наружу не публикуется);
 * - `GET /v1/connect` — прямое соединение приложения: поток SSE с сигналами (`event: push`), pushkey — в Bearer;
 * - `POST /v1/ack` — подтверждение сигнала `{ id }` тем же pushkey;
 * - `GET /healthz` — проверка живости и счётчики доставки по каналам.
 */
export function buildApp(deps: AppDeps) {
  const app = Fastify({ logger: deps.logger ?? false });
  const hub = deps.hub ?? new DirectHub();
  const counts: Record<Channel, number> = { direct: 0, apns: 0, fcm: 0, rustore: 0, dropped: 0 };

  app.get('/healthz', async () => ({ ok: true, connected: hub.size, external: deps.config.external, delivered: counts }));

  app.post('/_matrix/push/v1/notify', async (req, reply) => {
    const parsed = NotifyRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ errcode: 'M_BAD_JSON', error: 'Ожидается notification с devices' });
    const rejected = await deliver(parsed.data, {
      hub,
      providers: deps.providers,
      external: deps.config.external,
      ackTimeoutMs: deps.config.ackTimeoutMs,
      onDelivered: (channel) => counts[channel]++,
    });
    return { rejected };
  });

  app.get('/v1/connect', (req, reply) => {
    const pushkey = pushkeyOf(req);
    if (!pushkey) return reply.code(401).send({ error: 'Нужен pushkey устройства: Authorization: Bearer <pushkey>' });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    res.write('event: ready\ndata: {}\n\n');
    const detach = hub.attach(pushkey, {
      send: (s: PushSignal) => res.write(`event: push\nid: ${s.id}\ndata: ${JSON.stringify(s)}\n\n`),
      close: () => res.end(),
    });
    const beat = setInterval(() => res.write(': ping\n\n'), deps.config.heartbeatMs);
    req.raw.on('close', () => {
      clearInterval(beat);
      detach();
    });
  });

  app.post('/v1/ack', async (req, reply) => {
    const pushkey = pushkeyOf(req);
    if (!pushkey) return reply.code(401).send({ error: 'Нужен pushkey устройства' });
    const id = (req.body as { id?: unknown } | undefined)?.id;
    if (typeof id !== 'string' || !hub.ack(pushkey, id)) return reply.code(404).send({ error: 'Сигнал не ждёт подтверждения' });
    return reply.code(204).send();
  });

  return { app, hub, counts };
}
