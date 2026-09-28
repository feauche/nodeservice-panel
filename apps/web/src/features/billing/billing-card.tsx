import {
  BILLING_KIND_LABELS,
  type BillingItem,
  type BillingKind,
  billingPeriodLabel,
  type Provider,
} from '@nodeservice/shared';
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  EllipsisIcon,
  GlobeIcon,
  HistoryIcon,
  KeyRoundIcon,
  MoreVerticalIcon,
  PencilIcon,
  RepeatIcon,
  ServerIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ProviderIcon } from '@/features/providers/provider-icon';
import { openServer } from '@/features/servers/server-modal-store';
import { cn } from '@/lib/utils';
import { DUE_DOT, DUE_LABEL, DUE_TEXT, dueWords, formatDue, money, rubHint } from './billing-format';

export const KIND_ICON: Record<BillingKind, ComponentType<SVGProps<SVGSVGElement>>> = {
  server: ServerIcon,
  rent: KeyRoundIcon,
  domain: GlobeIcon,
  cert: ShieldCheckIcon,
  other: EllipsisIcon,
};

/** Иконка провайдера, а без провайдера — плитка с иконкой типа. */
export function BillingIcon({
  item,
  provider,
  size = 'lg',
}: {
  item: Pick<BillingItem, 'kind'>;
  provider: Provider | null;
  size?: 'md' | 'lg';
}) {
  if (provider) return <ProviderIcon provider={provider} size={size} />;
  const Icon = KIND_ICON[item.kind];
  return (
    <span
      className={cn(
        'grid flex-none place-items-center bg-surface-3 text-text-2',
        size === 'lg' ? 'size-9 rounded-[10px]' : 'size-6 rounded-[6px]',
      )}
      aria-hidden="true"
    >
      <Icon className={size === 'lg' ? 'size-[17px]' : 'size-3.5'} />
    </span>
  );
}

/** Маячок срока в левом верхнем углу: просрочено — с мягкой пульсацией. */
export function DueDot({ state, className }: { state: BillingItem['dueState']; className?: string }) {
  return (
    <span className={cn('relative flex size-[7px]', className)} role="img" aria-label={DUE_LABEL[state]}>
      {state === 'overdue' && (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-crit opacity-60 motion-reduce:hidden" />
      )}
      <span className={cn('relative inline-flex size-[7px] rounded-full', DUE_DOT[state])} />
    </span>
  );
}

interface CardProps {
  item: BillingItem;
  provider: Provider | null;
  servers: ReadonlyArray<{ id: string; name: string }>;
  now: number;
  onExtend: () => void;
  onEdit: () => void;
  onHistory: () => void;
  onArchive: () => void;
  onDelete: () => void;
}

/**
 * Карточка оплаты (витрина `billing-variants.html`, 2A, с правками): маячок срока в углу вместо полосы,
 * три ряда — кто и что; когда и сколько; серверы и «Продлить».
 */
export function BillingCard({
  item,
  provider,
  servers,
  now,
  onExtend,
  onEdit,
  onHistory,
  onArchive,
  onDelete,
}: CardProps) {
  const archived = item.archivedAt !== null;
  const linked = item.serverIds
    .map((id) => servers.find((s) => s.id === id))
    .filter((s): s is { id: string; name: string } => Boolean(s));
  const rub = rubHint(item);
  return (
    <article
      className="relative flex min-w-0 flex-col gap-2.5 rounded-[14px] border border-border bg-surface px-3.5 pt-3.5 pb-3"
      data-testid="billing-card"
      aria-label={item.title}
    >
      <DueDot state={item.dueState} className="absolute top-[7px] left-[7px]" />
      <div className="flex items-center gap-2.5">
        <BillingIcon item={item} provider={provider} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold leading-tight">{item.title}</div>
          <div className="truncate text-[11.5px] text-text-3">
            {provider ? `${provider.name} · ` : ''}
            {BILLING_KIND_LABELS[item.kind]}
            {item.domain && item.kind !== 'domain' ? ` · ${item.domain}` : ''}
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Действия: ${item.title}`}
              className="grid size-7 flex-none cursor-pointer place-items-center rounded-[8px] text-text-3 transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand"
            >
              <MoreVerticalIcon className="size-4" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[190px]">
            <DropdownMenuItem onSelect={onEdit}>
              <PencilIcon aria-hidden="true" />
              Изменить
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onHistory}>
              <HistoryIcon aria-hidden="true" />
              История оплат
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onArchive}>
              {archived ? <ArchiveRestoreIcon aria-hidden="true" /> : <ArchiveIcon aria-hidden="true" />}
              {archived ? 'Вернуть из архива' : 'В архив'}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2Icon aria-hidden="true" />
              Удалить
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3 rounded-[10px] bg-surface-2 px-2.5 py-2">
        <div className="min-w-0">
          <div className="truncate text-[12.5px] font-semibold tabular-nums">{formatDue(item.paidUntil)}</div>
          <div className={cn('truncate text-[11.5px] font-medium', DUE_TEXT[item.dueState])}>
            {archived ? 'в архиве' : dueWords(item.paidUntil, now)}
          </div>
        </div>
        <div className="text-right">
          <div className="font-heading text-[17px] leading-none font-bold tracking-[-0.02em] tabular-nums">
            {money(item.amountMinor, item.currency)}
          </div>
          <div className="mt-1 text-[11px] whitespace-nowrap text-text-3">
            {billingPeriodLabel(item.periodUnit, item.periodCount)}
            {rub ? ` · ${rub}` : ''}
          </div>
        </div>
      </div>

      <div className="flex min-h-7 items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
          {linked.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => openServer(s.id)}
              title={
                item.kind === 'cert'
                  ? 'Сертификат развёрнут здесь — открыть карточку сервера'
                  : 'Открыть карточку сервера'
              }
              className="inline-flex h-[22px] max-w-full cursor-pointer items-center gap-1 truncate rounded-[6px] bg-surface-3 px-2 text-[11.5px] text-text-2 transition-colors hover:text-foreground"
            >
              <ServerIcon className="size-3 flex-none" aria-hidden="true" />
              <span className="truncate">{s.name}</span>
            </button>
          ))}
          {item.autoCharge && (
            <span className="inline-flex h-[22px] items-center gap-1 rounded-[6px] bg-ok-soft px-2 text-[11.5px] text-ok">
              <RepeatIcon className="size-3" aria-hidden="true" />
              Списывается сама
            </span>
          )}
        </div>
        {!archived && (
          <button
            type="button"
            onClick={onExtend}
            className={cn(
              'h-7 flex-none cursor-pointer rounded-[8px] border px-3 text-[12px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-brand',
              item.dueState === 'overdue' || item.dueState === 'today'
                ? 'border-transparent bg-cta text-cta-foreground hover:bg-(--ns-cta-hover)'
                : 'border-border bg-surface-2 text-text-2 hover:bg-surface-3 hover:text-foreground',
            )}
          >
            Продлить
          </button>
        )}
      </div>
    </article>
  );
}
