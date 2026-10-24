import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConfigService } from '@nestjs/config';
import { afterAll, describe, expect, it } from 'vitest';

import { CryptoService } from '../../common/crypto/crypto.service.js';
import type { Env } from '../../config/env.schema.js';
import { cryptoFromEnv, PgBackupTools, packArgs } from './backup-tools.js';

describe('упаковка дополнительных путей', () => {
  it('пути идут только после «--»: путь, похожий на параметр, параметром не становится', () => {
    const args = packArgs(
      ['/etc/nginx', '/--checkpoint=1', '/--checkpoint-action=exec=sh -c "id"'],
      '/host',
      '/tmp/files.tar.gz',
    );
    const stop = args.indexOf('--');
    expect(stop).toBeGreaterThan(0);
    expect(args.slice(stop + 1)).toEqual([
      'etc/nginx',
      '--checkpoint=1',
      '--checkpoint-action=exec=sh -c "id"',
    ]);
    // До «--» — только параметры самой панели.
    expect(args.slice(0, stop)).toEqual(['-czf', '/tmp/files.tar.gz', '--ignore-failed-read', '-C', '/host']);
  });

  it('корень сервера по умолчанию — «/»; пустые пути отбрасываются', () => {
    expect(packArgs(['/etc', '//'], '', 'out')).toEqual([
      '-czf',
      'out',
      '--ignore-failed-read',
      '-C',
      '/',
      '--',
      'etc',
    ]);
  });
});

// Закрытая папка в тесте — настоящая (chmod 000); от root закрытых папок не бывает, и проверять нечего.
describe.skipIf(process.getuid?.() === 0)('«Проверить пути»', () => {
  const root = mkdtempSync(join(tmpdir(), 'ns-probe-'));
  mkdirSync(join(root, 'open'));
  writeFileSync(join(root, 'open', 'file.txt'), 'hello');
  // Закрытая папка, как /root на сервере панели: пользователю панели в неё хода нет.
  mkdirSync(join(root, 'closed', 'scripts'), { recursive: true });
  writeFileSync(join(root, 'closed', 'config'), 'x');
  chmodSync(join(root, 'closed'), 0o000);

  afterAll(() => {
    chmodSync(join(root, 'closed'), 0o700);
    rmSync(root, { recursive: true, force: true });
  });

  /** du с правом читать любой файл — как ns-du в контейнере панели. */
  const privileged = async (args: string[]) => {
    const target = args.at(-1) ?? '';
    if (target.endsWith('/closed/scripts') || target.endsWith('/closed/scripts/.'))
      return { code: 0, stdout: `4200\t${target}\n`, stderr: '' };
    // Файл — размером в байтах (как отвечает du -sb): в нём один символ.
    if (target.endsWith('/closed/config')) return { code: 0, stdout: `1\t${target}\n`, stderr: '' };
    if (target.endsWith('/closed/config/.'))
      return { code: 1, stdout: '', stderr: `du: cannot access '${target}': Not a directory\n` };
    return { code: 1, stdout: '', stderr: `du: cannot access '${target}': No such file or directory\n` };
  };

  it('путь внутри закрытой папки: спрашиваем программу с правом чтения — она его видит, значит и в копию он попадёт', async () => {
    const tools = new PgBackupTools('postgres://u:p@localhost/db', privileged);
    expect(await tools.probePath('/closed/scripts', root)).toEqual({ state: 'dir', size: 4200 * 1024 });
    expect(await tools.probePath('/closed/config', root)).toEqual({ state: 'file', size: 1 });
    expect(await tools.probePath('/closed/nope', root)).toEqual({ state: 'missing', size: null });
  });

  it('«нет доступа» — только когда и программа с правом чтения не смогла', async () => {
    const denied = async (args: string[]) => ({
      code: 1,
      stdout: '',
      stderr: `du: cannot read directory '${args.at(-1)}': Permission denied\n`,
    });
    const tools = new PgBackupTools('postgres://u:p@localhost/db', denied);
    expect(await tools.probePath('/closed/scripts', root)).toEqual({ state: 'denied', size: null });
    // Программа с правом чтения не запустилась вовсе — панель всё равно знает, что ей самой путь закрыт.
    const broken = new PgBackupTools('postgres://u:p@localhost/db', async () => null);
    expect(await broken.probePath('/closed/scripts', root)).toEqual({ state: 'denied', size: null });
  });

  it('большая закрытая папка не посчиталась за минуту — это «папка без размера», а не «нет доступа»', async () => {
    const slow = async () => ({ code: 1, stdout: '', stderr: '', timedOut: true });
    const tools = new PgBackupTools('postgres://u:p@localhost/db', slow);
    expect(await tools.probePath('/closed/scripts', root)).toEqual({ state: 'dir', size: null });
  });

  it('открытые пути — как раньше: файл, папка с размером, отсутствующий путь', async () => {
    const tools = new PgBackupTools('postgres://u:p@localhost/db');
    expect(await tools.probePath('/open/file.txt', root)).toEqual({ state: 'file', size: 5 });
    const dir = await tools.probePath('/open', root);
    expect(dir.state).toBe('dir');
    expect(dir.size).toBeGreaterThan(0);
    expect(await tools.probePath('/nope', root)).toEqual({ state: 'missing', size: null });
  });

  it('без особого права (как в разработке) закрытая папка честно «нет доступа»', async () => {
    const tools = new PgBackupTools('postgres://u:p@localhost/db');
    expect(await tools.probePath('/closed/scripts', root)).toEqual({ state: 'denied', size: null });
  });
});

describe('ключ из копии другой установки', () => {
  const key = 'ab'.repeat(32);
  const secret = 'JBSWY3DPEHPK3PXP';
  /** Панель той установки: ею зашифрован секрет кода входа в базе копии. */
  const install = (version = 1) => {
    const values: Record<string, unknown> = {
      ENCRYPTION_KEY: key,
      ENCRYPTION_KEY_VERSION: version,
      APP_SECRET: 'x'.repeat(64),
    };
    return new CryptoService({ get: (k: string) => values[k] } as unknown as ConfigService<Env, true>);
  };

  it('шифротекст той установки читается ключом из .env копии, чужим — нет', () => {
    const stored = install().encrypt(secret);
    expect(cryptoFromEnv({ ENCRYPTION_KEY: key, APP_SECRET: 'y'.repeat(64) })?.decrypt(stored)).toBe(secret);
    const other = cryptoFromEnv({ ENCRYPTION_KEY: 'cd'.repeat(32), APP_SECRET: 'y'.repeat(64) });
    expect(() => other?.decrypt(stored)).toThrow();
  });

  it('версия ключа — из .env копии; в старых .env её нет — 1', () => {
    expect(
      cryptoFromEnv({ ENCRYPTION_KEY: key, ENCRYPTION_KEY_VERSION: '2' })?.decrypt(install(2).encrypt('s')),
    ).toBe('s');
    expect(cryptoFromEnv({ ENCRYPTION_KEY: key })?.decrypt(install(1).encrypt('s'))).toBe('s');
  });

  it('ключа нет или он негодный — проверять нечем', () => {
    expect(cryptoFromEnv({})).toBeNull();
    expect(cryptoFromEnv({ ENCRYPTION_KEY: 'ab'.repeat(16) })).toBeNull();
    expect(cryptoFromEnv({ ENCRYPTION_KEY: key, ENCRYPTION_KEY_VERSION: 'x' })).toBeNull();
  });
});
