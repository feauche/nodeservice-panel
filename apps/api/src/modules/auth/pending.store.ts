import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { CryptoService } from '../../common/crypto/crypto.service.js';
import { VALKEY } from '../../infra/valkey/valkey.module.js';

export type PendingKind = 'login' | 'setup';

interface PendingBase {
  ip: string;
  ua: string;
  createdAt: string;
  /** Неудачные попытки TOTP/recovery на этом шаге (свой лимит, отдельно от throttle по паролю). */
  attempts: number;
}

/** «Пароль принят, ждём TOTP или код восстановления». */
export interface PendingLogin extends PendingBase {
  kind: 'login';
  userId: string;
  login: string;
}

/**
 * «Мастер первого запуска: логин/пароль приняты, ждём подтверждения секрета».
 * Пользователя в БД ещё нет — всё нужное для INSERT лежит здесь (секрет зашифрован).
 */
export interface PendingSetup extends PendingBase {
  kind: 'setup';
  setupTokenId: string;
  login: string;
  passwordHash: string;
  totpSecretEnc: string;
  totpKeyVersion: number;
}

export type PendingRecord = PendingLogin | PendingSetup;
export type PendingInput =
  | Omit<PendingLogin, 'createdAt' | 'attempts'>
  | Omit<PendingSetup, 'createdAt' | 'attempts'>;

export const PENDING_LOGIN_TTL_MS = 5 * 60_000;
export const PENDING_SETUP_TTL_MS = 10 * 60_000;
/** После стольких неудач на шаге кода pending-токен сгорает — назад к паролю. */
export const PENDING_MAX_ATTEMPTS = 5;

/** Инкремент attempts внутри JSON с сохранением TTL; 0 — записи уже нет. */
const BUMP_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local rec = cjson.decode(raw)
rec.attempts = (rec.attempts or 0) + 1
redis.call('SET', KEYS[1], cjson.encode(rec), 'KEEPTTL')
return rec.attempts
`;

/**
 * Промежуточные состояния между шагами. Клиент держит только opaque-токен (cookie),
 * в Valkey — запись под sha256(token) с TTL шага.
 */
@Injectable()
export class PendingStore {
  constructor(
    @Inject(VALKEY) private readonly valkey: Redis,
    private readonly crypto: CryptoService,
  ) {}

  async create(record: PendingInput, ttlMs: number): Promise<string> {
    const token = this.crypto.randomToken(32);
    const full: PendingRecord = { ...record, attempts: 0, createdAt: new Date().toISOString() };
    await this.valkey.set(this.key(token), JSON.stringify(full), 'PX', ttlMs);
    return token;
  }

  async get(token: string | undefined, kind: 'login'): Promise<PendingLogin | null>;
  async get(token: string | undefined, kind: 'setup'): Promise<PendingSetup | null>;
  async get(token: string | undefined, kind: PendingKind): Promise<PendingRecord | null> {
    if (!token || !isSafeToken(token)) return null;
    const raw = await this.valkey.get(this.key(token));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as PendingRecord;
      if (parsed.kind !== kind) return null;
      return { ...parsed, attempts: Number(parsed.attempts) || 0 };
    } catch {
      return null;
    }
  }

  /** Регистрирует неудачу на шаге кода; возвращает число попыток (0 — записи нет). */
  async recordFailure(token: string): Promise<number> {
    if (!isSafeToken(token)) return 0;
    const n = (await this.valkey.eval(BUMP_LUA, 1, this.key(token))) as number;
    return Number(n) || 0;
  }

  async consume(token: string): Promise<void> {
    if (!isSafeToken(token)) return;
    await this.valkey.del(this.key(token));
  }

  private key(token: string): string {
    return `pending:${this.crypto.sha256Hex(token)}`;
  }
}

function isSafeToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{16,128}$/.test(token);
}
