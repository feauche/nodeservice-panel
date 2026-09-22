import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { actionSteps, checkScript, parseCheckOutput } from './maintenance.scripts.js';

/**
 * Скрипты обслуживания прогоняются через настоящий sh: синтаксис, кавычки, `set -e`, разбор
 * вывода. Системные утилиты подменяются заглушками в PATH (apt-get, dpkg, systemctl, timeout…),
 * а пути /tmp и /usr/local/bin — через NS_TMP/NS_BIN.
 */
const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'ns-maint-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function stub(bin: string, name: string, body: string): void {
  const p = join(bin, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
}

function run(script: string, opts: { bin: string; env?: Record<string, string> }) {
  const res = spawnSync('sh', ['-c', script], {
    env: { ...process.env, PATH: `${opts.bin}:${process.env.PATH ?? ''}`, ...(opts.env ?? {}) },
    encoding: 'utf8',
  });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

/** Заглушки, общие для всех сценариев: timeout просто запускает команду, systemctl всегда active. */
function baseStubs(bin: string): void {
  stub('' + bin, 'timeout', 'shift 3; exec "$@"');
  stub(bin, 'systemctl', 'case "$1" in is-active) echo active ;; *) exit 0 ;; esac');
  stub(bin, 'sha256sum', 'exec shasum -a 256 "$@"');
}

describe('maintenance scripts', () => {
  it('все скрипты проходят проверку синтаксиса sh -n', () => {
    const scripts = [
      checkScript(),
      ...(['apt_upgrade', 'agent_update', 'cleanup', 'unattended_enable'] as const).flatMap((k) =>
        actionSteps(k, 'feauche/nodeservice-agent').map((s) => s.command),
      ),
    ];
    expect(scripts.length).toBeGreaterThan(8);
    for (const s of scripts) {
      const res = spawnSync('sh', ['-n'], { input: s, encoding: 'utf8' });
      expect(res.status, `${s.split('\n')[0]}: ${res.stderr}`).toBe(0);
    }
  });

  it('проверка: считает обновления и security из apt -s, unattended, dpkg --audit, диск', () => {
    const bin = join(scratch(), 'bin');
    mkdirSync(bin);
    baseStubs(bin);
    stub(
      bin,
      'apt-get',
      [
        'case "$*" in',
        '  *"-s"*) printf "Inst openssl [3.0] (3.0.1 Ubuntu:24.04/noble-security [amd64])\\nInst curl [8.5] (8.5.1 Ubuntu:24.04/noble-updates [amd64])\\nConf openssl\\n" ;;',
        '  *update*) exit 0 ;;',
        'esac',
      ].join('\n'),
    );
    stub(
      bin,
      'dpkg',
      'case "$1" in --audit) printf "The following packages are only half configured:\\n libx:amd64 lib\\n" ;; -s) exit 0 ;; esac',
    );
    stub(bin, 'apt-config', 'echo \'APT::Periodic::Unattended-Upgrade "1";\'');
    const { code, out } = run(checkScript(), { bin });
    expect(code).toBe(0);
    expect(out).toContain('@@done=1');
    const c = parseCheckOutput(out, 'v9.9.9');
    expect(c.supported).toBe(true);
    expect(c.updates).toEqual({ total: 2, security: 1 });
    expect(c.unattended).toBe(true);
    expect(c.rebootRequired).toBe(false);
    expect(c.agent).toEqual({ installed: null, latest: 'v9.9.9', service: 'active' });
    expect(c.disk.usedPct).not.toBeNull();
    expect(c.disk.freeMb).toBeGreaterThan(0);
    expect(c.warnings.join(' ')).toContain('недонастроенные пакеты (1)');
  });

  it('проверка без apt: supported=false, поля обновлений null, а не 0', () => {
    const bin = join(scratch(), 'bin');
    mkdirSync(bin);
    baseStubs(bin);
    // apt-get в PATH нет; command -v не найдёт
    const { code, out } = run(checkScript(), { bin, env: { PATH: bin + ':/usr/bin:/bin' } });
    expect(code).toBe(0);
    const c = parseCheckOutput(out, null);
    expect(c.supported).toBe(false);
    expect(c.updates).toBeNull();
    expect(c.unattended).toBeNull();
    expect(c.warnings[0]).toContain('не Debian/Ubuntu');
  });

  it('обновление агента: проверка суммы, бинарь пробуется до замены, замена атомарна, откат не нужен', () => {
    const root = scratch();
    const bin = join(root, 'bin');
    const tmp = join(root, 'tmp');
    mkdirSync(bin);
    mkdirSync(tmp);
    baseStubs(bin);
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const file = `nodeservice-agent_linux_${arch}`;
    const fakeAgent = '#!/bin/sh\necho v9.9.9\n';
    const sum = createHash('sha256').update(fakeAgent).digest('hex');
    // curl «скачивает» из фикстур: бинарь и checksums.txt
    const fixtures = join(root, 'fx');
    mkdirSync(fixtures);
    writeFileSync(join(fixtures, file), fakeAgent);
    writeFileSync(join(fixtures, 'checksums.txt'), `${sum}  ${file}\n`);
    stub(
      bin,
      'curl',
      `while [ $# -gt 0 ]; do case "$1" in -o) OUT="$2"; shift 2 ;; *) URL="$1"; shift ;; esac; done; cp "${fixtures}/$(basename "$URL")" "$OUT"`,
    );
    const oldBin = join(root, 'nodeservice-agent');
    writeFileSync(oldBin, '#!/bin/sh\necho v0.5.4\n');
    chmodSync(oldBin, 0o755);
    const env = { NS_TMP: tmp, NS_BIN: oldBin };
    const [download, install] = actionSteps('agent_update', 'feauche/nodeservice-agent');

    const d = run(download?.command ?? '', { bin, env });
    expect(d.code, d.out).toBe(0);
    expect(d.out).toContain('новая версия: v9.9.9');
    const i = run(install?.command ?? '', { bin, env });
    expect(i.code, i.out).toBe(0);
    expect(i.out).toContain('агент: v9.9.9 · active');
    expect(readFileSync(oldBin, 'utf8')).toBe(fakeAgent);
    expect(existsSync(join(tmp, 'ns-agent-update'))).toBe(false);

    // Испорченная сумма: скачивание падает, до замены не доходит, старый бинарь на месте.
    writeFileSync(oldBin, '#!/bin/sh\necho v0.5.4\n');
    writeFileSync(join(fixtures, 'checksums.txt'), `${'0'.repeat(64)}  ${file}\n`);
    const bad = run(download?.command ?? '', { bin, env });
    expect(bad.code).not.toBe(0);
    expect(bad.out).toMatch(/FAILED|не сошлась|did NOT match/i);
    const i2 = run(install?.command ?? '', { bin, env: { ...env, NS_TMP: join(root, 'nowhere') } });
    expect(i2.code).not.toBe(0);
    expect(i2.out).toContain('нет скачанного бинаря');
    expect(readFileSync(oldBin, 'utf8')).toContain('v0.5.4');
  });

  it('apt-команды неинтерактивны, ждут блокировку и идут под серверным timeout', () => {
    for (const kind of ['apt_upgrade', 'cleanup', 'unattended_enable'] as const) {
      for (const step of actionSteps(kind, 'x/y')) {
        if (!step.command.includes('apt-get')) continue;
        expect(step.command, step.key).toContain('DEBIAN_FRONTEND=noninteractive');
        expect(step.command, step.key).toContain('DPkg::Lock::Timeout');
        expect(step.command, step.key).toMatch(/timeout -k 30 \d+ apt-get/);
      }
    }
    const upgrade = actionSteps('apt_upgrade', 'x/y').find((s) => s.key === 'upgrade')?.command ?? '';
    expect(upgrade).toContain('--with-new-pkgs');
    expect(upgrade).toContain('force-confold');
    expect(upgrade).not.toContain('dist-upgrade');
  });
});
