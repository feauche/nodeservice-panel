import type { Incident, IncidentStatus } from '@nodeservice/shared';
import { Link } from '@tanstack/react-router';
import { ChevronRightIcon, Trash2Icon, WrenchIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { Pagination } from '@/components/pagination';
import { Skeleton } from '@/components/ui/skeleton';
import { Pill } from '@/features/settings/settings-ui';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { useAvailableHeight } from '@/lib/use-available-height';
import { useMediaQuery } from '@/lib/use-media';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';
import {
  closedAtMs,
  dayLabel,
  durationText,
  hhmm,
  humanSeconds,
  listSubtitle,
  titleOnly,
  type WeekStats,
} from './incident-format';
import {
  type IncidentsFilter,
  useDeleteResolvedIncidents,
  useIncidents,
  useIncidentWeekStats,
} from './incidents-api';
import {
  BOTTOM_GAP,
  FOOTER_HEIGHT,
  fitRows,
  type ListView,
  paging,
  requestSize,
  requestWindow,
  visibleCount,
} from './incidents-fit';
import { LevelChip } from './level-chip';

const FILTERS: ReadonlyArray<{ key: IncidentsFilter; label: string }> = [
  { key: 'all', label: 'Все' },
  { key: 'open', label: 'Открытые' },
  { key: 'resolved', label: 'Решённые' },
];
const STATUS_PILL: Record<IncidentStatus, { tone: 'ok' | 'warn' | 'crit' | 'muted'; label: string }> = {
  open: { tone: 'crit', label: 'Открыт' },
  acknowledged: { tone: 'warn', label: 'В работе' },
  resolved: { tone: 'ok', label: 'Решён' },
};
/** День закрытия инцидента — по нему решённые собираются в группы. */
const dayOf = (inc: Incident, now: number): string => dayLabel(inc.resolvedAt ?? inc.openedAt, now);

/**
 * Решённые по дням. `cut` — на каких краях страницы список продолжается: у крайних дней число сбоев тогда
 * относится только к этой странице (остальные сбои того же дня — на соседней), и итогом дня его не называем.
 */
const dayGroups = (
  items: Incident[],
  now: number,
  cut: { before: boolean; after: boolean } = { before: false, after: false },
): Array<{ key: string; label: string; note?: string; items: Incident[] }> => {
  // Недавно закрытый — сверху; день группы — день закрытия, а не открытия.
  const sorted = [...items].sort((a, b) => closedAtMs(b) - closedAtMs(a));
  const byDay = new Map<string, Incident[]>();
  for (const inc of sorted) {
    const label = dayOf(inc, now);
    byDay.set(label, [...(byDay.get(label) ?? []), inc]);
  }
  const days = [...byDay];
  return days.map(([label, list], i) => {
    const auto = list.filter((x) => x.attempts.some((a) => a.status === 'helped' && a.by === 'auto')).length;
    const n = list.length;
    const word = n === 1 ? 'сбой' : n < 5 ? 'сбоя' : 'сбоев';
    const partial = (i === 0 && cut.before) || (i === days.length - 1 && cut.after);
    return {
      key: label,
      label,
      note: partial
        ? `${n} ${word} на этой странице`
        : auto === n
          ? `${n} ${word} · все починила панель`
          : `${n} ${word}`,
      items: list,
    };
  });
};

/** Цвет полоски слева: итог инцидента одним взглядом. */
function barTone(inc: Incident): string {
  if (inc.status !== 'resolved') return inc.severity === 'crit' ? 'bg-crit' : 'bg-warn';
  const helped = inc.attempts.some((a) => a.status === 'helped');
  if (helped || inc.resolvedBy === 'auto') return 'bg-ok';
  return 'bg-border-2';
}

/**
 * «Инциденты» (витрина v3, A1): полоса итога за 7 дней и реестр по дням — время, сервер, что случилось
 * и чем кончилось одним предложением, статус, длительность. Строка ведёт на страницу-кейс.
 * На широком экране реестр занимает высоту окна: решённых на странице столько, сколько помещается, а поле
 * под ним — как боковые (см. incidents-fit.ts).
 */
export function IncidentsPage() {
  const [filter, setFilter] = useState<IncidentsFilter>('all');
  // Что показано из решённых: с какой строки страница начинается (или перед какой кончается — когда листаем
  // назад). Хранится строка, а не номер страницы: страницы разной длины (сколько помещается по высоте), и
  // при изменении окна или числа открытых на экране должны остаться те же инциденты.
  const [view, setView] = useState<ListView>({ mode: 'start', row: 0 });
  // Вкладка и страница меняются одним действием: сброс эффектом успевал отправить запрос по старой странице.
  const pickFilter = (next: IncidentsFilter) => {
    setFilter(next);
    setView({ mode: 'start', row: 0 });
  };

  // Открытых обычно мало — держим целиком, без пагинации: «Сейчас» видно сразу на любой вкладке, кроме
  // «Решённые». Решённые (основная масса истории) листаются.
  const needsOpen = filter !== 'resolved';
  const needsResolved = filter !== 'open';
  const open = useIncidents('open');
  const openItems = open.data?.items ?? [];
  const openRows = needsOpen ? openItems.length : 0;

  // Высота от верха реестра до нижнего поля. Меряем с постоянным запасом: место под строку страниц вычитаем
  // при расчёте — иначе при смене вкладки первый кадр считался бы по высоте прежней. На телефоне строки
  // разной высоты и страница листается — там обычное листание по десять.
  const wide = useMediaQuery('(min-width: 768px)', false);
  const listRef = useRef<HTMLDivElement>(null);
  const measured = useAvailableHeight(listRef, BOTTOM_GAP);
  const height = wide && measured ? measured : null;
  const roomFor = (footer: boolean) => (height === null ? null : height - (footer ? FOOTER_HEIGHT : 0));
  // Запрашиваем с запасом — сколько поместилось бы сжатыми строками при одном дне; покажем, сколько влезет.
  const size = requestSize(roomFor(true), openRows);
  const win = requestWindow(view, size);
  const resolvedPaged = useIncidents('resolved', {
    offset: win.offset,
    pageSize: win.limit,
    // Размер запроса зависит от высоты окна и числа открытых — ждём и то и другое, чтобы не запрашивать дважды.
    enabled: needsResolved && measured !== undefined && (!needsOpen || !open.isPending),
  });
  // На экране ещё прежняя страница (листание, смена размера): её строки — не те, что запрошены. На вкладке
  // «Открытые» решённые не запрашиваются вовсе — там ждать нечего.
  const stale = needsResolved && resolvedPaged.isPlaceholderData;
  // Полоса «за 7 дней» — готовые цифры с сервера, не зависит от вкладки и страницы и не держит реестр.
  const weekly = useIncidentWeekStats();

  const now = useNow(openItems.length > 0, 1000);
  const deleteResolved = useDeleteResolvedIncidents();
  const [confirmClear, setConfirmClear] = useState(false);

  const openCount = openItems.length;
  const pending = (needsOpen && open.isPending) || (needsResolved && resolvedPaged.isPending);
  const failed = open.isError ? open.error : resolvedPaged.isError ? resolvedPaged.error : null;
  const total = needsResolved && !pending && !failed ? (resolvedPaged.data?.total ?? 0) : 0;
  // Строка страниц есть, только когда решённые есть: без неё реестр получает и её место.
  const footer = total > 0;
  const available = roomFor(footer);

  // Какие решённые показать: из полученного окна — столько, сколько помещается по высоте. Листаем вперёд —
  // первые строки, назад — последние (страница кончается там, где начиналась следующая).
  const items = resolvedPaged.data?.items;
  const fresh = useMemo(() => {
    if (!needsResolved || stale || !items) return null;
    // Назад: в окно могли попасть строки за концом страницы (сервер отдаёт не меньше пяти) — их отбрасываем.
    const usable = view.mode === 'end' ? items.slice(0, Math.max(0, view.row - win.offset)) : items;
    const k = visibleCount(
      available,
      openRows,
      usable.map((i) => dayOf(i, now)),
      view.mode,
    );
    const rows = view.mode === 'start' ? usable.slice(0, k) : usable.slice(usable.length - k);
    const start = view.mode === 'start' ? win.offset : win.offset + usable.length - k;
    return { rows, start };
  }, [needsResolved, stale, items, view, win.offset, available, openRows, now]);
  // Пока новая страница не пришла, на экране остаётся прежняя — как была, только приглушённая.
  const last = useRef<{ rows: Incident[]; start: number } | null>(null);
  if (fresh) last.current = fresh;
  const shown = fresh ?? (needsResolved ? last.current : null);
  const resolvedRows = shown?.rows ?? [];
  const start = shown?.start ?? 0;

  // Строка за концом списка (решённых убавилось) — показываем конец. Листали назад и дошли до самого
  // начала — показываем начало полной страницей, а не короткий остаток.
  const settled = fresh !== null && !resolvedPaged.isFetching;
  useEffect(() => {
    if (!settled || total === 0) return;
    if (resolvedRows.length === 0) setView({ mode: 'end', row: total });
    else if (view.mode === 'end' && start === 0) setView({ mode: 'start', row: 0 });
  }, [settled, total, resolvedRows.length, view.mode, start]);

  const showOpen = needsOpen && openItems.length > 0;
  const showResolved = needsResolved && resolvedRows.length > 0;
  const groups = useMemo(() => {
    const out: Array<{ key: string; label: string; note?: string; items: Incident[] }> = [];
    if (showOpen) out.push({ key: 'now', label: 'Сейчас', items: openItems });
    if (showResolved)
      out.push(
        ...dayGroups(resolvedRows, now, { before: start > 0, after: start + resolvedRows.length < total }),
      );
    return out;
  }, [showOpen, openItems, showResolved, resolvedRows, now, start, total]);
  // Высота каждой строки, при которой реестр кончается ровно у нижнего поля; null — обычная высота.
  // Страница полная, если решённые на ней не кончаются: дальше (или раньше, когда листали назад) есть ещё.
  const rowCount = groups.reduce((n, g) => n + g.items.length, 0);
  const full = showResolved && (view.mode === 'start' ? start + resolvedRows.length < total : start > 0);
  const heights = useMemo(
    () => fitRows(available, groups.length, rowCount, full),
    [available, groups.length, rowCount, full],
  );
  // Номер первой строки каждой группы в общем счёте — по нему берётся высота строки.
  const groupStart = groups.map((_, i) => groups.slice(0, i).reduce((n, g) => n + g.items.length, 0));

  // Номера страниц. Пока показана прежняя страница, считаем от запрошенной строки: иначе «Следующая»
  // считалась бы от устаревшего места и быстрые нажатия терялись бы. Длина ещё не пришедшей страницы
  // неизвестна — берём длину показанной.
  const per = Math.max(1, resolvedRows.length || size);
  const at = stale
    ? { start: view.mode === 'start' ? view.row : Math.max(0, view.row - per), shown: per }
    : { start, shown: resolvedRows.length };
  const pages = paging(at.start, Math.min(at.shown, Math.max(0, total - at.start)), total, size);

  return (
    // Нижнее поле страницы (60px у оболочки) на широком экране сводим к боковому — 26px.
    <div className="flex flex-col gap-4 md:-mb-[34px]">
      <div className="flex flex-wrap items-center gap-2">
        <fieldset className="m-0 flex h-9 w-fit items-center rounded-[10px] border border-border bg-surface p-[3px]">
          <legend className="sr-only">Фильтр инцидентов</legend>
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => pickFilter(f.key)}
              className={cn(
                'flex h-full cursor-pointer items-center gap-1.5 rounded-[7px] px-3.5 text-[12.5px] font-medium text-text-3 transition-colors hover:text-foreground',
                filter === f.key && 'bg-surface-3 text-foreground',
              )}
            >
              {f.label}
              {f.key === 'open' && openCount > 0 && (
                <span className="inline-flex min-w-[16px] justify-center rounded-full bg-crit px-1 text-[10.5px] font-bold text-white tabular-nums">
                  {openCount}
                </span>
              )}
            </button>
          ))}
        </fieldset>
        <span className="flex-1" />
        {filter === 'resolved' && total > 0 && (
          <button
            type="button"
            disabled={deleteResolved.isPending}
            onClick={() => setConfirmClear(true)}
            className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[10px] border border-border bg-surface px-3.5 text-[12.5px] font-medium text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground disabled:opacity-50"
          >
            <Trash2Icon className="size-3.5" aria-hidden="true" />
            Удалить решённые
          </button>
        )}
        <Link
          to="/incidents/autofix"
          className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-border bg-surface px-3.5 text-[12.5px] font-medium text-text-2 transition-colors hover:bg-surface-3 hover:text-foreground"
        >
          <WrenchIcon className="size-3.5" aria-hidden="true" />
          Автопочинка
        </Link>
      </div>

      {/* Заглушка той же высоты, что и полоса в одну строку: реестр под ней не прыгает после загрузки. */}
      {weekly.data ? <StatsStrip stats={weekly.data} /> : <Skeleton className="h-[64px] rounded-2xl" />}

      {/* Верх этого блока — точка отсчёта высоты реестра: он есть при загрузке, ошибке и пустом списке. */}
      <div ref={listRef}>
        {pending ? (
          <Skeleton className="rounded-2xl" style={{ height: roomFor(needsResolved) ?? 320 }} />
        ) : failed ? (
          <p
            role="alert"
            className="rounded-[12px] border border-crit/30 bg-crit-soft px-4 py-3 text-[13px] text-crit"
          >
            {apiErrorMessage(failed)}
          </p>
        ) : !showOpen && !showResolved ? (
          <div className="grid place-items-center rounded-2xl border border-dashed border-border-2 px-6 py-16 text-center">
            <div className="text-[14px] font-semibold">Пока спокойно</div>
            <div className="mt-1 text-[12.5px] text-text-3">
              {filter === 'resolved'
                ? 'Решённых инцидентов нет.'
                : 'Сбоев не зафиксировано. Как только что-то случится, оно появится здесь.'}
            </div>
          </div>
        ) : (
          <div
            data-testid="incidents-list"
            aria-busy={stale}
            className={cn(
              'overflow-hidden rounded-2xl border border-border bg-surface transition-opacity',
              stale && 'opacity-60',
            )}
          >
            {groups.map((g, gi) => (
              <section key={g.key} aria-label={g.label}>
                <h2 className="flex items-baseline gap-2.5 border-t border-border px-4 pt-2.5 pb-1.5 text-[12px] text-text-3 first:border-t-0 md:h-9">
                  <span className="text-[12.5px] font-semibold text-text-2">{g.label}</span>
                  {g.note && <span>{g.note}</span>}
                </h2>
                {g.items.map((inc, i) => (
                  <IncidentRow
                    key={inc.id}
                    inc={inc}
                    now={now}
                    height={heights?.[(groupStart[gi] ?? 0) + i]}
                  />
                ))}
              </section>
            ))}
          </div>
        )}
      </div>

      {footer && (
        // В одну строку при любой ширине: перенос сделал бы строку выше заложенного места, и страница
        // начала бы прокручиваться. Не помещается — подпись слева сокращается.
        <div data-testid="incidents-footer" className="flex min-h-8 items-center justify-between gap-3 px-1">
          <p className="min-w-0 truncate text-[12px] text-text-3 tabular-nums">
            {filter === 'all' ? 'Решённых: ' : ''}
            {`${at.start + 1}–${Math.min(at.start + at.shown, total)} из ${total.toLocaleString('ru-RU')}`}
          </p>
          <div className="flex-none">
            <Pagination
              page={pages.page}
              totalPages={pages.totalPages}
              onChange={(next) => setView(pages.go(next))}
              label="Страницы решённых инцидентов"
            />
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        kind="crit"
        title="Удалить все решённые инциденты?"
        description="История починок по ним пропадёт, статистика «помогло N из M» пересчитается. Открытые инциденты останутся. Записи Журнала не трогаем."
        yesLabel="Удалить"
        loading={deleteResolved.isPending}
        onConfirm={async () => {
          try {
            const { deleted } = await deleteResolved.mutateAsync();
            // Удалённые не должны остаться на экране «прежней страницей», пока список перечитывается.
            last.current = null;
            setView({ mode: 'start', row: 0 });
            setConfirmClear(false);
            toast.success(deleted > 0 ? `Удалено инцидентов: ${deleted}.` : 'Решённых инцидентов не было.');
          } catch (err) {
            setConfirmClear(false);
            toast.error(apiErrorMessage(err));
          }
        }}
      />
    </div>
  );
}

