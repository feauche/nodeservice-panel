import {
  AUDIT_CATEGORIES,
  AUDIT_RESULTS,
  AUDIT_SOURCES,
  type AuditEntry,
  type AuditFilter,
  type AuditListQueryInput,
} from '@nodeservice/shared';
import { z } from 'zod';

/** Параметры страницы Журнала в URL — ссылку с фильтрами можно сохранить и переслать. */
export const AUDIT_PERIODS = ['today', '7d', '30d', 'all'] as const;
export type AuditPeriod = (typeof AUDIT_PERIODS)[number];

export const AUDIT_PERIOD_LABELS: Record<AuditPeriod, string> = {
  today: 'Сегодня',
  '7d': '7 дней',
  '30d': '30 дней',
  all: 'Всё время',
};

export const auditSearchSchema = z.object({
  page: z.number().int().min(1).optional().catch(undefined),
  q: z.string().trim().max(200).optional().catch(undefined),
  category: z.array(z.enum(AUDIT_CATEGORIES)).min(1).optional().catch(undefined),
  result: z.array(z.enum(AUDIT_RESULTS)).min(1).optional().catch(undefined),
  source: z.enum(AUDIT_SOURCES).optional().catch(undefined),
  period: z.enum(AUDIT_PERIODS).optional().catch(undefined),
  /** Только события одного сервера (id) — так из окна сервера открывается «его» Журнал. */
  target: z.uuid().optional().catch(undefined),
  /** Live-лента включена по умолчанию; в URL попадает только выключение (live=false). */
  live: z.boolean().optional().catch(undefined),
});
export type AuditSearch = z.infer<typeof auditSearchSchema>;

export function periodFrom(period: AuditPeriod | undefined, now = new Date()): string | undefined {
  switch (period) {
    case 'today': {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      return d.toISOString();
    }
    case '7d':
      return new Date(now.getTime() - 7 * 86_400_000).toISOString();
    case '30d':
      return new Date(now.getTime() - 30 * 86_400_000).toISOString();
    default:
      return undefined;
  }
}

/** URL-параметры → фильтр API (без пустых полей — exactOptionalPropertyTypes). */
export function toFilter(search: AuditSearch, now = new Date()): AuditFilter {
  const filter: AuditFilter = {};
  if (search.q) filter.q = search.q;
  if (search.category) filter.category = search.category;
  if (search.result) filter.result = search.result;
  if (search.source) filter.source = search.source;
  if (search.target) filter.targetId = search.target;
  const from = periodFrom(search.period, now);
  if (from) filter.from = from;
  return filter;
}

export function toListQuery(search: AuditSearch, pageSize: number, now = new Date()): AuditListQueryInput {
  return { ...toFilter(search, now), page: search.page ?? 1, pageSize };
}

/** Есть ли активные фильтры (для кнопки «Сбросить» и live-вставки). */
export function hasFilters(search: AuditSearch): boolean {
  return Boolean(
    search.q ||
      search.category ||
      search.result ||
      search.source ||
      search.target ||
      (search.period && search.period !== 'all'),
  );
}

/** Подходит ли live-запись под текущие фильтры (поиск проверяем грубо — подстрокой). */
export function matchesSearch(entry: AuditEntry, search: AuditSearch): boolean {
  if (search.category && !search.category.includes(entry.category)) return false;
  if (search.result && !search.result.includes(entry.result)) return false;
  if (search.source && entry.source !== search.source) return false;
  if (search.target && entry.targetId !== search.target) return false;
  if (search.q) {
    const q = search.q.toLowerCase();
    const hay = [
      entry.action,
      entry.actorDisplay,
      entry.targetDisplay ?? '',
      entry.ip ?? '',
      String(entry.metadata.login ?? ''),
    ]
      .join(' ')
      .toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}
