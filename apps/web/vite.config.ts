import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vitest/config';

const SDK = resolve(import.meta.dirname, '../../packages/embed/src/index.ts');

/** В разработке SDK встраивания отдаётся по тому же адресу, что и на сервере: /embed/v1/embed.js. */
const embedSdk: Plugin = {
  name: 'konsilium-embed-sdk',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url?.startsWith('/embed/v1/embed.js')) req.url = `/@fs${SDK}`;
      next();
    });
  },
};

// Адреса Synapse и сервиса контекста — VITE_HS_URL и VITE_CCS_URL (по умолчанию — окружение разработчика).
export default defineConfig({
  plugins: [react(), embedSdk],
  server: { port: 5173, strictPort: true },
  test: { include: ['src/**/*.test.ts'] },
});
