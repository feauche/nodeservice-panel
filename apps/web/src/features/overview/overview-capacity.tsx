import {
  CAPACITY_DAYS,
  CAPACITY_LIMITS,
  type CapacityResource,
  type NodeCapacityRow,
  nodeCapacitySchema,
  nodePreferencesSchema,
} from '@nodeservice/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { useState } from 'react';
import { Card } from '@/components/card';
import { CountryFlag } from '@/components/country-flag';
import { KpiCard } from '@/components/kpi-card';
import { Skeleton } from '@/components/ui/skeleton';
import { ChannelLimitDialog } from '@/features/nodes/channel-limit-dialog';
import { NodeDialog } from '@/features/nodes/node-dialog';
import { useNodes } from '@/features/nodes/nodes-api';
import { api, apiErrorMessage } from '@/lib/api';
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
 * Лимит канала прямо из строки: кнопка открывает окно по шагам — команда для сервера, поле для её вывода и число,
 * которое панель из него поняла (витрина channel-limit-2026-10, вариант C). Лимит сохраняется в настройки ноды,
 * расчёт сразу пересчитывается.
 */
function ChannelLimit({ uuid, name }: { uuid: string; name: string }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const save = async (mbps: number) => {
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
  };
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-[9px] border border-border bg-surface px-2.5 text-[12px] font-medium whitespace-nowrap text-text-2 transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand"
      >
        <PlusIcon className="size-3.5" aria-hidden="true" />
        Указать лимит
      </button>
      {open && <ChannelLimitDialog nodeName={name} onSubmit={save} onClose={() => setOpen(false)} />}
    </>
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
