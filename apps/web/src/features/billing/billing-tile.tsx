import { Link } from '@tanstack/react-router';
import { WalletIcon } from 'lucide-react';

import { isSectionOpen } from '@/lib/stages';
import { cn } from '@/lib/utils';
import { useBillingSummary } from './billing-api';
import { dueWords, money, rub } from './billing-format';

const MONTH_IN = [
  'январе',
  'феврале',
  'марте',
  'апреле',
  'мае',
  'июне',
  'июле',
  'августе',
  'сентябре',
  'октябре',
  'ноябре',
  'декабре',
];

/** Плитка биллинга в «Обзоре»: просрочки или ближайшая оплата и расходы месяца. Оплат нет — плитки нет. */
export function BillingTile() {
  const open = isSectionOpen('/servers/billing');
  const summary = useBillingSummary(open);
  const s = summary.data;
  if (!open || !s || (!s.next && s.month.spentRubMinor === 0)) return null;
  const alarm = s.overdue > 0;
  const title = alarm
    ? s.overdue === 1 && s.next
      ? `Просрочена оплата «${s.next.title}» — ${money(s.next.amountMinor, s.next.currency)}`
      : `Биллинг: просрочено оплат — ${s.overdue}`
    : s.next
      ? `Ближайшая оплата: «${s.next.title}» ${dueWords(s.next.paidUntil)}`
      : 'Биллинг: ближайших оплат нет';
  return (
    <Link
      to="/servers/billing"
      data-testid="billing-tile"
      className={cn(
        'flex items-center gap-3 rounded-2xl border bg-surface px-4 py-3.5 transition-colors',
        alarm ? 'border-crit/40 hover:border-crit/60' : 'border-border hover:border-border-2',
      )}
    >
      <span
        className={cn(
          'grid size-9 flex-none place-items-center rounded-full',
          alarm ? 'bg-crit-soft text-crit' : 'bg-brand-soft text-brand',
        )}
      >
        <WalletIcon className="size-4.5" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <div className={cn('truncate text-[13.5px] font-semibold', alarm && 'text-crit')}>{title}</div>
        <div className="truncate text-[12px] text-text-3">
          В {MONTH_IN[new Date().getMonth()]} оплачено {rub(s.month.spentRubMinor)} · ещё ≈{' '}
          {rub(s.month.expectedRubMinor)}
        </div>
      </div>
    </Link>
  );
}
