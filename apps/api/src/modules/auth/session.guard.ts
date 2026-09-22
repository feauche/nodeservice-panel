import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsService } from 'nestjs-cls';

import { CookiesService } from '../../common/http/cookies.service.js';
import { AuditService } from '../audit/audit.service.js';
import { IS_PUBLIC_KEY } from './auth.decorators.js';
import { authProblems } from './auth.problems.js';
import { CLS_SESSION, CLS_USER } from './cls-keys.js';
import type { AuthenticatedRequest } from './request-context.js';
import { SecurityPolicyStore } from './security-policy.store.js';
import { SessionStore } from './session.store.js';
import { UsersRepository } from './users.repository.js';

export { CLS_SESSION, CLS_USER };

/**
 * Глобальный guard: cookie сессии → Valkey (с продлением) → пользователь из БД.
 * @Public() выключает проверку, но если сессия есть — всё равно кладёт её в запрос
 * (нужно для GET /status).
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly cookies: CookiesService,
    private readonly sessions: SessionStore,
    private readonly users: UsersRepository,
    private readonly cls: ClsService,
    private readonly policy: SecurityPolicyStore,
    private readonly audit: AuditService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const attached = await this.attach(req);
    if (isPublic) return true;
    if (!attached) {
      await this.denied(req, 'unauthenticated');
      throw authProblems.unauthenticated();
    }
    // Заблокированная сессия: разрешён только /api/auth/* (status, me, unlock, logout) — остальное ждёт пароля.
    if (req.session?.lockedAt && !req.path.startsWith('/api/auth/')) {
      await this.denied(req, 'locked');
      throw authProblems.locked();
    }
    return true;
  }

  /**
   * Guard срабатывает раньше интерсептора @Audit, поэтому отказ пишем отсюда. Только для
   * изменяющих запросов: GET-опросы протухшей вкладки (/auth/me и т.п.) Журналу не нужны.
   */
  private async denied(req: AuthenticatedRequest, reason: 'unauthenticated' | 'locked'): Promise<void> {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    await this.audit.record({
      action: 'auth.request.denied',
      result: 'denied',
      severity: 'warn',
      ...(req.user ? { actor: { type: 'admin', id: req.user.id, display: req.user.login } } : {}),
      metadata: { reason, method: req.method, path: req.path },
    });
  }

  /** Пытается привязать сессию к запросу; true — есть валидная сессия. */
  async attach(req: AuthenticatedRequest): Promise<boolean> {
    const sid = this.cookies.read(req, 'session');
    if (!sid) return false;
    const lockAfterMinutes = (await this.policy.get()).lockAfterMinutes;
    const session = await this.sessions.touch(sid, lockAfterMinutes * 60_000);
    if (!session) return false;
    const user = await this.users.findById(session.userId);
    if (!user) {
      await this.sessions.destroy(sid);
      return false;
    }
    req.session = session;
    req.user = { id: user.id, login: user.login, createdAt: user.createdAt };
    if (session.autoLocked) {
      // Не блокирует запрос: Журнал сам переживёт ошибку записи.
      await this.audit.record({
        action: 'auth.lock',
        source: 'auto',
        actor: { type: 'admin', id: user.id, display: user.login },
        metadata: { reason: 'idle', lockAfterMinutes },
      });
    }
    if (this.cls.isActive()) {
      this.cls.set(CLS_USER, req.user);
      this.cls.set(CLS_SESSION, session);
    }
    return true;
  }
}
