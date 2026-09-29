import {
  closestCenter,
  DndContext,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  type Modifier,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import {
  countryName,
  normalizeTag,
  type Server,
  type ServersResponse,
  similarTag,
  tagCounts,
} from '@nodeservice/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  ChevronDownIcon,
  GlobeIcon,
  LayoutGridIcon,
  ListIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  ServerIcon,
  TagIcon,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CountryFlag } from '@/components/country-flag';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useOverviewMetrics } from '@/features/overview/overview-api';
import { apiErrorMessage } from '@/lib/api';
import { toast } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { AddServerDialog } from './add-server-dialog';
import { ServerCard, ServerCardGhost } from './server-card';
import { HEALTH_LABELS, type ServerHealth, serverHealth } from './server-health';
import { ServerList, useServersView } from './server-list';
import { openServer } from './server-modal-store';
import { serversKeys, useCheckAllServers, useReorderServers, useServers } from './servers-api';
import { TagsManageDialog } from './tags-manage-dialog';

export interface ServersPageProps {
  /** Фильтр по тегу из URL (?tag=prod) — ссылку можно переслать. */
  tag?: string | undefined;
  onTag: (tag: string | undefined) => void;
}

/** Значение фильтра стран для серверов без страны. */
const NO_COUNTRY = '__none';

type HealthFilter = 'all' | ServerHealth;
const HEALTH_FILTERS: Array<{ key: HealthFilter; label: string }> = [
  { key: 'all', label: 'Все' },
  { key: 'ok', label: HEALTH_LABELS.ok },
  { key: 'warn', label: 'Внимание' },
  { key: 'crit', label: HEALTH_LABELS.crit },
];

