import {
  BILLING_KIND_LABELS,
  BILLING_KINDS,
  type BillingStatPeriod,
  type BillingSummary,
} from '@nodeservice/shared';

import { Skeleton } from '@/components/ui/skeleton';
import { Segmented } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { useBillingStats } from './billing-api';
import { KIND_COLOR, money, rub } from './billing-format';

const PERIODS: ReadonlyArray<{ key: BillingStatPeriod; label: string }> = [
  { key: 'day', label: 'День' },
  { key: 'week', label: 'Неделя' },
  { key: 'month', label: 'Месяц' },
  { key: 'year', label: 'Год' },
];
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTH_FULL = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
];

/** Подпись периода: «Сегодня», «Эта неделя», «Сентябрь», «2026 год». */
export function periodTitle(p: BillingStatPeriod, now = new Date()): string {
  if (p === 'day') return 'Сегодня';
  if (p === 'week') return 'Эта неделя';
  if (p === 'month') return MONTH_FULL[now.getMonth()] ?? 'Месяц';
  return `${now.getFullYear()} год`;
}

/** «12 000 ₽ · $190 · €48» — сколько в каких валютах. */
export function currencyLine(t: BillingSummary['month']): string {
  return t.byCurrency.map((c) => money(c.amountMinor, c.currency)).join(' · ');
}

/** Статистика (витрина, 6A): столбцы по месяцам года с разбивкой по типам и разбивка периода по провайдерам. */
export function StatsView({
  period,
  onPeriod,
}: {
  period: BillingStatPeriod;
  onPeriod: (p: BillingStatPeriod) => void;
}) {
  const stats = useBillingStats(period);
  const now = new Date();
  const data = stats.data;
  const max = Math.max(
    1,
    ...(data?.months.map((m) => Object.values(m.byKind).reduce((a, b) => a + b, 0)) ?? [1]),
  );
  const provMax = Math.max(1, ...(data?.byProvider.map((p) => p.rubMinor) ?? [1]));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 basis-[260px] text-[12.5px] leading-snug text-text-3">
          В рублях по курсу ЦБ РФ на день каждой оплаты — задним числом не пересчитывается. Периоды
          календарные: неделя с понедельника, месяц с первого числа.
        </p>
        <Segmented label="Период статистики" items={PERIODS} value={period} onChange={onPeriod} />
      </div>
      {stats.isError ? (
        <p
          role="alert"
          className="rounded-[12px] border border-crit/30 bg-crit-soft px-4 py-3 text-[13px] text-crit"
        >
          {apiErrorMessage(stats.error)}
        </p>
      ) : !data ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-[280px] rounded-2xl" />
          <Skeleton className="h-[280px] rounded-2xl" />
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="flex flex-col rounded-2xl border border-border bg-surface px-5 py-4">
            <h3 className="text-[14px] font-semibold">По месяцам, {now.getFullYear()}</h3>
            <div className="mt-3 flex h-[180px] items-end gap-1.5 sm:gap-2.5" data-testid="billing-chart">
              {data.months.map((m) => {
                const sum = Object.values(m.byKind).reduce((a, b) => a + b, 0);
                const current = m.month === now.getMonth() + 1;
                return (
                  <div
                    key={m.month}
                    className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5"
                    title={`${MONTH_FULL[m.month - 1]}: ${rub(sum)}`}
                  >
                    <div
                      className="flex w-full max-w-[34px] flex-col-reverse overflow-hidden rounded-t-[6px] rounded-b-[2px]"
                      style={{ height: `${(sum / max) * 100}%`, minHeight: sum > 0 ? 3 : 0 }}
                    >
                      {BILLING_KINDS.map((k) =>
                        m.byKind[k] ? (
                          <i
                            key={k}
                            className="block"
                            style={{
                              height: `${((m.byKind[k] ?? 0) / sum) * 100}%`,
                              background: KIND_COLOR[k],
                            }}
                          />
                        ) : null,
                      )}
                    </div>
                    <span
                      className={
                        current ? 'text-[11px] font-semibold text-foreground' : 'text-[11px] text-text-3'
                      }
                    >
                      {MONTHS[m.month - 1]}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[11.5px] text-text-2">
              {BILLING_KINDS.map((k) => (
                <span key={k} className="inline-flex items-center gap-1.5">
                  <i className="size-2 rounded-[3px]" style={{ background: KIND_COLOR[k] }} />
                  {BILLING_KIND_LABELS[k]}
                </span>
              ))}
            </div>
          </section>

          <section className="flex flex-col rounded-2xl border border-border bg-surface px-5 py-4">
            <h3 className="text-[14px] font-semibold">
              {periodTitle(period, now)}: {rub(data.total.spentRubMinor)}
            </h3>
            {data.byProvider.length === 0 ? (
              <p className="mt-3 rounded-[10px] border border-dashed border-border-2 px-4 py-8 text-center text-[12.5px] text-text-3">
                За этот период оплат ещё не было.
              </p>
            ) : (
              <ul className="mt-3 flex flex-col gap-2.5" data-testid="billing-by-provider">
                {data.byProvider.map((p) => (
                  <li
                    key={p.providerId ?? 'none'}
                    className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1"
                  >
                    <span className="truncate text-[13px]">{p.name}</span>
                    <span className="text-right text-[13px] font-semibold tabular-nums">
                      {rub(p.rubMinor)}
                    </span>
                    <span className="col-span-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
                      <i
                        className="block h-full rounded-full bg-brand"
                        style={{ width: `${Math.max(2, (p.rubMinor / provMax) * 100)}%` }}
                      />
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-auto pt-4">
              {data.byKind.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {data.byKind.map((k) => (
                    <span
                      key={k.kind}
                      className="inline-flex h-6 items-center gap-1.5 rounded-[6px] bg-surface-2 px-2 text-[11.5px] text-text-2"
                    >
                      <i className="size-2 rounded-[3px]" style={{ background: KIND_COLOR[k.kind] }} />
                      {BILLING_KIND_LABELS[k.kind]}: {rub(k.rubMinor)}
                    </span>
                  ))}
                </div>
              )}
              <p className="mt-2 text-[11.5px] leading-snug text-text-3">
                {data.total.byCurrency.length > 0 ? `В валюте: ${currencyLine(data.total)}. ` : ''}
                Ещё ожидается до конца периода: ≈ {rub(data.total.expectedRubMinor)} по сегодняшнему курсу.
              </p>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
