import type { FastifyInstance, FastifyReply } from 'fastify';
import { MAX_BATCH, type ChatInfo } from '@konsilium/protocol/integration';
import type { AppDeps } from '../app.ts';
import type { Connector } from '../connectors.ts';
import { HostError } from '../host.ts';
import { MatrixError } from '../matrix.ts';

declare module 'fastify' {
  interface FastifyRequest {
    connector: Connector | null;
  }
}

/** Ошибка в формате RFC 9457 (Problem Details). */
export function problem(reply: FastifyReply, status: number, title: string, detail?: string) {
  return reply
    .code(status)
    .type('application/problem+json')
    .send({ type: 'about:blank', title, status, ...(detail ? { detail } : {}) });
}

/**
 * API интеграции для РИС, ЛИС и ТМК: `/integration/v1/*`.
 * Аутентификация — токен подключения (`Authorization: Bearer`). Контракт — apps/ccs/openapi/integration-v1.yaml.
 */
export async function integrationRoutes(app: FastifyInstance, deps: AppDeps) {
  app.decorateRequest('connector', null);

  // События принимаются и в типах CloudEvents, и как обычный JSON.
  app.addContentTypeParser(
    ['application/cloudevents+json', 'application/cloudevents-batch+json'],
    { parseAs: 'string' },
    app.getDefaultJsonParser('error', 'ignore'),
  );

  app.addHook('onRequest', async (req, reply) => {
    const h = req.headers.authorization;
    const connector = h?.startsWith('Bearer ') ? deps.connectors.authenticate(h.slice(7)) : null;
    if (!connector) return problem(reply, 401, 'Нужен токен подключения');
    req.connector = connector;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HostError) {
      req.log.warn({ err }, 'Ошибка обратного вызова');
      return problem(reply, err.transient ? 503 : 502, 'Система-источник не ответила по контракту', err.message);
    }
    if (err instanceof MatrixError) {
      req.log.error({ err }, 'Ошибка Matrix');
      return problem(reply, 503, 'Сервер сообщений недоступен');
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return problem(reply, status, 'Некорректный запрос', (err as Error).message);
    req.log.error({ err }, 'Внутренняя ошибка');
    return problem(reply, 500, 'Внутренняя ошибка');
  });

  const chatInfo = async (connector: Connector, caseId: string): Promise<ChatInfo> => {
    const ref = { connector: connector.id, caseId };
    const roomId = await deps.caseRooms.roomFor(ref);
    if (!roomId) return { case_id: caseId, chat: null };
    return {
      case_id: caseId,
      chat: {
        room_id: roomId,
        alias: deps.caseRooms.aliasFor(ref).alias,
        url: `${deps.chatWebUrl}/c/${connector.id}/${encodeURIComponent(caseId)}`,
      },
    };
  };

  /** Проверка настройки: кто я для сервиса контекста. */
  app.get('/connector', async (req) => {
    const c = req.connector!;
    return { id: c.id, kind: c.kind, org: c.org, title: c.title, level: c.callbacks ? 2 : 1 };
  });

  /** Приём событий: одно событие (объект) или пакет (массив) в формате CloudEvents 1.0. */
  app.post('/events', async (req, reply) => {
    const body = req.body;
    const items = Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : null;
    if (!items || items.length === 0) return problem(reply, 400, 'Ожидается событие CloudEvents или непустой массив событий');
    if (items.length > MAX_BATCH) return problem(reply, 413, `В пакете больше ${MAX_BATCH} событий`);

    const results = await deps.integration.process(req.connector!, items);
    // Есть временные ошибки — 503: простой клиент повторит весь пакет, уже принятые события вернутся как duplicate.
    if (results.some((r) => r.status === 'failed')) reply.code(503).header('retry-after', '5');
    return { results };
  });

  /**
   * Критические находки подключения с даты `since` (по умолчанию — за 7 дней): время подтверждения, эскалации.
   * Для РИС/ЛИС без обратных вызовов это способ узнать о подтверждении; для всех — отчёт.
   */
  app.get('/critical-findings', async (req, reply) => {
    const { since } = req.query as { since?: string };
    const from = since ? Date.parse(since) : Date.now() - 7 * 86_400_000;
    if (!Number.isFinite(from)) return problem(reply, 400, 'Некорректный параметр since', 'Ожидается дата и время ISO 8601');
    return { findings: await deps.critical.report(req.connector!.id, from) };
  });

  /** Есть ли чат по случаю, и ссылка на него. */
  app.get('/cases/:caseId/chat', async (req) => {
    const { caseId } = req.params as { caseId: string };
    return chatInfo(req.connector!, caseId);
  });

  /** Создать чат по случаю заранее (например, кнопка «Обсудить» в РИС). Повторный вызов вернёт тот же чат. */
  app.put('/cases/:caseId/chat', async (req, reply) => {
    const { caseId } = req.params as { caseId: string };
    const connector = req.connector!;
    const hostCase = await deps.directory.find({ connector: connector.id, caseId });
    if (!hostCase) return problem(reply, 404, 'Случай неизвестен', 'Сначала отправьте событие case.upserted');
    const room = await deps.caseRooms.getOrCreate(hostCase);
    reply.code(room.created ? 201 : 200);
    return chatInfo(connector, caseId);
  });
}
