import { describe, expect, it } from 'vitest';
import { nodeLayoutSchema } from './remnawave.js';

const folder = '0192c000-0000-7000-8000-000000000001';
const node = '0192c000-0000-7000-8000-000000000002';
describe('local folder layout', () => {
  it('allows a folder after a node in the same root order', () => {
    expect(
      nodeLayoutSchema.parse({
        folders: [{ id: folder, name: 'Group' }],
        rootOrder: [node, `folder:${folder}`],
      }).rootOrder,
    ).toEqual([node, `folder:${folder}`]);
  });
  it('rejects dropping a folder into itself', () => {
    expect(
      nodeLayoutSchema.safeParse({
        folders: [{ id: folder, name: 'Group' }],
        placement: { [folder]: folder },
      }).success,
    ).toBe(false);
  });
  it('allows placing a node inside a folder', () => {
    expect(
      nodeLayoutSchema.safeParse({ folders: [{ id: folder, name: 'Group' }], placement: { [node]: folder } })
        .success,
    ).toBe(true);
  });
  it('stores the collapsed state only for existing folders', () => {
    expect(
      nodeLayoutSchema.parse({ folders: [{ id: folder, name: 'Group' }], collapsedFolders: [folder] })
        .collapsedFolders,
    ).toEqual([folder]);
    expect(nodeLayoutSchema.safeParse({ folders: [], collapsedFolders: [folder] }).success).toBe(false);
  });
});
