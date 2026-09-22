import {
  type AppearanceSettings,
  type AppearanceSettingsUpdate,
  type AutochecksSettings,
  type AutochecksSettingsUpdate,
  appearanceSettingsSchema,
  autochecksSettingsSchema,
} from '@nodeservice/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api';

/** /api/settings — строго по контракту packages/shared/src/settings.ts. */
export const settingsApi = {
  appearance: (signal?: AbortSignal): Promise<AppearanceSettings> =>
    api.get('/settings/appearance', appearanceSettingsSchema, signal),
  updateAppearance: (body: AppearanceSettingsUpdate): Promise<AppearanceSettings> =>
    api.put('/settings/appearance', body, appearanceSettingsSchema),
  autochecks: (signal?: AbortSignal): Promise<AutochecksSettings> =>
    api.get('/settings/autochecks', autochecksSettingsSchema, signal),
  updateAutochecks: (body: AutochecksSettingsUpdate): Promise<AutochecksSettings> =>
    api.put('/settings/autochecks', body, autochecksSettingsSchema),
};

export const autochecksQuery = {
  queryKey: ['settings', 'autochecks'] as const,
  queryFn: ({ signal }: { signal?: AbortSignal }) => settingsApi.autochecks(signal),
  staleTime: 30_000,
};

export function useAutochecks() {
  return useQuery(autochecksQuery);
}

export function useUpdateAutochecks() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: settingsApi.updateAutochecks,
    onSuccess: (data) => {
      qc.setQueryData(autochecksQuery.queryKey, data);
    },
  });
}

export const appearanceQuery = {
  queryKey: ['settings', 'appearance'] as const,
  queryFn: ({ signal }: { signal?: AbortSignal }) => settingsApi.appearance(signal),
  staleTime: 5 * 60_000,
};

/** Открытая настройка — нужна и до входа (логотип на экране входа). */
export function useAppearance() {
  return useQuery(appearanceQuery);
}

export function useUpdateAppearance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: settingsApi.updateAppearance,
    onSuccess: (data) => {
      qc.setQueryData(appearanceQuery.queryKey, data);
    },
  });
}
