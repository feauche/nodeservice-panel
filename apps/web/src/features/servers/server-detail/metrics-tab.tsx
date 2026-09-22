import { METRIC_RANGES, type MetricPoint, type MetricRange } from '@nodeservice/shared';
import { ActivityIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Tooltip as ChartTooltip,
  Line,
  LineChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';

import { cn } from '@/lib/utils';
import { useServerMetrics } from './metrics-api';

const RANGES: Array<{ key: MetricRange; label: string }> = [
  { key: '1h', label: '1 час' },
  { key: '24h', label: '24 часа' },
  { key: '7d', label: '7 дней' },
];

const timeShort = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const dayShort = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' });

const fmtAxisTime = (range: MetricRange) => (ms: number) =>
  range === '7d' ? dayShort.format(ms) : timeShort.format(ms);

const fmtPct = (v: number) => `${Math.round(v)}%`;
const fmtMbit = (v: number) => `${((v * 8) / 1_000_000).toFixed(1)} Мбит/с`;
const fmtInt = (v: number) => String(Math.round(v));

function lastValue(points: MetricPoint[]): number | null {
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const v = points[i]?.v;
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

export function MetricsTab({
  serverId,
  range,
  onRange,
}: {
  serverId: string;
  range: MetricRange;
  onRange: (r: MetricRange) => void;
}) {
  const metrics = useServerMetrics(serverId, range);
  const d = metrics.data;
  const series = d?.series;
  const net =
    series && series.netRxBps.map((p, i) => ({ t: p.t * 1000, rx: p.v, tx: series.netTxBps[i]?.v ?? null }));
  const memPct =
    series?.memUsedMb.map((p, i) => {
      const total = series.memTotalMb[i]?.v;
      return { t: p.t, v: p.v !== null && total ? (p.v / total) * 100 : null };
    }) ?? [];
  const diskPct =
    series?.diskUsedMb.map((p, i) => {
      const total = series.diskTotalMb[i]?.v;
      return { t: p.t, v: p.v !== null && total ? (p.v / total) * 100 : null };
    }) ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <fieldset className="m-0 flex h-9 w-fit items-center rounded-[10px] border border-border bg-surface p-[3px]">
          <legend className="sr-only">Диапазон графиков</legend>
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              aria-pressed={range === r.key}
              onClick={() => onRange(r.key)}
              className={cn(
                'h-full cursor-pointer rounded-[7px] px-3 text-[12px] font-medium text-text-3 transition-colors hover:text-foreground',
                range === r.key && 'bg-surface-3 text-foreground',
              )}
            >
              {r.label}
            </button>
          ))}
        </fieldset>
        <span className="text-[11.5px] text-text-3">
          {range === '1h' ? 'обновляется каждые 15 с · ' : ''}
          шаг {d?.stepSeconds ?? METRIC_RANGES[range].stepSeconds} с
        </span>
      </div>
      {d && !d.vmOk && (
        <p className="rounded-[12px] border border-warn/30 bg-warn-soft px-4 py-2.5 text-[12.5px]">
          Хранилище метрик (VictoriaMetrics) сейчас недоступно — графики могут быть неполными.
        </p>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        <MetricPanel
          title="Процессор"
          current={fmtOrDash(lastValue(series?.cpuPct ?? []), fmtPct)}
          pct={lastValue(series?.cpuPct ?? [])}
          empty={!series || series.cpuPct.length === 0}
        >
          <AreaMetric
            points={series?.cpuPct ?? []}
            color="var(--ns-accent)"
            range={range}
            unit="%"
            max={100}
          />
        </MetricPanel>
        <MetricPanel
          title="Память"
          current={fmtOrDash(lastValue(memPct), fmtPct)}
          pct={lastValue(memPct)}
          empty={memPct.length === 0}
        >
          <AreaMetric points={memPct} color="var(--ns-teal)" range={range} unit="%" max={100} />
        </MetricPanel>
        <MetricPanel
          title="Диск"
          current={fmtOrDash(lastValue(diskPct), fmtPct)}
          pct={lastValue(diskPct)}
          empty={diskPct.length === 0}
        >
          <AreaMetric points={diskPct} color="var(--ns-warn)" range={range} unit="%" max={100} />
        </MetricPanel>
        <MetricPanel
          title="Сеть"
          current={fmtOrDash(lastValue(series?.netRxBps ?? []), fmtMbit)}
          empty={!net || net.length === 0}
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={net ?? []} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--ns-hairline)" vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                domain={['dataMin', 'dataMax']}
                tickFormatter={fmtAxisTime(range)}
                minTickGap={48}
                tickLine={false}
                axisLine={false}
                tick={{ fill: 'var(--ns-text-3)', fontSize: 10.5 }}
              />
              <YAxis
                width={44}
                tickFormatter={(v: number) => `${((v * 8) / 1_000_000).toFixed(0)}М`}
                tickLine={false}
                axisLine={false}
                tick={{ fill: 'var(--ns-text-3)', fontSize: 10.5 }}
              />
              <ChartTooltip content={<NetTip range={range} />} />
              <Line
                dataKey="rx"
                name="входящий"
                stroke="var(--ns-accent)"
                strokeWidth={1.6}
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
              <Line
                dataKey="tx"
                name="исходящий"
                stroke="var(--ns-teal)"
                strokeWidth={1.6}
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        </MetricPanel>
        <MetricPanel
          title="Load average"
          current={fmtOrDash(lastValue(series?.load1 ?? []), (v) => v.toFixed(2))}
          empty={!series || series.load1.length === 0}
        >
          <AreaMetric points={series?.load1 ?? []} color="var(--ns-accent)" range={range} unit="" />
        </MetricPanel>
        <MetricPanel
          title="Conntrack"
          current={fmtOrDash(lastValue(series?.conntrackCount ?? []), fmtInt)}
          empty={!series || series.conntrackCount.length === 0}
        >
          <AreaMetric
            points={series?.conntrackCount ?? []}
            color="var(--ns-chart-base, #7d8797)"
            range={range}
            unit=""
          />
        </MetricPanel>
      </div>
    </div>
  );
}

