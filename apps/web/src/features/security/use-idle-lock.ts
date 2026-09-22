import { useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';

import { useLockScreen } from '@/features/auth/queries';
import { useAuthStore } from '@/features/auth/store';

const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'wheel'] as const;
const CHECK_EVERY_MS = 15_000;

/**
 * Автоблокировка при бездействии в браузере (политика lockAfterMinutes) — дублирует серверную:
 * сервер блокирует сессию по паузе между запросами, клиент — по отсутствию мыши/клавиатуры.
 * Сессия и терминалы живут; серверный idle-таймаут (idleMinutes) — отдельно.
 */
export function useIdleLock(minutes: number): void {
  const navigate = useNavigate();
  const lock = useLockScreen();
  const locked = useAuthStore((s) => s.locked);

  useEffect(() => {
    if (!minutes || minutes <= 0 || locked) return;
    let last = Date.now();
    const touch = () => {
      last = Date.now();
    };
    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, touch, { passive: true });
    const timer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      if (Date.now() - last >= minutes * 60_000) {
        void lock();
        void navigate({ to: '/lock' });
      }
    }, CHECK_EVERY_MS);
    return () => {
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, touch);
      clearInterval(timer);
    };
  }, [minutes, locked, lock, navigate]);
}
