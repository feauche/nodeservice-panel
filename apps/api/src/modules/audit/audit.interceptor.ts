import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { defer, from, type Observable, throwError } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';

import { AUDIT_KEY, type AuditMeta } from './audit.decorator.js';
import { AuditService } from './audit.service.js';

/**
 * Глобальный интерсептор для @Audit(): одна запись на вызов обработчика.
 * Успех → result ok; исключение → failed (или denied для 401/403), затем исключение летит дальше.
 * Запись ждём до ответа клиенту — Журнал не отстаёт от действий.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.getAllAndOverride<AuditMeta | undefined>(AUDIT_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!meta) return next.handle();

    const started = performance.now();
    return next.handle().pipe(
      mergeMap((value) => defer(() => from(this.write(meta, 'ok', started))).pipe(mergeMap(() => [value]))),
      catchError((err: unknown) => {
        const status = err instanceof HttpException ? err.getStatus() : 500;
        const result = status === 401 || status === 403 ? 'denied' : 'failed';
        const metadata: Record<string, unknown> = { status };
        if (err instanceof HttpException) {
          const body = err.getResponse();
          if (body && typeof body === 'object' && 'type' in body && typeof body.type === 'string')
            metadata.error = body.type;
        }
        return from(this.write(meta, result, started, metadata)).pipe(mergeMap(() => throwError(() => err)));
      }),
    );
  }

  private write(
    meta: AuditMeta,
    result: 'ok' | 'failed' | 'denied',
    started: number,
    metadata: Record<string, unknown> = {},
  ): Promise<unknown> {
    const extra = this.audit.takeExtra();
    const target = extra.target ?? meta.target;
    return this.audit.record({
      action: meta.action,
      result,
      severity: result === 'ok' ? (meta.severity ?? 'info') : 'warn',
      ...(target ? { target } : {}),
      changes: extra.changes ?? null,
      durationMs: performance.now() - started,
      metadata: { ...(extra.metadata ?? {}), ...metadata },
    });
  }
}
