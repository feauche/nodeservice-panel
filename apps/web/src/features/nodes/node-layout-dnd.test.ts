import type { NodeLayout } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';
import {
  layoutToSortableGroups,
  moveNodeInLayout,
  nodeFolderGroup,
  nodeFolderId,
  ROOT_NODE_GROUP,
  sortableGroupsToLayout,
} from './node-layout-dnd';

const folderA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const folderB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const third = '33333333-3333-4333-8333-333333333333';
const nodeIds = [first, second, third];
const layout: NodeLayout = {
  folders: [
    { id: folderA, name: 'A' },
    { id: folderB, name: 'B' },
  ],
  order: [first, second, third],
  rootOrder: [nodeFolderId(folderA), second, nodeFolderId(folderB), third],
  placement: { [first]: folderA },
  collapsedFolders: [folderB],
};

describe('Remnawave-style sortable node groups', () => {
  it('maps the persisted layout to one root group and one group per folder', () => {
    expect(layoutToSortableGroups(layout, nodeIds)).toEqual({
      [ROOT_NODE_GROUP]: [nodeFolderId(folderA), second, nodeFolderId(folderB), third],
      [nodeFolderGroup(folderA)]: [first],
      [nodeFolderGroup(folderB)]: [],
    });
  });

  it('moves a folder exactly one adjacent root position', () => {
    const groups = layoutToSortableGroups(layout, nodeIds);
    groups[ROOT_NODE_GROUP] = [second, nodeFolderId(folderA), nodeFolderId(folderB), third];
    expect(sortableGroupsToLayout(layout, nodeIds, groups).rootOrder).toEqual([
      second,
      nodeFolderId(folderA),
      nodeFolderId(folderB),
      third,
    ]);
  });

  it('moves a node between two folders as a root item', () => {
    const groups = layoutToSortableGroups(layout, nodeIds);
    groups[nodeFolderGroup(folderA)] = [];
    groups[ROOT_NODE_GROUP] = [nodeFolderId(folderA), second, first, nodeFolderId(folderB), third];
    const result = sortableGroupsToLayout(layout, nodeIds, groups);
    expect(result.rootOrder).toEqual([nodeFolderId(folderA), second, first, nodeFolderId(folderB), third]);
    expect(result.placement[first]).toBeUndefined();
  });

  it('moves a root node to the exact position inside a folder', () => {
    const groups = layoutToSortableGroups(layout, nodeIds);
    groups[ROOT_NODE_GROUP] = [nodeFolderId(folderA), nodeFolderId(folderB), third];
    groups[nodeFolderGroup(folderA)] = [second, first];
    const result = sortableGroupsToLayout(layout, nodeIds, groups);
    expect(result.placement[second]).toBe(folderA);
    expect(result.order.filter((id) => result.placement[id] === folderA)).toEqual([second, first]);
  });

  it('keeps collapsed folder children out of root order', () => {
    const groups = layoutToSortableGroups(layout, nodeIds);
    groups[ROOT_NODE_GROUP] = [nodeFolderId(folderB), nodeFolderId(folderA), second, third];
    const result = sortableGroupsToLayout(layout, nodeIds, groups);
    expect(result.rootOrder).not.toContain(first);
    expect(result.placement[first]).toBe(folderA);
  });

  it('supports menu moves through the same group conversion', () => {
    const intoFolder = moveNodeInLayout(layout, nodeIds, third, { folder: folderA, index: 1 });
    expect(intoFolder.placement[third]).toBe(folderA);
    expect(intoFolder.order.filter((id) => intoFolder.placement[id] === folderA)).toEqual([first, third]);
    const backToRoot = moveNodeInLayout(intoFolder, nodeIds, third, { folder: null, rootIndex: 1 });
    expect(backToRoot.placement[third]).toBeUndefined();
    expect(backToRoot.rootOrder?.[1]).toBe(third);
  });
});
