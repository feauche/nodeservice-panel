import type { BillingItem, BillingPayment } from '@nodeservice/shared';
import { Loader2Icon, PencilIcon, Undo2Icon } from 'lucide-react';
import { useState } from 'react';

import { DialogPrimaryButton } from '@/components/dialog-actions';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { useBillingPayments, useUndoBillingPayment, useUpdateBillingPayment } from './billing-api';
import { formatDue, formatShortDate, fromLocalInput, money, toLocalInput } from './billing-format';

/** История оплат одной карточки: когда, сколько, по какому курсу; последнюю можно отменить, любую — поправить. */
export function HistoryDialog({
  item,
  open,
  onOpenChange,
}: {
  item: BillingItem | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const payments = useBillingPayments(open && item ? item.id : null);
  const undo = useUndoBillingPayment();
  const [editing, setEditing] = useState<string | null>(null);
  if (!item) return null;
  const rows = payments.data?.items ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[calc(100vh-48px)] flex-col gap-0 overflow-hidden rounded-2xl border-border-2 bg-surface p-0 sm:max-w-[560px]"
      >
        <DialogHeader className="flex-none gap-1 border-b border-border px-6 py-4 text-left">
          <DialogTitle className="truncate font-heading text-[17px]">
            История оплат «{item.title}»
          </DialogTitle>
          <DialogDescription className="text-[12.5px] text-text-3">
            Рубли — по курсу ЦБ на день оплаты, потом не пересчитываются. Отменить можно последнее продление.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto px-6 py-5" data-testid="billing-history">
          {payments.isPending ? (
            <>
              <Skeleton className="h-14 rounded-[10px]" />
              <Skeleton className="h-14 rounded-[10px]" />
            </>
          ) : rows.length === 0 ? (
            <p className="rounded-[10px] border border-dashed border-border-2 px-4 py-6 text-center text-[12.5px] text-text-3">
              Продлений пока не было. Они появятся после «Продлить».
            </p>
          ) : (
            rows.map((p) =>
              editing === p.id ? (
                <EditRow key={p.id} payment={p} onDone={() => setEditing(null)} />
              ) : (
                <div
                  key={p.id}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-[10px] bg-surface-2 px-3.5 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium">
                      {formatShortDate(p.paidAt)} · до {formatDue(p.extendedTo)}
                    </div>
                    <div className="truncate text-[11.5px] text-text-3">
                      {p.counted
                        ? `${money(p.amountMinor, p.currency)}${
                            p.currency !== 'RUB'
                              ? p.rate > 0
                                ? ` = ${money(p.amountRubMinor, 'RUB')} по ${p.rate.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`
                                : ' · курс ЦБ досчитается позже'
                              : ''
                          }`
                        : 'Только дата, без суммы'}
                      {p.actor ? ` · ${p.actor}` : ''}
                    </div>
                  </div>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      aria-label="Поправить дату или сумму"
                      title="Поправить дату или сумму"
                      onClick={() => setEditing(p.id)}
                      className="grid size-8 cursor-pointer place-items-center rounded-[8px] text-text-3 transition-colors hover:bg-surface-3 hover:text-foreground"
                    >
                      <PencilIcon className="size-3.5" aria-hidden="true" />
                    </button>
                    {p.undoable && (
                      <button
                        type="button"
                        disabled={undo.isPending}
                        onClick={async () => {
                          try {
                            await undo.mutateAsync(p.id);
                            toast.success('Продление отменено, дата вернулась.');
                          } catch (err) {
                            toast.error(apiErrorMessage(err));
                          }
                        }}
                        className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-[8px] px-2 text-[12px] font-medium text-brand hover:bg-surface-3 disabled:opacity-50"
                      >
                        <Undo2Icon className="size-3.5" aria-hidden="true" />
                        Отменить
                      </button>
                    )}
                  </div>
                </div>
              ),
            )
          )}
        </div>
        <div className="flex flex-none justify-end border-t border-border bg-bg-2 px-6 py-3.5">
          <DialogPrimaryButton
            onClick={() => onOpenChange(false)}
            className="h-10 w-[128px] flex-none rounded-[10px] sm:max-w-none"
          >
            Закрыть
          </DialogPrimaryButton>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EditRow({ payment, onDone }: { payment: BillingPayment; onDone: () => void }) {
  const update = useUpdateBillingPayment();
  const [at, setAt] = useState(toLocalInput(payment.paidAt));
  const [amount, setAmount] = useState(String(payment.amountMinor / 100));
  const save = async () => {
    const iso = fromLocalInput(at);
    const n = Number(amount.replace(',', '.'));
    if (!iso || !Number.isFinite(n) || n < 0) {
      toast.error('Проверьте дату и сумму.');
      return;
    }
    try {
      await update.mutateAsync({ id: payment.id, body: { paidAt: iso, amount: n } });
      toast.success('Запись оплаты поправлена, курс взят на новую дату.');
      onDone();
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };
  return (
    <div className="grid gap-2 rounded-[10px] border border-brand bg-surface-2 px-3.5 py-3 sm:grid-cols-[minmax(0,1fr)_120px_auto]">
      <Input
        type="datetime-local"
        aria-label="Дата оплаты"
        value={at}
        onChange={(e) => setAt(e.target.value)}
        className="h-9 rounded-[9px] bg-surface text-[13px]"
      />
      <Input
        aria-label="Сумма"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value.replace(/[^\d.,]/g, ''))}
        className="h-9 rounded-[9px] bg-surface tabular-nums"
      />
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={onDone}
          className="h-9 cursor-pointer rounded-[9px] border border-border px-3 text-[12.5px] text-text-2 hover:text-foreground"
        >
          Отмена
        </button>
        <button
          type="button"
          disabled={update.isPending}
          onClick={() => void save()}
          className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[9px] bg-cta px-3 text-[12.5px] font-semibold text-cta-foreground disabled:opacity-50"
        >
          {update.isPending && <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />}
          Сохранить
        </button>
      </div>
    </div>
  );
}