const fmtOrDash = (v: number | null, f: (v: number) => string) => (v === null ? '—' : f(v));

function MetricPanel({
  title,
  current,
  empty,
  pct,
  children,
}: {
  title: string;
  current: string;
  empty: boolean;
  /** Для процентных метрик — тонкий индикатор текущего уровня под заголовком. */
  pct?: number | null;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase">{title}</h3>
        <span className="font-heading text-[17px] font-bold tabular-nums">{current}</span>
      </div>
      {pct !== undefined && pct !== null && !empty && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
          <div
            className={cn('h-full rounded-full', pct > 90 ? 'bg-crit' : pct > 75 ? 'bg-warn' : 'bg-ok')}
            style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
          />
        </div>
      )}
      <div className="mt-2 h-[170px]">
        {empty ? (
          <div className="grid h-full place-items-center">
            <div className="flex flex-col items-center gap-1.5 text-center">
              <span className="grid size-9 place-items-center rounded-full bg-surface-2 text-text-3">
                <ActivityIcon className="size-4" aria-hidden="true" />
              </span>
              <p className="text-[13px] font-semibold">Пока нет данных</p>
              <p className="text-[12px] text-text-3">Появятся, когда агент выйдет на связь.</p>
            </div>
          </div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

function AreaMetric({
  points,
  color,
  range,
  unit,
  max,
}: {
  points: MetricPoint[];
  color: string;
  range: MetricRange;
  unit: string;
  max?: number;
}) {
  const data = points.map((p) => ({ t: p.t * 1000, v: p.v }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--ns-hairline)" vertical={false} />
        <XAxis
          dataKey="t"
          type="number"
          domain={['dataMin', 'dataMax']}
          tickFormatter={fmtAxisTime(range)}
          minTickGap={48}
          tickLine={false}
          axisLine={false}
          tick={{ fill: 'var(--ns-text-3)', fontSize: 10.5 }}
        />
        <YAxis
          width={38}
          domain={max ? [0, max] : ['auto', 'auto']}
          tickLine={false}
          axisLine={false}
          tick={{ fill: 'var(--ns-text-3)', fontSize: 10.5 }}
        />
        <ChartTooltip content={<ValueTip range={range} unit={unit} />} />
        <Area
          dataKey="v"
          stroke={color}
          fill={color}
          fillOpacity={0.14}
          strokeWidth={1.6}
          dot={false}
          isAnimationActive={false}
          connectNulls
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

interface TipProps {
  active?: boolean;
  label?: number;
  payload?: Array<{ value: number | null; name?: string; stroke?: string }>;
  range: MetricRange;
}

function TipShell({ label, range, children }: { label?: number; range: MetricRange; children: ReactNode }) {
  return (
    <div className="rounded-[9px] border border-border-2 bg-surface-2 px-2.5 py-1.5 text-[11.5px] shadow-float">
      <div className="text-text-3">{label ? fmtAxisTime(range)(label) : ''}</div>
      {children}
    </div>
  );
}

function ValueTip({ active, label, payload, range, unit }: TipProps & { unit: string }) {
  if (!active || !payload?.length) return null;
  const v = payload[0]?.value;
  return (
    <TipShell label={label} range={range}>
      <div className="font-semibold tabular-nums">
        {v === null || v === undefined ? '—' : `${Math.round(v * 100) / 100}${unit}`}
      </div>
    </TipShell>
  );
}

function NetTip({ active, label, payload, range }: TipProps) {
  if (!active || !payload?.length) return null;
  return (
    <TipShell label={label} range={range}>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-1.5 tabular-nums">
          <span className="size-2 rounded-full" style={{ background: p.stroke }} aria-hidden="true" />
          {p.name}: {p.value === null || p.value === undefined ? '—' : fmtMbit(p.value)}
        </div>
      ))}
    </TipShell>
  );
}
