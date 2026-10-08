import Fastify, { type FastifyInstance } from 'fastify';
import type { CallTokenService } from './calls.ts';
import type { CaseDirectory, CaseRegistry } from './cases.ts';
import type { CaseRoomService } from './caseRooms.ts';
import type { ConnectorRegistry, UserResolver } from './connectors.ts';
import type { EventProcessor } from './events.ts';
import type { IntegrationService } from './integration.ts';
import type { MatrixApi } from './matrix.ts';
import type { SecretaryService } from './secretary.ts';
import { appserviceRoutes } from './routes/appservice.ts';
import { clientRoutes } from './routes/client.ts';
import { integrationRoutes } from './routes/integration.ts';
import { internalRoutes } from './routes/internal.ts';

export interface AppDeps {
  hsToken: string;
  /** Адрес веб-клиента — для ссылок на чат случая из РИС/ЛИС. */
  chatWebUrl: string;
  matrix: MatrixApi;
  connectors: ConnectorRegistry;
  users: UserResolver;
  directory: CaseDirectory;
  registry: CaseRegistry;
  caseRooms: CaseRoomService;
  calls: CallTokenService;
  events: EventProcessor;
  integration: IntegrationService;
  secretary: SecretaryService;
  logger?: boolean;
}

/**
 * Три API сервиса контекста:
 * - `/api/v1` — клиенты и SDK встраивания (токен Matrix пользователя);
 * - `/integration/v1` — РИС, ЛИС, ТМК (токен подключения);
 * - `/_matrix/app/v1` — Synapse (токен Application Service).
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false });
  app.get('/healthz', async () => ({ ok: true }));
  app.register(async (scope) => clientRoutes(scope, deps), { prefix: '/api/v1' });
  app.register(async (scope) => integrationRoutes(scope, deps), { prefix: '/integration/v1' });
  app.register(async (scope) => appserviceRoutes(scope, deps), { prefix: '/_matrix/app/v1' });
  // Внутренние вызовы сервисов контура (ИИ-агенты); наружу через шлюз не публикуются.
  app.register(async (scope) => internalRoutes(scope, deps), { prefix: '/internal/v1' });
  return app;
}
