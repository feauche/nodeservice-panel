import {
  type DpiCheck,
  type DpiEstimate,
  type DpiPoint,
  dpiCheckSchema,
  dpiEstimateSchema,
  dpiScheduleSchema,
  dpiWorkspaceSchema,
  type RemnawaveNode,
} from '@nodeservice/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarClockIcon,
  ChevronRightIcon,
  Loader2Icon,
  PlayIcon,
  PlugIcon,
  PlusIcon,
  SearchIcon,
  WalletIcon,
  XIcon,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import { CountryFlag } from '@/components/country-flag';
import { DialogPrimaryButton, DialogSecondaryButton } from '@/components/dialog-actions';
import { KpiCard, KpiCardSkeleton } from '@/components/kpi-card';
import { PageActions } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { PasswordField } from '@/features/auth/components/password-field';
import { nodeOption } from '@/features/nodes/node-option';
import { useNodes } from '@/features/nodes/nodes-api';
import { Pill, Segmented, Toggle } from '@/features/settings/settings-ui';
import { api, apiErrorMessage } from '@/lib/api';
import { plural } from '@/lib/plural';
import { cn, randomId } from '@/lib/utils';
import { DpiTools } from './dpi-tools';

type Workspace = z.infer<typeof dpiWorkspaceSchema>;
type Tone = 'ok' | 'warn' | 'crit' | 'muted' | 'info';
const RUNNING = new Set(['pending', 'active', 'running']);
const isRunning = (c: DpiCheck) => RUNNING.has(c.status);
/** «0,04 $», «0,016 $», «5,92 $». */
export const usd = (n: number) =>
  `${n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 3 : 2 })} $`;
const whenFmt = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const when = (iso: string | null) =>
  iso && Number.isFinite(Date.parse(iso)) ? whenFmt.format(new Date(iso)) : '—';
