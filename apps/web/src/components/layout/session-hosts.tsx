import { useRouterState } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';

import { useAuthStore } from '@/features/auth/store';
import { useStepUpStore } from '@/features/security/step-up';
import { StepUpHost } from '@/features/security/step-up-host';
import { ServerModalHost } from '@/features/servers/server-modal-host';
import { TerminalHost } from '@/features/terminal/terminal-host';

/**
 * Окна поверх любого раздела: запрос пароля, веб-терминал и окно сервера. Смонтированы в корневом
 * маршруте, а не в AppShell: AppShell каждый раздел рисует свой, и переход по меню размонтировал бы
 * их — терминал закрывал сокет и обрывал SSH-сессию на середине команды, окно сервера молча теряло
 * несохранённые правки. Здесь они живут, пока открыта сессия панели; с выходом из учётной записи
 * они снимаются (сокет терминала закрывается).
 *
 * Экран блокировки: терминал прячется, но не закрывается — сессия и терминалы живут, как обещает
 * политика «Блокировать экран при бездействии». Окно сервера и запрос пароля на это время убираются.
 * Спрятать окно — не защита: ввод в терминал, пока экран заблокирован, отбрасывает сервер (шлюз терминала).
 */
export function SessionHosts() {
  const signedIn = useAuthStore((s) => s.me !== null);
  const locked = useAuthStore((s) => s.locked);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const page = useRef(pathname);
  // Запрос пароля относится к странице, где его вызвали. Хост здесь общий и при переходе не снимается,
  // поэтому уход со страницы («назад» в браузере при открытом запросе) отменяем явно: иначе пароль,
  // введённый уже на другой странице, выполнил бы действие покинутой — например, удаление сервера.
  useEffect(() => {
    if (page.current === pathname) return;
    page.current = pathname;
    useStepUpStore.getState().finish(false);
  }, [pathname]);
  if (!signedIn) return null;
  return (
    <>
      {!locked && <StepUpHost />}
      <TerminalHost hidden={locked} />
      {!locked && <ServerModalHost />}
    </>
  );
}
