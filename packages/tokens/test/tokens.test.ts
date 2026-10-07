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

describe('themeCss', () => {
  it('собирает тему из design/tokens.json и акцента', async () => {
    const { themeCss, themeVariables } = await import('../src/theme.ts');
    const vars = themeVariables('#0E7C6B');
    expect(vars.get('--color-accent')).toBe('#0E7C6B');
    expect(vars.get('--color-neutral-text')).toBe('#16202B');
    expect(vars.get('--font-ui')).toMatch(/Golos Text/);
    expect(themeCss('#0E7C6B', '.chat')).toMatch(/^\.chat \{\n  --color-/);
  });

  it('не принимает акцент с плохим контрастом', async () => {
    const { themeVariables } = await import('../src/theme.ts');
    expect(() => themeVariables('#FFE680')).toThrow(/контраст/);
  });
});
