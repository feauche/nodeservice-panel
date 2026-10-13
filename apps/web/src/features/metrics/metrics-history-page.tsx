import { nodeMetricHistorySchema } from '@nodeservice/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  CalendarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  RadarIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  TriangleAlertIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CountryFlag } from '@/components/country-flag';
import { KpiCard, KpiCardSkeleton } from '@/components/kpi-card';
import { gapRanges } from '@/components/metric-area';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ChartSkeleton, RowsSkeleton } from '@/components/ui/loading-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useIncidents } from '@/features/incidents/incidents-api';
import { useNodeLayout, useNodes } from '@/features/nodes/nodes-api';
import { CardButton, Segmented } from '@/features/settings/settings-ui';
import { api, apiErrorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  buildRows,
  eventTone,
  groupEvents,
  type HistoryEvent,
  METRICS,
  type Metric,
  nodeColor,
  seriesStats,
} from './metrics-math';

type Range = { from: number; to: number };
type Period = 'hour' | '1' | '7' | '30' | 'custom';
const PERIOD_MS: Record<Exclude<Period, 'custom'>, number> = {
  hour: 3_600_000,
  '1': 86_400_000,
  '7': 7 * 86_400_000,
  '30': 30 * 86_400_000,
};
/** Отступы области графика: подписи значений слева, поле справа. По ним же ставятся метки событий. */
const Y_AXIS = 52;
const RIGHT = 12;

