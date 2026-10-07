/**
 * Генерирует CSS-переменные из design/tokens.json.
 * Запуск: pnpm tokens:css [--accent=#RRGGBB] → packages/tokens/dist/tokens.css
 * Падает, если цвет бренда не проходит проверку контраста 4,5:1.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBrand, cssVariables } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tokensPath = resolve(here, '../../../design/tokens.json');
const outPath = resolve(here, '../dist/tokens.css');

type TokenNode = { $value?: unknown; [key: string]: unknown };
const tokens = JSON.parse(readFileSync(tokensPath, 'utf8')) as Record<string, TokenNode>;

const accentArg = process.argv.find((a) => a.startsWith('--accent='))?.split('=')[1];
const accent = accentArg ?? String((tokens.brand as Record<string, TokenNode>).accent?.$value);

const issues = checkBrand(accent);
if (issues.length) {
  console.error(`Цвет бренда ${accent} не проходит проверку контраста:`);
  for (const i of issues) console.error(`  ${i.pair}: ${i.ratio}:1 (нужно ≥ 4.5:1)`);
  process.exit(1);
}

/** Плоский обход токенов с конкретными значениями (кроме выводимых из бренда). */
function flatten(node: Record<string, unknown>, path: string[], out: Map<string, string>) {
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('$') || value === null || typeof value !== 'object') continue;
    const child = value as TokenNode;
    if ('$value' in child && typeof child.$value === 'string' && /^#[0-9a-fA-F]{6}$/.test(child.$value)) {
      out.set(`--${[...path, key].join('-')}`, child.$value.toUpperCase());
    } else {
      flatten(child as Record<string, unknown>, [...path, key], out);
    }
  }
}

const vars = new Map<string, string>();
flatten({ color: tokens.color } as Record<string, unknown>, [], vars);
for (const [name, value] of Object.entries(cssVariables(accent))) vars.set(name, value);

const body = [...vars.entries()].map(([k, v]) => `  ${k}: ${v};`).join('\n');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `/* Сгенерировано из design/tokens.json — не редактировать вручную. Акцент: ${accent} */\n:root {\n${body}\n}\n`);
console.log(`Записано ${vars.size} переменных в ${outPath}`);
