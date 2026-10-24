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
import { AssistantModule } from './modules/assistant/assistant.module.js';
import { CLS_REQUEST, requestInfo } from './modules/audit/audit.context.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { incomingRequestId } from './modules/auth/request-context.js';
import { BackupsModule } from './modules/backups/backups.module.js';
import { BillingModule } from './modules/billing/billing.module.js';
import { EventsModule } from './modules/events/events.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { HousekeepingModule } from './modules/housekeeping/housekeeping.module.js';
import { IncidentsModule } from './modules/incidents/incidents.module.js';
import { IntegrationsModule } from './modules/integrations/integrations.module.js';
import { KnowledgeModule } from './modules/knowledge/knowledge.module.js';
import { NodeMaintenanceModule } from './modules/maintenance/maintenance.module.js';
import { NodeEventsModule } from './modules/node-events/node-events.module.js';
import { NodeMetricsModule } from './modules/node-metrics/node-metrics.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { ProvidersModule } from './modules/providers/providers.module.js';
import { RemnawaveModule } from './modules/remnawave/remnawave.module.js';
import { ReserveIpsModule } from './modules/reserve-ips/reserve-ips.module.js';
import { ScenariosModule } from './modules/scenarios/scenarios.module.js';
import { SecurityModule } from './modules/security/security.module.js';
import { SettingsModule } from './modules/settings/settings.module.js';

@Module({
  imports: [
    ScenariosModule,
    ReserveIpsModule,
    NodeMaintenanceModule,
    NodeEventsModule,
    NodeMetricsModule,
    ConfigModule,
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        // requestId сквозной: заголовок от Caddy/клиента (только в формате uuid) или новый uuid
        genReqId: (req) => incomingRequestId(req.headers['x-request-id']) ?? randomUUID(),
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
    DbModule,
    ValkeyModule,
    CryptoModule,
    HttpModule,
    HealthModule,
    AuditModule,
    SettingsModule,
    AuthModule,
    SecurityModule,
    ProvidersModule,
    RemnawaveModule,
    IntegrationsModule,
    BillingModule,
    BackupsModule,
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
