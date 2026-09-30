import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { VALKEY } from '../../infra/valkey/valkey.module.js';
import { type AuditRecordInput, AuditService } from '../audit/audit.service.js';
import { throttleIp } from './throttle.schedule.js';

/**
 * Какие записи появляются в Журнале по запросам без входа: отказы на запрос (нет CSRF-токена, нет
 * сессии) и неудачные попытки входа. Счёт у каждого вида свой — поток мусорных запросов не вытесняет
 * из Журнала записи о подборе пароля.
 */
export type AnonAuditKind = 'request' | 'login';

/**
 * Сколько таких записей в минуту пишется по одной; остальные попадают в одну сводную запись за минуту.
 * perAddress — с одного адреса (для IPv6 — с сети /64), 0 — без отдельного счёта: неудачных попыток
 * входа один адрес и так не сделает больше дюжины в минуту (паузы), им нужен только общий потолок.
 */
export const ANON_AUDIT_LIMITS: Record<AnonAuditKind, { perAddress: number; total: number }> = {
  request: { perAddress: 5, total: 30 },
  login: { perAddress: 0, total: 30 },
};

/** Путь запроса в Журнале — не длиннее этого: адрес с мусором в тысячи символов целиком не храним. */
export const AUDIT_PATH_MAX = 200;

const KINDS: AnonAuditKind[] = ['request', 'login'];
const BUCKET_MS = 60_000;
const COUNTER_TTL_SECONDS = 2 * 60;
const SKIPPED_TTL_SECONDS = 15 * 60;
/** Сколько прошлых минут досматривает сводка: на случай, когда панель перезапустили посреди потока. */
const CATCH_UP_BUCKETS = 5;

/**
 * Можно ли записать ещё одну строку. KEYS: счётчик адреса, общий счётчик, счётчик пропущенных.
 * Общий потолок проверяется первым: когда он исчерпан, ключи по адресам не заводятся — поток с тысяч
 * адресов не занимает память Valkey. 1 — писать; 0 — в сводку.
 */
const ALLOW_LUA = `
local function skip()
  if redis.call('INCR', KEYS[3]) == 1 then redis.call('EXPIRE', KEYS[3], ARGV[4]) end
  return 0
end
if tonumber(redis.call('GET', KEYS[2]) or '0') >= tonumber(ARGV[2]) then return skip() end
if tonumber(ARGV[1]) > 0 then
  local a = redis.call('INCR', KEYS[1])
  if a == 1 then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
  if a > tonumber(ARGV[1]) then return skip() end
end
if redis.call('INCR', KEYS[2]) == 1 then redis.call('EXPIRE', KEYS[2], ARGV[3]) end
return 1
`;

export function clipPath(path: string): string {
  return path.length > AUDIT_PATH_MAX ? `${path.slice(0, AUDIT_PATH_MAX - 1)}…` : path;
}

/**
 * Предел записей в Журнал от запросов без входа. Журнал только дописывается (удалить из него нельзя),
 * а такие записи может создавать кто угодно, зная адрес панели, — без предела ими заполняется диск.
 * Первые записи минуты пишутся как обычно, остальные считаются в Valkey и попадают в Журнал одной
 * сводной строкой, когда минута кончилась.
 */
@Injectable()
export class AnonAuditLimiter implements OnModuleDestroy {
  private readonly log = new Logger(AnonAuditLimiter.name);
  /** Минуты, за которые сводка уже ждёт своего часа. */
  private readonly timers = new Map<number, NodeJS.Timeout>();
  private warnedAt = 0;

  constructor(
    @Inject(VALKEY) private readonly valkey: Redis,
    private readonly audit: AuditService,
  ) {}

  /** Записать в Журнал, если предел минуты не исчерпан; иначе запись идёт только в счёт сводки. */
  async record(kind: AnonAuditKind, ip: string, input: AuditRecordInput): Promise<void> {
    if (await this.allow(kind, ip)) await this.audit.record(input);
  }

  async allow(kind: AnonAuditKind, ip: string): Promise<boolean> {
    const bucket = currentBucket();
    const limits = ANON_AUDIT_LIMITS[kind];
    let allowed: number;
    try {
      allowed = (await this.valkey.eval(
        ALLOW_LUA,
        3,
        `audit:anon:${kind}:ip:${throttleIp(ip)}:${bucket}`,
        `audit:anon:${kind}:all:${bucket}`,
        skippedKey(kind, bucket),
        limits.perAddress,
        limits.total,
        COUNTER_TTL_SECONDS,
        SKIPPED_TTL_SECONDS,
      )) as number;
    } catch (err) {
      // Счёт недоступен — не пишем: иначе поток запросов без входа снова писал бы в Журнал без предела.
      if (Date.now() - this.warnedAt > BUCKET_MS) {
        this.warnedAt = Date.now();
        this.log.warn(`Предел записей Журнала: счёт недоступен, запись пропущена: ${(err as Error).message}`);
      }
      return false;
    }
    if (allowed === 1) return true;
    this.armFlush(bucket);
    return false;
  }

  /**
   * Сводные записи за минуты до `before` (по умолчанию — включая текущую: при остановке панели и в тестах).
   * Счётчик забирается с удалением, поэтому одна и та же сводка дважды не пишется.
   */
  async flush(before = currentBucket() + 1): Promise<void> {
    for (let bucket = before - 1 - CATCH_UP_BUCKETS; bucket < before; bucket++) {
      for (const kind of KINDS) {
        const skipped = Number((await this.valkey.getdel(skippedKey(kind, bucket))) ?? 0);
        if (skipped > 0)
          await this.audit.record({
            action: 'auth.denied.summary',
            result: 'denied',
            severity: 'warn',
            source: 'auto',
            actor: { type: 'anonymous', id: null, display: '—' },
            metadata: { note: summaryNote(kind, skipped) },
          });
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await this.flush().catch(() => undefined);
  }

  /** Сводка пишется, когда минута кончилась: тогда известно, сколько всего записей в неё не попало. */
  private armFlush(bucket: number): void {
    if (this.timers.has(bucket)) return;
    const timer = setTimeout(
      () => {
        this.timers.delete(bucket);
        void this.flush(bucket + 1).catch((err: unknown) =>
          this.log.warn(`Сводка отклонённых запросов не записана: ${(err as Error).message}`),
        );
      },
      (bucket + 1) * BUCKET_MS - Date.now() + 1_000,
    );
    timer.unref();
    this.timers.set(bucket, timer);
  }
}

function currentBucket(): number {
  return Math.floor(Date.now() / BUCKET_MS);
}

function skippedKey(kind: AnonAuditKind, bucket: number): string {
  return `audit:anon:${kind}:skipped:${bucket}`;
}

function summaryNote(kind: AnonAuditKind, skipped: number): string {
  return kind === 'request'
    ? `Отклонено запросов без входа: ещё ${skipped}. По одному они не записаны.`
    : `Записей о неудачных попытках входа: ещё ${skipped}. По одной они не записаны.`;
}
