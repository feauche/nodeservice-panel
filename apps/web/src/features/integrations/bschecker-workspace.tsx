import {
  type BsHistoryEntry,
  type BsRun,
  bsHistorySchema,
  bsPreviewSchema,
  bsRunSchema,
  bsWorkspaceSchema,
} from '@nodeservice/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronRightIcon, HistoryIcon, RefreshCwIcon, SearchIcon, SettingsIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { RowsSkeleton } from '@/components/ui/loading-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useNodes } from '@/features/nodes/nodes-api';
import { BarButton, CardButton, Pill } from '@/features/settings/settings-ui';
import { api, apiErrorMessage } from '@/lib/api';
import { plural } from '@/lib/plural';
import { explainProbeError } from '@/lib/probe-error';
import { BsRentals } from './bs-rentals';

const pointCount = (count: number) => `${count} ${plural(count, 'точка', 'точки', 'точек')}`;
const formatDate = (value: string) =>
  new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
const credits = (value: number) => `${new Intl.NumberFormat('ru-RU').format(value)} Cred`;
const statuses = {
  ready: 'Готова к запуску',
  running: 'Выполняется',
  done: 'Завершена',
  uncertain: 'Ожидает результата',
  failed: 'Не выполнена',
};
const availability = (run: BsRun) => {
  const method = run.rows.some((r) => r.tcp !== null) ? 'tcp' : 'icmp';
  const known = run.rows.filter((r) => r[method] !== null);
  const ok = known.filter((r) => r[method] === true).length;
  return run.status === 'done' && known.length
    ? {
        label: `${method.toUpperCase()}: ${ok}/${known.length}`,
        tone: ok === known.length ? ('ok' as const) : ok ? ('warn' as const) : ('crit' as const),
      }
    : {
        label: statuses[run.status],
        tone:
          run.status === 'failed'
            ? ('crit' as const)
            : run.status === 'done'
              ? ('muted' as const)
              : ('warn' as const),
      };
};
const runTone = (run: BsRun) =>
  run.status === 'done' ? ('ok' as const) : run.status === 'failed' ? ('crit' as const) : ('warn' as const);

export function BsBalanceSkeleton() {
  return (
    <div
      role="status"
      aria-label="Загрузка баланса BS Checker"
      className="flex min-h-[52px] flex-wrap items-center gap-x-6 gap-y-2"
    >
      <div className="space-y-2" aria-hidden="true">
        <Skeleton className="h-3 w-16 motion-reduce:animate-none" />
        <Skeleton className="h-7 w-40 motion-reduce:animate-none" />
      </div>
      <div className="space-y-2" aria-hidden="true">
        <Skeleton className="h-3.5 w-36 motion-reduce:animate-none" />
        <Skeleton className="h-3.5 w-28 motion-reduce:animate-none" />
      </div>
      <Skeleton aria-hidden="true" className="h-6 w-20 rounded-full motion-reduce:animate-none" />
    </div>
  );
}

