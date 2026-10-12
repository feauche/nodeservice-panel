/**
 * Дерево с перетаскиванием для страницы «Ноды»: папки и ноды в них.
 *
 * Основано на dnd-kit-sortable-tree 0.1.73 (MIT, © 2023 Artur Drobinskiy), перенесено в панель ради двух правок,
 * которых библиотека не позволяет сделать снаружи:
 * — новый порядок применяется в момент броска. Библиотека сначала возвращала строки на старые места и лишь на
 *   следующем шаге (setTimeout) отдавала новый порядок — строки отскакивали назад и ехали обратно;
 * — после броска фокус не возвращается на ручку, поэтому страница не прокручивается к старому месту строки.
 * Плюс подсказки для экранного диктора по-русски и сигнал «идёт перетаскивание» наружу: пока тянут, дерево не
 * пересобирается от фонового обновления.
 */
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  type DropAnimation,
  PointerSensor,
  type PointerSensorOptions,
  type UniqueIdentifier,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  type AnimateLayoutChanges,
  arrayMove,
  SortableContext,
  type SortingStrategy,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  type CSSProperties,
  type ForwardRefExoticComponent,
  memo,
  type RefAttributes,
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

export type TreeItem<T> = {
  id: UniqueIdentifier;
  children?: TreeItem<T>[];
  collapsed?: boolean;
  canHaveChildren?: boolean | ((dragItem: FlattenedItem<T>) => boolean);
} & T;
export type TreeItems<T> = TreeItem<T>[];

export type FlattenedItem<T> = TreeItem<T> & {
  parentId: UniqueIdentifier | null;
  depth: number;
  index: number;
  isLast: boolean;
  parent: FlattenedItem<T> | null;
};

export type ItemChangedReason<T> =
  | { type: 'dropped'; draggedItem: TreeItem<T>; droppedToParent: TreeItem<T> | null }
  | { type: 'collapsed' | 'expanded'; item: TreeItem<T> };

export type TreeItemComponentProps<T> = {
  item: FlattenedItem<T>;
  parent: FlattenedItem<T> | null;
  depth: number;
  childCount?: number;
  /** Копия под курсором. */
  clone?: boolean;
  /** Место, куда встанет строка (сама строка во время перетаскивания). */
  ghost?: boolean;
  collapsed?: boolean;
  /** Идёт перестановка: нажатия внутри строк временно не работают. */
  disableInteraction?: boolean;
  handleProps?: Record<string, unknown>;
  style?: CSSProperties;
  onCollapse?: () => void;
  wrapperRef?: (node: HTMLLIElement | null) => void;
};
export type TreeItemComponent<T> = ForwardRefExoticComponent<
  TreeItemComponentProps<T> & RefAttributes<HTMLDivElement>
>;

function flatten<T>(
  items: TreeItems<T>,
  parentId: UniqueIdentifier | null = null,
  depth = 0,
  parent: FlattenedItem<T> | null = null,
  out: FlattenedItem<T>[] = [],
): FlattenedItem<T>[] {
  items.forEach((item, index) => {
    const flat = {
      ...item,
      parentId,
      depth,
      index,
      isLast: items.length === index + 1,
      parent,
    } as FlattenedItem<T>;
    out.push(flat);
    flatten(item.children ?? [], item.id, depth + 1, flat, out);
  });
  return out;
}

export const flattenTree = <T,>(items: TreeItems<T>) => flatten(items);

function buildTree<T>(flat: FlattenedItem<T>[]): TreeItems<T> {
  const root = { id: 'root', children: [] as TreeItem<T>[] };
  const nodes: Record<string, { children?: TreeItem<T>[] }> = { [root.id]: root };
  const items = flat.map((item) => ({ ...item, children: [] as TreeItem<T>[] }));
  for (const item of items) {
    const parent = nodes[String(item.parentId ?? root.id)] ?? items.find((x) => x.id === item.parentId);
    const { parent: _p, parentId: _pid, depth: _d, index: _i, isLast: _l, ...clean } = item;
    nodes[String(item.id)] = clean as TreeItem<T>;
    parent?.children?.push(clean as TreeItem<T>);
  }
  return root.children;
}

