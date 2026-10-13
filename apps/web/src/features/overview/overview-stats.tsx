import { type BillingStatPeriod, type NodeStats, nodeStatsSchema } from '@nodeservice/shared';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon, DownloadIcon, LockIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, ChartCard } from '@/components/card';
import { CountryFlag } from '@/components/country-flag';
import { KpiCard } from '@/components/kpi-card';
import { MetricArea } from '@/components/metric-area';
import { ChartSkeleton } from '@/components/ui/loading-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useBillingStats } from '@/features/billing/billing-api';
import { rub } from '@/features/billing/billing-format';
import { bytes } from '@/features/nodes/node-card';
import { NodeDialog } from '@/features/nodes/node-dialog';
import { useNodes } from '@/features/nodes/nodes-api';
import { Segmented } from '@/features/settings/settings-ui';
import { api, apiErrorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { fmt, plural } from './overview-format';

type Period = '1' | '7' | '30';
const BILLING_PERIOD: Record<Period, BillingStatPeriod> = { '1': 'day', '7': 'week', '30': 'month' };
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
const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const TB = 1024 ** 4;
const DAY_MS = 86_400_000;

function useNodeStats(days: Period) {
  return useQuery({
    queryKey: ['nodes', 'stats', days],
    queryFn: ({ signal }) => api.get(`/nodes/stats?days=${days}`, nodeStatsSchema, signal),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}

/** «1,74 ПБ» → цифра и единица отдельно: единица в карточке мельче. */
function splitBytes(v: number | null) {
  const text = bytes(v);
  const at = text.lastIndexOf(' ');
  return at > 0 ? { value: text.slice(0, at), unit: text.slice(at + 1) } : { value: text, unit: '' };
}

/** «2 ч 14 мин», «35 мин», «3 д 4 ч». */
export function duration(ms: number) {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 ? `${h} ч ${min % 60} мин` : `${h} ч`;
  return `${Math.floor(h / 24)} д ${h % 24} ч`;
}

/** «UTC+6» для пояса панели. */
function offsetLabel(timeZone: string) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
    .formatToParts(new Date())
    .find((p) => p.type === 'timeZoneName')?.value;
  return part ? part.replace('GMT', 'UTC').replace(/^UTC$/, 'UTC+0') : timeZone;
}

function rangeText(stats: NodeStats) {
  const day = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: stats.timeZone });
  const time = new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: stats.timeZone,
  });
  const from = new Date(stats.from);
  const to = new Date(stats.to);
  const span =
    stats.days === 1
      ? `${day.format(from)}, ${time.format(from)} — ${time.format(to)}`
      : `${day.format(from)} — ${day.format(to)}`;
  return `${span} · по поясу панели, ${offsetLabel(stats.timeZone)}`;
}

/**
 * Подпись столбика в подсказке: итог Remnawave — по Гринвичу; крайние сутки периода — неполные, с какого и по какое
 * время; сутки на стыке с итогом Remnawave — с полуночи по Гринвичу.
 */
function dayNotes(d: NodeStats['traffic']['days'][number], stats: NodeStats, time: Intl.DateTimeFormat) {
  const ongoing = d.to === stats.to;
  if (d.source === 'remnawave')
    return [ongoing ? 'Итог Remnawave по Гринвичу — сутки ещё идут' : 'Итог Remnawave за сутки по Гринвичу'];
  const notes: string[] = [];
  const start = time.format(new Date(d.from));
  if (d.from === stats.from) notes.push(`С ${start} — начало периода`);
  else if (start !== '00:00') notes.push(`С ${start}, раньше — итог Remnawave`);
  if (ongoing) notes.push(`По ${time.format(new Date(d.to))} — сутки ещё идут`);
  return notes;
}

/**
 * Трафик пользователей по суткам пояса панели — та же величина, что в Remnawave, ровно за период: крайние столбики —
 * неполные сутки. Сутки до начала замеров панели — суточные итоги Remnawave (её сутки — по Гринвичу): подсказка так
 * и говорит.
 */
