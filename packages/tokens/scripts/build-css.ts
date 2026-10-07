/**
 * Генерирует CSS-переменные из design/tokens.json.
 * Запуск: pnpm tokens:css [--accent=#RRGGBB] → packages/tokens/dist/tokens.css
 * Падает, если цвет бренда не проходит проверку контраста 4,5:1.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ACCENT, themeCss, themeVariables } from '../src/theme.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, '../dist/tokens.css');
const accent = process.argv.find((a) => a.startsWith('--accent='))?.split('=')[1] ?? DEFAULT_ACCENT;

let css: string;
try {
  css = themeCss(accent);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `/* Сгенерировано из design/tokens.json — не редактировать вручную. Акцент: ${accent} */\n${css}`);
console.log(`Записано ${themeVariables(accent).size} переменных в ${outPath}`);
