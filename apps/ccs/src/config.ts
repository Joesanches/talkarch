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
  /** PostgreSQL для реестра случаев, заявок и идемпотентности. Без него — память (данные теряются при перезапуске). */
  DATABASE_URL: z.string().url().optional(),
  CHAT_WEB_URL: z.string().url().default('http://localhost:5173'),
  LIVEKIT_URL: z.string().min(1).default('ws://localhost:7880'),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),
  /** Адрес LiveKit для агентов в той же сети (например, ws://livekit:7880). По умолчанию — LIVEKIT_URL. */
  LIVEKIT_INTERNAL_URL: z.string().min(1).optional(),
  /** ИИ-«Секретарь» (apps/secretary). Без SECRETARY_URL стенограмма выключена. */
  SECRETARY_URL: z.string().url().optional(),
  SECRETARY_TOKEN: z.string().min(16).optional(),
  /** Профиль ИИ (docs/08-video-ai.md, 5.3): gpu, cpu, external или off. */
  AI_PROFILE: z.enum(['off', 'gpu', 'cpu', 'external']).optional(),
  /** Адрес сервиса контекста для обратных вызовов агента. */
  CCS_CALLBACK_URL: z.string().url().optional(),
  /** Распознавание речи (Vosk WebSocket): ws://…:2700 */
  ASR_URL: z.string().min(1).optional(),
  /** LLM через OpenAI-совместимый API; без неё черновик протокола — по шаблону. */
  LLM_URL: z.string().url().optional(),
  LLM_MODEL: z.string().min(1).optional(),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
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
  databaseUrl?: string;
  chatWebUrl: string;
  livekit: { url: string; apiKey: string; apiSecret: string; internalUrl?: string };
  ai: {
    profile: 'off' | 'gpu' | 'cpu' | 'external';
    secretaryUrl: string | null;
    secretaryToken: string;
    callbackUrl: string;
    asrUrl: string | null;
    llm: { url: string; model: string; timeoutMs: number } | null;
  };
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = Env.parse(env);
  if (e.SECRETARY_URL && !e.SECRETARY_TOKEN) throw new Error('Для SECRETARY_URL нужен SECRETARY_TOKEN');
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
    databaseUrl: e.DATABASE_URL,
    chatWebUrl: e.CHAT_WEB_URL.replace(/\/$/, ''),
    livekit: { url: e.LIVEKIT_URL, apiKey: e.LIVEKIT_API_KEY, apiSecret: e.LIVEKIT_API_SECRET, ...(e.LIVEKIT_INTERNAL_URL ? { internalUrl: e.LIVEKIT_INTERNAL_URL } : {}) },
    ai: {
      profile: e.AI_PROFILE ?? (e.SECRETARY_URL ? 'cpu' : 'off'),
      secretaryUrl: e.SECRETARY_URL?.replace(/\/$/, '') ?? null,
      secretaryToken: e.SECRETARY_TOKEN ?? '',
      callbackUrl: (e.CCS_CALLBACK_URL ?? `http://localhost:${e.CCS_PORT}`).replace(/\/$/, ''),
      asrUrl: e.ASR_URL ?? null,
      llm: e.LLM_URL && e.LLM_MODEL ? { url: e.LLM_URL, model: e.LLM_MODEL, timeoutMs: e.LLM_TIMEOUT_MS } : null,
    },
  };
}
