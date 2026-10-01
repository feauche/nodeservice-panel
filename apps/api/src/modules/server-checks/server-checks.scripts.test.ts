import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVER_CHECK_KEYS, SERVER_CHECK_META } from '@nodeservice/shared';
import { afterEach, describe, expect, it } from 'vitest';

import {
  capOutput,
  checkCommand,
  cleanOutput,
  exitReason,
  reportComplete,
  runStatus,
  SCRIPT_CHANGED_EXIT,
  SCRIPT_FETCH_FAILED_EXIT,
  SCRIPT_PINS,
  SCRIPT_PREPARE_FAILED_EXIT,
  type ScriptPin,
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
    expect(checkCommand('yabs')).toContain('masonr/yet-another-bench-script/');
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
  it('YABS: fio и iperf3 — из пакетов системы до запуска, иначе скрипт скачал бы их последний выпуск без сверки', () => {
    const cmd = checkCommand('yabs');
    const run = cmd.indexOf('bash "$f"');
    expect(run).toBeGreaterThan(0);
    for (const need of ['need fio fio', 'need iperf3 iperf3']) {
      expect(cmd, need).toContain(need);
      expect(cmd.indexOf(need), need).toBeLessThan(run);
    }
    // -b заставил бы скрипт качать свои сборки и при установленных программах.
    expect(cmd).toMatch(/bash "\$f" -4 <\/dev\/null/);
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

describe('сторонние скрипты закреплены на версии', () => {
  const RAW = /https:\/\/raw\.githubusercontent\.com\/[\w.-]+\/[\w.-]+\/([^/\s]+)\/[\w./-]+/g;

  it('у каждого — адрес с коммитом (не ветка) и sha256; значения заполнены', () => {
    const pins = Object.entries(SCRIPT_PINS);
    expect(pins.length).toBeGreaterThan(0);
    for (const [name, pin] of pins) {
      expect(pin.url, name).toMatch(
        /^https:\/\/raw\.githubusercontent\.com\/[\w.-]+\/[\w.-]+\/[0-9a-f]{40}\/[\w./-]+$/,
      );
      expect(pin.sha256, name).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('команды качают только закреплённые адреса и сверяют сумму; своя команда ничего не качает', () => {
    for (const key of SERVER_CHECK_KEYS) {
      const cmd = checkCommand(key);
      const commits = [...cmd.matchAll(RAW)].map((m) => m[1]);
      if (!SERVER_CHECK_META[key].thirdParty) {
        expect(commits, key).toEqual([]);
        expect(cmd, key).not.toContain('bash "$f"');
        continue;
      }
      expect(commits.length, key).toBe(1);
      for (const c of commits) expect(c, key).toMatch(/^[0-9a-f]{40}$/);
      expect(cmd, key).not.toMatch(/\/(main|master)\//);
      expect(cmd, key).not.toMatch(/IP\.Check\.Place|https:\/\/yabs\.sh|bash <\(curl/);
      const pin = Object.values(SCRIPT_PINS).find((p) => cmd.includes(p.url));
      expect(pin, key).toBeDefined();
      expect(cmd, key).toContain(pin?.sha256 ?? '-');
    }
  });

  it('код выхода «скачанный не совпал» — итог «отменена», а не ошибка; причина честная', () => {
    expect(runStatus(SCRIPT_CHANGED_EXIT)).toBe('cancelled');
    expect(runStatus(1)).toBe('failed');
    const changed = exitReason(SCRIPT_CHANGED_EXIT);
    expect(changed).toMatch(
      /^Скачанный скрипт не совпал с проверенной версией, записанной в панели, — запуск отменён, на сервере он не запускался\./,
    );
    // Адрес закреплён по коммиту: новая версия у автора сюда не попадает, так что это не «изменился у автора»,
    // а возможная подмена — и сказано как предположение.
    expect(changed).not.toMatch(/у автора|ошибк/i);
    expect(changed).toContain('Файл могли подменить по дороге к серверу или на сайте, где он хранится.');
    // До скачивания панель могла поставить недостающие программы — «ничего не запускалось» было бы неправдой.
    expect(exitReason(SCRIPT_FETCH_FAILED_EXIT)).toMatch(
      /^Не удалось скачать скрипт проверки — сам скрипт на сервере не запускался\./,
    );
    expect(exitReason(SCRIPT_FETCH_FAILED_EXIT)).not.toContain('ничего не запускалось');
    // Переписанный файл не совпал — сбой подготовки на сервере, а не подмена: ошибка, не отмена.
    expect(runStatus(SCRIPT_PREPARE_FAILED_EXIT)).toBe('failed');
    expect(exitReason(SCRIPT_PREPARE_FAILED_EXIT)).toMatch(
      /^Не удалось подготовить скрипт проверки к запуску — сам скрипт на сервере не запускался\./,
    );
    // Коды не пересекаются с тем, чем выходят сами закреплённые скрипты, таймаут и установка пакетов.
    for (const code of [0, 1, 2, 3, 4, 6, 7, 8, 10, 11, 40, 60, 124, 126, 127, 130, 137])
      expect([SCRIPT_CHANGED_EXIT, SCRIPT_FETCH_FAILED_EXIT, SCRIPT_PREPARE_FAILED_EXIT]).not.toContain(code);
  });
});

/**
 * Настоящий bash с подменённым curl: скачанный «скрипт» запускается, только если его sha256 совпал с
 * закреплённым. timeout и утилиты, которые ставит need, — заглушки в PATH (как в тестах обслуживания).
 */
describe('сверка суммы на настоящем шелле', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function stub(bin: string, name: string, body: string): void {
    const p = join(bin, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
  }

  /**
   * Окружение: заглушки и «сайт» с телом скрипта; curl записывает, куда сохранял файл, — видно уборку.
   * byUrl — что отдаёт «сайт», когда скрипт сам читает ответ curl (без -o): часть адреса → содержимое.
   */
  function setup(body: string, opts: { fail?: boolean; byUrl?: Record<string, string> } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'ns-checks-'));
    dirs.push(root);
    const bin = join(root, 'bin');
    const tmp = join(root, 'tmp');
    mkdirSync(bin);
    mkdirSync(tmp);
    const saved = join(root, 'saved.log');
    const urls = join(root, 'urls.log');
    const served = join(root, 'served.sh');
    writeFileSync(served, body);
    const byUrl = Object.entries(opts.byUrl ?? {}).map(([part, content], i) => {
      const file = join(root, `url-${i}.txt`);
      writeFileSync(file, content);
      return `    *'${part}'*) cat "${file}" ;;`;
    });
    // curl … -o ФАЙЛ АДРЕС: пишет тело в ФАЙЛ, адрес — в журнал; при fail — как 404 у curl -f.
    stub(
      bin,
      'curl',
      [
        'out=""; url=""',
        'while [ $# -gt 0 ]; do',
        '  case "$1" in',
        '    -o) out="$2"; shift 2 ;;',
        '    --proto|--max-time|-m|--retry) shift 2 ;;',
        '    -*) shift ;;',
        '    *) url="$1"; shift ;;',
        '  esac',
        'done',
        `echo "$url" >> "${urls}"`,
        'if [ -z "$out" ]; then',
        '  case "$url" in',
        ...byUrl,
        '  esac',
        '  exit 0',
        'fi',
        `echo "$out" >> "${saved}"`,
        opts.fail
          ? 'echo "curl: (22) The requested URL returned error: 404" >&2; exit 22'
          : `cat "${served}" > "$out"`,
      ].join('\n'),
    );
    // timeout -k 20 N команда…
    stub(bin, 'timeout', 'shift 3; exec "$@"');
    for (const tool of ['dig', 'jq', 'column']) stub(bin, tool, 'exit 0');
    const hasSha = spawnSync('sh', ['-c', 'command -v sha256sum'], { encoding: 'utf8' }).status === 0;
    if (!hasSha) stub(bin, 'sha256sum', 'exec shasum -a 256 "$@"');
    /** Временные файлы (скачанный и переписанный), в которые сохранялся скрипт: после выхода — ни одного. */
    const leftovers = () =>
      (existsSync(saved) ? readFileSync(saved, 'utf8') : '')
        .split('\n')
        .filter(Boolean)
        .flatMap((p) => [p, `${p}.pin`])
        .filter((p) => existsSync(p));
    /** Адреса, которые запрашивал curl (и панель, и сам скрипт). */
    const requested = () => (existsSync(urls) ? readFileSync(urls, 'utf8') : '').split('\n').filter(Boolean);
    return { root, bin, tmp, leftovers, requested };
  }

  function run(cmd: string, env: { root: string; bin: string; tmp: string }) {
    const res = spawnSync('bash', ['-c', cmd], {
      cwd: env.root,
      env: { ...process.env, PATH: `${env.bin}:${process.env.PATH ?? ''}`, TMPDIR: env.tmp },
      encoding: 'utf8',
    });
    return { code: res.status, out: `${res.stdout}${res.stderr}` };
  }

  const SCRIPT = '#!/bin/bash\necho "СКРИПТ ЗАПУЩЕН: $*"\n';
  const pinFor = (body: string): ScriptPin => ({
    url: `https://raw.githubusercontent.com/author/repo/${'a'.repeat(40)}/check.sh`,
    sha256: createHash('sha256').update(body).digest('hex'),
  });
  const pins = (pin: ScriptPin) =>
    Object.fromEntries(Object.keys(SCRIPT_PINS).map((k) => [k, pin])) as typeof SCRIPT_PINS;

  it('сумма совпала — скрипт запускается с аргументами, временный файл убран', () => {
    const env = setup(SCRIPT);
    const { code, out } = run(checkCommand('geoblock', pins(pinFor(SCRIPT))), env);
    expect(out).toContain('СКРИПТ ЗАПУЩЕН: --mode geoblock');
    expect(code).toBe(0);
    expect(readFileSync(join(env.tmp, '..', 'saved.log'), 'utf8').trim()).not.toBe('');
    expect(env.leftovers()).toEqual([]);
  });

  it('скачанный файл не совпал с закреплённым — не запускается; код «отменено» и понятная строка в выводе', () => {
    const changed = `${SCRIPT}echo "а тут чужая команда"\n`;
    const env = setup(changed);
    const { code, out } = run(checkCommand('geoblock', pins(pinFor(SCRIPT))), env);
    expect(code).toBe(SCRIPT_CHANGED_EXIT);
    expect(out).toContain('Скачанный скрипт не совпал с проверенной версией — запуск отменён.');
    expect(out).not.toContain('у автора');
    expect(out).not.toContain('СКРИПТ ЗАПУЩЕН');
    expect(out).not.toContain('чужая команда');
    expect(env.leftovers()).toEqual([]);
  });

  it('скачать не удалось — не запускается и не называется подменой', () => {
    const env = setup(SCRIPT, { fail: true });
    const { code, out } = run(checkCommand('ip_region', pins(pinFor(SCRIPT))), env);
    expect(code).toBe(SCRIPT_FETCH_FAILED_EXIT);
    expect(out).toContain('Не удалось скачать скрипт проверки');
    expect(out).not.toContain('не совпал');
    expect(out).not.toContain('СКРИПТ ЗАПУЩЕН');
    expect(env.leftovers()).toEqual([]);
  });

  /**
   * «Качество IP» (xykt/IPQuality) во время работы сам качает список DNSBL из ветки main и подставляет его
   * строки в текст `bash -c` — как здесь. Строка списка вида `x.$(команда)` выполнилась бы от root: сверка
   * суммы самого ip.sh от этого не защищала.
   */
  describe('IPQuality: свои файлы скрипт берёт из той же закреплённой версии', () => {
    const COMMIT = 'b'.repeat(40);
    const IPQ = [
      '#!/bin/bash',
      'rawgithub="https://github.com/xykt/IPQuality/raw/"',
      `curl -sL "\${rawgithub}main/ref/dnsbl.list" | xargs -I {} bash -c "echo \\"Проверяю {}\\""`,
      'echo "СКРИПТ ЗАПУЩЕН: $*"',
      '',
    ].join('\n');
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');
    const ipqPins = (over: Partial<NonNullable<ScriptPin['refs']>> = {}) => ({
      ...SCRIPT_PINS,
      ipquality: {
        url: `https://raw.githubusercontent.com/xykt/IPQuality/${COMMIT}/ip.sh`,
        sha256: sha(IPQ),
        refs: {
          from: '}main/',
          to: `}${COMMIT}/`,
          sha256: sha(IPQ.replaceAll('}main/', `}${COMMIT}/`)),
          ...over,
        },
      },
    });
    // В ветке main список подменён; в закреплённом коммите — настоящий.
    const byUrl = {
      [`/${COMMIT}/ref/dnsbl.list`]: 'zen.spamhaus.org\n',
      '/main/ref/dnsbl.list': 'x.$(touch pwned)\n',
    };

    it('список из ветки main в команды не попадает: адреса переписаны на закреплённый коммит', () => {
      const env = setup(IPQ, { byUrl });
      const { code, out } = run(checkCommand('ip_quality', ipqPins()), env);
      expect(existsSync(join(env.root, 'pwned'))).toBe(false);
      expect(code).toBe(0);
      expect(out).toContain('Проверяю zen.spamhaus.org');
      expect(out).toContain('СКРИПТ ЗАПУЩЕН: -E -n');
      expect(env.requested()).toContain(`https://github.com/xykt/IPQuality/raw/${COMMIT}/ref/dnsbl.list`);
      expect(env.requested().filter((u) => u.includes('/main/'))).toEqual([]);
      expect(env.leftovers()).toEqual([]);
    });

    it('переписанный файл не совпал с проверенным — не запускается; причина — подготовка, а не подмена', () => {
      const env = setup(IPQ, { byUrl });
      const { code, out } = run(checkCommand('ip_quality', ipqPins({ sha256: '0'.repeat(64) })), env);
      expect(code).toBe(SCRIPT_PREPARE_FAILED_EXIT);
      expect(out).toContain('Не удалось подготовить скрипт проверки к запуску');
      expect(out).not.toContain('не совпал с проверенной версией');
      expect(out).not.toContain('СКРИПТ ЗАПУЩЕН');
      expect(existsSync(join(env.root, 'pwned'))).toBe(false);
      expect(env.leftovers()).toEqual([]);
    });
  });
});

describe('IPQuality: закреплённая версия и её файлы', () => {
  it('адреса ветки в ip.sh переписываются на коммит закреплённой версии; сверяется переписанный файл', () => {
    const pin: ScriptPin = SCRIPT_PINS.ipquality;
    const commit = /\/([0-9a-f]{40})\//.exec(pin.url)?.[1];
    expect(commit).toBeDefined();
    expect(pin.refs).toEqual({
      from: '}main/',
      to: `}${commit}/`,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(pin.refs?.sha256).not.toBe(pin.sha256);
    const cmd = checkCommand('ip_quality');
    expect(cmd).toContain(`sed '\\''s|}main/|}${commit}/|g'\\'' "$f" > "$f.pin"`);
    expect(cmd).toContain(pin.refs?.sha256);
    expect(cmd).toContain('bash "$f.pin" -E -n');
    // Остальные скрипты своих файлов из веток не качают — переписывать нечего.
    for (const [name, other] of Object.entries(SCRIPT_PINS) as Array<[string, ScriptPin]>)
      if (name !== 'ipquality') expect(other.refs, name).toBeUndefined();
  });
});
