import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, Link, Outlet, useRouter } from '@tanstack/react-router';
import { Loader2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useSessionWatch } from '@/features/auth/queries';
import { ErrorScreen } from '@/features/errors/error-screen';
import { useTheme } from '@/features/theme/use-theme';

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  pendingComponent: PendingScreen,
  notFoundComponent: NotFound,
  errorComponent: RootError,
});

function RootLayout() {
  const theme = useTheme();
  useSessionWatch(useRouter());
  return (
    <TooltipProvider delayDuration={250}>
      <Outlet />
      <Toaster position="bottom-right" richColors theme={theme === 'light' ? 'light' : 'dark'} />
    </TooltipProvider>
  );
}

/** Глобальное ожидание: пока грузится статус сессии. */
export function PendingScreen() {
  return (
    <output aria-live="polite" className="grid h-full place-items-center bg-background text-text-3">
      <div className="flex items-center gap-2.5 text-[13px]">
        <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
        Загружаю…
      </div>
    </output>
  );
}

function NotFound() {
  return (
    <main className="grid h-full place-items-center bg-background p-6">
      <div className="max-w-[420px] text-center">
        <div className="font-heading text-[56px] leading-none font-bold tracking-[-0.03em] text-text-3">
          404
        </div>
        <h1 className="mt-3 text-xl">Такой страницы нет</h1>
        <p className="mt-1.5 text-[13px] text-text-2">
          Возможно, адрес набран с ошибкой или раздел ещё не готов.
        </p>
        <Link
          to="/"
          className="mt-5 inline-flex rounded-[10px] bg-cta px-4 py-2.5 text-[13px] font-semibold text-cta-foreground hover:bg-(--ns-cta-hover)"
        >
          На обзор
        </Link>
      </div>
    </main>
  );
}

/**
 * CancelledError — не поломка, а отменённый запрос TanStack Query: при быстрой навигации
 * или (в dev) при двойном прогоне эффектов StrictMode. Считаем такие отмены за короткое окно
 * и тихо перезапускаем рендер (через таймаут — чтобы разорвать синхронный цикл), а экран ошибки
 * показываем, только если отмены идут лавиной (значит, дело не в безобидной отмене).
 */
const cancelledResetsAt: number[] = [];
function tolerateCancelled(): boolean {
  const now = Date.now();
  while (cancelledResetsAt.length > 0 && now - (cancelledResetsAt[0] ?? 0) > 4000) cancelledResetsAt.shift();
  cancelledResetsAt.push(now);
  // Запас с большим гистерезисом: в StrictMode эффекты (в т.ч. этого обработчика) прогоняются дважды,
  // поэтому реальная отмена засчитывается 2–4 раза; экран показываем только при настоящей лавине.
  return cancelledResetsAt.length <= 12;
}

/** Необработанная ошибка маршрута: объяснение причины + отчёт (features/errors). */
function RootError({ error, reset }: { error: Error; reset: () => void }) {
  const cancelled = error.name === 'CancelledError';
  const [givenUp, setGivenUp] = useState(false);
  useEffect(() => {
    if (!cancelled || givenUp) return;
    if (!tolerateCancelled()) {
      setGivenUp(true);
      return;
    }
    const id = setTimeout(reset, 50);
    return () => clearTimeout(id);
  }, [cancelled, givenUp, reset]);
  if (cancelled && !givenUp) return <PendingScreen />;
  return <ErrorScreen error={error} reset={reset} />;
}
