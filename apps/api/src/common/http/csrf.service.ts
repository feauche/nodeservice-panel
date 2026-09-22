import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AUTH_PROBLEM, CSRF_HEADER } from '@nodeservice/shared';
import { type DoubleCsrfUtilities, doubleCsrf } from 'csrf-csrf';
import type { NextFunction, Request, Response } from 'express';

import type { Env } from '../../config/env.schema.js';
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

  /** Express-middleware: на ошибке отвечает problem+json 403 (фильтры Nest сюда не достают). */
  middleware(): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => {
      this.utils.doubleCsrfProtection(req, res, (err?: unknown) => {
        if (!err) return next();
        const requestId = (req as { id?: string }).id;
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

  /** Для тестов и отладки: имя cookie. */
  get cookieName(): string {
    return this.cookies.names.csrf;
  }
}
