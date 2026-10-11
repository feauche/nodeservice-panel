import { nodeMetricsSchema } from '@nodeservice/shared';
import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '@/lib/api';
export function useNodeMetrics(minutes = 60, days = 30) {
  return useQuery({
    queryKey: ['nodes', 'metrics', minutes, days],
    queryFn: ({ signal }) =>
      api.get(`/nodes/metrics?minutes=${minutes}&days=${days}`, nodeMetricsSchema, signal),
    refetchInterval: 15000,
    staleTime: 10000,
  });
}
export function NodeMetricChart({
  title,
  value,
  data,
  unit = '',
  color = 'var(--ns-accent)',
  percent = false,
}: {
  title: string;
  value: string;
  data: { t: number; v: number | null }[];
  unit?: string;
  color?: string;
  percent?: boolean;
}) {
  const id = useId().replaceAll(':', '');
  const valid = data.some((p) => p.v !== null);
  return (
    <section className="min-w-0 rounded-2xl border border-border bg-surface p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-text-2 uppercase">{title}</h3>
        <strong className="text-2xl tabular-nums">{value}</strong>
      </div>
      <div className="h-[200px] min-w-0">
        {valid ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ left: 0, right: 8, top: 8, bottom: 0 }}>
              <defs>
                <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.22} />
                  <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="var(--ns-border)" />
              <XAxis
                dataKey="t"
                type="number"
                domain={['dataMin', 'dataMax']}
                tickFormatter={(t) =>
                  data.length > 1 && (data.at(-1)?.t ?? 0) - data[0].t > 86400000
                    ? new Date(t).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })
                    : new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
                }
                minTickGap={35}
                tick={{ fill: 'var(--ns-text-3)', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                width={42}
                domain={percent ? [0, 100] : ['auto', 'auto']}
                tick={{ fill: 'var(--ns-text-3)', fontSize: 11 }}
                tickFormatter={(n) => Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                contentStyle={{
                  background: 'var(--ns-surface)',
                  border: '1px solid var(--ns-border)',
                  borderRadius: 10,
                  fontSize: 12,
                }}
                labelFormatter={(t) => new Date(Number(t)).toLocaleString('ru-RU')}
                formatter={(v) => [
                  `${Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 2 })}${unit}`,
                  title,
                ]}
              />
              <Area
                type="linear"
                dataKey="v"
                stroke={color}
                strokeWidth={2}
                fill={`url(#${id})`}
                connectNulls={false}
                isAnimationActive={false}
                dot={data.length < 3 ? { r: 3 } : false}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-full items-center justify-center text-center text-xs text-text-3">
            Замеры за этот период ещё не получены
          </div>
        )}
      </div>
      {valid && data.some((p) => p.v === null) && (
        <p className="mt-2 text-[11px] text-text-3">
          Разрыв линии — нет сохранённого замера за этот интервал.
        </p>
      )}
    </section>
  );
}
