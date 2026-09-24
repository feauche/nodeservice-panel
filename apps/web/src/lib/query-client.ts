import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: 1,
      /**
       * Пока вкладка в фоне, опрос остановлен (экономим запросы). Поэтому при возврате в окно
       * перечитываем всё устаревшее — иначе после работы в SSH видны цифры минутной давности.
       * staleTime 10 с не даёт спамить при быстрых переключениях.
       */
      refetchOnWindowFocus: true,
    },
  },
});
