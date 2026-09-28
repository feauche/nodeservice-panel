import { Link } from '@tanstack/react-router';

import { Pill } from '@/features/settings/settings-ui';
import { isSectionOpen } from '@/lib/stages';
import { cn } from '@/lib/utils';
import { useBillingSummary } from './billing-api';
import { DUE_TEXT, dueWords, formatDue, money } from './billing-format';

/** Ближайшая оплата сервера (тип «Сервер» или «Аренда») из итогов биллинга. */
export function useServerBilling(serverId: string) {
  const summary = useBillingSummary(isSectionOpen('/servers/billing'));
  return summary.data?.byServer.find((b) => b.serverId === serverId) ?? null;
}

/**
 * Метка на карточке сервера: только когда до оплаты меньше срока напоминания или она просрочена —
 * в остальное время карточка не меняется.
 */
export function ServerBillingPill({ serverId }: { serverId: string }) {
  const b = useServerBilling(serverId);
  if (!b || (b.dueState !== 'overdue' && b.dueState !== 'today' && b.dueState !== 'soon')) return null;
  const overdue = b.dueState === 'overdue';
  return (
    <Pill
      tone={overdue || b.dueState === 'today' ? 'crit' : 'warn'}
      title={`«${b.title}»: оплачено до ${formatDue(b.paidUntil)}. Продлить — «Серверы» → «Биллинг».`}
    >
      {overdue ? 'Оплата просрочена' : `Оплата ${dueWords(b.paidUntil)}`} · {money(b.amountMinor, b.currency)}
    </Pill>
  );
}

/** Строка «Оплата» в окне сервера: до какого числа и сколько осталось, ссылка в биллинг. */
export function ServerBillingFact({ serverId }: { serverId: string }) {
  const b = useServerBilling(serverId);
  if (!b) return null;
  return (
    <Link
      to="/servers/billing"
      search={{ item: b.itemId }}
      className="block whitespace-normal hover:underline"
      title={`«${b.title}» · ${money(b.amountMinor, b.currency)} — открыть в биллинге`}
    >
      до {formatDue(b.paidUntil)}
      <span className={cn('block text-[12px] font-normal', DUE_TEXT[b.dueState])}>
        {dueWords(b.paidUntil)} · {money(b.amountMinor, b.currency)}
      </span>
    </Link>
  );
}
