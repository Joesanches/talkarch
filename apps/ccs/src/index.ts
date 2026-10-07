import { resolve } from 'node:path';
import { buildApp } from './app.ts';
import { CallTokenService } from './calls.ts';
import { CaseDirectory, InMemoryCaseRegistry } from './cases.ts';
import { CaseRoomService, InMemoryCaseRoomStore } from './caseRooms.ts';
import { loadConfig, type Config } from './config.ts';
import { ConnectorRegistry, UserResolver, type Connector } from './connectors.ts';
import { EventProcessor, type Logger } from './events.ts';
import { HttpHostCallbacks, type HostCallbacks } from './host.ts';
import { IntegrationService } from './integration.ts';
import { HttpMatrixApi, type MatrixApi } from './matrix.ts';
import { InMemoryRequestStore } from './requests.ts';

export interface ServiceOptions {
  logger?: boolean;
  log?: Logger;
  /** Подменить реестр подключений (тесты). По умолчанию — из CONNECTORS_FILE. */
  connectors?: ConnectorRegistry;
  /** Подменить клиент Matrix (модульные тесты). */
  matrix?: MatrixApi;
}

/** Собрать сервис из конфигурации (используется в main, модульных и интеграционных тестах). */
export function createService(config: Config, opts: ServiceOptions = {}) {
  const matrix = opts.matrix ?? new HttpMatrixApi(config.hsUrl, config.asToken, config.botUserId);
  const connectors = opts.connectors ?? ConnectorRegistry.fromFile(resolve(config.connectorsFile));
  const users = new UserResolver(config.serverName);
  const registry = new InMemoryCaseRegistry();
  const requests = new InMemoryRequestStore();
  const callbacks = new Map<string, HostCallbacks>();
  const callbacksFor = (c: Connector) => {
    if (!c.callbacks) return null;
    if (!callbacks.has(c.id)) callbacks.set(c.id, new HttpHostCallbacks(c.callbacks.url, c.callbacks.token, c.callbacks.timeout_ms));
    return callbacks.get(c.id)!;
  };
  const directory = new CaseDirectory({ registry, connectors, users, callbacksFor });
  const caseRooms = new CaseRoomService(matrix, new InMemoryCaseRoomStore(), { aliasSecret: config.aliasSecret, serverName: config.serverName });
  const calls = new CallTokenService(matrix, { ...config.livekit, roomSecret: config.aliasSecret });
  const log = opts.log ?? console;
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
    events: new EventProcessor({ matrix, directory, requests, users, log }),
    integration: new IntegrationService({ matrix, directory, registry, caseRooms, requests, log }),
    logger: opts.logger ?? true,
  });
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
  return { app, matrix, connectors, registry, caseRooms, calls, directory };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const { app } = createService(config);
  app.listen({ host: config.host, port: config.port }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
