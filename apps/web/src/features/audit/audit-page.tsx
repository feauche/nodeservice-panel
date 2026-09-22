import {
  AUDIT_CATEGORIES,
  AUDIT_CATEGORY_LABELS,
  AUDIT_RESULT_LABELS,
  AUDIT_RESULTS,
  AUDIT_SOURCE_LABELS,
  type AuditCategory,
  type AuditEntry,
  type AuditListResponse,
  type AuditResult,
  type AuditSource,
  type Server,
} from '@nodeservice/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  DownloadIcon,
  RadioIcon,
  SearchIcon,
  ServerIcon,
  XIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useServers } from '@/features/servers/servers-api';
import { apiErrorMessage } from '@/lib/api';
import { useMediaQuery } from '@/lib/use-media';
import { cn } from '@/lib/utils';
import { auditExportUrl, auditListQuery, useAuditList, useAuditStream } from './audit-api';
import { AuditRow } from './audit-row';
import {
  AUDIT_PERIOD_LABELS,
  AUDIT_PERIODS,
  type AuditSearch,
  hasFilters,
  matchesSearch,
  toFilter,
  toListQuery,
} from './audit-search';
import { Pagination } from './pagination';
import { useAdaptivePageSize } from './use-adaptive-page-size';

export interface AuditPageProps {
  search: AuditSearch;
  /** Частичное обновление URL-параметров; undefined — убрать параметр. */
  onSearch: (patch: Partial<AuditSearch>) => void;
}

const SEARCH_DEBOUNCE_MS = 300;