const kindLabel = (kind: string) => (kind === 'vpn' ? 'VLESS' : kind === 'mtproto' ? 'MTProto' : 'IP');
const points = (n: number) => `${n} ${plural(n, 'точка', 'точки', 'точек')}`;
/** Длительность проверки: «1 мин 12 с», «48 с». */
function duration(c: DpiCheck) {
  const ms = Date.parse(c.completedAt ?? '') - Date.parse(c.createdAt);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} с` : `${Math.floor(s / 60)} мин ${String(s % 60).padStart(2, '0')} с`;
}
/** Откуда запущена: из этой панели (есть нода) или с сайта, бота, монитора DPI Checker. */
function sourceLabel(c: DpiCheck) {
  if (c.node) return 'из панели';
  return (
    {
      web: 'с сайта DPI Checker',
      bot: 'из бота DPI Checker',
      inline: 'из бота DPI Checker',
      watcher: 'монитор DPI Checker',
    }[c.source ?? ''] ?? 'не из панели'
  );
}
/** Итог проверки словами и цветом: открывается везде, частично, нигде; идёт; отменена; сбой. */
export function verdict(c: DpiCheck): { tone: Tone; label: string } {
  if (isRunning(c)) return { tone: 'info', label: c.status === 'pending' ? 'В очереди' : 'Идёт' };
  if (c.status === 'cancelled') return { tone: 'muted', label: 'Отменена' };
  if (c.status === 'failed') return { tone: 'crit', label: 'Сбой проверки' };
  const known = c.success === null ? 0 : c.total - c.unknown;
  if (c.success === null || known <= 0) return { tone: 'muted', label: 'Нет данных' };
  if (c.success === known) return { tone: 'ok', label: 'Доступна' };
  if (c.success === 0) return { tone: 'crit', label: 'Недоступна' };
  return { tone: 'warn', label: `Частично · ${c.success} из ${known}` };
}
const SEG: Record<DpiPoint['state'], string> = { ok: 'bg-ok', fail: 'bg-crit', unknown: 'bg-text-3/35' };
/** Полоса регионов: точка — отрезок, зелёный открывается, красный нет, серый без связи. */
function RegionBar({ check }: { check: DpiCheck }) {
  if (!check.results.length) return <span className="text-text-3">—</span>;
  const known = check.total - check.unknown;
  return (
    <div className="min-w-0">
      <div className="flex h-2 min-w-[120px] gap-[2px] overflow-hidden rounded-[4px]" aria-hidden="true">
        {check.results.map((p, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: точки одной проверки не переставляются
          <i key={i} className={cn('block flex-1', SEG[p.state])} />
        ))}
      </div>
      <small className="mt-1 block text-[12px] text-text-3">
        {check.success ?? 0} из {known} открывается{check.unknown ? ` · без связи ${check.unknown}` : ''}
      </small>
    </div>
  );
}
function NodeChip({ node }: { node?: RemnawaveNode; name?: string }) {
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-2 text-[13px]">
      {node?.countryCode && <CountryFlag code={node.countryCode} size="sm" />}
      <span className="truncate font-medium">{node?.name}</span>
      {node && (
        <span
          title={node.isConnected ? 'На связи' : 'Нет связи'}
          className={cn('size-1.5 flex-none rounded-full', node.isConnected ? 'bg-ok' : 'bg-crit')}
          aria-hidden="true"
        />
      )}
    </span>
  );
}
function DialogHead({ title, description }: { title: ReactNode; description: ReactNode }) {
  return (
    <div className="flex flex-none items-center gap-3 border-b border-border px-6 py-4 max-sm:px-4">
      <div className="min-w-0 flex-1">
        <DialogTitle className="font-heading text-[17px]">{title}</DialogTitle>
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
const dialogBox =
  'flex max-h-[calc(100dvh-48px)] flex-col gap-0 overflow-hidden rounded-2xl border-border-2 bg-surface p-0';
const dialogFoot =
  'flex flex-none items-center gap-3 border-t border-border bg-bg-2 px-6 py-3.5 max-sm:flex-col max-sm:items-stretch max-sm:px-4';
const footButton = 'h-10 w-[128px] flex-none rounded-[10px] max-sm:w-full sm:flex-none sm:max-w-none';
const outline = 'h-10 rounded-[10px] px-4 text-[13px] font-medium';
const label = 'mb-1.5 block text-[12.5px] font-medium text-text-2';

/** «Что проверяет DPI Checker и когда его запускать»: три шага и как читать итог. Свёрнутость помнит браузер. */
function Explain({ data }: { data: Workspace }) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem('ns-dpi-explain') !== '0';
    } catch {
      return true;
    }
  });
  const toggle = () => {
    setOpen((v) => {
      try {
        localStorage.setItem('ns-dpi-explain', v ? '0' : '1');
      } catch {}
      return !v;
    });
  };
  const ipPrice = data.prices ? data.optimal * (data.prices.ipPop + data.prices.ipResource) : null;
  const steps = [
    {
      kick: 'Шаг 1 · бесплатно',
      title: 'Check-Host',
      text: 'Открыт ли порт ноды вообще. Проверяет с серверов хостеров в России и других странах.',
    },
    {
      kick: 'Шаг 2 · DPI Checker · платно',
      title: 'Открывается ли у домашних провайдеров',
      text: `${points(data.pops.length)} в России у домашних провайдеров. Режим IP проверяет порт и TLS, режим VLESS — настоящее подключение по ключу.`,
      current: true,
    },
    {
      kick: 'Шаг 3 · BS Checker · кредиты',
      title: 'Проходит ли белые списки мобильных',
      text: 'Для нод белого списка у мобильных операторов. DPI Checker мобильные белые списки не видит.',
    },
  ];
  return (
    <section
      className="overflow-hidden rounded-2xl border border-border bg-surface"
      aria-label="Что проверяет DPI Checker"
    >
      <header className="flex min-h-14 items-center gap-3 px-[18px] py-3">
        <h2 className="flex-1 font-heading text-[14.5px] font-semibold">
          Что проверяет DPI Checker и когда его запускать
        </h2>
        <Button
          variant="outline"
          className="h-9 rounded-[10px] px-3.5 text-[12.5px]"
          onClick={toggle}
          aria-expanded={open}
        >
          {open ? 'Свернуть' : 'Показать'}
        </Button>
      </header>
      {open && (
        <div className="flex flex-col gap-3.5 border-t border-border px-[18px] py-4">
          <ol className="grid grid-cols-3 gap-2.5 max-md:grid-cols-1">
            {steps.map((s) => (
              <li
                key={s.kick}
                className={cn(
                  'rounded-[14px] border bg-surface px-3.5 py-3',
                  s.current ? 'border-brand shadow-[0_0_0_3px_var(--ns-accent-soft)]' : 'border-border',
                )}
              >
                <span className={cn('text-[11.5px] font-semibold', s.current ? 'text-brand' : 'text-text-3')}>
                  {s.kick}
                </span>
                <b className="mt-1.5 mb-1 block text-[14px] font-semibold">{s.title}</b>
                <small className="block text-[12.5px] leading-normal text-text-3">{s.text}</small>
              </li>
            ))}
          </ol>
          <div className="grid grid-cols-2 gap-4 text-[13px] leading-relaxed text-text-2 max-md:grid-cols-1">
            <p>
              <b className="font-semibold text-foreground">Когда запускать.</b> Check-Host показал «недоступен
              из РФ», или упал онлайн, а порт открыт. Если порт закрыт везде, DPI Checker не нужен — нода
              просто не отвечает.
            </p>
            <p>
              <b className="font-semibold text-foreground">Как читать итог.</b> Один красный регион — ещё не
              блокировка по стране. «Сертификат другого имени» у Reality — норма, это не недоступность.
              {ipPrice !== null && ` Цена: около ${usd(ipPrice)} за IP-проверку на ${points(data.optimal)}.`}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

/** Что значит главная причина отказа — для итога в окне результата. */
const EXPLAIN: Record<string, string> = {
  'Сброс при установке TLS':
    'Порт отвечает, но соединение рвётся при установке TLS — похоже на блокировку по протоколу (ТСПУ). Проверьте BS Checker и подумайте о смене адреса.',
  'Порт открыт, TLS не проходит':
    'Порт отвечает, но TLS не устанавливается ни разу — похоже на блокировку по протоколу (ТСПУ). Если на этом порту у ноды не TLS, режим IP её не покажет — проверьте режимом VLESS.',
  'Нет ответа':
    'Точки не дождались ответа — адрес фильтруется целиком или нода не отвечает. Сравните с Check-Host: если и там закрыто, дело в ноде.',
  'Порт закрыт': 'Порт закрыт — нода не принимает подключения на этом порту.',
  Замедление: 'Соединение есть, но скорость режут — похоже на замедление трафика.',
};
/** Окно результата: итог словами, плитки регионов с причиной, подробности по точкам, отмена и повтор. */
function ResultDialog({
  check: initial,
  nodes,
  onClose,
  onRepeat,
}: {
  check: DpiCheck;
  nodes: RemnawaveNode[];
  onClose: () => void;
  onRepeat: (c: DpiCheck) => void;
}) {
  const client = useQueryClient();
  const detail = useQuery({
    queryKey: ['dpi-check', initial.id],
    queryFn: ({ signal }) => api.get(`/integrations/dpi/checks/${initial.id}`, dpiCheckSchema, signal),
    initialData: initial,
    // Пока проверка идёт — свежий ход каждые 5 секунд.
    refetchInterval: (q) => (q.state.data && RUNNING.has(q.state.data.status) ? 5000 : false),
  });
  const c = detail.data ?? initial;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const v = verdict(c);
  const known = c.total - c.unknown;
  const fails = c.results.filter((p) => p.state === 'fail');
  const reasons = new Map<string, number>();
  for (const p of fails) reasons.set(p.reason ?? '', (reasons.get(p.reason ?? '') ?? 0) + 1);
  const top = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  const explain =
    v.tone === 'ok'
      ? 'Нода открывается у домашних провайдеров во всех проверенных регионах.'
      : (EXPLAIN[top] ??
        (c.success === 0 ? 'Ни одна точка не смогла открыть ноду.' : 'Часть точек не смогла открыть ноду.'));
  const title =
    v.tone === 'ok'
      ? `Открывается во всех ${known} ${plural(known, 'регионе', 'регионах', 'регионах')}`
      : v.tone === 'crit' && c.success === 0
        ? `Не открывается ни в одном из ${known} ${plural(known, 'региона', 'регионов', 'регионов')}`
        : v.tone === 'warn'
          ? `Открывается в ${c.success} из ${known} ${plural(known, 'региона', 'регионов', 'регионов')}`
          : v.label;
  async function cancel() {
    setBusy(true);
    setError('');
    try {
      await api.post(`/integrations/dpi/checks/${c.id}/cancel`, {}, z.object({ refunded: z.number() }));
      await client.invalidateQueries({ queryKey: ['dpi-workspace'] });
      await detail.refetch();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const node = nodes.find((n) => n.uuid === c.node?.uuid);
  const meta = [
    when(c.createdAt),
    points(c.total),
    duration(c),
    c.refunded ? 'деньги вернули' : c.cost !== null ? usd(c.cost) : null,
    sourceLabel(c),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent showCloseButton={false} className={cn(dialogBox, 'sm:max-w-[860px]')}>
        <DialogHead
          title={`${c.node?.name ?? `Проверка #${c.id}`} · режим ${kindLabel(c.kind)}`}
          description={meta}
        />
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 py-5 max-sm:px-4">
          {isRunning(c) ? (
            <div className="rounded-[12px] border border-brand/40 bg-brand-soft/40 px-4 py-3">
              <b className="text-[14px] font-semibold">
                {c.status === 'pending' ? 'Проверка в очереди' : 'Проверка идёт'}
              </b>
              <p className="mt-0.5 text-[12.5px] text-text-2">
                {c.progress
                  ? `Готово ${c.progress.done} из ${c.progress.total} — окно обновляется само.`
                  : 'Ждём первые ответы точек — окно обновляется само.'}
              </p>
              {c.progress && (
                <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-surface-3">
                  <i
                    className="block h-full rounded-full bg-brand"
                    style={{ width: `${Math.min(100, c.progress.percent)}%` }}
                  />
                </div>
              )}
            </div>
          ) : (
            <div
              className={cn(
                'rounded-[12px] border px-4 py-3',
                v.tone === 'ok'
                  ? 'border-ok/35 bg-ok-soft/50'
                  : v.tone === 'crit'
                    ? 'border-crit/35 bg-crit-soft/50'
                    : v.tone === 'warn'
                      ? 'border-warn/35 bg-warn-soft/50'
                      : 'border-border bg-surface-2/50',
              )}
            >
              <b className="text-[14px] font-semibold">{title}</b>
              {known > 0 && (
                <p className="mt-0.5 text-[12.5px] leading-relaxed text-text-2">
                  {explain}
                  {c.unknown > 0 &&
                    ` ${c.unknown} ${plural(c.unknown, 'точка была', 'точки были', 'точек были')} без связи — они не в счёт.`}
                </p>
              )}
            </div>
          )}
          {c.results.length > 0 && (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1.5" aria-label="Регионы">
              {c.results.map((p, i) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: точки одной проверки не переставляются
                  key={i}
                  className={cn(
                    'min-w-0 rounded-[10px] border px-2.5 py-2 text-[12px]',
                    p.state === 'ok'
                      ? 'border-ok/40 bg-ok-soft'
                      : p.state === 'fail'
                        ? 'border-crit/45 bg-crit-soft'
                        : 'border-dashed border-border-2 bg-surface-2',
                  )}
                >
                  <b className="block truncate text-[12.5px] font-semibold" title={p.location}>
                    {p.location}
                  </b>
                  <span
                    className={cn(
                      'mt-1 block font-semibold',
                      p.state === 'ok' ? 'text-ok' : p.state === 'fail' ? 'text-crit' : 'text-text-2',
                    )}
                  >
                    {p.state === 'ok'
                      ? p.latency !== null
                        ? `${Math.round(p.latency)} мс`
                        : 'Открывается'
                      : (p.reason ?? '—')}
                  </span>
                  {p.state === 'ok' && p.reason && (
                    <span className="mt-0.5 block text-text-3">{p.reason}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {c.results.some((p) => p.tls !== null || p.port80 !== null) && (
            <div className="overflow-x-auto rounded-[12px] border border-border">
              <table className="w-full min-w-[560px] text-left text-[12.5px]">
                <thead className="bg-surface-2 text-[11px] tracking-[0.08em] text-text-3 uppercase">
                  <tr>
                    {['Регион', 'TLS прошёл', 'Замедление', 'Пинг', 'Порт 80'].map((h) => (
                      <th key={h} className="px-3 py-2 font-semibold">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {c.results.map((p, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: точки одной проверки не переставляются
                    <tr key={i} className="border-t border-border">
                      <td className="px-3 py-2">{p.location}</td>
                      <td className="px-3 py-2 tabular-nums">{p.tls ?? '—'}</td>
                      <td className="px-3 py-2 tabular-nums">{p.throttled ?? '—'}</td>
                      <td className="px-3 py-2 tabular-nums">
                        {p.latency !== null ? `${Math.round(p.latency)} мс` : '—'}
                      </td>
                      <td className={cn('px-3 py-2', p.port80 === 'перехвачен' && 'text-warn')}>
                        {p.port80 ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {error && (
            <p
              role="alert"
              className="rounded-[10px] border border-crit/30 bg-crit-soft px-3 py-2 text-[12.5px] text-crit"
            >
              {error}
            </p>
          )}
        </div>
        <div className={dialogFoot}>
          <p className="min-w-0 flex-1 text-[12px] leading-snug text-text-3">
            {c.status === 'pending'
              ? 'Не начатую проверку можно отменить — деньги вернутся.'
              : c.results.some((p) => p.port80 === 'перехвачен')
                ? 'Перехват порта 80 — провайдер подменяет ответы сайта; для VPN на 443 это не мешает.'
                : ''}
          </p>
          <div className="flex gap-2 max-sm:flex-col">
            {c.status === 'pending' ? (
              <DialogSecondaryButton
                disabled={busy}
                onClick={() => void cancel()}
                className={cn(footButton, 'w-auto px-4 hover:border-crit/50 hover:text-crit')}
              >
                {busy && <Loader2Icon className="animate-spin" aria-hidden="true" />}
                Отменить
              </DialogSecondaryButton>
            ) : (
              <DialogSecondaryButton onClick={onClose} className={footButton}>
                Закрыть
              </DialogSecondaryButton>
            )}
            {node && !isRunning(c) && (
              <DialogPrimaryButton onClick={() => onRepeat(c)} className={cn(footButton, 'w-auto px-4')}>
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

type Points = 'optimal' | 'all' | 'manual';
/** Выбор точек: оптимальные сервиса, все в России или вручную — с поиском по региону и оператору. */
function PointsPicker({
  data,
  mode,
  setMode,
  pops,
  setPops,
  disabled,
}: {
  data: Workspace;
  mode: Points;
  setMode: (m: Points) => void;
  pops: number[];
  setPops: (p: number[]) => void;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState('');
  const visible = data.pops
    .filter((p) => `${p.name} ${p.provider}`.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru') || a.provider.localeCompare(b.provider, 'ru'));
  return (
    <div>
      <p className={label}>Точки</p>
      <Segmented<Points>
        label="Какие точки"
        value={mode}
        onChange={setMode}
        items={[
          { key: 'optimal', label: `Оптимальные · ${data.optimal}` },
          { key: 'all', label: `Все в России · ${data.pops.length}` },
          { key: 'manual', label: 'Выбрать вручную' },
        ]}
      />
      <p className="mt-1.5 text-[12px] text-text-3">
        {mode === 'optimal'
          ? `${points(data.optimal)}, которые подбирает сам DPI Checker: разные регионы и операторы.`
          : mode === 'all'
            ? 'Все исправные точки сервиса в России — дороже, зато видно каждый регион.'
            : `Выбрано ${pops.length} из ${data.pops.length}.`}
      </p>
      {mode === 'manual' && (
        <div className="mt-2.5">
          <div className="mb-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Найти регион или оператора"
              aria-label="Поиск точек проверки"
              className="h-10 rounded-[10px] bg-surface-2"
            />
            <Button
              variant="outline"
              className={outline}
              disabled={disabled}
              onClick={() =>
                setPops(data.pops.every((p) => pops.includes(p.id)) ? [] : data.pops.map((p) => p.id))
              }
            >
              {data.pops.length && data.pops.every((p) => pops.includes(p.id))
                ? 'Снять выбор'
                : 'Выбрать все'}
            </Button>
          </div>
          <div className="grid max-h-60 gap-1.5 overflow-auto rounded-[12px] border border-border bg-bg-2/45 p-2 sm:grid-cols-2">
            {visible.map((p) => (
              <label
                htmlFor={`dpi-pop-${p.id}`}
                key={p.id}
                className="flex min-h-10 cursor-pointer items-center gap-3 rounded-[9px] border border-border px-3 py-1.5 text-[12.5px] transition-colors hover:bg-surface-2"
              >
                <Toggle
                  id={`dpi-pop-${p.id}`}
                  checked={pops.includes(p.id)}
                  disabled={disabled}
                  onChange={(on) => setPops(on ? [...pops, p.id] : pops.filter((id) => id !== p.id))}
                />
                <span className="min-w-0 truncate">
                  {p.name}
                  {p.provider && <span className="text-text-3"> · {p.provider}</span>}
                </span>
              </label>
            ))}
            {!visible.length && (
              <p className="col-span-full px-3 py-6 text-center text-[12px] text-text-3">
                Точек с таким регионом или оператором нет.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
const popsFor = (data: Workspace, mode: Points, manual: number[]) =>
  mode === 'optimal' ? [] : mode === 'all' ? data.pops.map((p) => p.id) : manual;

/** «Новая проверка»: нода, режим IP или VLESS, точки; цена и хватит ли баланса — до запуска. */
function NewCheckDialog({
  data,
  nodes,
  initial,
  onClose,
  onStarted,
}: {
  data: Workspace;
  nodes: RemnawaveNode[];
  initial: { node: string | null; kind: 'ip' | 'vpn' };
  onClose: () => void;
  onStarted: (c: DpiCheck) => void;
}) {
  const client = useQueryClient();
  const [node, setNode] = useState<string | null>(initial.node);
  const [kind, setKind] = useState<'ip' | 'vpn'>(initial.kind);
  const [key, setKey] = useState('');
  const [mode, setMode] = useState<Points>('optimal');
  const [manual, setManual] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [requestId] = useState(() => randomId());
  const popIds = popsFor(data, mode, manual);
  const ready =
    Boolean(node) &&
    (kind === 'ip' || key.startsWith('vless://')) &&
    (mode !== 'manual' || manual.length > 0);
  const body = { nodeUuid: node, kind, key: kind === 'vpn' ? key : undefined, popIds };
  // Цена — у самого сервиса (бесплатная оценка): тарифы и «оптимальный» набор у него меняются.
  const estimate = useQuery({
    queryKey: ['dpi-estimate', node, kind, kind === 'vpn' ? key : '', popIds.join(',')],
    queryFn: () => api.post('/integrations/dpi/estimate', body, dpiEstimateSchema),
    enabled: ready,
    staleTime: 60_000,
    retry: false,
  });
  const e: DpiEstimate | undefined = estimate.data;
  async function start() {
    setBusy(true);
    setError('');
    try {
      const result = await api.post('/integrations/dpi/checks', { ...body, requestId }, dpiCheckSchema);
      await client.invalidateQueries({ queryKey: ['dpi-workspace'] });
      onStarted(result);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  const target = nodes.find((n) => n.uuid === node);
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent showCloseButton={false} className={cn(dialogBox, 'sm:max-w-[720px]')}>
        <DialogHead
          title="Новая проверка"
          description="Деньги списываются с баланса DPI Checker при запуске. Не начатую проверку можно отменить — они вернутся."
        />
        <fieldset
          disabled={busy}
          className="m-0 flex min-h-0 flex-col gap-4 overflow-y-auto border-0 px-6 py-5 max-sm:px-4"
        >
          <div>
            <p className={label}>Нода</p>
            <Combobox
              ariaLabel="Нода для проверки"
              value={node}
              onChange={setNode}
              options={nodes.map((n) => nodeOption({ id: n.uuid, name: n.name, host: n.address }))}
              placeholder="Выберите ноду"
              searchPlaceholder="Найти ноду…"
              className="h-10 w-full"
            />
          </div>
          <div>
            <p className={label}>Что проверять</p>
            <div
              className="grid grid-cols-2 gap-2.5 max-sm:grid-cols-1"
              role="radiogroup"
              aria-label="Что проверять"
            >
              {(
                [
                  [
                    'ip',
                    'Адрес и порт · IP',
                    'Открывается ли адрес, проходит ли TLS, нет ли замедления. Дешевле.',
                  ],
                  [
                    'vpn',
                    'Подключение · VLESS',
                    'Пробует настоящее VPN-подключение по ключу. Ключ в панели не сохраняется.',
                  ],
                ] as const
              ).map(([k, title, help]) => (
                // biome-ignore lint/a11y/useSemanticElements: карточка-выбор с пояснением, как в окне ноды
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={kind === k}
                  onClick={() => setKind(k)}
                  className={cn(
                    'cursor-pointer rounded-[12px] border px-3.5 py-3 text-left transition-colors',
                    kind === k ? 'border-brand bg-brand-soft/40' : 'border-border hover:bg-surface-2',
                  )}
                >
                  <b className="block text-[13.5px] font-semibold">{title}</b>
                  <span className="mt-0.5 block text-[12px] leading-snug text-text-3">{help}</span>
                </button>
              ))}
            </div>
          </div>
          {kind === 'vpn' && (
            <div>
              <label htmlFor="dpi-vless" className={label}>
                Ключ подключения
              </label>
              <PasswordField
                id="dpi-vless"
                value={key}
                onChange={(ev) => setKey(ev.target.value)}
                autoComplete="off"
                placeholder="vless://… ключ любого пользователя этой ноды"
                className="h-10 w-full"
              />
            </div>
          )}
          <PointsPicker
            data={data}
            mode={mode}
            setMode={setMode}
            pops={manual}
            setPops={setManual}
            disabled={busy}
          />
          {error && (
            <p
              role="alert"
              className="rounded-[10px] border border-crit/30 bg-crit-soft px-3 py-2 text-[12.5px] text-crit"
            >
              {error}
            </p>
          )}
        </fieldset>
        <div className={dialogFoot}>
          <p className="flex min-w-0 flex-1 items-center gap-2 text-[12.5px] leading-snug text-text-2">
            <WalletIcon className="size-4 flex-none text-text-3" aria-hidden="true" />
            {!ready ? (
              <span className="text-text-3">
                {!target
                  ? 'Выберите ноду — цена появится здесь.'
                  : kind === 'vpn'
                    ? 'Вставьте ключ — цена появится здесь.'
                    : 'Выберите точки.'}
              </span>
            ) : estimate.isFetching && !e ? (
              <span className="text-text-3">Считаю стоимость…</span>
            ) : estimate.isError ? (
              <span className="text-crit">{apiErrorMessage(estimate.error)}</span>
            ) : e ? (
              <span>
                Стоимость <b className="font-semibold text-foreground">{usd(e.cost)}</b>
                {e.balance !== null && ` · на балансе ${usd(e.balance)}`} ·{' '}
                <span className={e.affordable ? 'text-ok' : 'text-crit'}>
                  {e.affordable ? 'хватит' : 'не хватит'}
                </span>
                {e.minutes !== null && ` · до ${e.minutes} мин`}
              </span>
            ) : null}
          </p>
          <div className="flex gap-2 max-sm:flex-col">
            <DialogSecondaryButton disabled={busy} onClick={onClose} className={footButton}>
              Отмена
            </DialogSecondaryButton>
            <DialogPrimaryButton
              disabled={busy || !ready || !e?.affordable}
              onClick={() => void start()}
              className="h-10 min-w-[128px] flex-none rounded-[10px] px-4 whitespace-nowrap max-sm:w-full sm:w-auto sm:flex-none sm:max-w-none"
            >
              {busy && <Loader2Icon className="animate-spin" aria-hidden="true" />}
              {e ? `Запустить за ${usd(e.cost)}` : 'Запустить'}
            </DialogPrimaryButton>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const INTERVALS: Array<[number, string]> = [
  [15, 'каждые 15 минут'],
  [30, 'каждые 30 минут'],
  [60, 'каждый час'],
  [180, 'каждые 3 часа'],
  [360, 'каждые 6 часов'],
  [720, 'каждые 12 часов'],
  [1440, 'раз в сутки'],
];
const intervalText = (m: number) => INTERVALS.find(([v]) => v === m)?.[1] ?? `каждые ${m} мин`;
/** Расписание платных IP-проверок: ноды, точки и частота; цена запуска и суток — до сохранения. */
function ScheduleDialog({
  data,
  nodes,
  onClose,
}: {
  data: Workspace;
  nodes: RemnawaveNode[];
  onClose: () => void;
}) {
  const client = useQueryClient();
  const s = data.schedule;
  const [enabled, setEnabled] = useState(s.enabled);
  const [minutes, setMinutes] = useState(s.minutes);
  const [picked, setPicked] = useState<string[]>(s.nodes);
  const [mode, setMode] = useState<Points>(
    s.pops.length ? (s.pops.length === data.pops.length ? 'all' : 'manual') : 'optimal',
  );
  const [manual, setManual] = useState<number[]>(s.pops);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pops = popsFor(data, mode, manual);
  const perRun = data.prices
    ? picked.length * (pops.length || data.optimal) * (data.prices.ipPop + data.prices.ipResource)
    : null;
  async function save() {
    setBusy(true);
    setError('');
    try {
      await api.put(
        '/integrations/dpi/schedule',
        { enabled, minutes, nodes: picked, pops },
        dpiScheduleSchema,
      );
      await client.invalidateQueries({ queryKey: ['dpi-workspace'] });
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const all = nodes.length > 0 && nodes.every((n) => picked.includes(n.uuid));
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent showCloseButton={false} className={cn(dialogBox, 'sm:max-w-[720px]')}>
        <DialogHead
          title="Расписание проверок"
          description="Платные IP-проверки выбранных нод сами, с заданной частотой."
        />
        <fieldset
          disabled={busy}
          className="m-0 flex min-h-0 flex-col gap-4 overflow-y-auto border-0 px-6 py-5 max-sm:px-4"
        >
          <div className="flex items-center gap-3 rounded-[12px] border border-border px-3.5 py-3">
            <div className="min-w-0 flex-1">
              <label htmlFor="dpi-schedule-enabled" className="text-[13.5px] font-semibold">
                Проверять по расписанию
              </label>
              <p className="mt-0.5 text-[12px] leading-snug text-text-3">
                Платно: каждая проверка списывается с баланса DPI Checker. Не хватит денег — расписание
                остановится и скажет об этом.
              </p>
            </div>
            <Toggle id="dpi-schedule-enabled" checked={enabled} onChange={setEnabled} />
          </div>
          <div>
            <p className={label}>Как часто</p>
            <Combobox
              ariaLabel="Как часто"
              value={String(minutes)}
              onChange={(v) => setMinutes(Number(v ?? 60))}
              options={INTERVALS.map(([v, t]) => ({ value: String(v), label: t }))}
              placeholder="каждый час"
              className="h-10 w-full"
            />
          </div>
          <div>
            <div className="mb-1.5 flex items-center justify-between gap-3">
              <p className="text-[12.5px] font-medium text-text-2">
                Ноды · {picked.length} из {nodes.length}
              </p>
              <Button
                variant="outline"
                className="h-9 rounded-[10px] px-3.5 text-[12.5px]"
                disabled={!nodes.length}
                onClick={() => setPicked(all ? [] : nodes.map((n) => n.uuid))}
              >
                {all ? 'Снять выбор' : 'Выбрать все'}
              </Button>
            </div>
            <div className="grid max-h-56 gap-1.5 overflow-auto sm:grid-cols-2">
              {nodes.map((n) => (
                <label
                  htmlFor={`dpi-node-${n.uuid}`}
                  key={n.uuid}
                  className="flex min-h-10 cursor-pointer items-center gap-3 rounded-[9px] border border-border px-3 py-1.5 text-[12.5px] transition-colors hover:bg-surface-2"
                >
                  <Toggle
                    id={`dpi-node-${n.uuid}`}
                    checked={picked.includes(n.uuid)}
                    onChange={(on) =>
                      setPicked(on ? [...picked, n.uuid] : picked.filter((id) => id !== n.uuid))
                    }
                  />
                  <NodeChip node={n} />
                </label>
              ))}
            </div>
          </div>
          <PointsPicker
            data={data}
            mode={mode}
            setMode={setMode}
            pops={manual}
            setPops={setManual}
            disabled={busy}
          />
          {error && (
            <p
              role="alert"
              className="rounded-[10px] border border-crit/30 bg-crit-soft px-3 py-2 text-[12.5px] text-crit"
            >
              {error}
            </p>
          )}
        </fieldset>
        <div className={dialogFoot}>
          <p className="min-w-0 flex-1 text-[12px] leading-snug text-text-3">
            {perRun !== null && picked.length
              ? `За запуск ≈ ${usd(perRun)}, за сутки ≈ ${usd((perRun * 1440) / minutes)}.`
              : 'Цена запуска зависит от числа нод и точек.'}
          </p>
          <div className="flex gap-2 max-sm:flex-col">
            <DialogSecondaryButton disabled={busy} onClick={onClose} className={footButton}>
              Отмена
            </DialogSecondaryButton>
            <DialogPrimaryButton
              disabled={busy || (enabled && (!picked.length || (mode === 'manual' && !manual.length)))}
              onClick={() => void save()}
              className={footButton}
            >
              {busy && <Loader2Icon className="animate-spin" aria-hidden="true" />}
              Сохранить
            </DialogPrimaryButton>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function DpiWorkspaceSkeleton() {
  return (
    <div role="status" aria-label="Загрузка DPI Checker" className="flex flex-col gap-3">
      <div className="flex min-h-14 items-center gap-3 rounded-2xl border border-border bg-surface px-[18px] py-3">
        <Skeleton className="h-4 w-80 max-w-full" />
        <Skeleton className="ml-auto h-9 w-24 rounded-[10px]" />
      </div>
      <div className="grid grid-cols-4 gap-3 max-lg:grid-cols-2">
        {[1, 2, 3, 4].map((i) => (
          <KpiCardSkeleton key={i} />
        ))}
      </div>
      {[5, 3].map((rows) => (
        <div key={rows} className="overflow-hidden rounded-2xl border border-border bg-surface">
          <div className="flex min-h-14 items-center gap-3 border-b border-border px-[18px] py-3">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="ml-auto h-9 w-32 rounded-[10px]" />
          </div>
          {Array.from({ length: rows }, (_, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: заглушка без данных
              key={i}
              className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_120px] items-center gap-4 border-t border-border px-[18px] py-3.5 first:border-t-0 max-md:grid-cols-[minmax(0,1fr)_auto]"
            >
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3.5 w-2/3 max-md:hidden" />
              <Skeleton className="h-2 w-full rounded-[4px] max-md:hidden" />
              <Skeleton className="h-[22px] w-24 rounded-full" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * «DPI Checker» (витрина redesign-2026-10, DPI, вариант A): что это и когда запускать, баланс и на сколько
 * хватит, итог по каждой ноде, проверки с ценой и ходом, бесплатные инструменты сервиса.
 */
export function DpiWorkspace({
  settings,
  initialNode,
  onInitialNodeUsed,
}: {
  settings: () => void;
  initialNode?: string;
  onInitialNodeUsed?: () => void;
}) {
  const query = useQuery({
    queryKey: ['dpi-workspace'],
    queryFn: ({ signal }) => api.get('/integrations/dpi/overview', dpiWorkspaceSchema, signal),
    // Идёт проверка — обновляем часто, иначе раз в 30 секунд.
    refetchInterval: (q) => (q.state.data?.checks.some((c) => RUNNING.has(c.status)) ? 5000 : 30000),
  });
  const nodesQuery = useNodes();
  const nodes = nodesQuery.data?.nodes ?? [];
  const [newCheck, setNewCheck] = useState<{ node: string | null; kind: 'ip' | 'vpn' } | null>(null);
  const [result, setResult] = useState<DpiCheck | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(10);
  // Пришли из совета Ассистента: сразу «Новая проверка» с этой нодой. Запускает проверку владелец.
  useEffect(() => {
    if (!initialNode) return;
    setNewCheck({ node: initialNode, kind: 'ip' });
    onInitialNodeUsed?.();
  }, [initialNode, onInitialNodeUsed]);
  const data = query.data;
  const checks = data?.checks ?? [];
  // Последняя проверка каждой ноды — по времени запуска.
  const lastByNode = useMemo(() => {
    const map = new Map<string, DpiCheck>();
    for (const c of [...checks].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)))
      if (c.node && !map.has(c.node.uuid)) map.set(c.node.uuid, c);
    return map;
  }, [checks]);
  const balance = data?.balance != null ? Number(data.balance) : null;
  const ipPrice = data?.prices ? data.optimal * (data.prices.ipPop + data.prices.ipResource) : null;
  const month = checks.filter((c) => Date.now() - Date.parse(c.createdAt) < 30 * 86_400_000);
  const spent = month.reduce((sum, c) => sum + (c.refunded ? 0 : (c.cost ?? 0)), 0);
  const down = nodes.filter((n) => {
    const c = lastByNode.get(n.uuid);
    return c && verdict(c).tone === 'crit' && c.status === 'completed';
  });
  // Проверенные — наверху: сначала недоступные, потом частично, потом доступные; непроверенные — как в Remnawave.
  const rank = (n: RemnawaveNode) => {
    const c = lastByNode.get(n.uuid);
    return c ? ({ crit: 0, warn: 1, info: 2, ok: 3, muted: 4 } as const)[verdict(c).tone] : 5;
  };
  const visibleNodes = nodes
    .filter((n) => n.name.toLowerCase().includes(search.trim().toLowerCase()))
    .map((n, i) => ({ n, i }))
    .sort((a, b) => rank(a.n) - rank(b.n) || a.i - b.i)
    .map(({ n }) => n);
  return (
    <div className="flex flex-col gap-3">
      <PageActions>
        <Button variant="outline" className={outline} onClick={settings}>
          <PlugIcon className="size-4" aria-hidden="true" />
          Подключение
        </Button>
        <button
          type="button"
          disabled={!data}
          onClick={() => setNewCheck({ node: null, kind: 'ip' })}
          className="inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-[10px] bg-cta px-4 text-[13px] font-semibold text-cta-foreground transition-colors hover:bg-(--ns-cta-hover) disabled:cursor-default disabled:opacity-50"
        >
          <PlusIcon className="size-4" aria-hidden="true" />
          Новая проверка
        </button>
      </PageActions>
      {query.isPending ? (
        <DpiWorkspaceSkeleton />
      ) : query.isError || !data ? (
        <p
          role="alert"
          className="rounded-[12px] border border-crit/30 bg-crit-soft p-4 text-[13px] text-crit"
        >
          {apiErrorMessage(query.error)}{' '}
          <button
            type="button"
            onClick={() => void query.refetch()}
            className="cursor-pointer font-semibold underline"
          >
            Повторить
          </button>
        </p>
      ) : (
        <>
          <Explain data={data} />
          <div className="grid grid-cols-4 gap-3 max-lg:grid-cols-2">
            <KpiCard
              label="Баланс"
              value={balance !== null ? balance.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) : '—'}
              unit={balance !== null ? '$' : undefined}
              status={
                balance === null
                  ? 'не удалось узнать'
                  : ipPrice
                    ? balance < ipPrice
                      ? 'меньше одной проверки'
                      : `≈ ${Math.floor(balance / ipPrice)} проверок IP`
                    : 'баланс DPI Checker'
              }
              tone={balance === null ? 'muted' : ipPrice && balance < ipPrice ? 'warn' : 'ok'}
            />
            <KpiCard
              label="За 30 дней"
              value={month.length}
              unit={plural(month.length, 'проверка', 'проверки', 'проверок')}
              status={`потрачено ${usd(spent)}`}
              tone={month.length ? 'ok' : 'muted'}
            />
            <KpiCard
              label="Недоступны"
              value={down.length}
              unit={plural(down.length, 'нода', 'ноды', 'нод')}
              status={
                down.length
                  ? down
                      .slice(0, 2)
                      .map((n) => n.name)
                      .join(', ') + (down.length > 2 ? '…' : '')
                  : 'проверенные открываются'
              }
              tone={down.length ? 'crit' : 'ok'}
            />
            <KpiCard
              label="Автопроверки"
              value={data.schedule.enabled ? 'Вкл' : 'Выкл'}
              status={
                data.schedule.enabled
                  ? `${intervalText(data.schedule.minutes)} · ${data.schedule.nodes.length} ${plural(data.schedule.nodes.length, 'нода', 'ноды', 'нод')}`
                  : 'не запускаются'
              }
              tone={data.schedule.lastError ? 'warn' : data.schedule.enabled ? 'ok' : 'muted'}
            />
          </div>
          <section className="overflow-hidden rounded-2xl border border-border bg-surface" aria-label="Ноды">
            <header className="flex min-h-14 flex-wrap items-center gap-3 border-b border-border px-[18px] py-2.5">
              <h2 className="font-heading text-[14.5px] font-semibold">Ноды</h2>
              <span className="text-[12px] text-text-3 max-sm:hidden">последняя проверка каждой ноды</span>
              <div className="relative ml-auto w-[220px] max-sm:w-full">
                <SearchIcon
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-3"
                  aria-hidden="true"
                />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Нода"
                  aria-label="Поиск ноды"
                  className="h-9 w-full rounded-[10px] bg-surface pl-9"
                />
              </div>
            </header>
            <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.1fr)_150px_120px] gap-4 border-b border-border px-[18px] py-2.5 text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase max-md:hidden">
              <span>Нода</span>
              <span>Последняя проверка</span>
              <span>Регионы</span>
              <span>Итог</span>
              <span />
            </div>
            {visibleNodes.map((n) => {
              const c = lastByNode.get(n.uuid);
              const v = c ? verdict(c) : { tone: 'muted' as const, label: 'Не проверялась' };
              return (
                <div
                  key={n.uuid}
                  className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.1fr)_150px_120px] items-center gap-4 border-t border-border px-[18px] py-3 text-[13px] first-of-type:border-t-0 max-md:grid-cols-[minmax(0,1fr)_auto]"
                >
                  <div className="min-w-0">
                    <NodeChip node={n} />
                    <small className="mt-0.5 block text-[12px] text-text-3 md:hidden">
                      {c ? `${when(c.createdAt)} · ${v.label}` : 'Не проверялась'}
                    </small>
                  </div>
                  <div className="min-w-0 max-md:hidden">
                    {c ? (
                      <button
                        type="button"
                        onClick={() => setResult(c)}
                        className="cursor-pointer text-left hover:text-brand"
                      >
                        {when(c.createdAt)}
                        <small className="block text-[12px] text-text-3">
                          Режим {kindLabel(c.kind)} · {points(c.total)}
                        </small>
                      </button>
                    ) : (
                      <span className="text-text-3">—</span>
                    )}
                  </div>
                  <div className="min-w-0 max-md:hidden">
                    {c ? <RegionBar check={c} /> : <span className="text-text-3">—</span>}
                  </div>
                  <div className="max-md:hidden">
                    <Pill tone={v.tone}>{v.label}</Pill>
                  </div>
                  <div className="flex justify-end">
                    <Button
                      variant="outline"
                      className="h-9 rounded-[10px] px-3.5 text-[12.5px]"
                      aria-label={`Проверить ${n.name}`}
                      onClick={() => setNewCheck({ node: n.uuid, kind: 'ip' })}
                    >
                      <PlayIcon className="size-3.5" aria-hidden="true" />
                      Проверить
                    </Button>
                  </div>
                </div>
              );
            })}
            {!visibleNodes.length && (
              <p className="px-[18px] py-6 text-center text-[13px] text-text-3">
                {nodes.length ? 'Нод с таким названием нет.' : 'Нод пока нет — подключите Remnawave.'}
              </p>
            )}
          </section>
          <section
            className="overflow-hidden rounded-2xl border border-border bg-surface"
            aria-label="Проверки"
          >
            <header className="flex min-h-14 flex-wrap items-center gap-3 border-b border-border px-[18px] py-2.5">
              <h2 className="font-heading text-[14.5px] font-semibold">Проверки</h2>
              <Pill>{checks.length}</Pill>
              <span className="text-[12px] text-text-3">
                {data.schedule.enabled
                  ? `по расписанию ${intervalText(data.schedule.minutes)}${data.schedule.nextAt ? `, следующая ${when(data.schedule.nextAt)}` : ''}`
                  : 'автопроверки выключены'}
              </span>
              <Button
                variant="outline"
                className={cn(outline, 'ml-auto h-9 px-3.5 text-[12.5px]')}
                onClick={() => setScheduleOpen(true)}
              >
                <CalendarClockIcon className="size-4" aria-hidden="true" />
                Расписание
              </Button>
            </header>
            {data.schedule.lastError && (
              <p
                role="alert"
                className="border-b border-border bg-warn-soft px-[18px] py-2.5 text-[12.5px] text-warn"
              >
                {data.schedule.lastError}
              </p>
            )}
            {checks.length ? (
              <ol aria-label="Проверки DPI Checker">
                {checks.slice(0, shown).map((c) => {
                  const v = verdict(c);
                  return (
                    <li key={c.id} className="border-t border-border first:border-t-0">
                      <button
                        type="button"
                        onClick={() => setResult(c)}
                        className="grid w-full cursor-pointer grid-cols-[28px_minmax(0,1fr)_auto_auto_16px] items-center gap-3 px-[18px] py-3 text-left transition-colors hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand max-sm:grid-cols-[28px_minmax(0,1fr)_auto]"
                      >
                        <img src="/integration-icons/dpi.ico" alt="" className="size-5 rounded-[5px]" />
                        <span className="min-w-0">
                          <b className="block truncate text-[13.5px] font-semibold">
                            {c.node?.name ?? `Проверка #${c.id}`} · режим {kindLabel(c.kind)} ·{' '}
                            {points(c.total)}
                          </b>
                          <small className="block truncate text-[12px] text-text-3">
                            {isRunning(c)
                              ? `${c.status === 'pending' ? 'В очереди' : 'Идёт'}${c.progress ? ` · ${c.progress.done} из ${c.progress.total}` : ''} · ${sourceLabel(c)}`
                              : [when(c.createdAt), duration(c), sourceLabel(c)].filter(Boolean).join(' · ')}
                          </small>
                          {isRunning(c) && c.progress && (
                            <span className="mt-1.5 block h-1 max-w-[320px] overflow-hidden rounded-full bg-surface-3">
                              <i
                                className="block h-full rounded-full bg-brand"
                                style={{ width: `${Math.min(100, c.progress.percent)}%` }}
                              />
                            </span>
                          )}
                        </span>
                        <span className="text-[12.5px] whitespace-nowrap text-text-3 tabular-nums max-sm:hidden">
                          {c.refunded
                            ? 'возвращено'
                            : c.cost !== null
                              ? `${isRunning(c) ? '≈ ' : ''}${usd(c.cost)}`
                              : ''}
                        </span>
                        <Pill tone={v.tone}>{v.label}</Pill>
                        <ChevronRightIcon className="size-4 text-text-3 max-sm:hidden" aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="px-[18px] py-6 text-center text-[13px] text-text-3">
                Проверок пока нет — нажмите «Проверить» у нужной ноды.
              </p>
            )}
            {checks.length > shown && (
              <div className="border-t border-border px-[18px] py-3">
                <Button
                  variant="outline"
                  className="h-10 w-full rounded-[10px] text-[13px]"
                  onClick={() => setShown((n) => n + 20)}
                >
                  Показать ещё {Math.min(20, checks.length - shown)}
                </Button>
              </div>
            )}
          </section>
          <DpiTools nodes={nodes} probePrice={data.probePrice} />
          {newCheck && (
            <NewCheckDialog
              data={data}
              nodes={nodes}
              initial={newCheck}
              onClose={() => setNewCheck(null)}
              onStarted={(c) => {
                setNewCheck(null);
                setResult(c);
              }}
            />
          )}
          {result && (
            <ResultDialog
              check={result}
              nodes={nodes}
              onClose={() => setResult(null)}
              onRepeat={(c) => {
                setResult(null);
                setNewCheck({ node: c.node?.uuid ?? null, kind: c.kind === 'vpn' ? 'vpn' : 'ip' });
              }}
            />
          )}
          {scheduleOpen && (
            <ScheduleDialog data={data} nodes={nodes} onClose={() => setScheduleOpen(false)} />
          )}
        </>
      )}
    </div>
  );
}
