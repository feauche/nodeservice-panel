import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { providerSiteUrlSchema } from './providers.js';
import './zod-ru.js';

const message = (schema: z.ZodType, value: unknown) => schema.safeParse(value).error?.issues[0]?.message;

describe('русские тексты ошибок проверки полей', () => {
  it('числа: порт, интервалы, пороги', () => {
    const port = z.coerce.number().int().min(1).max(65535);
    expect(message(port, 99999)).toBe('Не больше 65535');
    expect(message(port, 0)).toBe('Не меньше 1');
    expect(message(port, 'abc')).toBe('Введите число');
    expect(message(z.number().positive(), 0)).toBe('Больше 0');
  });

  it('строки и списки — с правильным склонением', () => {
    expect(message(z.string().max(500), 'x'.repeat(501))).toBe('Не длиннее 500 символов');
    expect(message(z.string().max(21), 'x'.repeat(22))).toBe('Не длиннее 21 символа');
    expect(message(z.string().min(1), '')).toBe('Заполните поле');
    expect(message(z.string().min(3), 'ab')).toBe('Не короче 3 символов');
    expect(message(z.array(z.string()).min(1), [])).toBe('Выберите хотя бы один вариант');
    expect(message(z.string(), undefined)).toBe('Заполните поле');
  });

  it('форматы и варианты', () => {
    expect(message(z.email(), 'нет')).toBe('Неверный адрес почты');
    expect(message(z.enum(['a', 'b']), 'c')).toBe('Выберите один из вариантов');
  });

  it('своё сообщение схемы важнее общего', () => {
    expect(message(z.string().min(1, 'Введите название'), '')).toBe('Введите название');
  });

  it('сайт провайдера: «не сайт вообще» не проходит, обычные адреса — да', () => {
    expect(message(providerSiteUrlSchema, 'hello world')).toBe('Введите адрес сайта, например hetzner.com');
    expect(message(providerSiteUrlSchema, 'https://x')).toBe('Введите адрес сайта, например hetzner.com');
    expect(providerSiteUrlSchema.parse('hetzner.com')).toBe('https://hetzner.com');
    expect(providerSiteUrlSchema.parse('https://1.2.3.4')).toBe('https://1.2.3.4');
    expect(providerSiteUrlSchema.parse('localhost:8080')).toBe('https://localhost:8080');
    expect(providerSiteUrlSchema.safeParse('пример.рф').success).toBe(true);
  });
});