/** Страница «Журнал»: фильтры → таблица (новые сверху) → номерная пагинация; live и экспорт справа. */
export function AuditPage({ search, onSearch }: AuditPageProps) {
  const tableRef = useRef<HTMLDivElement>(null);
  const pageSize = useAdaptivePageSize(tableRef);
  const query = useMemo(() => toListQuery(search, pageSize), [search, pageSize]);
  const list = useAuditList(query);
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<number>>(new Set());
  const [missed, setMissed] = useState(0);
  const page = search.page ?? 1;
  const live = search.live !== false;
  // Колонки «Кто»/«Источник» есть только от xl, стрелка — от md: colSpan деталей должен совпадать,
  // иначе браузер дорисует пустые колонки и сожмёт «Событие».
  const xl = useMediaQuery('(min-width: 1280px)');
  const md = useMediaQuery('(min-width: 768px)');
  const cols = xl ? 6 : md ? 4 : 3;

  const streamStatus = useAuditStream(live, (entry: AuditEntry) => {
    if (!matchesSearch(entry, search)) return;
    if (page !== 1) {
      setMissed((n) => n + 1);
      return;
    }
    qc.setQueryData<AuditListResponse>(auditListQuery(query).queryKey, (old) => {
      if (!old || old.items.some((i) => i.seq === entry.seq)) return old;
      const total = old.total + 1;
      return {
        ...old,
        items: [entry, ...old.items].slice(0, old.pageSize),
        total,
        totalPages: Math.max(1, Math.ceil(total / old.pageSize)),
      };
    });
    setFresh((prev) => new Set(prev).add(entry.seq));
  });

  // Сброс «новых» и счётчика при смене страницы/фильтров.
  // biome-ignore lint/correctness/useExhaustiveDependencies: намеренно только по query
  useEffect(() => {
    setFresh(new Set());
    setMissed(0);
    setExpanded(null);
  }, [query]);

  const data = list.data;
  const filter = toFilter(search);
  const filtered = hasFilters(search);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <Toolbar
        search={search}
        onSearch={onSearch}
        live={live}
        streamStatus={streamStatus}
        exportFilter={filter}
      />

      {missed > 0 && (
        <button
          type="button"
          className="flex w-fit cursor-pointer items-center gap-2 rounded-[10px] bg-brand-soft px-3 py-1.5 text-[12.5px] font-medium text-brand hover:brightness-110"
          onClick={() => {
            onSearch({ page: undefined });
            void qc.invalidateQueries({ queryKey: ['audit', 'list'] });
          }}
        >
          <ArrowUpIcon className="size-3.5" />
          Новых записей: {missed} — к началу
        </button>
      )}

      <div
        ref={tableRef}
        className={cn(
          'overflow-hidden rounded-[12px] border border-border bg-surface',
          list.isFetching && !list.isPending && 'opacity-90',
        )}
        aria-busy={list.isFetching}
      >
        <table className="w-full table-fixed border-collapse">
          <thead>
            <tr className="h-10 border-b border-border text-left text-[11px] font-semibold tracking-[0.08em] text-text-3 uppercase">
              <th className="w-[128px] px-4 font-semibold max-md:w-[96px]">Время</th>
              <th className="px-3 font-semibold">Событие</th>
              <th className="w-[200px] px-3 font-semibold max-xl:hidden">Кто</th>
              <th className="w-[96px] px-3 font-semibold max-xl:hidden">Источник</th>
              <th className="w-[120px] px-3 font-semibold max-md:w-[44px]">
                <span className="max-md:sr-only">Результат</span>
              </th>
              <th className="w-10 max-md:hidden" />
            </tr>
          </thead>
          <tbody>
            {list.isPending &&
              Array.from({ length: Math.min(pageSize, 12) }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: скелет
                <tr key={i} className="h-11 border-t border-border first:border-t-0">
                  <td className="px-4">
                    <Skeleton className="h-3.5 w-16" />
                  </td>
                  <td className="px-3">
                    <Skeleton className="h-3.5 w-[60%]" />
                  </td>
                  <td className="px-3 max-xl:hidden">
                    <Skeleton className="h-3.5 w-20" />
                  </td>
                  <td className="px-3 max-xl:hidden">
                    <Skeleton className="h-3.5 w-12" />
                  </td>
                  <td className="px-3">
                    <Skeleton className="h-3.5 w-16" />
                  </td>
                  <td className="max-md:hidden" />
                </tr>
              ))}
            {list.isError && (
              <tr>
                <td colSpan={cols} className="px-4 py-10 text-center text-[13px] text-crit">
                  {apiErrorMessage(list.error)}{' '}
                  <button
                    type="button"
                    className="ml-2 cursor-pointer underline"
                    onClick={() => void list.refetch()}
                  >
                    Повторить
                  </button>
                </td>
              </tr>
            )}
            {data && data.items.length === 0 && (
              <tr>
                <td colSpan={cols} className="px-4 py-12 text-center text-[13px] text-text-3">
                  {filtered ? (
                    <>
                      По этим фильтрам записей нет.{' '}
                      <button
                        type="button"
                        className="cursor-pointer text-brand underline-offset-2 hover:underline"
                        onClick={() =>
                          onSearch({
                            q: undefined,
                            category: undefined,
                            result: undefined,
                            source: undefined,
                            period: undefined,
                            page: undefined,
                          })
                        }
                      >
                        Сбросить фильтры
                      </button>
                    </>
                  ) : (
                    'Журнал пока пуст — записи появятся после первых действий.'
                  )}
                </td>
              </tr>
            )}
            {data?.items.map((entry) => (
              <AuditRow
                key={entry.id}
                entry={entry}
                expanded={expanded === entry.id}
                colSpan={cols}
                fresh={fresh.has(entry.seq)}
                onToggle={() => setExpanded((cur) => (cur === entry.id ? null : entry.id))}
              />
            ))}
          </tbody>
        </table>
      </div>

      {data && data.total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-1">
          <p className="text-[12px] text-text-3 tabular-nums">
            {`${(data.page - 1) * data.pageSize + 1}–${Math.min(data.page * data.pageSize, data.total)} из ${data.total.toLocaleString('ru-RU')}`}
          </p>
          <Pagination
            page={data.page}
            totalPages={data.totalPages}
            onChange={(p) => onSearch({ page: p === 1 ? undefined : p })}
          />
        </div>
      )}
    </div>
  );
}

/* ---------- панель фильтров ---------- */

