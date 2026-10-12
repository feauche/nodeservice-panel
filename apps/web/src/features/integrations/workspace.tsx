import {
  type DnsRecord,
  type DpiCheck,
  dnsHistorySchema,
  dnsWorkspaceSchema,
  dpiCheckSchema,
  dpiScheduleSchema,
  dpiWorkspaceSchema,
} from '@nodeservice/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarClockIcon,
  ChevronRightIcon,
  HistoryIcon,
  PlusIcon,
  RefreshCwIcon,
  Settings2Icon,
} from 'lucide-react';
import { type ComponentProps, type ReactNode, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { DialogPrimaryButton, DialogSecondaryButton } from '@/components/dialog-actions';
import { Button as BaseButton } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { nodeOption } from '@/features/nodes/node-option';

function Button(props: ComponentProps<typeof BaseButton>) {
  return (
    <BaseButton
      {...props}
      className={`h-10 rounded-[10px] px-4 text-[13px] font-medium ${props.className ?? ''}`}
    />
  );
}

import { Pagination } from '@/components/pagination';
import { Combobox } from '@/components/ui/combobox';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useNodes } from '@/features/nodes/nodes-api';
import { Toggle } from '@/features/settings/settings-ui';
import { api, apiErrorMessage } from '@/lib/api';

const card = 'overflow-hidden rounded-2xl border border-border bg-surface';
const footer = 'flex flex-wrap items-center justify-between gap-3 border-t border-border bg-bg-2 p-4';
function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className={`${card} p-5`}>
      <p className="text-xs text-text-3">{label}</p>
      <strong className="my-3 block break-words text-2xl tabular-nums xl:text-3xl">{value}</strong>
      <p className="text-xs text-text-2">{hint}</p>
    </div>
  );
}
function SummaryStrip({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-2 overflow-hidden rounded-[14px] border border-border bg-surface xl:grid-cols-4 [&>*]:border-border [&>*]:border-b [&>*]:p-[18px] [&>*:nth-child(odd)]:border-r [&>*:nth-last-child(-n+2)]:border-b-0 xl:[&>*]:border-b-0 xl:[&>*:not(:last-child)]:border-r">
      {children}
    </div>
  );
}
function SummaryItem({
  label,
  value,
  hint,
  loading = false,
}: {
  label: string;
  value: string;
  hint: string;
  loading?: boolean;
}) {
  return (
    <div>
      <p className="text-[11.5px] text-text-3">{label}</p>
      {loading ? (
        <div role="status" aria-label={`Загрузка: ${label}`} className="my-2 flex h-[33px] items-center">
          <Skeleton aria-hidden="true" className="h-6 w-28 max-w-full motion-reduce:animate-none" />
        </div>
      ) : (
        <strong className="my-2 block break-words text-[22px] font-semibold tabular-nums">{value}</strong>
      )}
      <p className="min-h-[18px] text-[11.5px] text-text-2">{hint}</p>
    </div>
  );
}
function DpiChecksSkeleton() {
  return (
    <div role="status" aria-label="Загрузка истории DPI Checker" className="divide-y divide-border">
      {[0, 1, 2].map((row) => (
        <div
          key={row}
          aria-hidden="true"
          className="grid min-h-[68px] grid-cols-[minmax(0,1fr)_16px] items-center gap-4 px-[18px] py-3.5 sm:grid-cols-[minmax(180px,1.4fr)_minmax(130px,1fr)_minmax(120px,.8fr)_16px]"
        >
          <div className="space-y-2">
            <Skeleton className="h-4 w-40 max-w-full motion-reduce:animate-none" />
            <Skeleton className="h-3 w-28 motion-reduce:animate-none" />
          </div>
          <Skeleton className="hidden h-4 w-24 motion-reduce:animate-none sm:block" />
          <Skeleton className="hidden h-4 w-20 motion-reduce:animate-none sm:block" />
          <Skeleton className="size-4 motion-reduce:animate-none" />
        </div>
      ))}
    </div>
  );
}
export function DpiWorkspaceSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="flex justify-end gap-2" aria-hidden="true">
        <Skeleton className="h-10 w-36 rounded-[10px] motion-reduce:animate-none" />
        <Skeleton className="h-10 w-40 rounded-[10px] motion-reduce:animate-none" />
      </div>
      <SummaryStrip>
        {['Баланс', 'Проверки', 'Успешных точек', 'Расход в истории'].map((label) => (
          <SummaryItem key={label} label={label} value="" hint="" loading />
        ))}
      </SummaryStrip>
      <section className={card}>
        <div
          className="flex min-h-[75px] flex-wrap items-center gap-3 border-b border-border px-[18px] py-3.5"
          aria-hidden="true"
        >
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-24 motion-reduce:animate-none" />
            <Skeleton className="h-3 w-48 max-w-full motion-reduce:animate-none" />
          </div>
          <Skeleton className="h-10 w-32 rounded-[10px] motion-reduce:animate-none" />
        </div>
        <DpiChecksSkeleton />
      </section>
    </div>
  );
}
function ErrorNote({ error }: { error: string }) {
  return error ? (
    <p role="alert" className="rounded-xl border border-crit/30 bg-crit-soft p-3 text-sm text-crit">
      {error}
    </p>
  ) : null;
}
const date = (s: string) => (s && Number.isFinite(Date.parse(s)) ? new Date(s).toLocaleString('ru-RU') : '—');
const status = (c: DpiCheck) =>
  c.status === 'completed'
    ? c.success == null
      ? 'Завершена'
      : c.success === c.total
        ? 'Доступна'
        : 'Есть ограничения'
    : ({ pending: 'В очереди', running: 'Выполняется', failed: 'Ошибка', cancelled: 'Отменена' }[c.status] ??
      c.status);
