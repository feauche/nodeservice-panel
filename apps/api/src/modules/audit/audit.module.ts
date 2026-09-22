import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditController } from './audit.controller.js';
import { AuditEvents } from './audit.events.js';
import { AuditInterceptor } from './audit.interceptor.js';
import { AuditRepository } from './audit.repository.js';
import { AuditService } from './audit.service.js';
import { AuditPartitionsService } from './audit-partitions.service.js';

/**
 * Ядро Журнала без HTTP: запись, чтение, партиции. Глобальный — AuditService нужен
 * любому модулю (auth, settings, позже серверы) и rescue-CLI.
 */
@Global()
@Module({
  providers: [AuditEvents, AuditRepository, AuditPartitionsService, AuditService],
  exports: [AuditEvents, AuditRepository, AuditPartitionsService, AuditService],
})
export class AuditCoreModule {}

/** HTTP-обвязка Журнала: страница, SSE, экспорт и глобальный интерсептор @Audit(). */
@Module({
  imports: [AuditCoreModule],
  controllers: [AuditController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
})
export class AuditModule {}
