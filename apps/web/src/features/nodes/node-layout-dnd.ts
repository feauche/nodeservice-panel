import type { NodeLayout } from '@nodeservice/shared';

export const ROOT_NODE_GROUP = 'node-layout:root';
export const nodeFolderId = (id: string) => `folder:${id}`;
export const nodeFolderGroup = (id: string) => `node-layout:folder:${id}`;
export const folderIdFromGroup = (id: string) =>
  id.startsWith('node-layout:folder:') ? id.slice('node-layout:folder:'.length) : null;

export type SortableNodeGroups = Record<string, string[]>;

function completeOrder(source: NodeLayout, nodeIds: readonly string[]) {
  const known = new Set(nodeIds);
  return [
    ...source.order.filter((id) => known.has(id)),
    ...nodeIds.filter((id) => !source.order.includes(id)),
  ];
}

export function scopedNodeIds(source: NodeLayout, nodeIds: readonly string[], folder: string | null) {
  return completeOrder(source, nodeIds).filter((id) => (source.placement[id] ?? null) === folder);
}

export function normalizedRootIds(source: NodeLayout, nodeIds: readonly string[], without?: string) {
  const candidates = [
    ...source.folders.map((folder) => nodeFolderId(folder.id)),
    ...scopedNodeIds(source, nodeIds, null),
  ].filter((id) => id !== without);
  return [
    ...(source.rootOrder ?? []).filter((id) => candidates.includes(id)),
    ...candidates.filter((id) => !(source.rootOrder ?? []).includes(id)),
  ];
}

export function layoutToSortableGroups(source: NodeLayout, nodeIds: readonly string[]): SortableNodeGroups {
  return Object.fromEntries([
    [ROOT_NODE_GROUP, normalizedRootIds(source, nodeIds)],
    ...source.folders.map((folder) => [
      nodeFolderGroup(folder.id),
      scopedNodeIds(source, nodeIds, folder.id),
    ]),
  ]);
}

export function sortableGroupsToLayout(
  source: NodeLayout,
  nodeIds: readonly string[],
  groups: SortableNodeGroups,
): NodeLayout {
  const knownNodes = new Set(nodeIds);
  const knownFolders = new Set(source.folders.map((folder) => folder.id));
  const seen = new Set<string>();
  const placement: Record<string, string> = {};
  const rootOrder = (groups[ROOT_NODE_GROUP] ?? []).filter((id) => {
    if (id.startsWith('folder:')) return knownFolders.has(id.slice(7));
    if (!knownNodes.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const order: string[] = [];
  for (const rootId of rootOrder) {
    if (!rootId.startsWith('folder:')) {
      order.push(rootId);
      continue;
    }
    const folderId = rootId.slice(7);
    for (const nodeId of groups[nodeFolderGroup(folderId)] ?? []) {
      if (!knownNodes.has(nodeId) || seen.has(nodeId)) continue;
      seen.add(nodeId);
      placement[nodeId] = folderId;
      order.push(nodeId);
    }
  }

  for (const folder of source.folders) {
    for (const nodeId of groups[nodeFolderGroup(folder.id)] ?? []) {
      if (!knownNodes.has(nodeId) || seen.has(nodeId)) continue;
      seen.add(nodeId);
      placement[nodeId] = folder.id;
      order.push(nodeId);
    }
  }

  for (const nodeId of nodeIds) {
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    rootOrder.push(nodeId);
    order.push(nodeId);
  }

  return { ...source, order, placement, rootOrder };
}

export function moveNodeInLayout(
  source: NodeLayout,
  nodeIds: readonly string[],
  id: string,
  destination: { folder: string; index: number } | { folder: null; rootIndex: number },
): NodeLayout {
  const groups = layoutToSortableGroups(source, nodeIds);
  for (const items of Object.values(groups)) {
    const index = items.indexOf(id);
    if (index >= 0) items.splice(index, 1);
  }
  const group = destination.folder === null ? ROOT_NODE_GROUP : nodeFolderGroup(destination.folder);
  const index = destination.folder === null ? destination.rootIndex : destination.index;
  groups[group] ??= [];
  groups[group].splice(Math.max(0, Math.min(index, groups[group].length)), 0, id);
  return sortableGroupsToLayout(source, nodeIds, groups);
}
