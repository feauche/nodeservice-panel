import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AGENT_STATE_PATH,
  agentInstallCommand,
  agentInstallScript,
  agentPullInstallScript,
  installFailure,
  pullCertificateFromOutput,
} from './agent-install.js';
import { shellQuote } from './ssh.service.js';

const PARAMS = {
  repo: 'feauche/nodeservice-agent',
  token: 'nse_test-TOKEN_123',
  panel: 'https://panel.test',
  fallbackPanels: ['https://backup.test', 'https://second.test'],
};
const OLD_STATE = '{"serverId":"old","privKey":"old-key"}';

describe('входящий агент', () => {
  it('ключ отсутствует в команде и передаётся установщику только через stdin', () => {
    const script = agentPullInstallScript({
      repo: 'feauche/nodeservice-agent',
      serverId: '0192c000-0000-7000-8000-000000000001',
      serverName: "Казахстан ' 1",
      port: 23456,
      panelIp: '192.0.2.10',
    });
    expect(script).toContain('--listen-port 23456');
    expect(script).toContain("--panel-ip '192.0.2.10'");
    expect(script).toContain('--access-key-stdin');
    expect(script).toContain("'Казахстан '\\'' 1'");
    expect(script).not.toMatch(/nsa_|access-key\s+['"]/);
  });

  it('принимает только сертификат разумного размера', () => {
    const cert = Buffer.alloc(300, 7).toString('base64');
    expect(pullCertificateFromOutput(`шаг\nNODESERVICE_PULL_CERT=${cert}\nготово\n`)).toBe(cert);
    expect(pullCertificateFromOutput('NODESERVICE_PULL_CERT=eA==\n')).toBeNull();
    expect(pullCertificateFromOutput('без сертификата')).toBeNull();
  });
});

/** На серверах sh — это dash, на машине разработчика — bash: проверяем обоими, когда оба есть. */
const SHELLS = ['/bin/sh', ...(existsSync('/bin/dash') ? ['/bin/dash'] : [])];

/**
 * Установочные команды гоняем настоящим шеллом во временной папке: `curl` подменён заглушкой (код выхода и
 * «скачанный» файл задаются окружением), привязка агента лежит в этой же папке.
 */
// Каждый тест запускает настоящие процессы: на загруженной машине пяти секунд по умолчанию может не хватить.
describe.each(SHELLS)('установка агента: команды для сервера (%s)', { timeout: 30_000 }, (shell) => {
  let dir: string;
  let state: string;
  let bin: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ns-agent-install-'));
    state = join(dir, 'state.json');
    bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'curl'),
      [
        '#!/bin/sh',
        'out=""; fmt=""; fail=""',
        'while [ $# -gt 0 ]; do',
        '  case "$1" in -o) out="$2"; shift 2 ;; -w) fmt="$2"; shift 2 ;; -f*) fail=1; shift ;; *) shift ;; esac',
        'done',
        'rc="$STUB_CURL_RC"',
        '[ -z "$rc" ] || [ "$rc" -eq 0 ] || { echo "curl: (28) Operation timed out" >&2; [ -z "$fmt" ] || printf 000; exit "$rc"; }',
        'http="$STUB_CURL_HTTP"; [ -n "$http" ] || http=200',
        // Отказ сервера: с ключом -f — ненулевой код выхода; без него в файл ложится страница ошибки.
        'if [ "$http" != 200 ]; then',
        '  [ -z "$fail" ] || { echo "curl: (22) The requested URL returned error: $http" >&2; exit 22; }',
        '  echo "echo страница ошибки выполнилась; exit 0" > "$out"',
        'else',
        '  cat "$STUB_CURL_BODY" > "$out"',
        'fi',
        '[ -z "$fmt" ] || printf "%s" "$http"',
      ].join('\n'),
    );
    chmodSync(join(bin, 'curl'), 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** «Скачанный» install.sh: что он делает на сервере. */
  const body = (lines: string[]) => {
    const p = join(dir, 'install.sh');
    writeFileSync(p, ['#!/bin/sh', ...lines].join('\n'));
    return p;
  };
  const run = (script: string, env: Record<string, string> = {}, path = `${bin}:${process.env.PATH}`) =>
    spawnSync(shell, ['-c', script], {
      encoding: 'utf8',
      env: { PATH: path, NS_AGENT_STATE: state, NS_ARGS: join(dir, 'args'), ...env },
    });

  it('скрипт не скачался: ненулевой код, причина по-русски, привязка работающего агента цела', () => {
    writeFileSync(state, OLD_STATE);
    const res = run(agentInstallScript(PARAMS), { STUB_CURL_RC: '28' });
    expect(res.status).not.toBe(0);
    expect(res.stdout).toContain(
      'Установочный скрипт агента не скачался: скачивание с GitHub не уложилось в минуту. На сервере ничего не изменено.',
    );
    // Английский текст curl владельцу не показываем.
    expect(res.stdout + res.stderr).not.toMatch(/Operation timed out/);
    expect(readFileSync(state, 'utf8')).toBe(OLD_STATE);
    expect(existsSync(`${state}.prev`)).toBe(false);
  });

  it('GitHub ответил ошибкой (нет такого файла): страница ошибки не выполняется, привязка цела', () => {
    writeFileSync(state, OLD_STATE);
    const res = run(agentInstallScript(PARAMS), { STUB_CURL_HTTP: '404' });
    expect(res.status).not.toBe(0);
    expect(res.stdout).toContain(
      'Установочный скрипт агента не скачался: GitHub ответил ошибкой 404. На сервере ничего не изменено.',
    );
    expect(res.stdout).not.toContain('страница ошибки выполнилась');
    expect(readFileSync(state, 'utf8')).toBe(OLD_STATE);
    expect(existsSync(`${state}.prev`)).toBe(false);
  });

  it('GitHub отдал пустой файл — это не «установлено»', () => {
    writeFileSync(state, OLD_STATE);
    const res = run(agentInstallScript(PARAMS), { STUB_CURL_BODY: '/dev/null' });
    expect(res.status).not.toBe(0);
    expect(res.stdout).toContain('GitHub отдал пустой файл');
    expect(readFileSync(state, 'utf8')).toBe(OLD_STATE);
  });

  it('на сервере нет curl: понятная причина, а не «успех»', () => {
    // В PATH только то, что нужно самой команде, — curl среди этого нет.
    const bare = join(dir, 'bare');
    mkdirSync(bare);
    for (const tool of ['mktemp', 'rm', 'mv', 'cat', 'sh'])
      for (const from of ['/bin', '/usr/bin'])
        if (existsSync(join(from, tool)) && !existsSync(join(bare, tool)))
          symlinkSync(join(from, tool), join(bare, tool));
    writeFileSync(state, OLD_STATE);
    const res = run(agentInstallScript(PARAMS), {}, bare);
    expect(res.status).not.toBe(0);
    expect(res.stdout).toContain('На сервере нет curl');
    expect(readFileSync(state, 'utf8')).toBe(OLD_STATE);
  });

  it('установка прошла: токен и адрес панели дошли до скрипта, старая привязка убрана', () => {
    writeFileSync(state, OLD_STATE);
    const script = body([
      'printf "%s\\n" "$@" > "$NS_ARGS"',
      // Настоящий install.sh запускает агента, и тот при старте без привязки берёт новый токен.
      '[ -e "$NS_AGENT_STATE" ] && { echo "привязка мешает"; exit 1; }',
      'echo "✓ агент запущен"',
    ]);
    const res = run(agentInstallScript(PARAMS), { STUB_CURL_BODY: script });
    expect(res.stdout).toContain('✓ агент запущен');
    expect(res.status).toBe(0);
    expect(readFileSync(join(dir, 'args'), 'utf8').trim().split('\n')).toEqual([
      '--token',
      PARAMS.token,
      '--panel',
      PARAMS.panel,
      '--fallback-panels',
      PARAMS.fallbackPanels.join(','),
    ]);
    expect(existsSync(state)).toBe(false);
    expect(existsSync(`${state}.prev`)).toBe(false);
  });

  it('скрипт упал (не скачался бинарь): код и причина его, прежняя привязка возвращена', () => {
    writeFileSync(state, OLD_STATE);
    const script = body(['echo "✗ не скачался бинарь" >&2', 'exit 3']);
    const res = run(agentInstallScript(PARAMS), { STUB_CURL_BODY: script });
    expect(res.status).toBe(3);
    expect(res.stderr).toContain('✗ не скачался бинарь');
    expect(res.stdout).toContain('Прежняя привязка агента возвращена на место.');
    expect(readFileSync(state, 'utf8')).toBe(OLD_STATE);
    expect(existsSync(`${state}.prev`)).toBe(false);
  });

  it('скрипт упал, но новый агент успел привязаться — его привязку не затираем старой', () => {
    writeFileSync(state, OLD_STATE);
    const script = body(['echo \'{"serverId":"new"}\' > "$NS_AGENT_STATE"', 'exit 1']);
    const res = run(agentInstallScript(PARAMS), { STUB_CURL_BODY: script });
    expect(res.status).toBe(1);
    expect(readFileSync(state, 'utf8')).toContain('"new"');
    expect(existsSync(`${state}.prev`)).toBe(false);
    expect(res.stdout).not.toContain('возвращена');
  });

  it('пользователь не root: тот же скрипт целиком проходит через обёртку sudo (sh -c) без искажений', () => {
    writeFileSync(state, OLD_STATE);
    const script = body(['printf "%s\\n" "$@" > "$NS_ARGS"', 'echo "✗ нужен systemd" >&2', 'exit 1']);
    // Панель для не-root выполняет `sudo -n sh -c '<скрипт>'` — здесь то же без самого sudo.
    const res = run(`sh -c ${shellQuote(agentInstallScript(PARAMS))}`, { STUB_CURL_BODY: script });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('Прежняя привязка агента возвращена на место.');
    expect(readFileSync(join(dir, 'args'), 'utf8').trim().split('\n')).toEqual([
      '--token',
      PARAMS.token,
      '--panel',
      PARAMS.panel,
      '--fallback-panels',
      PARAMS.fallbackPanels.join(','),
    ]);
    expect(readFileSync(state, 'utf8')).toBe(OLD_STATE);
  });

  it('первая установка (привязки ещё нет): сбой скрипта не оставляет мусора', () => {
    const script = body(['exit 1']);
    const res = run(agentInstallScript(PARAMS), { STUB_CURL_BODY: script });
    expect(res.status).toBe(1);
    expect(existsSync(state)).toBe(false);
    expect(existsSync(`${state}.prev`)).toBe(false);
  });

  it('ручная команда: сбой скачивания — ненулевой код и привязка на месте; успех — код 0', () => {
    // Команда владельца работает с настоящим путём привязки — для проверки подставляем временный.
    const manual = agentInstallCommand(PARAMS);
    expect(manual).toContain(AGENT_STATE_PATH);
    expect(manual).toContain('--token');
    expect(manual).toContain('--panel');
    expect(manual).toContain('--fallback-panels');
    expect(manual).toContain('github.com/feauche/nodeservice-agent/releases/latest/download/install.sh');
    // Скрипт больше не идёт по конвейеру в sh: у конвейера код выхода — от sh с пустым вводом, то есть 0.
    expect(manual).not.toMatch(/\|\s*sh/);
    const local = manual.replaceAll(AGENT_STATE_PATH, state);

    writeFileSync(state, OLD_STATE);
    for (const env of [{ STUB_CURL_RC: '28' }, { STUB_CURL_HTTP: '404' }]) {
      const failed = run(local, env);
      expect(failed.status, JSON.stringify(env)).not.toBe(0);
      expect(failed.stdout).not.toContain('страница ошибки выполнилась');
      expect(readFileSync(state, 'utf8')).toBe(OLD_STATE);
    }

    const ok = run(local, { STUB_CURL_BODY: body(['printf "%s\\n" "$@" > "$NS_ARGS"']) });
    expect(ok.status).toBe(0);
    expect(existsSync(state)).toBe(false);
    expect(existsSync(`${state}.prev`)).toBe(false);
    expect(readFileSync(join(dir, 'args'), 'utf8').trim().split('\n')).toEqual([
      '--token',
      PARAMS.token,
      '--panel',
      PARAMS.panel,
      '--fallback-panels',
      PARAMS.fallbackPanels.join(','),
    ]);
  });

  it('ручная команда: скрипт скачался, но упал на своём шаге (не скачался бинарь) — привязка возвращена', () => {
    const local = agentInstallCommand(PARAMS).replaceAll(AGENT_STATE_PATH, state);
    writeFileSync(state, OLD_STATE);
    // Настоящий install.sh качает бинарь уже после старта: к этому моменту привязка отложена.
    const failed = run(local, {
      STUB_CURL_BODY: body([
        '[ -e "$NS_AGENT_STATE" ] && { echo "привязка мешает"; exit 9; }',
        'echo "✗ не скачался бинарь" >&2',
        'exit 3',
      ]),
    });
    expect(failed.status).toBe(3);
    expect(failed.stderr).toContain('✗ не скачался бинарь');
    expect(readFileSync(state, 'utf8')).toBe(OLD_STATE);
    expect(existsSync(`${state}.prev`)).toBe(false);

    // Скрипт упал, но новый агент успел привязаться — его привязку старой не затираем.
    const bound = run(local, {
      STUB_CURL_BODY: body(['echo \'{"serverId":"new"}\' > "$NS_AGENT_STATE"', 'exit 1']),
    });
    expect(bound.status).toBe(1);
    expect(readFileSync(state, 'utf8')).toContain('"new"');
    expect(existsSync(`${state}.prev`)).toBe(false);

    // Первая установка (привязки нет) — сбой не оставляет мусора.
    rmSync(state);
    const first = run(local, { STUB_CURL_BODY: body(['exit 1']) });
    expect(first.status).toBe(1);
    expect(existsSync(state)).toBe(false);
    expect(existsSync(`${state}.prev`)).toBe(false);
  });

  it('причина неудачи — хвост вывода, без него — код выхода', () => {
    expect(installFailure('→ скачиваю\n✗ не скачался бинарь\n', 1)).toBe('→ скачиваю\n✗ не скачался бинарь');
    expect(installFailure('  \n', 7)).toBe('код 7');
    expect(installFailure('x'.repeat(500), 1)).toHaveLength(300);
    // Скрипт красит вывод: код цвета, попавший на границу обрезки, не должен остаться в тексте обрывком.
    const colored = `${'\u001b[36m→\u001b[0m шаг\n'.repeat(40)}\u001b[31m✗ не скачался бинарь\u001b[0m\n`;
    const tail = installFailure(colored, 1);
    expect(tail.endsWith('✗ не скачался бинарь')).toBe(true);
    expect(tail).not.toContain('\u001b');
    expect(tail).not.toMatch(/\[\d+m/);
  });
});
