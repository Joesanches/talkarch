import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SourceSystem } from '@konsilium/protocol';
import { CallTokenService, ForbiddenError } from './calls.ts';
import type { CaseRoomService } from './caseRooms.ts';
import { EventProcessor, type MatrixEvent } from './events.ts';
import type { HostDirectory } from './host.ts';
import { MatrixError, type MatrixApi } from './matrix.ts';

export interface AppDeps {
  org: string;
  hsToken: string;
  matrix: MatrixApi;
  host: HostDirectory;
  caseRooms: CaseRoomService;
  calls: CallTokenService;
  events: EventProcessor;
  logger?: boolean;
}

const OpenCaseBody = z.object({ system: SourceSystem, caseId: z.string().trim().min(1).max(128) });
const CallTokenBody = z.object({ roomId: z.string().startsWith('!'), callId: z.string().regex(/^[\w.-]{1,64}$/).optional() });
const Transaction = z.object({ events: z.array(z.record(z.unknown())).default([]) });

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : null;
}

function problem(reply: FastifyReply, status: number, errcode: string, error: string) {
  return reply.code(status).send({ errcode, error });
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false });

  // Кеш whoami: токен пользователя → Matrix ID (60 с), чтобы не ходить в Synapse на каждый запрос.
  const whoamiCache = new Map<string, { userId: string; until: number }>();
  async function currentUser(req: FastifyRequest): Promise<string | null> {
    const token = bearer(req);
    if (!token) return null;
    const cached = whoamiCache.get(token);
    if (cached && cached.until > Date.now()) return cached.userId;
    try {
      const userId = await deps.matrix.whoami(token);
      whoamiCache.set(token, { userId, until: Date.now() + 60_000 });
      return userId;
    } catch {
      return null;
    }
  }

  app.get('/healthz', async () => ({ ok: true }));

  // ── Публичный API для клиентов и SDK встраивания ───────────────────────────────

  /** Открыть чат случая из РИС/ЛИС: проверка прав в системе-источнике → комната (создаётся при первом обращении) → приглашение. */
  app.post('/api/v1/cases/open', async (req, reply) => {
    const userId = await currentUser(req);
    if (!userId) return problem(reply, 401, 'M_UNAUTHORIZED', 'Нужен токен Matrix');
    const body = OpenCaseBody.safeParse(req.body);
    if (!body.success) return problem(reply, 400, 'M_BAD_JSON', body.error.issues.map((i) => i.message).join('; '));

    const ref = { org: deps.org, ...body.data };
    const hostCase = await deps.host.getCase(ref);
    if (!hostCase) return problem(reply, 404, 'M_NOT_FOUND', 'Случай не найден в системе-источнике');
    if (!(await deps.host.canAccess(userId, ref))) {
      req.log.warn({ userId, case: body.data }, 'Отказ в доступе к случаю');
      return problem(reply, 403, 'M_FORBIDDEN', 'Нет доступа к случаю в системе-источнике');
    }

    const room = await deps.caseRooms.getOrCreate(hostCase);
    const membership = await deps.caseRooms.ensureMember(room.roomId, userId);
    return { roomId: room.roomId, alias: room.alias, created: room.created, membership };
  });

  /** Токен LiveKit для звонка в комнате — только участникам комнаты. */
  app.post('/api/v1/calls/token', async (req, reply) => {
    const token = bearer(req);
    if (!token || !(await currentUser(req))) return problem(reply, 401, 'M_UNAUTHORIZED', 'Нужен токен Matrix');
    const body = CallTokenBody.safeParse(req.body);
    if (!body.success) return problem(reply, 400, 'M_BAD_JSON', body.error.issues.map((i) => i.message).join('; '));
    try {
      return await deps.calls.issue(token, body.data.roomId, body.data.callId);
    } catch (e) {
      if (e instanceof ForbiddenError) return problem(reply, 403, 'M_FORBIDDEN', e.message);
      throw e;
    }
  });

  // ── Matrix Application Service API (вызывает Synapse) ──────────────────────────

  function asAuthorized(req: FastifyRequest): 'ok' | 'missing' | 'wrong' {
    const token = bearer(req) ?? (req.query as Record<string, string | undefined>).access_token;
    if (!token) return 'missing';
    return token === deps.hsToken ? 'ok' : 'wrong';
  }

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/_matrix/app/')) return;
    const auth = asAuthorized(req);
    if (auth === 'missing') return problem(reply, 401, 'M_UNAUTHORIZED', 'Нет токена homeserver');
    if (auth === 'wrong') return problem(reply, 403, 'M_FORBIDDEN', 'Неверный токен homeserver');
  });

  const processedTxns = new Set<string>();

  app.put('/_matrix/app/v1/transactions/:txnId', async (req) => {
    const { txnId } = req.params as { txnId: string };
    if (processedTxns.has(txnId)) return {};
    const tx = Transaction.parse(req.body);
    for (const raw of tx.events) {
      try {
        await deps.events.handle(raw as unknown as MatrixEvent);
      } catch (e) {
        // Ошибка одного события не должна блокировать очередь Synapse: логируем и идём дальше.
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

  app.get('/_matrix/app/v1/users/:userId', async (req, reply) => {
    const { userId } = req.params as { userId: string };
    return userId === deps.matrix.botUserId ? {} : problem(reply, 404, 'M_NOT_FOUND', 'Пользователь не управляется сервисом');
  });

  // Псевдонимы #c-… создаёт только сервис при открытии случая, «по запросу» их не создаём.
  app.get('/_matrix/app/v1/rooms/:alias', async (_req, reply) => problem(reply, 404, 'M_NOT_FOUND', 'Комната не найдена'));

  app.post('/_matrix/app/v1/ping', async () => ({}));

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof MatrixError) {
      req.log.error({ err }, 'Ошибка Matrix');
      return problem(reply, 502, err.errcode, 'Ошибка сервера сообщений');
    }
    req.log.error({ err }, 'Внутренняя ошибка');
    return problem(reply, 500, 'M_UNKNOWN', 'Внутренняя ошибка');
  });

  return app;
}
