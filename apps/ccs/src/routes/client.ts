import cors from '@fastify/cors';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CaseContext, ConnectorId, EventType, SourceSystem, type CaseRef } from '@konsilium/protocol';
import type { AppDeps } from '../app.ts';
import { ForbiddenError } from '../calls.ts';
import { HostError } from '../host.ts';
import { MatrixError } from '../matrix.ts';
import { SecretaryError } from '../secretary.ts';

const OpenCaseBody = z
  .object({
    /** Подключение (конкретная РИС/ЛИС). Можно не указывать, если подключение этого типа одно — тогда нужен `system`. */
    connector: ConnectorId.optional(),
    system: SourceSystem.optional(),
    caseId: z.string().trim().min(1).max(128),
  })
  .refine((b) => b.connector || b.system, { message: 'Укажите connector или system' });
const PatientBody = z.object({ roomId: z.string().startsWith('!'), reason: z.string().max(200).optional() });
const SecretaryBody = z.object({ roomId: z.string().startsWith('!'), action: z.enum(['start', 'stop']) });
const CallTokenBody = z.object({ roomId: z.string().startsWith('!'), callId: z.string().regex(/^[\w.-]{1,64}$/).optional() });

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : null;
}

/** Ошибка в стиле Matrix: клиенты и так разбирают такие ответы. */
function mxError(reply: FastifyReply, status: number, errcode: string, error: string) {
  return reply.code(status).send({ errcode, error });
}

const issues = (e: z.ZodError) => e.issues.map((i) => i.message).join('; ');