export function ServersPage({ tag, onTag }: ServersPageProps) {
  const servers = useServers();
  const overview = useOverviewMetrics();
  const [q, setQ] = useState('');
  const [health, setHealth] = useState<HealthFilter>('all');
  /** Выбранные страны фильтра (коды) и особое значение «без страны». */
  const [countries, setCountries] = useState<string[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [view, setView] = useServersView();
  const [checkAllOpen, setCheckAllOpen] = useState(false);
  const checkAll = useCheckAllServers();
  const reorder = useReorderServers();
  const qc = useQueryClient();
  // Клик, которым закончилось перетаскивание, не должен открывать настройки карточки.
  const dragging = useRef(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  /** Порядок на время перетаскивания: слоты раздвигаются в onDragOver, и призрак «долетает» в новый. */
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  /** Невидимая стена сверху: не выше начала сетки (чуть ниже поиска); вбок и вниз — свободно. */
  const restrictAboveGrid: Modifier = ({ transform, draggingNodeRect }) => {
    const grid = gridRef.current?.getBoundingClientRect();
    if (!grid || !draggingNodeRect) return transform;
    return { ...transform, y: Math.max(transform.y, grid.top - draggingNodeRect.top) };
  };
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const items = servers.data?.items ?? [];
  const visual = dragOrder
    ? (dragOrder.map((id) => items.find((s) => s.id === id)).filter(Boolean) as Server[])
    : items;
  const tagCountMap = useMemo(() => tagCounts(items), [items]);
  const allTags = useMemo(
    () =>
      Object.keys(tagCountMap).sort(
        (a, b) => (tagCountMap[b] ?? 0) - (tagCountMap[a] ?? 0) || a.localeCompare(b),
      ),
    [tagCountMap],
  );
  /** Выбранные теги — в адресе через запятую (?tag=node,exit): ссылку можно переслать. */
  const selectedTags = useMemo(() => (tag ? tag.split(',').filter(Boolean) : []), [tag]);
  const setSelectedTags = (next: string[]) => onTag(next.length ? next.join(',') : undefined);
  const [tagQuery, setTagQuery] = useState('');
  const [manageTags, setManageTags] = useState(false);
  /** Страны, которые есть у серверов, с числом серверов; фильтр не показывается, пока стран нет ни у одного. */
  const countryStats = useMemo(() => {
    const byCode = new Map<string, number>();
    let without = 0;
    for (const s of items) {
      if (s.country.code) byCode.set(s.country.code, (byCode.get(s.country.code) ?? 0) + 1);
      else without += 1;
    }
    const list = [...byCode.entries()]
      .map(([code, n]) => ({ code, n, name: countryName(code) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    return { list, without };
  }, [items]);
  const metricsById = useMemo(
    () => new Map((overview.data?.servers ?? []).map((m) => [m.serverId, m])),
    [overview.data],
  );
  const healthOf = (s: Server) => serverHealth(s, metricsById.get(s.id));
  const counts = useMemo(() => {
    const c: Record<HealthFilter, number> = { all: items.length, ok: 0, warn: 0, crit: 0 };
    for (const s of items) c[serverHealth(s, metricsById.get(s.id))] += 1;
    return c;
  }, [items, metricsById]);
  const filtered = visual.filter((s) => {
    if (health !== 'all' && healthOf(s) !== health) return false;
    if (selectedTags.length > 0 && !selectedTags.every((t) => s.tags.includes(t))) return false;
    if (countries.length > 0 && !countries.includes(s.country.code ?? NO_COUNTRY)) return false;
    if (q) {
      const needle = q.toLowerCase();
      const hay = [s.name, s.host, s.facts.hostname ?? '', ...s.tags].join(' ').toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  const doCheckAll = async () => {
    setCheckAllOpen(false);
    const res = await checkAll.mutateAsync(items.map((s) => s.id));
    if (res.failed === 0) toast.success(`Проверено серверов: ${res.ok}. Все на связи.`);
    else
      toast.warning(
        `Проверено серверов: ${res.ok + res.failed}. Не ответили: ${res.failed} — подробности на карточках.`,
      );
  };

  const onDragStart = (e: DragStartEvent) => {
    dragging.current = true;
    setActiveId(String(e.active.id));
  };
  const onDragOver = (e: DragOverEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const base = dragOrder ?? items.map((s) => s.id);
    const from = base.indexOf(String(e.active.id));
    const to = base.indexOf(String(e.over.id));
    if (from < 0 || to < 0 || from === to) return;
    setDragOrder(arrayMove(base, from, to));
  };
  const onDragEnd = () => {
    setActiveId(null);
    setTimeout(() => {
      dragging.current = false;
    }, 80);
    if (dragOrder) {
      const original = items.map((s) => s.id);
      if (dragOrder.some((id, i) => original[i] !== id)) {
        // Кэш — синхронно, ДО сброса dragOrder: onMutate у mutate сработает микротаском позже,
        // и без этого на один кадр вернулся бы старый порядок — анимация «долёта» целилась бы в прежний слот.
        const byId = new Map(items.map((s) => [s.id, s]));
        qc.setQueryData<ServersResponse>(serversKeys.list, {
          items: dragOrder.map((id) => byId.get(id)).filter((s): s is Server => Boolean(s)),
        });
        reorder.mutate(dragOrder);
      }
    }
    setDragOrder(null);
  };
  const onDragCancel = () => {
    setActiveId(null);
    setDragOrder(null);
    setTimeout(() => {
      dragging.current = false;
    }, 80);
  };
  /** Клик, которым закончилось перетаскивание, не должен открывать модалку сервера. */
  const openDetail = (server: Server) => {
    if (dragging.current) return;
    openServer(server.id, 'metrics');
  };
  const openEdit = (server: Server) => {
    if (dragging.current) return;
    openServer(server.id, 'connection');
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Тулбар: фильтр по состоянию · поиск на всю свободную ширину · теги · проверить все · добавить */}
      {/* На средней ширине (планшет, узкое окно) сегменты уходят на свою строку целиком,
          а не роняют кнопку «Добавить» вниз в одиночестве. */}
      <div className="@container flex flex-wrap items-center gap-2">
        <fieldset
          className="m-0 flex h-9 items-center gap-[3px] rounded-[10px] border border-border bg-surface-2 p-[3px] @max-[900px]:w-full"
          aria-label="Фильтр по состоянию"
        >
          <legend className="sr-only">Состояние</legend>
          {HEALTH_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={health === f.key}
              onClick={() => setHealth(f.key)}
              className={cn(
                'flex h-full cursor-pointer items-center gap-1.5 rounded-[7px] px-2.5 text-[12.5px] font-medium text-text-2 transition-colors hover:text-foreground @max-[900px]:flex-1 @max-[900px]:justify-center max-md:px-1.5',
                health === f.key && 'bg-surface text-foreground shadow-[0_0_0_1px_var(--ns-border-2)]',
              )}
            >
              {f.label}
              <span className="text-[11px] text-text-3 tabular-nums">{counts[f.key]}</span>
            </button>
          ))}
        </fieldset>
        <div className="relative min-w-[200px] flex-1 basis-[220px] max-md:basis-full">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-3"
            aria-hidden="true"
          />
          <Input
            aria-label="Поиск по серверам"
            placeholder="Имя, адрес, тег…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-9 rounded-[10px] bg-surface-2 pl-9 text-[13px]"
          />
        </div>
        {countryStats.list.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                data-active={countries.length > 0}
                className="h-9 rounded-[10px] border-border bg-surface-2 px-3 text-[12.5px] font-medium text-text-2 hover:bg-surface-3 hover:text-foreground data-[active=true]:border-brand/40 data-[active=true]:text-foreground"
              >
                <GlobeIcon className="size-3.5" aria-hidden="true" />
                Страны
                {countries.length > 0 && (
                  <span className="rounded-full bg-brand-soft px-1.5 text-[11px] font-semibold text-brand">
                    {countries.length}
                  </span>
                )}
                <ChevronDownIcon className="size-3.5 opacity-70" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-[320px] min-w-[240px]">
              <DropdownMenuLabel>Фильтр по стране</DropdownMenuLabel>
              {[
                ...countryStats.list.map((c) => ({ key: c.code, name: c.name, n: c.n, code: c.code })),
                ...(countryStats.without > 0
                  ? [{ key: NO_COUNTRY, name: 'Без страны', n: countryStats.without, code: null }]
                  : []),
              ].map((c) => (
                <DropdownMenuCheckboxItem
                  key={c.key}
                  checked={countries.includes(c.key)}
                  // Список остаётся открытым: страны выбирают по несколько.
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={(on) =>
                    setCountries((cur) => (on ? [...cur, c.key] : cur.filter((k) => k !== c.key)))
                  }
                  className="py-1.5 pr-8 text-[13px]"
                >
                  {c.code ? (
                    <CountryFlag code={c.code} decorative />
                  ) : (
                    <span className="grid h-[15px] w-[20px] place-items-center rounded-[3px] border border-dashed border-border-2 text-text-3">
                      <GlobeIcon className="size-[10px]" aria-hidden="true" />
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  <span className="mr-1 text-[11.5px] text-text-3 tabular-nums">{c.n}</span>
                </DropdownMenuCheckboxItem>
              ))}
              <div className="mt-1 flex items-center gap-2 border-t border-border px-2 pt-1.5 pb-0.5 text-[12px] text-text-3">
                <span className="flex-1">Выбрано: {countries.length}</span>
                <button
                  type="button"
                  disabled={countries.length === 0}
                  onClick={() => setCountries([])}
                  className="cursor-pointer text-brand underline-offset-2 hover:underline disabled:cursor-default disabled:opacity-50 disabled:no-underline"
                >
                  Сбросить
                </button>
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {allTags.length > 0 && (
          <DropdownMenu onOpenChange={(o) => !o && setTagQuery('')}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                data-active={selectedTags.length > 0}
                className="h-9 rounded-[10px] border-border bg-surface-2 px-3 text-[12.5px] font-medium text-text-2 hover:bg-surface-3 hover:text-foreground data-[active=true]:border-brand/40 data-[active=true]:text-foreground"
              >
                <TagIcon className="size-3.5" aria-hidden="true" />
                {selectedTags.length === 1 ? `Тег: ${selectedTags[0]}` : 'Теги'}
                {selectedTags.length > 1 && (
                  <span className="rounded-full bg-brand-soft px-1.5 text-[11px] font-semibold text-brand">
                    {selectedTags.length}
                  </span>
                )}
                <ChevronDownIcon className="size-3.5 opacity-70" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-[360px] min-w-[260px]">
              <DropdownMenuLabel>Фильтр по тегам</DropdownMenuLabel>
              <div className="px-1 pb-1">
                <Input
                  aria-label="Найти тег"
                  placeholder="Найти тег…"
                  value={tagQuery}
                  onChange={(e) => setTagQuery(e.target.value)}
                  // Буквы — в поиск, а не в «прыжок по пунктам» меню.
                  onKeyDown={(e) => e.stopPropagation()}
                  className="h-8 rounded-[8px] bg-surface-2 text-[13px]"
                />
              </div>
              {allTags
                .filter((t) => t.includes(normalizeTag(tagQuery)))
                .map((t) => {
                  const like = similarTag(t, tagCountMap);
                  return (
                    <DropdownMenuCheckboxItem
                      key={t}
                      checked={selectedTags.includes(t)}
                      // Список остаётся открытым: теги выбирают по несколько.
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={(on) =>
                        setSelectedTags(on ? [...selectedTags, t] : selectedTags.filter((k) => k !== t))
                      }
                      className="py-1.5 pr-8 text-[13px]"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {t}
                        {like && <span className="ml-1.5 text-[11px] text-warn">похоже на {like.tag}</span>}
                      </span>
                      <span className="mr-1 text-[11.5px] text-text-3 tabular-nums">{tagCountMap[t]}</span>
                    </DropdownMenuCheckboxItem>
                  );
                })}
              <div className="mt-1 flex items-center gap-2 border-t border-border px-2 pt-1.5 pb-0.5 text-[12px] text-text-3">
                <span className="flex-1">
                  {selectedTags.length > 1
                    ? `Все выбранные: ${selectedTags.length}`
                    : `Выбрано: ${selectedTags.length}`}
                </span>
                <button
                  type="button"
                  disabled={selectedTags.length === 0}
                  onClick={() => setSelectedTags([])}
                  className="cursor-pointer text-brand underline-offset-2 hover:underline disabled:cursor-default disabled:opacity-50 disabled:no-underline"
                >
                  Сбросить
                </button>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setManageTags(true)} className="text-[13px] text-brand">
                Управление тегами…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {items.length > 0 && (
          <fieldset
            className="m-0 flex h-9 items-center gap-[3px] rounded-[10px] border border-border bg-surface-2 p-[3px]"
            aria-label="Вид"
          >
            <legend className="sr-only">Вид</legend>
            {(
              [
                { key: 'cards', label: 'Карточки', Icon: LayoutGridIcon },
                { key: 'list', label: 'Список', Icon: ListIcon },
              ] as const
            ).map(({ key, label, Icon }) => (
              <button
                key={key}
                type="button"
                aria-pressed={view === key}
                title={label}
                onClick={() => setView(key)}
                className={cn(
                  'grid h-full w-8 cursor-pointer place-items-center rounded-[7px] text-text-2 transition-colors hover:text-foreground',
                  view === key && 'bg-surface text-foreground shadow-[0_0_0_1px_var(--ns-border-2)]',
                )}
              >
                <Icon className="size-3.5" aria-hidden="true" />
                <span className="sr-only">{label}</span>
              </button>
            ))}
          </fieldset>
        )}
        {items.length > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                disabled={checkAll.isPending}
                onClick={() => setCheckAllOpen(true)}
                aria-label="Проверить все"
                className="size-9 rounded-[10px] border-border bg-surface-2 p-0 text-text-2 hover:bg-surface-3 hover:text-foreground"
              >
                <RefreshCwIcon
                  className={cn('size-4', checkAll.isPending && 'animate-spin')}
                  aria-hidden="true"
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Проверить связь со всеми серверами</TooltipContent>
          </Tooltip>
        )}
        <Button
          type="button"
          onClick={() => setAddOpen(true)}
          className="h-9 rounded-[10px] bg-cta px-4 text-cta-foreground hover:bg-(--ns-cta-hover) max-md:flex-1"
        >
          <PlusIcon className="size-4" aria-hidden="true" />
          Добавить сервер
        </Button>
      </div>

      <ConfirmDialog
        open={checkAllOpen}
        onOpenChange={setCheckAllOpen}
        title="Проверить все серверы?"
        description={`Панель по очереди подключится по SSH к каждому серверу (${items.length}) и обновит данные о системе. Обычно это занимает до минуты.`}
        yesLabel="Да, проверить"
        onConfirm={doCheckAll}
      />

      {servers.isPending && (
        <div className="flex flex-col gap-3">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-[120px] rounded-2xl" />
          ))}
        </div>
      )}
      {servers.isError && (
        <p className="rounded-[12px] border border-crit/30 bg-crit-soft px-4 py-3 text-[13px]">
          {apiErrorMessage(servers.error)}{' '}
          <button type="button" className="cursor-pointer underline" onClick={() => void servers.refetch()}>
            Повторить
          </button>
        </p>
      )}
      {servers.data && items.length === 0 && (
        <div className="grid place-items-center rounded-2xl border border-dashed border-border px-6 py-16 text-center">
          <ServerIcon className="size-8 text-text-3" aria-hidden="true" />
          <h2 className="mt-3 font-heading text-[16px] font-bold">Серверов пока нет</h2>
          <p className="mt-1 max-w-[380px] text-[13px] text-text-2">
            Добавьте первый: понадобятся IP, порт и доступ по SSH. Панель сама поставит свой ключ и подготовит
            сервер к установке агента.
          </p>
          <Button
            type="button"
            onClick={() => setAddOpen(true)}
            className="mt-5 rounded-[10px] bg-cta px-4 text-cta-foreground hover:bg-(--ns-cta-hover)"
          >
            <PlusIcon className="size-4" aria-hidden="true" />
            Добавить сервер
          </Button>
        </div>
      )}
      {servers.data && items.length > 0 && filtered.length === 0 && (
        <p className="rounded-[12px] border border-border bg-surface px-4 py-6 text-center text-[13px] text-text-3">
          Ничего не найдено.{' '}
          <button
            type="button"
            className="cursor-pointer text-brand underline-offset-2 hover:underline"
            onClick={() => {
              setQ('');
              setHealth('all');
              setCountries([]);
              onTag(undefined);
            }}
          >
            Сбросить фильтры
          </button>
        </p>
      )}
      {view === 'list' ? (
        filtered.length > 0 && <ServerList servers={filtered} metricsById={metricsById} onOpen={openDetail} />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictAboveGrid]}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragCancel={onDragCancel}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={filtered.map((s) => s.id)} strategy={rectSortingStrategy}>
            <div
              ref={gridRef}
              className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))] max-md:[grid-template-columns:1fr] 2xl:[grid-template-columns:repeat(3,minmax(0,1fr))]"
            >
              {filtered.map((s) => (
                <ServerCard
                  key={s.id}
                  server={s}
                  metrics={metricsById.get(s.id) ?? null}
                  onOpen={openDetail}
                  onEdit={openEdit}
                />
              ))}
            </div>
          </SortableContext>
          <DragOverlay dropAnimation={{ duration: 220, easing: 'cubic-bezier(0.2, 0, 0, 1)' }}>
            {activeId
              ? (() => {
                  const active = items.find((s) => s.id === activeId);
                  return active ? (
                    <ServerCardGhost server={active} metrics={metricsById.get(active.id) ?? null} />
                  ) : null;
                })()
              : null}
          </DragOverlay>
        </DndContext>
      )}

      <AddServerDialog open={addOpen} onOpenChange={setAddOpen} />
      <TagsManageDialog open={manageTags} onOpenChange={setManageTags} />
    </div>
  );
}
