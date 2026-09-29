import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { BACKUP_KDF_ITER, decryptFile, encryptFile, isEncrypted } from './backup-crypto.js';

const dir = mkdtempSync(join(tmpdir(), 'ns-bk-'));
const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('шифрование копии паролем', () => {
  it('туда и обратно; неверный пароль — ошибка', async () => {
    const src = join(dir, 'a.bin');
    writeFileSync(src, Buffer.from('PGDMP'.repeat(10_000)));
    await encryptFile(src, join(dir, 'a.enc'), 'секрет-123');
    expect(await isEncrypted(join(dir, 'a.enc'))).toBe(true);
    expect(await isEncrypted(src)).toBe(false);
    await decryptFile(join(dir, 'a.enc'), join(dir, 'a.out'), 'секрет-123');
    expect(readFileSync(join(dir, 'a.out')).equals(readFileSync(src))).toBe(true);
    await expect(decryptFile(join(dir, 'a.enc'), join(dir, 'b.out'), 'не тот')).rejects.toThrow();
  });

  it.skipIf(!hasOpenssl)('файл открывает обычный openssl — копию можно развернуть и без панели', async () => {
    const src = join(dir, 'c.bin');
    writeFileSync(src, 'nodeservice backup');
    await encryptFile(src, join(dir, 'c.enc'), 'pass');
    const out = execFileSync('openssl', [
      'enc',
      '-d',
      '-aes-256-cbc',
      '-pbkdf2',
      '-iter',
      String(BACKUP_KDF_ITER),
      '-md',
      'sha256',
      '-in',
      join(dir, 'c.enc'),
      '-pass',
      'pass:pass',
    ]);
    expect(out.toString()).toBe('nodeservice backup');
  });
});
