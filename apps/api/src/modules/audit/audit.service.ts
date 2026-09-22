import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  type AuditCategory,
  type AuditChanges,
  type AuditEntry,
  type AuditResult,
  type AuditSeverity,
  type AuditSource,
} from '@nodeservice/shared';
import { ClsService } from 'nestjs-cls';

import { DB, type Db } from '../../infra/db/db.module.js';
import { CLS_USER } from '../auth/cls-keys.js';
import {
  type AuditActor,
  type AuditExtra,
  type AuditTarget,
  CLS_AUDIT_EXTRA,
  CLS_REQUEST,
  type ClsRequestInfo,
} from './audit.context.js';
import { AuditEvents } from './audit.events.js';
import { AuditRepository } from './audit.repository.js';
import { type AuditInsert, auditLog } from './audit.table.js';
import { AuditPartitionsService } from './audit-partitions.service.js';

export interface AuditRecordInput {
  action: string;
  /** По умолчанию — из AUDIT_ACTIONS или префикса action. */
  category?: AuditCategory;
  result?: AuditResult;
  severity?: AuditSeverity;
  /** По умолчанию: system-актор → auto, иначе manual. */
  source?: AuditSource;
  /** По умолчанию — пользователь сессии из CLS, иначе anonymous. */
  actor?: AuditActor;
  target?: AuditTarget;
  ip?: string;
  userAgent?: string;
  requestId?: string;
  durationMs?: number;
  changes?: AuditChanges | null;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
}

const RETRY_QUEUE_MAX = 1000;
const RETRY_INTERVAL_MS = 5_000;
/** Postgres: check_violation — в т.ч. «no partition of relation … found for row». */
const PG_CHECK_VIOLATION = '23514';
const UA_MAX = 512;
const DISPLAY_MAX = 200;

/**
 * Запись в Журнал. Синхронно пишет в БД (вызывающий ждёт — запись гарантированно есть до ответа);
 * если БД недоступна — кладёт в ограниченную очередь повторов и пишет ошибку в лог,
 * но никогда не роняет само действие. Пароли, коды и токены сюда попадать не должны —
 * ответственность вызывающего (см. AuthEventsService: только факт и причина).
 */
