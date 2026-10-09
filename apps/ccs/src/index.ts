import { resolve } from 'node:path';
import { buildApp } from './app.ts';
import { ArchiveService, InMemoryArchiveStore } from './archive.ts';
import { CallTokenService } from './calls.ts';
import { CaseDirectory, InMemoryCaseRegistry } from './cases.ts';
import { CaseRoomService, InMemoryCaseRoomStore } from './caseRooms.ts';
import { loadConfig, type Config } from './config.ts';
import { ConsiliumService } from './consilia.ts';
import { ConnectorRegistry, UserResolver, type Connector } from './connectors.ts';
import { CriticalService, InMemoryCriticalStore } from './critical.ts';
import { createPool, ensureDatabase, migrate, PgArchiveStore, PgCaseRegistry, PgCaseRoomStore, PgCriticalStore, PgProcessedEvents, PgRequestStore } from './db.ts';
import { EventProcessor, type Logger } from './events.ts';
import { HttpHostCallbacks, type HostCallbacks } from './host.ts';
import { InMemoryProcessedEvents, IntegrationService } from './integration.ts';
import { HttpMatrixApi, type MatrixApi } from './matrix.ts';
import { InMemoryRequestStore } from './requests.ts';
import { OpenAiCompatibleLlm, SecretaryService, type LlmClient } from './secretary.ts';

export interface ServiceOptions {
  logger?: boolean;
  log?: Logger;
  /** Подменить реестр подключений (тесты). По умолчанию — из CONNECTORS_FILE. */
  connectors?: ConnectorRegistry;
  /** Подменить клиент Matrix (модульные тесты). */
  matrix?: MatrixApi;
  /** Подменить LLM (тесты); null — без LLM. */
  llm?: LlmClient | null;
  /** Часы для сроков критических находок (тесты). */
  now?: () => number;
}

