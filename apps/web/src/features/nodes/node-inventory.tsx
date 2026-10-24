import type { NodeLayout, RemnawaveNode, ScenarioDisabledHosts } from '@nodeservice/shared';
import {
  ChevronRightIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  GripVerticalIcon,
  MoreHorizontalIcon,
  PencilIcon,
  Trash2Icon,
} from 'lucide-react';
import {
  createContext,
  forwardRef,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useIncidents } from '@/features/incidents/incidents-api';
import { useDisabledHosts } from '@/features/scenarios/scenarios-api';
import { apiErrorMessage } from '@/lib/api';
import { cn, randomId } from '@/lib/utils';
import { NodeCard } from './node-card';
import {
  layoutToSortableGroups,
  moveNodeInLayout,
  nodeFolderGroup,
  nodeFolderId,
  normalizedRootIds,
  ROOT_NODE_GROUP,
  scopedNodeIds,
  sortableGroupsToLayout,
} from './node-layout-dnd';
import { useNodeLayout, useSaveNodeLayout } from './nodes-api';
import { SortableTree, type TreeItemComponentProps, type TreeItems } from './sortable-tree';

const empty: NodeLayout = { folders: [], order: [], placement: {}, rootOrder: [], collapsedFolders: [] };
const sameLayout = (a: NodeLayout, b: NodeLayout) => JSON.stringify(a) === JSON.stringify(b);
/** Папка открывается и закрывается за 0,17 с — как в витрине. */
const FOLDER_MS = 170;

type NodeTreeData = {
  kind: 'folder' | 'node';
  folderId?: string;
  nodeId?: string;
  label: string;
};

type NodeIncident = { title: string; tone: 'crit' | 'warn' };

type NodeTreeContextValue = {
  nodes: Map<string, RemnawaveNode>;
  incidents: Map<string, NodeIncident>;
  /** Host, отключённые сценарием, по нодам — метка «Host отключён». */
  hostsOff: Map<string, ScenarioDisabledHosts['items'][number]>;
  folders: NodeLayout['folders'];
  stale: boolean;
  /** Раскладка не загрузилась: перетаскивать и менять папки нельзя. */
  locked: boolean;
  searching: boolean;
  visible: Set<string>;
  /** Ноды, которые сейчас появляются: их папку только что открыли. */
  entering: Set<string>;
  /** Папки, которые сейчас закрываются: их строки уезжают. */
  closing: Set<string>;
  onSelect: (id: string) => void;
  onToggleFolder: (folderId: string) => void;
  onMoveNode: (nodeId: string, folderId: string | null) => void;
  onEditFolder: (folder: { id: string; name: string }) => void;
  onDeleteFolder: (folderId: string) => void;
};

const NodeTreeContext = createContext<NodeTreeContextValue | null>(null);
function useNodeTreeContext() {
  const value = useContext(NodeTreeContext);
  if (!value) throw new Error('NodeTreeContext is missing');
  return value;
}

function layoutToTree(
  source: NodeLayout,
  nodes: RemnawaveNode[],
  searching: boolean,
): TreeItems<NodeTreeData> {
  const nodeIds = nodes.map((node) => node.uuid);
  const nodeById = new Map(nodes.map((node) => [node.uuid, node]));
  const folderById = new Map(source.folders.map((folder) => [folder.id, folder]));
  return normalizedRootIds(source, nodeIds).flatMap((id): TreeItems<NodeTreeData> => {
    if (!id.startsWith('folder:')) {
      const node = nodeById.get(id);
      return node ? [{ id, kind: 'node', nodeId: id, label: node.name, canHaveChildren: false }] : [];
    }
    const folderId = id.slice('folder:'.length);
    const folder = folderById.get(folderId);
    if (!folder) return [];
    const children = scopedNodeIds(source, nodeIds, folderId).flatMap((nodeId): TreeItems<NodeTreeData> => {
      const node = nodeById.get(nodeId);
      return node ? [{ id: nodeId, kind: 'node', nodeId, label: node.name, canHaveChildren: false }] : [];
    });
    return [
      {
        id,
        kind: 'folder',
        folderId,
        label: folder.name,
        // Во время поиска папки открыты, чтобы были видны найденные ноды; сохранённое состояние не меняется.
        collapsed: searching ? false : source.collapsedFolders.includes(folderId),
        canHaveChildren: (dragItem) => dragItem.kind === 'node',
        children,
      },
    ];
  });
}

