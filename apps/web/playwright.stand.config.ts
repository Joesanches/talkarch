import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

/**
 * Сквозные тесты против развёрнутого стенда (deploy/stand). Пример для стенда на localhost:
 *   cd deploy/stand && ./stand.sh ca > /tmp/stand-ca.crt && set -a && . ./.env && set +a && cd -
 *   STAND_URL=https://localhost DEV_USERS_PASSWORD=$DEMO_PASSWORD E2E_LIS_TOKEN=$LIS_TOKEN \
 *   NODE_EXTRA_CA_CERTS=/tmp/stand-ca.crt npx playwright test -c playwright.stand.config.ts
 */
const stand = process.env.STAND_URL ?? 'https://localhost';
process.env.E2E_HS_URL ??= stand;
process.env.E2E_CCS_URL ??= stand;
const chromium = '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: stand,
    // Стенд с TLS_MODE=internal — собственный сертификат Caddy.
    ignoreHTTPSErrors: true,
    locale: 'ru-RU',
    viewport: { width: 1360, height: 860 },
    permissions: ['microphone', 'camera'],
    launchOptions: {
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
      ...(existsSync(chromium) ? { executablePath: chromium } : {}),
    },
  },
});
