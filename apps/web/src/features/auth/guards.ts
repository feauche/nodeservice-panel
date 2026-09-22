import type { QueryClient } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';

import { hydrateAuth } from './queries';
import { useAuthStore } from './store';

export interface GuardContext {
  queryClient: QueryClient;
}

/**
 * Хелперы для beforeLoad. Все начинают с hydrateAuth — статус берётся из кэша,
 * так что лишних запросов при переходах между маршрутами нет.
 */

/** Только авторизованный: иначе /setup → /login → /lock. */
export async function requireAuth(ctx: GuardContext): Promise<void> {
  const { status } = await hydrateAuth(ctx.queryClient);
  if (status.setupRequired) throw redirect({ to: '/setup' });
  if (!status.authenticated) throw redirect({ to: '/login' });
  if (useAuthStore.getState().locked) throw redirect({ to: '/lock' });
}

/** Только гость (страницы входа): при сессии — в панель (или на /lock). */
export async function requireGuest(ctx: GuardContext): Promise<void> {
  const { status } = await hydrateAuth(ctx.queryClient);
  if (status.setupRequired) throw redirect({ to: '/setup' });
  if (status.authenticated) throw redirect({ to: useAuthStore.getState().locked ? '/lock' : '/' });
}

/** Шаг 2FA/восстановления: гость, у которого пароль уже принят. */
export async function requirePendingTotp(ctx: GuardContext): Promise<void> {
  await requireGuest(ctx);
  if (!useAuthStore.getState().pendingTotp) throw redirect({ to: '/login' });
}

/** Мастер первого запуска — только пока администратора нет. */
export async function requireSetup(ctx: GuardContext): Promise<void> {
  const { status } = await hydrateAuth(ctx.queryClient);
  if (!status.setupRequired) throw redirect({ to: status.authenticated ? '/' : '/login' });
}

/** Экран блокировки: сессия есть и экран действительно заблокирован. */
export async function requireLocked(ctx: GuardContext): Promise<void> {
  const { status } = await hydrateAuth(ctx.queryClient);
  if (status.setupRequired) throw redirect({ to: '/setup' });
  if (!status.authenticated) throw redirect({ to: '/login' });
  if (!useAuthStore.getState().locked) throw redirect({ to: '/' });
}
