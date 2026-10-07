import { z } from 'zod';

const Env = z.object({
  CCS_HOST: z.string().default('0.0.0.0'),
  CCS_PORT: z.coerce.number().int().positive().default(8080),
  CCS_ORG: z.string().min(1).default('clinic'),
  HS_URL: z.string().url().default('http://localhost:8008'),
  HS_SERVER_NAME: z.string().min(1).default('konsilium.test'),
  AS_TOKEN: z.string().min(16),
  HS_TOKEN: z.string().min(16),
  AS_SENDER_LOCALPART: z.string().min(1).default('ccs'),
  ALIAS_SECRET: z.string().min(16),
  HOST_DIRECTORY_FILE: z.string().min(1).default('fixtures/host-directory.json'),
  LIVEKIT_URL: z.string().min(1).default('ws://localhost:7880'),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),
});

export type Config = {
  host: string;
  port: number;
  org: string;
  hsUrl: string;
  serverName: string;
  asToken: string;
  hsToken: string;
  botUserId: string;
  aliasSecret: string;
  hostDirectoryFile: string;
  livekit: { url: string; apiKey: string; apiSecret: string };
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = Env.parse(env);
  return {
    host: e.CCS_HOST,
    port: e.CCS_PORT,
    org: e.CCS_ORG,
    hsUrl: e.HS_URL.replace(/\/$/, ''),
    serverName: e.HS_SERVER_NAME,
    asToken: e.AS_TOKEN,
    hsToken: e.HS_TOKEN,
    botUserId: `@${e.AS_SENDER_LOCALPART}:${e.HS_SERVER_NAME}`,
    aliasSecret: e.ALIAS_SECRET,
    hostDirectoryFile: e.HOST_DIRECTORY_FILE,
    livekit: { url: e.LIVEKIT_URL, apiKey: e.LIVEKIT_API_KEY, apiSecret: e.LIVEKIT_API_SECRET },
  };
}