export function BsCheckerWorkspace({
  settings,
  initialNode,
  onInitialNodeUsed,
}: {
  settings: () => void;
  initialNode?: string;
  onInitialNodeUsed?: () => void;
}) {
  const q = useQuery({
    queryKey: ['bschecker-workspace'],
    queryFn: ({ signal }) => api.get('/integrations/bschecker/workspace', bsWorkspaceSchema, signal),
  });
  const history = useQuery({
    queryKey: ['bschecker-history'],
    queryFn: ({ signal }) => api.get('/integrations/bschecker/history', bsHistorySchema, signal),
    refetchInterval: (query) =>
      query.state.data?.runs.some((r) => r.run.status === 'running') ? 5000 : false,
  });
  const nodes = useNodes();
  const [nodeUuid, setNodeUuid] = useState<string | undefined>();
  const [ip, setIp] = useState(''),
    [port, setPort] = useState('443'),
    [operators, setOperators] = useState<string[]>([]),
    [icmp, setIcmp] = useState(true),
    [tcp, setTcp] = useState(true);
  const [error, setError] = useState<string | null>(null),
    [points, setPoints] = useState(false),
    [search, setSearch] = useState(''),
    [region, setRegion] = useState('all'),
    [dpi, setDpi] = useState('all'),
    [selected, setSelected] = useState<BsHistoryEntry | null>(null);
  // Пришли из совета Ассистента: подставляем ноду и её адрес, как при выборе из списка.
  useEffect(() => {
    if (!initialNode) return;
    const n = nodes.data?.nodes.find((x) => x.uuid === initialNode);
    if (!n) return;
    setNodeUuid(n.uuid);
    setIp(n.address);
    onInitialNodeUsed?.();
  }, [initialNode, nodes.data, onInitialNodeUsed]);
  const preview = useMutation({
    mutationFn: () =>
      api.post(
        '/integrations/bschecker/preview',
        { ip, port: Number(port), operators, icmp, tcp, ...(nodeUuid ? { nodeUuid } : {}) },
        bsPreviewSchema,
      ),
  });
  const execute = useMutation({
    mutationFn: (id: string) => api.post(`/integrations/bschecker/runs/${id}/execute`, {}, bsRunSchema),
    onSuccess: (data) => {
      setSelected((prev) => (prev ? { ...prev, run: data } : null));
      void q.refetch();
      void history.refetch();
    },
  });
  const available = q.data?.units.filter((u) => u.probeable) ?? [];
  const filtered = (q.data?.units ?? []).filter(
    (u) =>
      (region === 'all' || u.region === region) &&
      (dpi === 'all' || u.dpi === dpi) &&
      `${u.name} ${u.region} ${u.operator}`.toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru')),
  );
  const locked =
    execute.isPending ||
    history.data?.runs.some((r) => r.run.status === 'uncertain' || r.run.status === 'running');
  function change() {
    preview.reset();
    setError(null);
  }
  async function price() {
    setError(null);
    try {
      await preview.mutateAsync();
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }
  async function start(id: string, entry?: BsHistoryEntry) {
    const context = entry ?? {
      target: `${ip.includes(':') ? `[${ip}]` : ip}:${port}`,
      createdAt: new Date().toISOString(),
      units: operators.length,
      estimatedCredits: preview.data?.costCredits ?? 0,
      run: { id, status: 'ready', costCredits: null, refundedCredits: null, error: null, rows: [] } as BsRun,
    };
    setPoints(false);
    setSelected({ ...context, run: { ...context.run, status: 'running', error: null } });
    setError(null);
    try {
      await execute.mutateAsync(id);
    } catch (e) {
      setSelected({ ...context, run: { ...context.run, status: 'uncertain', error: apiErrorMessage(e) } });
      void history.refetch();
    }
  }
  async function openResult(entry: BsHistoryEntry) {
    setSelected(entry);
    try {
      const run = await api.get(`/integrations/bschecker/runs/${entry.run.id}`, bsRunSchema);
      setSelected((prev) => (prev?.run.id === run.id ? { ...entry, run } : prev));
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }
  return (
    <div
      data-testid="bs-workspace"
      className="flex min-w-0 flex-col gap-4 lg:-mb-11 lg:h-[calc(100dvh-206px)] lg:min-h-[440px] lg:overflow-hidden"
    >
      <section className="flex flex-none flex-wrap items-center gap-x-6 gap-y-3 rounded-[14px] border border-border bg-surface px-[18px] py-4">
        <div className="min-w-0 flex-1 max-sm:basis-full">
          {q.isPending ? (
            <BsBalanceSkeleton />
          ) : q.isError ? (
            <p role="alert" className="text-[13px] text-crit">
              {apiErrorMessage(q.error)}
            </p>
          ) : (
            q.data && (
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <div>
                  <p className="text-[12px] text-text-3">Доступно</p>
                  <p className="whitespace-nowrap font-mono text-[23px] font-semibold">
                    {credits(q.data.account.totalCredits)}
                  </p>
                </div>
                <div className="text-[12.5px] text-text-3">
                  <p>
                    Основной: <span className="text-text-2">{credits(q.data.account.balanceCredits)}</span>
                  </p>
                  <p>
                    Бонусы: <span className="text-text-2">{credits(q.data.account.bonusCredits)}</span>
                  </p>
                </div>
                <Pill>{q.data.account.tier}</Pill>
              </div>
            )
          )}
        </div>
        <BarButton className="h-10" onClick={() => void q.refetch()} disabled={q.isFetching}>
          <RefreshCwIcon />
          Обновить баланс
        </BarButton>
        <BarButton className="h-10" onClick={settings}>
          <SettingsIcon />
          Подключение
        </BarButton>
      </section>
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-2">
        <section className="flex min-h-0 flex-col overflow-hidden rounded-[14px] border border-border bg-surface">
          <header className="border-b border-border px-[18px] py-4">
            <h2 className="font-heading text-[15px] font-semibold">Проверка IP или домена</h2>
            <p className="mt-1 text-[12px] text-text-3">
              Выберите цель и точки. Стоимость покажем до запуска.
            </p>
          </header>
          <div className="flex-none space-y-3 px-[18px] py-4">
            <Select
              disabled={locked}
              value={nodeUuid ?? 'manual'}
              onValueChange={(v) => {
                const n = nodes.data?.nodes.find((n) => n.uuid === v);
                setNodeUuid(n?.uuid);
                setIp(n?.address ?? '');
                change();
              }}
            >
              <SelectTrigger aria-label="Нода для проверки" className="h-10">
                <SelectValue placeholder="Выберите ноду" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="manual">Ввести IP или домен вручную</SelectItem>
                {nodes.data?.nodes.map((n) => (
                  <SelectItem key={n.uuid} value={n.uuid}>
                    {n.name} · {n.address}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="grid grid-cols-[minmax(0,1fr)_100px] gap-3">
              <label htmlFor="bs-ip" className="space-y-1.5 text-[12.5px] font-medium">
                IP или домен
                <Input
                  id="bs-ip"
                  aria-label="IP или домен"
                  disabled={locked}
                  value={ip}
                  onChange={(e) => {
                    setNodeUuid(undefined);
                    setIp(e.target.value);
                    change();
                  }}
                  placeholder="8.8.8.8 или example.com"
                  className="h-10 bg-surface-2"
                />
              </label>
              <label htmlFor="bs-port" className="space-y-1.5 text-[12.5px] font-medium">
                Порт
                <Input
                  id="bs-port"
                  aria-label="Порт проверки"
                  disabled={locked}
                  inputMode="numeric"
                  value={port}
                  onChange={(e) => {
                    setPort(e.target.value);
                    change();
                  }}
                  className="h-10 bg-surface-2"
                />
              </label>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex gap-4">
                {[
                  ['TCP', tcp, setTcp],
                  ['ICMP', icmp, setIcmp],
                ].map(([label, value, setter]) => (
                  <label
                    htmlFor={`bs-method-${label}`}
                    key={label as string}
                    className="flex items-center gap-2 text-[13px]"
                  >
                    <Checkbox
                      id={`bs-method-${label}`}
                      disabled={locked}
                      checked={value as boolean}
                      onCheckedChange={(v) => {
                        (setter as (v: boolean) => void)(v === true);
                        change();
                      }}
                    />
                    {label as string}
                  </label>
                ))}
              </div>
              <CardButton
                className="h-10"
                disabled={!q.data || !ip || (!tcp && !icmp) || locked}
                onClick={() => {
                  setError(null);
                  setPoints(true);
                }}
              >
                Выбрать точки и проверить
              </CardButton>
            </div>
            {locked && (
              <p className="text-[12px] text-warn">
                Есть незавершённая проверка. Откройте её в истории и получите результат.
              </p>
            )}
            {error && (
              <p role="alert" className="text-[12.5px] text-crit">
                {error}
              </p>
            )}
          </div>
          <header className="flex flex-none items-center justify-between border-y border-border px-[18px] py-3">
            <h3 className="flex items-center gap-2 text-[13px] font-semibold">
              <HistoryIcon className="size-4 text-text-3" />
              История проверок <span className="text-text-3">{history.data?.runs.length ?? 0}</span>
            </h3>
            <BarButton
              className="h-9 min-w-0"
              disabled={history.isFetching}
              onClick={() => void history.refetch()}
            >
              Обновить
            </BarButton>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-3 max-lg:max-h-[360px]">
            {history.isPending && <RowsSkeleton label="Загрузка истории проверок" />}
            {history.isError && (
              <p role="alert" className="p-3 text-[13px] text-crit">
                {apiErrorMessage(history.error)}
              </p>
            )}
            {history.data?.runs.length === 0 && (
              <div className="grid min-h-[110px] place-content-center text-center">
                <p className="text-[13px] text-text-2">Проверок пока нет</p>
                <p className="mt-1 text-[12px] text-text-3">
                  Здесь будут цели, время и сохранённые результаты.
                </p>
              </div>
            )}
            <div className="space-y-2">
              {history.data?.runs.map((entry) => (
                <button
                  type="button"
                  key={entry.run.id}
                  onClick={() => void openResult(entry)}
                  className="flex w-full cursor-pointer items-center gap-3 rounded-[10px] border border-border bg-surface-2 p-3 text-left transition-colors hover:border-border-2 focus-visible:outline-brand"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-[13px] font-medium">{entry.target}</p>
                    <p className="mt-1 text-[11.5px] text-text-3">
                      {formatDate(entry.createdAt)} · {pointCount(entry.units)} ·{' '}
                      {credits(entry.run.costCredits ?? entry.estimatedCredits)}
                    </p>
                  </div>
                  <Pill tone={availability(entry.run).tone}>{availability(entry.run).label}</Pill>
                  <ChevronRightIcon className="size-4 flex-none text-text-3" />
                </button>
              ))}
            </div>
          </div>
        </section>
        <BsRentals />
      </div>
      <Dialog
        open={points}
        onOpenChange={(v) => {
          setPoints(v);
          if (!v) preview.reset();
        }}
      >
        <DialogContent className="flex h-[min(720px,90dvh)] flex-col sm:max-w-[880px]">
          <DialogTitle className="pr-10">Точки проверки</DialogTitle>
          <DialogDescription>
            Цель {ip}:{port}. Точки с активным БС и без БС могут дать разные результаты. Выберите нужный режим
            перед расчётом.
          </DialogDescription>
          <div className="grid flex-none gap-3 sm:grid-cols-[minmax(0,1fr)_160px_160px]">
            <div className="relative">
              <SearchIcon className="absolute top-3 left-3 size-4 text-text-3" />
              <Input
                aria-label="Поиск точек"
                placeholder="Оператор или регион"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-10 pl-9"
              />
            </div>
            <Select value={region} onValueChange={setRegion}>
              <SelectTrigger aria-label="Регион точек" className="h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Все регионы</SelectItem>
                {[...new Set(q.data?.units.map((u) => u.region))].sort().map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={dpi} onValueChange={setDpi}>
              <SelectTrigger aria-label="Режим БС" className="h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Все точки</SelectItem>
                <SelectItem value="on">БС активен</SelectItem>
                <SelectItem value="off">Без БС</SelectItem>
                <SelectItem value="unknown">БС неизвестно</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-none flex-wrap items-center justify-between gap-2">
            <span className="text-[13px] text-text-3">
              Выбрано {operators.length} из {available.length}
            </span>
            <div className="flex gap-2">
              <BarButton
                className="h-9 min-w-0"
                onClick={() => {
                  setOperators(
                    [
                      ...new Set([...operators, ...filtered.filter((u) => u.probeable).map((u) => u.op_key)]),
                    ].slice(0, 100),
                  );
                  change();
                }}
              >
                Выбрать показанные
              </BarButton>
              <BarButton
                className="h-9 min-w-0"
                onClick={() => {
                  setOperators([]);
                  change();
                }}
              >
                Очистить
              </BarButton>
            </div>
          </div>
          {q.data?.unitsError && (
            <p role="alert" className="text-[12px] text-warn">
              {q.data.unitsError}
            </p>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="grid gap-2 sm:grid-cols-2">
              {filtered.map((u) => (
                <label
                  key={u.op_key}
                  htmlFor={`bs-unit-${u.op_key}`}
                  className="flex cursor-pointer items-center gap-3 rounded-[10px] border border-border bg-surface-2 px-3 py-3 text-[12.5px] hover:border-border-2"
                >
                  <Checkbox
                    id={`bs-unit-${u.op_key}`}
                    checked={operators.includes(u.op_key)}
                    disabled={!u.probeable || (!operators.includes(u.op_key) && operators.length >= 100)}
                    onCheckedChange={(v) => {
                      setOperators(
                        v === true ? [...operators, u.op_key] : operators.filter((k) => k !== u.op_key),
                      );
                      change();
                    }}
                  />
                  <span className="min-w-0 flex-1">
                    <b>{u.name}</b>
                    <span className="block text-[11.5px] text-text-3">
                      {u.region} · {u.probeable ? 'Доступна' : 'Недоступна'}
                    </span>
                  </span>
                  <Pill tone={u.dpi === 'on' ? 'warn' : 'muted'}>
                    {u.dpi === 'on' ? 'БС активен' : u.dpi === 'off' ? 'Без БС' : 'БС неизвестно'}
                  </Pill>
                </label>
              ))}
            </div>
            {!filtered.length && (
              <p className="p-5 text-center text-text-3">Нет точек по выбранным фильтрам</p>
            )}
          </div>
          <footer className="flex flex-none flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
            <div className="text-[13px]">
              {preview.data ? (
                <>
                  <span className="text-text-3">Стоимость </span>
                  <b>{credits(preview.data.costCredits)}</b>
                  <p className="mt-1 text-[11.5px] text-text-3">Списание только после нажатия «Запустить».</p>
                </>
              ) : (
                <span className="text-text-3">Расчёт стоимости бесплатный</span>
              )}
              {error && (
                <p role="alert" className="mt-1 text-crit">
                  {error}
                </p>
              )}
            </div>
            <CardButton
              className="h-10"
              disabled={!operators.length || preview.isPending || execute.isPending}
              onClick={() => (preview.data ? void start(preview.data.id) : void price())}
            >
              {preview.isPending
                ? 'Рассчитываю…'
                : preview.data
                  ? `Запустить за ${credits(preview.data.costCredits)}`
                  : 'Рассчитать стоимость'}
            </CardButton>
          </footer>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!selected}
        onOpenChange={(v) => {
          if (!v) setSelected(null);
        }}
      >
        <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-[960px]">
          <DialogTitle className="pr-10">Результат проверки · {selected?.target}</DialogTitle>
          <DialogDescription>
            {selected
              ? `${formatDate(selected.createdAt)} · ${pointCount(selected.units)}`
              : 'Сохранённые результаты'}
          </DialogDescription>
          {selected && (
            <>
              <div className="flex flex-none flex-wrap items-center gap-3">
                <Pill tone={runTone(selected.run)}>{statuses[selected.run.status]}</Pill>
                <span className="text-[13px] text-text-3">
                  Списано: {selected.run.costCredits === null ? '—' : credits(selected.run.costCredits)} ·
                  Возвращено:{' '}
                  {selected.run.refundedCredits === null ? '—' : credits(selected.run.refundedCredits)}
                </span>
              </div>
              {selected.run.status === 'done' && selected.run.rows.length > 0 && (
                <div className="grid grid-cols-2 gap-3">
                  {(['tcp', 'icmp'] as const).map((method) => {
                    const known = selected.run.rows.filter((r) => r[method] !== null),
                      ok = known.filter((r) => r[method] === true).length;
                    return (
                      <div key={method} className="rounded-[11px] border border-border bg-surface-2 p-3">
                        <p className="text-[12px] text-text-3">{method.toUpperCase()}</p>
                        <p className="mt-1 text-[14px] font-semibold">
                          {ok} доступно · {known.length - ok} недоступно
                        </p>
                        {known.length < selected.run.rows.length && (
                          <p className="mt-1 text-[12px] text-text-3">
                            Нет данных: {selected.run.rows.length - known.length}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="min-h-0 overflow-y-auto">
                {selected.run.status === 'running' && (
                  <p className="py-4 text-text-3">
                    Проверка выполняется. Ответ может занять около двух минут.
                  </p>
                )}
                {selected.run.error && (
                  <p role="alert" className="mb-3 rounded-[10px] bg-warn-soft p-3 text-[13px] text-warn">
                    {selected.run.error}
                  </p>
                )}
                {!!selected.run.skippedCount && (
                  <p className="mb-3 text-[13px] text-warn">
                    Пропущено сервисом: {selected.run.skippedCount}.
                  </p>
                )}
                {selected.run.rows.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[650px] table-fixed text-left text-[12.5px]">
                      <colgroup>
                        <col className="w-[220px]" />
                        <col className="w-[110px]" />
                        <col className="w-[110px]" />
                        <col />
                      </colgroup>
                      <thead className="text-text-3">
                        <tr>
                          {['Точка проверки', 'TCP', 'ICMP', 'Примечание'].map((h) => (
                            <th key={h} className="px-2 py-3 font-medium whitespace-nowrap">
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {selected.run.rows.map((row) => (
                          <tr key={row.unit} className="border-t border-border">
                            <td className="px-2 py-3">
                              <div className="flex items-center gap-2">
                                <span
                                  className="min-w-0 truncate"
                                  title={
                                    q.data?.units.find((u) => u.op_key === row.unit)?.name ?? row.operator
                                  }
                                >
                                  {q.data?.units.find((u) => u.op_key === row.unit)?.name ?? row.operator}
                                </span>
                                <span className="flex-none">
                                  <Pill tone={row.dpi === 'on' ? 'warn' : 'muted'}>
                                    {row.dpi === 'on'
                                      ? 'БС активен'
                                      : row.dpi === 'off'
                                        ? 'Без БС'
                                        : 'БС неизвестно'}
                                  </Pill>
                                </span>
                              </div>
                              <span className="mt-1 block text-text-3">{row.region}</span>
                            </td>
                            {[row.tcp, row.icmp].map((v, i) => (
                              <td key={i === 0 ? 'tcp' : 'icmp'} className="px-2 py-3">
                                <Pill tone={v === null ? 'muted' : v ? 'ok' : 'crit'}>
                                  {v === null ? 'Нет данных' : v ? 'Доступно' : 'Недоступно'}
                                </Pill>
                              </td>
                            ))}
                            <td className="break-words px-2 py-3 text-text-3">
                              {row.tcpIsTls ? 'Проверка TCP с TLS. ' : ''}
                              {explainProbeError(row.error)}
                              {row.error && (
                                <details className="mt-2 text-[11.5px]">
                                  <summary className="cursor-pointer text-text-2">Технические детали</summary>
                                  <p className="mt-1 break-all font-mono">{row.error}</p>
                                </details>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {selected.run.status === 'done' && !selected.run.rows.length && (
                  <p className="py-3 text-warn">
                    Сервис не вернул результаты точек. Доступность не подтверждена.
                  </p>
                )}
              </div>
              <footer className="flex flex-none flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
                <p className="text-[12px] text-text-3">«Нет данных» не означает недоступность.</p>
                {['running', 'uncertain'].includes(selected.run.status) && (
                  <CardButton
                    className="h-10"
                    disabled={execute.isPending}
                    onClick={() => void start(selected.run.id, selected)}
                  >
                    {execute.isPending ? 'Получаю результат…' : 'Получить результат той же проверки'}
                  </CardButton>
                )}
              </footer>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
