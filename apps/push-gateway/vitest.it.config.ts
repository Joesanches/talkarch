import { defineConfig } from 'vitest/config';

// Интеграционные тесты: нужен поднятый сервер сообщений из infra/ (Synapse или Tuwunel, см. infra/README.md).
export default defineConfig({
  test: {
    include: ['test/it/**/*.it.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
