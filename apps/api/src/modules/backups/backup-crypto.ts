import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Шифрование архива паролем в формате `openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -md sha256`:
 * «Salted__» + 8 байт соли + шифротекст. Такой файл открывается и без панели:
 *   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -in копия.tar.gz.enc -out копия.tar.gz
 */
export const BACKUP_KDF_ITER = 200_000;
const MAGIC = Buffer.from('Salted__', 'ascii');

function keyIv(password: string, salt: Buffer): { key: Buffer; iv: Buffer } {
  const k = pbkdf2Sync(password, salt, BACKUP_KDF_ITER, 48, 'sha256');
  return { key: k.subarray(0, 32), iv: k.subarray(32, 48) };
}

export async function encryptFile(src: string, dst: string, password: string): Promise<void> {
  const salt = randomBytes(8);
  const { key, iv } = keyIv(password, salt);
  const out = createWriteStream(dst, { mode: 0o600 });
  out.write(Buffer.concat([MAGIC, salt]));
  await pipeline(createReadStream(src), createCipheriv('aes-256-cbc', key, iv), out);
}

/** Файл зашифрован паролем (начинается с «Salted__»). */
export async function isEncrypted(path: string): Promise<boolean> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(8);
    await fh.read(buf, 0, 8, 0);
    return buf.equals(MAGIC);
  } finally {
    await fh.close();
  }
}

/** Расшифровать; неверный пароль — ошибка «bad decrypt» (заполнение не сходится). */
export async function decryptFile(src: string, dst: string, password: string): Promise<void> {
  const fh = await open(src, 'r');
  const head = Buffer.alloc(16);
  try {
    await fh.read(head, 0, 16, 0);
  } finally {
    await fh.close();
  }
  if (!head.subarray(0, 8).equals(MAGIC)) throw new Error('Файл не зашифрован паролем');
  const { key, iv } = keyIv(password, head.subarray(8, 16));
  await pipeline(
    createReadStream(src, { start: 16 }),
    createDecipheriv('aes-256-cbc', key, iv),
    new Transform({ transform: (c, _e, cb) => cb(null, c) }),
    createWriteStream(dst, { mode: 0o600 }),
  );
}
