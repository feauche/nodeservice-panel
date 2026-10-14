import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { LockReason, Me } from '@nodeservice/shared';
import type { Redis } from 'ioredis';

import { CryptoService } from '../../common/crypto/crypto.service.js';
import type { Env } from '../../config/env.schema.js';
import { VALKEY } from '../../infra/valkey/valkey.module.js';
import { SecurityPolicyStore } from './security-policy.store.js';
import { SessionChannelsService } from './session-channels.service.js';

export type Amr = Me['amr'][number];

export interface SessionRecord {
  id: string;
  userId: string;
  createdAt: string;
  /** Последний запрос любого рода — для списка сессий и скользящего срока. */
  lastSeenAt: string;
  /**
   * Когда человек последний раз что-то делал в панели (со слов браузера, заголовок x-ns-idle). Опросы
   * и перечитывания по потоку событий идут сами и это время не сдвигают — по нему считается автоблокировка.
   */
  lastActiveAt: string;
  absoluteExpiresAt: string;
  ua: string;
  ip: string;
  amr: Amr[];
  /** Когда последний раз вводили пароль (создание сессии или /unlock). */
  stepUpAt: string | null;
  /** Экран заблокирован (вручную или по бездействию): до /unlock остальные запросы получают 403 locked. */
  lockedAt: string | null;
  /** Почему заблокирован — для экрана блокировки в любой вкладке. */
  lockReason: LockReason | null;
  /** Через сколько минут бездействия сработала блокировка. */
  lockIdleMinutes: number | null;
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

/**
 * Продление только существующего ключа: сессия, удалённая между get и touch, не воскресает.
 * ARGV[3] — новое время действия человека; пусто — не менялось.
 */
const TOUCH_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('HSET', KEYS[1], 'lastSeenAt', ARGV[1])
if ARGV[3] ~= '' then redis.call('HSET', KEYS[1], 'lastActiveAt', ARGV[3]) end
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
    private readonly channels: SessionChannelsService,
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
      lastActiveAt: new Date(now).toISOString(),
      absoluteExpiresAt: new Date(now + absolute).toISOString(),
      ua: input.ua.slice(0, 512),
      ip: input.ip,
      amr: input.amr,
      stepUpAt: input.amr.includes('pwd') ? new Date(now).toISOString() : null,
      lockedAt: null,
      lockReason: null,
      lockIdleMinutes: null,
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
   * lockAfterMs > 0 — автоблокировка: если человек не трогал панель дольше, экран блокируется на сервере
   * (нужен пароль, а не полный вход), запись помечается autoLocked для Журнала.
   * activeAt — когда человек последний раз что-то делал, со слов браузера: undefined — запрос без заголовка
   * (не из панели или старая вкладка), считается действием сейчас; null — поток событий, действием не считается.
   */
  async touch(sid: string, lockAfterMs = 0, activeAt?: number | null): Promise<SessionRecord | null> {
    const record = await this.get(sid);
    if (!record) return null;
    const now = Date.now();
    const prev = Date.parse(record.lastActiveAt) || Date.parse(record.lastSeenAt) || now;
    const reported = activeAt === null ? null : Math.min(now, activeAt ?? now);
    const active = reported !== null && reported > prev ? reported : prev;
    // Человек отсутствовал дольше срока: либо его нет до сих пор, либо он только что вернулся после такого
    // перерыва — в обоих случаях сначала пароль.
    if (!record.lockedAt && lockAfterMs > 0 && (now - active > lockAfterMs || active - prev > lockAfterMs)) {
      record.lockedAt = new Date(now).toISOString();
      record.lockReason = 'idle';
      record.lockIdleMinutes = Math.max(1, Math.round(lockAfterMs / 60_000));
      record.autoLocked = true;
      await this.valkey.hset(SESSION_PREFIX + sid, {
        lockedAt: record.lockedAt,
        lockReason: record.lockReason,
        lockIdleMinutes: String(record.lockIdleMinutes),
      });
    }
    record.lastSeenAt = new Date(now).toISOString();
    const activeMoved = active > prev;
    if (activeMoved) record.lastActiveAt = new Date(active).toISOString();
    const key = SESSION_PREFIX + sid;
    const touched = (await this.valkey.eval(
      TOUCH_LUA,
      1,
      key,
      record.lastSeenAt,
      String(await this.ttlFor(record, now)),
      activeMoved ? record.lastActiveAt : '',
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

  /**
   * Заблокировать экран сессии (с причиной) или снять блокировку (at = null). Снятие — это ввод пароля,
   * то есть действие человека: отсчёт бездействия начинается заново.
   */
  async setLocked(
    sid: string,
    at: Date | null,
    reason: LockReason = 'manual',
    idleMinutes: number | null = null,
  ): Promise<void> {
    await this.valkey.hset(
      SESSION_PREFIX + sid,
      at
        ? {
            lockedAt: at.toISOString(),
            lockReason: reason,
            lockIdleMinutes: reason === 'idle' && idleMinutes ? String(idleMinutes) : '',
          }
        : { lockedAt: '', lockReason: '', lockIdleMinutes: '', lastActiveAt: new Date().toISOString() },
    );
  }

  async destroy(sid: string): Promise<void> {
    if (!isSafeSid(sid)) return;
    const userId = await this.valkey.hget(SESSION_PREFIX + sid, 'userId');
    const multi = this.valkey.multi().del(SESSION_PREFIX + sid);
    if (userId) multi.srem(userIndexKey(userId), sid);
    await multi.exec();
    this.channels.revoke([sid]);
  }

  async destroyAllForUser(userId: string): Promise<number> {
    const ids = await this.valkey.smembers(userIndexKey(userId));
    if (ids.length === 0) return 0;
    const multi = this.valkey.multi();
    for (const id of ids) multi.del(SESSION_PREFIX + id);
    multi.del(userIndexKey(userId));
    await multi.exec();
    this.channels.revoke(ids);
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
    this.channels.revoke(ids);
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
    lastActiveAt: r.lastActiveAt,
    absoluteExpiresAt: r.absoluteExpiresAt,
    ua: r.ua,
    ip: r.ip,
    amr: JSON.stringify(r.amr),
    stepUpAt: r.stepUpAt ?? '',
    lockedAt: r.lockedAt ?? '',
    lockReason: r.lockReason ?? '',
    lockIdleMinutes: r.lockIdleMinutes ? String(r.lockIdleMinutes) : '',
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
    // Сессии до 0.101: времени действия ещё нет — берём время последнего запроса.
    lastActiveAt: raw.lastActiveAt || raw.lastSeenAt || '',
    absoluteExpiresAt: raw.absoluteExpiresAt ?? '',
    ua: raw.ua ?? '',
    ip: raw.ip ?? '',
    amr,
    stepUpAt: raw.stepUpAt ? raw.stepUpAt : null,
    lockedAt: raw.lockedAt ? raw.lockedAt : null,
    lockReason:
      raw.lockedAt && (raw.lockReason === 'manual' || raw.lockReason === 'idle') ? raw.lockReason : null,
    lockIdleMinutes: raw.lockedAt && Number(raw.lockIdleMinutes) > 0 ? Number(raw.lockIdleMinutes) : null,
  };
}

const AMR_VALUES: ReadonlySet<string> = new Set(['pwd', 'totp', 'recovery', 'trusted']);
function isAmr(v: unknown): v is Amr {
  return typeof v === 'string' && AMR_VALUES.has(v);
}
