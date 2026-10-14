import { useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';

import { lockScreen } from '@/features/auth/queries';
import { useAuthStore } from '@/features/auth/store';
import { configureIdleLimit, idleMs, installActivityTracking } from '@/lib/activity';

const CHECK_EVERY_MS = 15_000;

/**
 * Автоблокировка при бездействии в браузере (политика lockAfterMinutes) — вместе с серверной: сервер
 * блокирует сессию по тому же времени, которое браузер сообщает с каждым запросом. Время последнего действия
 * одно на все вкладки и не сбрасывается перерисовкой; проверка идёт и в фоновой вкладке, а первое движение
 * после долгого отсутствия блокирует экран, а не начинает отсчёт заново.
 */
export function useIdleLock(minutes: number): void {
  const router = useRouter();
  const locked = useAuthStore((s) => s.locked);

  useEffect(() => {
    if (!minutes || minutes <= 0 || locked) {
      configureIdleLimit(0, null);
      return;
    }
    installActivityTracking();
    const limit = minutes * 60_000;
    let fired = false;
    const lockNow = () => {
      if (fired) return;
      fired = true;
      configureIdleLimit(0, null);
      void lockScreen({ reason: 'idle', minutes });
      void router.navigate({ to: '/lock' });
    };
    const check = () => {
      if (idleMs() >= limit) lockNow();
    };
    configureIdleLimit(limit, lockNow);
    check();
    const timer = setInterval(check, CHECK_EVERY_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      configureIdleLimit(0, null);
    };
  }, [minutes, locked, router]);
}
