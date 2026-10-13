import {
  type BsHistoryEntry,
  type BsRun,
  bsHistorySchema,
  bsPreviewSchema,
  bsRunSchema,
  bsWorkspaceSchema,
} from '@nodeservice/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  CheckIcon,
  ChevronRightIcon,
  CoinsIcon,
  Loader2Icon,
  PlayIcon,
  PlugIcon,
  RefreshCwIcon,
  XIcon,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { DialogPrimaryButton, DialogSecondaryButton } from '@/components/dialog-actions';
import { PageActions } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboOption } from '@/components/ui/combobox';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { nodeOption } from '@/features/nodes/node-option';
import { useNodes } from '@/features/nodes/nodes-api';
import { Pill, Segmented } from '@/features/settings/settings-ui';
import { api, apiErrorMessage } from '@/lib/api';
import { plural } from '@/lib/plural';
import { explainProbeError } from '@/lib/probe-error';
import { cn } from '@/lib/utils';
import { BsRentals } from './bs-rentals';

type Unit = ReturnType<typeof bsWorkspaceSchema.parse>['units'][number];
type Mode = 'on' | 'off' | 'any';
const points = (n: number) => `${n} ${plural(n, 'точка', 'точки', 'точек')}`;
const credits = (n: number) => `${new Intl.NumberFormat('ru-RU').format(n)} Cred`;
const whenFmt = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const when = (iso: string) => whenFmt.format(new Date(iso));
/** Федеральные округа по порядку; Крым и Калининград — самостоятельные. */
const REGIONS: Array<[string, string]> = [
  ['cfo', 'ЦФО'],
  ['szfo', 'СЗФО'],
  ['yufo', 'ЮФО'],
  ['skfo', 'СКФО'],
  ['pfo', 'ПФО'],
  ['urfo', 'УФО'],
  ['sfo', 'СФО'],
  ['dfo', 'ДФО'],
  ['krym', 'Крым'],
  ['kgd', 'Калинингр.'],
];
const BY_NAME: Record<string, string> = {
  ЦФО: 'cfo',
  СЗФО: 'szfo',
  ЮФО: 'yufo',
  СКФО: 'skfo',
  ПФО: 'pfo',
  УФО: 'urfo',
  СФО: 'sfo',
  ДФО: 'dfo',
  КРЫМ: 'krym',
  KGD: 'kgd',
};
const codeOf = (u: Unit) => u.region_code || BY_NAME[u.region.toUpperCase()] || u.region;
const fits = (u: Unit, mode: Mode) => u.probeable && (mode === 'any' || u.dpi === mode);
/** «МТС, Билайн, МегаФон и ещё 2». */
const someNames = (names: string[]) =>
  names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} и ещё ${names.length - 3}`;

/** Доступность строки по контракту BS Checker: ответил TCP или ICMP; ни одна проба не дала ответа — нет данных. */
const reach = (r: BsRun['rows'][number]) =>
  r.tcp === true || r.icmp === true ? true : r.tcp === false || r.icmp === false ? false : null;
function summary(run: BsRun) {
  const known = run.rows.filter((r) => reach(r) !== null);
  const ok = known.filter((r) => reach(r)).length;
  return { known: known.length, ok };
}
function runPill(run: BsRun): { tone: 'ok' | 'warn' | 'crit' | 'muted' | 'info'; label: string } {
  if (run.status === 'running') return { tone: 'info', label: 'Идёт' };
  if (run.status === 'uncertain') return { tone: 'warn', label: 'Результат уточняется' };
  if (run.status === 'failed') return { tone: 'crit', label: 'Не выполнена' };
  if (run.status === 'ready') return { tone: 'muted', label: 'Не запускалась' };
  const { known, ok } = summary(run);
  if (!known) return { tone: 'muted', label: 'Нет данных' };
  return { tone: ok === known ? 'ok' : ok ? 'warn' : 'crit', label: `Доступна · ${ok} из ${known}` };
}
/** «a.b.c.d:443», «[::1]:443», «example.com:8443» → адрес и порт. */
function splitTarget(target: string) {
  const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(target);
  return m ? { host: m[1] ?? '', port: m[2] ?? '443' } : { host: target, port: '443' };
}

const dialogBox =
  'flex max-h-[calc(100dvh-48px)] flex-col gap-0 overflow-hidden rounded-2xl border-border-2 bg-surface p-0';
const dialogFoot =
  'flex flex-none items-center gap-3 border-t border-border bg-bg-2 px-6 py-3.5 max-sm:flex-col max-sm:items-stretch max-sm:px-4';
const footButton = 'h-10 w-[128px] flex-none rounded-[10px] max-sm:w-full sm:flex-none sm:max-w-none';
const label = 'mb-1.5 block text-[12.5px] font-medium text-text-2';
function DialogHead({ title, description }: { title: ReactNode; description: ReactNode }) {
  return (
    <div className="flex flex-none items-center gap-3 border-b border-border px-6 py-4 max-sm:px-4">
      <div className="min-w-0 flex-1">
        <DialogTitle className="font-heading text-[17px] break-all">{title}</DialogTitle>
        <DialogDescription className="mt-0.5 text-[12.5px] text-text-3">{description}</DialogDescription>
      </div>
      <DialogClose
        aria-label="Закрыть окно"
        className="grid size-9 flex-none cursor-pointer place-items-center rounded-[10px] border border-border bg-surface-2 text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground"
      >
        <XIcon className="size-4" aria-hidden="true" />
      </DialogClose>
    </div>
  );
}

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

/** Точки проверки таблицей «оператор × округ»: клетка — точка с белым списком («БС») или без него («·»). */
function UnitsDialog({
  units,
  selected,
  onDone,
  onClose,
  price,
}: {
  units: Unit[];
  selected: string[];
  onDone: (keys: string[]) => void;
  onClose: () => void;
  price: (keys: string[]) => ReactNode;
}) {
  const [mode, setMode] = useState<Mode>(() =>
    selected.length && selected.every((k) => units.find((u) => u.op_key === k)?.dpi === 'off') ? 'off' : 'on',
  );
  const [picked, setPicked] = useState<string[]>(selected);
  const operators = useMemo(() => {
    const seen = new Map<string, string>();
    for (const u of units) if (!seen.has(u.operator)) seen.set(u.operator, u.name);
    return [...seen.entries()];
  }, [units]);
  const cell = (op: string, rc: string) =>
    units.filter((u) => u.operator === op && codeOf(u) === rc && fits(u, mode));
  // Операторы без единой точки в выбранном режиме только загромождают таблицу.
  const shown = operators.filter(([op]) => units.some((u) => u.operator === op && fits(u, mode)));
  const toggle = (list: Unit[]) => {
    const keys = list.map((u) => u.op_key);
    const all = keys.every((k) => picked.includes(k));
    setPicked(all ? picked.filter((k) => !keys.includes(k)) : [...new Set([...picked, ...keys])]);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent showCloseButton={false} className={cn(dialogBox, 'sm:max-w-[980px]')}>
        <DialogHead
          title="Точки проверки"
          description="Точка — оператор в федеральном округе. Нажимайте клетки, строки и столбцы — цена пересчитывается сразу."
        />
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-6 py-5 max-sm:px-4">
          <div className="flex flex-wrap items-center gap-2">
            <Segmented<Mode>
              label="Какие точки"
              value={mode}
              onChange={setMode}
              items={[
                { key: 'on', label: 'С белым списком' },
                { key: 'off', label: 'Без белого списка' },
                { key: 'any', label: 'Любые' },
              ]}
            />
            <span className="flex-1" />
            <Button
              variant="outline"
              className="h-9 rounded-[10px] px-3.5 text-[12.5px]"
              onClick={() =>
                setPicked([
                  ...new Set([...picked, ...units.filter((u) => fits(u, mode)).map((u) => u.op_key)]),
                ])
              }
            >
              Выбрать все {mode === 'on' ? 'с белым списком' : mode === 'off' ? 'без белого списка' : ''}
            </Button>
            <Button
              variant="outline"
              className="h-9 rounded-[10px] px-3.5 text-[12.5px]"
              onClick={() => setPicked([])}
            >
              Очистить
            </Button>
          </div>
          <div className="overflow-x-auto">
            <table
              className="w-full min-w-[720px] table-fixed border-separate border-spacing-1 text-[11.5px]"
              aria-label="Оператор × округ"
            >
              <colgroup>
                <col className="w-[140px]" />
              </colgroup>
              <thead>
                <tr>
                  <th />
                  {REGIONS.map(([rc, name]) => (
                    <th key={rc} className="font-semibold text-text-3">
                      <button
                        type="button"
                        className="cursor-pointer rounded px-1 hover:text-foreground"
                        onClick={() => toggle(shown.flatMap(([op]) => cell(op, rc)))}
                      >
                        {name}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map(([op, name]) => (
                  <tr key={op}>
                    <th scope="row" className="pr-2 text-left text-[12px] font-semibold whitespace-nowrap">
                      <button
                        type="button"
                        className="cursor-pointer hover:text-brand"
                        onClick={() => toggle(REGIONS.flatMap(([rc]) => cell(op, rc)))}
                      >
                        {name}
                      </button>
                    </th>
                    {REGIONS.map(([rc, region]) => {
                      const list = cell(op, rc);
                      const on = list.length > 0 && list.every((u) => picked.includes(u.op_key));
                      const bs = list.some((u) => u.dpi === 'on'),
                        free = list.some((u) => u.dpi === 'off');
                      return (
                        <td key={rc}>
                          {list.length ? (
                            <button
                              type="button"
                              aria-pressed={on}
                              aria-label={`${name} · ${region}`}
                              title={`${name} · ${region} · ${bs && free ? 'с белым списком и без' : bs ? 'белый список включён' : 'без белого списка'}`}
                              onClick={() => toggle(list)}
                              className={cn(
                                'grid h-[30px] w-full cursor-pointer place-items-center rounded-[7px] border font-semibold transition-colors',
                                on
                                  ? 'border-transparent bg-brand text-cta-foreground'
                                  : bs
                                    ? 'border-teal/45 bg-surface-2 text-text-2 hover:border-teal'
                                    : 'border-border bg-surface-2 text-text-3 hover:border-border-2',
                              )}
                            >
                              {bs && free ? 'БС·' : bs ? 'БС' : '·'}
                            </button>
                          ) : (
                            <span
                              className="grid h-[30px] place-items-center text-text-3/50"
                              title="Сейчас недоступна"
                            >
                              —
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-text-3">
            <span>«БС» — белый список включён</span>
            <span>«·» — без белого списка</span>
            <span>«—» — точка сейчас недоступна</span>
          </p>
        </div>
        <div className={dialogFoot}>
          <p className="min-w-0 flex-1 text-[12.5px] leading-snug text-text-2">{price(picked)}</p>
          <div className="flex gap-2 max-sm:flex-col">
            <DialogSecondaryButton onClick={onClose} className={footButton}>
              Отмена
            </DialogSecondaryButton>
            <DialogPrimaryButton onClick={() => onDone(picked)} className={footButton}>
              Готово
            </DialogPrimaryButton>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Результат проверки: вывод про белый список сверху, ниже точки с TCP и ICMP. */
function ResultDialog({
  entry,
  units,
  busy,
  onClose,
  onRepeat,
  onFetch,
}: {
  entry: BsHistoryEntry;
  units: Unit[];
  busy: boolean;
  onClose: () => void;
  onRepeat: () => void;
  onFetch: () => void;
}) {
  const run = entry.run;
  const bsRows = run.rows.filter((r) => r.dpi === 'on'),
    freeRows = run.rows.filter((r) => r.dpi !== 'on');
  const known = (rows: BsRun['rows']) => rows.filter((r) => reach(r) !== null);
  const okCount = (rows: BsRun['rows']) => known(rows).filter((r) => reach(r)).length;
  const failedBs = [
    ...new Set(
      known(bsRows)
        .filter((r) => !reach(r))
        .map((r) => r.operator),
    ),
  ];
  const unknown = run.rows.filter((r) => reach(r) === null).length;
  const nameOf = (r: BsRun['rows'][number]) => units.find((u) => u.op_key === r.unit)?.name ?? r.operator;
  const bsKnown = known(bsRows).length,
    bsOk = okCount(bsRows);
  const tone =
    run.status !== 'done'
      ? 'muted'
      : bsKnown
        ? bsOk === bsKnown
          ? 'ok'
          : bsOk
            ? 'warn'
            : 'crit'
        : known(run.rows).length && okCount(run.rows) === known(run.rows).length
          ? 'ok'
          : okCount(run.rows)
            ? 'warn'
            : 'crit';
  const meta = [
    when(entry.createdAt),
    points(entry.units),
    run.costCredits !== null ? `списано ${credits(run.costCredits)}` : null,
    run.refundedCredits ? `возврат ${credits(run.refundedCredits)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent showCloseButton={false} className={cn(dialogBox, 'sm:max-w-[880px]')}>
        <DialogHead
          title={
            <>
              <span className="font-mono">{entry.target}</span>
              {entry.nodeName && <span className="text-text-3"> · {entry.nodeName}</span>}
            </>
          }
          description={meta}
        />
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 py-5 max-sm:px-4">
          {run.status === 'running' && (
            <p role="status" className="flex items-center gap-2 text-[13px] text-text-2">
              <Loader2Icon className="size-4 animate-spin text-brand" aria-hidden="true" />
              Проверка идёт — обычно несколько секунд, бывает до пары минут.
            </p>
          )}
          {run.error && (
            <p
              role="alert"
              className="rounded-[12px] border border-warn/35 bg-warn-soft/60 px-4 py-3 text-[13px] text-warn"
            >
              {run.error}
            </p>
          )}
          {run.status === 'done' && run.rows.length > 0 && (
            <div
              className={cn(
                'rounded-[12px] border px-4 py-3',
                tone === 'ok'
                  ? 'border-ok/35 bg-ok-soft/50'
                  : tone === 'crit'
                    ? 'border-crit/35 bg-crit-soft/50'
                    : 'border-warn/35 bg-warn-soft/50',
              )}
            >
              <b className="text-[14px] font-semibold">
                {bsKnown
                  ? `Белый список пропускает ноду в ${bsOk} из ${bsKnown} ${plural(bsKnown, 'точки', 'точек', 'точек')}`
                  : `Открывается в ${okCount(run.rows)} из ${known(run.rows).length} ${plural(known(run.rows).length, 'точки', 'точек', 'точек')}`}
              </b>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-text-2">
                {bsKnown
                  ? failedBs.length
                    ? `У ${someNames(failedBs)} с включённым белым списком адрес не открывается — для мобильных клиентов этих операторов нода сейчас недоступна.`
                    : 'Нода проходит белые списки всех проверенных операторов.'
                  : 'Проверяли точки без белого списка — это доступность в обычной мобильной сети.'}
                {bsKnown > 0 &&
                  freeRows.length > 0 &&
                  ` Без белого списка: ${okCount(freeRows)} из ${known(freeRows).length}.`}
                {unknown > 0 && ` По ${points(unknown)} нет данных — это не недоступность.`}
              </p>
            </div>
          )}
          {!!run.skippedCount && (
            <p className="text-[12.5px] text-warn">
              {points(run.skippedCount)} сервис пропустил — они стали недоступны перед запуском; за них не
              списано.
            </p>
          )}
          {run.rows.length > 0 && (
            <div className="overflow-x-auto rounded-[12px] border border-border">
              <table className="w-full min-w-[640px] text-left text-[12.5px]">
                <thead className="bg-surface-2 text-[11px] tracking-[0.08em] text-text-3 uppercase">
                  <tr>
                    {['Оператор', 'Округ', 'Белый список', 'TCP', 'ICMP'].map((h) => (
                      <th key={h} className="px-3 py-2 font-semibold">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {run.rows.map((r) => (
                    <tr key={r.unit} className="border-t border-border align-top">
                      <td className="px-3 py-2">
                        {nameOf(r)}
                        {(r.error || r.dnsFail) && (
                          <small className="mt-0.5 block text-[11.5px] text-text-3">
                            {r.dnsFail
                              ? 'Точка не смогла разрешить домен — замеров нет.'
                              : explainProbeError(r.error)}
                          </small>
                        )}
                      </td>
                      <td className="px-3 py-2">{r.region}</td>
                      <td className="px-3 py-2">
                        {r.dpi === 'on' ? (
                          <Pill tone="teal">БС</Pill>
                        ) : (
                          <span className="text-text-3">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {r.tcp === null ? (
                          <span className="text-text-3">—</span>
                        ) : r.tcp ? (
                          <Pill tone="ok">
                            {r.tcpIsTls ? 'TLS открыт' : 'открыт'}
                            {r.latency !== null ? ` · ${r.latency} мс` : ''}
                          </Pill>
                        ) : (
                          <Pill tone="crit">нет ответа</Pill>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {r.icmp === null ? (
                          <span className="text-text-3">—</span>
                        ) : r.icmp ? (
                          <Pill tone="ok">отвечает</Pill>
                        ) : (
                          <Pill tone="crit">нет ответа</Pill>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {run.status === 'done' && !run.rows.length && (
            <p className="text-[13px] text-warn">
              Сервис не вернул результаты точек — доступность не подтверждена.
            </p>
          )}
        </div>
        <div className={dialogFoot}>
          <p className="min-w-0 flex-1 text-[12px] leading-snug text-text-3">
            «TLS открыт» — у этих точек TCP проверяется с рукопожатием TLS: ТСПУ рвёт связь после него.
          </p>
          <div className="flex gap-2 max-sm:flex-col">
            <DialogSecondaryButton disabled={busy} onClick={onClose} className={footButton}>
              Закрыть
            </DialogSecondaryButton>
            {['running', 'uncertain'].includes(run.status) ? (
              <DialogPrimaryButton
                disabled={busy}
                onClick={onFetch}
                className="h-10 min-w-[128px] flex-none rounded-[10px] px-4 whitespace-nowrap max-sm:w-full sm:w-auto sm:flex-none sm:max-w-none"
              >
                {busy && <Loader2Icon className="animate-spin" aria-hidden="true" />}
                Получить результат той же проверки
              </DialogPrimaryButton>
            ) : (
              <DialogPrimaryButton onClick={onRepeat} className={cn(footButton, 'w-auto px-4')}>
                <PlayIcon aria-hidden="true" />
                Проверить снова
              </DialogPrimaryButton>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const readUnits = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem('ns-bs-units') ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};
/**
 * «BS Checker» (витрина redesign-2026-10, BS, вариант A): баланс сверху, слева проверка с ценой на кнопке и
 * история, справа арендованные точки входа — WebSocket и TCP/UDP. Точки проверки — таблицей «оператор × округ».
 */
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
  const allNodes = nodes.data?.nodes ?? [];
  const [nodeUuid, setNodeUuid] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [ip, setIp] = useState(''),
    [port, setPort] = useState('443'),
    [tcp, setTcp] = useState(true),
    [icmp, setIcmp] = useState(true),
    [sni, setSni] = useState(false),
    [sniHost, setSniHost] = useState(''),
    [units, setUnits] = useState<string[]>(readUnits),
    [unitsOpen, setUnitsOpen] = useState(false),
    [selected, setSelected] = useState<BsHistoryEntry | null>(null),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem('ns-bs-units', JSON.stringify(units));
    } catch {}
  }, [units]);
  // Пришли из совета Ассистента: подставляем ноду и её адрес, как при выборе из списка.
  useEffect(() => {
    if (!initialNode) return;
    const n = allNodes.find((x) => x.uuid === initialNode);
    if (!n) return;
    setNodeUuid(n.uuid);
    setIp(n.address);
    onInitialNodeUsed?.();
  }, [initialNode, allNodes, onInitialNodeUsed]);
  const catalog = q.data?.units ?? [];
  // Выбор держим только из доступных сейчас точек: устаревшие ключи (API 1.1) отбрасываются.
  const live = units.filter((k) => catalog.some((u) => u.op_key === k && u.probeable));
  const ready =
    Boolean(ip.trim()) &&
    /^\d+$/.test(port) &&
    (tcp || icmp || (sni && sniHost.trim().length >= 3)) &&
    live.length > 0;
  const body = {
    ip: ip.trim(),
    port: Number(port),
    operators: live,
    tcp,
    icmp,
    ...(sni && sniHost.trim() ? { sniHost: sniHost.trim() } : {}),
    ...(nodeUuid ? { nodeUuid } : {}),
  };
  // Цена — сама, после короткой паузы: расчёт у BS Checker бесплатный.
  const [debounced, setDebounced] = useState(body);
  const bodyKey = JSON.stringify(body);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(JSON.parse(bodyKey)), 500);
    return () => clearTimeout(t);
  }, [bodyKey]);
  const preview = useQuery({
    queryKey: ['bschecker-preview', JSON.stringify(debounced)],
    queryFn: () => api.post('/integrations/bschecker/preview', debounced, bsPreviewSchema),
    enabled: ready && JSON.stringify(debounced) === bodyKey,
    staleTime: 4 * 60_000,
    retry: false,
  });
  const execute = useMutation({
    mutationFn: (id: string) => api.post(`/integrations/bschecker/runs/${id}/execute`, {}, bsRunSchema),
    onSuccess: (data) => {
      setSelected((prev) => (prev ? { ...prev, run: data } : null));
      void q.refetch();
      void history.refetch();
    },
  });
  const locked =
    execute.isPending ||
    Boolean(history.data?.runs.some((r) => r.run.status === 'uncertain' || r.run.status === 'running'));
  async function start(id: string, entry?: BsHistoryEntry) {
    const node = allNodes.find((n) => n.uuid === nodeUuid);
    const context: BsHistoryEntry = entry ?? {
      target: `${ip.includes(':') ? `[${ip}]` : ip}:${port}`,
      createdAt: new Date().toISOString(),
      units: live.length,
      estimatedCredits: preview.data?.costCredits ?? 0,
      nodeName: node?.name ?? null,
      operators: live,
      run: { id, status: 'ready', costCredits: null, refundedCredits: null, error: null, rows: [] },
    };
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
  function repeat(entry: BsHistoryEntry) {
    const t = splitTarget(entry.target);
    const node = allNodes.find((n) => n.address === t.host);
    setNodeUuid(node?.uuid ?? null);
    setManual(!node);
    setIp(t.host);
    setPort(t.port);
    if (entry.operators.length) setUnits(entry.operators);
    setSelected(null);
  }
  const pickedUnits = catalog.filter((u) => live.includes(u.op_key));
  const opNames = [...new Set(pickedUnits.map((u) => u.name))];
  const dpiText = pickedUnits.every((u) => u.dpi === 'on')
    ? 'только с белым списком'
    : pickedUnits.every((u) => u.dpi === 'off')
      ? 'только без белого списка'
      : 'с белым списком и без';
  const p = preview.data;
  const total = q.data?.account.totalCredits ?? null;
  const priceLine = (keys: string[]): ReactNode =>
    !keys.length ? (
      'Выберите точки — цена появится здесь.'
    ) : p && keys.length === live.length && keys.every((k) => live.includes(k)) ? (
      <>
        {points(keys.length)} · <b className="font-semibold text-foreground">{credits(p.costCredits)}</b>
        {total !== null && ` · на балансе ${credits(total)}`}
      </>
    ) : (
      `${points(keys.length)} · цена пересчитается после «Готово»`
    );
  // Ноды белого списка — первой группой: для них BS Checker и нужен. Ручной ввод — закреплённым пунктом.
  const nodeOptions: ComboOption[] = [
    { value: '__manual', label: 'Ввести IP или домен вручную', pinned: true },
    ...[...allNodes]
      .sort((a, b) => Number(Boolean(b.whitelist)) - Number(Boolean(a.whitelist)))
      .map((n) => ({
        ...nodeOption({ id: n.uuid, name: n.name, host: n.address }),
        group: n.whitelist ? 'Сервер белого списка' : 'Остальные ноды',
      })),
  ];
  return (
    <div data-testid="bs-workspace" className="flex min-w-0 flex-col gap-3">
      <PageActions>
        <Button
          variant="outline"
          className="h-10 rounded-[10px] px-4 text-[13px] font-medium"
          onClick={settings}
        >
          <PlugIcon className="size-4" aria-hidden="true" />
          Подключение
        </Button>
      </PageActions>
      <section
        aria-label="Баланс BS Checker"
        className="flex flex-wrap items-center gap-x-7 gap-y-3 rounded-2xl border border-border bg-surface px-[18px] py-4"
      >
        {q.isPending ? (
          <div className="flex-1">
            <BsBalanceSkeleton />
          </div>
        ) : q.isError || !q.data ? (
          <p role="alert" className="flex-1 text-[13px] text-crit">
            {apiErrorMessage(q.error)}
          </p>
        ) : (
          <>
            <div>
              <p className="text-[11px] font-semibold tracking-[0.08em] text-text-3 uppercase">Доступно</p>
              <p className="font-mono text-[26px] leading-tight font-semibold whitespace-nowrap">
                {new Intl.NumberFormat('ru-RU').format(q.data.account.totalCredits)}{' '}
                <span className="text-[15px] text-text-3">Cred</span>
              </p>
            </div>
            <div className="text-[12.5px] leading-relaxed text-text-2">
              <p>Основной: {credits(q.data.account.balanceCredits)}</p>
              <p>Бонусы: {credits(q.data.account.bonusCredits)}</p>
            </div>
            <Pill tone="info">
              тариф {q.data.account.tier}
              {q.data.account.tierExpiresAt
                ? ` · до ${new Date(q.data.account.tierExpiresAt).toLocaleDateString('ru-RU')}`
                : ''}
            </Pill>
            <div className="text-[12.5px] leading-relaxed text-text-3">
              {p && p.costCredits > 0 && (
                <p>
                  ≈ {Math.floor(q.data.account.totalCredits / p.costCredits)}{' '}
                  {plural(
                    Math.floor(q.data.account.totalCredits / p.costCredits),
                    'проверка',
                    'проверки',
                    'проверок',
                  )}{' '}
                  по {points(live.length)}
                </p>
              )}
              <p>1 Cred = 1 копейка</p>
            </div>
            <span className="flex-1" />
            <Button
              variant="outline"
              className="h-10 rounded-[10px] px-4 text-[13px] font-medium"
              disabled={q.isFetching}
              onClick={() => void q.refetch()}
            >
              <RefreshCwIcon className={cn('size-4', q.isFetching && 'animate-spin')} aria-hidden="true" />
              Обновить баланс
            </Button>
          </>
        )}
      </section>
      <div className="grid items-stretch gap-3 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <section
            aria-label="Проверка IP или домена"
            className="overflow-hidden rounded-2xl border border-border bg-surface"
          >
            <header className="flex min-h-14 items-center gap-3 border-b border-border px-[18px] py-3">
              <h2 className="font-heading text-[14.5px] font-semibold">Проверка IP или домена</h2>
              <span className="text-[12px] text-text-3 max-sm:hidden">стоимость видна до запуска</span>
            </header>
            <fieldset disabled={locked} className="m-0 flex flex-col gap-3.5 border-0 px-[18px] py-4">
              <div>
                <p className={label}>Что проверяем</p>
                <Combobox
                  ariaLabel="Нода для проверки"
                  value={manual ? '__manual' : nodeUuid}
                  onChange={(v) => {
                    if (v === '__manual') {
                      setManual(true);
                      setNodeUuid(null);
                      setIp('');
                      return;
                    }
                    const n = allNodes.find((x) => x.uuid === v);
                    setManual(false);
                    setNodeUuid(n?.uuid ?? null);
                    setIp(n?.address ?? '');
                  }}
                  options={nodeOptions}
                  placeholder="Выберите ноду"
                  searchPlaceholder="Найти ноду…"
                  className="h-10 w-full"
                />
                <p className="mt-1.5 text-[12px] text-text-3">
                  Ноды с отметкой «Сервер белого списка» — первыми. Можно ввести адрес вручную.
                </p>
              </div>
              {manual && (
                <div>
                  <label htmlFor="bs-ip" className={label}>
                    IP или домен
                  </label>
                  <Input
                    id="bs-ip"
                    value={ip}
                    onChange={(e) => setIp(e.target.value)}
                    placeholder="8.8.8.8 или example.com"
                    className="h-10 rounded-[10px] bg-surface-2"
                  />
                </div>
              )}
              <div className="flex flex-wrap items-end gap-3">
                <div className="w-[110px]">
                  <label htmlFor="bs-port" className={label}>
                    Порт
                  </label>
                  <Input
                    id="bs-port"
                    inputMode="numeric"
                    value={port}
                    onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
                    className="h-10 rounded-[10px] bg-surface-2"
                  />
                </div>
                <div>
                  <p className={label}>Проверки</p>
                  <div className="flex gap-1.5">
                    {(
                      [
                        ['TCP', tcp, setTcp],
                        ['ICMP', icmp, setIcmp],
                        ['SNI', sni, setSni],
                      ] as const
                    ).map(([name, on, set]) => (
                      <button
                        key={name}
                        type="button"
                        aria-pressed={on}
                        onClick={() => set(!on)}
                        className={cn(
                          'inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-[10px] border px-3 text-[12.5px] transition-colors',
                          on
                            ? 'border-brand bg-brand-soft font-semibold text-brand'
                            : 'border-border text-text-2 hover:bg-surface-2',
                        )}
                      >
                        {on && <CheckIcon className="size-3.5" aria-hidden="true" />}
                        {name}
                      </button>
                    ))}
                  </div>
                </div>
                {sni && (
                  <div className="min-w-[180px] flex-1">
                    <label htmlFor="bs-sni" className={label}>
                      Имя для SNI
                    </label>
                    <Input
                      id="bs-sni"
                      value={sniHost}
                      onChange={(e) => setSniHost(e.target.value)}
                      placeholder="example.com"
                      className="h-10 rounded-[10px] bg-surface-2"
                    />
                  </div>
                )}
              </div>
              <div>
                <p className={label}>Точки · оператор × округ</p>
                <div className="flex items-center gap-3 rounded-[12px] border border-border bg-surface-2/60 px-3.5 py-2.5">
                  <span className="min-w-0 flex-1 text-[13px]">
                    {live.length ? (
                      <>
                        <b className="font-semibold">{points(live.length)}</b>
                        <span className="text-text-3">
                          {' '}
                          · {someNames(opNames)} · {dpiText}
                        </span>
                      </>
                    ) : (
                      <span className="text-text-3">Точки не выбраны</span>
                    )}
                  </span>
                  <Button
                    variant="outline"
                    className="h-9 rounded-[10px] px-3.5 text-[12.5px]"
                    disabled={!catalog.length}
                    onClick={() => setUnitsOpen(true)}
                  >
                    Выбрать
                  </Button>
                </div>
                {q.data?.unitsError && <p className="mt-1.5 text-[12px] text-warn">{q.data.unitsError}</p>}
              </div>
              <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3.5 max-sm:flex-col max-sm:items-stretch">
                <p className="flex min-w-0 flex-1 items-center gap-2 text-[12.5px] text-text-2">
                  <CoinsIcon className="size-4 flex-none text-text-3" aria-hidden="true" />
                  {!ready ? (
                    <span className="text-text-3">
                      {!ip.trim()
                        ? 'Выберите ноду или адрес'
                        : !live.length
                          ? 'Выберите точки'
                          : 'Включите хотя бы одну проверку'}{' '}
                      — цена появится здесь.
                    </span>
                  ) : preview.isError ? (
                    <span className="text-crit">{apiErrorMessage(preview.error)}</span>
                  ) : p ? (
                    <span>
                      <b className="font-semibold text-foreground">{credits(p.costCredits)}</b>
                      {p.discountPct && p.levelName && (
                        <span className="text-text-3">
                          {' '}
                          (скидка {p.levelName} −{p.discountPct} %)
                        </span>
                      )}
                      {total !== null && <span className="text-text-3"> · на балансе {credits(total)}</span>}
                      <span className="text-text-3"> · расчёт бесплатный</span>
                    </span>
                  ) : (
                    <span className="text-text-3">Считаю стоимость…</span>
                  )}
                </p>
                <button
                  type="button"
                  disabled={
                    !ready || !p || preview.isFetching || locked || (total !== null && p.costCredits > total)
                  }
                  onClick={() => p && void start(p.id)}
                  className="inline-flex h-10 cursor-pointer items-center justify-center gap-1.5 rounded-[10px] bg-cta px-4 text-[13px] font-semibold whitespace-nowrap text-cta-foreground transition-colors hover:bg-(--ns-cta-hover) disabled:cursor-default disabled:opacity-50"
                >
                  {execute.isPending && <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />}
                  {p ? `Запустить за ${credits(p.costCredits)}` : 'Запустить'}
                </button>
              </div>
              {locked && (
                <p className="text-[12px] text-warn">
                  Есть незавершённая проверка — откройте её в истории и получите результат.
                </p>
              )}
              {error && (
                <p role="alert" className="text-[12.5px] text-crit">
                  {error}
                </p>
              )}
            </fieldset>
          </section>
          <section
            aria-label="История проверок"
            className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-surface"
          >
            <header className="flex min-h-14 items-center gap-3 border-b border-border px-[18px] py-2.5">
              <h2 className="font-heading text-[14.5px] font-semibold">История проверок</h2>
              <Pill>{history.data?.runs.length ?? 0}</Pill>
              <span className="flex-1" />
              <Button
                variant="outline"
                aria-label="Обновить историю"
                className="size-9 rounded-[10px] p-0"
                disabled={history.isFetching}
                onClick={() => void history.refetch()}
              >
                <RefreshCwIcon
                  className={cn('size-4', history.isFetching && 'animate-spin')}
                  aria-hidden="true"
                />
              </Button>
            </header>
            {history.isPending ? (
              <div
                role="status"
                aria-label="Загрузка истории проверок"
                className="flex flex-col gap-2.5 px-[18px] py-3"
              >
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-12 w-full rounded-[10px]" />
                ))}
              </div>
            ) : history.isError ? (
              <p role="alert" className="px-[18px] py-4 text-[13px] text-crit">
                {apiErrorMessage(history.error)}
              </p>
            ) : history.data?.runs.length ? (
              <ol
                aria-label="Проверки BS Checker"
                className="min-h-0 flex-1 overflow-y-auto max-lg:max-h-[420px]"
              >
                {history.data.runs.map((entry) => {
                  const pill = runPill(entry.run);
                  return (
                    <li key={entry.run.id} className="border-t border-border first:border-t-0">
                      <button
                        type="button"
                        onClick={() => void openResult(entry)}
                        className="grid w-full cursor-pointer grid-cols-[22px_minmax(0,1fr)_auto_16px] items-center gap-3 px-[18px] py-3 text-left transition-colors hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand"
                      >
                        <img src="/integration-icons/bschecker.svg" alt="" className="size-[18px]" />
                        <span className="min-w-0">
                          <b className="block truncate text-[13px] font-semibold">
                            <span className="font-mono">{entry.target}</span>
                            {entry.nodeName && (
                              <span className="font-normal text-text-3"> · {entry.nodeName}</span>
                            )}
                          </b>
                          <small className="block text-[12px] text-text-3">
                            {when(entry.createdAt)} · {points(entry.units)} ·{' '}
                            {credits(entry.run.costCredits ?? entry.estimatedCredits)}
                          </small>
                        </span>
                        <Pill tone={pill.tone}>{pill.label}</Pill>
                        <ChevronRightIcon className="size-4 text-text-3" aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="px-[18px] py-6 text-center text-[13px] text-text-3">
                Проверок пока нет — здесь будут цели, время и результаты.
              </p>
            )}
          </section>
        </div>
        <BsRentals />
      </div>
      {unitsOpen && (
        <UnitsDialog
          units={catalog}
          selected={live}
          onClose={() => setUnitsOpen(false)}
          onDone={(keys) => {
            setUnits(keys);
            setUnitsOpen(false);
          }}
          price={priceLine}
        />
      )}
      {selected && (
        <ResultDialog
          entry={selected}
          units={catalog}
          busy={execute.isPending}
          onClose={() => setSelected(null)}
          onRepeat={() => repeat(selected)}
          onFetch={() => void start(selected.run.id, selected)}
        />
      )}
    </div>
  );
}
