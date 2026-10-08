import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

/**
 * Сквозной тест веб-клиента на живом окружении: Synapse из infra/ (docker compose up -d) + сервис контекста +
 * песочница РИС/ЛИС + Vite. Запуск: pnpm --filter @konsilium/web e2e
 */
const devEnv = {
  ...process.env,
  CCS_HOST: '0.0.0.0',
  CCS_PORT: '8080',
  HS_URL: 'http://localhost:8008',
  HS_SERVER_NAME: 'konsilium.test',
  AS_TOKEN: 'dev-only-as-token-0123456789abcdef',
  HS_TOKEN: 'dev-only-hs-token-0123456789abcdef',
  // Свой секрет псевдонимов на прогон — новые комнаты, без хвостов прошлых прогонов.
  ALIAS_SECRET: `dev-only-alias-secret-e2e-${Date.now()}`,
  CHAT_WEB_URL: 'http://localhost:5173',
  LIVEKIT_API_KEY: 'devkey',
  LIVEKIT_API_SECRET: 'secret',
  STEP_MS: '400',
  // Сроки критических находок проверяются раз в секунду: эскалация в тесте — за секунды.
  CRITICAL_TICK_MS: '1000',
  // ИИ-«Секретарь» из профиля ai (infra/docker-compose.yml): агент в Docker, сервис контекста — на хосте.
  ...(process.env.E2E_AI
    ? {
        SECRETARY_URL: 'http://localhost:8070',
        SECRETARY_TOKEN: 'dev-only-secretary-token-0123456789',
        AI_PROFILE: 'cpu',
        ASR_URL: 'ws://vosk:2700',
        LIVEKIT_INTERNAL_URL: 'ws://livekit:7880',
        CCS_CALLBACK_URL: 'http://host.docker.internal:8080',
        LLM_URL: 'http://localhost:12434/engines/v1',
        LLM_MODEL: 'ai/qwen3:1.7b-q4_K_M',
      }
    : {}),
} as Record<string, string>;

// Браузер окружения (Chromium из /opt/pw-browsers), если версия Playwright не совпадает с установленной.
const chromium = '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  // Сценарии работают в одном чате случая — по очереди.
  workers: 1,
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://localhost:5173',
    // Элемент, перекрытый другим (например, развёрнутым звонком), — ошибка через 20 с, а не ожидание до конца теста.
    actionTimeout: 20_000,
    locale: 'ru-RU',
    viewport: { width: 1360, height: 860 },
    // Тестовые камера и микрофон Chromium — для сквозного теста звонков.
    permissions: ['microphone', 'camera'],
    launchOptions: {
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
      ...(existsSync(chromium) ? { executablePath: chromium } : {}),
    },
  },
  webServer: [
    { command: 'pnpm --filter @konsilium/ccs start', url: 'http://127.0.0.1:8080/healthz', env: devEnv, reuseExistingServer: false, timeout: 60_000 },
    { command: 'pnpm --filter @konsilium/host-mock start', url: 'http://127.0.0.1:8090/healthz', env: devEnv, reuseExistingServer: false },
    { command: 'pnpm --filter @konsilium/web dev', url: 'http://localhost:5173', env: devEnv, reuseExistingServer: false },
  ],
});
