import {
  CAPACITY_DAYS,
  CAPACITY_LIMITS,
  type CapacityResource,
  type NodeCapacityRow,
  nodeCapacitySchema,
  nodePreferencesSchema,
} from '@nodeservice/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2Icon, PlusIcon } from 'lucide-react';
import { Popover } from 'radix-ui';
import { useState } from 'react';
import { Card } from '@/components/card';
import { CountryFlag } from '@/components/country-flag';
import { KpiCard } from '@/components/kpi-card';
import { Skeleton } from '@/components/ui/skeleton';
import { NodeDialog } from '@/features/nodes/node-dialog';
import { useNodes } from '@/features/nodes/nodes-api';
import { api, apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { fmt, plural } from './overview-format';

const RESOURCE: Record<CapacityResource, { name: string; into: string }> = {
  cpu: { name: 'Процессор', into: 'в процессор' },
  ram: { name: 'Память', into: 'в память' },
  channel: { name: 'Канал', into: 'в канал' },
};

const SKIP: Record<NonNullable<NodeCapacityRow['skipped']>, string> = {
  disabled: 'не используется',
  idle: 'мало нагрузки',
  collecting: 'мало замеров',
};

function useCapacity() {
  return useQuery({
    queryKey: ['nodes', 'capacity'],
    queryFn: ({ signal }) => api.get('/nodes/capacity', nodeCapacitySchema, signal),
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });
}

/** Полоса загрузки: зелёная до двух третей предела, жёлтая ближе к нему, красная за ним. */
function LoadBar({ value, limit }: { value: number | null; limit: number }) {
  if (value == null) return <span className="text-[12.5px] text-text-3">—</span>;
  const tone = value >= limit ? 'bg-crit' : value >= limit * 0.8 ? 'bg-warn' : 'bg-ok';
  return (
    <div className="flex items-center gap-2" title={`Безопасный предел — ${limit} %`}>
      <div className="h-1.5 min-w-[64px] flex-1 overflow-hidden rounded-full bg-surface-3">
        <i
          className={cn('block h-full rounded-full', tone)}
          style={{ width: `${Math.min(100, Math.max(2, value))}%` }}
        />
      </div>
      <span className="w-10 text-right text-[12px] text-text-2 tabular-nums">{fmt(value)} %</span>
    </div>
  );
}

/**
 * Лимит канала прямо из строки: окошко у кнопки — поле с единицей внутри, «Отмена» и «Сохранить». Таблица при этом
 * не меняет ширину столбцов. Лимит сохраняется в настройки ноды, расчёт сразу пересчитывается.
 */
function ChannelLimit({ uuid, name }: { uuid: string; name: string }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('1000');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const mbps = Number(value.replace(/\s/g, '').replace(',', '.'));
    if (!Number.isFinite(mbps) || mbps <= 0 || mbps > 1_000_000) {
      toast.error('Укажите скорость канала числом, например 1000.');
      return;
    }
    setSaving(true);
    try {
      const current = await client.fetchQuery({
        queryKey: ['nodes', 'preferences', uuid],
        queryFn: ({ signal }) => api.get(`/nodes/${uuid}/preferences`, nodePreferencesSchema, signal),
      });
      const saved = await api.put(
        `/nodes/${uuid}/preferences`,
        { ...current, channelMbps: mbps },
        nodePreferencesSchema,
      );
      client.setQueryData(['nodes', 'preferences', uuid], saved);
      await client.invalidateQueries({ queryKey: ['nodes', 'capacity'] });
      setOpen(false);
    } catch (err) {
      toast.error(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Popover.Root open={open} onOpenChange={(next) => !saving && setOpen(next)}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[9px] border border-border bg-surface px-2.5 text-[12px] font-medium whitespace-nowrap text-text-2 transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand data-[state=open]:border-brand/50 data-[state=open]:text-foreground"
        >
          <PlusIcon className="size-3.5" aria-hidden="true" />
          Указать лимит
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="z-50 w-[288px] rounded-[14px] border border-border-2 bg-surface p-4 shadow-float outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <h3 className="text-[13.5px] font-semibold">Лимит канала · {name}</h3>
            <p className="mt-1 text-[12px] leading-snug text-text-3">
              Скорость, которую даёт провайдер. Обычно 1000 Мбит/с.
            </p>
            <div className="relative mt-3">
              <input
                // biome-ignore lint/a11y/noAutofocus: окошко открыто нажатием «Указать лимит» — сразу вводим число
                autoFocus
                inputMode="decimal"
                aria-label="Лимит канала, Мбит/с"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="h-10 w-full rounded-[10px] border border-border bg-surface-2 pr-[64px] pl-3 text-[13.5px] tabular-nums outline-none focus:border-brand/60"
              />
              <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-[12.5px] whitespace-nowrap text-text-3">
                Мбит/с
              </span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Popover.Close asChild>
                <button
                  type="button"
                  disabled={saving}
                  className="h-10 cursor-pointer rounded-[10px] border border-border bg-surface text-[13px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-foreground disabled:opacity-60"
                >
                  Отмена
                </button>
              </Popover.Close>
              <button
                type="submit"
                disabled={saving}
                className="inline-flex h-10 cursor-pointer items-center justify-center gap-1.5 rounded-[10px] bg-cta text-[13px] font-semibold text-cta-foreground transition-[filter] hover:brightness-105 disabled:opacity-60"
              >
                {saving && <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />}
                Сохранить
              </button>
            </div>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function CapacitySkeleton() {
  return (
    <div role="status" aria-label="Загрузка расчёта" className="flex flex-col gap-3">
      <div className="grid gap-3 md:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-[118px] rounded-2xl" />
        ))}
      </div>
      <div className="flex flex-col gap-2 rounded-2xl border border-border bg-surface p-4">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-11 rounded-[10px]" />
        ))}
      </div>
    </div>
  );
}

