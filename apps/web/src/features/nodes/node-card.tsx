import type { RemnawaveNode } from '@nodeservice/shared';
import { ArrowDownIcon, ArrowUpIcon, ShieldCheckIcon, UsersIcon } from 'lucide-react';
import type { ReactNode } from 'react';
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

/** Нагрузка на ядро, %: средняя нагрузка за минуту, делённая на число ядер (1,0 на ядро — это 100 %). */
export function loadPerCore(node: RemnawaveNode) {
  const load = node.loadAverage?.[0];
  return load != null && node.cpuCount ? (load / node.cpuCount) * 100 : null;
}

/** Полоса загрузки с процентом: зелёная, жёлтая ближе к пределу, красная за ним. */
export function LoadBar({
  value,
  warnAt = 65,
  critAt = 85,
}: {
  value: number | null;
  warnAt?: number;
  critAt?: number;
}) {
  if (value == null) return <span className="text-[12.5px] text-text-3">—</span>;
  const tone = value >= critAt ? 'bg-crit' : value >= warnAt ? 'bg-warn' : 'bg-ok';
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 min-w-[48px] flex-1 overflow-hidden rounded-full bg-foreground/10">
        <span
          className={cn('block h-full rounded-full', tone)}
          style={{ width: `${Math.min(100, Math.max(2, value))}%` }}
        />
      </span>
      <span className="w-9 text-right text-[12px] text-text-2 tabular-nums">
        {Math.round(value).toLocaleString('ru-RU')} %
      </span>
    </span>
  );
}

function Metric({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <span className={cn('block min-w-0', className)}>
      <span className="mb-1 block text-[10.5px] text-text-3">{label}</span>
      {children}
    </span>
  );
}

/**
 * Строка ноды: заливка по состоянию (как была), внутри — состояние, флаг, имя, событие и «БС»; адрес и провайдер;
 * онлайн, нагрузка на ядро и память полосами, сеть и время работы (витрина redesign-2026-10, «Ноды»).
 */
export function NodeCard({
  node,
  onClick,
  stale,
  incident,
}: {
  node: RemnawaveNode;
  onClick: () => void;
  stale: boolean;
  /** Открытое событие ноды: короткое название и важность. */
  incident?: { title: string; tone: 'crit' | 'warn' } | null;
}) {
  const state = nodeState(node),
    tone = stale ? 'muted' : state.tone;
  const down = !node.isConnected && !node.isDisabled;
  return (
    <button
      type="button"
      data-node-card={node.uuid}
      data-state={tone}
      onClick={onClick}
      className={cn(
        'group relative grid w-full min-w-0 cursor-pointer grid-cols-2 items-center gap-x-5 gap-y-3 rounded-[10px] border py-3 pr-12 pl-9 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        '@min-[720px]/nodes:grid-cols-[minmax(0,1.6fr)_72px_minmax(0,1fr)_minmax(0,1fr)] @min-[1000px]/nodes:grid-cols-[minmax(0,1.7fr)_80px_minmax(0,1fr)_minmax(0,1fr)_120px_84px]',
        tones[tone],
      )}
    >
      <span className="col-span-2 block min-w-0 @min-[720px]/nodes:col-span-1">
        <span className="flex min-w-0 items-center gap-2">
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
          <span className="truncate font-heading text-[13.5px] font-semibold" title={node.name}>
            {node.name}
          </span>
          {incident && (
            <span
              className={cn(
                'shrink-0 rounded-full px-[9px] py-[3px] text-[11.5px] font-semibold whitespace-nowrap',
                incident.tone === 'crit' ? 'bg-crit-soft text-crit' : 'bg-warn-soft text-warn',
              )}
            >
              {incident.title}
            </span>
          )}
          {node.whitelist && <WhitelistBadge />}
        </span>
        <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[11.5px] text-text-3">
          <span className="truncate font-mono" title={node.address}>
            {node.address}
          </span>
          <span className="opacity-50">·</span>
          <RemnaProviderIcon
            src={node.providerIcon}
            name={node.providerName ?? '?'}
            className="size-4 flex-none rounded-[4px] [&_img]:size-3"
          />
          <span className="truncate" title={node.providerName ?? undefined}>
            {node.providerName || 'Провайдер не указан'}
          </span>
          {stale && <span className="flex-none text-warn">· данные устарели</span>}
        </span>
      </span>
      <Metric label="Онлайн">
        <span
          className={cn(
            'flex items-center gap-1 text-[14px] font-semibold tabular-nums',
            down && 'text-crit',
          )}
        >
          <UsersIcon className="size-3.5 opacity-50 @min-[720px]/nodes:hidden" aria-hidden="true" />
          {node.usersOnline?.toLocaleString('ru-RU') ?? '—'}
        </span>
      </Metric>
      <Metric label="Нагрузка на ядро">
        <LoadBar value={loadPerCore(node)} />
      </Metric>
      <Metric label="Память">
        <LoadBar value={ram(node)} />
      </Metric>
      <Metric label="Сеть, Мбит/с" className="hidden @min-[1000px]/nodes:block">
        <span className="flex items-center gap-1.5 text-[12.5px] whitespace-nowrap tabular-nums">
          <ArrowDownIcon className="size-3 text-brand" aria-hidden="true" />
          {mbitPerSecond(node.rxBytesPerSec)}
          <ArrowUpIcon className="ml-1 size-3 text-teal" aria-hidden="true" />
          {mbitPerSecond(node.txBytesPerSec)}
        </span>
      </Metric>
      <Metric label="Работает" className="hidden @min-[1000px]/nodes:block">
        <span className="block truncate text-[12.5px]">{uptime(node.uptime)}</span>
      </Metric>
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
