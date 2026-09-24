import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import type { Request } from 'express';
import { ClsModule } from 'nestjs-cls';
import { LoggerModule } from 'nestjs-pino';
import { ZodValidationPipe } from 'nestjs-zod';

import { CryptoModule } from './common/crypto/crypto.module.js';
import { ProblemDetailsFilter } from './common/filters/problem-details.filter.js';
import { HttpModule } from './common/http/http.module.js';
import { ConfigModule } from './config/config.module.js';
import { DbModule } from './infra/db/db.module.js';
import { ValkeyModule } from './infra/valkey/valkey.module.js';
import { WsModule } from './infra/ws/ws.module.js';
import { AgentModule } from './modules/agent/agent.module.js';
import { AssistantModule } from './modules/assistant/assistant.module.js';
import { CLS_REQUEST, requestInfo } from './modules/audit/audit.context.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { EventsModule } from './modules/events/events.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { HousekeepingModule } from './modules/housekeeping/housekeeping.module.js';
import { IncidentsModule } from './modules/incidents/incidents.module.js';
import { KnowledgeModule } from './modules/knowledge/knowledge.module.js';
import { MaintenanceModule } from './modules/maintenance/maintenance.module.js';
import { MetricsModule } from './modules/metrics/metrics.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { ProvidersModule } from './modules/providers/providers.module.js';
import { SecurityModule } from './modules/security/security.module.js';
import { ServersModule } from './modules/servers/servers.module.js';
import { SettingsModule } from './modules/settings/settings.module.js';
import { TerminalModule } from './modules/terminal/terminal.module.js';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        // requestId сквозной: заголовок от Caddy/клиента или новый uuid
        genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
        // секреты никогда не попадают в логи
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'res.headers["set-cookie"]',
            '*.password',
            '*.totp',
            '*.secret',
            '*.token',
          ],
          censor: '[скрыто]',
        },
        autoLogging: { ignore: (req) => (req.url ?? '').startsWith('/api/health') },
        customProps: () => ({ service: 'api' }),
        ...(process.env.NODE_ENV !== 'production'
          ? {
              transport: {
                target: 'pino-pretty',
                options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' },
              },
            }
          : {}),
      },
    }),
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: (req) => (req as { id?: string }).id ?? randomUUID(),
        // IP/UA/путь запроса — для Журнала (AuditService читает из CLS).
        setup: (cls, req) => cls.set(CLS_REQUEST, requestInfo(req as Request)),
      },
    }),
    ScheduleModule.forRoot(),
    WsModule,
    DbModule,
    ValkeyModule,
    CryptoModule,
    HttpModule,
    HealthModule,
    AuditModule,
    SettingsModule,
    AuthModule,
    SecurityModule,
    ServersModule,
    ProvidersModule,
    AgentModule,
    MetricsModule,
    TerminalModule,
    MaintenanceModule,
    IncidentsModule,
    HousekeepingModule,
    EventsModule,
    NotificationsModule,
    KnowledgeModule,
    AssistantModule,
  ],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
  ],
})
export class AppModule {}
