import { test } from 'node:test';
import assert from 'node:assert/strict';

import { treeify } from '../src/editor/WorldBrowser.js';

test('treeify nests a flat listing into folders', () => {
  const tree = treeify([
    { path: 'campaign', type: 'folder' },
    { path: 'campaign/01-farm.json', type: 'world', size: 10, mtime: 5 },
    { path: 'campaign/02-village.json', type: 'world', size: 20, mtime: 6 },
    { path: 'loose.json', type: 'world', size: 1, mtime: 1 },
  ]);
  assert.deepEqual(tree.map((n) => [n.name, n.type]), [['campaign', 'folder'], ['loose.json', 'world']]);
  const campaign = tree[0];
  assert.deepEqual(campaign.children.map((n) => n.path), ['campaign/01-farm.json', 'campaign/02-village.json']);
  assert.equal(campaign.children[0].size, 10);
});

test('treeify sorts folders before worlds, both alphabetically', () => {
  const tree = treeify([
    { path: 'b.json', type: 'world' },
    { path: 'z', type: 'folder' },
    { path: 'a.json', type: 'world' },
  ]);
  assert.deepEqual(tree.map((n) => n.name), ['z', 'a.json', 'b.json']);
});

test('treeify keeps empty folders and infers missing parents', () => {
  const tree = treeify([
    { path: 'empty', type: 'folder' },
    // parent folder entry missing — must still nest correctly
    { path: 'implied/deep.json', type: 'world' },
  ]);
  assert.deepEqual(tree.map((n) => [n.name, n.type]), [['empty', 'folder'], ['implied', 'folder']]);
  assert.equal(tree[1].children[0].path, 'implied/deep.json');
});
