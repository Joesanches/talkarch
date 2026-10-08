import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/** Сборка SDK встраивания в dist/embed/v1/embed.js (ES-модуль без зависимостей). */
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: resolve(import.meta.dirname, '../../packages/embed/src/index.ts'),
      formats: ['es'],
      fileName: () => 'embed/v1/embed.js',
    },
  },
});
