import { buildApp } from './app.ts';
import { loadConfig, type Config } from './config.ts';
import { ApnsProvider } from './providers/apns.ts';
import { FcmProvider } from './providers/fcm.ts';
import { RuStoreProvider } from './providers/rustore.ts';
import type { PushProvider } from './providers/types.ts';

/** Внешние сервисы, для которых заданы ключи. Без ключей сервис выключен, даже если политика разрешает внешнюю доставку. */
export function providersFrom(config: Config): Partial<Record<PushProvider['name'], PushProvider>> {
  return {
    ...(config.apns ? { apns: new ApnsProvider({ ...config.apns, texts: config.texts }) } : {}),
    ...(config.fcm ? { fcm: new FcmProvider(config.fcm) } : {}),
    ...(config.rustore ? { rustore: new RuStoreProvider(config.rustore) } : {}),
  };
}

export function createGateway(config: Config) {
  const providers = providersFrom(config);
  return { ...buildApp({ config, providers }), providers };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const { app, providers } = createGateway(config);
  const enabled = Object.keys(providers);
  app.listen({ host: config.host, port: config.port }).then(
    () => console.info(`Push-шлюз: порт ${config.port}, внешняя доставка — ${config.external}${enabled.length ? ` (${enabled.join(', ')})` : ', внешних сервисов нет'}`),
    (err: unknown) => {
      console.error(err);
      process.exit(1);
    },
  );
}