function TrafficBars({ stats }: { stats: NodeStats }) {
  const time = new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: stats.timeZone,
  });
  const data = stats.traffic.days.map((d) => ({
    date: d.date,
    total: d.total / TB,
    notes: dayNotes(d, stats, time),
  }));
  const label = (iso: string) =>
    new Date(`${iso}T12:00:00Z`).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  return (
    <div className="mt-3 h-[200px] min-w-0">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ left: 0, right: 6, top: 6, bottom: 0 }} barCategoryGap="18%">
          <CartesianGrid vertical={false} stroke="var(--ns-border)" />
          <XAxis
            dataKey="date"
            tickFormatter={label}
            minTickGap={24}
            tick={{ fill: 'var(--ns-text-3)', fontSize: 10.5 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            width={40}
            tickFormatter={(v) => fmt(Number(v), 1)}
            tick={{ fill: 'var(--ns-text-3)', fontSize: 10.5 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            cursor={{ fill: 'var(--ns-surface-2)' }}
            content={({ active, payload }) => {
              const row = active ? (payload?.[0]?.payload as (typeof data)[number] | undefined) : undefined;
              if (!row) return null;
              return (
                <div className="min-w-[170px] rounded-[10px] border border-border-2 bg-surface px-3 py-2 text-[12px] shadow-float">
                  <div className="mb-1 text-text-3">
                    {new Date(`${row.date}T12:00:00Z`).toLocaleDateString('ru-RU', {
                      day: 'numeric',
                      month: 'long',
                    })}
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-text-2">Трафик</span>
                    <b className="tabular-nums">{fmt(row.total, 2)} ТБ</b>
                  </div>
                  {row.notes.map((note) => (
                    <div key={note} className="mt-1 text-text-3">
                      {note}
                    </div>
                  ))}
                </div>
              );
            }}
          />
          <Bar
            dataKey="total"
            fill="var(--ns-accent)"
            fillOpacity={0.9}
            radius={[4, 4, 0, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

const pad2 = (h: number) => `${String(h).padStart(2, '0')}:00`;

/** Онлайн по часам суток за последние недели: когда пик и когда спокойнее всего работать с нодами. */
function HourHeatmap({ heat }: { heat: NodeStats['heatmap'] }) {
  const values = heat.cells.flat().filter((v): v is number => v != null);
  if (values.length === 0)
    return (
      <div className="mt-3 grid h-[180px] place-items-center rounded-[12px] border border-dashed border-border text-[12.5px] text-text-3">
        Замеров пока нет
      </div>
    );
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  return (
    <>
      <div
        className="mt-3 grid gap-[3px] text-[10.5px] text-text-3"
        style={{ gridTemplateColumns: '26px repeat(24, minmax(0, 1fr))' }}
      >
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: часы суток — постоянный порядок
          <span key={h} className="text-center">
            {h % 3 ? '' : h}
          </span>
        ))}
        {heat.cells.map((row, d) => (
          <div key={DAYS[d]} className="contents">
            <span className="self-center">{DAYS[d]}</span>
            {row.map((v, h) => (
              <i
                // biome-ignore lint/suspicious/noArrayIndexKey: ячейка — час суток
                key={h}
                title={
                  v == null
                    ? `${DAYS[d]}, ${pad2(h)} — замеров нет`
                    : `${DAYS[d]}, ${pad2(h)} — в среднем ${fmt(v)} онлайн`
                }
                className="block aspect-[1.4] rounded-[3px]"
                style={{
                  background:
                    v == null
                      ? 'var(--ns-surface-2)'
                      : `color-mix(in srgb, var(--ns-accent) ${Math.round(8 + ((v - min) / span) * 84)}%, var(--ns-surface-2))`,
                }}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-[12px] text-text-3">
        <span>
          {heat.peak && heat.quiet
            ? `Пик — ${pad2(heat.peak.from)}–${pad2(heat.peak.to)}, тише всего — ${pad2(heat.quiet.from)}–${pad2(heat.quiet.to)}`
            : 'Часы пика появятся, когда наберётся история'}
        </span>
        <span className="flex items-center gap-1.5">
          меньше
          <i
            className="block h-2 w-[60px] rounded"
            style={{ background: 'linear-gradient(90deg, var(--ns-surface-2), var(--ns-accent))' }}
          />
          больше
        </span>
      </div>
    </>
  );
}

type SortKey = 'name' | 'traffic' | 'peakOnline' | 'uptime' | 'incidents';
const COLUMNS: Array<{ key: SortKey | 'share'; label: string; num?: boolean }> = [
  { key: 'name', label: 'Нода' },
  { key: 'traffic', label: 'Трафик', num: true },
  { key: 'share', label: 'Доля' },
  { key: 'peakOnline', label: 'Пиковый онлайн', num: true },
  { key: 'uptime', label: 'На связи', num: true },
  { key: 'incidents', label: 'Сбои', num: true },
];

function downloadCsv(stats: NodeStats, rows: NodeStats['nodes']) {
  const cell = (v: string | number | null) => {
    const s = v == null ? '' : String(v).replace('.', ',');
    return /[;"\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines = [
    ['Нода', 'Трафик, ГБ', 'Доля, %', 'Пиковый онлайн', 'На связи, %', 'Сбои'].join(';'),
    ...rows.map((n) =>
      [
        cell(n.name),
        cell(n.traffic == null ? null : Math.round((n.traffic / 1024 ** 3) * 10) / 10),
        cell(n.share == null ? null : Math.round(n.share * 10) / 10),
        cell(n.peakOnline),
        cell(n.uptime),
        cell(n.incidents),
      ].join(';'),
    ),
  ];
  // Знак порядка байтов в начале — чтобы Excel открыл русские буквы без вопросов о кодировке.
  const blob = new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ноды-за-${stats.days}-${plural(stats.days, 'день', 'дня', 'дней')}-${stats.to.slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function NodesTable({ stats, onOpen }: { stats: NodeStats; onOpen: (uuid: string) => void }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'traffic', dir: -1 });
  const rows = useMemo(() => {
    const val = (n: NodeStats['nodes'][number]) => (sort.key === 'name' ? n.name : n[sort.key]);
    return [...stats.nodes].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === 'string' ? x.localeCompare(String(y), 'ru') : Number(x) - Number(y)) * sort.dir;
    });
  }, [stats.nodes, sort]);
  const maxShare = Math.max(1, ...stats.nodes.map((n) => n.share ?? 0));
  return (
    <Card
      title="Ноды за период"
      sub="нажмите на заголовок столбца, чтобы отсортировать"
      end={
        <button
          type="button"
          onClick={() => downloadCsv(stats, rows)}
          className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[10px] border border-border bg-surface px-3 text-[12.5px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand"
        >
          <DownloadIcon className="size-3.5" aria-hidden="true" />
          Скачать таблицу
        </button>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-[13px]">
          <thead>
            <tr className="border-b border-border text-[11px] font-semibold tracking-[0.08em] text-text-3 uppercase">
              {COLUMNS.map((c) => {
                const active = sort.key === c.key;
                return (
                  <th
                    key={c.key}
                    className="px-4 py-2.5 font-semibold"
                    aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}
                  >
                    {c.key === 'share' ? (
                      c.label
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          setSort((s) =>
                            s.key === c.key
                              ? { key: s.key, dir: s.dir === 1 ? -1 : 1 }
                              : { key: c.key as SortKey, dir: c.key === 'name' ? 1 : -1 },
                          )
                        }
                        className={cn(
                          'inline-flex cursor-pointer items-center gap-1 uppercase transition-colors hover:text-foreground',
                          active && 'text-foreground',
                        )}
                      >
                        {c.label}
                        {active ? (
                          sort.dir === 1 ? (
                            <ArrowUpIcon className="size-3" aria-hidden="true" />
                          ) : (
                            <ArrowDownIcon className="size-3" aria-hidden="true" />
                          )
                        ) : (
                          <ChevronsUpDownIcon className="size-3 opacity-50" aria-hidden="true" />
                        )}
                      </button>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((n) => (
              <tr
                key={n.uuid}
                className="border-t border-border transition-colors first:border-t-0 hover:bg-surface-2/60"
              >
                <td className="px-4 py-2.5">
                  <button
                    type="button"
                    onClick={() => onOpen(n.uuid)}
                    className="flex cursor-pointer items-center gap-2 text-left font-medium hover:text-brand focus-visible:outline-2 focus-visible:outline-brand"
                  >
                    {n.countryCode && <CountryFlag code={n.countryCode} size="sm" />}
                    <span>{n.name}</span>
                    {n.disabled && (
                      <span className="text-[12px] font-normal text-text-3">не используется</span>
                    )}
                  </button>
                </td>
                <td className="px-4 py-2.5 font-semibold whitespace-nowrap tabular-nums">
                  {bytes(n.traffic)}
                </td>
                <td className="w-[22%] px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
                      <i
                        className="block h-full rounded-full bg-brand"
                        style={{ width: `${((n.share ?? 0) / maxShare) * 100}%` }}
                      />
                    </div>
                    <span className="w-11 text-right text-[12px] text-text-3 tabular-nums">
                      {n.share == null ? '—' : `${fmt(n.share, 1)} %`}
                    </span>
                  </div>
                </td>
                <td className="px-4 py-2.5 tabular-nums">{fmt(n.peakOnline)}</td>
                <td
                  className={cn('px-4 py-2.5 tabular-nums', n.uptime != null && n.uptime < 99 && 'text-warn')}
                >
                  {n.uptime == null ? '—' : `${fmt(n.uptime, 1)} %`}
                </td>
                <td className={cn('px-4 py-2.5 tabular-nums', n.incidents > 0 && 'text-crit')}>
                  {n.incidents || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Удалённые из Remnawave ноды: их трафик есть в итоге — строкой, чтобы доли сходились в 100 %. */}
      {stats.traffic.removed > 0 && (
        <p className="border-t border-border px-4 py-2.5 text-[12.5px] text-text-3">
          Удалённые ноды — {bytes(stats.traffic.removed)}
          {stats.traffic.total
            ? ` · ${fmt((stats.traffic.removed / stats.traffic.total) * 100, 1)} % трафика за период`
            : ''}
        </p>
      )}
    </Card>
  );
}

function StatsSkeleton() {
  return (
    <div role="status" aria-label="Загрузка статистики" className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-[118px] rounded-2xl" />
        ))}
      </div>
      <div className="h-[260px] rounded-2xl border border-border bg-surface p-4">
        <ChartSkeleton />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <Skeleton className="h-[290px] rounded-2xl" />
        <Skeleton className="h-[290px] rounded-2xl" />
      </div>
    </div>
  );
}

/** «Обзор», вкладка «Статистика»: отчёт за период (витрина redesign-2026-10, вариант A). */
export function OverviewStats() {
  const [period, setPeriod] = useState<Period>('30');
  const stats = useNodeStats(period);
  const billing = useBillingStats(BILLING_PERIOD[period]);
  const nodes = useNodes();
  const [selected, setSelected] = useState<string | null>(null);
  const s = stats.data;
  const selectedNode = nodes.data?.nodes.find((n) => n.uuid === selected);
  const total = splitBytes(s?.traffic.total ?? null);
  // За какое время есть трафик: сумма частей суток под столбиками — крайние сутки периода неполные, а до начала
  // замеров панели первые сутки периода целым итогом Remnawave не заменить.
  const coveredMs = s?.traffic.days.reduce((sum, d) => sum + Date.parse(d.to) - Date.parse(d.from), 0) ?? 0;
  // В среднем за сутки: итог на это время, а не на число столбиков.
  const perDay =
    s?.traffic.total != null && coveredMs >= DAY_MS ? s.traffic.total / (coveredMs / DAY_MS) : null;
  const paidLabel =
    period === '1' ? 'сегодня' : period === '7' ? 'на этой неделе' : `в ${MONTH_IN[new Date().getMonth()]}`;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <Segmented<Period | '90'>
          label="Период статистики"
          value={period}
          onChange={(v) => v !== '90' && setPeriod(v)}
          items={[
            { key: '1', label: 'Сутки' },
            { key: '7', label: 'Неделя' },
            { key: '30', label: '30 дней' },
            {
              key: '90',
              label: (
                <>
                  90 дней <LockIcon className="size-3" aria-hidden="true" />
                </>
              ),
              disabled: true,
              title: 'Панель хранит замеры 30 дней',
            },
          ]}
        />
        {s && <span className="text-[12.5px] text-text-3">{rangeText(s)}</span>}
      </div>

      {stats.isPending ? (
        <StatsSkeleton />
      ) : stats.isError ? (
        <p role="alert" className="rounded-[12px] border border-crit/30 bg-crit-soft px-4 py-3 text-[13px]">
          {apiErrorMessage(stats.error)}{' '}
          <button type="button" className="cursor-pointer underline" onClick={() => void stats.refetch()}>
            Повторить
          </button>
        </p>
      ) : s ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <KpiCard
              label="Трафик за период"
              value={total.value}
              unit={total.unit}
              status={
                s.traffic.total == null
                  ? 'Трафика пока нет'
                  : period === '1' || perDay == null
                    ? `за последние ${duration(coveredMs)}`
                    : `в среднем ${bytes(perDay)} в сутки`
              }
              tone={s.traffic.total == null ? 'muted' : 'info'}
            />
            <KpiCard
              label="Пиковый онлайн"
              value={fmt(s.online.peak)}
              status={
                s.online.peakAt
                  ? new Date(s.online.peakAt).toLocaleString('ru-RU', {
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                      timeZone: s.timeZone,
                    })
                  : 'Замеров пока нет'
              }
              tone={s.online.peak == null ? 'muted' : 'ok'}
            />
            <KpiCard
              label="Средний онлайн"
              value={fmt(s.online.average)}
              status={s.online.minimum == null ? 'Замеров пока нет' : `минимум ${fmt(s.online.minimum)}`}
              tone={s.online.average == null ? 'muted' : 'ok'}
            />
            <KpiCard
              label="Сбои"
              value={s.incidents.count}
              unit={s.incidents.downtimeMs > 0 ? `· ${duration(s.incidents.downtimeMs)}` : undefined}
              status={s.incidents.count || s.incidents.downtimeMs ? 'суммарный простой нод' : 'Сбоев не было'}
              tone={s.incidents.count || s.incidents.downtimeMs ? 'warn' : 'ok'}
            />
            <KpiCard
              label="Оплачено"
              value={billing.data ? rub(billing.data.total.spentRubMinor).replace(/\s?₽$/, '') : '—'}
              unit={billing.data ? '₽' : undefined}
              status={paidLabel}
              tone={billing.data ? 'ok' : 'muted'}
            />
          </div>

          <ChartCard
            title="Трафик по дням"
            sub="ТБ в сутки по поясу панели · трафик пользователей, как в Remnawave"
          >
            {s.traffic.error && (
              <p className="mt-3 rounded-[10px] bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
                {s.traffic.error}
              </p>
            )}
            {s.traffic.days.length === 0 ? (
              !s.traffic.error && (
                <div className="mt-3 grid h-[200px] place-items-center rounded-[12px] border border-dashed border-border text-[12.5px] text-text-3">
                  Трафика за этот период пока нет
                </div>
              )
            ) : (
              <TrafficBars stats={s} />
            )}
          </ChartCard>

          <div className="grid gap-3 lg:grid-cols-2">
            <ChartCard
              title="Онлайн за период"
              sub={`средний по ${s.online.bucketSeconds >= 3600 ? `${s.online.bucketSeconds / 3600} ч` : `${s.online.bucketSeconds / 60} мин`}, сумма по нодам`}
              value={fmt(s.online.peak)}
              valueSub={s.online.peak == null ? undefined : 'пик за период'}
            >
              <MetricArea
                height={200}
                times={s.online.series.map((p) => p.t)}
                yMin={0}
                series={[
                  {
                    key: 'online',
                    name: 'Онлайн',
                    color: 'var(--ns-accent)',
                    values: s.online.series.map((p) => (p.v == null ? null : Math.round(p.v))),
                  },
                ]}
              />
            </ChartCard>
            <ChartCard
              title="Онлайн по часам суток"
              sub={
                s.heatmap.days >= 28
                  ? 'средний за последние 4 недели'
                  : `средний по ${s.heatmap.days} ${plural(s.heatmap.days, 'дню', 'дням', 'дням')} истории`
              }
            >
              <HourHeatmap heat={s.heatmap} />
            </ChartCard>
          </div>

          <NodesTable stats={s} onOpen={setSelected} />
          {s.collectedSince && (
            <p className="text-[12px] text-text-3">
              Онлайн, время на связи и часы пика — по замерам панели с{' '}
              {new Date(s.collectedSince).toLocaleString('ru-RU', {
                day: 'numeric',
                month: 'long',
                timeZone: s.timeZone,
              })}
              ; хранятся 30 дней. Трафик — трафик пользователей, как в Remnawave: панель считает его каждую
              минуту по суткам своего пояса
              {s.traffic.days.some((d) => d.source === 'remnawave')
                ? ', а сутки до начала её замеров — итоги Remnawave по Гринвичу'
                : ''}
              .
            </p>
          )}
        </>
      ) : null}
      {selectedNode && <NodeDialog node={selectedNode} stale={false} onClose={() => setSelected(null)} />}
    </div>
  );
}
