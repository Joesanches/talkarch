import { describe, expect, it } from 'vitest';
import { checkBrand, contrast, cssVariables, deriveShades, mix } from '../src/index.ts';

describe('deriveShades', () => {
  it('совпадает со значениями из design/tokens.json для пресета clinical-blue', () => {
    expect(deriveShades('#1F6FB2')).toEqual({
      accent: '#1F6FB2',
      accentText: '#1A5E97',
      accentSoft: '#E4EEF6',
      bubbleOut: '#DDE9F3',
      bubbleOutMeta: '#164E7D',
      darkBubbleOut: '#174267',
    });
  });

  it('совпадает для пресета terracotta', () => {
    expect(deriveShades('#b4532a').bubbleOutMeta).toBe('#7E3A1D');
  });
});

describe('контраст', () => {
  it('белый на чёрном — 21:1', () => {
    expect(contrast('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
  });

  it.each(['#1F6FB2', '#0E7C6B', '#6E3FA3', '#B4532A'])('пресет %s проходит проверку 4,5:1', (accent) => {
    expect(checkBrand(accent)).toEqual([]);
  });

  it('слишком светлый фирменный цвет отклоняется — для заливок нужен затемнённый вариант', () => {
    const issues = checkBrand('#7FB8E6');
    expect(issues.map((i) => i.pair)).toContain('белый текст на акценте');
  });
});

describe('mix и cssVariables', () => {
  it('k = 0 и k = 1 дают исходные цвета', () => {
    expect(mix('#123456', '#FFFFFF', 0)).toBe('#123456');
    expect(mix('#123456', '#FFFFFF', 1)).toBe('#FFFFFF');
  });

  it('выдаёт набор переменных темы', () => {
    expect(cssVariables('#1F6FB2')['--color-bubble-out']).toBe('#DDE9F3');
  });

  it('отклоняет неверный формат цвета', () => {
    expect(() => deriveShades('blue')).toThrow();
  });
});
