import { defineConfig } from 'vitest/config';

// Интеграционные тесты: нужен поднятый Synapse из infra/ (см. infra/README.md).
export default defineConfig({
  test: {
    include: ['test/it/**/*.it.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
