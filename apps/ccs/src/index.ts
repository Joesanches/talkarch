import { resolve } from 'node:path';
import { buildApp } from './app.ts';
import { CallTokenService } from './calls.ts';
import { CaseRoomService, InMemoryCaseRoomStore } from './caseRooms.ts';
import { loadConfig, type Config } from './config.ts';
import { EventProcessor } from './events.ts';
import { JsonHostDirectory } from './host.ts';
import { HttpMatrixApi } from './matrix.ts';

/** Собрать сервис из конфигурации (используется и в main, и в интеграционных тестах). */
export function createService(config: Config, opts: { logger?: boolean } = {}) {
  const matrix = new HttpMatrixApi(config.hsUrl, config.asToken, config.botUserId);
  const store = new InMemoryCaseRoomStore();
  const host = JsonHostDirectory.fromFile(resolve(config.hostDirectoryFile), config.org, config.serverName);
  const caseRooms = new CaseRoomService(matrix, store, { aliasSecret: config.aliasSecret, serverName: config.serverName });
  const calls = new CallTokenService(matrix, { ...config.livekit, roomSecret: config.aliasSecret });
  const app = buildApp({
    org: config.org,
    hsToken: config.hsToken,
    matrix,
    host,
    caseRooms,
    calls,
    events: new EventProcessor({ matrix, store, host, org: config.org, log: console }),
    logger: opts.logger ?? true,
  });
  // Имя сервиса в лентах чатов вместо технического «ccs». Ошибка не мешает запуску.
  app.addHook('onReady', async () => {
    await matrix.setBotDisplayName('Консилиум · сервис').catch((err) => app.log.warn({ err }, 'Не удалось задать имя сервиса'));
  });
  return { app, matrix, store, host, caseRooms, calls };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const { app } = createService(config);
  app.listen({ host: config.host, port: config.port }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
