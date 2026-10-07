import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.ts';
import { RetryLaterError, type MatrixEvent } from '../events.ts';

const Transaction = z.object({ events: z.array(z.record(z.unknown())).default([]) });

function mxError(reply: FastifyReply, status: number, errcode: string, error: string) {
  return reply.code(status).send({ errcode, error });
}

/** Matrix Application Service API: `/_matrix/app/v1/*`. Вызывает Synapse с токеном `hs_token`. */
export async function appserviceRoutes(app: FastifyInstance, deps: AppDeps) {
  function authorized(req: FastifyRequest): 'ok' | 'missing' | 'wrong' {
    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7) : (req.query as Record<string, string | undefined>).access_token;
    if (!token) return 'missing';
    return token === deps.hsToken ? 'ok' : 'wrong';
  }

  app.addHook('onRequest', async (req, reply) => {
    const auth = authorized(req);
    if (auth === 'missing') return mxError(reply, 401, 'M_UNAUTHORIZED', 'Нет токена homeserver');
    if (auth === 'wrong') return mxError(reply, 403, 'M_FORBIDDEN', 'Неверный токен homeserver');
  });

  const processedTxns = new Set<string>();

  app.put('/transactions/:txnId', async (req, reply) => {
    const { txnId } = req.params as { txnId: string };
    if (processedTxns.has(txnId)) return {};
    const tx = Transaction.parse(req.body);
    for (const raw of tx.events) {
      try {
        await deps.events.handle(raw as unknown as MatrixEvent);
      } catch (e) {
        if (e instanceof RetryLaterError) {
          // Synapse повторит транзакцию; уже обработанные события пропустятся.
          req.log.warn({ err: e, eventId: raw.event_id }, 'Транзакция будет повторена');
          return mxError(reply, 503, 'M_UNKNOWN', 'Повторите транзакцию позже');
        }
        // Остальные ошибки одного события не должны блокировать очередь Synapse.
        req.log.error({ err: e, eventId: raw.event_id }, 'Ошибка обработки события');
      }
    }
    processedTxns.add(txnId);
    if (processedTxns.size > 10_000) {
      const oldest = processedTxns.values().next().value;
      if (oldest !== undefined) processedTxns.delete(oldest);
    }
    return {};
  });

  app.get('/users/:userId', async (req, reply) => {
    const { userId } = req.params as { userId: string };
    return userId === deps.matrix.botUserId ? {} : mxError(reply, 404, 'M_NOT_FOUND', 'Пользователь не управляется сервисом');
  });

  // Псевдонимы #c-… создаёт только сервис при открытии случая, «по запросу» их не создаём.
  app.get('/rooms/:alias', async (_req, reply) => mxError(reply, 404, 'M_NOT_FOUND', 'Комната не найдена'));

  app.post('/ping', async () => ({}));
}
