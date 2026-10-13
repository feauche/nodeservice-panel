import {
  type AppearanceSettings,
  type AppearanceSettingsUpdate,
  appearanceSettingsSchema,
  type CustomSites,
  customSitesSchema,
  type MonitoringSettings,
  monitoringSettingsSchema,
} from '@nodeservice/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api';

/** /api/settings — строго по контракту packages/shared/src/settings.ts. */
export const settingsApi = {
  appearance: (signal?: AbortSignal): Promise<AppearanceSettings> =>
    api.get('/settings/appearance', appearanceSettingsSchema, signal),
  updateAppearance: (body: AppearanceSettingsUpdate): Promise<AppearanceSettings> =>
    api.put('/settings/appearance', body, appearanceSettingsSchema),
  customSites: (signal?: AbortSignal): Promise<CustomSites> =>
    api.get('/settings/custom-sites', customSitesSchema, signal),
  updateCustomSites: (body: CustomSites): Promise<CustomSites> =>
    api.put('/settings/custom-sites', body, customSitesSchema),
};

export const customSitesQuery = {
  queryKey: ['settings', 'custom-sites'] as const,
  queryFn: ({ signal }: { signal?: AbortSignal }) => settingsApi.customSites(signal),
  staleTime: 60_000,
};

export function useCustomSites() {
  return useQuery(customSitesQuery);
}

export function useUpdateCustomSites() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: settingsApi.updateCustomSites,
    onSuccess: (data) => qc.setQueryData(customSitesQuery.queryKey, data),
  });
}

/**
 * Последние логотип и название — в этом браузере: при следующем открытии они видны сразу, без мелькания
 * стандартных. Хранилище может быть недоступно (приватный режим) — тогда просто ждём ответа.
 */
const APPEARANCE_CACHE = 'ns-appearance';
function rememberAppearance(data: AppearanceSettings) {
  try {
    localStorage.setItem(APPEARANCE_CACHE, JSON.stringify(data));
  } catch {}
}
function rememberedAppearance(): AppearanceSettings | undefined {
  try {
    const raw = localStorage.getItem(APPEARANCE_CACHE);
    const parsed = raw ? appearanceSettingsSchema.safeParse(JSON.parse(raw)) : null;
    return parsed?.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export const appearanceQuery = {
  queryKey: ['settings', 'appearance'] as const,
  queryFn: async ({ signal }: { signal?: AbortSignal }) => {
    const data = await settingsApi.appearance(signal);
    rememberAppearance(data);
    return data;
  },
  staleTime: 5 * 60_000,
};

/** Открытая настройка — нужна и до входа (логотип на экране входа). */
export function useAppearance() {
  return useQuery({ ...appearanceQuery, placeholderData: rememberedAppearance });
}

export function useUpdateAppearance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: settingsApi.updateAppearance,
    onSuccess: (data) => {
      qc.setQueryData(appearanceQuery.queryKey, data);
      rememberAppearance(data);
    },
  });
}

const monitoringKey = ['settings', 'monitoring'] as const;
export function useMonitoring() {
  return useQuery({
    queryKey: monitoringKey,
    queryFn: ({ signal }) => api.get('/settings/monitoring', monitoringSettingsSchema, signal),
  });
}
export function useUpdateMonitoring() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<MonitoringSettings>) =>
      api.put('/settings/monitoring', body, monitoringSettingsSchema),
    onSuccess: (data) => qc.setQueryData(monitoringKey, data),
  });
}