/** Собрать сервис из конфигурации (используется в main, модульных и интеграционных тестах). */
export function createService(config: Config, opts: ServiceOptions = {}) {
  const matrix = opts.matrix ?? new HttpMatrixApi(config.hsUrl, config.asToken, config.botUserId);
  const connectors = opts.connectors ?? ConnectorRegistry.fromFile(resolve(config.connectorsFile));
  const users = new UserResolver(config.serverName);
  const log = opts.log ?? console;
  // Хранилище: PostgreSQL, если задан DATABASE_URL; иначе память (модульные тесты, быстрый старт).
  const pool = config.databaseUrl ? createPool(config.databaseUrl) : null;
  const registry = pool ? new PgCaseRegistry(pool) : new InMemoryCaseRegistry();
  const requests = pool ? new PgRequestStore(pool) : new InMemoryRequestStore();
  const roomStore = pool ? new PgCaseRoomStore(pool) : new InMemoryCaseRoomStore();
  const processed = pool ? new PgProcessedEvents(pool) : new InMemoryProcessedEvents();
  const criticalStore = pool ? new PgCriticalStore(pool) : new InMemoryCriticalStore();
  const archive = new ArchiveService({
    matrix,
    store: pool ? new PgArchiveStore(pool) : new InMemoryArchiveStore(),
    log,
    ...config.archive,
    hasPendingCritical: (roomId) => criticalStore.pendingInRoom(roomId),
    ...(opts.now ? { now: opts.now } : {}),
  });
  const callbacks = new Map<string, HostCallbacks>();
  const callbacksFor = (c: Connector) => {
    if (!c.callbacks) return null;
    if (!callbacks.has(c.id)) callbacks.set(c.id, new HttpHostCallbacks(c.callbacks.url, c.callbacks.token, c.callbacks.timeout_ms));
    return callbacks.get(c.id)!;
  };
  const directory = new CaseDirectory({ registry, connectors, users, callbacksFor });
  const caseRooms = new CaseRoomService(matrix, roomStore, { aliasSecret: config.aliasSecret, serverName: config.serverName, archive });
  const critical = new CriticalService({ matrix, store: criticalStore, directory, caseRooms, connectors, users, log, ...(opts.now ? { now: opts.now } : {}) });
  const calls = new CallTokenService(matrix, { ...config.livekit, roomSecret: config.aliasSecret });
  const secretary = new SecretaryService({
    matrix,
    calls,
    log,
    profile: config.ai.profile,
    secretaryUrl: config.ai.secretaryUrl,
    secretaryToken: config.ai.secretaryToken,
    callbackBaseUrl: config.ai.callbackUrl,
    asrUrl: config.ai.asrUrl,
    llm: opts.llm !== undefined ? opts.llm : config.ai.llm ? new OpenAiCompatibleLlm(config.ai.llm.url, config.ai.llm.model, config.ai.llm.timeoutMs) : null,
  });
  const consilia = new ConsiliumService({ matrix, directory, caseRooms, users, log, aliasSecret: config.aliasSecret, serverName: config.serverName });
  const app = buildApp({
    hsToken: config.hsToken,
    chatWebUrl: config.chatWebUrl,
    matrix,
    connectors,
    users,
    directory,
    registry,
    caseRooms,
    calls,
    events: new EventProcessor({ matrix, directory, requests, users, critical, archive, consilia, secretary, log }),
    integration: new IntegrationService({ matrix, directory, registry, caseRooms, requests, processed, critical, consilia, log }),
    secretary,
    critical,
    archive,
    logger: opts.logger ?? true,
  });
  if (pool && config.databaseUrl) {
    const url = config.databaseUrl;
    let pruneTimer: ReturnType<typeof setInterval> | undefined;
    // До приёма запросов: база есть, миграции применены. Ошибка здесь останавливает запуск — без хранилища работать нельзя.
    app.addHook('onReady', async () => {
      await ensureDatabase(url, log);
      const applied = await migrate(pool);
      if (applied) log.info({ applied }, 'Миграции базы сервиса контекста применены');
      const prune = () => (processed as PgProcessedEvents).prune().catch((err) => log.warn({ err }, 'Очистка событий не удалась'));
      void prune();
      pruneTimer = setInterval(prune, 3600_000);
      pruneTimer.unref();
    });
    app.addHook('onClose', async () => {
      if (pruneTimer) clearInterval(pruneTimer);
      await pool.end();
    });
  }
  // Сроки критических находок: проверка по таймеру (0 — не запускать; тесты вызывают tick сами).
  if (config.criticalTickMs > 0) {
    app.addHook('onReady', async () => critical.start(config.criticalTickMs));
    app.addHook('onClose', async () => critical.stop());
  }
  // Архив чатов случаев: проход по таймеру (0 — не запускать; тесты вызывают tick сами).
  if (config.archive.tickMs > 0) {
    app.addHook('onReady', async () => archive.start(config.archive.tickMs));
    app.addHook('onClose', async () => archive.stop());
  }
  // Имя сервиса в лентах чатов вместо технического «ccs». Ошибка не мешает запуску.
  if (matrix instanceof HttpMatrixApi) {
    app.addHook('onReady', async () => {
      await matrix.setBotDisplayName('Консилиум · сервис').catch((err) => app.log.warn({ err }, 'Не удалось задать имя сервиса'));
    });
    // Сервис снова доступен — просим Synapse сразу дослать накопленные события, не дожидаясь паузы повторов.
    app.addHook('onListen', async () => {
      matrix
        .pingAppservice(config.asId)
        .then((ms) => app.log.info({ ms }, 'Synapse видит сервис контекста'))
        .catch((err) => app.log.warn({ err }, 'Ping Application Service не прошёл'));
    });
  }
  return { app, matrix, connectors, registry, caseRooms, calls, directory, secretary, critical, archive, consilia };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const { app } = createService(config);
  app.listen({ host: config.host, port: config.port }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