const dateLabel = (t: number) =>
  new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const localInput = (t: number) => {
  const d = new Date(t);
  return new Date(t - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const fmt = (v: number | null | undefined, digits = 0) =>
  v == null ? '—' : v.toLocaleString('ru-RU', { maximumFractionDigits: digits });

function useHistory(range: Range, maxPoints: number, keep: boolean) {
  return useQuery({
    queryKey: ['metrics-history', range.from, range.to, maxPoints],
    queryFn: ({ signal }) =>
      api.get(
        `/nodes/metrics/history?${new URLSearchParams({
          from: new Date(range.from).toISOString(),
          to: new Date(range.to).toISOString(),
          maxPoints: String(maxPoints),
        })}`,
        nodeMetricHistorySchema,
        signal,
      ),
    staleTime: 60_000,
    // При приближении и сдвиге старый график остаётся на месте, пока грузится новый.
    ...(keep ? { placeholderData: keepPreviousData } : {}),
  });
}

const BTN =
  'inline-flex h-10 cursor-pointer items-center justify-center gap-1.5 rounded-[10px] border border-border bg-surface px-3 text-[13px] font-medium whitespace-nowrap text-text-2 transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand disabled:cursor-default disabled:opacity-50 [&_svg]:size-4';
const SQ =
  'grid size-9 cursor-pointer place-items-center rounded-[10px] border border-border bg-surface text-text-2 transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand [&_svg]:size-4';

function EventIcon({ e, className }: { e: HistoryEvent; className?: string }) {
  const tone = eventTone(e);
  const Icon = tone === 'crit' ? TriangleAlertIcon : tone === 'ok' ? CircleCheckIcon : RadarIcon;
  return (
    <span
      className={cn(
        'grid size-9 flex-none place-items-center rounded-full',
        tone === 'crit'
          ? 'bg-crit-soft text-crit'
          : tone === 'ok'
            ? 'bg-ok-soft text-ok'
            : 'bg-brand-soft text-brand',
        className,
      )}
      aria-hidden="true"
    >
      <Icon className="size-4" />
    </span>
  );
}

/** Подсказка графика: время и ноды по убыванию значения. */
function SortedTip({
  active,
  payload,
  label,
  unit,
  names,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ dataKey?: unknown; value?: unknown; color?: string }>;
  label?: unknown;
  unit: string;
  names: Map<string, string>;
}) {
  if (!active || !payload?.length) return null;
  const rows = payload.filter((p) => p.value != null).sort((a, b) => Number(b.value) - Number(a.value));
  if (!rows.length) return null;
  return (
    <div className="max-h-[280px] min-w-[200px] overflow-hidden rounded-[10px] border border-border-2 bg-surface px-3 py-2 text-[12px] shadow-float">
      <div className="mb-1 text-text-3">{dateLabel(Number(label))}</div>
      {rows.slice(0, 12).map((p) => (
        <div key={String(p.dataKey)} className="flex items-center gap-2">
          <span
            className="size-2 flex-none rounded-full"
            style={{ background: p.color }}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate text-text-2">
            {names.get(String(p.dataKey)) ?? 'Весь парк'}
          </span>
          <b className="tabular-nums">
            {fmt(Number(p.value), 1)}
            {unit}
          </b>
        </div>
      ))}
      {rows.length > 12 && <div className="mt-1 text-text-3">…и ещё {rows.length - 12}</div>}
    </div>
  );
}

/** Метки событий над графиком: близкие сливаются в одну с числом, наведение показывает, что случилось. */
function EventLane({
  events,
  range,
  bucketMs,
  onFocus,
}: {
  events: HistoryEvent[];
  range: Range;
  bucketMs: number;
  onFocus: (e: HistoryEvent) => void;
}) {
  const span = range.to - range.from || 1;
  // Сливаем то, что на экране ближе ширины значка: около 2,2 % окна (24 px на обычной ширине), но не меньше двух шагов.
  const groups = groupEvents(events, Math.max(bucketMs * 2, span * 0.022));
  return (
    <fieldset
      className="relative mt-2 h-[26px] min-w-0"
      style={{ marginLeft: Y_AXIS, marginRight: RIGHT }}
      aria-label="События на шкале"
    >
      <span className="absolute inset-x-0 top-1/2 h-px bg-border" aria-hidden="true" />
      {groups.map((g) => {
        const first = g[0] as HistoryEvent;
        const tone = g.some((e) => eventTone(e) === 'crit')
          ? 'crit'
          : g.every((e) => eventTone(e) === 'ok')
            ? 'ok'
            : 'info';
        const pct = Math.min(100, Math.max(0, ((first.t - range.from) / span) * 100));
        const text = g.map((e) => `${dateLabel(e.t)} · ${e.title} · ${e.nodeName}`).join('\n');
        return (
          <button
            key={first.id}
            type="button"
            title={text}
            aria-label={`${g.length > 1 ? `${g.length} события` : first.title}: ${text}`}
            onClick={() => onFocus(first)}
            className={cn(
              'absolute top-[3px] grid h-5 -translate-x-1/2 cursor-pointer place-items-center rounded-full border-[1.6px] bg-surface text-[10px] font-extrabold transition-transform hover:scale-110',
              g.length > 1 ? 'min-w-7 px-1' : 'w-5',
              tone === 'crit'
                ? 'border-crit text-crit'
                : tone === 'ok'
                  ? 'border-ok text-ok'
                  : 'border-brand text-brand',
            )}
            style={{ left: `${pct}%` }}
          >
            {g.length > 1 ? `×${g.length}` : tone === 'ok' ? '✓' : '!'}
          </button>
        );
      })}
    </fieldset>
  );
}

/** Навигатор: весь период мелко, окно графика — рамкой. Рамку можно тянуть, нажатие ставит окно в это место. */
function RangeNavigator({
  full,
  range,
  values,
  onChange,
}: {
  full: Range;
  range: Range;
  values: Array<{ t: number; v: number | null }>;
  onChange: (r: Range) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const span = full.to - full.from || 1;
  const left = ((range.from - full.from) / span) * 100;
  const width = Math.max(1.5, ((range.to - range.from) / span) * 100);
  const nums = values.filter((p): p is { t: number; v: number } => p.v != null);
  // Форма кривой важнее нуля: растягиваем от минимума до максимума, иначе сумма парка — сплошная заливка.
  const lo = nums.length ? Math.min(...nums.map((p) => p.v)) : 0;
  const hi = nums.length ? Math.max(...nums.map((p) => p.v)) : 1;
  const k = hi - lo || 1;
  const path = nums.length
    ? `M${nums.map((p) => `${(((p.t - full.from) / span) * 600).toFixed(1)},${(48 - ((p.v - lo) / k) * 40).toFixed(1)}`).join(' L')}`
    : '';
  const shift = (from: number) => {
    const w = range.to - range.from;
    const start = Math.max(full.from, Math.min(full.to - w, from));
    onChange({ from: start, to: start + w });
  };
  const timeAt = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return full.from;
    return full.from + ((clientX - rect.left) / rect.width) * span;
  };
  return (
    <div
      ref={box}
      className="relative mt-2.5 h-[54px] cursor-pointer overflow-hidden rounded-[10px] border border-border bg-surface-2 select-none"
      style={{ marginLeft: Y_AXIS, marginRight: RIGHT }}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).dataset.window) return;
        shift(timeAt(e.clientX) - (range.to - range.from) / 2);
      }}
      role="presentation"
    >
      {path && (
        <svg
          viewBox="0 0 600 54"
          preserveAspectRatio="none"
          className="absolute inset-0 size-full"
          aria-hidden="true"
        >
          <path d={`${path} L600,54 L0,54 Z`} fill="var(--ns-accent)" opacity="0.18" />
          <path
            d={path}
            fill="none"
            stroke="var(--ns-accent)"
            strokeWidth="1.4"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
      <span
        data-window="1"
        className="absolute inset-y-0 cursor-grab border-x-2 border-brand bg-brand/12 active:cursor-grabbing"
        style={{ left: `${left}%`, width: `${width}%` }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          const startX = e.clientX;
          const startFrom = range.from;
          const rect = box.current?.getBoundingClientRect();
          const move = (ev: PointerEvent) => {
            if (!rect) return;
            shift(startFrom + ((ev.clientX - startX) / rect.width) * span);
          };
          const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        }}
        aria-hidden="true"
      />
    </div>
  );
}