/** API для клиентов и SDK встраивания: `/api/v1/*`. Аутентификация — токен Matrix пользователя. */
export async function clientRoutes(app: FastifyInstance, deps: AppDeps) {
  // Веб-клиент работает с другого адреса: разрешаем только его (и SDK встраивания, который грузится оттуда же).
  await app.register(cors, { origin: [deps.chatWebUrl], methods: ['POST'], allowedHeaders: ['authorization', 'content-type'], maxAge: 600 });

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

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HostError) {
      req.log.warn({ err }, 'Ошибка системы-источника');
      return mxError(reply, err.transient ? 503 : 502, 'M_UNKNOWN', 'Система-источник недоступна');
    }
    if (err instanceof MatrixError) {
      req.log.error({ err }, 'Ошибка Matrix');
      return mxError(reply, 502, err.errcode, 'Ошибка сервера сообщений');
    }
    req.log.error({ err }, 'Внутренняя ошибка');
    return mxError(reply, 500, 'M_UNKNOWN', 'Внутренняя ошибка');
  });

  /**
   * Открыть чат случая из РИС/ЛИС: случай → проверка прав в системе-источнике → комната (создаётся при первом обращении)
   * → приглашение пользователя.
   */
  /**
   * Сервис уже пустил пользователя в чат случая (эскалация критической находки) — он может открыть чат и по ссылке,
   * даже если в списках системы-источника его нет. Отозванных это не касается: их выводят из комнаты.
   */
  async function invitedByService(ref: CaseRef, userId: string, revoked: string[]): Promise<boolean> {
    if (revoked.includes(userId)) return false;
    const roomId = await deps.caseRooms.roomFor(ref);
    if (!roomId) return false;
    const m = await deps.matrix.getMembership(roomId, userId).catch(() => null);
    return m === 'invite' || m === 'join';
  }

  app.post('/cases/open', async (req, reply) => {
    const userId = await currentUser(req);
    if (!userId) return mxError(reply, 401, 'M_UNAUTHORIZED', 'Нужен токен Matrix');
    const body = OpenCaseBody.safeParse(req.body);
    if (!body.success) return mxError(reply, 400, 'M_BAD_JSON', issues(body.error));

    let connectorId = body.data.connector;
    if (!connectorId) {
      const found = deps.connectors.single(body.data.system!);
      if (found === 'none') return mxError(reply, 404, 'M_NOT_FOUND', `Нет подключения типа ${body.data.system}`);
      if (found === 'ambiguous') return mxError(reply, 400, 'M_BAD_JSON', `Подключений типа ${body.data.system} несколько — укажите connector`);
      connectorId = found.id;
    } else if (!deps.connectors.get(connectorId)) {
      return mxError(reply, 404, 'M_NOT_FOUND', 'Неизвестное подключение');
    }

    const ref: CaseRef = { connector: connectorId, caseId: body.data.caseId };
    const hostCase = await deps.directory.find(ref);
    if (!hostCase) return mxError(reply, 404, 'M_NOT_FOUND', 'Случай не найден в системе-источнике');
    if (!(await deps.directory.canAccess(userId, hostCase)) && !(await invitedByService(ref, userId, hostCase.revoked))) {
      req.log.warn({ userId, connector: ref.connector }, 'Отказ в доступе к случаю');
      return mxError(reply, 403, 'M_FORBIDDEN', 'Нет доступа к случаю в системе-источнике');
    }

    const room = await deps.caseRooms.getOrCreate(hostCase);
    // Пока создавалась комната, могло прийти более новое событие case.upserted — догоняем.
    const latest = await deps.registry.get(ref);
    if (room.created && latest && latest.snapshot.version > hostCase.snapshot.version) await deps.caseRooms.sync(room.roomId, latest);
    const membership = await deps.caseRooms.ensureMember(room.roomId, userId);
    return { roomId: room.roomId, alias: room.alias, created: room.created, membership, connector: ref.connector, caseId: hostCase.snapshot.case_id };
  });

  /**
   * Раскрыть данные пациента участнику чата. Данные не попадают в Matrix: сервис запрашивает их у системы-источника
   * (она проверяет права и пишет в свой журнал) и отдаёт клиенту без кеширования.
   */
  app.post('/cases/patient', async (req, reply) => {
    const userId = await currentUser(req);
    if (!userId) return mxError(reply, 401, 'M_UNAUTHORIZED', 'Нужен токен Matrix');
    const body = PatientBody.safeParse(req.body);
    if (!body.success) return mxError(reply, 400, 'M_BAD_JSON', issues(body.error));

    const ctx = CaseContext.safeParse(await deps.matrix.getState(body.data.roomId, EventType.CaseContext).catch(() => null));
    if (!ctx.success) return mxError(reply, 404, 'M_NOT_FOUND', 'Это не чат случая');
    if ((await deps.matrix.getMembership(body.data.roomId, userId)) !== 'join') {
      return mxError(reply, 403, 'M_FORBIDDEN', 'Только для участников чата');
    }
    const callbacks = deps.directory.callbacks(ctx.data.connector);
    if (!callbacks) return mxError(reply, 501, 'M_UNRECOGNIZED', 'Система-источник не поддерживает раскрытие данных пациента');

    try {
      const patient = await callbacks.revealPatient({ case_id: ctx.data.case_id, user: deps.users.toRef(userId), reason: body.data.reason });
      req.log.info({ audit: 'patient_reveal', userId, connector: ctx.data.connector, roomId: body.data.roomId }, 'Раскрытие данных пациента');
      reply.header('cache-control', 'no-store');
      return { patient };
    } catch (e) {
      if (e instanceof HostError && e.status === 403) return mxError(reply, 403, 'M_FORBIDDEN', 'Система-источник отказала в доступе');
      throw e;
    }
  });

  /** Токен LiveKit для звонка в комнате — только вошедшим участникам. */
  app.post('/calls/token', async (req, reply) => {
    const token = bearer(req);
    if (!token || !(await currentUser(req))) return mxError(reply, 401, 'M_UNAUTHORIZED', 'Нужен токен Matrix');
    const body = CallTokenBody.safeParse(req.body);
    if (!body.success) return mxError(reply, 400, 'M_BAD_JSON', issues(body.error));
    try {
      const issued = await deps.calls.issue(token, body.data.roomId, body.data.callId);
      // Клиент показывает кнопку стенограммы, только если «Секретарь» включён политикой организации.
      return { ...issued, secretary: deps.secretary.enabled ? { eta_minutes: deps.secretary.etaMinutes } : null };
    } catch (e) {
      if (e instanceof ForbiddenError) return mxError(reply, 403, 'M_FORBIDDEN', e.message);
      throw e;
    }
  });

  /** ИИ-«Секретарь»: включить или выключить стенограмму звонка. Только для вошедших участников. */
  app.post('/calls/secretary', async (req, reply) => {
    const token = bearer(req);
    if (!token || !(await currentUser(req))) return mxError(reply, 401, 'M_UNAUTHORIZED', 'Нужен токен Matrix');
    const body = SecretaryBody.safeParse(req.body);
    if (!body.success) return mxError(reply, 400, 'M_BAD_JSON', issues(body.error));
    try {
      if (body.data.action === 'start') {
        await deps.secretary.start(token, body.data.roomId);
        return { status: 'started', eta_minutes: deps.secretary.etaMinutes };
      }
      await deps.secretary.stop(token, body.data.roomId);
      return { status: 'stopping' };
    } catch (e) {
      if (e instanceof ForbiddenError) return mxError(reply, 403, 'M_FORBIDDEN', e.message);
      if (e instanceof SecretaryError) return mxError(reply, e.status, e.status === 409 ? 'M_CONFLICT' : 'M_UNAVAILABLE', e.message);
      throw e;
    }
  });
}