function findItemDeep<T>(items: TreeItems<T>, id: UniqueIdentifier): TreeItem<T> | undefined {
  for (const item of items) {
    if (item.id === id) return item;
    const child = item.children?.length ? findItemDeep(item.children, id) : undefined;
    if (child) return child;
  }
  return undefined;
}

function toggleCollapsed<T>(items: TreeItems<T>, id: UniqueIdentifier): TreeItems<T> {
  return items.map((item) =>
    item.id === id
      ? { ...item, collapsed: !item.collapsed }
      : item.children?.length
        ? { ...item, children: toggleCollapsed(item.children, id) }
        : item,
  );
}

function countChildren<T>(items: TreeItems<T>, count = 0): number {
  return items.reduce(
    (acc, { children }) => (children?.length ? countChildren(children, acc + 1) : acc + 1),
    count,
  );
}

function childCount<T>(items: TreeItems<T>, id: UniqueIdentifier | null) {
  const item = id ? findItemDeep(items, id) : undefined;
  return item ? countChildren(item.children ?? []) : 0;
}

function removeChildrenOf<T>(items: FlattenedItem<T>[], ids: UniqueIdentifier[]) {
  const exclude = [...ids];
  return items.filter((item) => {
    if (item.parentId != null && exclude.includes(item.parentId)) {
      if (item.children?.length) exclude.push(item.id);
      return false;
    }
    return true;
  });
}

const canHave = <T,>(parent: FlattenedItem<T>, drag: FlattenedItem<T>) =>
  typeof parent.canHaveChildren === 'function' ? parent.canHaveChildren(drag) : parent.canHaveChildren;

/** Куда встанет строка: глубина и родитель по положению курсора (как в библиотеке). */
function getProjection<T>(
  items: FlattenedItem<T>[],
  activeId: UniqueIdentifier | null,
  overId: UniqueIdentifier | null,
  dragOffset: number,
  indentationWidth: number,
  canRootHaveChildren: boolean,
) {
  if (!activeId || !overId) return null;
  const overIndex = items.findIndex(({ id }) => id === overId);
  const activeIndex = items.findIndex(({ id }) => id === activeId);
  const activeItem = items[activeIndex];
  if (!activeItem) return null;
  const moved = arrayMove(items, activeIndex, overIndex);
  const previous = moved[overIndex - 1];
  const next = moved[overIndex + 1];
  let depth = activeItem.depth + Math.round(dragOffset / indentationWidth);
  const withDepth = (d: number, item: FlattenedItem<T> | undefined) => {
    let cur = item ?? null;
    while (cur && d < cur.depth) cur = cur.parent;
    return cur;
  };
  const allowed = (parent: FlattenedItem<T> | null): FlattenedItem<T> | null | undefined => {
    if (!parent) return canRootHaveChildren ? null : undefined;
    return canHave(parent, activeItem) === false ? allowed(parent.parent) : parent;
  };
  const parent = allowed(withDepth(depth - 1, previous));
  if (parent === undefined) return null;
  const maxDepth = (parent?.depth ?? -1) + 1;
  const minDepth = next?.depth ?? 0;
  if (minDepth > maxDepth) return null;
  depth = Math.min(Math.max(depth, minDepth), maxDepth);
  let parentId: UniqueIdentifier | null = null;
  if (depth > 0 && previous) {
    if (depth === previous.depth) parentId = previous.parentId;
    else if (depth > previous.depth) parentId = previous.id;
    else
      parentId =
        moved
          .slice(0, overIndex)
          .reverse()
          .find((x) => x.depth === depth)?.parentId ?? null;
  }
  return { depth, parentId, parent, isLast: (next?.depth ?? -1) < depth };
}

