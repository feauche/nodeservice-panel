import type { BillingForecast } from '@nodeservice/shared';
import { RepeatIcon } from 'lucide-react';

import { Skeleton } from '@/components/ui/skeleton';
import { apiErrorMessage } from '@/lib/api';
import { plural } from '@/lib/plural';
import { cn } from '@/lib/utils';
import { useBillingForecast } from './billing-api';
import { dueWords, money, rub } from './billing-format';

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const DAY = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
const day = (iso: string) => DAY.format(new Date(iso)).replace('.', '');
const payments = (n: number) => `${n} ${plural(n, 'оплата', 'оплаты', 'оплат')}`;

function Kpi({ label, value, sub, testId }: { label: string; value: string; sub: string; testId: string }) {
  return (
    <div
      className="flex min-w-0 flex-col rounded-[14px] border border-border bg-surface px-4 py-3"
      data-testid={testId}
    >
      <span className="truncate text-[11.5px] text-text-3">{label}</span>
      <b className="mt-0.5 mb-2 font-heading text-[21px] leading-tight font-bold tracking-[-0.02em] tabular-nums">
        {value}
      </b>
      <span className="mt-auto border-t border-dashed border-border pt-2 text-[11.5px] text-text-2">
        {sub}
      </span>
    </div>
  );
}