/** Полоса итога за 7 дней: числа словами, без KPI-плиток. */
function StatsStrip({ stats }: { stats: WeekStats }) {
  const resolved = stats.auto + stats.waited + stats.self + stats.manual;
  const pct = (n: number) => (resolved > 0 ? `${(n / resolved) * 100}%` : '0%');
  return (
    <div
      data-testid="incidents-stats"
      className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl border border-border bg-surface px-4 py-3"
    >
      <Stat n={stats.total} label="сбоев за 7 дней" />
      <span className="hidden h-7 w-px bg-border sm:block" aria-hidden="true" />
      <Stat n={stats.auto} label="починила панель" cls="text-ok" />
      <Stat n={stats.waited} label="по вашей команде" cls="text-warn" />
      <Stat n={stats.self} label="прошли сами" cls="text-brand" />
      <Stat n={stats.manual} label="закрыты вручную" />
      {stats.open > 0 && <Stat n={stats.open} label="открыто сейчас" cls="text-crit" />}
      <div className="flex min-w-[120px] flex-1 items-center gap-3">
        <div className="flex h-2 flex-1 overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
          <span className="h-full bg-ok" style={{ width: pct(stats.auto) }} />
          <span className="h-full bg-warn" style={{ width: pct(stats.waited) }} />
          <span className="h-full bg-brand" style={{ width: pct(stats.self) }} />
          <span className="h-full bg-border-2" style={{ width: pct(stats.manual) }} />
        </div>
        {stats.medianFixS !== null && (
          <span className="text-[12px] whitespace-nowrap text-text-3">
            Типичное время починки {humanSeconds(stats.medianFixS)}
          </span>
        )}
      </div>
    </div>
  );
}

