import { afterEach, describe, expect, it, vi } from 'vitest';

import { GEO_SOURCES, HttpGeoLookup, isPublicIp } from './geo.lookup.js';

const parseOf = (id: string) => {
  const src = GEO_SOURCES.find((s) => s.id === id);
  if (!src) throw new Error(`нет источника ${id}`);
  return src.parse;
};

describe('isPublicIp', () => {
  it('частные, служебные и документационные адреса не публичные', () => {
    for (const ip of [
      '10.1.2.3',
      '127.0.0.1',
      '172.16.0.1',
      '172.31.255.1',
      '192.168.1.1',
      '169.254.1.1',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '203.0.113.7',
      '198.51.100.20',
      '::1',
      'fe80::1',
      'fc00::1',
      '2001:db8::1',
      'не-адрес',
    ])
      expect(isPublicIp(ip), ip).toBe(false);
  });
  it('обычные публичные адреса подходят', () => {
    for (const ip of ['8.8.8.8', '95.216.0.1', '104.171.133.254', '172.32.0.1', '2606:4700:4700::1111'])
      expect(isPublicIp(ip), ip).toBe(true);
  });
});

describe('разбор ответов геосервисов (настоящие ответы)', () => {
  it('ipwho.is, ipwhois.app: код в country_code, success:false — нет ответа', () => {
    expect(
      parseOf('ipwho.is')('{"ip":"8.8.8.8","success":true,"country":"United States","country_code":"US"}'),
    ).toBe('US');
    expect(parseOf('ipwho.is')('{"success":false,"message":"Reserved range"}')).toBeNull();
    expect(parseOf('ipwhois.app')('{"success":true,"country_code":"PL"}')).toBe('PL');
  });
  it('country.is, geojs.io: код в поле country', () => {
    expect(parseOf('country.is')('{"ip":"8.8.8.8","country":"US"}')).toBe('US');
    expect(parseOf('country.is')('{"error":{"code":404,"message":"Not Found"}}')).toBeNull();
    expect(parseOf('geojs.io')('{"country":"FI","country_3":"FIN","ip":"95.216.0.1"}')).toBe('FI');
  });
  it('ipinfo.io: тело ответа это сам код', () => {
    expect(parseOf('ipinfo.io')('RU\n')).toBe('RU');
    expect(parseOf('ipinfo.io')('Please slow down')).toBeNull();
  });
  it('ipquery.io: location.country_code; iplocation.net: country_code2', () => {
    expect(
      parseOf('ipquery.io')('{"ip":"8.8.8.8","location":{"country":"United States","country_code":"US"}}'),
    ).toBe('US');
    expect(parseOf('iplocation.net')('{"country_code2":"NL","country_name":"Netherlands"}')).toBe('NL');
  });
  it('мусор и не JSON не ломают разбор', () => {
    for (const src of GEO_SOURCES) expect(src.parse('<html>Just a moment...</html>'), src.id).toBeNull();
  });
});

describe('HttpGeoLookup', () => {
  const prev = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = prev;
    vi.unstubAllGlobals();
  });

  it('в тестовом окружении наружу не ходит', async () => {
    const r = await new HttpGeoLookup().detect('8.8.8.8');
    expect(r.problem).toContain('тестовом окружении');
    expect(r.asked).toBe(0);
  });

  it('непубличный адрес: источников не спрашивает, причина названа', async () => {
    process.env.NODE_ENV = 'development';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = await new HttpGeoLookup().detect('10.0.0.5');
    expect(r.problem).toContain('не публичный');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('спрашивает все источники, недоступные и странные ответы пропускает', async () => {
    process.env.NODE_ENV = 'development';
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(url);
        if (url.includes('ipwho.is')) return new Response('{"success":true,"country_code":"PL"}');
        if (url.includes('country.is')) return new Response('{"country":"PL"}');
        if (url.includes('ipinfo.io')) return new Response('PL');
        if (url.includes('geojs.io')) return new Response('{"country":"BR"}');
        if (url.includes('ipquery.io')) return new Response('nope', { status: 429 });
        if (url.includes('ipwhois.app')) throw new Error('timeout');
        return new Response('<html>captcha</html>');
      }),
    );
    const r = await new HttpGeoLookup().detect('104.171.133.254');
    expect(r.ip).toBe('104.171.133.254');
    expect(r.asked).toBe(GEO_SOURCES.length);
    expect([...r.answers].sort()).toEqual(['BR', 'PL', 'PL', 'PL']);
    expect(seen.every((u) => u.startsWith('https://') && u.includes('104.171.133.254'))).toBe(true);
  });
});
