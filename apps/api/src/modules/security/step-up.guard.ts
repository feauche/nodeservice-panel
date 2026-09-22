import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { STEP_UP_MINUTES } from '@nodeservice/shared';

import { authProblems } from '../auth/auth.problems.js';
import type { AuthenticatedRequest } from '../auth/request-context.js';

/**
 * Step-up: чувствительное действие требует, чтобы пароль вводили не раньше STEP_UP_MINUTES назад
 * (вход или POST /api/auth/unlock ставят session.stepUpAt). Иначе 403 step-up-required —
 * фронт спрашивает пароль и повторяет запрос. Ставится после SessionGuard (глобальный).
 */
@Injectable()
export class StepUpGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const at = req.session?.stepUpAt ? Date.parse(req.session.stepUpAt) : Number.NaN;
    if (!Number.isFinite(at) || Date.now() - at > STEP_UP_MINUTES * 60_000) throw authProblems.stepUp();
    return true;
  }
}
