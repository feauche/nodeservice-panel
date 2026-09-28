import {
  BILLING_KIND_LABELS,
  BILLING_KINDS,
  type BillingItem,
  type BillingKind,
  type BillingStatPeriod,
  type BillingTotal,
} from '@nodeservice/shared';
import { PlusIcon, SearchIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useProviders } from '@/features/providers/providers-api';
import { useServers } from '@/features/servers/servers-api';
import { Segmented } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { plural } from '@/lib/plural';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';
import {
  useArchiveBillingItem,
  useBillingItems,
  useBillingSummary,
  useDeleteBillingItem,
} from './billing-api';
import { BillingCard } from './billing-card';
import { rub } from './billing-format';
import { ExtendDialog } from './extend-dialog';
import { HistoryDialog } from './history-dialog';
import { ItemDialog } from './item-dialog';
import { currencyLine, StatsView } from './stats-view';

export type BillingView = 'items' | 'stats' | 'archive';

const DAY_FMT = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
const SHORT_FMT = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });
const MONTH_FMT = new Intl.DateTimeFormat('ru-RU', { month: 'long' });

function StatCard({
  label,
  total,
  expectedLabel,
  testId,
}: {
  label: string;
  total: BillingTotal | undefined;
  expectedLabel: string;
  testId: string;
}) {
  return (
    <div
      className="flex min-w-0 flex-col rounded-[14px] border border-border bg-surface px-4 py-3"
      data-testid={testId}
    >
      <span className="truncate text-[11.5px] text-text-3">{label}</span>
      {total ? (
        <>
          <b className="mt-0.5 font-heading text-[21px] leading-tight font-bold tracking-[-0.02em] tabular-nums">
            {rub(total.spentRubMinor)}
          </b>
          <span className="mb-2 truncate text-[11.5px] text-text-3">
            {total.payments === 0
              ? 'оплат не было'
              : currencyLine(total) ||
                `${total.payments} ${plural(total.payments, 'оплата', 'оплаты', 'оплат')}`}
          </span>
          <span className="mt-auto border-t border-dashed border-border pt-2 text-[11.5px] text-text-2">
            {expectedLabel}: <b className="tabular-nums">≈ {rub(total.expectedRubMinor)}</b>
          </span>
        </>
      ) : (
        <Skeleton className="mt-1 h-[58px] rounded-[8px]" />
      )}
    </div>
  );
}

/**
 * «Биллинг» (витрина `billing-variants.html`, 2A): итоги за день, неделю, месяц и год, ниже — карточки по
 * ближайшему сроку. Вкладки: оплаты, статистика (6A), архив.
 */
