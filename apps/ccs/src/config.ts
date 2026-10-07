import { z } from 'zod';

const Env = z.object({
  CCS_HOST: z.string().default('0.0.0.0'),
  CCS_PORT: z.coerce.number().int().positive().default(8080),
  HS_URL: z.string().url().default('http://localhost:8008'),
  HS_SERVER_NAME: z.string().min(1).default('konsilium.test'),
  AS_TOKEN: z.string().min(16),
  HS_TOKEN: z.string().min(16),
  AS_SENDER_LOCALPART: z.string().min(1).default('ccs'),
  /** `id` из регистрации Application Service (infra/synapse/appservice-ccs.yaml). */
  AS_ID: z.string().min(1).default('konsilium-ccs'),
  ALIAS_SECRET: z.string().min(16),
  CONNECTORS_FILE: z.string().min(1).default('fixtures/connectors.json'),
  CHAT_WEB_URL: z.string().url().default('http://localhost:5173'),
  LIVEKIT_URL: z.string().min(1).default('ws://localhost:7880'),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),
});

export type Config = {
  host: string;
  port: number;
  hsUrl: string;
  serverName: string;
  asToken: string;
  hsToken: string;
  botUserId: string;
  asId: string;
  aliasSecret: string;
  connectorsFile: string;
  chatWebUrl: string;
  livekit: { url: string; apiKey: string; apiSecret: string };
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = Env.parse(env);
  return {
    host: e.CCS_HOST,
    port: e.CCS_PORT,
    hsUrl: e.HS_URL.replace(/\/$/, ''),
    serverName: e.HS_SERVER_NAME,
    asToken: e.AS_TOKEN,
    hsToken: e.HS_TOKEN,
    botUserId: `@${e.AS_SENDER_LOCALPART}:${e.HS_SERVER_NAME}`,
    asId: e.AS_ID,
    aliasSecret: e.ALIAS_SECRET,
    connectorsFile: e.CONNECTORS_FILE,
    chatWebUrl: e.CHAT_WEB_URL.replace(/\/$/, ''),
    livekit: { url: e.LIVEKIT_URL, apiKey: e.LIVEKIT_API_KEY, apiSecret: e.LIVEKIT_API_SECRET },
  };
}
