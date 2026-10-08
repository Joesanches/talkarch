import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.ts';
import { SecretaryError, SecretaryResult } from '../secretary.ts';

/** Внутренний API: результаты ИИ-агентов. Аутентификация — общий токен агента (SECRETARY_TOKEN). */
export async function internalRoutes(app: FastifyInstance, deps: AppDeps) {
  app.post('/secretary/sessions/:id/result', async (req, reply) => {
    const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
    if (!deps.secretary.enabled || !deps.secretary.checkToken(token)) return reply.code(401).send({ error: 'Неверный токен агента' });
    const body = SecretaryResult.safeParse(req.body);
    if (!body.success) {
      const error = body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      req.log.warn({ error }, 'Результат агента не прошёл проверку');
      return reply.code(400).send({ error });
    }
    const { id } = req.params as { id: string };
    try {
      // Стенограмма — сразу; черновик протокола (LLM может думать минутами) — в фоне.
      const r = await deps.secretary.onResult(id, body.data);
      return reply.code(202).send({ transcript_event_id: r.transcriptEventId });
    } catch (e) {
      if (e instanceof SecretaryError) return reply.code(e.status).send({ error: e.message });
      throw e;
    }
  });
}
