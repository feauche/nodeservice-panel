import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Me } from '@nodeservice/shared';
import type { Redis } from 'ioredis';

import { CryptoService } from '../../common/crypto/crypto.service.js';
import type { Env } from '../../config/env.schema.js';
import { VALKEY } from '../../infra/valkey/valkey.module.js';
import { SecurityPolicyStore } from './security-policy.store.js';

export type Amr = Me['amr'][number];

export interface SessionRecord {
  id: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  absoluteExpiresAt: string;
  ua: string;
  ip: string;
  amr: Amr[];
  /** Когда последний раз вводили пароль (создание сессии или /unlock). */
  stepUpAt: string | null;
  /** Экран заблокирован (вручную или по бездействию): до /unlock остальные запросы получают 403 locked. */
  lockedAt: string | null;
  /** Только что заблокирована этим же touch (по бездействию) — чтобы записать событие в Журнал. */
  autoLocked?: boolean;
}

export interface CreateSessionInput {
  userId: string;
  ua: string;
  ip: string;
  amr: Amr[];
}

const SESSION_PREFIX = 'sess:';
const userIndexKey = (userId: string): string => `user:${userId}:sessions`;

/** Продление только существующего ключа: сессия, удалённая между get и touch, не воскресает. */
const TOUCH_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('HSET', KEYS[1], 'lastSeenAt', ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`;

/**
 * Серверные сессии в Valkey: hash `sess:{sid}` + индекс `user:{userId}:sessions`.
 * TTL скользящий (idle), но не дольше абсолютного срока.
 */
@Injectable()
export class SessionStore {
  private readonly idleMs: number;
  private readonly absoluteMs: number;
  private readonly trustedAbsoluteMs: number;

  constructor(
    @Inject(VALKEY) private readonly valkey: Redis,
    private readonly crypto: CryptoService,
    private readonly policy: SecurityPolicyStore,
    config: ConfigService<Env, true>,
  ) {
    // Стартовое значение из env; дальше idle берётся из политики безопасности (Настройки → Безопасность).
    this.idleMs = config.get('SESSION_IDLE_MINUTES') * 60_000;
    this.absoluteMs = config.get('SESSION_ABSOLUTE_HOURS') * 3_600_000;
    this.trustedAbsoluteMs = config.get('TRUSTED_SESSION_ABSOLUTE_HOURS') * 3_600_000;
  }

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    const now = Date.now();
    const absolute = input.amr.includes('trusted') ? this.trustedAbsoluteMs : this.absoluteMs;
    const record: SessionRecord = {
      id: this.crypto.randomToken(32),
      userId: input.userId,
      createdAt: new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      absoluteExpiresAt: new Date(now + absolute).toISOString(),
      ua: input.ua.slice(0, 512),
      ip: input.ip,
      amr: input.amr,
      stepUpAt: input.amr.includes('pwd') ? new Date(now).toISOString() : null,
      lockedAt: null,
    };
    const key = SESSION_PREFIX + record.id;
    await this.valkey
      .multi()
      .hset(key, serialize(record))
      .pexpire(key, await this.ttlFor(record, now))
      .sadd(userIndexKey(record.userId), record.id)
      .exec();
    return record;
  }

  /**
   * Возвращает сессию и продлевает её (скользящий TTL). null — нет/истекла.
   * lockAfterMs > 0: если с прошлого запроса прошло больше — экран блокируется на сервере
   * (нужен пароль, а не полный вход), запись помечается autoLocked для Журнала.
   */
  async touch(sid: string, lockAfterMs = 0): Promise<SessionRecord | null> {
    const record = await this.get(sid);
    if (!record) return null;
    const now = Date.now();
    if (!record.lockedAt && lockAfterMs > 0 && now - Date.parse(record.lastSeenAt) > lockAfterMs) {
      record.lockedAt = new Date(now).toISOString();
      record.autoLocked = true;
      await this.valkey.hset(SESSION_PREFIX + sid, { lockedAt: record.lockedAt });
    }
    record.lastSeenAt = new Date(now).toISOString();
    const key = SESSION_PREFIX + sid;
    const touched = (await this.valkey.eval(
      TOUCH_LUA,
      1,
      key,
      record.lastSeenAt,
      String(await this.ttlFor(record, now)),
    )) as number;
    return touched === 1 ? record : null;
  }

  /** Чтение без продления. Сессии за абсолютным сроком удаляются на месте. */
  async get(sid: string): Promise<SessionRecord | null> {
    if (!isSafeSid(sid)) return null;
    const raw = await this.valkey.hgetall(SESSION_PREFIX + sid);
    if (!raw.userId) return null;
    const record = deserialize(sid, raw);
    if (Date.parse(record.absoluteExpiresAt) <= Date.now()) {
      await this.destroy(sid);
      return null;
    }
    return record;
  }

  async setStepUp(sid: string, at: Date): Promise<void> {
    await this.valkey.hset(SESSION_PREFIX + sid, { stepUpAt: at.toISOString() });
  }

  /** Заблокировать/разблокировать экран сессии (null — снять блокировку). */
  async setLocked(sid: string, at: Date | null): Promise<void> {
    await this.valkey.hset(SESSION_PREFIX + sid, { lockedAt: at ? at.toISOString() : '' });
  }

  async destroy(sid: string): Promise<void> {
    if (!isSafeSid(sid)) return;
    const userId = await this.valkey.hget(SESSION_PREFIX + sid, 'userId');
    const multi = this.valkey.multi().del(SESSION_PREFIX + sid);
    if (userId) multi.srem(userIndexKey(userId), sid);
    await multi.exec();
  }

  async destroyAllForUser(userId: string): Promise<number> {
    const ids = await this.valkey.smembers(userIndexKey(userId));
    if (ids.length === 0) return 0;
    const multi = this.valkey.multi();
    for (const id of ids) multi.del(SESSION_PREFIX + id);
    multi.del(userIndexKey(userId));
    await multi.exec();
    return ids.length;
  }

  /** Живые сессии пользователя; протухшие вычищаются из индекса попутно. */
  async listForUser(userId: string): Promise<SessionRecord[]> {
    const ids = await this.valkey.smembers(userIndexKey(userId));
    const result: SessionRecord[] = [];
    const dead: string[] = [];
    for (const id of ids) {
      const record = await this.get(id);
      if (record) result.push(record);
      else dead.push(id);
    }
    if (dead.length > 0) await this.valkey.srem(userIndexKey(userId), ...dead);
    return result.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  private async ttlFor(record: SessionRecord, now: number): Promise<number> {
    const untilAbsolute = Date.parse(record.absoluteExpiresAt) - now;
    const idleMs = (await this.policy.get().catch(() => null))?.idleMinutes ?? 0;
    return Math.max(1, Math.min(idleMs > 0 ? idleMs * 60_000 : this.idleMs, untilAbsolute));
  }

  /** Завершить все сессии пользователя, кроме одной (смена пароля, перевыпуск 2FA, «выйти везде»). */
  async destroyOthersForUser(userId: string, keepSid: string): Promise<number> {
    const ids = (await this.valkey.smembers(userIndexKey(userId))).filter((id) => id !== keepSid);
    if (ids.length === 0) return 0;
    const multi = this.valkey.multi();
    for (const id of ids) multi.del(SESSION_PREFIX + id);
    multi.srem(userIndexKey(userId), ...ids);
    await multi.exec();
    return ids.length;
  }
}

function isSafeSid(sid: string): boolean {
  return /^[A-Za-z0-9_-]{16,128}$/.test(sid);
}

function serialize(r: SessionRecord): Record<string, string> {
  return {
    userId: r.userId,
    createdAt: r.createdAt,
    lastSeenAt: r.lastSeenAt,
    absoluteExpiresAt: r.absoluteExpiresAt,
    ua: r.ua,
    ip: r.ip,
    amr: JSON.stringify(r.amr),
    stepUpAt: r.stepUpAt ?? '',
    lockedAt: r.lockedAt ?? '',
  };
}

function deserialize(id: string, raw: Record<string, string>): SessionRecord {
  let amr: Amr[] = [];
  try {
    const parsed: unknown = JSON.parse(raw.amr ?? '[]');
    if (Array.isArray(parsed)) amr = parsed.filter(isAmr);
  } catch {
    amr = [];
  }
  return {
    id,
    userId: raw.userId ?? '',
    createdAt: raw.createdAt ?? '',
    lastSeenAt: raw.lastSeenAt ?? '',
    absoluteExpiresAt: raw.absoluteExpiresAt ?? '',
    ua: raw.ua ?? '',
    ip: raw.ip ?? '',
    amr,
    stepUpAt: raw.stepUpAt ? raw.stepUpAt : null,
    lockedAt: raw.lockedAt ? raw.lockedAt : null,
  };
}

const AMR_VALUES: ReadonlySet<string> = new Set(['pwd', 'totp', 'recovery', 'trusted']);
function isAmr(v: unknown): v is Amr {
  return typeof v === 'string' && AMR_VALUES.has(v);
}
