import {
  CAPACITY_LIMIT_PCT,
  CAPACITY_RESOURCE_LABELS,
  CAPACITY_WINDOW_DAYS,
  type CapacityCell,
  type CapacityServer,
  formatMbit,
} from '@nodeservice/shared';
import {
  GaugeIcon,
  InfoIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  RefreshCwIcon,
  ServerIcon,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';

import { CountryFlag } from '@/components/country-flag';
import { DialogActions, DialogPrimaryButton, DialogSecondaryButton } from '@/components/dialog-actions';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { openServer } from '@/features/servers/server-modal-store';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { useCapacity, useMeasureLink, useRecomputeCapacity, useSetManualLink } from './capacity-api';

const nf = (v: number) => v.toLocaleString('ru-RU');
const WHEN = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const when = (iso: string | null) =>
  iso ? WHEN.format(new Date(iso)).replace(' в ', ', ').replace('.', '') : '';
const TIME = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const STATUS_TEXT: Record<CapacityServer['status'], string> = {
  ok: '',
  few_data: 'мало данных',
  weak: 'слабоват',
  no_online: 'не нода',
  no_metrics: 'нет метрик',
};

/**
 * «Обзор» → «Ёмкость» (витрина `capacity-0.58-readings-variants.html`, вариант A): спокойная таблица
 * показаний с одним итоговым вердиктом по каждой ноде.
 */
export function CapacityView() {
  const q = useCapacity();
  const recompute = useRecomputeCapacity();
  const [measure, setMeasure] = useState<CapacityServer | null>(null);
  const [manual, setManual] = useState<CapacityServer | null>(null);
  const c = q.data;

  if (q.isPending)
    return (
      <div className="flex flex-col gap-4" data-testid="capacity-loading">
        <Skeleton className="h-8 w-full rounded-[9px]" />
        <Skeleton className="h-[92px] rounded-2xl" />
        <Skeleton className="h-[360px] rounded-2xl" />
      </div>
    );
  if (q.isError || !c)
    return (
      <p className="rounded-2xl border border-crit/30 bg-crit-soft px-4 py-3 text-[13px]">
        Ёмкость не посчиталась: {apiErrorMessage(q.error)}
      </p>
    );

  const exits = c.servers.filter((s) => s.role !== 'other');
  const critical = exits.filter((s) => s.tone === 'crit' && s.left != null).length;
  const soonText =
    c.growthPctWeek == null
      ? 'Рост пока не виден: нужно 2 недели онлайна'
      : c.growthPctWeek <= 0
        ? `Онлайн за неделю ${c.growthPctWeek === 0 ? 'не изменился' : `снизился на ${nf(-c.growthPctWeek)} %`}`
        : c.soonest
          ? `до упора «${c.soonest.name}»`
          : 'запаса хватает';

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex-1 text-[12.5px] text-text-3">
          По пикам за {CAPACITY_WINDOW_DAYS} дней · посчитано в {TIME.format(new Date(c.computedAt))} ·
          пересчёт раз в час
        </span>
        <button
          type="button"
          onClick={() => recompute.mutate(undefined, { onError: (e) => toast.error(apiErrorMessage(e)) })}
          disabled={recompute.isPending}
          className="inline-flex h-[32px] cursor-pointer items-center gap-1.5 rounded-[9px] border border-border bg-surface px-3 text-[12.5px] font-medium text-text-2 transition-colors hover:text-foreground disabled:opacity-60"
        >
          <RefreshCwIcon
            className={cn('size-3.5', recompute.isPending && 'animate-spin')}
            aria-hidden="true"
          />
          {recompute.isPending ? 'Считаю…' : 'Пересчитать'}
        </button>
      </div>

      {!c.remnawave && (
        <Banner>
          Remnawave не подключена — без онлайна нод ёмкость не посчитать. Подключите её в «Серверы →
          Remnawave».
        </Banner>
      )}
      {c.remnawave && !c.vmOk && (
        <Banner>Хранилище метрик не ответило — нагрузка серверов сейчас неизвестна.</Banner>
      )}

      <div className="grid overflow-hidden rounded-2xl border border-border bg-surface sm:grid-cols-2 xl:grid-cols-4">
        <SummaryMetric
          caps="Итог"
          value={
            c.counted === 0
              ? 'Нет расчёта'
              : critical > 0
                ? `${critical} ${nodeWord(critical)} почти без запаса`
                : 'Запас есть'
          }
          tone={critical > 0 ? 'crit' : undefined}
          sub={
            c.left == null
              ? 'недостаточно данных для общего итога'
              : `суммарно можно добавить ≈ ${nf(c.left)} пользователей${c.counted < exits.length ? ` · по ${c.counted} из ${exits.length} нод` : ''}`
          }
        />
        <SummaryMetric
          caps="Онлайн в пик"
          value={c.onlinePeak == null ? '—' : nf(c.onlinePeak)}
          sub={c.peakAt ? `${when(c.peakAt)} · ${exits.length} нод` : 'онлайна пока не было'}
        />
        <SummaryMetric
          caps="Упор парка"
          value={c.bottleneck ? capital(CAPACITY_RESOURCE_LABELS[c.bottleneck]) : '—'}
          tone={c.bottleneck ? 'crit' : undefined}
          sub={
            c.bottleneck
              ? `${c.bottleneckCount} из ${c.counted} нод упираются в ${CAPACITY_RESOURCE_LABELS[c.bottleneck]}`
              : 'ещё не известен'
          }
        />
        <SummaryMetric
          caps="Следующий предел"
          value={c.soonest && c.growthPctWeek && c.growthPctWeek > 0 ? `≈ ${c.soonest.days} дн.` : '—'}
          sub={
            c.soonest && c.growthPctWeek && c.growthPctWeek > 0
              ? `${c.soonest.name} · при росте +${nf(c.growthPctWeek)} % в неделю`
              : soonText
          }
        />
      </div>

      <section className="min-w-0 rounded-2xl border border-border bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h2 className="font-heading text-[14.5px] font-bold">Показания нод</h2>
            <p className="m-0 mt-0.5 text-[12px] text-text-3">
              Безопасные пределы: процессор {CAPACITY_LIMIT_PCT.cpu} %, память {CAPACITY_LIMIT_PCT.mem} %,
              канал {CAPACITY_LIMIT_PCT.net} %, соединения {CAPACITY_LIMIT_PCT.conn} %.
            </p>
          </div>
        </div>
        {c.servers.length === 0 ? (
          <p className="m-0 px-4 py-10 text-center text-[12.5px] text-text-3">Серверов пока нет.</p>
        ) : (
          <>
            <ul
              className="m-0 grid list-none gap-3 p-3 sm:grid-cols-2 xl:hidden"
              aria-label="Ёмкость нод на узком экране"
            >
              {c.servers.map((s) => (
                <CapacityCard
                  key={s.serverId}
                  s={s}
                  onMeasure={() => setMeasure(s)}
                  onManual={() => setManual(s)}
                />
              ))}
            </ul>
            <div className="relative hidden w-full max-w-full overflow-x-auto xl:block">
              <table
                className="w-full min-w-[1050px] table-fixed border-collapse text-[12.5px]"
                aria-label="Ёмкость нод"
              >
                <thead>
                  <tr className="text-[10.5px] font-semibold tracking-[0.07em] text-text-3 uppercase">
                    <th className="px-4 py-2.5 text-left">
                      <span className="grid grid-cols-[minmax(190px,1.25fr)_64px_repeat(4,minmax(92px,.72fr))_minmax(210px,1.35fr)_34px] items-center gap-3">
                        <span>Нода</span>
                        <span className="text-right">В пик</span>
                        <span>Процессор</span>
                        <span>Память</span>
                        <span>Канал</span>
                        <span>Соединения</span>
                        <span>Вердикт</span>
                        <span className="sr-only">Действия</span>
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {c.servers.map((s) => (
                    <Row
                      key={s.serverId}
                      s={s}
                      onMeasure={() => setMeasure(s)}
                      onManual={() => setManual(s)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <details className="rounded-2xl border border-border bg-surface px-4 py-3 text-[12.5px] text-text-2">
        <summary className="cursor-pointer font-medium text-foreground">Как считается</summary>
        <div className="mt-2 flex flex-col gap-1.5 leading-relaxed">
          <p className="m-0">
            Берём {CAPACITY_WINDOW_DAYS} дней: онлайн ноды из Remnawave и в те же минуты нагрузку сервера.
            Считаем, сколько в среднем берёт один подключённый, — постоянный фон (сама система без людей)
            вычитаем.
          </p>
          <p className="m-0">
            Потолок — не 100 %: процессор {CAPACITY_LIMIT_PCT.cpu} %, память {CAPACITY_LIMIT_PCT.mem} %, канал{' '}
            {CAPACITY_LIMIT_PCT.net} %, соединения {CAPACITY_LIMIT_PCT.conn} % от предела ядра. «Ещё влезет» —
            по самому тесному из четырёх.
          </p>
          <p className="m-0">
            Канал: указанный вручную, иначе замер, иначе скорость сетевой карты — но только настоящей. У
            виртуальной карты скорость порта условная (хостер режет полосу снаружи), ей не верим — нужен
            замер.
          </p>
          <p className="m-0">Меньше 3 дней данных или меньше 30 человек в пик — «мало данных», числа нет.</p>
        </div>
      </details>

      <MeasureDialog server={measure} onClose={() => setMeasure(null)} />
      <ManualDialog server={manual} onClose={() => setManual(null)} />
    </div>
  );
}

function Banner({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2.5 rounded-2xl border border-warn/30 bg-warn-soft px-4 py-3 text-[12.5px]">
      <InfoIcon className="mt-0.5 size-4 flex-none text-warn" aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}

function nodeWord(value: number): string {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 14) return 'нод';
  const mod10 = value % 10;
  if (mod10 === 1) return 'нода';
  if (mod10 >= 2 && mod10 <= 4) return 'ноды';
  return 'нод';
}

function SummaryMetric({
  caps,
  value,
  sub,
  tone,
}: {
  caps: string;
  value: string;
  sub: ReactNode;
  tone?: 'crit' | undefined;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 border-border p-4 max-sm:border-t max-sm:first:border-t-0 sm:[&:nth-child(n+3)]:border-t sm:[&:nth-child(even)]:border-l xl:border-t-0 xl:border-l xl:first:border-l-0">
      <div className="text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase">{caps}</div>
      <div
        className={cn(
          'truncate font-heading text-[23px] leading-none font-bold tracking-[-0.02em] tabular-nums',
          tone === 'crit' && 'text-crit',
        )}
      >
        {value}
      </div>
      <div className="mt-auto pt-1 text-[12px] leading-snug text-text-2">{sub}</div>
    </div>
  );
}

function Meter({ cell, lim, tone }: { cell: CapacityCell; lim: boolean; tone: CapacityServer['tone'] }) {
  const u = cell.usedPct;
  const color =
    u == null ? '' : lim && tone === 'crit' ? 'bg-crit' : lim && tone === 'warn' ? 'bg-warn' : 'bg-brand';
  return (
    <div
      className="flex min-w-0 flex-col gap-1.5"
      title={[cell.detail, `безопасный предел ${cell.limitPct} %`].filter(Boolean).join(' · ')}
    >
      <div
        className={cn(
          'text-left text-[12px] tabular-nums',
          lim && tone === 'crit'
            ? 'font-bold text-crit'
            : lim && tone === 'warn'
              ? 'font-bold text-warn'
              : lim
                ? 'font-bold'
                : 'text-text-2',
        )}
      >
        {u == null ? '—' : `${u.toLocaleString('ru-RU', { maximumFractionDigits: 0 })} %`}
      </div>
      <div className="relative h-1 overflow-hidden rounded-full bg-surface-3">
        {u != null && (
          <i
            className={cn('absolute inset-y-0 left-0 rounded-full', color)}
            style={{ width: `${Math.min(100, u)}%` }}
          />
        )}
      </div>
    </div>
  );
}

const CELL_KEYS = ['cpu', 'mem', 'net', 'conn'] as const;

function CapacityActions({
  s,
  onMeasure,
  onManual,
  className,
}: {
  s: CapacityServer;
  onMeasure: () => void;
  onManual: () => void;
  className?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Действия: ${s.name}`}
          className={cn(
            'grid size-[30px] cursor-pointer place-items-center rounded-[9px] border border-border bg-surface-2 text-text-2 hover:text-foreground',
            className,
          )}
        >
          <MoreHorizontalIcon className="size-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[220px]">
        <DropdownMenuItem onSelect={onMeasure}>
          <GaugeIcon className="size-4" aria-hidden="true" />
          Замерить канал…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onManual}>
          <PencilIcon className="size-4" aria-hidden="true" />
          Указать канал вручную…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openServer(s.serverId)}>
          <ServerIcon className="size-4" aria-hidden="true" />
          Открыть окно сервера
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CapacityCard({
  s,
  onMeasure,
  onManual,
}: {
  s: CapacityServer;
  onMeasure: () => void;
  onManual: () => void;
}) {
  const role = s.role === 'exit' ? 'нода' : s.role === 'bridge' ? 'мост' : 'не нода';
  const linkNote =
    s.link.source === 'none'
      ? 'канал неизвестен'
      : `канал: ${{ manual: 'вручную', measured: 'замер', nic: 'сетевая карта' }[s.link.source]}`;
  return (
    <li className="min-w-0 rounded-[14px] border border-border bg-bg-2/45 p-3.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <button
          type="button"
          onClick={() => openServer(s.serverId)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left hover:underline"
        >
          <span className="min-w-0">
            <b className="block truncate text-[13.5px]">{s.name}</b>
            <span className="block truncate text-[11.5px] text-text-3">
              {role} · {linkNote} · в пик {s.onlinePeak == null ? '—' : nf(s.onlinePeak)}
            </span>
          </span>
          {s.country && <CountryFlag code={s.country} size="sm" decorative />}
        </button>
        <CapacityActions s={s} onMeasure={onMeasure} onManual={onManual} className="size-9 flex-none" />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-3 sm:grid-cols-4 xl:grid-cols-2">
        {CELL_KEYS.map((key) => (
          <div key={key} className="min-w-0">
            <div className="mb-1 text-[10.5px] text-text-3">{capital(CAPACITY_RESOURCE_LABELS[key])}</div>
            <Meter cell={s.cells[key]} lim={s.bottleneck === key} tone={s.tone} />
          </div>
        ))}
      </div>

      <div className="mt-3 border-t border-border pt-3">
        <Verdict server={s} />
      </div>
    </li>
  );
}

function Row({ s, onMeasure, onManual }: { s: CapacityServer; onMeasure: () => void; onManual: () => void }) {
  const role = s.role === 'exit' ? 'нода' : s.role === 'bridge' ? 'мост' : 'не нода';
  const linkNote =
    s.link.source === 'none'
      ? 'канал неизвестен'
      : `канал: ${{ manual: 'вручную', measured: 'замер', nic: 'сетевая карта' }[s.link.source]}`;
  return (
    <tr className="border-t border-border">
      <td className="px-4 py-3">
        <div className="grid grid-cols-[minmax(190px,1.25fr)_64px_repeat(4,minmax(92px,.72fr))_minmax(210px,1.35fr)_34px] items-center gap-3">
          <div className="min-w-0">
            <button
              type="button"
              onClick={() => openServer(s.serverId)}
              className="flex min-w-0 cursor-pointer items-center gap-2 text-left hover:underline"
            >
              {s.country && <CountryFlag code={s.country} size="sm" decorative />}
              <b className="truncate text-[13px]">{s.name}</b>
            </button>
            <div className="truncate text-[11.5px] text-text-3" title={s.note ?? undefined}>
              {role} · {linkNote}
            </div>
          </div>
          <div className="text-right tabular-nums">
            {s.onlinePeak == null ? <span className="text-text-3">—</span> : nf(s.onlinePeak)}
          </div>
          {CELL_KEYS.map((key) => (
            <Meter key={key} cell={s.cells[key]} lim={s.bottleneck === key} tone={s.tone} />
          ))}
          <Verdict server={s} />
          <CapacityActions s={s} onMeasure={onMeasure} onManual={onManual} />
        </div>
      </td>
    </tr>
  );
}

function Verdict({ server: s }: { server: CapacityServer }) {
  const resource = s.bottleneck ? CAPACITY_RESOURCE_LABELS[s.bottleneck] : null;
  const used = s.bottleneck ? s.cells[s.bottleneck].usedPct : null;
  const title =
    s.left == null
      ? STATUS_TEXT[s.status] || 'Недостаточно данных'
      : s.tone === 'crit'
        ? s.left <= 0
          ? 'Безопасный запас исчерпан'
          : `Осталось ≈ ${nf(s.left)}`
        : `Можно добавить ≈ ${nf(s.left)}`;
  const detail =
    resource && used != null
      ? `Первым ограничит: ${resource} ${Math.round(used)} %`
      : s.note || 'Вердикт появится после накопления данных.';
  return (
    <div
      title={s.note ?? undefined}
      className={cn(
        'min-w-0 border-l-2 pl-3',
        s.tone === 'crit'
          ? 'border-crit'
          : s.tone === 'warn'
            ? 'border-warn'
            : s.tone === 'ok'
              ? 'border-ok'
              : 'border-border-2',
      )}
    >
      <div
        className={cn(
          'truncate text-[12px] font-semibold',
          s.tone === 'crit'
            ? 'text-crit'
            : s.tone === 'warn'
              ? 'text-warn'
              : s.tone === 'ok'
                ? 'text-ok'
                : 'text-text-2',
        )}
      >
        {title}
      </div>
      <div className="mt-0.5 truncate text-[10.5px] text-text-3">{detail}</div>
    </div>
  );
}

function Shell({
  open,
  onClose,
  title,
  description,
  lock,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: ReactNode;
  lock?: boolean;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !lock && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="rounded-2xl border-border-2 bg-surface p-6 sm:max-w-[500px]"
      >
        <DialogHeader className="text-left">
          <DialogTitle className="font-heading text-[17px]">{title}</DialogTitle>
          <DialogDescription className="text-[12.5px] text-text-3">{description}</DialogDescription>
        </DialogHeader>
        <div className="mt-3 flex flex-col gap-3 text-[13px]">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

function MeasureDialog({ server, onClose }: { server: CapacityServer | null; onClose: () => void }) {
  const m = useMeasureLink();
  useEffect(() => {
    if (server) m.reset();
  }, [server, m.reset]);
  if (!server) return null;
  const res = m.data;
  return (
    <Shell
      open
      onClose={onClose}
      lock={m.isPending}
      title={`Замерить канал «${server.name}»`}
      description="С самого сервера: загрузка и отдача по 8 секунд через сервис скорости Cloudflare."
    >
      {!res ? (
        <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[12.5px] text-text-2">
          <li>Займёт около 20 секунд и до ≈ 2 ГБ трафика — на тарифах с оплатой за трафик учтите это.</li>
          <li>
            На время замера канал нагружен полностью — у пользователей может ненадолго просесть скорость.
            Лучше не в пик.
          </li>
          <li>К замеренной полосе панель прибавит то, что сервер уже отдавал в этот момент.</li>
        </ul>
      ) : (
        <p className="m-0 rounded-[11px] border border-ok/30 bg-ok-soft px-3.5 py-3 text-[12.5px]">
          <b>Готово:</b> загрузка {formatMbit(res.measuredDownMbit)}, отдача {formatMbit(res.measuredUpMbit)}.
          {res.source === 'manual'
            ? ' В расчёте по-прежнему значение, указанное вручную.'
            : ' Ёмкость пересчитана.'}
        </p>
      )}
      {m.isError && (
        <p className="m-0 rounded-[11px] border border-crit/30 bg-crit-soft px-3.5 py-3 text-[12.5px]">
          {apiErrorMessage(m.error)}
        </p>
      )}
      <DialogActions>
        {res ? (
          <DialogSecondaryButton onClick={onClose}>Закрыть</DialogSecondaryButton>
        ) : (
          <>
            <DialogSecondaryButton disabled={m.isPending} onClick={onClose}>
              Отмена
            </DialogSecondaryButton>
            <DialogPrimaryButton disabled={m.isPending} onClick={() => m.mutate(server.serverId)}>
              {m.isPending ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}
              {m.isPending ? 'Замеряю…' : 'Замерить'}
            </DialogPrimaryButton>
          </>
        )}
      </DialogActions>
    </Shell>
  );
}

function ManualDialog({ server, onClose }: { server: CapacityServer | null; onClose: () => void }) {
  const set = useSetManualLink();
  const [value, setValue] = useState('');
  useEffect(() => {
    if (server) setValue(server.link.manualMbit ? String(server.link.manualMbit) : '');
  }, [server]);
  if (!server) return null;
  const num = Number(value.replace(/\s/g, ''));
  const bad = value.trim() !== '' && (!Number.isInteger(num) || num < 10 || num > 400_000);
  const save = (manualMbit: number | null) =>
    set.mutate(
      { serverId: server.serverId, manualMbit },
      {
        onSuccess: () => {
          toast.success(
            manualMbit
              ? `Канал «${server.name}»: ${formatMbit(manualMbit)}.`
              : 'Канал снова считается автоматически.',
          );
          onClose();
        },
        onError: (e) => toast.error(apiErrorMessage(e)),
      },
    );
  const auto =
    server.link.measuredUpMbit != null
      ? `по замеру ${formatMbit(server.link.measuredUpMbit)}`
      : server.link.nicMbit && server.link.nicVirtual === false
        ? `по сетевой карте ${formatMbit(server.link.nicMbit)}`
        : 'неизвестен — лучше замерить';
  return (
    <Shell
      open
      onClose={onClose}
      lock={set.isPending}
      title={`Канал «${server.name}» вручную`}
      description="Необязательно. Если хостер обещает конкретную полосу — укажите её, она важнее замера."
    >
      <label htmlFor="cap-manual" className="text-[12.5px] font-semibold">
        Скорость канала, Мбит/с
      </label>
      <div className="flex items-center gap-2">
        <Input
          id="cap-manual"
          inputMode="numeric"
          placeholder="например, 1000"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-invalid={bad || undefined}
          className="h-10 w-[180px] rounded-[10px] bg-surface-2 font-mono"
        />
        <span className="text-[12px] text-text-3">1 Гбит = 1000, 10 Гбит = 10000</span>
      </div>
      <p className="m-0 text-[12px] text-text-3">
        {bad ? (
          <span className="text-crit">От 10 до 400 000 Мбит/с.</span>
        ) : (
          `Без значения канал берётся автоматически: ${auto}.`
        )}
      </p>
      <DialogActions>
        {server.link.manualMbit != null && (
          <DialogSecondaryButton disabled={set.isPending} onClick={() => save(null)}>
            Считать автоматически
          </DialogSecondaryButton>
        )}
        <DialogSecondaryButton disabled={set.isPending} onClick={onClose}>
          Отмена
        </DialogSecondaryButton>
        <DialogPrimaryButton disabled={set.isPending || bad || value.trim() === ''} onClick={() => save(num)}>
          Сохранить
        </DialogPrimaryButton>
      </DialogActions>
    </Shell>
  );
}