function Weeks({ weeks, onOpen }: { weeks: BillingForecast['weeks']; onOpen: (itemId: string) => void }) {
  return (
    <section className="flex flex-col rounded-2xl border border-border bg-surface px-5 py-4">
      <h3 className="flex items-baseline justify-between text-[14px] font-semibold">
        Ближайшие оплаты <span className="text-[12px] font-normal text-text-3">по неделям</span>
      </h3>
      <div className="mt-3 flex flex-col" data-testid="forecast-weeks">
        {weeks.map((w, i) => (
          <div key={w.from} className={cn('py-2.5', i > 0 && 'border-t border-border')}>
            <div className="mb-1.5 flex items-baseline justify-between text-[12px] text-text-3">
              <span>
                {i === 0 ? 'Эта неделя · ' : ''}
                {day(w.from)} – {day(new Date(Date.parse(w.to) - 1).toISOString())}
              </span>
              <b className="text-[13px] text-foreground tabular-nums">
                {w.items.length === 0 ? 'нет оплат' : `≈ ${rub(w.rubMinor)}`}
              </b>
            </div>
            {w.items.map((it) => (
              <button
                key={`${it.itemId}:${it.date}`}
                type="button"
                onClick={() => onOpen(it.itemId)}
                className="grid w-full cursor-pointer grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[8px] px-1 py-1 text-left text-[12.5px] transition-colors hover:bg-surface-2"
              >
                <span className={cn('tabular-nums', it.overdue ? 'font-medium text-crit' : 'text-text-3')}>
                  {it.overdue ? 'сейчас' : day(it.date)}
                </span>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate">
                    {it.title}
                    {it.provider ? <span className="text-text-3"> · {it.provider}</span> : null}
                  </span>
                  {it.auto && (
                    <span className="inline-flex flex-none items-center gap-1 rounded-[6px] bg-ok-soft px-1.5 text-[10.5px] text-ok">
                      <RepeatIcon className="size-2.5" aria-hidden="true" />
                      сама
                    </span>
                  )}
                </span>
                <span className="text-right font-semibold tabular-nums">
                  {money(it.amountMinor, it.currency)}
                  {it.currency !== 'RUB' && it.rubMinor !== null && (
                    <small className="block text-[11px] font-normal text-text-3">≈ {rub(it.rubMinor)}</small>
                  )}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function Months({ months }: { months: BillingForecast['months'] }) {
  const values = months.map((m) => m.paidRubMinor + m.forecastRubMinor);
  const max = Math.max(1, ...values);
  return (
    <section className="flex flex-col rounded-2xl border border-border bg-surface px-5 py-4">
      <h3 className="flex items-baseline justify-between text-[14px] font-semibold">
        По месяцам <span className="text-[12px] font-normal text-text-3">оплачено и прогноз</span>
      </h3>
      <div className="mt-3 flex h-[200px] items-end gap-2.5" data-testid="forecast-months">
        {months.map((m, i) => {
          const total = values[i] ?? 0;
          const current = i === 3;
          return (
            <div
              key={`${m.year}-${m.month}`}
              className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5"
              title={`${MONTHS[m.month - 1]} ${m.year}: оплачено ${rub(m.paidRubMinor)}${m.forecastRubMinor ? `, ещё ≈ ${rub(m.forecastRubMinor)}` : ''}`}
            >
              <span className="text-[10.5px] text-text-2 tabular-nums">
                {total > 0
                  ? `${(total / 100_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} тыс.`
                  : '—'}
              </span>
              <div
                className="flex w-full max-w-[40px] flex-col-reverse overflow-hidden rounded-t-[7px] rounded-b-[3px]"
                style={{ height: `${(total / max) * 150}px`, minHeight: total > 0 ? 3 : 0 }}
              >
                {m.paidRubMinor > 0 && (
                  <i className="block bg-brand" style={{ height: `${(m.paidRubMinor / total) * 100}%` }} />
                )}
                {m.forecastRubMinor > 0 && (
                  <i
                    className="block border border-dashed border-brand"
                    style={{
                      height: `${(m.forecastRubMinor / total) * 100}%`,
                      background:
                        'repeating-linear-gradient(135deg, color-mix(in srgb, var(--color-brand) 55%, transparent) 0 6px, color-mix(in srgb, var(--color-brand) 22%, transparent) 6px 12px)',
                    }}
                  />
                )}
              </div>
              <span className={cn('text-[11px]', current ? 'font-semibold text-foreground' : 'text-text-3')}>
                {MONTHS[m.month - 1]}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[11.5px] text-text-2">
        <span className="inline-flex items-center gap-1.5">
          <i className="size-2.5 rounded-[3px] bg-brand" />
          Оплачено по курсу дня оплаты
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i className="size-2.5 rounded-[3px] border border-dashed border-brand bg-brand-soft" />
          Прогноз по сегодняшнему курсу
        </span>
      </div>
    </section>
  );
}

/**
 * Прогноз оплат (витрина `billing-forecast-variants.html`, A): четыре итога вперёд, ближайшие оплаты по неделям
 * и месяцы — прошлые оплачены, будущие штрихом. Для $ и € — по сегодняшнему курсу ЦБ, поэтому «≈».
 */
export function ForecastView({ onOpenItem }: { onOpenItem: (itemId: string) => void }) {
  const q = useBillingForecast();
  if (q.isError)
    return (
      <p
        role="alert"
        className="rounded-[12px] border border-crit/30 bg-crit-soft px-4 py-3 text-[13px] text-crit"
      >
        {apiErrorMessage(q.error)}
      </p>
    );
  const f = q.data;
  if (!f)
    return (
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[98px] rounded-[14px]" />
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-[300px] rounded-2xl" />
          <Skeleton className="h-[300px] rounded-2xl" />
        </div>
      </div>
    );
  const avg = f.restOfYear.months > 0 ? Math.round(f.restOfYear.rubMinor / f.restOfYear.months) : 0;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          testId="forecast-7"
          label="Следующие 7 дней"
          value={`≈ ${rub(f.next7.rubMinor)}`}
          sub={
            f.next7.count === 0
              ? 'оплат нет'
              : `${payments(f.next7.count)}${f.first ? ` · ближайшая «${f.first.title}» ${f.first.overdue ? 'просрочена' : dueWords(f.first.date)}` : ''}`
          }
        />
        <Kpi
          testId="forecast-30"
          label="Следующие 30 дней"
          value={`≈ ${rub(f.next30.rubMinor)}`}
          sub={`${payments(f.next30.count)}${f.next30.auto ? ` · из них сами спишутся ${f.next30.auto}` : ''}`}
        />
        <Kpi
          testId="forecast-year"
          label="До конца года"
          value={`≈ ${rub(f.restOfYear.rubMinor)}`}
          sub={`в среднем ≈ ${rub(avg)} в месяц`}
        />
        <Kpi
          testId="forecast-per-year"
          label="В год при нынешних оплатах"
          value={`≈ ${rub(f.perYearRubMinor)}`}
          sub="если ничего не добавлять и не убирать"
        />
      </div>
      {f.rateMissing && (
        <p className="m-0 text-[12px] text-warn">
          Курса ЦБ сейчас нет — суммы в $ и € в рубли не пересчитаны, итоги неполные.
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Weeks weeks={f.weeks} onOpen={onOpenItem} />
        <Months months={f.months} />
      </div>
    </div>
  );
}
