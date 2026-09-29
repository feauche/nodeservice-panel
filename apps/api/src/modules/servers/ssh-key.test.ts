import { generateKeyPairSync } from 'node:crypto';
import { utils } from 'ssh2';
import { describe, expect, it } from 'vitest';

import { normalizePrivateKey, privateKeyProblem } from './ssh-key.js';

// PEM «-----BEGIN RSA PRIVATE KEY-----» (PKCS#1), как у ключей из Termius, PuTTYgen и ssh-keygen -m PEM.
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs1',
  format: 'pem',
}) as string;
const rsaEnc = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs1',
  format: 'pem',
  cipher: 'aes-128-cbc',
  passphrase: 'секрет',
}) as string;
const ok = (k: string, p?: string) => !(utils.parseKey(k, p) instanceof Error);

describe('ключ, вставленный руками', () => {
  it('RSA PEM читается как есть', () => {
    expect(rsa).toContain('BEGIN RSA PRIVATE KEY');
    expect(privateKeyProblem(normalizePrivateKey(rsa))).toBeNull();
  });

  it('отступы, одна строка, окончания Windows — выправляются', () => {
    const variants = [
      rsa.replace(/\n/g, '\r\n'),
      rsa
        .split('\n')
        .map((l) => `   ${l}`)
        .join('\n'),
      rsa.trim().replace(/\n/g, ' '),
      rsa.trim().replace(/\n/g, ''),
    ];
    for (const v of variants) {
      expect(ok(normalizePrivateKey(v))).toBe(true);
    }
  });

  it('PEM с паролем, склеенный в строку, тоже собирается обратно', () => {
    const k = normalizePrivateKey(rsaEnc.trim().replace(/\n/g, ' '));
    expect(k).toContain('Proc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,');
    expect(ok(k, 'секрет')).toBe(true);
  });

  it('понятные причины: нужен пароль, пароль не подошёл, ключ не читается', () => {
    expect(privateKeyProblem(rsaEnc)).toMatch(/защищён паролем/);
    expect(privateKeyProblem(rsaEnc, 'не тот')).toBe('Пароль ключа не подошёл.');
    expect(privateKeyProblem(rsaEnc, 'секрет')).toBeNull();
    expect(
      privateKeyProblem('-----BEGIN RSA PRIVATE KEY-----\nобрывок\n-----END RSA PRIVATE KEY-----'),
    ).toMatch(/не читается/);
  });
});