// Во время перетаскивания перестановку анимирует сама сортировка; после — раскладка не «едет».
const animateLayoutChanges: AnimateLayoutChanges = ({ isSorting, wasDragging }) =>
  !(isSorting || wasDragging);

const SortableItem = memo(function SortableItem<T>({
  id,
  item,
  depth,
  TreeItemComponent: Component,
  ...props
}: Omit<TreeItemComponentProps<T>, 'handleProps' | 'style' | 'wrapperRef'> & {
  id: UniqueIdentifier;
  TreeItemComponent: TreeItemComponent<T>;
  disableSorting?: boolean;
}) {
  const {
    attributes,
    listeners,
    isDragging,
    isSorting,
    setDraggableNodeRef,
    setDroppableNodeRef,
    transform,
    transition,
  } = useSortable({
    id,
    animateLayoutChanges,
    disabled: props.disableSorting,
    // Соседние строки сдвигаются за 0,17 с — как папки.
    transition: { duration: 170, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
  });
  return (
    <Component
      {...props}
      item={item}
      depth={depth}
      ref={setDraggableNodeRef}
      wrapperRef={setDroppableNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition: transition ?? undefined }}
      ghost={isDragging}
      disableInteraction={isSorting}
      handleProps={{ ...attributes, ...listeners }}
    />
  );
}) as <T>(
  props: Omit<TreeItemComponentProps<T>, 'handleProps' | 'style' | 'wrapperRef'> & {
    id: UniqueIdentifier;
    TreeItemComponent: TreeItemComponent<T>;
    disableSorting?: boolean;
  },
) => React.ReactElement;

