import { type BlockProbeResult, maskTelegramUrl, parseTelegramUrl } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';
import { describeAnomaly } from '../../incidents/block-check.logic.js';
import { describeTelegramError } from './telegram.client.js';
import {
  esc,
  formatTelegramMessage,
  inQuietHours,
  outageDuration,
  shortOutageMessage,
} from './telegram.format.js';

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

describe('сообщение блоками (1A)', () => {
  it('заголовок без повтора имени, строка сервера с адресом, подписи жирным, пустые строки, хвост', () => {
    const t = formatTelegramMessage({
      event: 'incident_crit',
      title: 'Сервер недоступен · Финляндия #01',
      body: 'Онлайн: 605 → 0 (−100 %) за 5 минут\n\nИз России:\n• Мост — порт <не> отвечает\n\nПохоже: сервер выключен & не оплачен.',
      server: { name: 'Финляндия #01', host: '95.216.10.4' },
      footer: 'Критичный инцидент · 23:11',
    });
    const lines = t.split('\n');
    expect(lines[0]).toBe('🔴 <b>Сервер недоступен</b>');
    expect(lines[1]).toBe('<b>Финляндия #01</b> · <code>95.216.10.4</code>');
    expect(lines[2]).toBe('');
    expect(t).toContain('<b>Онлайн:</b> 605 → 0 (−100 %) за 5 минут');
    expect(t).toContain('<b>Из России:</b>\n• Мост — порт &lt;не&gt; отвечает');
    expect(t).toContain('<b>Похоже:</b> сервер выключен &amp; не оплачен.');
    expect(t.endsWith('\n\n<i>Критичный инцидент · 23:11</i>')).toBe(true);
    expect(esc('<a>')).toBe('&lt;a&gt;');
  });

  it('строка-подпись с двоеточиями внутри (адрес с портом, время) — тоже жирная; пункты и ссылки — нет', () => {
    const t = formatTelegramMessage({
      event: 'incident_crit',
      title: 'Похоже на блокировку',
      body: 'Вход арендодателя (amwey.guardora.pro:1819), из России:\n• Мост — порт отвечает\n\nПроверено в 15:57:\n• Мост: 12 мс:\nСм. https://example.com:',
    });
    expect(t).toContain(
      '<b>Вход арендодателя (amwey.guardora.pro:1819), из России:</b>\n• Мост — порт отвечает',
    );
    expect(t).toContain('<b>Проверено в 15:57:</b>');
    expect(t).toContain('\n• Мост: 12 мс:\n');
    expect(t).toContain('См. https://example.com:');
    expect(t).not.toContain('<b>См.');
  });
});

