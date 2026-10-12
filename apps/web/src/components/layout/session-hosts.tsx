import { useRouterState } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';

import { useAuthStore } from '@/features/auth/store';
import { useStepUpStore } from '@/features/security/step-up';
import { StepUpHost } from '@/features/security/step-up-host';

/**
 * Окно поверх любого раздела: запрос пароля. Смонтировано в корневом маршруте, а не в AppShell: AppShell
 * каждый раздел рисует свой, и переход по меню пересоздавал бы окно. Живёт, пока открыта сессия панели;
 * с выходом из учётной записи снимается. Пока экран заблокирован, запрос пароля убран.
 */
export function SessionHosts() {
  const signedIn = useAuthStore((s) => s.me !== null);
  const locked = useAuthStore((s) => s.locked);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const page = useRef(pathname);
  // Запрос пароля относится к странице, где его вызвали. Хост здесь общий и при переходе не снимается,
  // поэтому уход со страницы («назад» в браузере при открытом запросе) отменяем явно: иначе пароль,
  // введённый уже на другой странице, выполнил бы действие покинутой.
  useEffect(() => {
    if (page.current === pathname) return;
    page.current = pathname;
    useStepUpStore.getState().finish(false);
  }, [pathname]);
  if (!signedIn || locked) return null;
  return <StepUpHost />;
}