export function SortableTree<T>({
  items,
  onItemsChanged,
  TreeItemComponent,
  indentationWidth = 12,
  pointerSensorOptions,
  disableSorting = false,
  dropAnimation = null,
  canRootHaveChildren = true,
  label,
  onDraggingChange,
}: {
  items: TreeItems<T>;
  onItemsChanged: (items: TreeItems<T>, reason: ItemChangedReason<T>) => void;
  TreeItemComponent: TreeItemComponent<T>;
  indentationWidth?: number;
  pointerSensorOptions?: PointerSensorOptions;
  disableSorting?: boolean;
  dropAnimation?: DropAnimation | null;
  canRootHaveChildren?: boolean;
  /** Имя элемента для диктора: «Нидерланды - 1». */
  label: (item: TreeItem<T>) => string;
  onDraggingChange?: (dragging: boolean) => void;
}) {
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null);
  const [overId, setOverId] = useState<UniqueIdentifier | null>(null);
  const [offsetLeft, setOffsetLeft] = useState(0);
  const flattened = useMemo(() => {
    const flat = flattenTree(items);
    const collapsed = flat.filter((i) => i.collapsed && i.children?.length).map((i) => i.id);
    return removeChildrenOf(flat, activeId ? [activeId, ...collapsed] : collapsed);
  }, [activeId, items]);
  const projected = getProjection(
    flattened,
    activeId,
    overId,
    offsetLeft,
    indentationWidth,
    canRootHaveChildren,
  );
  const sensors = useSensors(
    useSensor(PointerSensor, pointerSensorOptions ?? { activationConstraint: { distance: 3 } }),
  );
  const sortedIds = useMemo(() => flattened.map(({ id }) => id), [flattened]);
  const activeItem = activeId ? flattened.find(({ id }) => id === activeId) : null;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const handleCollapse = useCallback(
    (id: UniqueIdentifier) => {
      const item = findItemDeep(itemsRef.current, id);
      if (!item) return;
      onItemsChanged(toggleCollapsed(itemsRef.current, id), {
        type: item.collapsed ? 'expanded' : 'collapsed',
        item,
      });
    },
    [onItemsChanged],
  );

  const nameOf = (id: UniqueIdentifier) => {
    const item = findItemDeep(itemsRef.current, id);
    return item ? label(item) : String(id);
  };
  const announcements = {
    onDragStart: ({ active }: DragStartEvent) => `Взяли «${nameOf(active.id)}».`,
    onDragOver: ({ active, over }: DragOverEvent) =>
      over ? `«${nameOf(active.id)}» над «${nameOf(over.id)}».` : undefined,
    onDragEnd: ({ active }: DragEndEvent) => `«${nameOf(active.id)}» поставлена.`,
    onDragCancel: ({ active }: { active: { id: UniqueIdentifier } }) =>
      `Перемещение «${nameOf(active.id)}» отменено, строка на прежнем месте.`,
    onDragMove: () => undefined,
  };

  const strategy: SortingStrategy = (args) => (projected ? verticalListSortingStrategy(args) : null);

  const reset = () => {
    setOverId(null);
    setActiveId(null);
    setOffsetLeft(0);
    document.body.style.removeProperty('cursor');
    onDraggingChange?.(false);
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (projected && over) {
      const flat = flattenTree(items);
      const overIndex = flat.findIndex(({ id }) => id === over.id);
      const activeIndex = flat.findIndex(({ id }) => id === active.id);
      const activeTreeItem = flat[activeIndex];
      if (activeTreeItem && overIndex >= 0) {
        flat[activeIndex] = { ...activeTreeItem, depth: projected.depth, parentId: projected.parentId };
        const sorted = arrayMove(flat, activeIndex, overIndex);
        const moved = sorted.find((x) => x.id === active.id);
        const parent = moved?.parentId != null ? (sorted.find((x) => x.id === moved.parentId) ?? null) : null;
        // Новый порядок — в том же обработчике, что и сброс: на экране сразу новое место, без отскока.
        if (moved)
          onItemsChanged(buildTree(sorted), { type: 'dropped', draggedItem: moved, droppedToParent: parent });
      }
    }
    reset();
  };

  return (
    <DndContext
      accessibility={{ announcements, restoreFocus: false }}
      // Датчики — всегда: отключённая сортировка выключает сами строки (useSortable), а смена «нет датчиков» на
      // «есть» меняла бы размер списка зависимостей внутри DndContext.
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={
        disableSorting
          ? undefined
          : ({ active }) => {
              setActiveId(active.id);
              setOverId(active.id);
              document.body.style.setProperty('cursor', 'grabbing');
              onDraggingChange?.(true);
            }
      }
      onDragMove={disableSorting ? undefined : ({ delta }: DragMoveEvent) => setOffsetLeft(delta.x)}
      onDragOver={disableSorting ? undefined : ({ over }: DragOverEvent) => setOverId(over?.id ?? null)}
      onDragEnd={disableSorting ? undefined : handleDragEnd}
      onDragCancel={disableSorting ? undefined : reset}
    >
      <SortableContext items={sortedIds} strategy={disableSorting ? undefined : strategy}>
        {flattened.map((item) => (
          <SortableItem<T>
            key={item.id}
            id={item.id}
            item={item}
            TreeItemComponent={TreeItemComponent}
            childCount={item.children?.length}
            depth={item.id === activeId && projected ? projected.depth : item.depth}
            collapsed={Boolean(item.collapsed && item.children?.length)}
            onCollapse={item.children?.length ? () => handleCollapse(item.id) : undefined}
            parent={item.id === activeId && projected ? projected.parent : item.parent}
            disableSorting={disableSorting}
          />
        ))}
        {createPortal(
          <DragOverlay dropAnimation={dropAnimation}>
            {activeId && activeItem ? (
              <TreeItemComponent
                item={activeItem}
                depth={activeItem.depth}
                clone
                childCount={childCount(items, activeId) + 1}
                parent={activeItem.parent}
              />
            ) : null}
          </DragOverlay>,
          document.body,
        )}
      </SortableContext>
    </DndContext>
  );
}
