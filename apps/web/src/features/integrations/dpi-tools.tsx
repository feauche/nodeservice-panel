import {
  dpiNoisySchema,
  dpiProbeSchema,
  dpiQuotaSchema,
  dpiRknSchema,
  dpiScanStartSchema,
  type RemnawaveNode,
} from '@nodeservice/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2Icon, ScanLineIcon, SearchIcon, UsersIcon, XIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { DialogPrimaryButton, DialogSecondaryButton } from '@/components/dialog-actions';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { nodeOption } from '@/features/nodes/node-option';
import { Pill } from '@/features/settings/settings-ui';
import { api, apiErrorMessage } from '@/lib/api';
import { plural } from '@/lib/plural';
import { cn, randomId } from '@/lib/utils';

type Tool = 'rkn' | 'noisy' | 'probe';
type ProbePrice = { fixed: number; perGb: number } | null;
const money = (n: number) =>
  `${n.toLocaleString('ru-RU', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: n < 1 ? 3 : 2 })} $`;
const whenFmt = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/** Итог инструмента: цветная рамка, заголовок и пояснение. */
function Verdict({
  tone,
  title,
  children,
}: {
  tone: 'ok' | 'warn' | 'crit' | 'muted';
  title: string;
  children?: ReactNode;
}) {
  return (
    <div
      role="status"
      className={cn(
        'rounded-[12px] border px-4 py-3',
        tone === 'ok'
          ? 'border-ok/35 bg-ok-soft/50'
          : tone === 'crit'
            ? 'border-crit/35 bg-crit-soft/50'
            : tone === 'warn'
              ? 'border-warn/35 bg-warn-soft/50'
              : 'border-border bg-surface-2/50',
      )}
    >
      <b className="text-[14px] font-semibold">{title}</b>
      {children && <div className="mt-0.5 text-[12.5px] leading-relaxed text-text-2">{children}</div>}
    </div>
  );
}
/** Список соседей: адрес, домен и чем подозрителен. */
function Hosts({
  title,
  items,
}: {
  title: string;
  items: Array<{ ip: string; domain: string; note: string }>;
}) {
  if (!items.length) return null;
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-semibold tracking-[0.08em] text-text-3 uppercase">
        {title} · {items.length}
      </p>
      <ul className="flex flex-col rounded-[12px] border border-border">
        {items.slice(0, 30).map((h) => (
          <li
            key={`${h.ip}:${h.domain}`}
            className="grid grid-cols-[140px_minmax(0,1fr)] gap-3 border-t border-border px-3.5 py-2 text-[12.5px] first:border-t-0 max-sm:grid-cols-1 max-sm:gap-0"
          >
            <span className="font-mono">{h.ip}</span>
            <span className="min-w-0 break-all text-text-2">
              {h.domain}
              {h.note && h.note !== h.domain && <span className="text-text-3"> · {h.note}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const TEXT: Record<Tool, { title: string; description: string }> = {
  rkn: {
    title: 'Реестр РКН',
    description: 'Есть ли адрес ноды или её подсеть в реестре блокировок. Бесплатно, баланс не тратится.',
  },
  noisy: {
    title: 'Шумные соседи',
    description: 'Кто ещё живёт в подсети /24 ноды: адреса с плохой репутацией и похожие на VPN. Бесплатно.',
  },
  probe: {
    title: 'Зонд подсети /24',
    description: 'Заблокирована вся подсеть или только адрес ноды — поможет ли новый IP в той же подсети.',
  },
};

/** Окно инструмента: выбор ноды, запуск, ход и итог по-русски. */
function ToolDialog({
  tool,
  nodes,
  probePrice,
  quota,
  onClose,
}: {
  tool: Tool;
  nodes: RemnawaveNode[];
  probePrice: ProbePrice;
  quota: { left: number | null; limit: number | null; unlimited: boolean } | undefined;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [node, setNode] = useState<string | null>(null);
  const [scan, setScan] = useState<string | null>(null);
  const [rknFor, setRknFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [requestId] = useState(() => randomId());
  const rkn = useQuery({
    queryKey: ['dpi-rkn', rknFor],
    queryFn: ({ signal }) => api.get(`/integrations/dpi/tools/rkn/${rknFor}`, dpiRknSchema, signal),
    enabled: tool === 'rkn' && Boolean(rknFor),
    retry: false,
  });
  // Соседи и зонд идут минуту-другую: результат опрашиваем, пока не «done».
  const noisy = useQuery({
    queryKey: ['dpi-noisy', scan],
    queryFn: ({ signal }) => api.get(`/integrations/dpi/tools/noisy/${scan}`, dpiNoisySchema, signal),
    enabled: tool === 'noisy' && Boolean(scan),
    refetchInterval: (q) => (q.state.data?.status === 'done' ? false : 3000),
    retry: false,
  });
  const probe = useQuery({
    queryKey: ['dpi-probe', scan],
    queryFn: ({ signal }) => api.get(`/integrations/dpi/tools/probe/${scan}`, dpiProbeSchema, signal),
    enabled: tool === 'probe' && Boolean(scan),
    refetchInterval: (q) => (q.state.data?.status === 'done' || q.state.data?.error ? false : 5000),
    retry: false,
  });
  async function run() {
    if (!node) return;
    setError('');
    if (tool === 'rkn') {
      setRknFor(node);
      return;
    }
    setBusy(true);
    try {
      const started = await api.post(
        `/integrations/dpi/tools/${tool}`,
        tool === 'probe' ? { nodeUuid: node, requestId } : { nodeUuid: node },
        dpiScanStartSchema,
      );
      setScan(started.id);
      if (tool === 'noisy') void client.invalidateQueries({ queryKey: ['dpi-noisy-quota'] });
      if (tool === 'probe') void client.invalidateQueries({ queryKey: ['dpi-workspace'] });
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const running =
    busy ||
    rkn.isFetching ||
    (tool === 'noisy' && Boolean(scan) && noisy.data?.status !== 'done') ||
    (tool === 'probe' && Boolean(scan) && probe.data?.status !== 'done' && !probe.data?.error);
  const started = Boolean(scan) || Boolean(rknFor);
  const queryError = tool === 'rkn' ? rkn.error : tool === 'noisy' ? noisy.error : probe.error;
  const shownError = error || (queryError ? apiErrorMessage(queryError) : '');
  const n = noisy.data;
  const p = probe.data;
  const r = rkn.data;
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[calc(100dvh-48px)] flex-col gap-0 overflow-hidden rounded-2xl border-border-2 bg-surface p-0 sm:max-w-[680px]"
      >
        <div className="flex flex-none items-center gap-3 border-b border-border px-6 py-4 max-sm:px-4">
          <div className="min-w-0 flex-1">
            <DialogTitle className="font-heading text-[17px]">{TEXT[tool].title}</DialogTitle>
            <DialogDescription className="mt-0.5 text-[12.5px] text-text-3">
              {TEXT[tool].description}
            </DialogDescription>
          </div>
          <DialogClose
            aria-label="Закрыть окно"
            className="grid size-9 flex-none cursor-pointer place-items-center rounded-[10px] border border-border bg-surface-2 text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground"
          >
            <XIcon className="size-4" aria-hidden="true" />
          </DialogClose>
        </div>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 py-5 max-sm:px-4">
          <div>
            <p className="mb-1.5 text-[12.5px] font-medium text-text-2">Нода</p>
            <Combobox
              ariaLabel="Нода"
              value={node}
              onChange={(v) => {
                setNode(v);
                setScan(null);
                setRknFor(null);
              }}
              options={nodes.map((x) => nodeOption({ id: x.uuid, name: x.name, host: x.address }))}
              placeholder="Выберите ноду"
              searchPlaceholder="Найти ноду…"
              disabled={running}
              className="h-10 w-full"
            />
          </div>
          {running && started && (
            <p role="status" className="flex items-center gap-2 text-[12.5px] text-text-2">
              <Loader2Icon className="size-4 animate-spin text-brand" aria-hidden="true" />
              {tool === 'rkn'
                ? 'Проверяю реестр…'
                : tool === 'noisy'
                  ? 'Ищу соседей — обычно до минуты, окно обновится само.'
                  : 'Зонд идёт — обычно пару минут, окно обновится само.'}
            </p>
          )}
          {tool === 'rkn' && r && (
            <Verdict
              tone={r.blocked ? 'crit' : 'ok'}
              title={r.blocked ? `Адрес ${r.address} в реестре РКН` : `Адреса ${r.address} нет в реестре РКН`}
            >
              {r.blocked
                ? r.subnet
                  ? `В реестре блокировок вся подсеть ${r.subnet} — новый адрес из неё тоже будет закрыт.`
                  : 'Адрес в реестре блокировок.'
                : 'Если нода всё равно не открывается, дело не в реестре, а в фильтрации по протоколу — это и проверяет DPI Checker.'}
              {r.network && <span className="mt-1 block text-text-3">Сеть: {r.network}</span>}
              {r.refreshedAt && (
                <span className="block text-text-3">
                  Реестр обновлён {whenFmt.format(new Date(r.refreshedAt))}
                </span>
              )}
            </Verdict>
          )}
          {tool === 'noisy' && n?.status === 'done' && (
            <>
              <Verdict
                tone={n.bad.length || n.foreign.length ? 'warn' : 'ok'}
                title={
                  n.bad.length || n.foreign.length
                    ? `В подсети ${n.cidr ?? ''} есть адреса с плохой репутацией`
                    : `Плохих соседей в подсети ${n.cidr ?? ''} не нашлось`
                }
              >
                Найдено {n.count} {plural(n.count, 'адрес', 'адреса', 'адресов')} с сайтами.{' '}
                {n.bad.length
                  ? 'Соседи с плохой репутацией в РФ тянут подсеть в блокировки — следите за ней.'
                  : 'Соседи не выглядят опасными для вашей ноды.'}
              </Verdict>
              <Hosts title="Плохая репутация в РФ" items={n.bad} />
              <Hosts title="Плохая репутация за рубежом" items={n.foreign} />
              <Hosts title="Похожи на VPN" items={n.vpn} />
            </>
          )}
          {tool === 'probe' && p && (p.status === 'done' || p.error) && (
            <>
              {p.error ? (
                <Verdict tone="crit" title="Зонд не завершился">
                  {p.error}
                </Verdict>
              ) : !p.tested ? (
                <Verdict tone="muted" title="Проверить не на чем">
                  В подсети не нашлось соседних адресов с сайтами — вывод сделать нельзя.
                </Verdict>
              ) : p.blocked === p.tested ? (
                <Verdict
                  tone="crit"
                  title={`Закрыты все проверенные адреса подсети: ${p.tested} из ${p.tested}`}
                >
                  Блокируют подсеть {p.cidr ?? ''} целиком — нужен адрес из другой подсети.
                </Verdict>
              ) : p.blocked ? (
                <Verdict tone="warn" title={`Закрыта часть адресов подсети: ${p.blocked} из ${p.tested}`}>
                  Новый адрес в этой подсети — как повезёт: часть соседей открывается, часть нет.
                </Verdict>
              ) : (
                <Verdict tone="ok" title={`Соседние адреса открываются: ${p.tested} из ${p.tested}`}>
                  Если адрес ноды закрыт, блокируют его отдельно — новый IP в той же подсети может помочь.
                </Verdict>
              )}
              {p.ips.length > 0 && (
                <ul
                  className="flex flex-col rounded-[12px] border border-border"
                  aria-label="Проверенные адреса"
                >
                  {p.ips.map((x) => (
                    <li
                      key={x.ip}
                      className="grid grid-cols-[140px_minmax(0,1fr)_auto] gap-3 border-t border-border px-3.5 py-2 text-[12.5px] first:border-t-0"
                    >
                      <span className="font-mono">{x.ip}</span>
                      <span className="min-w-0 truncate text-text-2">{x.domain}</span>
                      <span className={cn('tabular-nums', x.closed ? 'text-crit' : 'text-ok')}>
                        открыт у {x.open} из {x.total}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[12px] text-text-3">Списано {money(p.cost)}.</p>
            </>
          )}
          {shownError && (
            <p
              role="alert"
              className="rounded-[10px] border border-crit/30 bg-crit-soft px-3 py-2 text-[12.5px] text-crit"
            >
              {shownError}
            </p>
          )}
        </div>
        <div className="flex flex-none items-center gap-3 border-t border-border bg-bg-2 px-6 py-3.5 max-sm:flex-col max-sm:items-stretch max-sm:px-4">
          <p className="min-w-0 flex-1 text-[12px] leading-snug text-text-3">
            {tool === 'rkn'
              ? 'Реестр DPI Checker обновляет сам, обычно раз в несколько часов.'
              : tool === 'noisy'
                ? quota?.unlimited
                  ? 'Без ограничения по числу запусков.'
                  : `Осталось сегодня: ${quota?.left ?? '—'} из ${quota?.limit ?? 10}.`
                : probePrice
                  ? `Спишется ${money(probePrice.fixed)} сразу и ${money(probePrice.perGb)} за ГБ трафика по итогу — обычно около 0,03 $. Отменить зонд нельзя.`
                  : 'Платно: фиксированная часть сразу и трафик по итогу. Отменить зонд нельзя.'}
          </p>
          <div className="flex gap-2 max-sm:flex-col">
            <DialogSecondaryButton
              disabled={busy}
              onClick={onClose}
              className="h-10 w-[128px] flex-none rounded-[10px] max-sm:w-full sm:flex-none sm:max-w-none"
            >
              Закрыть
            </DialogSecondaryButton>
            <DialogPrimaryButton
              disabled={!node || running || (tool === 'noisy' && quota?.left === 0 && !quota.unlimited)}
              onClick={() => void run()}
              className="h-10 min-w-[128px] flex-none rounded-[10px] px-4 whitespace-nowrap max-sm:w-full sm:w-auto sm:flex-none sm:max-w-none"
            >
              {busy && <Loader2Icon className="animate-spin" aria-hidden="true" />}
              {tool === 'rkn'
                ? 'Проверить адрес'
                : tool === 'noisy'
                  ? 'Найти соседей'
                  : `Запустить за ${probePrice ? money(probePrice.fixed) : '1 $'}`}
            </DialogPrimaryButton>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Бесплатные и дешёвые инструменты DPI Checker: реестр РКН, шумные соседи, зонд подсети. */
export function DpiTools({ nodes, probePrice }: { nodes: RemnawaveNode[]; probePrice: ProbePrice }) {
  const [open, setOpen] = useState<Tool | null>(null);
  const quota = useQuery({
    queryKey: ['dpi-noisy-quota'],
    queryFn: ({ signal }) => api.get('/integrations/dpi/tools/noisy/quota', dpiQuotaSchema, signal),
    staleTime: 60_000,
    retry: false,
  });
  const cards: Array<{ key: Tool; badge: ReactNode; icon: typeof SearchIcon; action: string }> = [
    { key: 'rkn', badge: <Pill tone="ok">Бесплатно</Pill>, icon: SearchIcon, action: 'Проверить адрес' },
    {
      key: 'noisy',
      badge: (
        <Pill tone="ok">
          {quota.data?.unlimited
            ? 'Бесплатно'
            : `Бесплатно · ${quota.data?.limit ?? 10} в сутки${quota.data?.left != null ? `, осталось ${quota.data.left}` : ''}`}
        </Pill>
      ),
      icon: UsersIcon,
      action: 'Найти соседей',
    },
    {
      key: 'probe',
      badge: (
        <Pill tone="warn">
          {probePrice ? `${money(probePrice.fixed)} + ${money(probePrice.perGb)} за ГБ` : 'Платно'}
        </Pill>
      ),
      icon: ScanLineIcon,
      action: 'Запустить зонд',
    },
  ];
  return (
    <section aria-label="Инструменты DPI Checker" className="grid grid-cols-3 gap-3 max-lg:grid-cols-1">
      {cards.map(({ key, badge, icon: Icon, action }) => (
        <div
          key={key}
          className="flex flex-col gap-1.5 rounded-2xl border border-border bg-surface px-4 py-3.5"
        >
          <span className="self-start">{badge}</span>
          <b className="mt-0.5 text-[13.5px] font-semibold">{TEXT[key].title}</b>
          <small className="flex-1 text-[12.5px] leading-normal text-text-3">{TEXT[key].description}</small>
          <Button
            variant="outline"
            className="mt-1.5 h-9 self-start rounded-[10px] px-3.5 text-[12.5px]"
            onClick={() => setOpen(key)}
          >
            <Icon className="size-3.5" aria-hidden="true" />
            {action}
          </Button>
        </div>
      ))}
      {open && (
        <ToolDialog
          tool={open}
          nodes={nodes}
          probePrice={probePrice}
          quota={quota.data}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
}
