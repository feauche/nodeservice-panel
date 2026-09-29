import {
  type BillingExtend,
  type BillingItem,
  type BillingItemUpsert,
  type BillingPayment,
  type BillingStatPeriod,
  billingExtendResponseSchema,
  billingForecastSchema,
  billingItemSchema,
  billingItemsResponseSchema,
  billingPaymentSchema,
  billingPaymentsResponseSchema,
  billingStatsSchema,
  billingSummarySchema,
} from '@nodeservice/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, request } from '@/lib/api';

/** Часовой пояс браузера: «сегодня», «неделя», «месяц» считаются по календарю владельца. */
export const browserTz = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow';
  } catch {
    return 'Europe/Moscow';
  }
};

/** /api/billing — по контракту packages/shared/src/billing.ts. */
export const billingApi = {
  list: (archived: boolean, signal?: AbortSignal) =>
    api.get(`/billing/items${archived ? '?archived=1' : ''}`, billingItemsResponseSchema, signal),
  create: (body: BillingItemUpsert): Promise<BillingItem> =>
    api.post('/billing/items', body, billingItemSchema),
  update: (id: string, body: BillingItemUpsert): Promise<BillingItem> =>
    request(`/billing/items/${id}`, { method: 'PUT', body, schema: billingItemSchema }),
  remove: (id: string): Promise<void> => request(`/billing/items/${id}`, { method: 'DELETE' }),
  archive: (id: string, archived: boolean): Promise<BillingItem> =>
    api.post(`/billing/items/${id}/archive`, { archived }, billingItemSchema),
  extend: (id: string, body: BillingExtend) =>
    api.post(`/billing/items/${id}/extend`, body, billingExtendResponseSchema),
  payments: (id: string, signal?: AbortSignal) =>
    api.get(`/billing/items/${id}/payments`, billingPaymentsResponseSchema, signal),
  updatePayment: (id: string, body: { paidAt?: string; amount?: number }): Promise<BillingPayment> =>
    request(`/billing/payments/${id}`, { method: 'PATCH', body, schema: billingPaymentSchema }),
  undo: (id: string): Promise<BillingItem> =>
    request(`/billing/payments/${id}`, { method: 'DELETE', schema: billingItemSchema }),
  summary: (signal?: AbortSignal) =>
    api.get(`/billing/summary?tz=${encodeURIComponent(browserTz())}`, billingSummarySchema, signal),
  forecast: (signal?: AbortSignal) =>
    api.get(`/billing/forecast?tz=${encodeURIComponent(browserTz())}`, billingForecastSchema, signal),
  stats: (period: BillingStatPeriod, signal?: AbortSignal) =>
    api.get(
      `/billing/stats?period=${period}&tz=${encodeURIComponent(browserTz())}`,
      billingStatsSchema,
      signal,
    ),
};

export const billingKeys = {
  all: ['billing'] as const,
  list: (archived: boolean) => ['billing', 'items', archived] as const,
  payments: (id: string) => ['billing', 'payments', id] as const,
  summary: ['billing', 'summary'] as const,
  forecast: ['billing', 'forecast'] as const,
  stats: (period: BillingStatPeriod) => ['billing', 'stats', period] as const,
};

export function useBillingItems(archived = false) {
  return useQuery({
    queryKey: billingKeys.list(archived),
    queryFn: ({ signal }) => billingApi.list(archived, signal),
    staleTime: 15_000,
    // Сроки «через 2 часа» и «просрочено» меняются сами — раз в минуту пересчитываем.
    refetchInterval: 60_000,
  });
}

export function useBillingSummary(enabled = true) {
  return useQuery({
    queryKey: billingKeys.summary,
    queryFn: ({ signal }) => billingApi.summary(signal),
    staleTime: 30_000,
    refetchInterval: 60_000,
    enabled,
  });
}

export function useBillingForecast() {
  return useQuery({
    queryKey: billingKeys.forecast,
    queryFn: ({ signal }) => billingApi.forecast(signal),
    staleTime: 30_000,
  });
}

export function useBillingStats(period: BillingStatPeriod, enabled = true) {
  return useQuery({
    queryKey: billingKeys.stats(period),
    queryFn: ({ signal }) => billingApi.stats(period, signal),
    staleTime: 30_000,
    enabled,
  });
}

export function useBillingPayments(id: string | null) {
  return useQuery({
    queryKey: billingKeys.payments(id ?? ''),
    queryFn: ({ signal }) => billingApi.payments(id ?? '', signal),
    enabled: id !== null,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: billingKeys.all });
}

export function useSaveBillingItem() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, body }: { id: string | null; body: BillingItemUpsert }) =>
      id ? billingApi.update(id, body) : billingApi.create(body),
    onSuccess: inv,
  });
}

export function useDeleteBillingItem() {
  const inv = useInvalidate();
  return useMutation({ mutationFn: billingApi.remove, onSuccess: inv });
}

export function useArchiveBillingItem() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) => billingApi.archive(id, archived),
    onSuccess: inv,
  });
}

export function useExtendBillingItem() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: BillingExtend }) => billingApi.extend(id, body),
    onSuccess: inv,
  });
}

export function useUndoBillingPayment() {
  const inv = useInvalidate();
  return useMutation({ mutationFn: billingApi.undo, onSuccess: inv });
}

export function useUpdateBillingPayment() {
  const inv = useInvalidate();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: { paidAt?: string; amount?: number } }) =>
      billingApi.updatePayment(id, body),
    onSuccess: inv,
  });
}
