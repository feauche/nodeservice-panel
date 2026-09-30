import { describe, expect, it } from 'vitest';

import { blockSecondsForSeries, retryAfterSeconds, shouldBlock, throttleIp } from './throttle.schedule.js';

describe('throttle schedule', () => {
  it('серии 1..4 → 30, 60, 300, 900; дальше — плато 900', () => {
    expect(blockSecondsForSeries(1)).toBe(30);
    expect(blockSecondsForSeries(2)).toBe(60);
    expect(blockSecondsForSeries(3)).toBe(300);
    expect(blockSecondsForSeries(4)).toBe(900);
    expect(blockSecondsForSeries(5)).toBe(900);
    expect(blockSecondsForSeries(100)).toBe(900);
  });

  it('некорректный номер серии не ломает расчёт', () => {
    expect(blockSecondsForSeries(0)).toBe(30);
    expect(blockSecondsForSeries(-3)).toBe(30);
  });

  it('пауза начинается ровно после 5 неудач', () => {
    expect(shouldBlock(4)).toBe(false);
    expect(shouldBlock(5)).toBe(true);
    expect(shouldBlock(6)).toBe(true);
  });

  it('Retry-After округляется вверх и не бывает нулём', () => {
    expect(retryAfterSeconds(0)).toBe(1);
    expect(retryAfterSeconds(1)).toBe(1);
    expect(retryAfterSeconds(29_001)).toBe(30);
  });
});

describe('throttleIp — ключ счёта по адресу', () => {
  it('IPv4 считается целиком; запись «::ffff:…» — тот же IPv4', () => {
    expect(throttleIp('203.0.113.7')).toBe('203.0.113.7');
    expect(throttleIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(throttleIp('::FFFF:203.0.113.7')).toBe('203.0.113.7');
    expect(throttleIp('::ffff:cb00:7107')).toBe('203.0.113.7');
    // соседний адрес той же сети /24 — отдельный ключ: чужие неудачи соседа не должны держать владельца
    expect(throttleIp('203.0.113.8')).not.toBe(throttleIp('203.0.113.7'));
  });

  it('IPv6 считается по сети /64: смена адреса внутри неё ключ не меняет', () => {
    expect(throttleIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(throttleIp('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(throttleIp('2001:DB8:1:2:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(throttleIp('2001:db8:1:3::1')).toBe('2001:db8:1:3::/64');
  });

  it('сжатая запись с нулями в сети не даёт обойти счёт', () => {
    // Сеть 2001:db8:0:0::/64 — адреса записываются с «::» в разных местах, ключ один
    const key = '2001:db8:0:0::/64';
    expect(throttleIp('2001:db8::1')).toBe(key);
    expect(throttleIp('2001:db8::1234:5678:9abc:def0')).toBe(key);
    expect(throttleIp('2001:db8:0:0:1::')).toBe(key);
    expect(throttleIp('2001:db8::')).toBe(key);
    expect(throttleIp('::1')).toBe('0:0:0:0::/64');
    expect(throttleIp('fe80::1%en0')).toBe('fe80:0:0:0::/64');
  });

  it('не адрес — возвращается как есть (счёт всё равно ведётся)', () => {
    expect(throttleIp('')).toBe('');
    expect(throttleIp('not-an-ip')).toBe('not-an-ip');
  });
});
