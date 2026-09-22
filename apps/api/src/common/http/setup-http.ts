import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';

import type { Env } from '../../config/env.schema.js';
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
  const csrf = app.get(CsrfService).middleware();
  // /api/agent/* — API для агентов, не браузеров: cookie-сессий нет, аутентификация токеном
  // и подписью ed25519, CSRF неприменим.
  app.use((req: Request, res: Response, next: NextFunction) =>
    req.path.startsWith('/api/') && !req.path.startsWith('/api/agent/') ? csrf(req, res, next) : next(),
  );
  app.setGlobalPrefix('api');
}
