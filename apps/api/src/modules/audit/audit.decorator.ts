import { SetMetadata } from '@nestjs/common';
import type { AuditAction, AuditSeverity } from '@nodeservice/shared';

import type { AuditTarget } from './audit.context.js';

export const AUDIT_KEY = 'audit:meta';

export interface AuditMeta {
  action: AuditAction;
  /** Цель по умолчанию; сервис может уточнить через AuditService.extend(). */
  target?: AuditTarget;
  severity?: AuditSeverity;
}

/**
 * Помечает обработчик как аудируемое действие: интерсептор запишет результат (ok/failed/denied),
 * длительность, актора и контекст запроса. Детали (diff, цель) сервис добавляет через
 * `audit.extend({...})` — они попадут в ту же запись.
 */
export const Audit = (action: AuditAction, opts: Omit<AuditMeta, 'action'> = {}) =>
  SetMetadata<string, AuditMeta>(AUDIT_KEY, { action, ...opts });
