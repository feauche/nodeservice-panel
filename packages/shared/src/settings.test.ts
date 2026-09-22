import { describe, expect, it } from 'vitest';

import { appearanceSettingsSchema, brandNamePlain, brandNameSchema, parseBrandName } from './settings.js';

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
