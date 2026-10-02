import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';

import type { Env } from '../../config/env.schema.js';
import { AnonAuditLimiter } from '../../modules/auth/anon-audit.limiter.js';
import { CsrfService } from './csrf.service.js';

/**
 * Общая HTTP-обвязка (main.ts и e2e-тесты): trust proxy, helmet, cookie, CSRF, префикс /api.
 * Порядок важен: cookie-parser до CSRF, CSRF до роутов Nest.
 */
export function setupHttp(app: NestExpressApplication): void {
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  app.set('trust proxy', config.get('TRUST_PROXY'));
  app.disable('x-powered-by');
  app.use(
    helmet({
      // CSP для SPA настраивается на этапе 11 (hash для inline-скрипта темы); пока — без CSP.
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(cookieParser());
  // Все мутирующие запросы к API — только с CSRF-токеном (GET/HEAD/OPTIONS пропускаются).
  // Отказы пишутся в Журнал через общий предел записей от запросов без входа.
  const csrf = app.get(CsrfService).middleware(app.get(AnonAuditLimiter, { strict: false }));
  // /api/agent/* — API для агентов, не браузеров: cookie-сессий нет, аутентификация токеном
  // и подписью ed25519, CSRF неприменим. /api/internal/* — служебные запросы изнутри контейнера api
  // (nodeservice update): только с 127.0.0.1 и с подписью из APP_SECRET, браузер их не делает.
  app.use((req: Request, res: Response, next: NextFunction) =>
    shouldApplyCsrf(req.path) ? csrf(req, res, next) : next(),
  );
  app.setGlobalPrefix('api');
}

/** Express сопоставляет маршруты без учёта регистра; защита обязана делать так же. */
export function shouldApplyCsrf(path: string): boolean {
  const p = path.toLowerCase();
  return p.startsWith('/api/') && !p.startsWith('/api/agent/') && !p.startsWith('/api/internal/');
}
