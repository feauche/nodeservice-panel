import type { AuditChanges } from '@nodeservice/shared';
import type { Request } from 'express';

/** Ключи CLS, которые читает Журнал. Кладутся middleware ClsModule (app.module) и SessionGuard. */
export const CLS_REQUEST = 'req';
export const CLS_AUDIT_EXTRA = 'audit.extra';

export interface ClsRequestInfo {
  ip: string;
  ua: string;
  method: string;
  path: string;
}

export function requestInfo(req: Request): ClsRequestInfo {
  const ua = req.headers['user-agent'];
  return {
    ip: req.ip ?? req.socket?.remoteAddress ?? '',
    ua: typeof ua === 'string' ? ua : '',
    method: req.method,
    path: req.originalUrl ?? req.url,
  };
}

export interface AuditActor {
  type: 'admin' | 'system' | 'anonymous';
  id?: string | null;
  display: string;
}

export interface AuditTarget {
  type: string;
  id?: string | null;
  display?: string | null;
}

/** То, что сервис может добавить к записи, которую сделает интерсептор (@Audit). */
export interface AuditExtra {
  target?: AuditTarget;
  changes?: AuditChanges | null;
  metadata?: Record<string, unknown>;
}

export const SYSTEM_ACTOR: AuditActor = { type: 'system', id: null, display: 'NodeService' };
