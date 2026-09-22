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
import type { Server, ServersResponse } from '@nodeservice/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDownIcon, PlusIcon, RefreshCwIcon, SearchIcon, ServerIcon, TagIcon } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { apiErrorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { AddServerDialog } from './add-server-dialog';
import { ServerCard, ServerCardGhost } from './server-card';
import { ServerModal, type ServerModalTab } from './server-modal';
import { serversKeys, useCheckAllServers, useReorderServers, useServers } from './servers-api';

export interface ServersPageProps {
  /** Фильтр по тегу из URL (?tag=prod) — ссылку можно переслать. */
  tag?: string | undefined;
  onTag: (tag: string | undefined) => void;
  /** Модалка сервера из URL (?open=<id>). */
  openId?: string | undefined;
  onOpen: (id: string | undefined) => void;
}

export function ServersPage({ tag, onTag, openId, onOpen }: ServersPageProps) {
  const servers = useServers();
  const [q, setQ] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [modalTab, setModalTab] = useState<ServerModalTab>('metrics');
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
  const allTags = useMemo(() => [...new Set(items.flatMap((s) => s.tags))].sort(), [items]);
  const filtered = visual.filter((s) => {
    if (tag && !s.tags.includes(tag)) return false;
    if (q) {
      const needle = q.toLowerCase();
      const hay = [s.name, s.host, s.facts.hostname ?? '', ...s.tags].join(' ').toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  const doCheckAll = async () => {
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
    setModalTab('metrics');
    onOpen(server.id);
  };
  const openEdit = (server: Server) => {
    if (dragging.current) return;
    setModalTab('connection');
    onOpen(server.id);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 basis-[240px]">
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
        {allTags.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                data-active={Boolean(tag)}
                className="h-9 rounded-[10px] border-border bg-surface-2 px-3 text-[12.5px] font-medium text-text-2 hover:bg-surface-3 hover:text-foreground data-[active=true]:border-brand/40 data-[active=true]:text-foreground"
              >
                <TagIcon className="size-3.5" aria-hidden="true" />
                {tag ? `Тег: ${tag}` : 'Теги'}
                <ChevronDownIcon className="size-3.5 opacity-70" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[180px]">
              <DropdownMenuLabel>Фильтр по тегу</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={tag ?? ''}
                onValueChange={(v) => onTag(v === '' ? undefined : v)}
              >
                <DropdownMenuRadioItem value="">Все серверы</DropdownMenuRadioItem>
                {allTags.map((t) => (
                  <DropdownMenuRadioItem key={t} value={t}>
                    {t}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <div className="ml-auto flex items-center gap-2">
          {items.length > 0 && (
            <Button
              type="button"
              variant="outline"
              disabled={checkAll.isPending}
              onClick={() => void doCheckAll()}
              className="h-9 rounded-[10px] border-border bg-surface-2 px-3 text-[12.5px] font-medium text-text-2 hover:bg-surface-3 hover:text-foreground"
            >
              <RefreshCwIcon
                className={cn('size-3.5', checkAll.isPending && 'animate-spin')}
                aria-hidden="true"
              />
              Проверить все
            </Button>
          )}
          <Button
            type="button"
            onClick={() => setAddOpen(true)}
            className="h-9 rounded-[10px] bg-cta px-4 text-cta-foreground hover:bg-(--ns-cta-hover)"
          >
            <PlusIcon className="size-4" aria-hidden="true" />
            Добавить сервер
          </Button>
        </div>
      </div>

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
            Добавь первый: понадобится IP, порт и доступ по SSH. Панель сама поставит свой ключ и подготовит
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
              onTag(undefined);
            }}
          >
            Сбросить фильтры
          </button>
        </p>
      )}
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
          <div ref={gridRef} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filtered.map((s) => (
              <ServerCard key={s.id} server={s} onOpen={openDetail} onEdit={openEdit} />
            ))}
          </div>
        </SortableContext>
        <DragOverlay dropAnimation={{ duration: 220, easing: 'cubic-bezier(0.2, 0, 0, 1)' }}>
          {activeId
            ? (() => {
                const active = items.find((s) => s.id === activeId);
                return active ? <ServerCardGhost server={active} /> : null;
              })()
            : null}
        </DragOverlay>
      </DndContext>

      <AddServerDialog open={addOpen} onOpenChange={setAddOpen} />
      <ServerModal
        server={items.find((sv) => sv.id === openId) ?? null}
        initialTab={modalTab}
        onClose={() => {
          onOpen(undefined);
          setModalTab('metrics');
        }}
      />
    </div>
  );
}
