import {
  type TelegramSettings,
  type TelegramSettingsUpdate,
  type TelegramTestRequest,
  type TelegramTestResponse,
  telegramSettingsSchema,
  telegramTestResponseSchema,
} from '@nodeservice/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api';
import { WATCHDOG_KEY } from './watchdog-api';

const KEY = ['settings', 'telegram'] as const;

/** «Настройки → Уведомления»: чаты Telegram (токены приходят только маской), события, тихие часы. */
export function useTelegramSettings() {
  return useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => api.get('/settings/telegram', telegramSettingsSchema, signal),
  });
}

export function useUpdateTelegram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TelegramSettingsUpdate): Promise<TelegramSettings> =>
      api.put('/settings/telegram', body, telegramSettingsSchema),
    onSuccess: (s) => {
      qc.setQueryData(KEY, s);
      // Сторож пишет в эти же чаты: после сохранения он мог стать «поставленным по-старому» или стать возможным.
      void qc.invalidateQueries({ queryKey: WATCHDOG_KEY });
    },
  });
}

export function useTestTelegram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TelegramTestRequest): Promise<TelegramTestResponse> =>
      api.post('/settings/telegram/test', body, telegramTestResponseSchema),
    // Тест сохранённого чата обновляет его отметку «доставлено/ошибка» на сервере.
    onSuccess: (_r, body) => {
      if (body.id) void qc.invalidateQueries({ queryKey: KEY });
    },
  });
}
