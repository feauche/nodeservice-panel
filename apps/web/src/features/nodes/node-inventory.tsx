import type { NodeLayout, RemnawaveNode } from '@nodeservice/shared';
import {
  SortableTree,
  type TreeItem,
  type TreeItemComponentProps,
  type TreeItems,
} from 'dnd-kit-sortable-tree';
import {
  ChevronDownIcon,
  FolderIcon,
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
import { apiErrorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
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

const empty: NodeLayout = { folders: [], order: [], placement: {}, rootOrder: [], collapsedFolders: [] };
const sameLayout = (a: NodeLayout, b: NodeLayout) => JSON.stringify(a) === JSON.stringify(b);

type NodeTreeData = {
  kind: 'folder' | 'node';
  folderId?: string;
  nodeId?: string;
  label: string;
};

type NodeTreeContextValue = {
  nodes: Map<string, RemnawaveNode>;
  folders: NodeLayout['folders'];
  stale: boolean;
  busy: boolean;
  searching: boolean;
  visible: Set<string>;
  onSelect: (id: string) => void;
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
  const collapsedFolders: string[] = [];
  const seenNodes = new Set<string>();
  const seenFolders = new Set<string>();

  const addRootNode = (item: TreeItem<NodeTreeData>) => {
    const nodeId = item.nodeId;
    if (!nodeId || !knownNodes.has(nodeId) || seenNodes.has(nodeId)) return;
    seenNodes.add(nodeId);
    rootOrder.push(nodeId);
    order.push(nodeId);
  };

  for (const item of tree) {
    if (item.kind !== 'folder') {
      addRootNode(item);
      continue;
    }
    const folderId = item.folderId;
    if (!folderId || !knownFolders.has(folderId) || seenFolders.has(folderId)) continue;
    seenFolders.add(folderId);
    rootOrder.push(nodeFolderId(folderId));
    if (item.collapsed) collapsedFolders.push(folderId);
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
    if (source.collapsedFolders.includes(folder.id)) collapsedFolders.push(folder.id);
    for (const nodeId of scopedNodeIds(source, nodeIds, folder.id)) {
      if (seenNodes.has(nodeId)) continue;
      seenNodes.add(nodeId);
      placement[nodeId] = folder.id;
      order.push(nodeId);
    }
  }
  for (const node of nodes) {
    if (seenNodes.has(node.uuid)) continue;
    seenNodes.add(node.uuid);
    rootOrder.push(node.uuid);
    order.push(node.uuid);
  }
  return { ...source, order, placement, rootOrder, collapsedFolders };
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
    onCollapse,
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
    clone && 'w-[min(1200px,calc(100vw-48px))] opacity-100 shadow-xl',
    disableInteraction && !clone && 'pointer-events-none',
  );
  const offset = clone ? 0 : depth * 12;

  if (item.kind === 'folder') {
    const folderId = item.folderId ?? '';
    const folder = context.folders.find((candidate) => candidate.id === folderId);
    if (!folder) return <li ref={wrapperRef} style={style} />;
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
            'flex items-center gap-2 rounded-xl border border-border bg-surface py-2.5 pr-3 pl-10',
          )}
          style={{ marginLeft: offset }}
        >
          {!clone && (
            <button
              type="button"
              disabled={context.busy}
              aria-label={`${collapsed ? 'Открыть' : 'Закрыть'} папку ${folder.name}`}
              aria-expanded={!collapsed}
              onClick={onCollapse}
              className="absolute inset-0 cursor-pointer rounded-xl"
            />
          )}
          <button
            type="button"
            {...handleProps}
            onClick={(event) => event.stopPropagation()}
            disabled={context.busy || context.searching}
            aria-label={`Переместить папку ${folder.name}`}
            className="absolute top-1/2 left-2 z-10 -translate-y-1/2 touch-none rounded p-1 text-text-3 hover:bg-surface-2 disabled:opacity-30"
          >
            <GripVerticalIcon className="size-4" />
          </button>
          <div className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-2.5 text-left text-[13px] font-medium">
            <ChevronDownIcon
              className={cn(
                'size-4 text-text-3 transition-transform duration-200',
                collapsed && '-rotate-90',
              )}
            />
            <FolderIcon className="size-4 text-brand" />
            <span className="truncate">{folder.name}</span>
            <span className="text-xs text-text-3">{childCount ?? 0}</span>
          </div>
          {!clone && !ghost && (
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={context.busy}
                aria-label={`Настройки папки ${folder.name}`}
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                className="relative z-10 rounded-lg p-1.5 text-text-3 hover:bg-surface-2"
              >
                <MoreHorizontalIcon className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                collisionPadding={12}
                className="w-[240px] max-w-[calc(100vw-24px)]"
              >
                <DropdownMenuItem disabled={context.busy} onSelect={() => context.onEditFolder(folder)}>
                  <PencilIcon />
                  Переименовать
                </DropdownMenuItem>
                <DropdownMenuItem disabled={context.busy} onSelect={() => context.onDeleteFolder(folder.id)}>
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
  return (
    <li
      ref={wrapperRef}
      style={style}
      data-tree-kind="node"
      data-tree-id={node.uuid}
      data-tree-parent={parent?.folderId ?? 'root'}
      className="list-none py-1.5"
    >
      <div ref={ref} className={common} style={{ marginLeft: offset }}>
        <NodeCard node={node} stale={context.stale} onClick={() => context.onSelect(node.uuid)} />
        {ghost && (
          <span className="pointer-events-none absolute top-2 right-10 z-20 rounded-md border border-brand/35 bg-surface/95 px-2 py-1 text-[10px] font-semibold text-brand shadow-sm">
            {targetFolder ? `В папку: ${targetFolder.name}` : 'Вне папки'}
          </span>
        )}
        <button
          type="button"
          {...handleProps}
          disabled={context.busy || context.searching}
          aria-label={`Переместить ${node.name}`}
          className="absolute top-1/2 left-1.5 z-10 -translate-y-1/2 touch-none rounded-md p-1 text-text-3 hover:bg-surface-2 hover:text-foreground disabled:opacity-30"
        >
          <GripVerticalIcon className="size-4" />
        </button>
        {!clone && !ghost && (
          <div className="absolute top-2 right-2">
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={`Папка ноды ${node.name}`}
                className="rounded-md p-1 text-text-3 hover:bg-surface-2"
              >
                <MoreHorizontalIcon className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                collisionPadding={12}
                className="w-[240px] max-w-[calc(100vw-24px)]"
              >
                <DropdownMenuItem
                  disabled={context.busy}
                  onSelect={() => context.onMoveNode(node.uuid, null)}
                >
                  Вне папки {!parent ? '✓' : ''}
                </DropdownMenuItem>
                {context.folders.map((folder) => (
                  <DropdownMenuItem
                    key={folder.id}
                    disabled={context.busy}
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
  const layout = query.data ?? empty;
  const [draft, setDraft] = useState<NodeLayout | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const saving = useRef(false);
  const value = draft ?? layout;
  const valueRef = useRef(value);
  valueRef.current = value;
  const allNodesRef = useRef(allNodes);
  allNodesRef.current = allNodes;
  const visible = useMemo(() => new Set(nodes.map((node) => node.uuid)), [nodes]);
  const nodeMap = useMemo(() => new Map(allNodes.map((node) => [node.uuid, node])), [allNodes]);
  const treeItems = useMemo(() => layoutToTree(value, allNodes, searching), [value, allNodes, searching]);
  const busy = save.isPending || query.isPending || query.isError;

  const persist = useCallback(
    async (next: NodeLayout) => {
      if (saving.current || sameLayout(next, query.data ?? empty)) {
        setDraft(null);
        return;
      }
      saving.current = true;
      setDraft(next);
      setError('');
      try {
        await save.mutateAsync(next);
        setDraft(null);
      } catch (cause) {
        setError(apiErrorMessage(cause));
        setDraft(null);
      } finally {
        saving.current = false;
      }
    },
    [query.data, save],
  );

  const handleTreeChange = useCallback(
    (nextTree: TreeItems<NodeTreeData>) => {
      void persist(treeToLayout(valueRef.current, allNodesRef.current, nextTree));
    },
    [persist],
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
      folders: value.folders,
      stale,
      busy,
      searching,
      visible,
      onSelect,
      onMoveNode: moveFromMenu,
      onEditFolder: setEditing,
      onDeleteFolder: deleteFolder,
    }),
    [nodeMap, value.folders, stale, busy, searching, visible, onSelect, moveFromMenu, deleteFolder],
  );

  return (
    <div className="px-4 pb-4">
      <div className="my-4 flex flex-wrap items-center gap-2">
        {toolbar}
        <Button
          variant="outline"
          disabled={busy}
          className="h-10 shrink-0 rounded-[10px] text-[12px]"
          onClick={() => setEditing({ id: crypto.randomUUID(), name: '' })}
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
      <NodeTreeContext.Provider value={treeContext}>
        <div data-node-tree className="-my-1.5">
          <SortableTree
            key={searching ? 'search' : 'sortable'}
            items={treeItems}
            onItemsChanged={handleTreeChange}
            TreeItemComponent={NodeTreeItem}
            indentationWidth={12}
            pointerSensorOptions={{ activationConstraint: { distance: 6 } }}
            disableSorting={searching}
            canRootHaveChildren
            {...({ manualDrag: true, hideCollapseButton: true, disableCollapseOnItemClick: true } as object)}
            dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.2,0,0,1)' }}
          />
        </div>
      </NodeTreeContext.Provider>
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
              <Button type="submit" disabled={busy || !editing?.name.trim()}>
                Сохранить
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