function treeToLayout(source: NodeLayout, nodes: RemnawaveNode[], tree: TreeItems<NodeTreeData>): NodeLayout {
  const nodeIds = nodes.map((node) => node.uuid);
  const knownNodes = new Set(nodeIds);
  const knownFolders = new Set(source.folders.map((folder) => folder.id));
  const rootOrder: string[] = [];
  const order: string[] = [];
  const placement: Record<string, string> = {};
  const seenNodes = new Set<string>();
  const seenFolders = new Set<string>();

  const addRootNode = (nodeId: string | undefined) => {
    if (!nodeId || !knownNodes.has(nodeId) || seenNodes.has(nodeId)) return;
    seenNodes.add(nodeId);
    rootOrder.push(nodeId);
    order.push(nodeId);
  };

  for (const item of tree) {
    if (item.kind !== 'folder') {
      addRootNode(item.nodeId);
      continue;
    }
    const folderId = item.folderId;
    if (!folderId || !knownFolders.has(folderId) || seenFolders.has(folderId)) continue;
    seenFolders.add(folderId);
    rootOrder.push(nodeFolderId(folderId));
    for (const child of item.children ?? []) {
      const nodeId = child.nodeId;
      if (!nodeId || !knownNodes.has(nodeId) || seenNodes.has(nodeId)) continue;
      seenNodes.add(nodeId);
      placement[nodeId] = folderId;
      order.push(nodeId);
    }
  }

  for (const folder of source.folders) {
    if (seenFolders.has(folder.id)) continue;
    rootOrder.push(nodeFolderId(folder.id));
    for (const nodeId of scopedNodeIds(source, nodeIds, folder.id)) {
      if (seenNodes.has(nodeId)) continue;
      seenNodes.add(nodeId);
      placement[nodeId] = folder.id;
      order.push(nodeId);
    }
  }
  for (const node of nodes) addRootNode(node.uuid);
  // Свёрнутость папок перетаскивание не меняет: она хранится отдельно и меняется только нажатием на папку.
  return { ...source, order, placement, rootOrder };
}