export function DpiWorkspace({ balance, settings }: { balance: string | null; settings: () => void }) {
  const query = useQuery({
    queryKey: ['dpi-workspace'],
    queryFn: ({ signal }) => api.get('/integrations/dpi/overview', dpiWorkspaceSchema, signal),
    refetchInterval: 15000,
  });
  const nodes = useNodes();
  const client = useQueryClient();
  const [modal, setModal] = useState<'run' | 'schedule' | null>(null),
    [detail, setDetail] = useState<DpiCheck | null>(null),
    [node, setNode] = useState<string | null>(null),
    [kind, setKind] = useState<string | null>('ip'),
    [key, setKey] = useState(''),
    [pops, setPops] = useState<number[]>([]),
    [minutes, setMinutes] = useState(60),
    [enabled, setEnabled] = useState(false),
    [scheduleNodes, setScheduleNodes] = useState<string[]>([]),
    [search, setSearch] = useState(''),
    [popSearch, setPopSearch] = useState(''),
    [selectedPopsOnly, setSelectedPopsOnly] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [requestId, setRequestId] = useState(crypto.randomUUID());
  useEffect(() => {
    if (!detail || !['pending', 'running'].includes(detail.status)) return;
    const controller = new AbortController();
    const timer = setInterval(async () => {
      try {
        const result = await api.get(
          `/integrations/dpi/checks/${detail.id}`,
          dpiCheckSchema,
          controller.signal,
        );
        if (!controller.signal.aborted) setDetail(result);
      } catch {}
    }, 5000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [detail]);
  const detailRequest = useRef(0);
  const [detailLoading, setDetailLoading] = useState(false);
  function closeDetail() {
    detailRequest.current++;
    setDetail(null);
    setDetailLoading(false);
  }
  async function openDetail(check: DpiCheck) {
    const request = ++detailRequest.current;
    setDetail(check);
    setDetailLoading(true);
    setError('');
    try {
      const result = await api.get(`/integrations/dpi/checks/${check.id}`, dpiCheckSchema);
      if (request === detailRequest.current) setDetail(result);
    } catch (e) {
      if (request === detailRequest.current) setError(apiErrorMessage(e));
    } finally {
      if (request === detailRequest.current) setDetailLoading(false);
    }
  }
  const checks = query.data?.checks ?? [];
  const completed = checks.filter((c) => c.status === 'completed');
  const known = completed.filter((c) => c.success != null && c.total > 0);
  const costs = checks.filter((c) => c.cost != null);
  const spent = costs.reduce((n, c) => n + (c.cost ?? 0), 0);
  const visiblePops = (query.data?.pops ?? [])
    .filter((p) => !selectedPopsOnly || pops.includes(p.id))
    .filter((p) => `${p.name} ${p.provider}`.toLowerCase().includes(popSearch.trim().toLowerCase()))
    .sort((a, b) => a.provider.localeCompare(b.provider, 'ru') || a.name.localeCompare(b.name, 'ru'));
  const run = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await api.post(
        '/integrations/dpi/checks',
        { nodeUuid: node, kind, key: kind === 'vpn' ? key : undefined, popIds: pops, requestId },
        dpiCheckSchema,
      );
      setKey('');
      setModal(null);
      setDetail(result);
      await client.invalidateQueries({ queryKey: ['dpi-workspace'] });
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const saveSchedule = async () => {
    setBusy(true);
    setError('');
    try {
      await api.put(
        '/integrations/dpi/schedule',
        { enabled, minutes, nodes: scheduleNodes, pops },
        dpiScheduleSchema,
      );
      setModal(null);
      await client.invalidateQueries({ queryKey: ['dpi-workspace'] });
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  function openSchedule() {
    const s = query.data?.schedule;
    setEnabled(s?.enabled ?? false);
    setMinutes(s?.minutes ?? 60);
    setScheduleNodes(s?.nodes ?? []);
    setPops(s?.pops ?? []);
    setError('');
    setModal('schedule');
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={settings}>
          <Settings2Icon className="size-4" /> Подключение
        </Button>
        <Button
          onClick={() => {
            setRequestId(crypto.randomUUID());
            setError('');
            setModal('run');
          }}
        >
          <PlusIcon className="size-4" /> Новая проверка
        </Button>
      </div>
      <SummaryStrip>
        <SummaryItem
          label="Баланс"
          value={balance == null ? '—' : `${balance} USD`}
          hint="Аккаунт подключён"
        />
        <SummaryItem
          label="Проверки"
          value={String(checks.length)}
          hint="Последние 100 запусков"
          loading={query.isPending}
        />
        <SummaryItem
          label="Успешных точек"
          loading={query.isPending}
          value={
            known.length
              ? `${Math.round(
                  (known.reduce((n, c) => n + (c.success ?? 0), 0) / known.reduce((n, c) => n + c.total, 0)) *
                    100,
                )}%`
              : '—'
          }
          hint="По проверкам с результатами"
        />
        <SummaryItem
          label="Расход в истории"
          loading={query.isPending}
          value={
            costs.length
              ? `${spent.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} USD`
              : '—'
          }
          hint="Стоимость, возвращённая DPI Checker"
        />
      </SummaryStrip>
      <ErrorNote error={query.isError ? apiErrorMessage(query.error) : ''} />
      {query.data?.schedule.lastError && <ErrorNote error={query.data.schedule.lastError} />}
      <section className={card}>
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-[18px] py-3.5">
          <div className="min-w-[180px] flex-1">
            <h2 className="text-[14.5px] font-semibold">Проверки</h2>
            <div className="mt-0.5 text-[12px] text-text-3">
              {query.isPending ? (
                <Skeleton
                  aria-hidden="true"
                  className="mt-1 h-3 w-48 max-w-full motion-reduce:animate-none"
                />
              ) : query.data?.schedule.enabled ? (
                `Следующая по расписанию: ${date(query.data.schedule.nextAt ?? '')}`
              ) : (
                'Автоматические проверки выключены'
              )}
            </div>
          </div>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Нода или номер"
            className="h-10 max-w-xs"
          />
          <Button variant="outline" onClick={openSchedule} disabled={query.isPending}>
            <CalendarClockIcon className="size-4" /> Расписание
          </Button>
        </div>
        <div className="divide-y divide-border">
          {query.isPending && <DpiChecksSkeleton />}
          {checks
            .filter((c) => (c.node?.name ?? c.id).toLowerCase().includes(search.toLowerCase()))
            .map((c) => (
              <button
                type="button"
                key={c.id}
                onClick={() => void openDetail(c)}
                className="group grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-[18px] py-3.5 text-left transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-2 focus-visible:outline-brand sm:grid-cols-[minmax(180px,1.4fr)_minmax(130px,1fr)_minmax(120px,.8fr)_auto]"
              >
                <span className="min-w-0">
                  <strong className="block truncate text-[13.5px] font-medium group-hover:text-brand">
                    {c.node?.name ?? `Проверка #${c.id}`}
                  </strong>
                  <small className="block text-[11.5px] text-text-3">{date(c.createdAt)}</small>
                </span>
                <span className="hidden text-[12.5px] text-text-2 sm:block">{status(c)}</span>
                <span className="hidden text-[12.5px] text-text-3 sm:block">
                  {c.success == null ? c.kind.toUpperCase() : `${c.success} из ${c.total} точек`}
                </span>
                <ChevronRightIcon className="size-4 text-text-3 transition-transform group-hover:translate-x-0.5 group-hover:text-brand" />
              </button>
            ))}
          {!query.isPending && !query.isError && !checks.length && (
            <p className="p-5 text-sm text-text-3">Запустите первую проверку доступности ноды.</p>
          )}
        </div>
      </section>
      <ErrorNote error={modal ? '' : error} />
      <Dialog
        open={modal !== null}
        onOpenChange={(o) => {
          if (!o && !busy) {
            setModal(null);
            setKey('');
          }
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-auto p-0 sm:max-w-[720px]">
          <div className="border-b border-border p-5">
            <DialogTitle className="pr-10">
              {modal === 'run' ? 'Новая проверка' : 'Расписание IP-проверок'}
            </DialogTitle>
            <DialogDescription className="mt-2">
              Проверки оплачиваются с баланса DPI Checker. Платежи в Remnawave не создаются.
            </DialogDescription>
          </div>
          <fieldset disabled={busy} className="space-y-4 px-5">
            <ErrorNote error={error} />
            {modal === 'run' ? (
              <>
                <div className="rounded-[12px] border border-border bg-surface-2/55 px-4 py-3 text-[12.5px] leading-5 text-text-2">
                  <strong className="text-foreground">Что проверяет сервис.</strong> IP-проверка смотрит,
                  открывается ли адрес ноды из сетей выбранных операторов. VLESS-проверка дополнительно
                  пробует установить VPN-соединение по переданному ключу; ключ используется один раз и в
                  NodeService не сохраняется.
                </div>
                <div>
                  <p className="mb-2.5 text-sm font-medium text-text-2">Нода</p>
                  {nodes.isPending ? (
                    <Skeleton
                      role="status"
                      aria-label="Загрузка нод"
                      className="h-10 w-full rounded-[10px] motion-reduce:animate-none"
                    />
                  ) : (
                    <Combobox
                      ariaLabel="Нода для проверки"
                      value={node}
                      onChange={setNode}
                      options={(nodes.data?.nodes ?? []).map((n) =>
                        nodeOption({ id: n.uuid, name: n.name, host: n.address }),
                      )}
                      placeholder="Выберите ноду"
                      searchPlaceholder="Найти ноду…"
                      className="h-10 w-full"
                    />
                  )}
                </div>
                <div>
                  <p className="mb-2.5 text-sm font-medium text-text-2">Тип</p>
                  <Combobox
                    ariaLabel="Тип проверки"
                    placeholder="Выберите тип"
                    value={kind}
                    onChange={setKind}
                    options={[
                      { value: 'ip', label: 'IP — доступность адреса' },
                      { value: 'vpn', label: 'VLESS — подключение к VPN' },
                    ]}
                  />
                </div>
                {kind === 'vpn' && (
                  <label htmlFor="dpi-vless" className="block space-y-2 text-sm">
                    VLESS-ключ
                    <Input
                      id="dpi-vless"
                      type="password"
                      value={key}
                      onChange={(e) => setKey(e.target.value)}
                      autoComplete="off"
                      placeholder="vless://…"
                    />
                    <small className="text-text-3">
                      Отправляется DPI Checker для этой проверки; в NodeService не сохраняется.
                    </small>
                  </label>
                )}
              </>
            ) : (
              <>
                <label htmlFor="dpi-schedule-enabled" className="flex items-center gap-3 text-sm">
                  <Toggle
                    id="dpi-schedule-enabled"
                    checked={enabled}
                    onChange={(v) => setEnabled(v === true)}
                  />
                  Включить платные проверки по расписанию
                </label>
                <label htmlFor="dpi-interval" className="block space-y-2 text-sm">
                  Интервал, минут
                  <Input
                    id="dpi-interval"
                    type="number"
                    min={15}
                    max={10080}
                    value={minutes}
                    onChange={(e) => setMinutes(Number(e.target.value))}
                  />
                </label>
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm">
                    Ноды{' '}
                    <span className="text-text-3">
                      · {scheduleNodes.length} из {nodes.data?.nodes.length ?? 0}
                    </span>
                  </h3>
                  <Button
                    variant="outline"
                    disabled={busy || !nodes.data?.nodes.length}
                    onClick={() =>
                      setScheduleNodes(
                        nodes.data?.nodes.every((n) => scheduleNodes.includes(n.uuid))
                          ? []
                          : (nodes.data?.nodes.map((n) => n.uuid) ?? []),
                      )
                    }
                  >
                    {nodes.data?.nodes.length && nodes.data.nodes.every((n) => scheduleNodes.includes(n.uuid))
                      ? 'Снять выбор'
                      : 'Выбрать все'}
                  </Button>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {nodes.data?.nodes.map((n) => (
                    <label
                      htmlFor={`dpi-node-${n.uuid}`}
                      className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-border px-3 py-2 text-[13px] transition-colors hover:bg-surface-2"
                      key={n.uuid}
                    >
                      <Toggle
                        id={`dpi-node-${n.uuid}`}
                        checked={scheduleNodes.includes(n.uuid)}
                        disabled={busy}
                        onChange={(checked) =>
                          setScheduleNodes(
                            checked === true
                              ? [...scheduleNodes, n.uuid]
                              : scheduleNodes.filter((id) => id !== n.uuid),
                          )
                        }
                      />
                      {n.name}
                    </label>
                  ))}
                </div>
              </>
            )}
            <div>
              <div className="mb-2 flex items-center justify-between gap-3">
                <h3 className="text-sm">
                  Точки проверки{' '}
                  <span className="text-text-3">
                    · {pops.length} из {query.data?.pops.length ?? 0}
                  </span>
                </h3>
                <Button
                  variant="outline"
                  disabled={busy || !query.data?.pops.length}
                  onClick={() =>
                    setPops(
                      query.data?.pops.every((p) => pops.includes(p.id))
                        ? []
                        : (query.data?.pops.map((p) => p.id) ?? []),
                    )
                  }
                >
                  {query.data?.pops.length && query.data.pops.every((p) => pops.includes(p.id))
                    ? 'Снять выбор'
                    : 'Выбрать все'}
                </Button>
              </div>
              <p className="mb-3 text-xs text-text-3">
                Без выбора сервис подберёт оптимальные доступные точки.
              </p>
              <div className="mb-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <Input
                  value={popSearch}
                  onChange={(e) => setPopSearch(e.target.value)}
                  placeholder="Найти регион или оператора"
                  aria-label="Поиск точек проверки"
                  className="h-10"
                />
                <Button
                  type="button"
                  variant={selectedPopsOnly ? 'default' : 'outline'}
                  onClick={() => setSelectedPopsOnly((value) => !value)}
                >
                  Выбранные · {pops.length}
                </Button>
              </div>
              <div className="grid max-h-64 gap-2 overflow-auto rounded-[12px] border border-border bg-bg-2/45 p-2 sm:grid-cols-2">
                {query.isPending &&
                  [0, 1, 2, 3].map((row) => (
                    <Skeleton
                      key={row}
                      role={row === 0 ? 'status' : undefined}
                      aria-label={row === 0 ? 'Загрузка точек проверки' : undefined}
                      className="h-11 w-full rounded-lg motion-reduce:animate-none"
                    />
                  ))}
                {visiblePops.map((p) => (
                  <label
                    htmlFor={`dpi-pop-${p.id}`}
                    key={p.id}
                    className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-border px-3 py-2 text-[13px] transition-colors hover:bg-surface-2"
                  >
                    <Toggle
                      id={`dpi-pop-${p.id}`}
                      checked={pops.includes(p.id)}
                      disabled={busy}
                      onChange={(checked) =>
                        setPops(checked === true ? [...pops, p.id] : pops.filter((id) => id !== p.id))
                      }
                    />
                    {p.name} {p.provider}
                  </label>
                ))}
                {!query.isPending && !visiblePops.length && (
                  <p className="col-span-full px-3 py-8 text-center text-xs text-text-3">
                    Точки с таким регионом или оператором не найдены.
                  </p>
                )}
              </div>
            </div>
          </fieldset>
          <div className={footer}>
            <DialogSecondaryButton
              disabled={busy}
              onClick={() => {
                setKey('');
                setModal(null);
              }}
            >
              Отмена
            </DialogSecondaryButton>
            <DialogPrimaryButton
              disabled={busy || (modal === 'run' && !node)}
              onClick={() => void (modal === 'run' ? run() : saveSchedule())}
            >
              {busy ? 'Сохраняю…' : modal === 'run' ? 'Запустить проверку' : 'Сохранить'}
            </DialogPrimaryButton>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={!!detail} onOpenChange={(o) => !o && closeDetail()}>
        <DialogContent className="max-h-[85dvh] overflow-auto sm:max-w-[760px]">
          <DialogTitle className="pr-10">Проверка #{detail?.id}</DialogTitle>
          <ErrorNote error={error} />
          <DialogDescription>
            {detail && status(detail)} · {detail && date(detail.createdAt)}
          </DialogDescription>
          {detailLoading && (
            <div aria-label="Загрузка результата" role="status" className="space-y-3 py-4">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          )}
          <div className="divide-y divide-border">
            {!detailLoading &&
              detail?.results.map((r, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: Immutable result order; the provider may return identical unnamed locations.
                <div key={r.location + i} className="flex justify-between gap-3 py-3 text-sm">
                  <span>{r.location}</span>
                  <span
                    className={
                      r.accessible === true ? 'text-ok' : r.accessible === false ? 'text-crit' : 'text-text-3'
                    }
                  >
                    {r.accessible === true
                      ? 'Доступно'
                      : r.accessible === false
                        ? 'Недоступно'
                        : 'Нет результата'}
                    {r.latency != null ? ` · ${r.latency} мс` : ''}
                  </span>
                </div>
              ))}
          </div>
          {!detailLoading && !detail?.results.length && (
            <p className="text-sm text-text-3">Результаты точек ещё не получены.</p>
          )}
          <div className="flex justify-end border-t border-border pt-4">
            <Button
              variant="outline"
              onClick={async () => {
                try {
                  if (detail)
                    setDetail(await api.get(`/integrations/dpi/checks/${detail.id}`, dpiCheckSchema));
                } catch (e) {
                  setError(apiErrorMessage(e));
                }
              }}
            >
              <RefreshCwIcon className="size-4" /> Обновить результат
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
export function DnsWorkspace({ settings }: { settings: () => void }) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['dns-workspace'],
    queryFn: ({ signal }) => api.get('/integrations/dns/overview', dnsWorkspaceSchema, signal),
    refetchInterval: 30000,
  });
  const history = useQuery({
    queryKey: ['dns-history'],
    queryFn: ({ signal }) => api.get('/integrations/dns/history', dnsHistorySchema, signal),
    refetchInterval: 30000,
  });
  const nodesQuery = useNodes();
  const [zone, setZone] = useState<string | null>(null),
    [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState('25');
  const [search, setSearch] = useState(''),
    [record, setRecord] = useState<DnsRecord | null>(null),
    [historyOpen, setHistoryOpen] = useState(false),
    [node, setNode] = useState<string | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const data = query.data;
  const target = nodesQuery.data?.nodes.find((n) => n.uuid === node);
  const records = data?.records ?? [];
  const automatic = (r: DnsRecord) =>
    data?.settings.automaticRecords.includes(r.id) ||
    r.nodes.some((n) => data?.settings.automaticNodes.includes(n.uuid));
  async function setAutomatic(record: DnsRecord, checked: boolean) {
    setBusy(true);
    setError('');
    try {
      await api.put(
        '/integrations/dns/settings',
        { recordId: record.id, enabled: checked },
        z.object({ automaticNodes: z.array(z.string()), automaticRecords: z.array(z.string()) }),
      );
      await client.invalidateQueries({ queryKey: ['dns-workspace'] });
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const filtered = records
    .filter(
      (r) =>
        (!zone || r.zone === zone) &&
        [r.name, r.content, r.type, ...r.nodes.map((n) => n.name)]
          .join(' ')
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(b.nodes.length > 0) - Number(a.nodes.length > 0) ||
        a.name.localeCompare(b.name, 'ru') ||
        a.content.localeCompare(b.content),
    );
  const totalPages = Math.max(1, Math.ceil(filtered.length / Number(pageSize))),
    currentPage = Math.min(page, totalPages);
  const shown = filtered.slice((currentPage - 1) * Number(pageSize), currentPage * Number(pageSize));
  async function apply() {
    if (!record || !target) return;
    setBusy(true);
    setError('');
    try {
      await api.post(
        '/integrations/dns/apply',
        { recordId: record.id, nodeUuid: node, expected: record.content },
        z.object({ changed: z.boolean() }),
      );
      setRecord(null);
      await client.invalidateQueries({ queryKey: ['dns-workspace'] });
      await client.invalidateQueries({ queryKey: ['dns-history'] });
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={settings}>
          <Settings2Icon className="size-4" /> Подключения
        </Button>
        <Button variant="outline" onClick={() => setHistoryOpen(true)}>
          <HistoryIcon className="size-4" /> История замен
        </Button>
        <Button
          variant="outline"
          disabled={query.isFetching}
          onClick={async () => {
            try {
              await api.post('/integrations/dns/workspace/refresh', {}, dnsWorkspaceSchema);
              await query.refetch();
            } catch (e) {
              setError(apiErrorMessage(e));
            }
          }}
        >
          <RefreshCwIcon className="size-4" /> Обновить
        </Button>
      </div>
      <SummaryStrip>
        <SummaryItem
          label="Домены"
          value={String(data?.domains.length ?? 0)}
          hint="Все зоны, доступные подключённым аккаунтам"
        />
        <SummaryItem
          label="DNS-записи"
          value={String(records.length)}
          hint="Все типы, включая A, AAAA и CNAME"
        />
        <SummaryItem
          label="Соответствуют нодам"
          value={String(records.filter((r) => r.nodes.some((n) => n.address === r.content)).length)}
          hint="Адрес DNS совпадает с нодой"
        />
        <SummaryItem
          label="Требуют внимания"
          value={String(
            records.filter((r) => r.nodes.length > 0 && !r.nodes.some((n) => n.address === r.content)).length,
          )}
          hint="Связана с нодой, но адрес отличается"
        />
      </SummaryStrip>
      <ErrorNote error={query.isError ? apiErrorMessage(query.error) : ''} />
      {data?.errors.map((e) => (
        <ErrorNote key={e} error={e} />
      ))}
      <ErrorNote error={record ? '' : error} />
      <section className={card}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4">
          <h2 className="font-semibold">Все DNS-записи</h2>
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Домен, адрес или нода"
            className="max-w-sm"
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-4">
          <div className="w-64">
            <Combobox
              ariaLabel="Домен DNS"
              value={zone}
              onChange={(v) => {
                setZone(v);
                setPage(1);
              }}
              options={(data?.domains ?? []).map((d) => ({ value: d.name, label: d.name }))}
              placeholder="Все домены"
              emptyLabel="Все домены"
            />
          </div>
          <span className="text-xs text-text-3">Найдено записей: {filtered.length}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[750px] text-left text-sm">
            <thead className="bg-surface-2 text-xs text-text-3">
              <tr>
                {['Домен', 'Провайдер', 'Нода', 'Адрес DNS', 'Состояние', 'Автообновление', ''].map((h) => (
                  <th className="p-4" key={h}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr className="border-t border-border transition-colors hover:bg-surface-2/60" key={r.id}>
                  <td className="p-4">
                    {r.name}
                    <small className="block text-text-3">
                      {r.type} · TTL {r.ttl}
                    </small>
                  </td>
                  <td className="px-4">{r.provider === 'regru' ? 'REG.RU' : 'Cloudflare'}</td>
                  <td className="px-4">{r.nodes.map((n) => n.name).join(', ') || 'Не связана'}</td>
                  <td className="max-w-[260px] break-all px-4 py-3 font-mono text-xs">{r.content}</td>
                  <td
                    className={
                      r.nodes.some((n) => n.address === r.content)
                        ? 'px-4 text-ok'
                        : r.nodes.length
                          ? 'px-4 text-warn'
                          : 'px-4 text-text-3'
                    }
                  >
                    {r.nodes.some((n) => n.address === r.content)
                      ? 'Соответствует'
                      : r.nodes.length
                        ? 'Проверить'
                        : 'Без привязки'}
                  </td>
                  <td className="px-4">
                    {['A', 'AAAA'].includes(r.type) && r.nodes.length === 1 ? (
                      <Toggle
                        id={`dns-auto-${r.id}`}
                        aria-label={`Автообновление ${r.name} ${r.content}`}
                        checked={Boolean(automatic(r))}
                        disabled={busy}
                        onChange={(checked) => void setAutomatic(r, checked)}
                      />
                    ) : (
                      <span className="text-text-3">—</span>
                    )}
                  </td>
                  <td className="p-3">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setRecord(r);
                        setNode(r.nodes.length === 1 ? r.nodes[0]?.uuid : null);
                        setError('');
                      }}
                    >
                      Открыть
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!records.length && query.isFetching ? (
            <div
              role="status"
              aria-label="Загрузка доменов и DNS-записей"
              className="mx-auto flex min-h-72 w-full max-w-3xl flex-col justify-center gap-3 px-6 py-10"
            >
              <div className="mb-2 flex flex-col items-center gap-2 text-center">
                <Skeleton className="h-5 w-44" />
                <Skeleton className="h-3 w-64 max-w-full" />
              </div>
              {[1, 2, 3].map((row) => (
                <div
                  key={row}
                  className="grid grid-cols-[1.4fr_.8fr_1fr] gap-4 rounded-xl border border-border p-4"
                >
                  <Skeleton className="h-4 w-4/5" />
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-full" />
                </div>
              ))}
            </div>
          ) : !records.length ? (
            <p className="p-8 text-center text-sm text-text-3">
              DNS-записей не найдено. Проверьте доступ токена к зонам.
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-4">
          <span className="text-xs text-text-2">
            {filtered.length ? (currentPage - 1) * Number(pageSize) + 1 : 0}–
            {Math.min(currentPage * Number(pageSize), filtered.length)} из {filtered.length}
          </span>
          <div className="flex items-center gap-3">
            <span className="text-xs text-text-3">На странице</span>
            <div className="w-24">
              <Combobox
                ariaLabel="Записей на странице"
                value={pageSize}
                onChange={(v) => {
                  setPageSize(v ?? '25');
                  setPage(1);
                }}
                options={['10', '25', '50', '100'].map((v) => ({ value: v, label: v }))}
                placeholder="25"
              />
            </div>
            <Pagination
              page={currentPage}
              totalPages={totalPages}
              onChange={setPage}
              label="Страницы DNS-записей"
            />
          </div>
        </div>
      </section>
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="max-h-[82dvh] overflow-hidden p-0 sm:max-w-[760px]">
          <div className="border-b border-border px-5 py-4">
            <DialogTitle className="pr-10">История замен DNS</DialogTitle>
            <DialogDescription className="mt-1.5">
              Последние ручные и автоматические изменения адресов.
            </DialogDescription>
          </div>
          <div className="max-h-[62dvh] overflow-y-auto divide-y divide-border">
            {history.isPending && (
              <div className="space-y-3 p-5" role="status" aria-label="Загрузка истории замен">
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
              </div>
            )}
            {history.data?.items.slice(0, 50).map((e) => (
              <div
                key={`${e.at}:${e.domain}:${e.old}:${e.next}`}
                className="grid gap-2 px-5 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto]"
              >
                <span className="min-w-0 text-[13.5px] font-medium">
                  {e.domain}
                  <small className="mt-0.5 block truncate font-mono text-[11.5px] font-normal text-text-3">
                    {e.old} → {e.next}
                  </small>
                </span>
                <span
                  className={
                    e.status === 'success'
                      ? 'text-[12.5px] text-ok'
                      : e.status === 'partial'
                        ? 'text-[12.5px] text-warn'
                        : 'text-[12.5px] text-crit'
                  }
                >
                  {e.status === 'success'
                    ? 'Обновлено'
                    : e.status === 'partial'
                      ? 'Частично выполнено'
                      : 'Ошибка'}
                  <small className="block text-text-3">{date(e.at)}</small>
                </span>
              </div>
            ))}
            {!history.isPending && !history.data?.items.length && (
              <p className="p-5 text-sm text-text-3">Замен DNS пока не было.</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={!!record} onOpenChange={(o) => !o && !busy && setRecord(null)}>
        <DialogContent className="overflow-hidden p-0 sm:max-w-[760px]">
          <div className="border-b border-border p-5">
            <DialogTitle>{record?.name}</DialogTitle>
            <DialogDescription>
              {record?.provider === 'regru' ? 'REG.RU' : 'Cloudflare'} · {record?.type}
            </DialogDescription>
          </div>
          <div className="space-y-4 px-5">
            <ErrorNote error={error} />
            <div>
              <p id="dns-node-label" className="mb-2.5 text-sm font-medium text-text-2">
                Связанная нода
              </p>
              <Combobox
                id="dns-node"
                ariaLabel="Связанная нода"
                value={node}
                onChange={setNode}
                options={(nodesQuery.data?.nodes ?? []).map((n) =>
                  nodeOption({ id: n.uuid, name: n.name, host: n.address }),
                )}
                placeholder="Выберите ноду"
                searchPlaceholder="Найти ноду…"
                disabled={busy}
                className="h-10 w-full"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Metric
                label="Текущий DNS-адрес"
                value={record?.content ?? '—'}
                hint="Сверяется перед сохранением"
              />
              <Metric label="Новый адрес" value={target?.address ?? '—'} hint="Адрес выбранной ноды" />
            </div>
            <p className="text-xs text-text-3">
              {['A', 'AAAA'].includes(record?.type ?? '')
                ? 'Изменится только эта запись. TTL и проксирование Cloudflare сохраняются.'
                : 'Эта запись не содержит IP-адрес. Здесь она доступна для просмотра.'}
            </p>
          </div>
          <div className={footer}>
            <DialogSecondaryButton onClick={() => setRecord(null)} disabled={busy}>
              Отмена
            </DialogSecondaryButton>
            <DialogPrimaryButton
              disabled={
                busy ||
                !target ||
                !['A', 'AAAA'].includes(record?.type ?? '') ||
                target.address === record?.content
              }
              onClick={() => void apply()}
            >
              {busy ? 'Применяю…' : 'Заменить адрес'}
            </DialogPrimaryButton>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
