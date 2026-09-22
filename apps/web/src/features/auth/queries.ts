import type { AuthStatus, Me } from '@nodeservice/shared';
import { type QueryClient, queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { isApiError, resetCsrfToken, setLockedHandler, setUnauthenticatedHandler } from '@/lib/api';
import { authApi } from './api';
import { useAuthStore } from './store';

export const authKeys = {
  all: ['auth'] as const,
  status: () => ['auth', 'status'] as const,
  me: () => ['auth', 'me'] as const,
};

export const authStatusQuery = queryOptions({
  queryKey: authKeys.status(),
  queryFn: ({ signal }) => authApi.status(signal),
  staleTime: 5_000,
  retry: 1,
});

export const meQuery = queryOptions({
  queryKey: authKeys.me(),
  queryFn: ({ signal }) => authApi.me(signal),
  staleTime: 60_000,
  retry: (count, err) => !(isApiError(err) && err.status === 401) && count < 1,
});

/**
 * Загрузить статус (и /me, если сессия есть) и положить в стор.
 * Вызывается из beforeLoad корневого маршрута — один раз на навигацию,
 * дальше отдаётся из кэша TanStack Query.
 */
export async function hydrateAuth(
  qc: QueryClient,
  opts: { force?: boolean } = {},
): Promise<{ status: AuthStatus; me: Me | null }> {
  if (opts.force) await qc.invalidateQueries({ queryKey: authKeys.all });
  // revalidateIfStale: протухший кэш отдаётся сразу, но в фоне перечитывается — иначе staleTime не работает.
  const status = await qc.ensureQueryData({ ...authStatusQuery, revalidateIfStale: true });
  let me: Me | null = null;
  if (status.authenticated) {
    try {
      me = await qc.ensureQueryData({ ...meQuery, revalidateIfStale: true });
    } catch (e) {
      // 401 при живом status.authenticated — гонка с истёкшей сессией; считаем, что сессии нет.
      if (!(isApiError(e) && e.status === 401)) throw e;
      qc.setQueryData(authKeys.status(), { ...status, authenticated: false });
      useAuthStore.getState().hydrate({ setupRequired: status.setupRequired, authenticated: false });
      return { status: { ...status, authenticated: false }, me: null };
    }
  }
  useAuthStore.getState().hydrate({
    setupRequired: status.setupRequired,
    authenticated: status.authenticated,
    me,
    locked: status.authenticated ? status.locked || Boolean(me?.locked) : false,
  });
  return { status, me };
}

/** Сессия появилась/обновилась: кладём me в кэш и стор, статус помечаем authenticated. */
export function applySession(qc: QueryClient, me: Me, recoveryCodesLeft?: number): void {
  qc.setQueryData(authKeys.me(), me);
  qc.setQueryData<AuthStatus>(authKeys.status(), {
    setupRequired: false,
    authenticated: true,
    locked: false,
  });
  const st = useAuthStore.getState();
  st.setSetupRequired(false);
  st.setMe(me);
  if (typeof recoveryCodesLeft === 'number') st.setRecoveryCodesLeft(recoveryCodesLeft);
  st.setPendingTotp(false);
}

/** Локально забыть сессию: стор, CSRF, кэш статуса/me. */
export function dropSession(qc: QueryClient): void {
  useAuthStore.getState().signedOut();
  resetCsrfToken();
  qc.setQueryData<AuthStatus>(authKeys.status(), {
    setupRequired: false,
    authenticated: false,
    locked: false,
  });
  qc.removeQueries({ queryKey: authKeys.me() });
}

export interface SessionExpiryRouter {
  navigate(opts: { to: '/login' | '/lock' }): Promise<unknown>;
}

/**
 * Центральная реакция на 401 unauthenticated вне auth-потока (истёкшая сессия):
 * локально выходим, чистим кэш и уводим на /login. Ставится один раз в main.tsx.
 */
export function installSessionExpiry(qc: QueryClient, router: SessionExpiryRouter): () => void {
  setUnauthenticatedHandler(() => {
    if (useAuthStore.getState().me === null) return;
    dropSession(qc);
    void qc.invalidateQueries({ queryKey: authKeys.status() });
    void router.navigate({ to: '/login' });
  });
  // Сервер заблокировал экран (бездействие или другая вкладка) — показываем блокировку.
  setLockedHandler(() => {
    const st = useAuthStore.getState();
    if (st.me === null || st.locked) return;
    st.lock();
    void router.navigate({ to: '/lock' });
  });
  return () => {
    setUnauthenticatedHandler(null);
    setLockedHandler(null);
  };
}

export const SESSION_WATCH_INTERVAL_MS = 60_000;

/**
 * Пока есть сессия — перечитывать /auth/status при фокусе окна и раз в минуту,
 * чтобы истёкшая сессия обнаружилась без действий пользователя.
 */
export function useSessionWatch(router: SessionExpiryRouter): void {
  const qc = useQueryClient();
  const authenticated = useAuthStore((s) => s.me !== null);
  const { data } = useQuery({
    ...authStatusQuery,
    enabled: authenticated,
    refetchInterval: SESSION_WATCH_INTERVAL_MS,
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: false,
  });
  const expired = authenticated && data !== undefined && !data.authenticated;
  const lockedOnServer = authenticated && data !== undefined && data.authenticated && data.locked;
  useEffect(() => {
    if (!expired) return;
    dropSession(qc);
    void router.navigate({ to: '/login' });
  }, [expired, qc, router]);
  useEffect(() => {
    if (!lockedOnServer || useAuthStore.getState().locked) return;
    useAuthStore.getState().lock();
    void router.navigate({ to: '/lock' });
  }, [lockedOnServer, router]);
}

export function useAuthStatus() {
  return useQuery(authStatusQuery);
}

export function useMe() {
  return useQuery(meQuery);
}

export function useSetupStart() {
  return useMutation({ mutationFn: authApi.setupStart });
}

export function useSetupConfirm() {
  return useMutation({ mutationFn: authApi.setupConfirm });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: authApi.login,
    onSuccess: (res) => {
      if (res.next === 'done') applySession(qc, res.me);
      else useAuthStore.getState().setPendingTotp(true);
    },
  });
}

export function useLoginTotp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: authApi.loginTotp,
    onSuccess: (res) => applySession(qc, res.me),
  });
}

export function useLoginRecovery() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: authApi.loginRecovery,
    onSuccess: (res) => applySession(qc, res.me, res.recoveryCodesLeft),
  });
}

export function useUnlock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: authApi.unlock,
    onSuccess: (res) => {
      applySession(qc, res.me);
      useAuthStore.getState().unlock(res.me);
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: authApi.logout,
    onSettled: async () => {
      // Даже если сервер ответил ошибкой — локально сессии больше нет.
      dropSession(qc);
      await qc.invalidateQueries({ queryKey: authKeys.status() });
    },
  });
}

/** Заблокировать экран: на сервере (остальные вкладки и запросы тоже упрутся в пароль) и локально. */
export function useLockScreen() {
  return async () => {
    useAuthStore.getState().lock();
    try {
      await authApi.lock();
    } catch {
      /* сеть/сессия — локальная блокировка всё равно стоит */
    }
  };
}