interface ToolbarProps {
  search: AuditSearch;
  onSearch: AuditPageProps['onSearch'];
  live: boolean;
  streamStatus: ReturnType<typeof useAuditStream>;
  exportFilter: ReturnType<typeof toFilter>;
}

/** Фильтр «только этот сервер» — приходит из окна сервера ссылкой, снимается крестиком. */
function ServerChip({ id, servers, onClear }: { id: string; servers: Server[]; onClear: () => void }) {
  const server = servers.find((s) => s.id === id);
  return (
    <span
      data-testid="audit-target-chip"
      className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-brand/40 bg-surface-2 pr-1.5 pl-3 text-[12.5px] font-medium"
    >
      <ServerIcon className="size-3.5 text-text-3" aria-hidden="true" />
      <span className="max-w-[220px] truncate">
        Сервер: {server?.name ?? (servers.length ? 'удалён' : '…')}
      </span>
      <button
        type="button"
        aria-label="Снять фильтр по серверу"
        onClick={onClear}
        className="grid size-6 cursor-pointer place-items-center rounded-[6px] text-text-3 hover:bg-surface-3 hover:text-foreground"
      >
        <XIcon className="size-3.5" aria-hidden="true" />
      </button>
    </span>
  );
}

function Toolbar({ search, onSearch, live, streamStatus, exportFilter }: ToolbarProps) {
  const servers = useServers();
  const [q, setQ] = useState(search.q ?? '');
  useEffect(() => setQ(search.q ?? ''), [search.q]);
  useEffect(() => {
    if ((search.q ?? '') === q.trim()) return;
    const t = setTimeout(() => onSearch({ q: q.trim() || undefined, page: undefined }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q, search.q, onSearch]);

  const toggleIn = <T extends string>(list: readonly T[] | undefined, value: T): T[] | undefined => {
    const next = list?.includes(value) ? list.filter((x) => x !== value) : [...(list ?? []), value];
    return next.length ? next : undefined;
  };

  const pill =
    'h-9 rounded-[10px] border-border bg-surface-2 px-3 text-[12.5px] font-medium text-text-2 hover:bg-surface-3 hover:text-foreground data-[active=true]:border-brand/40 data-[active=true]:text-foreground';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[220px] flex-1 basis-[260px]">
        <SearchIcon
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-3"
          aria-hidden="true"
        />
        <Input
          aria-label="Поиск по журналу"
          placeholder="Поиск: действие, логин, IP, id запроса…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="h-9 rounded-[10px] bg-surface-2 pr-8 pl-9 text-[13px]"
        />
        {q && (
          <button
            type="button"
            aria-label="Очистить поиск"
            className="absolute top-1/2 right-2 grid size-6 -translate-y-1/2 cursor-pointer place-items-center rounded-[6px] text-text-3 hover:bg-surface-3 hover:text-foreground"
            onClick={() => setQ('')}
          >
            <XIcon className="size-3.5" />
          </button>
        )}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className={pill} data-active={Boolean(search.category)}>
            Категория{search.category ? `: ${search.category.length}` : ''}
            <ChevronDownIcon className="size-3.5 opacity-70" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[180px]">
          <DropdownMenuLabel>Категория</DropdownMenuLabel>
          {AUDIT_CATEGORIES.map((c: AuditCategory) => (
            <DropdownMenuCheckboxItem
              key={c}
              checked={search.category?.includes(c) ?? false}
              onCheckedChange={() => onSearch({ category: toggleIn(search.category, c), page: undefined })}
              onSelect={(e) => e.preventDefault()}
            >
              {AUDIT_CATEGORY_LABELS[c]}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className={pill} data-active={Boolean(search.result)}>
            Результат{search.result ? `: ${search.result.length}` : ''}
            <ChevronDownIcon className="size-3.5 opacity-70" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[160px]">
          <DropdownMenuLabel>Результат</DropdownMenuLabel>
          {AUDIT_RESULTS.map((r: AuditResult) => (
            <DropdownMenuCheckboxItem
              key={r}
              checked={search.result?.includes(r) ?? false}
              onCheckedChange={() => onSearch({ result: toggleIn(search.result, r), page: undefined })}
              onSelect={(e) => e.preventDefault()}
            >
              {AUDIT_RESULT_LABELS[r]}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <fieldset className="m-0 min-w-0 flex h-9 items-center rounded-[10px] border border-border bg-surface-2 p-[3px]">
        <legend className="sr-only">Источник</legend>
        {([undefined, 'manual', 'auto'] as const).map((s) => (
          <button
            key={s ?? 'all'}
            type="button"
            aria-pressed={search.source === s}
            className={cn(
              'h-full cursor-pointer rounded-[7px] px-2.5 text-[12px] font-medium text-text-3 transition-colors hover:text-foreground',
              search.source === s && 'bg-surface text-foreground shadow-[0_1px_0_var(--ns-hairline)]',
            )}
            onClick={() => onSearch({ source: s as AuditSource | undefined, page: undefined })}
          >
            {s ? AUDIT_SOURCE_LABELS[s] : 'все'}
          </button>
        ))}
      </fieldset>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className={pill}
            data-active={Boolean(search.period && search.period !== 'all')}
          >
            {AUDIT_PERIOD_LABELS[search.period ?? 'all']}
            <ChevronDownIcon className="size-3.5 opacity-70" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[150px]">
          <DropdownMenuRadioGroup
            value={search.period ?? 'all'}
            onValueChange={(v) =>
              onSearch({ period: v === 'all' ? undefined : (v as AuditSearch['period']), page: undefined })
            }
          >
            {AUDIT_PERIODS.map((p) => (
              <DropdownMenuRadioItem key={p} value={p}>
                {AUDIT_PERIOD_LABELS[p]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {search.target && (
        <ServerChip
          id={search.target}
          servers={servers.data?.items ?? []}
          onClear={() => onSearch({ target: undefined, page: undefined })}
        />
      )}

      {hasFilters(search) && (
        <button
          type="button"
          className="h-9 cursor-pointer rounded-[10px] px-2.5 text-[12.5px] text-text-3 hover:text-foreground"
          onClick={() =>
            onSearch({
              q: undefined,
              category: undefined,
              result: undefined,
              source: undefined,
              period: undefined,
              target: undefined,
              page: undefined,
            })
          }
        >
          Сбросить
        </button>
      )}

      <div className="ml-auto flex items-center gap-2">
        <Button
          variant="outline"
          aria-pressed={live}
          title="Показывать новые записи сразу, без обновления страницы"
          className={cn(pill, live && 'border-ok/40 text-foreground')}
          onClick={() => onSearch({ live: live ? false : undefined })}
        >
          <span
            className={cn(
              'size-2 rounded-full',
              !live && 'bg-text-3',
              live && streamStatus === 'live' && 'bg-ok shadow-[0_0_0_3px_var(--ns-ok-soft)]',
              live && streamStatus !== 'live' && 'bg-warn',
            )}
            aria-hidden="true"
          />
          {live
            ? streamStatus === 'live'
              ? 'Live'
              : streamStatus === 'connecting'
                ? 'Подключаюсь…'
                : 'Переподключаюсь…'
            : 'Live: выкл'}
          <RadioIcon className="size-3.5 opacity-60" />
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className={pill}>
              <DownloadIcon className="size-3.5" />
              Экспорт
              <ChevronDownIcon className="size-3.5 opacity-70" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[200px]">
            <DropdownMenuLabel>По текущим фильтрам</DropdownMenuLabel>
            <DropdownMenuItem asChild>
              <a href={auditExportUrl(exportFilter, 'csv')} download>
                CSV — для Excel / Sheets
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href={auditExportUrl(exportFilter, 'json')} download>
                JSON — для скриптов
              </a>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <p className="px-2 py-1 text-[11px] text-text-3">
              До 100 000 записей за раз. Больше — сузь период.
            </p>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <span className="sr-only">
        <CheckIcon className="size-3" />
      </span>
    </div>
  );
}
