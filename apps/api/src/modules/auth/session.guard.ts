import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ACTIVITY_HEADER } from '@nodeservice/shared';
import { ClsService } from 'nestjs-cls';

import { CookiesService } from '../../common/http/cookies.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AnonAuditLimiter, clipPath } from './anon-audit.limiter.js';
import { IS_PUBLIC_KEY } from './auth.decorators.js';
import { authProblems } from './auth.problems.js';
import { CLS_SESSION, CLS_USER } from './cls-keys.js';
import type { AuthenticatedRequest } from './request-context.js';
import { SecurityPolicyStore } from './security-policy.store.js';
import { SessionStore } from './session.store.js';
import { UsersRepository } from './users.repository.js';

export { CLS_SESSION, CLS_USER };

/** Потоки событий открываются сами и живут часами — действием человека их не считаем. */
const STREAM_PATH = /^\/api\/(events|audit)\/stream$/;
/** Больше недели бездействия не бывает: сессия столько не живёт. */
const MAX_IDLE_SECONDS = 7 * 24 * 3600;

/**
 * Когда человек последний раз что-то делал в панели — со слов браузера (ACTIVITY_HEADER, секунды бездействия).
 * undefined — заголовка нет (запрос не из панели или вкладка старой версии): считается действием сейчас;
 * null — поток событий, картинка (значки своих сайтов браузер грузит сам) или непонятное значение:
 * действием не считается.
 */
export function activityFrom(
  req: { path: string; headers: Record<string, string | string[] | undefined> },
  now = Date.now(),
): number | null | undefined {
  if (STREAM_PATH.test(req.path) || req.headers['sec-fetch-dest'] === 'image') return null;
  const raw = req.headers[ACTIVITY_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === '') return undefined;
  const idle = Number(value);
  if (!Number.isFinite(idle) || idle < 0) return null;
  return now - Math.min(idle, MAX_IDLE_SECONDS) * 1000;
}

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
    private readonly limiter: AnonAuditLimiter,
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
   * Запрос без входа может прислать кто угодно — записи идут через предел в минуту, путь обрезается.
   */
  private async denied(req: AuthenticatedRequest, reason: 'unauthenticated' | 'locked'): Promise<void> {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    await this.limiter.record('request', req.ip ?? '', {
      action: 'auth.request.denied',
      result: 'denied',
      severity: 'warn',
      ...(req.user ? { actor: { type: 'admin', id: req.user.id, display: req.user.login } } : {}),
      metadata: { reason, method: req.method, path: clipPath(req.path) },
    });
  }

  /** Пытается привязать сессию к запросу; true — есть валидная сессия. */
  async attach(req: AuthenticatedRequest): Promise<boolean> {
    const sid = this.cookies.read(req, 'session');
    if (!sid) return false;
    const lockAfterMinutes = (await this.policy.get()).lockAfterMinutes;
    const session = await this.sessions.touch(sid, lockAfterMinutes * 60_000, activityFrom(req));
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
