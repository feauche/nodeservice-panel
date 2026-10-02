import type { MetricPoint, MetricRange } from '@nodeservice/shared';
import { ActivityIcon } from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

const time = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

const values = (points: MetricPoint[]) => points.map((p) => p.v).filter((v): v is number => v !== null);
const percentile = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? null;
};

export function NodeOnlineChart({
  name,
  points,
  range,
  incidentAt,
  compact = false,
}: {
  name: string;
  points: MetricPoint[];
  range: MetricRange;
  incidentAt?: string;
  compact?: boolean;
}) {
  const xs = values(points);
  const current = xs.at(-1) ?? null;
  const low = percentile(xs, 0.2);
  const high = percentile(xs, 0.8);
  const data = points.map((p) => ({ t: p.t * 1000, online: p.v }));
  const typical =
    low === null || high === null
      ? '—'
      : low === high
        ? `${Math.round(low)}`
        : `${Math.round(low)}–${Math.round(high)}`;

  return (
    <section className="rounded-2xl border border-border bg-surface p-4" data-testid="node-online-chart">
      <div className="flex flex-wrap items-start gap-x-8 gap-y-2">
        <div className="min-w-0 flex-1">
          <h3 className="m-0 text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase">
            Онлайн ноды
          </h3>
          <p className="mt-0.5 truncate text-[12px] text-text-3">{name}</p>
        </div>
        <div className="flex gap-7 text-right">
          <div>
            <span className="block text-[10.5px] font-semibold tracking-[0.06em] text-text-3 uppercase">
              Сейчас
            </span>
            <b className="font-heading text-[20px] tabular-nums">
              {current === null ? '—' : Math.round(current)}
            </b>
          </div>
          <div>
            <span className="block text-[10.5px] font-semibold tracking-[0.06em] text-text-3 uppercase">
              Обычно
            </span>
            <b className="font-heading text-[20px] tabular-nums">{typical}</b>
          </div>
        </div>
      </div>
      <div className={compact ? 'mt-2 h-[126px]' : 'mt-3 h-[190px]'}>
        {data.length === 0 ? (
          <div className="grid h-full place-items-center text-center text-[12.5px] text-text-3">
            <span>
              <ActivityIcon className="mx-auto mb-1.5 size-4" aria-hidden="true" />
              История онлайна ещё не накопилась.
            </span>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="nodeOnlineFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="var(--ns-accent)" stopOpacity=".28" />
                  <stop offset="1" stopColor="var(--ns-accent)" stopOpacity=".02" />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--ns-hairline)" vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                domain={['dataMin', 'dataMax']}
                tickFormatter={(v: number) =>
                  range === '7d' ? time.format(v).slice(0, 5) : time.format(v).slice(7)
                }
                minTickGap={50}
                tickLine={false}
                axisLine={false}
                tick={{ fill: 'var(--ns-text-3)', fontSize: 10.5 }}
              />
              <YAxis
                width={42}
                domain={[0, 'auto']}
                tickLine={false}
                axisLine={false}
                tick={{ fill: 'var(--ns-text-3)', fontSize: 10.5 }}
              />
              <Tooltip
                labelFormatter={(v) => time.format(Number(v))}
                formatter={(v) => [Math.round(Number(v)), 'онлайн']}
                contentStyle={{
                  background: 'var(--ns-surface-2)',
                  border: '1px solid var(--ns-border)',
                  borderRadius: 9,
                  fontSize: 12,
                }}
              />
              {incidentAt && (
                <ReferenceLine
                  x={Date.parse(incidentAt)}
                  stroke="var(--ns-crit)"
                  strokeDasharray="4 4"
                  label={{ value: 'инцидент', fill: 'var(--ns-crit)', fontSize: 10 }}
                />
              )}
              <Area
                dataKey="online"
                stroke="var(--ns-accent)"
                fill="url(#nodeOnlineFill)"
                strokeWidth={2}
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}
