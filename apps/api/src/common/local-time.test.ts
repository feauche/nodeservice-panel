import { describe, expect, it } from 'vitest';

import {
  localClock,
  localDateTime,
  localDay,
  localizeIsoTimes,
  safeTimeZone,
  zoneLabel,
} from './local-time.js';

const OMSK = 'Asia/Omsk';
const NOW = new Date('2026-09-30T09:58:00Z');

describe('время в поясе панели', () => {
  it('дата и время словами: год — только если он не текущий', () => {
    expect(localDateTime(new Date('2026-09-30T10:00:00Z'), OMSK, NOW)).toBe('30 сентября, 16:00');
    expect(localDateTime(new Date('2026-09-30T10:00:00Z'), 'Europe/Moscow', NOW)).toBe('30 сентября, 13:00');
    expect(localDateTime(new Date('2025-03-01T00:05:00Z'), OMSK, NOW)).toBe('1 марта 2025, 06:05');
    // Полночь — «00:00», а не «24:00».
    expect(localDateTime(new Date('2026-09-29T18:00:00Z'), OMSK, NOW)).toBe('30 сентября, 00:00');
  });

  it('по просьбе — с годом всегда и с секундами', () => {
    expect(localDateTime(NOW, OMSK, NOW, { year: true })).toBe('30 сентября 2026, 15:58');
    expect(localDateTime(new Date('2026-09-30T09:56:03Z'), OMSK, NOW, { seconds: true })).toBe(
      '30 сентября, 15:56:03',
    );
  });

  it('только дата — с годом: по ней судят, не устарели ли сведения', () => {
    // 1 октября, 03:00 в Омске — по UTC это ещё 30 сентября.
    expect(localDay(new Date('2026-09-30T21:00:00Z'), OMSK)).toBe('1 октября 2026');
    expect(localDay(new Date('2026-09-30T21:00:00Z'), 'UTC')).toBe('30 сентября 2026');
  });

  it('только часы и минуты', () => {
    expect(localClock(new Date('2026-09-30T09:55:00Z'), OMSK)).toBe('15:55');
    expect(localClock(new Date('2026-09-30T21:00:00Z'), 'Europe/Moscow')).toBe('00:00');
  });

  it('подпись пояса: Москва — «МСК», остальное — смещением', () => {
    expect(zoneLabel(NOW, 'Europe/Moscow')).toBe('МСК');
    expect(zoneLabel(NOW, OMSK)).toBe('UTC+6');
    expect(zoneLabel(NOW, 'UTC')).toBe('UTC+0');
  });

  it('неизвестный пояс не роняет форматирование: берётся пояс по умолчанию', () => {
    expect(safeTimeZone('Нет/Такого')).toBe('Europe/Moscow');
    expect(safeTimeZone(null)).toBe('Europe/Moscow');
    expect(safeTimeZone(OMSK)).toBe(OMSK);
    expect(localDateTime(new Date('2026-09-30T10:00:00Z'), 'Нет/Такого', NOW)).toBe('30 сентября, 13:00');
    expect(localClock(new Date('2026-09-30T10:00:00Z'), 'Нет/Такого')).toBe('13:00');
  });
});

describe('localizeIsoTimes: отметки времени в данных для Джарвиса — в поясе панели', () => {
  it('отметки в данных дела заменяются временем панели, остальной текст не меняется', () => {
    const json = JSON.stringify({
      openedAt: '2026-09-30T09:56:03.000Z',
      timeline: [{ at: '2026-09-30T09:57:10.412Z', action: 'Обнаружено' }],
      title: 'Резко упал онлайн · guardora (Аренда)',
    });
    const out = localizeIsoTimes(json, OMSK, NOW);
    expect(out).toBe(
      '{"openedAt":"30 сентября, 15:56:03","timeline":[{"at":"30 сентября, 15:57:10","action":"Обнаружено"}],"title":"Резко упал онлайн · guardora (Аренда)"}',
    );
    // Результат остаётся разбираемым JSON.
    expect(JSON.parse(out).openedAt).toBe('30 сентября, 15:56:03');
  });

  it('понимает секунды с долями любой длины, без секунд и со смещением вместо Z', () => {
    expect(localizeIsoTimes('старт 2026-09-30T09:56:03.123456789Z INFO', OMSK, NOW)).toBe(
      'старт 30 сентября, 15:56:03 INFO',
    );
    // Секунд в отметке не было — их и не выдумываем.
    expect(localizeIsoTimes('2026-09-30T09:56Z', OMSK, NOW)).toBe('30 сентября, 15:56');
    expect(localizeIsoTimes('2026-09-30T12:56:03+03:00', OMSK, NOW)).toBe('30 сентября, 15:56:03');
    expect(localizeIsoTimes('2026-09-30T09:56:03+0000', OMSK, NOW)).toBe('30 сентября, 15:56:03');
  });

  it('многострочный журнал внутри JSON: переводится отметка в начале каждой строки, а не только первой', () => {
    // В JSON перевод строки записан двумя знаками «\n» — перед отметкой стоит буква n.
    const json = JSON.stringify({
      server: 'x',
      logs: '2026-09-30T09:56:03+0000 host agent[1]: a\n2026-09-30T09:57:03+0000 host agent[1]: b\n\t2026-09-30T09:57:30+0000 c\r\n2026-09-30T09:58:00+0000 d',
    });
    const out = localizeIsoTimes(json, OMSK, NOW);
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(JSON.parse(out).logs).toBe(
      '30 сентября, 15:56:03 host agent[1]: a\n30 сентября, 15:57:03 host agent[1]: b\n\t30 сентября, 15:57:30 c\r\n30 сентября, 15:58:00 d',
    );
    // Тот же текст с настоящими переводами строк.
    expect(localizeIsoTimes('a\n2026-09-30T09:57:03Z b', OMSK, NOW)).toBe('a\n30 сентября, 15:57:03 b');
  });

  it('прошлый год называется явно', () => {
    expect(localizeIsoTimes('"2025-12-31T20:30:00.000Z"', OMSK, NOW)).toBe('"1 января, 02:30:00"');
    expect(localizeIsoTimes('"2025-03-01T00:05:00.000Z"', OMSK, NOW)).toBe('"1 марта 2025, 06:05:00"');
  });

  it('не трогает даты без времени, имена файлов, невозможные даты и время без пояса', () => {
    for (const s of [
      '2026-09-30',
      'nodeservice-2026-09-30T09-56-03Z.tar.gz',
      '2026-13-45T99:99:00Z',
      '2026-09-30T09:56:03',
      'x2026-09-30T09:56:03Z',
      // Буква перед отметкой — не экранированный перевод строки: это часть слова.
      'in2026-09-30T09:56:03Z',
    ])
      expect(localizeIsoTimes(s, OMSK, NOW), s).toBe(s);
  });
});