@Injectable()
export class AuditService implements OnModuleDestroy {
  private readonly log = new Logger(AuditService.name);
  private readonly retryQueue: AuditInsert[] = [];
  private retryTimer: NodeJS.Timeout | null = null;
  private flushing = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly cls: ClsService,
    private readonly events: AuditEvents,
    private readonly repo: AuditRepository,
    private readonly partitions: AuditPartitionsService,
  ) {}

  /** Добавить детали (цель, diff, метаданные) к записи, которую сделает @Audit-интерсептор. */
  extend(patch: AuditExtra): void {
    if (!this.cls.isActive()) return;
    const current = this.cls.get<AuditExtra | undefined>(CLS_AUDIT_EXTRA) ?? {};
    this.cls.set(CLS_AUDIT_EXTRA, {
      ...current,
      ...patch,
      metadata: { ...(current.metadata ?? {}), ...(patch.metadata ?? {}) },
    });
  }

  /** Забрать и очистить накопленные детали (интерсептор). */
  takeExtra(): AuditExtra {
    if (!this.cls.isActive()) return {};
    const extra = this.cls.get<AuditExtra | undefined>(CLS_AUDIT_EXTRA) ?? {};
    this.cls.set(CLS_AUDIT_EXTRA, undefined);
    return extra;
  }

  async record(input: AuditRecordInput): Promise<AuditEntry | null> {
    const row = this.toInsert(input);
    try {
      const entry = await this.insert(row);
      this.events.emitCreated(entry);
      return entry;
    } catch (err) {
      this.enqueue(row, err);
      return null;
    }
  }

  private async insert(row: AuditInsert): Promise<AuditEntry> {
    try {
      return await this.insertOnce(row);
    } catch (err) {
      if (!isPgError(err, PG_CHECK_VIOLATION)) throw err;
      // Раздела на этот месяц ещё нет (часы/долгий простой) — создаём и повторяем один раз.
      await this.partitions.ensureFor(row.occurredAt ?? new Date());
      return await this.insertOnce(row);
    }
  }

  private async insertOnce(row: AuditInsert): Promise<AuditEntry> {
    const [inserted] = await this.db.insert(auditLog).values(row).returning();
    if (!inserted) throw new Error('audit_log insert вернул пустой результат');
    return this.repo.toEntry(inserted);
  }

  private toInsert(input: AuditRecordInput): AuditInsert {
    const actor = input.actor ?? this.actorFromCls();
    const req = this.cls.isActive() ? this.cls.get<ClsRequestInfo | undefined>(CLS_REQUEST) : undefined;
    const category =
      input.category ??
      (AUDIT_ACTIONS as Record<string, { category: AuditCategory }>)[input.action]?.category ??
      categoryFromAction(input.action);
    const ip = (input.ip ?? req?.ip ?? '').trim();
    const ua = (input.userAgent ?? req?.ua ?? '').trim();
    const requestId = input.requestId ?? (this.cls.isActive() ? this.cls.getId() : undefined);
    const row: AuditInsert = {
      actorType: actor.type,
      actorId: actor.id ?? null,
      actorDisplay: clip(actor.display, DISPLAY_MAX),
      action: input.action,
      category,
      targetType: input.target?.type ?? null,
      targetId: input.target?.id ?? null,
      targetDisplay: input.target?.display ? clip(input.target.display, DISPLAY_MAX) : null,
      result: input.result ?? 'ok',
      severity: input.severity ?? 'info',
      source: input.source ?? (actor.type === 'system' ? 'auto' : 'manual'),
      ip: ip === '' ? null : ip,
      userAgent: ua === '' ? null : clip(ua, UA_MAX),
      requestId: requestId && requestId !== '' ? requestId : null,
      durationMs: input.durationMs === undefined ? null : Math.max(0, Math.round(input.durationMs)),
      changes: input.changes ?? null,
      metadata: input.metadata ?? {},
    };
    if (input.occurredAt) row.occurredAt = input.occurredAt;
    return row;
  }

  private actorFromCls(): AuditActor {
    if (this.cls.isActive()) {
      const user = this.cls.get<{ id: string; login: string } | undefined>(CLS_USER);
      if (user) return { type: 'admin', id: user.id, display: user.login };
    }
    return { type: 'anonymous', id: null, display: '—' };
  }

  /* ---------- очередь повторов ---------- */

  private enqueue(row: AuditInsert, err: unknown): void {
    if (this.retryQueue.length >= RETRY_QUEUE_MAX) {
      const dropped = this.retryQueue.shift();
      this.log.error({ action: dropped?.action }, 'Журнал: очередь повторов переполнена, запись потеряна');
    }
    this.retryQueue.push(row);
    this.log.error(
      { action: row.action, queued: this.retryQueue.length, err: errorMessage(err) },
      'Журнал: не удалось записать, повторю позже',
    );
    if (!this.retryTimer) {
      this.retryTimer = setInterval(() => void this.flush(), RETRY_INTERVAL_MS);
      this.retryTimer.unref();
    }
  }

  /** Повторить отложенные записи (по порядку; при первой ошибке — ждём следующего тика). */
  async flush(): Promise<number> {
    if (this.flushing) return 0;
    this.flushing = true;
    let written = 0;
    try {
      while (this.retryQueue.length > 0) {
        const row = this.retryQueue[0];
        if (!row) break;
        try {
          const entry = await this.insert(row);
          this.retryQueue.shift();
          written++;
          this.events.emitCreated(entry);
        } catch {
          break;
        }
      }
      if (this.retryQueue.length === 0 && this.retryTimer) {
        clearInterval(this.retryTimer);
        this.retryTimer = null;
        if (written > 0) this.log.warn({ written }, 'Журнал: отложенные записи дописаны');
      }
    } finally {
      this.flushing = false;
    }
    return written;
  }

  get pending(): number {
    return this.retryQueue.length;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.retryQueue.length > 0) await this.flush();
  }
}

function categoryFromAction(action: string): AuditCategory {
  const prefix = action.split('.')[0];
  return prefix === 'auth' || prefix === 'settings' || prefix === 'security' ? prefix : 'system';
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function isPgError(err: unknown, code: string): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  return e.code === code || e.cause?.code === code;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
