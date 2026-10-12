import { nodeMetricHistorySchema } from '@nodeservice/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ActivityIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SearchIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from 'lucide-react';
import { type ComponentProps, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useNodes } from '@/features/nodes/nodes-api';
import { BarButton as BaseBarButton, CardButton, Pill } from '@/features/settings/settings-ui';
import { api, apiErrorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

function BarButton({ className, ...props }: ComponentProps<typeof BaseBarButton>) {
  return <BaseBarButton {...props} className={cn('h-10 rounded-[10px]', className)} />;
}

type Range = { from: number; to: number };
const metrics = { online: 'Онлайн', cpu: 'CPU', ram: 'RAM', rx: 'Входящий трафик', tx: 'Исходящий трафик' };
type Metric = keyof typeof metrics;
const colors = [
  'var(--ns-accent)',
  'var(--ns-ok)',
  'var(--ns-warn)',
  'var(--ns-crit)',
  'var(--ns-teal)',
  'var(--ns-ai)',
];
const dateLabel = (t: number) =>
  new Date(t).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const localInput = (t: number) => {
  const d = new Date(t);
  return new Date(t - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const formatValue = (n: number, kind: Metric) =>
  `${Number(kind === 'rx' || kind === 'tx' ? (n * 8) / 1e6 : n).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}${kind === 'cpu' || kind === 'ram' ? '%' : kind === 'rx' || kind === 'tx' ? ' Мбит/с' : ''}`;
export function MetricsHistoryPage({ overview = false }: { overview?: boolean }) {
  const inventory = useNodes();
  const [full, setFull] = useState<Range>(() => ({ from: Date.now() - 86400000, to: Date.now() })),
    [range, setRange] = useState(full);
  const [period, setPeriod] = useState('1');
  const [selected, setSelected] = useState<string[]>([]),
    [kind, setKind] = useState<Metric>('online'),
    [showEvents, setShowEvents] = useState(true),
    [showPeaks, setShowPeaks] = useState(false);
  const [pick, setPick] = useState(false),
    [draftNodes, setDraftNodes] = useState<string[]>([]),
    [search, setSearch] = useState(''),
    [dates, setDates] = useState(false),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [dateError, setDateError] = useState('');
  const [drag, setDrag] = useState<{ start: number; end: number } | null>(null);
  const query = useQuery({
    queryKey: ['metrics-history', range.from, range.to, selected.join(',')],
    queryFn: ({ signal }) =>
      api.get(
        `/nodes/metrics/history?${new URLSearchParams({ from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString(), nodes: selected.join(','), maxPoints: '400' })}`,
        nodeMetricHistorySchema,
        signal,
      ),
    staleTime: 60000,
  });
  const nodes = query.data?.nodes ?? [];
  const seriesOrder = useMemo(
    () =>
      new Map(
        [...(inventory.data?.nodes ?? [])]
          .sort((a, b) => a.uuid.localeCompare(b.uuid))
          .map((n, i) => [n.uuid, i]),
      ),
    [inventory.data?.nodes],
  );
  const seriesIndex = (uuid: string) => seriesOrder.get(uuid) ?? 0;
  const seriesColor = (uuid: string) => colors[seriesIndex(uuid) % colors.length];
  const seriesDash = (uuid: string) =>
    [undefined, '6 3', '2 3', '8 3 2 3'][Math.floor(seriesIndex(uuid) / colors.length) % 4];
  const data = useMemo(() => {
    const map = new Map<number, Record<string, number | null>>();
    for (const node of nodes)
      for (const p of node.points) {
        const row = map.get(p.t) ?? { t: p.t };
        row[node.uuid] = p[kind];
        row[node.uuid + 'min'] = p.min[kind];
        row[node.uuid + 'max'] = p.max[kind];
        map.set(p.t, row);
      }
    return [...map.values()].sort((a, b) => Number(a.t) - Number(b.t));
  }, [nodes, kind]);
  const events = (query.data?.events ?? []).filter((e) => e.t >= range.from && e.t < range.to);
  const visibleInventory = (inventory.data?.nodes ?? []).filter((n) =>
    `${n.name} ${n.address}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const chooseRange = (r: Range) => {
    setRange(r);
    setDrag(null);
  };
  const preset = (days: number) => {
    setPeriod(String(days));
    const r = { from: Date.now() - days * 86400000, to: Date.now() };
    setFull(r);
    chooseRange(r);
  };
  const zoom = (factor: number) => {
    const span = Math.min(full.to - full.from, Math.max(300000, (range.to - range.from) * factor));
    let start = (range.from + range.to - span) / 2;
    start = Math.max(full.from, Math.min(full.to - span, start));
    chooseRange({ from: start, to: start + span });
  };
  const move = (direction: number) => {
    const span = range.to - range.from;
    const start = Math.max(full.from, Math.min(full.to - span, range.from + (direction * span) / 2));
    chooseRange({ from: start, to: start + span });
  };
  const hasData = data.some((p) => nodes.some((n) => p[n.uuid] !== null && p[n.uuid] !== undefined));
  const onlineSummary = query.data?.onlineSummary;
  return (
    <div className="flex min-h-0 flex-col gap-4 xl:h-[calc(100dvh-206px)] xl:min-h-[480px] xl:-mb-11 [@media(min-width:1280px)_and_(max-height:850px)]:h-auto [@media(min-width:1280px)_and_(max-height:850px)]:min-h-0 [@media(min-width:1280px)_and_(max-height:850px)]:mb-0">
      <section className="flex flex-none flex-col gap-4 rounded-[14px] border border-border bg-surface p-[18px]">
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-[10px] bg-brand-soft text-brand">
            <ActivityIcon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="font-heading text-[15px] font-semibold">
              {overview ? 'Графики и события' : 'История метрик'}
            </h2>
            <p className="mt-1 text-[12px] text-text-3">
              {dateLabel(range.from)} — {dateLabel(range.to)}
            </p>
          </div>
          {overview && (
            <Link
              to="/"
              search={{ view: 'stats' }}
              className="inline-flex h-10 flex-none items-center justify-center rounded-[10px] border border-border bg-surface-2 px-3 text-[13px] font-medium text-text-2 hover:bg-surface-3"
            >
              ← К сводке
            </Link>
          )}
        </div>
        <div
          data-testid="metric-controls"
          className="grid grid-cols-1 gap-3 xl:grid-cols-5 [&>button]:h-10 [&>button]:w-full [&>button]:min-w-0 [&>button]:rounded-[10px] [&>button]:px-3 [&>button]:text-[13px] [&>button]:font-medium"
        >
          <BarButton
            onClick={() => {
              setDraftNodes(selected.length ? selected : (inventory.data?.nodes ?? []).map((n) => n.uuid));
              setPick(true);
            }}
          >
            Ноды · {selected.length || 'Все'}
          </BarButton>
          <Select value={kind} onValueChange={(v) => setKind(v as Metric)}>
            <SelectTrigger aria-label="Метрика" className="h-10 w-full rounded-[10px] px-3 text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(metrics).map(([key, label]) => (
                <SelectItem key={key} value={key}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={period} onValueChange={(v) => preset(Number(v))}>
            <SelectTrigger
              aria-label="Период истории"
              className="h-10 w-full rounded-[10px] px-3 text-[13px]"
            >
              <SelectValue placeholder="Период" />
            </SelectTrigger>
            <SelectContent>
              {period === 'custom' && (
                <SelectItem value="custom" disabled>
                  Свои даты
                </SelectItem>
              )}
              {[1, 3, 7, 14, 30].map((d) => (
                <SelectItem key={d} value={String(d)}>
                  {d === 1 ? '24 часа' : `${d} дней`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <BarButton
            onClick={() => {
              setFrom(localInput(full.from));
              setTo(localInput(full.to));
              setDateError('');
              setDates(true);
            }}
          >
            Выбрать даты
          </BarButton>
          <BarButton disabled={query.isFetching} onClick={() => void query.refetch()}>
            <RefreshCwIcon className={query.isFetching ? 'animate-spin' : ''} />
            Обновить
          </BarButton>
        </div>
      </section>
      <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <section className="flex min-h-[360px] min-w-0 flex-col overflow-hidden rounded-[14px] border border-border bg-surface">
          <div
            className="grid flex-none grid-cols-3 gap-px border-b border-border bg-border"
            data-testid="online-period-summary"
          >
            {[
              [
                'Пиковый онлайн',
                onlineSummary?.peak,
                onlineSummary?.peakAt ? dateLabel(Date.parse(onlineSummary.peakAt)) : 'Нет полного замера',
              ],
              ['Средний онлайн', onlineSummary?.average, 'За выбранный промежуток'],
              ['Минимальный онлайн', onlineSummary?.minimum, 'По одновременным замерам'],
            ].map(([label, value, hint]) => (
              <div key={String(label)} className="min-w-0 bg-surface-2 px-4 py-3">
                <p className="text-[11.5px] text-text-3">{label}</p>
                <p className="mt-1 font-mono text-[18px] font-semibold">
                  {typeof value === 'number' ? Math.round(value).toLocaleString('ru-RU') : '—'}
                </p>
                <p className="mt-1 text-[11px] text-text-3">{hint}</p>
              </div>
            ))}
          </div>
          {onlineSummary?.partial && (
            <p className="flex-none px-4 py-2 text-[11px] text-text-3">
              Неполные снимки исключены из сводки онлайна.
            </p>
          )}
          <header className="flex flex-none flex-wrap items-center justify-between gap-3 border-b border-border px-[18px] py-3.5">
            <div>
              <h3 className="text-[14px] font-semibold">{metrics[kind]}</h3>
              <p className="mt-1 text-[11.5px] text-text-3">
                Выделите промежуток на графике, чтобы увеличить масштаб
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              {[
                { icon: ChevronLeftIcon, title: 'Предыдущий промежуток', fn: () => move(-1) },
                { icon: ZoomInIcon, title: 'Увеличить масштаб', fn: () => zoom(0.5) },
                { icon: ZoomOutIcon, title: 'Уменьшить масштаб', fn: () => zoom(2) },
                { icon: ChevronRightIcon, title: 'Следующий промежуток', fn: () => move(1) },
                { icon: RotateCcwIcon, title: 'Сбросить масштаб', fn: () => chooseRange(full) },
              ].map(({ icon: Icon, title, fn }) => (
                <BarButton
                  key={title}
                  aria-label={title}
                  title={title}
                  className="min-w-0 w-10 px-0"
                  onClick={fn}
                >
                  <Icon />
                </BarButton>
              ))}
            </div>
          </header>
          <div className="min-h-[180px] flex-1 p-4 [@media(min-width:1280px)_and_(max-height:850px)]:h-[240px] [@media(min-width:1280px)_and_(max-height:850px)]:flex-none">
            {query.isPending ? (
              <p role="status" className="grid h-full place-items-center text-[13px] text-text-3">
                Загружаю историю…
              </p>
            ) : query.isError ? (
              <p role="alert" className="text-crit">
                {apiErrorMessage(query.error)}
              </p>
            ) : !hasData ? (
              <p className="grid h-full place-items-center text-[13px] text-text-3">
                За этот период ещё нет замеров
              </p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={data}
                  margin={{ left: 0, right: 12, top: 12, bottom: 0 }}
                  onMouseLeave={() => setDrag(null)}
                  onMouseDown={(e) => {
                    if (typeof e.activeLabel === 'number')
                      setDrag({ start: e.activeLabel, end: e.activeLabel });
                  }}
                  onMouseMove={(e) => {
                    if (drag && typeof e.activeLabel === 'number') setDrag({ ...drag, end: e.activeLabel });
                  }}
                  onMouseUp={() => {
                    if (drag && Math.abs(drag.end - drag.start) >= 60000)
                      chooseRange({
                        from: Math.min(drag.start, drag.end),
                        to: Math.max(drag.start, drag.end),
                      });
                    else setDrag(null);
                  }}
                >
                  <CartesianGrid stroke="var(--ns-border)" vertical={false} />
                  <XAxis
                    dataKey="t"
                    type="number"
                    domain={[range.from, range.to]}
                    allowDataOverflow
                    tickFormatter={(t) =>
                      new Date(t).toLocaleString('ru-RU', {
                        day: '2-digit',
                        month: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    }
                    minTickGap={70}
                    tick={{ fill: 'var(--ns-text-2)', fontSize: 11 }}
                  />
                  <YAxis
                    width={55}
                    domain={kind === 'cpu' || kind === 'ram' ? [0, 100] : [0, 'auto']}
                    tickFormatter={(v) => formatValue(v, kind)}
                    tick={{ fill: 'var(--ns-text-2)', fontSize: 11 }}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--ns-surface)',
                      border: '1px solid var(--ns-border)',
                      borderRadius: 10,
                      fontSize: 12,
                    }}
                    labelFormatter={(t) => dateLabel(Number(t))}
                    formatter={(v, name) => [v == null ? 'Нет данных' : formatValue(Number(v), kind), name]}
                  />
                  {nodes.map((n) => (
                    <Line
                      key={n.uuid}
                      name={n.name}
                      dataKey={n.uuid}
                      stroke={seriesColor(n.uuid)}
                      strokeWidth={2}
                      strokeDasharray={seriesDash(n.uuid)}
                      dot={false}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  ))}
                  {showPeaks &&
                    nodes.flatMap((n) =>
                      ['min', 'max'].map((s) => (
                        <Line
                          key={n.uuid + s}
                          name={`${n.name} · ${s === 'min' ? 'минимум' : 'максимум'}`}
                          dataKey={n.uuid + s}
                          stroke={seriesColor(n.uuid)}
                          strokeOpacity={0.4}
                          strokeDasharray="3 3"
                          dot={false}
                          connectNulls={false}
                          isAnimationActive={false}
                        />
                      )),
                    )}
                  {showEvents &&
                    events
                      .slice(0, 80)
                      .map((e) => (
                        <ReferenceLine
                          key={e.id}
                          x={e.t}
                          stroke={
                            e.type === 'incident_resolved'
                              ? 'var(--ns-ok)'
                              : e.type === 'tcp_check'
                                ? 'var(--ns-accent)'
                                : 'var(--ns-warn)'
                          }
                          strokeDasharray="3 3"
                        />
                      ))}
                  {drag && (
                    <ReferenceArea
                      x1={Math.min(drag.start, drag.end)}
                      x2={Math.max(drag.start, drag.end)}
                      fill="var(--ns-accent)"
                      fillOpacity={0.12}
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
          <div className="flex max-h-[66px] flex-none flex-wrap gap-x-4 gap-y-2 overflow-y-auto border-t border-border px-[18px] py-3">
            {nodes.map((n) => (
              <span key={n.uuid} className="inline-flex items-center gap-2 text-[12px] text-text-2">
                <svg width="20" height="8" aria-hidden="true">
                  <line
                    x1="0"
                    x2="20"
                    y1="4"
                    y2="4"
                    stroke={seriesColor(n.uuid)}
                    strokeWidth="2"
                    strokeDasharray={seriesDash(n.uuid)}
                  />
                </svg>
                {n.name}
              </span>
            ))}
          </div>
          <footer className="flex flex-none flex-wrap items-center gap-4 border-t border-border bg-bg-2 px-[18px] py-3">
            <label htmlFor="metric-events" className="flex items-center gap-2 text-[12px]">
              <Checkbox
                id="metric-events"
                checked={showEvents}
                onCheckedChange={(v) => setShowEvents(v === true)}
              />
              События на графике
            </label>
            <label htmlFor="metric-peaks" className="flex items-center gap-2 text-[12px]">
              <Checkbox
                id="metric-peaks"
                checked={showPeaks}
                onCheckedChange={(v) => setShowPeaks(v === true)}
              />
              Минимум и максимум
            </label>
            <span className="ml-auto text-[11.5px] text-text-3">
              {query.data
                ? `Шаг ${Math.round(query.data.bucketSeconds / 60)} мин · хранение 30 дней`
                : 'История сохраняется в панели'}
            </span>
          </footer>
        </section>
        <section className="flex min-h-0 flex-col overflow-hidden rounded-[14px] border border-border bg-surface">
          <header className="flex items-center justify-between border-b border-border px-[18px] py-3.5">
            <h3 className="text-[14px] font-semibold">События за промежуток</h3>
            <Pill>{events.length}</Pill>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-3 max-xl:max-h-[300px]">
            {events.length === 0 && (
              <p className="px-2 py-3 text-[12px] text-text-3">Событий за выбранный промежуток нет</p>
            )}
            {events.map((e) => (
              <details
                key={e.id}
                className="mb-2 overflow-hidden rounded-[10px] border border-border bg-surface-2"
              >
                <summary className="cursor-pointer list-none p-3">
                  <span className="block text-[11px] text-text-3">{dateLabel(e.t)}</span>
                  <span className="mt-1 block text-[13px] font-semibold">{e.title}</span>
                  <span className="mt-1 block truncate text-[12px] text-text-3">{e.nodeName}</span>
                </summary>
                <div className="border-t border-border p-3 text-[12px] leading-5 text-text-2">
                  <p className="whitespace-pre-wrap break-words">{e.summary}</p>
                  {e.link && (
                    <a
                      className="mt-2 inline-block text-brand"
                      href={e.link}
                      target={e.link.startsWith('https:') ? '_blank' : undefined}
                      rel="noreferrer"
                    >
                      Открыть подробности
                    </a>
                  )}
                  <CardButton
                    className="mt-3 h-10 w-full"
                    onClick={() =>
                      chooseRange({
                        from: Math.max(full.from, e.t - 15 * 60000),
                        to: Math.min(full.to, e.t + 15 * 60000),
                      })
                    }
                  >
                    Показать момент
                  </CardButton>
                </div>
              </details>
            ))}
          </div>
          {query.data?.eventsTruncated && (
            <p className="border-t border-border p-3 text-[11px] text-warn">
              Показана часть событий. Уменьшите промежуток.
            </p>
          )}
          {showEvents && events.length > 80 && (
            <p className="border-t border-border p-3 text-[11px] text-text-3">
              На графике первые 80 отметок; полный список здесь.
            </p>
          )}
        </section>
      </div>
      <Dialog open={pick} onOpenChange={setPick}>
        <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-[560px]">
          <DialogTitle>Ноды на графике</DialogTitle>
          <DialogDescription>
            Выберите ноды для сравнения. Цвета обозначают отдельные линии.
          </DialogDescription>
          <div className="relative">
            <SearchIcon className="absolute left-3 top-3 size-4 text-text-3" />
            <Input
              className="h-10 pl-9"
              aria-label="Найти ноду"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Название или адрес"
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 [&>button]:min-w-0">
            <BarButton
              disabled={!visibleInventory.length}
              onClick={() => setDraftNodes(visibleInventory.map((n) => n.uuid))}
            >
              Выбрать показанные
            </BarButton>
            <BarButton onClick={() => setDraftNodes((inventory.data?.nodes ?? []).map((n) => n.uuid))}>
              Все ноды
            </BarButton>
            <BarButton onClick={() => setDraftNodes([])}>Снять выбор</BarButton>
          </div>
          <div className="min-h-0 overflow-y-auto">
            {visibleInventory.map((n) => (
              <label
                key={n.uuid}
                htmlFor={`metric-node-${n.uuid}`}
                className="flex cursor-pointer items-center gap-3 border-b border-border py-3"
              >
                <Checkbox
                  id={`metric-node-${n.uuid}`}
                  checked={draftNodes.includes(n.uuid)}
                  onCheckedChange={(v) =>
                    setDraftNodes((s) => (v ? [...s, n.uuid] : s.filter((x) => x !== n.uuid)))
                  }
                />
                <span className="min-w-0">
                  <span className="block text-[13px]">{n.name}</span>
                  <span className="text-[11.5px] text-text-3">{n.address}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="-mx-4 -mb-4 flex justify-end border-t border-border bg-bg-2 p-4">
            <CardButton
              disabled={!draftNodes.length}
              className="h-10"
              onClick={() => {
                setSelected(draftNodes.length === inventory.data?.nodes.length ? [] : draftNodes);
                setPick(false);
              }}
            >
              Готово
            </CardButton>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={dates} onOpenChange={setDates}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogTitle>Период истории</DialogTitle>
          <DialogDescription>
            До 30 дней. Время: {Intl.DateTimeFormat().resolvedOptions().timeZone}.
          </DialogDescription>
          <label htmlFor="metric-from" className="space-y-1.5 text-[12px]">
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
          <label htmlFor="metric-to" className="space-y-1.5 text-[12px]">
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
            <p role="alert" className="text-[12px] text-crit">
              {dateError}
            </p>
          )}
          <div className="-mx-4 -mb-4 flex justify-end border-t border-border bg-bg-2 p-4">
            <CardButton
              className="h-10"
              onClick={() => {
                const a = Date.parse(from),
                  b = Date.parse(to);
                if (!Number.isFinite(a) || !Number.isFinite(b) || a >= b || b - a > 30 * 86400000) {
                  setDateError('Выберите начало раньше конца и промежуток до 30 дней.');
                  return;
                }
                const r = { from: a, to: b };
                setFull(r);
                setPeriod('custom');
                chooseRange(r);
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
