import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Адреса Synapse и сервиса контекста — VITE_HS_URL и VITE_CCS_URL (по умолчанию — окружение разработчика).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  test: { include: ['src/**/*.test.ts'] },
});
