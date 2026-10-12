import type { RemnawaveNode } from '@nodeservice/shared';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  Clock3Icon,
  ShieldCheckIcon,
  UsersIcon,
} from 'lucide-react';
import { CountryFlag } from '@/components/country-flag';
import { cn } from '@/lib/utils';
import { RemnaProviderIcon } from './remna-providers-page';

export function nodeState(node: RemnawaveNode) {
  if (node.isDisabled) return { label: 'Отключена', tone: 'muted' as const };
  if (node.isConnecting) return { label: 'Подключается', tone: 'warn' as const };
  return node.isConnected
    ? { label: 'Доступна', tone: 'ok' as const }
    : { label: 'Недоступна', tone: 'crit' as const };
}
export function bytes(raw: number | string | null | undefined) {
  if (raw === null || raw === undefined) return '—';
  let value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ', 'ПБ'];
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ${units[i]}`;
}
export function percent(value: number | null | undefined) {
  return value == null ? '—' : `${value.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;
}
/** Remnawave reports bytes per second; the panel displays network speed in Mbit/s like Remnawave UI. */
export function mbitPerSecond(raw: number | null | undefined) {
  if (raw == null || !Number.isFinite(raw) || raw < 0) return '—';
  const value = (raw * 8) / 1_000_000;
  return value.toLocaleString('ru-RU', { maximumFractionDigits: value >= 10 ? 0 : 1 });
}
export function ram(node: RemnawaveNode) {
  return node.memoryTotalBytes && node.memoryUsedBytes != null
    ? Math.min(100, (node.memoryUsedBytes / node.memoryTotalBytes) * 100)
    : null;
}
export function uptime(value: string | null | undefined) {
  if (!value) return '—';
  if (!/^\d+(\.\d+)?$/.test(value)) return value;
  const sec = Number(value),
    days = Math.floor(sec / 86400),
    hours = Math.floor((sec % 86400) / 3600),
    minutes = Math.floor((sec % 3600) / 60);
  return days ? `${days} д ${hours} ч` : hours ? `${hours} ч ${minutes} мин` : `${minutes} мин`;
}
const tones = {
  ok: 'border-ok/25 bg-linear-to-r from-ok/10 to-ok/3 hover:border-ok/50 hover:from-ok/14',
  crit: 'border-crit/35 bg-linear-to-r from-crit/17 via-crit/10 to-crit/5 hover:border-crit/60',
  warn: 'border-warn/30 bg-linear-to-r from-warn/14 to-warn/4 hover:border-warn/60',
  muted: 'border-border bg-surface hover:bg-surface-2',
};
export function NodeCard({
  node,
  onClick,
  stale,
}: {
  node: RemnawaveNode;
  onClick: () => void;
  stale: boolean;
}) {
  const state = nodeState(node),
    tone = stale ? 'muted' : state.tone;
  const used = node.trafficUsedBytes,
    limit = node.trafficLimitBytes;
  return (
    <button
      type="button"
      data-node-card={node.uuid}
      data-state={tone}
      onClick={onClick}
      className={cn(
        'group relative grid w-full min-w-0 cursor-pointer grid-cols-1 items-center gap-x-6 gap-y-4 rounded-[10px] border py-3.5 pr-7 pl-9 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:grid-cols-2 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,.8fr)_minmax(0,.65fr)_16px]',
        tones[tone],
      )}
    >
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden="true"
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              tone === 'ok'
                ? 'bg-ok'
                : tone === 'crit'
                  ? 'bg-crit'
                  : tone === 'warn'
                    ? 'bg-warn'
                    : 'bg-text-3',
            )}
          />
          {node.countryCode && <CountryFlag code={node.countryCode} size="md" />}
          <span className="truncate font-heading text-[14px] font-semibold" title={node.name}>
            {node.name}
          </span>
          {node.whitelist && <WhitelistBadge />}
          <span className="ml-auto flex shrink-0 items-center gap-1.5 rounded-md bg-black/10 px-2 py-1 text-[12px] tabular-nums">
            <UsersIcon className="size-3.5 opacity-60" />
            {node.usersOnline?.toLocaleString('ru-RU') ?? '—'}
          </span>
        </span>
        <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-text-2">
          <span>{stale ? 'Данные устарели' : state.label}</span>
          <span className="opacity-35">·</span>
          <span>
            {node.cpuPercent == null
              ? `Load ${node.loadAverage?.[0]?.toFixed(2) ?? '—'}`
              : `CPU ${percent(node.cpuPercent)}`}
          </span>
          <span>RAM {percent(ram(node))}</span>
        </span>
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-[12.5px] font-medium">
          <RemnaProviderIcon
            src={node.providerIcon}
            name={node.providerName ?? '?'}
            className="size-6 rounded-md [&_img]:size-4"
          />
          <span className="truncate" title={node.providerName ?? undefined}>
            {node.providerName || 'Провайдер не указан'}
          </span>
        </span>
        <span className="mt-2 block truncate font-mono text-[11.5px] text-text-3" title={node.address}>
          {node.address}
        </span>
      </span>
      <span className="min-w-0">
        <span className="flex items-baseline justify-between gap-2 text-[13px] tabular-nums">
          <span className="font-semibold">{bytes(used)}</span>
          <span className="text-[11px] text-text-3">{limit ? `/ ${bytes(limit)}` : '∞'}</span>
        </span>
        <span className="my-2 block h-1 overflow-hidden rounded-full bg-foreground/8">
          <span
            className="block h-full rounded-full bg-current opacity-40"
            style={{ width: limit && used != null ? `${Math.min(100, (used / limit) * 100)}%` : '0%' }}
          />
        </span>
        <span className="flex flex-wrap gap-x-3 text-[10.5px] text-text-3">
          <span className="flex items-center gap-1">
            <ArrowDownIcon className="size-3" />
            {mbitPerSecond(node.rxBytesPerSec)} Мбит/с
          </span>
          <span className="flex items-center gap-1">
            <ArrowUpIcon className="size-3" />
            {mbitPerSecond(node.txBytesPerSec)} Мбит/с
          </span>
        </span>
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-[12px]">
          <Clock3Icon className="size-3.5 text-text-3" />
          {uptime(node.uptime)}
        </span>
        <span className="mt-2 block truncate text-[10.5px] text-text-3">
          Xray {node.xrayVersion || '—'} · Node {node.nodeVersion || '—'}
        </span>
      </span>
      <ChevronRightIcon className="absolute top-5 right-3 size-4 text-text-3 md:hidden xl:static xl:block" />
    </button>
  );
}

/** Метка «БС»: нода отмечена как сервер белого списка. */
export function WhitelistBadge() {
  return (
    <span
      title="Сервер белого списка"
      className="inline-flex items-center gap-1 rounded-full bg-teal/15 px-[9px] py-[3px] text-[11.5px] font-semibold whitespace-nowrap text-teal"
    >
      <ShieldCheckIcon className="size-3" aria-hidden="true" />
      БС
    </span>
  );
}
