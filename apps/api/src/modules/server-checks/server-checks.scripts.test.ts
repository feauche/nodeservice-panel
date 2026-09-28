import { describe, expect, it } from 'vitest';

import {
  capOutput,
  checkCommand,
  cleanOutput,
  exitReason,
  reportComplete,
  stripNoise,
} from './server-checks.scripts.js';

describe('checkCommand', () => {
  it('метка первой строкой, bash, чужие скрипты только по https', () => {
    for (const key of ['cpu', 'ip_region', 'geoblock', 'dpi', 'ip_quality', 'iperf3_ru', 'yabs'] as const) {
      const cmd = checkCommand(key);
      expect(cmd.split('\n')[0]).toBe(`# ns-check:${key}`);
      expect(cmd).toContain('bash -c');
      expect(cmd).not.toMatch(/https?:\/\/[^\s']*tlab\.pw|bench\.sh|http:\/\//);
      expect(cmd).not.toContain('multitest');
    }
    expect(checkCommand('geoblock')).toContain('--mode geoblock');
    expect(checkCommand('dpi')).toContain('--mode dpi');
    expect(checkCommand('yabs')).toContain('https://yabs.sh');
    expect(checkCommand('ip_quality')).toContain("--proto '\\''=https'\\''");
  });
  it('всё без ввода с клавиатуры и под серверным таймаутом', () => {
    expect(checkCommand('ip_region')).toContain('</dev/null');
    expect(checkCommand('ip_region')).toMatch(/timeout -k 20 \d+ bash/);
  });
});

describe('cleanOutput', () => {
  it('убирает цвета и оставляет последнее состояние строки с прогрессом', () => {
    expect(cleanOutput('\u001b[32mOK\u001b[0m\n10%\r50%\r100%\nитог')).toBe('OK\n100%\nитог');
  });
});

describe('capOutput', () => {
  it('короткий не трогает, длинный режет середину и сохраняет конец', () => {
    expect(capOutput('abc', 10)).toBe('abc');
    const out = capOutput(`${'a'.repeat(100)}КОНЕЦ`, 30);
    expect(out).toContain('вывод сокращён');
    expect(out.endsWith('КОНЕЦ')).toBe(true);
  });
});

describe('exitReason', () => {
  it('таймаут и пакет — понятным текстом', () => {
    expect(exitReason(124)).toContain('не уложилась');
    expect(exitReason(3)).toContain('пакет');
    expect(exitReason(1)).toContain('код 1');
  });
});

describe('зависимости скриптов', () => {
  it('геоблок и DPI ставят dig, jq и column; iPerf3 — ещё и ping', () => {
    for (const key of ['geoblock', 'dpi'] as const) {
      const cmd = checkCommand(key);
      expect(cmd).toContain('need dig dnsutils');
      expect(cmd).toContain('need column bsdextrautils util-linux');
    }
    expect(checkCommand('iperf3_ru')).toContain('need ping iputils-ping');
  });
});

describe('IPQuality: баннеры и код выхода', () => {
  const report = [
    'SPONSORSPONSORSPONSOR',
    'RapidProxy https://www.rapidproxy.io/',
    '#'.repeat(72),
    '               IP QUALITY CHECK REPORT(LITE): 81.177.*.*',
    '#'.repeat(72),
    '1. Basic Information',
    '='.repeat(72),
    'IP Checks Today: 3161',
  ].join('\n');
  it('реклама до отчёта вырезается, отчёт остаётся целиком', () => {
    const out = stripNoise('ip_quality', report);
    expect(out.startsWith('#'.repeat(72))).toBe(true);
    expect(out).not.toContain('SPONSOR');
    expect(out).toContain('IP Checks Today');
    expect(stripNoise('geoblock', report)).toBe(report);
  });
  it('полный отчёт — успех даже при коде 1; оборванный — нет', () => {
    expect(reportComplete('ip_quality', report)).toBe(true);
    expect(reportComplete('ip_quality', report.split('1. Basic')[0] ?? '')).toBe(false);
    expect(reportComplete('geoblock', report)).toBe(false);
  });
});
