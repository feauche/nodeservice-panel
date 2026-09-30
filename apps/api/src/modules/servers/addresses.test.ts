import { describe, expect, it } from 'vitest';

import { externalAddresses, isExternalIp, normalizeAddress } from './addresses.js';

describe('адреса сервера', () => {
  it('normalizeAddress: регистр, пробелы, скобки IPv6 и точка в конце не мешают сравнению', () => {
    expect(normalizeAddress('  DE1.Example.COM. ')).toBe('de1.example.com');
    expect(normalizeAddress('[2A01:4F8::1]')).toBe('2a01:4f8::1');
    expect(normalizeAddress('201.34.145.175')).toBe('201.34.145.175');
  });

  it('isExternalIp: локальные, частные и служебные адреса не считаются', () => {
    for (const ip of ['201.34.145.175', '5.9.10.11', '198.51.100.9', '2a01:4f8::1'])
      expect(isExternalIp(ip), ip).toBe(true);
    for (const ip of [
      '127.0.0.1',
      '10.0.0.5',
      '172.17.0.1',
      '192.168.1.10',
      '100.64.0.1',
      '169.254.10.1',
      '::1',
      'fe80::1',
      'fd00::1',
      'не адрес',
      '',
    ])
      expect(isExternalIp(ip), ip).toBe(false);
  });

  it('externalAddresses: из вывода сервера — только внешние адреса, без повторов', () => {
    expect(
      externalAddresses(
        '201.34.145.175 10.8.0.1 172.17.0.1 201.34.145.176 201.34.145.175 2a01:4f8::1 fe80::42',
      ),
    ).toEqual(['201.34.145.175', '201.34.145.176', '2a01:4f8::1']);
    expect(externalAddresses('')).toEqual([]);
    expect(externalAddresses(null)).toEqual([]);
  });
});
