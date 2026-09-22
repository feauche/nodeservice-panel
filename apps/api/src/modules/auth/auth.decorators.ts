import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';

import type { AuthenticatedRequest } from './request-context.js';

export const IS_PUBLIC_KEY = 'nodeservice:isPublic';

/** Открытый маршрут — SessionGuard пропускает без сессии. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

export type CurrentUserPayload = NonNullable<AuthenticatedRequest['user']>;

/** Текущий пользователь (после SessionGuard). */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CurrentUserPayload => {
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!req.user) throw new Error('CurrentUser без SessionGuard');
    return req.user;
  },
);

/** Текущая сессия (после SessionGuard). */
export const CurrentSession = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!req.session) throw new Error('CurrentSession без SessionGuard');
  return req.session;
});