export function BillingPage({
  view,
  onView,
  focusItem,
  onFocusDone,
}: {
  view: BillingView;
  onView: (v: BillingView) => void;
  /** Из уведомления «Открыть биллинг»: сразу открыть «Продлить» у этой оплаты. */
  focusItem?: string | undefined;
  onFocusDone?: () => void;
}) {
  const archived = view === 'archive';
  const items = useBillingItems(archived);
  const activeCount = useBillingItems(false).data?.items.length;
  const archiveCount = useBillingItems(true).data?.items.length;
  const summary = useBillingSummary();
  const providers = useProviders();
  const servers = useServers();
  const archive = useArchiveBillingItem();
  const remove = useDeleteBillingItem();
  const now = useNow(true, 60_000);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<BillingKind | 'all'>('all');
  const [period, setPeriod] = useState<BillingStatPeriod>('month');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<BillingItem | null>(null);
  const [extending, setExtending] = useState<BillingItem | null>(null);
  const [history, setHistory] = useState<BillingItem | null>(null);
  const [deleting, setDeleting] = useState<BillingItem | null>(null);

  const list = items.data?.items ?? [];
  const provList = providers.data?.items ?? [];
  const srvList = useMemo(
    () => (servers.data?.items ?? []).map((s) => ({ id: s.id, name: s.name })),
    [servers.data],
  );
  const providerOf = (id: string | null) => provList.find((p) => p.id === id) ?? null;

  useEffect(() => {
    if (!focusItem || !items.data) return;
    const it = items.data.items.find((i) => i.id === focusItem);
    if (it) setExtending(it);
    onFocusDone?.();
  }, [focusItem, items.data, onFocusDone]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: list.length };
    for (const i of list) c[i.kind] = (c[i.kind] ?? 0) + 1;
    return c;
  }, [list]);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return list.filter((i) => {
      if (kind !== 'all' && i.kind !== kind) return false;
      if (!needle) return true;
      const prov = provList.find((p) => p.id === i.providerId)?.name ?? '';
      const srv = i.serverIds.map((id) => srvList.find((s) => s.id === id)?.name ?? '').join(' ');
      return `${i.title} ${prov} ${srv} ${i.domain ?? ''} ${i.note ?? ''}`.toLowerCase().includes(needle);
    });
  }, [list, q, kind, provList, srvList]);

  const doArchive = async (i: BillingItem) => {
    try {
      await archive.mutateAsync({ id: i.id, archived: i.archivedAt === null });
      toast.success(i.archivedAt === null ? `«${i.title}» в архиве.` : `«${i.title}» снова в оплатах.`);
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };
  const doDelete = async () => {
    if (!deleting) return;
    try {
      await remove.mutateAsync(deleting.id);
      toast.success(`Оплата «${deleting.title}» удалена.`);
    } catch (err) {
      toast.error(apiErrorMessage(err));
    } finally {
      setDeleting(null);
    }
  };

  const today = new Date(now);
  const s = summary.data;
  const monday = s ? new Date(s.week.from) : null;
  const sunday = s ? new Date(Date.parse(s.week.to) - 1) : null;
  const kindItems = [
    { key: 'all' as const, label: `Все ${counts.all ?? 0}` },
    ...BILLING_KINDS.filter((k) => counts[k]).map((k) => ({
      key: k,
      label: `${BILLING_KIND_LABELS[k]} ${counts[k]}`,
    })),
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Раздел биллинга"
          value={view}
          onChange={onView}
          items={[
            { key: 'items', label: `Оплаты${activeCount !== undefined ? ` ${activeCount}` : ''}` },
            { key: 'stats', label: 'Статистика' },
            { key: 'archive', label: `Архив${archiveCount ? ` ${archiveCount}` : ''}` },
          ]}
        />
        <span className="flex-1" />
        {s?.rates.USD && (
          <span className="text-[11.5px] text-text-3 max-sm:hidden" title="Курс ЦБ РФ сегодня">
            ЦБ: $ {s.rates.USD.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽ · €{' '}
            {s.rates.EUR?.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽
          </span>
        )}
        <Button
          type="button"
          onClick={() => setAdding(true)}
          className="h-9 rounded-[10px] bg-cta px-4 text-cta-foreground hover:bg-(--ns-cta-hover)"
        >
          <PlusIcon className="size-4" aria-hidden="true" />
          Добавить оплату
        </Button>
      </div>

      {view === 'stats' ? (
        <StatsView period={period} onPeriod={setPeriod} />
      ) : (
        <>
          {view === 'items' && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard
                testId="billing-stat-day"
                label={`Сегодня · ${DAY_FMT.format(today)}`}
                total={s?.day}
                expectedLabel="Ещё сегодня"
              />
              <StatCard
                testId="billing-stat-week"
                label={
                  monday && sunday
                    ? `Неделя · ${SHORT_FMT.format(monday).replace('.', '')} – ${SHORT_FMT.format(sunday).replace('.', '')}`
                    : 'Неделя'
                }
                total={s?.week}
                expectedLabel="До воскресенья"
              />
              <StatCard
                testId="billing-stat-month"
                label={MONTH_FMT.format(today).replace(/^./, (c) => c.toUpperCase())}
                total={s?.month}
                expectedLabel="Осталось в месяце"
              />
              <StatCard
                testId="billing-stat-year"
                label={`${today.getFullYear()} год`}
                total={s?.year}
                expectedLabel="До конца года"
              />
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[200px] flex-1 basis-[240px]">
              <SearchIcon
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-3"
                aria-hidden="true"
              />
              <Input
                aria-label="Поиск по оплатам"
                placeholder="Название, провайдер, сервер, домен…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="h-9 rounded-[10px] bg-surface-2 pl-9 text-[13px]"
              />
            </div>
            {list.length > 0 && (
              <div className="max-w-full overflow-x-auto">
                <Segmented label="Тип оплаты" items={kindItems} value={kind} onChange={setKind} />
              </div>
            )}
          </div>

          {items.isPending ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(290px,1fr))] gap-3">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-[142px] rounded-[14px]" />
              ))}
            </div>
          ) : items.isError ? (
            <p
              role="alert"
              className="rounded-[12px] border border-crit/30 bg-crit-soft px-4 py-3 text-[13px] text-crit"
            >
              {apiErrorMessage(items.error)}
            </p>
          ) : list.length === 0 ? (
            <div className="grid place-items-center rounded-2xl border border-dashed border-border-2 px-6 py-16 text-center">
              <p className="text-[14px] font-semibold">{archived ? 'Архив пуст' : 'Оплат пока нет'}</p>
              <p className="mt-1 max-w-[460px] text-[12.5px] text-text-3">
                {archived
                  ? 'Сюда попадает то, что больше не оплачивается: меню «⋯» у карточки → «В архив». История оплат сохраняется.'
                  : 'Добавьте серверы, аренду, домены и сертификаты с датой следующей оплаты. Панель напомнит в Telegram, посчитает расходы в рублях по курсу ЦБ, а Джарвис учтёт неоплату, если сервер упадёт.'}
              </p>
              {!archived && (
                <Button
                  type="button"
                  onClick={() => setAdding(true)}
                  className="mt-4 h-9 rounded-[10px] bg-brand px-4 text-[13px] font-semibold text-(--ns-on-accent) hover:brightness-[1.07]"
                >
                  Добавить первую оплату
                </Button>
              )}
            </div>
          ) : filtered.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-border-2 px-6 py-10 text-center text-[12.5px] text-text-3">
              Ничего не найдено{q ? ` по «${q}»` : ''}.
            </p>
          ) : (
            <div
              className={cn(
                'grid grid-cols-[repeat(auto-fill,minmax(290px,1fr))] gap-3',
                archived && 'opacity-90',
              )}
              data-testid="billing-grid"
            >
              {filtered.map((i) => (
                <BillingCard
                  key={i.id}
                  item={i}
                  provider={providerOf(i.providerId)}
                  servers={srvList}
                  now={now}
                  onExtend={() => setExtending(i)}
                  onEdit={() => setEditing(i)}
                  onHistory={() => setHistory(i)}
                  onArchive={() => void doArchive(i)}
                  onDelete={() => setDeleting(i)}
                />
              ))}
            </div>
          )}
        </>
      )}

      <ItemDialog open={adding} onOpenChange={setAdding} rates={s?.rates} />
      <ItemDialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        item={editing}
        rates={s?.rates}
      />
      <ExtendDialog
        open={extending !== null}
        onOpenChange={(o) => !o && setExtending(null)}
        item={extending}
        provider={providerOf(extending?.providerId ?? null)}
      />
      <HistoryDialog open={history !== null} onOpenChange={(o) => !o && setHistory(null)} item={history} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        kind="crit"
        title={`Удалить оплату «${deleting?.title ?? ''}»?`}
        description="Карточка удалится вместе с историей продлений, из статистики уйдут её суммы. Если оплата просто больше не нужна — лучше «В архив»: история останется."
        yesLabel="Да, удалить"
        loading={remove.isPending}
        onConfirm={doDelete}
      />
    </div>
  );
}