describe('текст падения онлайна', () => {
  const probe = (from: string, verdict: BlockProbeResult['verdict'], detail: string): BlockProbeResult => ({
    from,
    verdict,
    detail,
    stalledAtKb: null,
    error: null,
  });
  it('сервер недоступен отовсюду: блоки, без двойных точек, арендованный — подсказка про оплату', () => {
    const r = describeAnomaly({
      nodeName: 'vk (Аренда)',
      before: 605,
      after: 0,
      windowMin: 5,
      portKnown: true,
      result: {
        nodeName: 'vk (Аренда)',
        address: '1.2.3.4',
        sniUsed: 'site.ru',
        verdict: 'unreachable',
        probes: [probe('Мост', 'unreachable', 'Порт не отвечает совсем.')],
        foreign: [probe('Нидерланды - 2', 'unreachable', 'Порт не отвечает совсем.')],
      },
    });
    expect(r.title).toBe('Сервер недоступен · vk (Аренда)');
    expect(r.confirmed).toBe(true);
    expect(r.kind).toBe('server_down');
    expect(r.detail).toBe(
      [
        'Онлайн: 605 → 0 (−100 %) за 5 минут',
        '',
        'Из России:',
        '• Мост — порт не отвечает совсем',
        'Из-за рубежа:',
        '• Нидерланды - 2 — порт не отвечает совсем',
        '',
        'Похоже: сервер выключен, отключён хостером или арендодателем, либо закрыт firewall.',
        // Ноды нет среди серверов панели — «Биллинг» спросить не о чем, и панель так и говорит.
        'Сервер арендован: если он недоступен целиком, возможно, не оплачена аренда (оплату в «Биллинге» панель проверить не смогла).',
      ].join('\n'),
    );
    expect(r.detail).not.toContain('..');
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
  it('группа стала супергруппой, бота убрали из чата — причина и что сделать', () => {
    expect(describeTelegramError(400, 'Bad Request: group chat was upgraded to a supergroup chat')).toContain(
      'Группа стала супергруппой',
    );
    expect(describeTelegramError(403, 'Forbidden: bot is not a member of the supergroup chat')).toContain(
      'Бота нет в этом чате',
    );
  });
  it('незнакомый отказ — без английского текста: сырой ответ Telegram остаётся в логе', () => {
    const text = describeTelegramError(400, 'Bad Request: some brand new reason');
    expect(text).toBe('Telegram отказал в отправке (код 400). Точный ответ Telegram записан в лог панели.');
    expect(text.replaceAll('Telegram', '')).not.toMatch(/[A-Za-z]{3,}/);
  });
});

describe('короткий сбой, о котором не успели сообщить', () => {
  it('сколько длился — словами', () => {
    expect(outageDuration(0)).toBe('меньше минуты');
    expect(outageDuration(59_900)).toBe('меньше минуты');
    expect(outageDuration(60_000)).toBe('1 мин');
    expect(outageDuration(90_500)).toBe('1 мин 30 с');
    expect(outageDuration(12 * 60_000 + 40_000)).toBe('12 мин');
    expect(outageDuration(125 * 60_000)).toBe('2 ч 5 мин');
    expect(outageDuration(120 * 60_000)).toBe('2 ч');
  });
  it('сбой прошёл сам: что было, сколько длился, что сейчас в норме', () => {
    const m = shortOutageMessage({ what: 'Сервер недоступен', lastedMs: 90_000, recovered: true });
    expect(m.title).toBe('Короткий сбой уже прошёл: Сервер недоступен');
    expect(m.body).toBe('Длился с момента обнаружения: 1 мин 30 с\nСейчас: в норме — проблема исчезла сама.');
    const t = formatTelegramMessage({
      event: 'resolved',
      ...m,
      server: { name: 'Финляндия #01', host: '95.216.10.4' },
      footer: 'Починилось · 14:01',
    });
    expect(t).toBe(
      [
        '✅ <b>Короткий сбой уже прошёл: Сервер недоступен</b>',
        '<b>Финляндия #01</b> · <code>95.216.10.4</code>',
        '',
        '<b>Длился с момента обнаружения:</b> 1 мин 30 с',
        '<b>Сейчас:</b> в норме — проблема исчезла сама.',
        '',
        '<i>Починилось · 14:01</i>',
      ].join('\n'),
    );
  });
  it('помог шаг — «в норме» и чем помогло; закрыто по другой причине — «в норме» не утверждаем', () => {
    expect(
      shortOutageMessage({
        what: 'Контейнер ноды не запущен',
        lastedMs: 70_000,
        recovered: true,
        how: 'помог шаг «Поднять контейнер ноды» (автоматически)',
      }).body,
    ).toBe(
      'Длился с момента обнаружения: 1 мин 10 с\nСейчас: в норме — помог шаг «Поднять контейнер ноды» (автоматически).',
    );
    const closed = shortOutageMessage({
      what: 'Контейнер ноды не запущен',
      lastedMs: 20_000,
      recovered: false,
      how: 'Слежение за нодой на этом сервере выключено — инцидент закрыт',
    });
    expect(closed.title).toBe('Короткий сбой, дело уже закрыто: Контейнер ноды не запущен');
    expect(closed.body).toBe(
      'Длился с момента обнаружения: меньше минуты\nЧем закончилось: Слежение за нодой на этом сервере выключено — инцидент закрыт.',
    );
    // Причина не названа — строки «чем закончилось» нет, выдумывать её панель не станет.
    expect(shortOutageMessage({ what: 'Диск заполняется', lastedMs: 1_000, recovered: false }).body).toBe(
      'Длился с момента обнаружения: меньше минуты',
    );
  });
});
