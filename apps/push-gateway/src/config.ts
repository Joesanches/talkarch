import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Внешняя доставка — когда у устройства нет прямого соединения со шлюзом (телефон вне сети организации) или оно не
 * подтвердило сигнал:
 * - `off` — никогда: закрытый контур без выхода в интернет, уведомления — только в сети организации (или через VPN);
 * - `critical` — только критические находки и входящие звонки;
 * - `all` — всё, в том числе обычные сообщения и значок непрочитанного.
 * В любом режиме во внешний сервис уходит только сигнал без содержимого (docs/03-architecture.md, раздел 6).
 */
export const ExternalPolicy = z.enum(['off', 'critical', 'all']);
export type ExternalPolicy = z.infer<typeof ExternalPolicy>;

const Env = z.object({
  PUSH_HOST: z.string().default('0.0.0.0'),
  PUSH_PORT: z.coerce.number().int().nonnegative().default(8075),
  PUSH_EXTERNAL: ExternalPolicy.default('off'),
  /** Сколько ждать подтверждения сигнала по прямому соединению, прежде чем считать его оборванным (мс). */
  PUSH_ACK_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  /** Как часто писать в прямое соединение пустую строку, чтобы прокси и NAT не закрыли его (мс). */
  PUSH_HEARTBEAT_MS: z.coerce.number().int().positive().default(25_000),
  /** Тексты на экране блокировки. Имени отправителя и текста сообщения в push нет никогда. */
  PUSH_TITLE: z.string().min(1).default('Консилиум'),
  PUSH_TEXT_MESSAGE: z.string().min(1).default('Новое сообщение'),
  PUSH_TEXT_CRITICAL: z.string().min(1).default('Критическая находка — требуется подтверждение'),
  PUSH_TEXT_CALL: z.string().min(1).default('Входящий звонок'),
  /** APNs (iOS): ключ .p8 из Apple Developer, его ID, ID команды и bundle ID приложения. */
  APNS_KEY_FILE: z.string().min(1).optional(),
  APNS_KEY_ID: z.string().min(1).optional(),
  APNS_TEAM_ID: z.string().min(1).optional(),
  APNS_TOPIC: z.string().min(1).optional(),
  APNS_URL: z.string().url().default('https://api.push.apple.com'),
  /** FCM HTTP v1 (Android): JSON сервисного аккаунта Firebase. */
  FCM_SERVICE_ACCOUNT_FILE: z.string().min(1).optional(),
  FCM_URL: z.string().url().default('https://fcm.googleapis.com'),
  /** RuStore Push (Android): проект и сервисный токен из консоли RuStore. */
  RUSTORE_PROJECT_ID: z.string().min(1).optional(),
  RUSTORE_SERVICE_TOKEN: z.string().min(1).optional(),
  RUSTORE_URL: z.string().url().default('https://vkpns.rustore.ru'),
});

export interface Texts {
  title: string;
  message: string;
  critical: string;
  call: string;
}

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
  project_id: string;
}

export interface Config {
  host: string;
  port: number;
  external: ExternalPolicy;
  ackTimeoutMs: number;
  heartbeatMs: number;
  texts: Texts;
  apns?: { url: string; keyPem: string; keyId: string; teamId: string; topic: string };
  fcm?: { url: string; account: ServiceAccount };
  rustore?: { url: string; projectId: string; serviceToken: string };
}

const ServiceAccountJson = z.object({ client_email: z.string().min(1), private_key: z.string().min(1), token_uri: z.string().url(), project_id: z.string().min(1) });

export function loadConfig(env: NodeJS.ProcessEnv = process.env, read = (f: string) => readFileSync(f, 'utf8')): Config {
  const e = Env.parse(env);
  const apnsSet = [e.APNS_KEY_FILE, e.APNS_KEY_ID, e.APNS_TEAM_ID, e.APNS_TOPIC];
  if (apnsSet.some(Boolean) && !apnsSet.every(Boolean)) throw new Error('APNs: нужны все четыре — APNS_KEY_FILE, APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC');
  if (!!e.RUSTORE_PROJECT_ID !== !!e.RUSTORE_SERVICE_TOKEN) throw new Error('RuStore: нужны оба — RUSTORE_PROJECT_ID и RUSTORE_SERVICE_TOKEN');
  return {
    host: e.PUSH_HOST,
    port: e.PUSH_PORT,
    external: e.PUSH_EXTERNAL,
    ackTimeoutMs: e.PUSH_ACK_TIMEOUT_MS,
    heartbeatMs: e.PUSH_HEARTBEAT_MS,
    texts: { title: e.PUSH_TITLE, message: e.PUSH_TEXT_MESSAGE, critical: e.PUSH_TEXT_CRITICAL, call: e.PUSH_TEXT_CALL },
    ...(e.APNS_KEY_FILE
      ? { apns: { url: e.APNS_URL, keyPem: read(e.APNS_KEY_FILE), keyId: e.APNS_KEY_ID!, teamId: e.APNS_TEAM_ID!, topic: e.APNS_TOPIC! } }
      : {}),
    ...(e.FCM_SERVICE_ACCOUNT_FILE ? { fcm: { url: e.FCM_URL, account: ServiceAccountJson.parse(JSON.parse(read(e.FCM_SERVICE_ACCOUNT_FILE))) } } : {}),
    ...(e.RUSTORE_PROJECT_ID ? { rustore: { url: e.RUSTORE_URL, projectId: e.RUSTORE_PROJECT_ID, serviceToken: e.RUSTORE_SERVICE_TOKEN! } } : {}),
  };
}
