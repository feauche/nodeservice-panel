import { existsSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { join } from 'node:path';
import { Logger as NestLogger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { SHARED_VERSION } from '@nodeservice/shared';
import { apiReference } from '@scalar/nestjs-api-reference';

// Необработанный reject в фоновой задаче не должен ронять панель целиком — пишем в лог и живём дальше.
process.on('unhandledRejection', (reason) => {
  new NestLogger('process').error(`необработанный reject: ${(reason as Error)?.stack ?? String(reason)}`);
});

import express from 'express';
import { Logger } from 'nestjs-pino';
import { cleanupOpenApiDoc } from 'nestjs-zod';

import { AppModule } from './app.module.js';
import { CookiesService } from './common/http/cookies.service.js';
import { setupHttp } from './common/http/setup-http.js';
import type { Env } from './config/env.schema.js';
import { DB, type Db } from './infra/db/db.module.js';
import { runMigrations } from './infra/db/migrate.js';
import { WsUpgradeService } from './infra/ws/ws-upgrade.service.js';
import { AgentGateway } from './modules/agent/agent.gateway.js';
import { SYSTEM_ACTOR } from './modules/audit/audit.context.js';
import { AuditService } from './modules/audit/audit.service.js';
import { TerminalGateway } from './modules/terminal/terminal.gateway.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const isProd = config.get('NODE_ENV') === 'production';

  setupHttp(app);
  app.enableShutdownHooks();

  // OpenAPI: /api/docs (Scalar) + /api/docs/openapi.json (для Orval на фронте)
  const doc = new DocumentBuilder()
    .setTitle('NodeService API')
    .setVersion(SHARED_VERSION)
    .addCookieAuth(app.get(CookiesService).names.session)
    .build();
  const openapi = cleanupOpenApiDoc(SwaggerModule.createDocument(app, doc));
  const server = app.getHttpAdapter().getInstance() as express.Express;
  // Каноничная JSON-схема (для Orval и скриптов).
  server.get('/api/backend-tools/openapi.json', (_req: express.Request, res: express.Response) => {
    res.json(openapi);
  });
  // Классический Swagger UI — привычен тем, кто работал с ним.
  SwaggerModule.setup('api/backend-tools/swagger', app, openapi, {
    customSiteTitle: 'NodeService API — Swagger',
    swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
  });
  app.use(
    '/api/backend-tools/docs',
    apiReference({ content: openapi, theme: 'purple', layout: 'modern', showDeveloperTools: 'never' }),
  );

  // Продакшен: SPA лежит рядом (dist/public), отдаём статику и fallback на index.html.
  const publicDir = join(process.cwd(), 'public');
  if (isProd && existsSync(publicDir)) {
    app.use(
      express.static(publicDir, {
        index: false,
        maxAge: '1y',
        immutable: true,
        setHeaders: (res, path) => path.endsWith('index.html') && res.setHeader('Cache-Control', 'no-cache'),
      }),
    );
    app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
      res.sendFile(join(publicDir, 'index.html'), { headers: { 'Cache-Control': 'no-cache' } });
    });
  }

  if (config.get('AUTO_MIGRATE')) await runMigrations(app.get<Db>(DB));

  const port = config.get('PORT');
  await app.listen(port, '0.0.0.0');
  // WebSocket на том же HTTP-сервере: агент (/api/agent/v1/ws) и терминал (/ws/terminal).
  app.get(AgentGateway).register();
  app.get(TerminalGateway).register();
  app.get(WsUpgradeService).attach(app.getHttpServer() as HttpServer);
  new NestLogger('Bootstrap').log(`NodeService API слушает :${port} (${config.get('NODE_ENV')})`);
  await app.get(AuditService).record({
    action: 'system.started',
    actor: SYSTEM_ACTOR,
    source: 'auto',
    metadata: {
      version: process.env.npm_package_version ?? '0.1.0',
      node: process.version,
      env: config.get('NODE_ENV'),
    },
  });
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
