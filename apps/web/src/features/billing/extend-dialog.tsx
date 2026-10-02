import {
  addBillingPeriod,
  BILLING_CURRENCY_SIGN,
  BILLING_KIND_LABELS,
  type BillingExtend,
  type BillingItem,
  billingPeriodLabel,
  type Provider,
} from '@nodeservice/shared';
import { CheckIcon, Loader2Icon, Undo2Icon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { DialogPrimaryButton } from '@/components/dialog-actions';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { plural } from '@/lib/plural';
import { cn } from '@/lib/utils';
import { useExtendBillingItem, useUndoBillingPayment } from './billing-api';
import { BillingIcon } from './billing-card';
import {
  DUE_TEXT,
  dueWords,
  formatDue,
  fromLocalInput,
  money,
  rateDayPhrase,
  rub,
  toLocalInput,
} from './billing-format';

interface LogRow {
  paymentId: string;
  text: string;
  undone: boolean;
}

const LBL = 'mb-1.5 block text-[12px] font-medium text-text-2';
const SMALL_BTN =
  'h-10 w-[112px] flex-none cursor-pointer rounded-[10px] border border-border bg-surface-3 px-3.5 text-[12.5px] font-semibold text-text-2 transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-brand';

const daysLabel = (n: number) => `${n} ${plural(n, 'день', 'дня', 'дней')}`;

/**
 * «Продлить» (витрина, раздел 4): быстрые кнопки продлевают сразу, окно остаётся открытым; после
 * продления галочка «Учесть оплату» снимается — случайный второй клик не запишет оплату дважды.
 * Всё сделанное — в «В этом окне» с кнопкой «Отменить».
 */
export function ExtendDialog({
  item,
  provider,
  open,
  onOpenChange,
  rateDate,
}: {
  item: BillingItem | null;
  provider: Provider | null;
  /** Дата курса ЦБ (по Москве): не сегодняшняя — в подписи «по курсу ЦБ на …», а не «сегодня». */
  rateDate?: string | null | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const extend = useExtendBillingItem();
  const undo = useUndoBillingPayment();
  const [cur, setCur] = useState<BillingItem | null>(item);
  const [count, setCount] = useState(true);
  const [amount, setAmount] = useState('');
  const [days, setDays] = useState('');
  const [until, setUntil] = useState('');
  const [log, setLog] = useState<LogRow[]>([]);
  const running = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: заполняем при открытии окна
  useEffect(() => {
    if (!open || !item) return;
    setCur(item);
    setCount(true);
    setAmount(String(item.amountMinor / 100));
    setDays('');
    setUntil(
      toLocalInput(
        (item.periodUnit === 'once'
          ? new Date(Date.parse(item.paidUntil) + 30 * 86_400_000)
          : addBillingPeriod(
              new Date(item.paidUntil),
              item.periodUnit,
              item.periodCount,
              item.billingTimeZone,
              item.billingDay,
            )
        ).toISOString(),
      ),
    );
    setLog([]);
    running.current = false;
  }, [open, item?.id]);

  if (!cur) return null;
  const busy = extend.isPending || undo.isPending;
  const sign = BILLING_CURRENCY_SIGN[cur.currency];
  const amountNum = Number(amount.replace(',', '.'));
  const amountOk = !count || (amount.trim() !== '' && Number.isFinite(amountNum) && amountNum >= 0);
  const rate =
    cur.currency !== 'RUB' && cur.amountRubTodayMinor !== null && cur.amountMinor > 0
      ? cur.amountRubTodayMinor / cur.amountMinor
      : null;

  // Всегда четыре кнопки: три коротких срока и период карточки (выделен); у разовой — четыре срока.
  const periodDays =
    cur.periodUnit === 'day' ? cur.periodCount : cur.periodUnit === 'week' ? cur.periodCount * 7 : null;
  const quick: Array<{
    key: string;
    label: string;
    body: Pick<BillingExtend, 'period' | 'days'>;
    main: boolean;
  }> = [1, 3, 7, 14, 30]
    .filter((d) => d !== periodDays)
    .slice(0, cur.periodUnit === 'once' ? 4 : 3)
    .map((d) => ({ key: `d${d}`, label: daysLabel(d), body: { days: d }, main: false }));
  if (cur.periodUnit !== 'once')
    quick.push({
      key: 'period',
      label:
        periodDays !== null
          ? daysLabel(periodDays)
          : billingPeriodLabel(cur.periodUnit, cur.periodCount)
              .replace(/^раз в /, 'на ')
              .replace(/^каждые /, 'на '),
      body: { period: true },
      main: true,
    });

  const run = async (body: Pick<BillingExtend, 'period' | 'days' | 'until'>, label: string) => {
    if (running.current) return;
    if (count && !amountOk) {
      toast.error('Укажите сумму оплаты или снимите галочку «Учесть оплату».');
      return;
    }
    running.current = true;
    try {
      const res = await extend.mutateAsync({
        id: cur.id,
        body: { ...body, count, ...(count ? { amount: amountNum } : {}) },
      });
      setCur(res.item);
      setLog((l) => [
        {
          paymentId: res.payment.id,
          text: `${label} → до ${formatDue(res.item.paidUntil)}${
            res.payment.counted
              ? ` · учтено ${money(res.payment.amountMinor, res.payment.currency)}`
              : ' · без суммы'
          }`,
          undone: false,
        },
        ...l,
      ]);
      // Как описано: после продления галочка снимается, сумма недоступна до новой галочки.
      setCount(false);
    } catch (err) {
      toast.error(apiErrorMessage(err));
    } finally {
      running.current = false;
    }
  };

  const doUndo = async (row: LogRow) => {
    try {
      const it = await undo.mutateAsync(row.paymentId);
      setCur(it);
      setLog((l) => l.map((r) => (r.paymentId === row.paymentId ? { ...r, undone: true } : r)));
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };
  // Отменить можно только последнее действующее продление.
  const lastLive = log.find((r) => !r.undone)?.paymentId ?? null;
  const daysNum = Number(days);
  const untilIso = fromLocalInput(until);

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[calc(100vh-48px)] flex-col gap-0 overflow-hidden rounded-2xl border-border-2 bg-surface p-0 sm:max-w-[520px]"
      >
        <DialogHeader className="flex-none flex-row items-center gap-3 border-b border-border px-6 py-4 text-left">
          <BillingIcon item={cur} provider={provider} />
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate font-heading text-[17px]">Продлить «{cur.title}»</DialogTitle>
            <DialogDescription className="truncate text-[12.5px] text-text-3">
              {[
                provider?.name,
                BILLING_KIND_LABELS[cur.kind],
                billingPeriodLabel(cur.periodUnit, cur.periodCount),
                money(cur.amountMinor, cur.currency),
              ]
                .filter(Boolean)
                .join(' · ')}
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 py-5">
          <div className="flex items-center justify-between gap-3 rounded-[12px] bg-surface-2 px-3.5 py-3">
            <span className="text-[12.5px] text-text-3">Оплачено до</span>
            <span className="text-right">
              <b className="block text-[15px] tabular-nums" data-testid="extend-due">
                {formatDue(cur.paidUntil)}
              </b>
              <span className={cn('text-[11.5px] font-medium', DUE_TEXT[cur.dueState])}>
                {dueWords(cur.paidUntil)}
              </span>
            </span>
          </div>

          <div>
            <span className={LBL}>Продлить на</span>
            <div className="grid grid-cols-4 gap-2">
              {quick.map((q) => (
                <button
                  key={q.key}
                  type="button"
                  disabled={busy}
                  onClick={(event) => event.detail <= 1 && void run(q.body, `+${q.label}`)}
                  className={cn(
                    'h-10 min-w-0 cursor-pointer truncate rounded-[10px] border px-2 text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-brand',
                    q.main
                      ? 'border-brand bg-brand-soft text-foreground hover:brightness-110'
                      : 'border-border bg-surface-2 text-foreground hover:border-brand',
                  )}
                >
                  {q.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11.5px] leading-snug text-text-3">
              {cur.periodUnit === 'once'
                ? 'Разовая оплата: продлевается на дни или до даты.'
                : 'Выделенная кнопка — период этой карточки. Нажатие продлевает сразу, окно остаётся открытым.'}
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <div>
              <label htmlFor="ext-days" className={LBL}>
                Или своё число дней
              </label>
              <div className="flex gap-2">
                <Input
                  id="ext-days"
                  inputMode="numeric"
                  placeholder="например, 14"
                  value={days}
                  disabled={busy}
                  onChange={(e) => setDays(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  className="h-10 min-w-0 flex-1 rounded-[10px] bg-surface-2"
                />
                <button
                  type="button"
                  className={SMALL_BTN}
                  disabled={busy || !(daysNum >= 1)}
                  onClick={(event) =>
                    event.detail <= 1 && void run({ days: daysNum }, `+${daysLabel(daysNum)}`)
                  }
                >
                  Продлить
                </button>
              </div>
            </div>
            <div>
              <label htmlFor="ext-until" className={LBL}>
                Или точная дата и время
              </label>
              <div className="flex gap-2">
                <Input
                  id="ext-until"
                  type="datetime-local"
                  value={until}
                  disabled={busy}
                  onChange={(e) => setUntil(e.target.value)}
                  className="h-10 min-w-0 flex-1 rounded-[10px] bg-surface-2 text-[13px]"
                />
                <button
                  type="button"
                  className={SMALL_BTN}
                  disabled={busy || !untilIso}
                  onClick={(event) =>
                    event.detail <= 1 && untilIso && void run({ until: untilIso }, 'Дата установлена')
                  }
                >
                  Установить
                </button>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2.5 rounded-[12px] border border-border px-3.5 py-3">
            <label
              htmlFor="ext-count"
              className="flex cursor-pointer items-center gap-2.5 text-[13px] font-medium"
            >
              <Checkbox id="ext-count" checked={count} onCheckedChange={(v) => setCount(v === true)} />
              Учесть оплату в статистике
            </label>
            <div className="grid grid-cols-[minmax(0,160px)_minmax(0,1fr)] items-center gap-3">
              <div className="relative">
                <Input
                  id="ext-amount"
                  aria-label="Сумма оплаты"
                  inputMode="decimal"
                  value={amount}
                  disabled={!count || busy}
                  onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ''))}
                  aria-invalid={count && !amountOk ? true : undefined}
                  className="h-10 rounded-[10px] bg-surface-2 pr-8 tabular-nums"
                />
                <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[13px] text-text-3">
                  {sign}
                </span>
              </div>
              <span className="text-[12px] leading-snug text-text-3">
                {rate !== null && amountOk && count
                  ? `≈ ${rub(Math.round(amountNum * 100 * rate))} по курсу ЦБ ${rateDayPhrase(rateDate)} (${rate.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽/${sign})`
                  : count
                    ? 'Сумма подставлена из карточки.'
                    : 'Без галочки меняется только дата.'}
              </span>
            </div>
          </div>

          <div>
            <span className={LBL}>В этом окне</span>
            <div className="flex flex-col gap-1.5" data-testid="extend-log">
              {log.length === 0 ? (
                <div className="rounded-[9px] bg-surface-2 px-3 py-2 text-[12.5px] text-text-3">
                  Пока ничего не продлевали.
                </div>
              ) : (
                log.map((r) => (
                  <div
                    key={r.paymentId}
                    className={cn(
                      'flex items-center gap-2 rounded-[9px] bg-surface-2 px-3 py-2 text-[12.5px]',
                      r.undone && 'text-text-3 line-through',
                    )}
                  >
                    <CheckIcon className="size-3.5 flex-none text-ok" aria-hidden="true" />
                    <span className="min-w-0 flex-1">{r.text}</span>
                    {!r.undone && r.paymentId === lastLive && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void doUndo(r)}
                        className="inline-flex flex-none cursor-pointer items-center gap-1 text-[12px] font-medium text-brand hover:underline disabled:opacity-50"
                      >
                        <Undo2Icon className="size-3.5" aria-hidden="true" />
                        Отменить
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-none items-center gap-3 border-t border-border bg-bg-2 px-6 py-3.5">
          <p className="min-w-0 flex-1 text-[12px] leading-snug text-text-3">
            Всё записывается в Журнал и историю оплат.
          </p>
          <DialogPrimaryButton
            disabled={busy}
            onClick={() => onOpenChange(false)}
            className="h-10 w-[128px] flex-none rounded-[10px] sm:max-w-none"
          >
            {busy && <Loader2Icon className="animate-spin" aria-hidden="true" />}
            Готово
          </DialogPrimaryButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}
