import { actionMeta, INCIDENT_CHART_LABELS, INCIDENT_CHART_METRIC, type Incident } from '@nodeservice/shared';
import { useMemo } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { useServerMetrics } from '@/features/servers/server-detail/metrics-api';
import { cn } from '@/lib/utils';
import { buildGeometry, CHART_H, CHART_W, chartMarkers, chartRange, pctSeries } from './analysis-chart-data';
import { useIncidentsSettings } from './incidents-settings-api';

const THRESHOLD_KEY = { cpuPct: 'cpuPct', memPct: 'memPct', diskPct: 'diskPct' } as const;
const RANGE_LABEL = { '1h': 'последний час', '24h': 'последние сутки', '7d': 'последние 7 дней' } as const;

/** Не у каждого инцидента есть что нарисовать: только нагрузка и место. */
export const hasAnalysisChart = (inc: Pick<Incident, 'kind' | 'serverId'>): boolean =>
  INCIDENT_CHART_METRIC[inc.kind] !== undefined && inc.serverId !== null;

/**
 * График-доказательство: метрика за окно вокруг инцидента, порог, момент открытия и попытки починки.
 * Текста внутри SVG нет: он растягивается по ширине, а подписи должны оставаться читаемыми на телефоне.
 */
export function AnalysisChart({ incident }: { incident: Incident }) {
  const metric = INCIDENT_CHART_METRIC[incident.kind];
  const range = useMemo(() => chartRange(incident.openedAt, Date.now()), [incident.openedAt]);
  const q = useServerMetrics(
    incident.serverId ?? '',
    range,
    metric !== undefined && incident.serverId !== null,
  );
  const settings = useIncidentsSettings();
  if (!metric) return null;

  const points = q.data ? pctSeries(metric, q.data.series) : [];
  const threshold = settings.data ? settings.data[THRESHOLD_KEY[metric]] : null;
  const geo = buildGeometry(points, threshold);
  const name = INCIDENT_CHART_LABELS[metric];

  if (q.isPending || (settings.isPending && !q.isError))
    return <Skeleton data-testid="analysis-chart-skeleton" className="h-[176px] rounded-[12px]" />;
  if (q.isError || !q.data?.vmOk || !geo)
    return (
      <p className="rounded-[12px] border border-border bg-surface-2 px-3.5 py-3 text-[12.5px] text-text-3">
        Истории метрики нет: хранилище недоступно или агент ещё не присылал данные.
      </p>
    );

  const last = points.at(-1)?.v ?? 0;
  const first = points[0]?.v ?? 0;
  const markers = chartMarkers(incident, geo.xOf, (k) => actionMeta(k).title);
  return (
    <figure
      data-testid="analysis-chart"
      className="m-0 rounded-[12px] border border-border bg-surface-2 px-3 pt-2.5 pb-2.5"
    >
      <figcaption className="mb-1.5 flex items-baseline gap-2 text-[12.5px]">
        <b className="font-semibold">{name}</b>
        <span className="text-text-3">{RANGE_LABEL[range]}</span>
        <span
          className={cn(
            'ml-auto rounded-full px-2 py-px text-[11.5px] font-semibold tabular-nums',
            threshold !== null && last >= threshold ? 'bg-crit-soft text-crit' : 'bg-surface-3 text-text-2',
          )}
        >
          {Math.round(last)} %
        </span>
      </figcaption>
      <div className="relative">
        <svg
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`${name}: от ${Math.round(first)} % до ${Math.round(last)} % за ${RANGE_LABEL[range]}`}
          className="block h-[116px] w-full overflow-visible"
        >
          <path d={geo.area} className="fill-brand-soft" />
          {markers.map((m) => (
            <line
              key={m.key}
              x1={m.x}
              x2={m.x}
              y1={0}
              y2={CHART_H}
              className="stroke-border-2"
              strokeWidth={1}
              strokeDasharray="2 3"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {geo.thresholdTop !== null && (
            <line
              x1={0}
              x2={CHART_W}
              y1={(geo.thresholdTop / 100) * CHART_H}
              y2={(geo.thresholdTop / 100) * CHART_H}
              className="stroke-warn"
              strokeWidth={1}
              strokeDasharray="4 4"
              vectorEffect="non-scaling-stroke"
            />
          )}
          <path
            d={geo.line}
            fill="none"
            className="stroke-brand"
            strokeWidth={2}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {geo.thresholdTop !== null && threshold !== null && (
          <span
            className="pointer-events-none absolute left-1 text-[10.5px] leading-none text-warn"
            style={{ top: `calc(${geo.thresholdTop}% - 13px)` }}
          >
            Порог {threshold} %
          </span>
        )}
        <div className="relative mt-1.5 h-[20px]">
          {markers.map((m) => (
            <span
              key={m.key}
              title={m.title}
              className={cn(
                'absolute top-0 grid size-[19px] -translate-x-1/2 place-items-center rounded-full text-[10.5px] font-bold',
                m.kind === 'open' ? 'bg-crit text-white' : 'bg-brand text-cta-foreground',
              )}
              style={{ left: `${m.shown}%` }}
            >
              {m.label}
            </span>
          ))}
        </div>
      </div>
      {markers.length > 0 && (
        <ul className="m-0 mt-1.5 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[11.5px] text-text-3">
          {markers.map((m) => (
            <li key={m.key} className="flex items-center gap-1.5">
              <span
                className={cn(
                  'grid size-[15px] place-items-center rounded-full text-[9.5px] font-bold',
                  m.kind === 'open' ? 'bg-crit text-white' : 'bg-brand text-cta-foreground',
                )}
              >
                {m.label}
              </span>
              {m.kind === 'open' ? 'Открыт' : m.title}
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}