function Section({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cn('min-w-0 overflow-hidden rounded-2xl border border-border bg-surface', className)}>
      {children}
    </section>
  );
}

/**
 * «Метрики» (витрина redesign-2026-10, вариант A): по умолчанию пять нод с наибольшим онлайном, «Весь парк» —
 * отдельным переключателем. Легенда — таблица: нажатие включает и выключает линию. События — метками над
 * графиком и списком по видимому окну. Внизу навигатор по всему периоду.
 */
export function MetricsHistoryPage() {
  const inventory = useNodes();
  const layout = useNodeLayout();
  const incidents = useIncidents('open');
  const [period, setPeriod] = useState<Period>('1');
  const [full, setFull] = useState<Range>(() => ({ from: Date.now() - PERIOD_MS['1'], to: Date.now() }));
  const [range, setRange] = useState<Range>(full);
  const [metric, setMetric] = useState<Metric>('online');
  const [selected, setSelected] = useState<string[] | null>(null);
  const [preset, setPreset] = useState<string>('top');
  const [fleetMode, setFleetMode] = useState(false);
  const [drag, setDrag] = useState<{ start: number; end: number } | null>(null);
  const [focused, setFocused] = useState<HistoryEvent | null>(null);
  const [eventPage, setEventPage] = useState(1);
  const [eventSize, setEventSize] = useState('10');
  const [dates, setDates] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [dateError, setDateError] = useState('');
  const chartBox = useRef<HTMLDivElement>(null);
  // Около 480 точек на окно: сутки — шаг 3 минуты, линии читаются; приближение даёт поминутные замеры.
  const view = useHistory(range, 480, true);
  const overview = useHistory(full, 300, false);

  const all = inventory.data?.nodes ?? [];
  const cores = useMemo(() => new Map(all.map((n) => [n.uuid, n.cpuCount ?? null])), [all]);
  const order = useMemo(
    () => new Map([...all].sort((a, b) => a.uuid.localeCompare(b.uuid)).map((n, i) => [n.uuid, i])),
    [all],
  );
  const colorOf = (uuid: string) => nodeColor(order.get(uuid) ?? 0);
  const names = useMemo(() => new Map(all.map((n) => [n.uuid, n.name])), [all]);
  const top5 = useMemo(
    () =>
      [...all]
        .filter((n) => !n.isDisabled)
        .sort((a, b) => (b.usersOnline ?? 0) - (a.usersOnline ?? 0))
        .slice(0, 5)
        .map((n) => n.uuid),
    [all],
  );
  const failing = useMemo(() => {
    const open = new Set(
      (incidents.data?.items ?? [])
        .filter((i) => i.status !== 'resolved' && i.nodeUuid)
        .map((i) => i.nodeUuid as string),
    );
    return all.filter((n) => open.has(n.uuid) || (!n.isConnected && !n.isDisabled)).map((n) => n.uuid);
  }, [all, incidents.data]);
  const shown = selected ?? top5;
  const historyNodes = view.data?.nodes ?? [];
  const rows = useMemo(() => buildRows(historyNodes, metric, cores), [historyNodes, metric, cores]);
  const navRows = useMemo(
    () =>
      buildRows(overview.data?.nodes ?? [], metric, cores).map((r) => ({
        t: Number(r.t),
        v: r.fleet ?? null,
      })),
    [overview.data, metric, cores],
  );
  const unit = METRICS[metric].unit;
  const events = useMemo(
    () => [...(view.data?.events ?? [])].sort((a, b) => b.t - a.t || a.id.localeCompare(b.id)),
    [view.data],
  );
  const pages = Math.max(1, Math.ceil(events.length / Number(eventSize)));
  const page = Math.min(eventPage, pages);
  const eventRows = events.slice((page - 1) * Number(eventSize), page * Number(eventSize));
  const lines = fleetMode ? ['fleet'] : shown.filter((id) => historyNodes.some((n) => n.uuid === id));
  const gaps = gapRanges(
    rows.map((r) => Number(r.t)),
    lines.map((key) => ({ key, name: key, color: '', values: rows.map((r) => r[key] ?? null) })),
  );
  const fleet = seriesStats(rows, 'fleet');
  const summary = view.data?.onlineSummary;

  // biome-ignore lint/correctness/useExhaustiveDependencies: список событий начинается с первой страницы при смене окна
  useEffect(() => setEventPage(1), [range.from, range.to]);

  const choose = (r: Range) => {
    setRange(r);
    setDrag(null);
  };
  const applyPeriod = (p: Exclude<Period, 'custom'>) => {
    setPeriod(p);
    const r = { from: Date.now() - PERIOD_MS[p], to: Date.now() };
    setFull(r);
    setFocused(null);
    choose(r);
  };
  const zoom = (factor: number, at?: number) => {
    const spanNow = range.to - range.from;
    const next = Math.min(full.to - full.from, Math.max(5 * 60_000, spanNow * factor));
    const center = at ?? (range.from + range.to) / 2;
    const ratio = at == null ? 0.5 : (at - range.from) / spanNow;
    let start = center - next * ratio;
    start = Math.max(full.from, Math.min(full.to - next, start));
    choose({ from: start, to: start + next });
  };
  const move = (direction: number) => {
    const spanNow = range.to - range.from;
    const start = Math.max(full.from, Math.min(full.to - spanNow, range.from + (direction * spanNow) / 2));
    choose({ from: start, to: start + spanNow });
  };
  const focusEvent = (e: HistoryEvent) => {
    setFocused(e);
    choose({ from: Math.max(full.from, e.t - 15 * 60_000), to: Math.min(full.to, e.t + 15 * 60_000) });
    chartBox.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const toggle = (uuid: string) => {
    const base = shown;
    setSelected(base.includes(uuid) ? base.filter((x) => x !== uuid) : [...base, uuid]);
    setPreset('');
    setFleetMode(false);
  };
  const applyPreset = (key: string) => {
    setFleetMode(false);
    setPreset(key);
    if (key === 'top') setSelected(null);
    else if (key === 'bad') setSelected(failing);
    else if (key === 'all') setSelected(all.map((n) => n.uuid));
    else if (key.startsWith('folder:')) {
      const id = key.slice('folder:'.length);
      setSelected(all.filter((n) => layout.data?.placement[n.uuid] === id).map((n) => n.uuid));
    }
  };

  // Ctrl + колесо — масштаб вокруг курсора. Слушатель не пассивный: иначе страница прокручивалась бы вместе с графиком.
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const rangeRef = useRef(range);
  rangeRef.current = range;
  useEffect(() => {
    const el = chartBox.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (e.clientX - rect.left - Y_AXIS) / (rect.width - Y_AXIS - RIGHT)));
      const r = rangeRef.current;
      zoomRef.current(e.deltaY < 0 ? 0.8 : 1.25, r.from + x * (r.to - r.from));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const folders = layout.data?.folders ?? [];
  const legend = [...historyNodes]
    .map((n) => ({ n, stats: seriesStats(rows, n.uuid) }))
    .sort((a, b) => (b.stats.now ?? -1) - (a.stats.now ?? -1));
  const loading = view.isPending;
  const spanText = `${dateLabel(full.from)} — ${period === 'custom' ? dateLabel(full.to) : 'сейчас'}`;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<Metric>
          label="Показатель"
          value={metric}
          onChange={setMetric}
          items={(Object.keys(METRICS) as Metric[]).map((k) => ({ key: k, label: METRICS[k].label }))}
        />
        <Segmented<Period>
          label="Период истории"
          value={period}
          onChange={(p) => p !== 'custom' && applyPeriod(p)}
          items={[
            { key: 'hour', label: '1 час' },
            { key: '1', label: '24 часа' },
            { key: '7', label: '7 дней' },
            { key: '30', label: '30 дней' },
          ]}
        />
        <button
          type="button"
          aria-label="Выбрать даты"
          title="Выбрать даты"
          className={BTN}
          onClick={() => {
            setFrom(localInput(full.from));
            setTo(localInput(full.to));
            setDateError('');
            setDates(true);
          }}
        >
          <CalendarIcon aria-hidden="true" />
          {spanText}
        </button>
        <span className="flex-1" />
        <button
          type="button"
          className={BTN}
          disabled={view.isFetching}
          onClick={() => {
            void view.refetch();
            void overview.refetch();
          }}
        >
          <RefreshCwIcon className={view.isFetching ? 'animate-spin' : ''} aria-hidden="true" />
          Обновить
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="online-period-summary">
        {loading ? (
          [0, 1, 2, 3].map((i) => <KpiCardSkeleton key={i} />)
        ) : metric === 'online' ? (
          <>
            <KpiCard label="Сейчас" value={fmt(fleet.now)} status="весь парк" tone="info" />
            <KpiCard
              label="Пиковый онлайн"
              value={fmt(summary?.peak)}
              status={summary?.peakAt ? dateLabel(Date.parse(summary.peakAt)) : 'нет полного замера'}
              tone="ok"
            />
            <KpiCard
              label="Средний онлайн"
              value={fmt(summary?.average)}
              status="за видимое окно"
              tone="ok"
            />
            <KpiCard
              label="Минимальный онлайн"
              value={fmt(summary?.minimum)}
              status="по одновременным замерам"
              tone="muted"
            />
          </>
        ) : (
          <>
            <KpiCard
              label="Сейчас"
              value={fmt(fleet.now, 1)}
              unit={unit.trim()}
              status="весь парк"
              tone="info"
            />
            <KpiCard
              label="Пик"
              value={fmt(fleet.peak?.v, 1)}
              unit={unit.trim()}
              status={fleet.peak ? dateLabel(fleet.peak.t) : '—'}
              tone="ok"
            />
            <KpiCard
              label="Среднее"
              value={fmt(fleet.avg, 1)}
              unit={unit.trim()}
              status="за видимое окно"
              tone="ok"
            />
            <KpiCard
              label="Минимум"
              value={fmt(fleet.min?.v, 1)}
              unit={unit.trim()}
              status={fleet.min ? dateLabel(fleet.min.t) : '—'}
              tone="muted"
            />
          </>
        )}
      </div>

      <Section>
        {/* Тонкая полоса сверху, пока грузится новое окно: старый график остаётся на месте. */}
        <div className="relative h-0.5 overflow-hidden" aria-hidden="true">
          {view.isFetching && !loading && (
            <span className="absolute inset-y-0 w-1/3 animate-[ns-load_1.1s_linear_infinite] bg-brand" />
          )}
        </div>
        {focused && (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-3 border-b border-brand/30 bg-brand-soft px-4 py-3"
          >
            <div className="min-w-0">
              <strong className="text-[13.5px]">{focused.title}</strong>
              <p className="mt-1 text-[12px] text-text-2">
                {focused.nodeName} · {dateLabel(focused.t)} · {focused.summary}
              </p>
            </div>
            <button
              type="button"
              className={BTN}
              onClick={() => {
                setFocused(null);
                choose(full);
              }}
            >
              Сбросить выбор
            </button>
          </div>
        )}
        <div className="px-4 pt-4 pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-[11.5px] font-semibold tracking-[0.08em] text-text-2 uppercase">
                {METRICS[metric].title} · {fleetMode ? 'весь парк' : 'выбранные ноды'}
              </h2>
              <p className="mt-[3px] text-[12px] text-text-3">
                Ctrl + колесо — масштаб, протяжка — выделить участок, двойной щелчок — сброс
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              {[
                { icon: ChevronLeftIcon, title: 'Предыдущий промежуток', fn: () => move(-1) },
                { icon: ZoomOutIcon, title: 'Уменьшить масштаб', fn: () => zoom(2) },
                { icon: ZoomInIcon, title: 'Увеличить масштаб', fn: () => zoom(0.5) },
                { icon: ChevronRightIcon, title: 'Следующий промежуток', fn: () => move(1) },
                { icon: RotateCcwIcon, title: 'Сбросить масштаб', fn: () => choose(full) },
              ].map(({ icon: Icon, title, fn }) => (
                <button
                  key={title}
                  type="button"
                  aria-label={title}
                  title={title}
                  className={SQ}
                  onClick={fn}
                >
                  <Icon aria-hidden="true" />
                </button>
              ))}
            </div>
          </div>
          {!loading && (
            <EventLane
              events={events}
              range={range}
              bucketMs={(view.data?.bucketSeconds ?? 60) * 1000}
              onFocus={focusEvent}
            />
          )}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: двойной щелчок — короткий путь мышью; с клавиатуры есть «Сбросить масштаб». */}
          <div
            ref={chartBox}
            className="mt-1 h-[300px] min-w-0 select-none max-md:h-[240px]"
            onDoubleClick={() => {
              setFocused(null);
              choose(full);
            }}
          >
            {loading ? (
              <ChartSkeleton />
            ) : view.isError ? (
              <p role="alert" className="grid h-full place-items-center text-[13px] text-crit">
                {apiErrorMessage(view.error)}
              </p>
            ) : !lines.length ? (
              <p className="grid h-full place-items-center text-[13px] text-text-3">
                Выберите ноды в таблице ниже или включите «Весь парк»
              </p>
            ) : !rows.some((r) => lines.some((k) => r[k] != null)) ? (
              <p className="grid h-full place-items-center text-[13px] text-text-3">
                За этот период ещё нет замеров
              </p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={rows}
                  margin={{ left: 0, right: RIGHT, top: 8, bottom: 0 }}
                  onMouseLeave={() => setDrag(null)}
                  onMouseDown={(e) => {
                    if (typeof e.activeLabel === 'number')
                      setDrag({ start: e.activeLabel, end: e.activeLabel });
                  }}
                  onMouseMove={(e) => {
                    if (drag && typeof e.activeLabel === 'number') setDrag({ ...drag, end: e.activeLabel });
                  }}
                  onMouseUp={() => {
                    if (drag && Math.abs(drag.end - drag.start) >= 60_000)
                      choose({ from: Math.min(drag.start, drag.end), to: Math.max(drag.start, drag.end) });
                    else setDrag(null);
                  }}
                >
                  <defs>
                    <linearGradient id="metrics-fleet" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--ns-accent)" stopOpacity={0.22} />
                      <stop offset="100%" stopColor="var(--ns-accent)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="var(--ns-border)" vertical={false} />
                  {gaps.map(([x1, x2]) => (
                    <ReferenceArea
                      key={x1}
                      x1={x1}
                      x2={x2}
                      fill="var(--ns-text-3)"
                      fillOpacity={0.08}
                      ifOverflow="hidden"
                      label={{
                        value: 'нет данных',
                        position: 'insideTop',
                        fill: 'var(--ns-text-3)',
                        fontSize: 10.5,
                      }}
                    />
                  ))}
                  <XAxis
                    dataKey="t"
                    type="number"
                    domain={[range.from, range.to]}
                    allowDataOverflow
                    tickFormatter={(t) =>
                      range.to - range.from > 36 * 3_600_000
                        ? new Date(t).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })
                        : new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
                    }
                    minTickGap={50}
                    tick={{ fill: 'var(--ns-text-3)', fontSize: 10.5 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    width={Y_AXIS}
                    domain={metric === 'ram' ? [0, 100] : [0, 'auto']}
                    tickFormatter={(v) => fmt(Number(v), 1)}
                    tick={{ fill: 'var(--ns-text-3)', fontSize: 10.5 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    cursor={{ stroke: 'var(--ns-text-3)', strokeDasharray: '3 3' }}
                    content={({ active, payload, label }) => (
                      <SortedTip
                        active={active}
                        payload={
                          payload as
                            | ReadonlyArray<{ dataKey?: unknown; value?: unknown; color?: string }>
                            | undefined
                        }
                        label={label}
                        unit={unit}
                        names={names}
                      />
                    )}
                  />
                  {fleetMode ? (
                    <Area
                      type="monotone"
                      dataKey="fleet"
                      stroke="var(--ns-accent)"
                      strokeWidth={2.2}
                      fill="url(#metrics-fleet)"
                      connectNulls={false}
                      isAnimationActive={false}
                      dot={false}
                    />
                  ) : (
                    lines.map((uuid) => (
                      <Line
                        key={uuid}
                        dataKey={uuid}
                        name={names.get(uuid)}
                        stroke={colorOf(uuid)}
                        strokeWidth={1.6}
                        dot={false}
                        activeDot={{ r: 3 }}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                    ))
                  )}
                  {focused && (
                    <ReferenceLine
                      x={focused.t}
                      stroke="var(--ns-crit)"
                      strokeWidth={2}
                      ifOverflow="extendDomain"
                    />
                  )}
                  {drag && (
                    <ReferenceArea
                      x1={Math.min(drag.start, drag.end)}
                      x2={Math.max(drag.start, drag.end)}
                      fill="var(--ns-accent)"
                      fillOpacity={0.12}
                    />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </div>
          {!loading && (
            <RangeNavigator full={full} range={range} values={navRows} onChange={(r) => choose(r)} />
          )}
          <p className="mt-2 text-[11.5px] text-text-3">
            {view.data ? `Шаг ${Math.max(1, Math.round(view.data.bucketSeconds / 60))} мин · ` : ''}хранение
            30 дней · одиночный пропуск замера дорисован, перерыв показан серой полосой «нет данных»
          </p>
        </div>

        <div className="border-t border-border">
          <div className="flex flex-wrap items-center gap-2 px-4 py-3">
            <b className="mr-1 text-[13.5px] font-semibold">Что на графике</b>
            <Segmented<string>
              label="Набор нод"
              value={preset}
              onChange={applyPreset}
              items={[
                { key: 'top', label: 'Топ-5' },
                {
                  key: 'bad',
                  label: 'Со сбоями',
                  disabled: failing.length === 0,
                  title: failing.length === 0 ? 'Сейчас сбоев нет' : undefined,
                },
                { key: 'all', label: `Все ${all.length}` },
              ]}
            />
            {folders.length > 0 && (
              <Select value={preset.startsWith('folder:') ? preset : ''} onValueChange={applyPreset}>
                <SelectTrigger
                  aria-label="Ноды папки"
                  className="h-10 w-auto min-w-[160px] rounded-[10px] text-[13px]"
                >
                  <SelectValue placeholder="Папка…" />
                </SelectTrigger>
                <SelectContent>
                  {folders.map((f) => (
                    <SelectItem key={f.id} value={`folder:${f.id}`}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <span className="flex-1" />
            <Segmented<'nodes' | 'fleet'>
              label="Что показывать"
              value={fleetMode ? 'fleet' : 'nodes'}
              onChange={(v) => setFleetMode(v === 'fleet')}
              items={[
                { key: 'nodes', label: 'Ноды' },
                { key: 'fleet', label: 'Весь парк' },
              ]}
            />
          </div>
          {!fleetMode && shown.length > 8 && (
            <p className="-mt-1 px-4 pb-2.5 text-[12px] text-warn">
              Больше восьми линий на одном графике сливаются — удобнее смотреть по папкам или «Топ-5».
            </p>
          )}
          <div className="max-h-[300px] overflow-auto">
            {loading ? (
              // Силуэт таблицы: те же строки — флажок, цвет и имя, три числа справа.
              <div role="status" aria-label="Загрузка нод" className="pb-2">
                {[1, 2, 3, 4].map((row) => (
                  <div
                    key={row}
                    className="grid grid-cols-[40px_minmax(0,1fr)_repeat(3,72px)] items-center gap-2 border-t border-border px-4 py-[11px] first:border-t-0"
                  >
                    <Skeleton className="size-4 rounded-[5px]" />
                    <Skeleton className="h-3 w-[46%]" />
                    <Skeleton className="ml-auto h-3 w-10" />
                    <Skeleton className="ml-auto h-3 w-10" />
                    <Skeleton className="ml-auto h-3 w-10" />
                  </div>
                ))}
              </div>
            ) : (
              <table className="w-full text-[12.5px]" aria-label="Ноды на графике">
                <thead>
                  <tr className="text-[10.5px] font-semibold tracking-[0.08em] text-text-3 uppercase">
                    <th className="w-10 px-4 py-2" />
                    <th className="px-2 py-2 text-left font-semibold">Нода</th>
                    <th className="px-4 py-2 text-right font-semibold">Сейчас</th>
                    <th className="px-4 py-2 text-right font-semibold">Пик</th>
                    <th className="px-4 py-2 text-right font-semibold">Минимум</th>
                  </tr>
                </thead>
                <tbody>
                  {legend.map(({ n, stats }) => {
                    const on = !fleetMode && shown.includes(n.uuid);
                    return (
                      <tr
                        key={n.uuid}
                        onClick={() => toggle(n.uuid)}
                        className={cn(
                          'cursor-pointer border-t border-border transition-colors hover:bg-surface-2/60',
                          !on && 'text-text-3',
                        )}
                      >
                        <td className="px-4 py-2">
                          <Checkbox
                            checked={on}
                            aria-label={`${n.name} на графике`}
                            onClick={(e) => e.stopPropagation()}
                            onCheckedChange={() => toggle(n.uuid)}
                          />
                        </td>
                        <td className="px-2 py-2">
                          <span className="flex min-w-0 items-center gap-2">
                            <span
                              className="size-2.5 flex-none rounded-[3px]"
                              style={{ background: on ? colorOf(n.uuid) : 'var(--ns-surface-3)' }}
                              aria-hidden="true"
                            />
                            {all.find((x) => x.uuid === n.uuid)?.countryCode && (
                              <CountryFlag
                                code={all.find((x) => x.uuid === n.uuid)?.countryCode ?? ''}
                                size="sm"
                              />
                            )}
                            <span className={cn('truncate', on && 'text-foreground')}>{n.name}</span>
                            {failing.includes(n.uuid) && (
                              <span className="flex-none rounded-full bg-crit-soft px-[7px] py-px text-[11px] font-semibold text-crit">
                                сбой
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">{fmt(stats.now, 1)}</td>
                        <td className="px-4 py-2 text-right text-text-3 tabular-nums">
                          {fmt(stats.peak?.v, 1)}
                        </td>
                        <td className="px-4 py-2 text-right text-text-3 tabular-nums">
                          {fmt(stats.min?.v, 1)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </Section>

      <Section>
        <section aria-label="События метрик">
          <header className="flex min-h-14 flex-wrap items-center gap-2.5 border-b border-border px-4 py-3">
            <h2 className="flex items-center gap-2.5 font-heading text-[14.5px] font-semibold">
              События в видимом окне{' '}
              <span className="inline-grid h-[22px] min-w-6 place-items-center rounded-full bg-surface-2 px-[7px] text-[12px] font-bold text-text-2 tabular-nums">
                {loading ? '—' : events.length}
              </span>
            </h2>
            <span className="text-[12px] text-text-3">сдвиньте окно — список обновится</span>
            <span className="ml-auto flex items-center gap-2 text-[12px] text-text-3">
              Показывать
              <Select
                value={eventSize}
                onValueChange={(v) => {
                  setEventSize(v);
                  setEventPage(1);
                }}
              >
                <SelectTrigger aria-label="Событий на странице" className="h-9 w-20 rounded-[10px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['10', '25', '50'].map((n) => (
                    <SelectItem key={n} value={n}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </span>
          </header>
          {loading ? (
            <div className="p-4">
              <RowsSkeleton />
            </div>
          ) : view.isError ? (
            <p role="alert" className="p-4 text-[13px] text-crit">
              {apiErrorMessage(view.error)}
            </p>
          ) : !events.length ? (
            <p className="px-4 py-6 text-[13px] text-text-3">В видимом окне событий нет</p>
          ) : (
            <ul className="px-4 pt-1 pb-2">
              {eventRows.map((e) => (
                <li
                  key={e.id}
                  className={cn(
                    'flex items-center gap-3.5 border-t border-border py-2.5 first:border-t-0',
                    focused?.id === e.id && '-mx-4 bg-brand-soft px-4',
                  )}
                >
                  <EventIcon e={e} />
                  <button
                    type="button"
                    onClick={() => focusEvent(e)}
                    aria-pressed={focused?.id === e.id}
                    className="min-w-0 flex-1 cursor-pointer text-left hover:text-brand"
                  >
                    <span className="block truncate text-[13.5px] font-semibold">
                      {e.title} <span className="font-normal text-text-3">· {e.nodeName}</span>
                    </span>
                    <span className="mt-[3px] block text-[12px] text-text-3">
                      {dateLabel(e.t)}
                      {e.type === 'incident_opened'
                        ? ' · началось'
                        : e.type === 'incident_resolved'
                          ? ' · закончилось'
                          : ''}{' '}
                      · показать на графике
                    </span>
                  </button>
                  {e.link ? (
                    <a
                      href={e.link}
                      target={e.link.startsWith('https:') ? '_blank' : undefined}
                      rel="noreferrer"
                      className="flex-none text-[12.5px] text-brand hover:text-foreground"
                    >
                      Подробнее
                    </a>
                  ) : (
                    <ChevronRightIcon className="size-4 flex-none text-text-3" aria-hidden="true" />
                  )}
                </li>
              ))}
            </ul>
          )}
          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-bg-2 px-4 py-2">
            <span className="text-[12px] text-text-3">
              {events.length
                ? `${(page - 1) * Number(eventSize) + 1}–${Math.min(page * Number(eventSize), events.length)} из ${events.length}`
                : '0 событий'}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={SQ}
                aria-label="Предыдущая страница событий"
                disabled={page === 1}
                onClick={() => setEventPage(page - 1)}
              >
                <ChevronLeftIcon aria-hidden="true" />
              </button>
              <span className="min-w-16 text-center text-[12px] tabular-nums">
                {page} / {pages}
              </span>
              <button
                type="button"
                className={SQ}
                aria-label="Следующая страница событий"
                disabled={page === pages}
                onClick={() => setEventPage(page + 1)}
              >
                <ChevronRightIcon aria-hidden="true" />
              </button>
            </div>
          </footer>
          {view.data?.eventsTruncated && (
            <p className="px-4 pb-3 text-[12px] text-warn">
              Показаны первые 1000 событий. Уменьшите окно, чтобы увидеть остальные.
            </p>
          )}
        </section>
      </Section>

      <Dialog open={dates} onOpenChange={setDates}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogTitle>Период истории</DialogTitle>
          <DialogDescription>До 30 дней. Время — как на вашем компьютере.</DialogDescription>
          <label htmlFor="metric-from" className="space-y-1.5 text-[12.5px]">
            Начало
            <Input
              type="datetime-local"
              id="metric-from"
              aria-label="Начало периода"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="h-10"
            />
          </label>
          <label htmlFor="metric-to" className="space-y-1.5 text-[12.5px]">
            Конец
            <Input
              type="datetime-local"
              id="metric-to"
              aria-label="Конец периода"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="h-10"
            />
          </label>
          {dateError && (
            <p role="alert" className="text-[12.5px] text-crit">
              {dateError}
            </p>
          )}
          <div className="-mx-4 -mb-4 flex justify-end border-t border-border bg-bg-2 p-4">
            <CardButton
              className="h-10"
              onClick={() => {
                const a = Date.parse(from);
                const b = Date.parse(to);
                if (!Number.isFinite(a) || !Number.isFinite(b) || a >= b || b - a > 30 * 86_400_000) {
                  setDateError('Выберите начало раньше конца и промежуток до 30 дней.');
                  return;
                }
                const r = { from: a, to: b };
                setFull(r);
                setPeriod('custom');
                setFocused(null);
                choose(r);
                setDates(false);
              }}
            >
              Показать историю
            </CardButton>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
