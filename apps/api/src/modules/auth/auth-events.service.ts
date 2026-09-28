import { Injectable, Optional } from '@nestjs/common';
import type { AuditResult, AuditSeverity, Me } from '@nodeservice/shared';
import { PinoLogger } from 'nestjs-pino';

import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';

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
    // Нет в консольной утилите панели (rescue CLI): там вход только пишется в Журнал.
    @Optional() private readonly notifications?: NotificationsService,
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

    // Telegram «Вход в панель»: вход без доверенного устройства (значит, новое) и блокировка после
    // серии неудачных попыток. Вход с доверенного устройства — обычная жизнь, не шумим.
    const newDevice = event === 'auth.login.success' && !(ctx.amr ?? []).includes('trusted');
    if (this.notifications && (newDevice || event === 'auth.login.throttled'))
      await this.notifications.push({
        severity: 'info',
        title: newDevice ? 'Вход в панель с нового устройства' : 'Серия неудачных попыток входа',
        body: `${newDevice ? `Вошёл «${ctx.login ?? 'admin'}». ` : `Логин «${ctx.login ?? '—'}», вход временно заблокирован. `}IP ${ctx.ip}, ${deviceOf(ctx.ua)}. Если это не вы — смените пароль в «Настройки → Безопасность».`,
        link: { to: '/settings/security', label: 'Открыть безопасность' },
        telegram: { event: 'login' },
      });
  }
}

/** «Chrome на macOS» из User-Agent — достаточно, чтобы узнать своё устройство. */
function deviceOf(ua: string): string {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /YaBrowser/.test(ua)
      ? 'Яндекс Браузер'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'браузер';
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'неизвестной системе';
  return `${browser} на ${os}`;
}
