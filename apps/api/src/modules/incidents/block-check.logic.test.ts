import { DEFAULT_SERVER_COUNTRY } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import {
  buildBlockCheckCommand,
  combineVerdicts,
  isSafeBlockCheckTarget,
  parseBlockCheckOutput,
  pickRuProbes,
} from './block-check.logic.js';

const country = (code: string | null) => ({ ...DEFAULT_SERVER_COUNTRY, code });

/** Снять экранирование одинарных кавычек, которое добавляет SH() при обёртке в sh -c '...'. */
const unescapeSh = (s: string) => s.replace(/'\\''/g, "'");

describe('pickRuProbes', () => {
  const all = [
    { id: 'a', name: 'ru-a', sshOk: true, country: country('RU') },
    { id: 'b', name: 'ru-b', sshOk: true, country: country('RU') },
    { id: 'c', name: 'nl-c', sshOk: true, country: country('NL') },
    { id: 'd', name: 'ru-d-down', sshOk: false, country: country('RU') },
    { id: 'e', name: 'ru-e-target', sshOk: true, country: country('RU') },
  ];

  it('берёт только российские серверы с рабочим SSH, не саму проверяемую ноду, по алфавиту', () => {
    expect(pickRuProbes('e', all).map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('не больше max', () => {
    expect(pickRuProbes(null, all, 1)).toHaveLength(1);
  });

  it('нет ни одного подходящего — пустой список', () => {
    expect(
      pickRuProbes(
        null,
        all.filter((s) => s.country.code !== 'RU'),
      ),
    ).toEqual([]);
  });
});

describe('buildBlockCheckCommand', () => {
  it('подставляет адрес, порт и SNI (в кавычках для оболочки); печатает один JSON на этапах tcp/tls/data', () => {
    const cmd = unescapeSh(buildBlockCheckCommand('203.0.113.7', 8443, 'www.example.com'));
    expect(cmd).toContain("addr='203.0.113.7'");
    expect(cmd).toContain('port=8443');
    expect(cmd).toContain("sni='www.example.com'");
    expect(cmd).toContain('"stage":"tcp"');
    expect(cmd).toContain('"stage":"tls"');
    expect(cmd).toContain('"stage":"data"');
    expect(cmd).toContain('BEGIN CERTIFICATE');
  });

  it('без имени маскировки — только проверка порта (этап port), без TLS и данных', () => {
    const cmd = unescapeSh(buildBlockCheckCommand('203.0.113.7', 8443, null));
    expect(cmd).toContain("sni=''");
    expect(cmd).toContain('"stage":"port"');
  });

  it('адрес или SNI с символами оболочки — отказ, а не подстановка в команду (защита от инъекции)', () => {
    expect(() => buildBlockCheckCommand('1.2.3.4; rm -rf / #', 443, 'example.com')).toThrow();
    expect(() => buildBlockCheckCommand('1.2.3.4', 443, '$(reboot)')).toThrow();
    expect(() => buildBlockCheckCommand('1.2.3.4', 443, 'example.com`whoami`')).toThrow();
    expect(() => buildBlockCheckCommand('1.2.3.4 && curl evil', 443, 'example.com')).toThrow();
  });

  it('порт вне диапазона или не целое число — тоже отказ', () => {
    expect(() => buildBlockCheckCommand('1.2.3.4', 0, 'example.com')).toThrow();
    expect(() => buildBlockCheckCommand('1.2.3.4', 65536, 'example.com')).toThrow();
    expect(() => buildBlockCheckCommand('1.2.3.4', 443.5, 'example.com')).toThrow();
  });
});

describe('isSafeBlockCheckTarget', () => {
  it('обычные IPv4, IPv6 и доменное имя — безопасны', () => {
    expect(isSafeBlockCheckTarget('203.0.113.7', 8443, 'www.example.com')).toBe(true);
    expect(isSafeBlockCheckTarget('2001:db8::1', 443, 'example.com')).toBe(true);
  });

  it('пробел, кавычка, точка с запятой, обратные кавычки, подстановка команд — небезопасны', () => {
    expect(isSafeBlockCheckTarget('1.2.3.4 rm', 443, 'example.com')).toBe(false);
    expect(isSafeBlockCheckTarget('1.2.3.4', 443, "example.com'; rm -rf ~ #")).toBe(false);
    expect(isSafeBlockCheckTarget('1.2.3.4', 443, 'example.com`id`')).toBe(false);
    expect(isSafeBlockCheckTarget('1.2.3.4', 443, '$(id)')).toBe(false);
  });
});

describe('parseBlockCheckOutput', () => {
  it('tcp недоступен — unreachable', () => {
    const r = parseBlockCheckOutput('ru-a', '{"stage":"tcp","ok":false,"stalledAtKb":null}');
    expect(r).toMatchObject({ from: 'ru-a', verdict: 'unreachable' });
  });

  it('порт отвечает, имени маскировки нет — ok, с честной пометкой, что блокировку не проверить', () => {
    const r = parseBlockCheckOutput('ru-a', '{"stage":"port","ok":true,"stalledAtKb":null}');
    expect(r).toMatchObject({ from: 'ru-a', verdict: 'ok' });
    expect(r.detail).toContain('Порт отвечает');
  });

  it('tls тихо обрывается — tspu', () => {
    const r = parseBlockCheckOutput('ru-a', '{"stage":"tls","ok":false,"stalledAtKb":null}');
    expect(r.verdict).toBe('tspu');
  });

  it('data обрывается в диапазоне 12–40 КБ — block_16_20', () => {
    const r = parseBlockCheckOutput('ru-a', '{"stage":"data","ok":false,"stalledAtKb":16}');
    expect(r).toMatchObject({ verdict: 'block_16_20', stalledAtKb: 16 });
  });

  it('data обрывается ДО 12 КБ — не считаем этой сигнатурой (ok, а не block_16_20)', () => {
    const r = parseBlockCheckOutput('ru-a', '{"stage":"data","ok":false,"stalledAtKb":4}');
    expect(r.verdict).toBe('ok');
  });

  it('data прошла целиком — ok', () => {
    const r = parseBlockCheckOutput('ru-a', '{"stage":"data","ok":true,"stalledAtKb":null}');
    expect(r.verdict).toBe('ok');
  });

  it('мусор вместо JSON — unreachable с пометкой ошибки', () => {
    const r = parseBlockCheckOutput('ru-a', 'permission denied\n');
    expect(r.verdict).toBe('unreachable');
    expect(r.error).toBeTruthy();
  });

  it('пустой вывод (проверяющий не ответил) — unreachable', () => {
    const r = parseBlockCheckOutput('ru-a', '');
    expect(r.verdict).toBe('unreachable');
  });
});

describe('combineVerdicts', () => {
  it('нет проб — unreachable', () => {
    expect(combineVerdicts([])).toBe('unreachable');
  });

  it('хоть одна проба нашла block_16_20 — это и есть итог, даже если другие ok', () => {
    const probes = [
      { from: 'a', verdict: 'ok' as const, detail: '', stalledAtKb: null, error: null },
      { from: 'b', verdict: 'block_16_20' as const, detail: '', stalledAtKb: 20, error: null },
    ];
    expect(combineVerdicts(probes)).toBe('block_16_20');
  });

  it('block_16_20 важнее tspu, tspu важнее unreachable, unreachable важнее ok', () => {
    const mk = (verdict: 'ok' | 'tspu' | 'unreachable' | 'block_16_20') => ({
      from: 'x',
      verdict,
      detail: '',
      stalledAtKb: null,
      error: null,
    });
    expect(combineVerdicts([mk('tspu'), mk('unreachable')])).toBe('tspu');
    expect(combineVerdicts([mk('unreachable'), mk('ok')])).toBe('unreachable');
    expect(combineVerdicts([mk('ok'), mk('ok')])).toBe('ok');
  });
});
