/**
 * Корпоративный стиль задаётся одним цветом бренда; остальные оттенки выводятся формулами.
 * Формулы совпадают с docs/06-design-system.md и макетами на холсте.
 */

const HEX = /^#[0-9a-fA-F]{6}$/;

export function assertHex(hex: string): string {
  if (!HEX.test(hex)) throw new Error(`Ожидается цвет вида #RRGGBB, получено: ${hex}`);
  return hex.toUpperCase();
}

/** Линейное смешение каналов sRGB: k — доля цвета `to` (0…1). Округление как Math.round в макетах. */
export function mix(hex: string, to: string, k: number): string {
  const a = parseInt(assertHex(hex).slice(1), 16);
  const b = parseInt(assertHex(to).slice(1), 16);
  const ch = (shift: number) => Math.round(((a >> shift) & 255) * (1 - k) + ((b >> shift) & 255) * k);
  return '#' + [ch(16), ch(8), ch(0)].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Относительная яркость по WCAG 2.1. */
export function luminance(hex: string): number {
  const n = parseInt(assertHex(hex).slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** Отношение контраста по WCAG 2.1 (1…21). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export interface BrandShades {
  accent: string;
  accentText: string;
  accentSoft: string;
  bubbleOut: string;
  bubbleOutMeta: string;
  darkBubbleOut: string;
}

export const DARK_BG = '#0E141B';

export function deriveShades(accent: string): BrandShades {
  const base = assertHex(accent);
  return {
    accent: base,
    accentText: mix(base, '#000000', 0.15),
    accentSoft: mix(base, '#FFFFFF', 0.88),
    bubbleOut: mix(base, '#FFFFFF', 0.85),
    bubbleOutMeta: mix(base, '#000000', 0.3),
    darkBubbleOut: mix(base, DARK_BG, 0.5),
  };
}

export const TEXT = '#16202B';
export const DARK_TEXT = '#E8EEF4';
export const MIN_CONTRAST = 4.5;

export interface ContrastIssue {
  pair: string;
  ratio: number;
}

/** Пары «текст / фон», которые обязаны держать ≥ 4,5:1. Пустой массив — бренд годится для интерфейса. */
export function checkBrand(accent: string): ContrastIssue[] {
  const s = deriveShades(accent);
  const pairs: Array<[string, string, string]> = [
    ['белый текст на акценте', '#FFFFFF', s.accent],
    ['ссылка на белом', s.accentText, '#FFFFFF'],
    ['ссылка на мягком фоне', s.accentText, s.accentSoft],
    ['метаданные в исходящем пузыре', s.bubbleOutMeta, s.bubbleOut],
    ['текст в исходящем пузыре', TEXT, s.bubbleOut],
    ['текст в исходящем пузыре (тёмная тема)', DARK_TEXT, s.darkBubbleOut],
  ];
  return pairs
    .map(([pair, fg, bg]) => ({ pair, ratio: Math.round(contrast(fg, bg) * 100) / 100 }))
    .filter((p) => p.ratio < MIN_CONTRAST);
}

/** CSS-переменные темы для подстановки в :root (веб-клиент, виджет, десктоп). */
export function cssVariables(accent: string): Record<string, string> {
  const s = deriveShades(accent);
  return {
    '--color-accent': s.accent,
    '--color-accent-text': s.accentText,
    '--color-accent-soft': s.accentSoft,
    '--color-bubble-out': s.bubbleOut,
    '--color-bubble-out-meta': s.bubbleOutMeta,
    '--color-dark-bubble-out': s.darkBubbleOut,
  };
}