/** «Обзор», вкладка «Ёмкость»: сколько ещё выдержит каждая нода (витрина redesign-2026-10, вариант A). */
export function OverviewCapacity() {
  const q = useCapacity();
  const nodes = useNodes();
  const [selected, setSelected] = useState<string | null>(null);
  if (q.isPending) return <CapacitySkeleton />;
  if (q.isError)
    return (
      <p role="alert" className="rounded-[12px] border border-crit/30 bg-crit-soft px-4 py-3 text-[13px]">
        {apiErrorMessage(q.error)}{' '}
        <button type="button" className="cursor-pointer underline" onClick={() => void q.refetch()}>
          Повторить
        </button>
      </p>
    );
  const provider = new Map((nodes.data?.nodes ?? []).map((n) => [n.uuid, n.providerName ?? null]));
  const calculated = q.data.rows.filter((r) => r.skipped == null);
  const skipped = q.data.rows.filter((r) => r.skipped != null);
  const total = calculated.reduce((s, r) => s + (r.extra ?? 0), 0);
  const atLimit = calculated.filter((r) => r.extra === 0);
  const preliminary = calculated.filter((r) => r.preliminary);
  const necks = (['cpu', 'ram', 'channel'] as const)
    .map((k) => ({ k, n: calculated.filter((r) => r.bottleneck === k).length }))
    .sort((a, b) => b.n - a.n);
  const top = necks[0];
  const others = necks.slice(1).filter((x) => x.n > 0);
  const rows = [...calculated].sort((a, b) => (a.extra ?? 0) - (b.extra ?? 0));
  const selectedNode = nodes.data?.nodes.find((n) => n.uuid === selected);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 md:grid-cols-3">
        <KpiCard
          label="Итог по парку"
          value={calculated.length ? `+${fmt(total)}` : '—'}
          unit={calculated.length ? 'пользователей ещё выдержит' : undefined}
          status={
            !calculated.length
              ? 'Нод с нагрузкой пока нет'
              : atLimit.length
                ? `${atLimit.length} ${plural(atLimit.length, 'нода', 'ноды', 'нод')} уже на пределе`
                : 'Запас есть у всех нод'
          }
          tone={!calculated.length ? 'muted' : atLimit.length ? 'crit' : 'ok'}
        />
        <KpiCard
          label="Рассчитано нод"
          value={calculated.length}
          unit={`из ${q.data.rows.length}`}
          status={
            preliminary.length
              ? `${preliminary.length} — предварительно, без лимита канала`
              : calculated.length
                ? 'Все расчёты точные'
                : 'Нечего считать'
          }
          tone={preliminary.length ? 'warn' : 'ok'}
        />
        <KpiCard
          label="Узкое место"
          value={top && top.n > 0 ? RESOURCE[top.k].name : '—'}
          unit={top && top.n > 0 ? `у ${top.n} ${plural(top.n, 'ноды', 'нод', 'нод')}` : undefined}
          status={
            others.length
              ? others.map((x) => `${RESOURCE[x.k].name.toLowerCase()} у ${x.n}`).join(', ')
              : 'Других ограничений нет'
          }
          tone="info"
        />
      </div>

      <Card
        title="Запас по нодам"
        sub={`безопасные пределы: процессор ${CAPACITY_LIMITS.cpu} %, память ${CAPACITY_LIMITS.ram} %, канал ${CAPACITY_LIMITS.channel} % · по пику за ${CAPACITY_DAYS} дней`}
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-border text-[11px] font-semibold tracking-[0.08em] text-text-3 uppercase">
                <th className="px-4 py-2.5 font-semibold">Нода</th>
                <th className="px-4 py-2.5 font-semibold">Пик онлайна</th>
                <th className="px-4 py-2.5 font-semibold">
                  Процессор
                  <span className="block text-[11px] font-medium tracking-normal normal-case">
                    нагрузка на ядро
                  </span>
                </th>
                <th className="px-4 py-2.5 font-semibold">Память</th>
                <th className="px-4 py-2.5 font-semibold">Канал</th>
                <th className="px-4 py-2.5 font-semibold">Выдержит ещё</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.uuid}
                  className="border-t border-border transition-colors first:border-t-0 hover:bg-surface-2/60"
                >
                  <td className="px-4 py-2.5">
                    <button
                      type="button"
                      onClick={() => setSelected(r.uuid)}
                      className="flex cursor-pointer items-center gap-2 text-left font-medium whitespace-nowrap hover:text-brand focus-visible:outline-2 focus-visible:outline-brand"
                    >
                      {r.countryCode && <CountryFlag code={r.countryCode} size="sm" />}
                      {r.name}
                    </button>
                    <small className="mt-0.5 block text-[12px] text-text-3">
                      {[
                        r.cores ? `${r.cores} ${plural(r.cores, 'ядро', 'ядра', 'ядер')}` : null,
                        provider.get(r.uuid),
                      ]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </small>
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">{fmt(r.peakOnline)}</td>
                  <td className="w-[15%] px-4 py-2.5">
                    <LoadBar value={r.cpu} limit={CAPACITY_LIMITS.cpu} />
                  </td>
                  <td className="w-[15%] px-4 py-2.5">
                    <LoadBar value={r.ram} limit={CAPACITY_LIMITS.ram} />
                  </td>
                  <td className="w-[15%] px-4 py-2.5">
                    {r.channelMbps ? (
                      <LoadBar value={r.channel} limit={CAPACITY_LIMITS.channel} />
                    ) : (
                      <ChannelLimit uuid={r.uuid} name={r.name} />
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <b className={cn('tabular-nums', r.extra === 0 ? 'text-crit' : 'text-ok')}>
                      {r.extra == null ? '—' : r.extra === 0 ? 'на пределе' : `+${fmt(r.extra)}`}
                    </b>
                    <small className="mt-0.5 block text-[12px] whitespace-nowrap text-text-3">
                      {r.preliminary ? 'предварительно · ' : ''}
                      {r.bottleneck
                        ? `${r.extra === 0 ? 'упирается' : 'упрётся'} ${RESOURCE[r.bottleneck].into}`
                        : 'недостаточно данных'}
                    </small>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-[13px] text-text-3">
                    Нод с нагрузкой пока нет: считать нечего.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="border-t border-border px-4 py-3 text-[12.5px] leading-relaxed text-text-3">
          Remnawave не отдаёт процент процессора, поэтому процессор считается как нагрузка на ядро: 1,0 на
          ядро — это 100 %. Расчёт идёт по замерам в загруженные часы: сколько нода тратит без пользователей и
          сколько на каждого.
          {skipped.length > 0 && (
            <>
              {' '}
              Без расчёта: {skipped.map((r) => `${r.name} (${r.skipped ? SKIP[r.skipped] : ''})`).join(', ')}.
            </>
          )}
        </div>
      </Card>
      {selectedNode && <NodeDialog node={selectedNode} stale={false} onClose={() => setSelected(null)} />}
    </div>
  );
}
