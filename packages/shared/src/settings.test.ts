import { describe, expect, it } from 'vitest';

import {
  appearanceSettingsSchema,
  brandNamePlain,
  brandNameSchema,
  customSitesSchema,
  parseBrandName,
} from './settings.js';

describe('parseBrandName', () => {
  it('красит сегменты кодами цвета, пробелы сохраняет', () => {
    expect(parseBrandName('Node[#accent]Service')).toEqual([
      { text: 'Node', color: null },
      { text: 'Service', color: 'accent' },
    ]);
    expect(parseBrandName('[#111111]Node [#22aaFF]Service')).toEqual([
      { text: 'Node ', color: '#111111' },
      { text: 'Service', color: '#22aaff' },
    ]);
    expect(parseBrandName('[#f00]Красный')).toEqual([{ text: 'Красный', color: '#f00' }]);
    // без скобок — обычный текст, не код
    expect(parseBrandName('#accentNode')).toEqual([{ text: '#accentNode', color: null }]);
  });
  it('видимый текст без кодов; пустое название не проходит', () => {
    expect(brandNamePlain('[#111111]Node[#accent]Service')).toBe('NodeService');
    expect(brandNameSchema.safeParse('[#111111]').success).toBe(false);
    expect(brandNameSchema.safeParse('x'.repeat(65)).success).toBe(false);
  });
  it('схема подставляет название по умолчанию', () => {
    expect(appearanceSettingsSchema.parse({ logoUrl: null }).brandName).toBe('Node[#accent]Service');
  });
});

describe('customSitesSchema', () => {
  const site = (n: number, url = `https://site-${n}.example`) => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    name: `Сайт ${n}`,
    url,
  });

  it('принимает не больше пяти HTTP(S)-ссылок', () => {
    expect(
      customSitesSchema.parse({ items: Array.from({ length: 5 }, (_, i) => site(i + 1)) }).items,
    ).toHaveLength(5);
    expect(
      customSitesSchema.safeParse({ items: Array.from({ length: 6 }, (_, i) => site(i + 1)) }).success,
    ).toBe(false);
  });

  it('не принимает опасные протоколы и пустое название', () => {
    expect(customSitesSchema.safeParse({ items: [site(1, 'javascript:alert(1)')] }).success).toBe(false);
    expect(customSitesSchema.safeParse({ items: [{ ...site(1), name: '   ' }] }).success).toBe(false);
  });
});