function Stat({ n, label, cls }: { n: number; label: string; cls?: string }) {
  return (
    <div className="flex flex-col leading-tight">
      <b className={cn('font-heading text-[19px] font-bold tracking-[-0.02em] tabular-nums', cls)}>{n}</b>
      <span className="text-[11.5px] text-text-3">{label}</span>
    </div>
  );
}

/** `height` — высота строки, подогнанная под окно (см. incidents-fit.ts); нет — обычная. */
function IncidentRow({ inc, now, height }: { inc: Incident; now: number; height?: number | undefined }) {
  const status = STATUS_PILL[inc.status];
  const level =
    inc.attempts.find((a) => a.status === 'running')?.level ??
    inc.proposal?.level ??
    inc.attempts.at(-1)?.level;
  return (
    <Link
      to="/incidents/$id"
      params={{ id: inc.id }}
      data-testid="incident-row"
      style={height ? { minHeight: height } : undefined}
      className="grid grid-cols-[3px_52px_minmax(0,1fr)_auto] items-center gap-x-3 border-t border-border py-2.5 pr-3 transition-colors hover:bg-surface-2 md:min-h-[59px] md:grid-cols-[3px_56px_170px_minmax(0,1fr)_auto_84px] md:gap-x-4 md:py-1.5"
    >
      <span className={cn('h-full min-h-9 w-[3px] rounded-r-[2px]', barTone(inc))} aria-hidden="true" />
      <span
        className="text-[12.5px] text-text-3 tabular-nums"
        title={`Открыт ${hhmm(inc.openedAt)}${inc.resolvedAt ? ` · закрыт ${hhmm(inc.resolvedAt)}` : ''}`}
      >
        {hhmm(inc.resolvedAt ?? inc.openedAt)}
      </span>
      <span className="hidden truncate text-[13px] font-semibold md:block">{inc.serverName}</span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold max-md:line-clamp-2 md:truncate">
          {titleOnly(inc)}
        </span>
        <span className="block text-[12.5px] text-text-3 md:hidden">{inc.serverName}</span>
        <span className="block text-[12.5px] text-text-2 max-md:line-clamp-2 md:truncate">
          {listSubtitle(inc, now)}
        </span>
      </span>
      <span className="flex items-center gap-1.5 max-md:self-start">
        <Pill tone={status.tone}>{status.label}</Pill>
        {level && <LevelChip level={level} />}
        <ChevronRightIcon className="size-4 text-text-3 md:hidden" aria-hidden="true" />
      </span>
      <span className="hidden text-right text-[12.5px] text-text-3 tabular-nums md:block">
        {durationText(inc, now)}
      </span>
    </Link>
  );
}
