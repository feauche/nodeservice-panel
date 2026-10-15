import { describe, expect, it } from 'vitest';

import { heartbeatSettingsSchema, heartbeatTestRequestSchema } from './heartbeat.js';

const message = (url: string) => heartbeatSettingsSchema.safeParse({ url }).error?.issues[0]?.message;

describe('адрес сигнала «панель жива»', () => {
  it('пустой — сигнал выключен; пробелы по краям убираются', () => {
    expect(heartbeatSettingsSchema.parse({ url: '' }).url).toBe('');
    expect(heartbeatSettingsSchema.parse({ url: '  ' }).url).toBe('');
    expect(heartbeatSettingsSchema.parse({ url: ' https://hc-ping.com/abc ' }).url).toBe(
      'https://hc-ping.com/abc',
    );
  });

  it('принимает ссылки сервисов проверки', () => {
    for (const url of [
      'https://hc-ping.com/5b4e6c8a-1d2f-4c3b-9a8e-7f6d5c4b3a21',
      'https://kuma.example.com/api/push/Ab12Cd34?status=up&msg=OK&ping=',
      'https://uptime.betterstack.com/api/v1/heartbeat/AbCdEf123',
      'http://monitor.example.org:3001/api/push/x',
    ])
      expect(heartbeatSettingsSchema.safeParse({ url }).success, url).toBe(true);
  });

  it('не http(s), не адрес, с логином и паролем, слишком длинный — понятная ошибка по-русски', () => {
    expect(message('ftp://hc-ping.com/abc')).toBe('Адрес должен начинаться с https:// или http://');
    expect(message('javascript:alert(1)')).toBe('Адрес должен начинаться с https:// или http://');
    expect(message('hc-ping.com/abc')).toBe('Введите адрес вида https://hc-ping.com/…');
    expect(message('https://user:pass@hc-ping.com/abc')).toBe(
      'Адрес с логином и паролем не подходит — нужна ссылка сервиса',
    );
    expect(message(`https://hc-ping.com/${'a'.repeat(500)}`)).toBe('Не длиннее 500 символов');
  });

  it('проверка — с адресом или без (тогда берётся сохранённый)', () => {
    expect(heartbeatTestRequestSchema.parse({})).toEqual({});
    expect(heartbeatTestRequestSchema.parse({ url: 'https://hc-ping.com/x' }).url).toBe(
      'https://hc-ping.com/x',
    );
    expect(heartbeatTestRequestSchema.safeParse({ url: 'нет' }).success).toBe(false);
  });
});
