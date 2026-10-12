import { useId } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ChartSkeleton } from '@/components/ui/loading-state';

export interface AreaSeries {
  key: string;
  name: string;
  color: string;
  values: Array<number | null>;
}

const num = (v: number, digits = 1) => v.toLocaleString('ru-RU', { maximumFractionDigits: digits });

/** Подписи времени: на графике длиннее суток — дата, короче — часы и минуты. */
function timeLabel(t: number, long: boolean, withTime = false) {
  const d = new Date(t);
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (!long) return time;
  const day = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  return withTime ? `${day}, ${time}` : day;
}

/**
 * Перерывы в данных: подряд идущие точки, где нет ни одного значения. Одиночный пропуск сервер уже дорисовал,
 * так что пустая точка здесь — настоящий перерыв. Полоса тянется от последней точки с данными до следующей.
 */
export function gapRanges(times: number[], series: AreaSeries[]): Array<[number, number]> {
  const empty = (i: number) => series.every((s) => s.values[i] == null);
  const out: Array<[number, number]> = [];
  let i = 0;
  while (i < times.length) {
    if (!empty(i)) {
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < times.length && empty(j + 1)) j += 1;
    const from = times[Math.max(0, i - 1)];
    const to = times[Math.min(times.length - 1, j + 1)];
    if (from != null && to != null && to > from) out.push([from, to]);
    i = j + 1;
  }
  return out;
}

type TipEntry = { dataKey?: unknown; name?: unknown; value?: unknown; color?: string };

function ChartTip({
  active,
  payload,
  label,
  long,
  unit,
  format,
}: {
  active?: boolean;
  payload?: ReadonlyArray<TipEntry>;
  label?: unknown;
  long: boolean;
  unit: string;
  format: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="min-w-[150px] rounded-[10px] border border-border-2 bg-surface px-3 py-2 text-[12px] shadow-float">
      <div className="mb-1 text-text-3">{timeLabel(Number(label), long, true)}</div>
      {payload.map((p) => (
        <div key={String(p.dataKey)} className="flex items-center gap-2">
          <span
            className="size-2 flex-none rounded-full"
            style={{ background: p.color }}
            aria-hidden="true"
          />
          <span className="flex-1 text-text-2">{String(p.name ?? '')}</span>
          <b className="tabular-nums">{p.value == null ? '—' : `${format(Number(p.value))}${unit}`}</b>
        </div>
      ))}
    </div>
  );
}

/**
 * График показателя во времени: одна или две линии с мягкой заливкой, подсказка при наведении, серая полоса
 * «нет данных» на месте настоящих перерывов. Пустой ряд — сообщение, а не пустые оси.
 */
export function MetricArea({
  times,
  series,
  height = 170,
  unit = '',
  format = (v) => num(v),
  yMin = 'auto',
  yMax = 'auto',
  loading = false,
  empty = 'Замеры за этот период ещё не получены',
}: {
  times: number[];
  series: AreaSeries[];
  height?: number;
  unit?: string;
  format?: (v: number) => string;
  yMin?: number | 'auto';
  yMax?: number | 'auto';
  loading?: boolean;
  empty?: string;
}) {
  const id = useId().replaceAll(':', '');
  if (loading)
    return (
      <div style={{ height }} className="mt-2.5">
        <ChartSkeleton />
      </div>
    );
  const valid = series.some((s) => s.values.some((v) => v != null));
  if (!valid)
    return (
      <div
        style={{ height }}
        className="mt-2.5 grid place-items-center rounded-[12px] border border-dashed border-border text-center text-[12.5px] text-text-3"
      >
        {empty}
      </div>
    );
  const data = times.map((t, i) =>
    Object.fromEntries([['t', t], ...series.map((s) => [s.key, s.values[i]])]),
  );
  const long = times.length > 1 && (times.at(-1) ?? 0) - (times[0] ?? 0) > 36 * 3_600_000;
  const gaps = gapRanges(times, series);
  return (
    <div style={{ height }} className="mt-2.5 min-w-0">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ left: 0, right: 6, top: 6, bottom: 0 }}>
          <defs>
            {series.map((s) => (
              <linearGradient key={s.key} id={`${id}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity={0.2} />
                <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid vertical={false} stroke="var(--ns-border)" />
          {gaps.map(([x1, x2]) => (
            <ReferenceArea
              key={x1}
              x1={x1}
              x2={x2}
              fill="var(--ns-text-3)"
              fillOpacity={0.08}
              ifOverflow="hidden"
              label={{ value: 'нет данных', position: 'insideTop', fill: 'var(--ns-text-3)', fontSize: 10.5 }}
            />
          ))}
          <XAxis
            dataKey="t"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(t) => timeLabel(Number(t), long)}
            minTickGap={40}
            tick={{ fill: 'var(--ns-text-3)', fontSize: 10.5 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            width={44}
            domain={[yMin, yMax]}
            tick={{ fill: 'var(--ns-text-3)', fontSize: 10.5 }}
            tickFormatter={(n) => format(Number(n))}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            cursor={{ stroke: 'var(--ns-text-3)', strokeDasharray: '3 3' }}
            content={({ active, payload, label }) => (
              <ChartTip
                active={active}
                payload={payload as ReadonlyArray<TipEntry> | undefined}
                label={label}
                long={long}
                unit={unit}
                format={format}
              />
            )}
          />
          {series.map((s) => (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.name}
              stroke={s.color}
              strokeWidth={2}
              fill={`url(#${id}-${s.key})`}
              connectNulls={false}
              isAnimationActive={false}
              dot={false}
              activeDot={{ r: 3.5, strokeWidth: 0 }}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