const NodeTreeItem = forwardRef<HTMLDivElement, TreeItemComponentProps<NodeTreeData>>(function NodeTreeItem(
  {
    item,
    parent,
    childCount,
    clone,
    ghost,
    collapsed,
    depth,
    handleProps,
    wrapperRef,
    style,
    disableInteraction,
  },
  ref,
) {
  const context = useNodeTreeContext();
  const hidden = item.kind === 'node' && context.searching && !context.visible.has(item.nodeId ?? '');
  if (hidden && !clone) return <li ref={wrapperRef} style={{ display: 'none' }} />;

  const common = cn(
    'relative min-w-0 transition-opacity',
    ghost && 'opacity-[0.18]',
    // Копия под курсором — ровно по ширине строки, без сдвига; под заливкой сплошной фон, как у карточки списка,
    // иначе сквозь неё видны строки ниже.
    clone && 'w-full rounded-[10px] bg-surface opacity-100 shadow-xl',
    disableInteraction && !clone && 'pointer-events-none',
  );
  const offset = depth * 12;

  if (item.kind === 'folder') {
    const folderId = item.folderId ?? '';
    const folder = context.folders.find((candidate) => candidate.id === folderId);
    if (!folder) return <li ref={wrapperRef} style={style} />;
    const kids = (item.children ?? []).flatMap((child) => {
      const node = context.nodes.get(child.nodeId ?? '');
      return node ? [node] : [];
    });
    const online = kids.reduce((sum, n) => sum + (n.isDisabled ? 0 : (n.usersOnline ?? 0)), 0);
    const failing = kids.filter(
      (n) =>
        !n.maintenance &&
        ((!n.isConnected && !n.isDisabled) || context.incidents.get(n.uuid)?.tone === 'crit'),
    ).length;
    const maintained = kids.filter((n) => n.maintenance).length;
    const open = !collapsed && !context.closing.has(folderId);
    const toggleLocked = context.locked || context.searching;
    return (
      <li
        ref={wrapperRef}
        style={style}
        data-tree-kind="folder"
        data-tree-id={folderId}
        className="list-none py-1.5"
      >
        <div
          ref={ref}
          className={cn(
            common,
            'group/folder flex h-[52px] items-center gap-2.5 rounded-[14px] border border-border bg-surface pr-2 pl-10 transition-colors hover:bg-surface-2/55',
          )}
          style={{ marginLeft: clone ? 0 : offset }}
        >
          {!clone && (
            <button
              type="button"
              disabled={toggleLocked}
              title={
                context.searching
                  ? 'Во время поиска папки открыты, чтобы были видны найденные ноды'
                  : undefined
              }
              aria-label={`${open ? 'Закрыть' : 'Открыть'} папку ${folder.name}`}
              aria-expanded={open}
              onClick={() => context.onToggleFolder(folderId)}
              className="absolute inset-0 cursor-pointer rounded-[14px] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand disabled:cursor-default"
            />
          )}
          <button
            type="button"
            {...handleProps}
            onClick={(event) => event.stopPropagation()}
            disabled={context.locked || context.searching}
            aria-label={`Переместить папку ${folder.name}`}
            className="absolute top-1/2 left-2 z-10 -translate-y-1/2 cursor-grab touch-none rounded p-1 text-text-3 hover:bg-surface-2 disabled:opacity-30"
          >
            <GripVerticalIcon className="size-4" />
          </button>
          <div className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-2.5 text-left">
            <ChevronRightIcon
              className={cn(
                'size-4 flex-none text-text-3 transition-transform duration-[170ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none',
                open && 'rotate-90',
              )}
              aria-hidden="true"
            />
            {open ? (
              <FolderOpenIcon className="size-[18px] flex-none text-brand" aria-hidden="true" />
            ) : (
              <FolderIcon className="size-[18px] flex-none text-brand" aria-hidden="true" />
            )}
            <span className="truncate text-[14px] font-semibold">{folder.name}</span>
            <span className="inline-grid h-[22px] min-w-6 flex-none place-items-center rounded-full bg-surface-2 px-[7px] text-[12px] font-bold text-text-2 tabular-nums">
              {clone ? (childCount ?? 1) - 1 : kids.length}
            </span>
            <span className="ml-auto flex flex-none items-center gap-3.5 pl-2 text-[12.5px] whitespace-nowrap text-text-3">
              <span className="tabular-nums">онлайн {online.toLocaleString('ru-RU')}</span>
              {kids.length > 0 && (
                <span
                  className={cn('max-sm:hidden', failing > 0 ? 'text-crit' : maintained > 0 && 'text-brand')}
                >
                  ●{' '}
                  {failing > 0
                    ? `${failing} со сбоем${maintained > 0 ? ` · ${maintained} на обслуживании` : ''}`
                    : maintained > 0
                      ? `${maintained} на обслуживании`
                      : 'все в норме'}
                </span>
              )}
            </span>
          </div>
          {!clone && !ghost && (
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={context.locked}
                aria-label={`Настройки папки ${folder.name}`}
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                className="relative z-10 grid size-[30px] place-items-center rounded-[9px] text-text-3 hover:bg-surface-2 hover:text-foreground"
              >
                <MoreHorizontalIcon className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                collisionPadding={12}
                className="w-[240px] max-w-[calc(100vw-24px)]"
              >
                <DropdownMenuItem onSelect={() => context.onEditFolder(folder)}>
                  <PencilIcon />
                  Переименовать
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => context.onDeleteFolder(folder.id)}>
                  <Trash2Icon />
                  Удалить папку
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </li>
    );
  }

  const node = context.nodes.get(item.nodeId ?? '');
  if (!node) return <li ref={wrapperRef} style={style} />;
  const targetFolder = parent?.folderId
    ? context.folders.find((folder) => folder.id === parent.folderId)
    : null;
  // Строка внутри папки появляется и уходит плавно: высота и прозрачность за 0,17 с.
  const motion =
    clone || ghost
      ? ''
      : context.entering.has(node.uuid)
        ? 'ns-row-in'
        : parent?.folderId && context.closing.has(parent.folderId)
          ? 'ns-row-out'
          : '';
  return (
    <li
      ref={wrapperRef}
      style={style}
      data-tree-kind="node"
      data-tree-id={node.uuid}
      data-tree-parent={parent?.folderId ?? 'root'}
      className="list-none"
    >
      <div className={motion}>
        <div className={motion ? 'min-h-0 overflow-hidden' : undefined}>
          <div className="py-1.5">
            {/* Раскладка строки зависит от ширины самой строки: копия под курсором (она рисуется вне списка) и
                строка в списке всегда выглядят одинаково. */}
            <div
              ref={ref}
              className={cn(common, '@container/nodes')}
              style={{ marginLeft: clone ? 0 : offset }}
            >
              <NodeCard
                node={node}
                stale={context.stale}
                incident={context.incidents.get(node.uuid) ?? null}
                hostsOff={context.hostsOff.get(node.uuid) ?? null}
                onClick={() => context.onSelect(node.uuid)}
              />
              {ghost && (
                <span className="pointer-events-none absolute top-2 right-12 z-20 rounded-md border border-brand/35 bg-surface/95 px-2 py-1 text-[10px] font-semibold text-brand shadow-sm">
                  {targetFolder ? `В папку: ${targetFolder.name}` : 'Вне папки'}
                </span>
              )}
              <button
                type="button"
                {...handleProps}
                disabled={context.locked || context.searching}
                aria-label={`Переместить ${node.name}`}
                className="absolute top-1/2 left-1.5 z-10 -translate-y-1/2 cursor-grab touch-none rounded-md p-1 text-text-3 hover:bg-surface-2 hover:text-foreground disabled:opacity-30"
              >
                <GripVerticalIcon className="size-4" />
              </button>
              {!clone && !ghost && (
                <div className="absolute top-1/2 right-2 -translate-y-1/2">
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      aria-label={`Папка ноды ${node.name}`}
                      className="grid size-[30px] place-items-center rounded-[9px] text-text-3 hover:bg-surface-2 hover:text-foreground"
                    >
                      <MoreHorizontalIcon className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      collisionPadding={12}
                      className="w-[240px] max-w-[calc(100vw-24px)]"
                    >
                      <DropdownMenuItem
                        disabled={context.locked}
                        onSelect={() => context.onMoveNode(node.uuid, null)}
                      >
                        Вне папки {!parent ? '✓' : ''}
                      </DropdownMenuItem>
                      {context.folders.map((folder) => (
                        <DropdownMenuItem
                          key={folder.id}
                          disabled={context.locked}
                          onSelect={() => context.onMoveNode(node.uuid, folder.id)}
                        >
                          <FolderIcon />
                          {folder.name} {parent?.folderId === folder.id ? '✓' : ''}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </li>
  );
});

export function NodeInventory({
  toolbar,
  nodes,
  allNodes,
  stale,
  onSelect,
  searching,
}: {
  toolbar: ReactNode;
  nodes: RemnawaveNode[];
  allNodes: RemnawaveNode[];
  stale: boolean;
  onSelect: (id: string) => void;
  searching: boolean;
}) {
  const query = useNodeLayout();
  const save = useSaveNodeLayout();
  const incidents = useIncidents('open');
  const disabledHosts = useDisabledHosts();
  const layout = query.data ?? empty;
  const [draft, setDraft] = useState<NodeLayout | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [entering, setEntering] = useState<Set<string>>(() => new Set());
  const [closing, setClosing] = useState<Set<string>>(() => new Set());
  const [dragging, setDragging] = useState(false);
  const saving = useRef(false);
  const queued = useRef<NodeLayout | null>(null);
  const savedRef = useRef(layout);
  savedRef.current = layout;
  const value = draft ?? layout;
  const valueRef = useRef(value);
  valueRef.current = value;
  const allNodesRef = useRef(allNodes);
  allNodesRef.current = allNodes;
  const visible = useMemo(() => new Set(nodes.map((node) => node.uuid)), [nodes]);
  const nodeMap = useMemo(() => new Map(allNodes.map((node) => [node.uuid, node])), [allNodes]);
  const hostsOffMap = useMemo(
    () => new Map((disabledHosts.data?.items ?? []).map((i) => [i.nodeUuid, i])),
    [disabledHosts.data],
  );
  const incidentMap = useMemo(() => {
    const map = new Map<string, NodeIncident>();
    for (const i of incidents.data?.items ?? []) {
      if (i.status === 'resolved' || !i.nodeUuid) continue;
      const node = nodeMap.get(i.nodeUuid);
      const title =
        node && i.title.endsWith(` · ${node.name}`) ? i.title.slice(0, -` · ${node.name}`.length) : i.title;
      const tone = i.severity === 'crit' ? 'crit' : 'warn';
      if (!map.has(i.nodeUuid) || tone === 'crit') map.set(i.nodeUuid, { title, tone });
    }
    return map;
  }, [incidents.data, nodeMap]);
  // Дерево зависит только от состава нод и их имён: опрос раз в 15 секунд с новыми цифрами его не пересобирает.
  const shapeKey = allNodes.map((n) => `${n.uuid}:${n.name}`).join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: allNodes учтён через shapeKey — пересобираем дерево только при смене состава
  const liveTree = useMemo(() => layoutToTree(value, allNodes, searching), [value, shapeKey, searching]);
  // Пока строку тянут, дерево не трогаем вовсе.
  const frozen = useRef(liveTree);
  if (!dragging) frozen.current = liveTree;
  const treeItems = dragging ? frozen.current : liveTree;
  const locked = query.isPending || query.isError;

  /** Экран меняется сразу; сохранение идёт в фоне и по очереди — вторая правка не теряется и ничего не мигает. */
  const persist = useCallback(
    async (next: NodeLayout) => {
      setDraft(next);
      setError('');
      if (saving.current) {
        queued.current = next;
        return;
      }
      saving.current = true;
      let current: NodeLayout | null = next;
      try {
        while (current) {
          queued.current = null;
          if (!sameLayout(current, savedRef.current)) await save.mutateAsync(current);
          current = queued.current;
        }
        setDraft(null);
      } catch (cause) {
        queued.current = null;
        setError(apiErrorMessage(cause));
        setDraft(null);
      } finally {
        saving.current = false;
      }
    },
    [save],
  );

  const handleTreeChange = useCallback(
    (nextTree: TreeItems<NodeTreeData>) => {
      void persist(treeToLayout(valueRef.current, allNodesRef.current, nextTree));
    },
    [persist],
  );

  const timers = useRef<number[]>([]);
  useEffect(
    () => () => {
      for (const t of timers.current) window.clearTimeout(t);
    },
    [],
  );
  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  }, []);

  const toggleFolder = useCallback(
    (folderId: string) => {
      const source = valueRef.current;
      const isCollapsed = source.collapsedFolders.includes(folderId);
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      const setCollapsed = (collapsed: boolean) => {
        const current = valueRef.current;
        const rest = current.collapsedFolders.filter((id) => id !== folderId);
        void persist({ ...current, collapsedFolders: collapsed ? [...rest, folderId] : rest });
      };
      if (isCollapsed) {
        // Открытие: папка открывается сразу, строки появляются за 0,17 с.
        const ids = scopedNodeIds(
          source,
          allNodesRef.current.map((n) => n.uuid),
          folderId,
        );
        if (!reduce) {
          setEntering((cur) => new Set([...cur, ...ids]));
          later(
            () => setEntering((cur) => new Set([...cur].filter((id) => !ids.includes(id)))),
            FOLDER_MS + 40,
          );
        }
        setCollapsed(false);
        return;
      }
      if (reduce) {
        setCollapsed(true);
        return;
      }
      // Закрытие в две фазы: сначала строки сжимаются, потом папка закрывается.
      setClosing((cur) => new Set(cur).add(folderId));
      later(() => {
        setCollapsed(true);
        setClosing((cur) => {
          const next = new Set(cur);
          next.delete(folderId);
          return next;
        });
      }, FOLDER_MS);
    },
    [persist, later],
  );

  const moveFromMenu = useCallback(
    (nodeId: string, folderId: string | null) => {
      const source = valueRef.current;
      const ids = allNodesRef.current.map((node) => node.uuid);
      const next = folderId
        ? moveNodeInLayout(source, ids, nodeId, {
            folder: folderId,
            index: scopedNodeIds(source, ids, folderId).length,
          })
        : moveNodeInLayout(source, ids, nodeId, {
            folder: null,
            rootIndex: normalizedRootIds(source, ids, nodeId).length,
          });
      void persist(next);
    },
    [persist],
  );

  const deleteFolder = useCallback(
    (folderId: string) => {
      const source = valueRef.current;
      const ids = allNodesRef.current.map((node) => node.uuid);
      const groups = layoutToSortableGroups(source, ids);
      const rootId = nodeFolderId(folderId);
      const children = groups[nodeFolderGroup(folderId)] ?? [];
      const at = groups[ROOT_NODE_GROUP].indexOf(rootId);
      groups[ROOT_NODE_GROUP].splice(
        at < 0 ? groups[ROOT_NODE_GROUP].length : at,
        at < 0 ? 0 : 1,
        ...children,
      );
      delete groups[nodeFolderGroup(folderId)];
      const nextSource = {
        ...source,
        folders: source.folders.filter((folder) => folder.id !== folderId),
        collapsedFolders: source.collapsedFolders.filter((id) => id !== folderId),
      };
      void persist(sortableGroupsToLayout(nextSource, ids, groups));
    },
    [persist],
  );

  const treeContext = useMemo<NodeTreeContextValue>(
    () => ({
      nodes: nodeMap,
      incidents: incidentMap,
      hostsOff: hostsOffMap,
      folders: value.folders,
      stale,
      locked,
      searching,
      visible,
      entering,
      closing,
      onSelect,
      onToggleFolder: toggleFolder,
      onMoveNode: moveFromMenu,
      onEditFolder: setEditing,
      onDeleteFolder: deleteFolder,
    }),
    [
      nodeMap,
      incidentMap,
      hostsOffMap,
      value.folders,
      stale,
      locked,
      searching,
      visible,
      entering,
      closing,
      onSelect,
      toggleFolder,
      moveFromMenu,
      deleteFolder,
    ],
  );

  return (
    <div className="px-4 pb-4">
      <div className="my-4 flex flex-wrap items-center gap-2">
        {toolbar}
        <Button
          variant="outline"
          disabled={locked}
          className="h-10 shrink-0 rounded-[10px] text-[12px]"
          onClick={() => setEditing({ id: randomId(), name: '' })}
        >
          <FolderPlusIcon className="size-3.5" />
          Новая папка
        </Button>
      </div>
      {(error || query.isError) && (
        <p role="alert" className="mb-3 text-[12px] text-crit">
          {error || 'Не удалось загрузить порядок нод.'}
        </p>
      )}
      {query.isPending ? (
        <NodeTreeSkeleton />
      ) : (
        <NodeTreeContext.Provider value={treeContext}>
          <div data-node-tree className="-my-1.5">
            <SortableTree
              items={treeItems}
              onItemsChanged={handleTreeChange}
              TreeItemComponent={NodeTreeItem}
              indentationWidth={12}
              pointerSensorOptions={{ activationConstraint: { distance: 6 } }}
              disableSorting={searching || locked}
              label={(item) => item.label}
              onDraggingChange={setDragging}
            />
          </div>
        </NodeTreeContext.Provider>
      )}
      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="rounded-2xl sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>
              {value.folders.some((folder) => folder.id === editing?.id) ? 'Название папки' : 'Новая папка'}
            </DialogTitle>
            <DialogDescription>Группировка нод только в этой панели.</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!editing?.name.trim()) return;
              const folder = { ...editing, name: editing.name.trim() };
              const exists = value.folders.some((item) => item.id === folder.id);
              void persist({
                ...value,
                folders: exists
                  ? value.folders.map((item) => (item.id === folder.id ? folder : item))
                  : [...value.folders, folder],
                rootOrder: exists ? value.rootOrder : [nodeFolderId(folder.id), ...value.rootOrder],
              });
              setEditing(null);
            }}
          >
            <Input
              autoFocus
              aria-label="Название папки"
              maxLength={60}
              value={editing?.name ?? ''}
              onChange={(event) =>
                setEditing((current) => (current ? { ...current, name: event.target.value } : current))
              }
            />
            <div className="mt-4 flex justify-end">
              <Button type="submit" disabled={locked || !editing?.name.trim()}>
                Сохранить
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Пока не пришёл порядок и папки, — силуэт папки со строками той же сетки, что у карточки ноды: без мелькания
 * плоского списка, который через мгновение раскладывается по папкам.
 */
export function NodeTreeSkeleton() {
  return (
    <div role="status" aria-label="Загрузка нод" className="@container/nodes flex flex-col gap-2">
      <div className="flex h-11 items-center gap-3 px-2">
        <Skeleton className="size-4 rounded-[5px]" />
        <Skeleton className="h-3.5 w-40" />
        <Skeleton className="ml-auto h-3 w-24" />
      </div>
      {[1, 2, 3].map((row) => (
        <div
          key={row}
          className="grid grid-cols-2 items-center gap-x-5 gap-y-3 rounded-[10px] border border-border py-3 pr-12 pl-9 @min-[720px]/nodes:grid-cols-[minmax(0,1.6fr)_72px_minmax(0,1fr)_minmax(0,1fr)] @min-[1000px]/nodes:grid-cols-[minmax(0,1.7fr)_80px_minmax(0,1fr)_minmax(0,1fr)_120px_84px]"
        >
          <div className="col-span-2 space-y-2 @min-[720px]/nodes:col-span-1">
            <Skeleton className="h-3.5 w-[55%]" />
            <Skeleton className="h-3 w-[70%]" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-2.5 w-[70%]" />
            <Skeleton className="h-3.5 w-[60%]" />
          </div>
          <Skeleton className="h-1.5 w-full rounded-full" />
          <Skeleton className="h-1.5 w-full rounded-full" />
          <Skeleton className="hidden h-3 w-[80%] @min-[1000px]/nodes:block" />
          <Skeleton className="hidden h-3 w-[70%] @min-[1000px]/nodes:block" />
        </div>
      ))}
    </div>
  );
}
