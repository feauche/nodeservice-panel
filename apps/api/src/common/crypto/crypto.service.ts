import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';

import type { Env } from '../../config/env.schema.js';

/** argon2id для паролей: 128 МиБ, 3 прохода, 4 потока (один пользователь — дорогой хеш бесплатен). */
export const PASSWORD_HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 131_072,
  timeCost: 3,
  parallelism: 4,
} as const;

/**
 * Одновременных хешей пароля — не больше двух: каждый занимает 128 МиБ и поток из пула libuv (их четыре,
 * на них же чтение файлов и поиск адресов для SSH). Залп попыток входа иначе съедает память панели.
 */
export const PASSWORD_HASH_CONCURRENCY = 2;

/** Очередь к ограниченному числу мест: лишние операции ждут, пока место освободится. */
class Slots {
  private busy = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  get waiting(): number {
    return this.queue.length;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy < this.limit) this.busy += 1;
    else await new Promise<void>((resolve) => this.queue.push(resolve));
    try {
      return await fn();
    } finally {
      // Место передаётся следующему в очереди напрямую — счётчик занятых не меняется.
      const next = this.queue.shift();
      if (next) next();
      else this.busy -= 1;
    }
  }
}

/** Один предел на процесс (как и dummyHashPromise): память общая, сколько бы экземпляров сервиса ни было. */
const passwordSlots = new Slots(PASSWORD_HASH_CONCURRENCY);

/** Коды восстановления проверяются перебором (до 10 штук) — параметры легче. */
export const RECOVERY_HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Хеш-«пустышка»: вычисляется один раз, чтобы проверка пароля несуществующего
 * пользователя занимала столько же времени, сколько и существующего.
 */
let dummyHashPromise: Promise<string> | undefined;

const CIPHER = 'aes-256-gcm';
const IV_BYTES = 12;
/** Контекст HKDF для pepper, если PASSWORD_PEPPER не задан явно. */
const PEPPER_HKDF_INFO = 'nodeservice/password-pepper/v1';
const PEPPER_BYTES = 32;

/**
 * Pepper для argon2 («secret»): либо PASSWORD_PEPPER (hex), либо HKDF-SHA256 от APP_SECRET.
 * Хранится отдельно от БД — утёкшая таблица users без env бесполезна для перебора.
 */
export function derivePepper(pepperHex: string | undefined, appSecret: string): Buffer {
  if (pepperHex) return Buffer.from(pepperHex, 'hex');
  return Buffer.from(hkdfSync('sha256', appSecret, '', PEPPER_HKDF_INFO, PEPPER_BYTES));
}

@Injectable()
export class CryptoService {
  private readonly key: Buffer;
  private readonly keyVersion: number;
  private readonly pepper: Buffer;

  constructor(config: ConfigService<Env, true>) {
    const keyHex: string = config.get('ENCRYPTION_KEY');
    this.key = Buffer.from(keyHex, 'hex');
    this.keyVersion = config.get('ENCRYPTION_KEY_VERSION');
    this.pepper = derivePepper(config.get('PASSWORD_PEPPER'), config.get('APP_SECRET'));
  }

  /* ---------- пароли ---------- */

  hashPassword(password: string): Promise<string> {
    return passwordSlots.run(() => argon2.hash(password, { ...PASSWORD_HASH_OPTIONS, secret: this.pepper }));
  }

  async verifyPassword(hash: string, password: string): Promise<boolean> {
    try {
      return await passwordSlots.run(() => argon2.verify(hash, password, { secret: this.pepper }));
    } catch {
      return false;
    }
  }

  /** Сколько проверок пароля ждёт своей очереди: вход отказывает сразу, когда очередь уже длинная. */
  get passwordChecksWaiting(): number {
    return passwordSlots.waiting;
  }

  /** Проверка против фиктивного хеша — выравнивает время ответа при неизвестном логине. */
  async verifyAgainstDummy(password: string): Promise<false> {
    dummyHashPromise ??= this.hashPassword(randomBytes(32).toString('base64url'));
    await this.verifyPassword(await dummyHashPromise, password);
    return false;
  }

  /* ---------- коды восстановления ---------- */

  hashRecoveryCode(code: string): Promise<string> {
    return argon2.hash(code, { ...RECOVERY_HASH_OPTIONS, secret: this.pepper });
  }

  async verifyRecoveryCode(hash: string, code: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, code, { secret: this.pepper });
    } catch {
      return false;
    }
  }

  /* ---------- AES-256-GCM ---------- */

  /** Формат: `v{version}:{iv}:{tag}:{ciphertext}`, всё в base64url. */
  encrypt(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(CIPHER, this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [`v${this.keyVersion}`, b64(iv), b64(tag), b64(ct)].join(':');
  }

  decrypt(stored: string): string {
    const parts = stored.split(':');
    const [ver, ivStr, tagStr, ctStr] = parts;
    if (parts.length !== 4 || !ver || !ivStr || !tagStr || !ctStr || !/^v\d+$/.test(ver))
      throw new Error('Повреждённый шифротекст: неверный формат');
    const version = Number(ver.slice(1));
    if (version !== this.keyVersion)
      throw new Error(`Шифротекст версии ключа ${version}, а активна ${this.keyVersion}`);
    const decipher = createDecipheriv(CIPHER, this.key, Buffer.from(ivStr, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagStr, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ctStr, 'base64url')), decipher.final()]).toString(
      'utf8',
    );
  }

  get currentKeyVersion(): number {
    return this.keyVersion;
  }

  /* ---------- токены ---------- */

  randomToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  sha256Hex(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  /** Сравнение без утечки по времени; разная длина → false без исключения. */
  constantTimeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ab.length !== bb.length) {
      // всё равно тратим время на сравнение, чтобы не выдавать длину
      timingSafeEqual(ab, ab);
      return false;
    }
    return timingSafeEqual(ab, bb);
  }
}

function b64(buf: Buffer): string {
  return buf.toString('base64url');
}
