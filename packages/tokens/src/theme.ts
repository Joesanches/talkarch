/**
 * Тема интерфейса из design/tokens.json: нейтральные и семантические цвета как есть, оттенки бренда — из акцента.
 * Используется и при сборке (scripts/build-css.ts), и во время работы клиента: встроенный чат получает акцент
 * от РИС/ЛИС и пересчитывает тему сам (docs/04-embedding.md, раздел 6).
 */
import tokens from '../../../design/tokens.json' with { type: 'json' };
import { checkBrand, cssVariables } from './index.ts';

type TokenNode = { $value?: unknown; [key: string]: unknown };

export const DEFAULT_ACCENT: string = tokens.brand.accent.$value;
export const FONT_UI: string = tokens.brand.font.ui.$value.map((f) => (f.includes(' ') ? `"${f}"` : f)).join(', ');
export const FONT_MONO: string = tokens.brand.font.mono.$value.map((f) => (f.includes(' ') ? `"${f}"` : f)).join(', ');

/** Плоский обход токенов с конкретными цветами (кроме выводимых из бренда). */
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

/** CSS-переменные темы. Бросает ошибку, если акцент не проходит проверку контраста 4,5:1. */
export function themeVariables(accent: string = DEFAULT_ACCENT): Map<string, string> {
  const issues = checkBrand(accent);
  if (issues.length) {
    throw new Error(`Цвет бренда ${accent} не проходит проверку контраста: ${issues.map((i) => `${i.pair} ${i.ratio}:1`).join(', ')}`);
  }
  const vars = new Map<string, string>();
  flatten({ color: tokens.color } as Record<string, unknown>, [], vars);
  for (const [name, value] of Object.entries(cssVariables(accent))) vars.set(name, value);
  vars.set('--font-ui', FONT_UI);
  vars.set('--font-mono', FONT_MONO);
  return vars;
}

export function themeCss(accent: string = DEFAULT_ACCENT, selector = ':root'): string {
  const body = [...themeVariables(accent).entries()].map(([k, v]) => `  ${k}: ${v};`).join('\n');
  return `${selector} {\n${body}\n}\n`;
}
