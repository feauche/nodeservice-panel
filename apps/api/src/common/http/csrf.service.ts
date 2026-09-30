import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AUTH_PROBLEM, CSRF_HEADER } from '@nodeservice/shared';
import { type DoubleCsrfUtilities, doubleCsrf } from 'csrf-csrf';
import type { NextFunction, Request, Response } from 'express';

import type { Env } from '../../config/env.schema.js';
import { AuditService } from '../../modules/audit/audit.service.js';
import { type AnonAuditLimiter, clipPath } from '../../modules/auth/anon-audit.limiter.js';
import { CookiesService } from './cookies.service.js';

/**
 * Double-submit CSRF (csrf-csrf): cookie с HMAC-подписанным токеном + тот же токен в заголовке.
 * Токен не привязан к сессии — иначе после входа (появился sid) фронту пришлось бы
 * запрашивать новый. SameSite=Strict на всех cookie — второй рубеж.
 */
@Injectable()
export class CsrfService {
  private readonly utils: DoubleCsrfUtilities;

  constructor(
    config: ConfigService<Env, true>,
    private readonly cookies: CookiesService,
    /** Журнал глобальный; Optional — чтобы сервис поднимался и без него (юнит-тесты). */
    @Optional() private readonly audit?: AuditService,
  ) {
    this.utils = doubleCsrf({
      getSecret: () => config.get('APP_SECRET'),
      getSessionIdentifier: () => '',
      cookieName: cookies.names.csrf,
      cookieOptions: { ...cookies.options(), httpOnly: true },
      ignoredMethods: ['GET', 'HEAD', 'OPTIONS'],
      getCsrfTokenFromRequest: (req) => {
        const h = req.headers[CSRF_HEADER];
        return Array.isArray(h) ? h[0] : h;
      },
    });
  }

  /** Выдаёт токен (и ставит cookie, если её ещё нет). */
  issueToken(req: Request, res: Response): string {
    return this.utils.generateCsrfToken(req, res, { overwrite: false, validateOnReuse: false });
  }

  /**
   * Express-middleware: на ошибке отвечает problem+json 403 (фильтры Nest сюда не достают).
   * limiter — предел записей в Журнал от запросов без входа (подключает setupHttp): такой запрос может
   * прислать кто угодно, и без предела ими заполняется Журнал.
   */
  middleware(limiter?: AnonAuditLimiter): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => {
      this.utils.doubleCsrfProtection(req, res, (err?: unknown) => {
        if (!err) return next();
        const requestId = (req as { id?: string }).id;
        // Middleware живёт до guard-ов и интерсепторов — в Журнал пишем сами (без ожидания).
        void this.recordDenied(req, requestId, limiter).catch(() => undefined);
        res
          .status(403)
          .type('application/problem+json')
          .json({
            type: AUTH_PROBLEM.csrf,
            title: 'Доступ запрещён',
            status: 403,
            detail: `Нет или не совпал CSRF-токен. Запроси GET /api/auth/csrf и передай значение в заголовке ${CSRF_HEADER}.`,
            instance: req.originalUrl,
            ...(requestId ? { requestId } : {}),
          });
      });
    };
  }

  /** Путь в записи обрезается: адрес запроса бывает в тысячи символов, а Журнал не очищается. */
  private async recordDenied(
    req: Request,
    requestId: string | undefined,
    limiter: AnonAuditLimiter | undefined,
  ): Promise<void> {
    const ip = req.ip ?? '';
    const entry = {
      action: 'auth.csrf.denied',
      result: 'denied' as const,
      severity: 'warn' as const,
      ip,
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : '',
      ...(requestId ? { requestId } : {}),
      metadata: { method: req.method, path: clipPath(req.originalUrl) },
    };
    if (limiter) await limiter.record('request', ip, entry);
    else await this.audit?.record(entry);
  }

  /** Для тестов и отладки: имя cookie. */
  get cookieName(): string {
    return this.cookies.names.csrf;
  }
}
