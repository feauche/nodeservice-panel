import { maskTelegramUrl, parseTelegramUrl } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import { describeTelegramError } from './telegram.client.js';
import { esc, formatTelegramMessage, inQuietHours } from './telegram.format.js';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

describe('ссылка tgram://', () => {
  it('группа с темой, группа без темы, личный чат', () => {
    expect(parseTelegramUrl(`tgram://${TOKEN}/-1002946167407:8`)).toEqual({
      token: TOKEN,
      chatId: '-1002946167407',
      topic: 8,
    });
    expect(parseTelegramUrl(`tgram://${TOKEN}/-1002946167407`)?.topic).toBeNull();
    expect(parseTelegramUrl(` tgram://${TOKEN}/412345678 `)?.chatId).toBe('412345678');
  });
  it('мусор и неполные ссылки не принимаются', () => {
    for (const bad of [
      '',
      'tgram://',
      `tgram://${TOKEN}`,
      `https://${TOKEN}/1234`,
      'tgram://abc/-100123',
      `tgram://${TOKEN}/-100x`,
    ])
      expect(parseTelegramUrl(bad), bad).toBeNull();
  });
  it('маска скрывает токен', () => {
    expect(maskTelegramUrl('-1002946167407', 8)).toBe('tgram://***/-1002946167407:8');
    expect(maskTelegramUrl('412345678', null)).toBe('tgram://***/412345678');
  });
});

describe('сообщение (M2)', () => {
  it('заголовок жирным, текст, сервер с адресом, хвост курсивом; HTML экранируется', () => {
    const t = formatTelegramMessage({
      event: 'incident_crit',
      title: 'Похоже на блокировку IP <из России>',
      body: 'Онлайн 477 → 6 & порт молчит.',
      server: { name: 'vk (Аренда)', host: '81.177.1.2' },
      footer: 'Критичный инцидент · 17:12',
    });
    expect(t.startsWith('🔴 <b>Похоже на блокировку IP &lt;из России&gt;</b>')).toBe(true);
    expect(t).toContain('Онлайн 477 → 6 &amp; порт молчит.');
    expect(t).toContain('Сервер: <b>vk (Аренда)</b> <code>81.177.1.2</code>');
    expect(t).toContain('<i>Критичный инцидент · 17:12</i>');
    expect(esc('<a>')).toBe('&lt;a&gt;');
  });
});

describe('тихие часы', () => {
  const at = (iso: string) => new Date(iso);
  it('окно через полночь в поясе владельца', () => {
    // 21:30 UTC = 00:30 по Москве
    expect(inQuietHours(at('2026-09-28T21:30:00Z'), '23:00', '08:00', 'Europe/Moscow')).toBe(true);
    // 06:00 UTC = 09:00 по Москве
    expect(inQuietHours(at('2026-09-28T06:00:00Z'), '23:00', '08:00', 'Europe/Moscow')).toBe(false);
    expect(inQuietHours(at('2026-09-28T13:00:00Z'), '12:00', '14:00', 'UTC')).toBe(true);
    expect(inQuietHours(at('2026-09-28T13:00:00Z'), '12:00', '14:00', 'Нет/Такого')).toBe(false);
  });
});

describe('ошибки Telegram по-русски', () => {
  it('частые случаи', () => {
    expect(describeTelegramError(401, 'Unauthorized')).toContain('@BotFather');
    expect(describeTelegramError(403, "Forbidden: bot can't initiate conversation with a user")).toContain(
      'Старт',
    );
    expect(describeTelegramError(400, 'Bad Request: chat not found')).toContain('добавьте бота');
    expect(describeTelegramError(400, 'Bad Request: message thread not found')).toContain('Тема не найдена');
    expect(describeTelegramError(0, 'timeout')).toContain('в России');
  });
});
