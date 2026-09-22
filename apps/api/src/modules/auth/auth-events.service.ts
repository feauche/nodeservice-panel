import { Injectable } from '@nestjs/common';
import type { AuditResult, AuditSeverity, Me } from '@nodeservice/shared';
import { PinoLogger } from 'nestjs-pino';

import { AuditService } from '../audit/audit.service.js';

export type AuthEvent =
  | 'auth.setup.completed'
  | 'auth.login.success'
  | 'auth.login.failed'
  | 'auth.login.throttled'
  | 'auth.totp.failed'
  | 'auth.recovery.used'
  | 'auth.logout'
  | 'auth.lock'
  | 'auth.unlock'
  | 'auth.trusted_device.added';

export interface AuthEventContext {
  userId?: string;
  login?: string;
  ip: string;
  ua: string;
  requestId: string;
  amr?: Me['amr'];
  /** Небольшие безопасные детали (без секретов): например, причина или остаток кодов. */
  meta?: Record<string, string | number | boolean>;
}

const OUTCOME: Record<AuthEvent, { result: AuditResult; severity: AuditSeverity }> = {
  'auth.setup.completed': { result: 'ok', severity: 'info' },
  'auth.login.success': { result: 'ok', severity: 'info' },
  'auth.login.failed': { result: 'failed', severity: 'warn' },
  'auth.login.throttled': { result: 'denied', severity: 'warn' },
  'auth.totp.failed': { result: 'failed', severity: 'warn' },
  'auth.recovery.used': { result: 'ok', severity: 'warn' },
  'auth.logout': { result: 'ok', severity: 'info' },
  'auth.lock': { result: 'ok', severity: 'info' },
  'auth.unlock': { result: 'ok', severity: 'info' },
  'auth.trusted_device.added': { result: 'ok', severity: 'info' },
};

/**
 * События входа → Журнал (audit_log) + структурированная строка pino.
 * Никаких паролей, кодов и токенов в контексте быть не должно — только факт и причина.
 * Актор задаётся явно: на этих путях сессии в CLS ещё нет (гость) или она только что создана.
 */
@Injectable()
export class AuthEventsService {
  constructor(
    private readonly logger: PinoLogger,
    private readonly audit: AuditService,
  ) {
    this.logger.setContext('AuthEvents');
  }

  async record(event: AuthEvent, ctx: AuthEventContext): Promise<void> {
    const payload = {
      event,
      userId: ctx.userId,
      login: ctx.login,
      ip: ctx.ip,
      ua: ctx.ua.slice(0, 256),
      requestId: ctx.requestId,
      amr: ctx.amr,
      ...(ctx.meta ?? {}),
    };
    if (event.endsWith('.failed') || event.endsWith('.throttled')) this.logger.warn(payload, event);
    else this.logger.info(payload, event);

    const { result, severity } = OUTCOME[event];
    await this.audit.record({
      action: event,
      result,
      severity,
      source: 'manual',
      actor: ctx.userId
        ? { type: 'admin', id: ctx.userId, display: ctx.login ?? 'admin' }
        : { type: 'anonymous', id: null, display: ctx.login ?? '—' },
      ip: ctx.ip,
      userAgent: ctx.ua,
      requestId: ctx.requestId,
      metadata: {
        ...(ctx.login ? { login: ctx.login } : {}),
        ...(ctx.amr ? { amr: ctx.amr } : {}),
        ...(ctx.meta ?? {}),
      },
    });
  }
}
