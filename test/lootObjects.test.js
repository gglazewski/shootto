import { test } from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/engine/World.js';
import { SIZE } from '../src/engine/VoxelTypes.js';
import { registerItem } from '../src/engine/ItemRegistry.js';
import { serialize, deserialize } from '../src/persistence/WorldSerializer.js';
import { removeItemCommand } from '../src/editor/commands.js';

// Search-loot settings on placed objects (containers): the `loot` config
// rides the placement record through place, copy, undo and the map file.

test('placeItem carries search-loot settings onto the record', () => {
  const world = new World();
  registerItem({ id: 'bin', name: 'Garbage Can', cells: SIZE.SMALL, microVoxels: [] });
  assert.ok(world.placeItem('bin', SIZE.SMALL, 0, 0, 0, 0, { loot: { pool: ['crowbar'], reset: 30 } }));
  const it = world.itemAt(0, 0, 0);
  assert.deepEqual(it.loot, { pool: ['crowbar'], reset: 30 });
  // plain placement stays scenery — no loot field at all
  assert.ok(world.placeItem('bin', SIZE.SMALL, 2, 0, 0));
  assert.equal('loot' in world.itemAt(2, 0, 0), false);
  // default pool + no restock normalizes to nulls
  assert.ok(world.placeItem('bin', SIZE.SMALL, 4, 0, 0, 0, { loot: {} }));
  assert.deepEqual(world.itemAt(4, 0, 0).loot, { pool: null, reset: null });
});

test('copyFrom preserves container settings', () => {
  const world = new World();
  registerItem({ id: 'crate2', name: 'Crate', cells: SIZE.SMALL, microVoxels: [] });
  world.placeItem('crate2', SIZE.SMALL, 1, 0, 1, 0, { loot: { pool: null, reset: 12 } });
  const copy = new World();
  copy.copyFrom(world);
  assert.deepEqual(copy.itemAt(1, 0, 1).loot, { pool: null, reset: 12 });
});

test('serializer round-trips container settings and omits them when unset', () => {
  const world = new World();
  registerItem({ id: 'shelf', name: 'Shelf', cells: SIZE.SMALL, microVoxels: [] });
  world.placeItem('shelf', SIZE.SMALL, 0, 0, 0, 0, { loot: { pool: ['pipe', 'scrap'], reset: null } });
  world.placeItem('shelf', SIZE.SMALL, 3, 0, 0);
  const text = serialize(world);
  const { world: loaded, errors } = deserialize(text);
  assert.deepEqual(errors, []);
  assert.deepEqual(loaded.itemAt(0, 0, 0).loot, { pool: ['pipe', 'scrap'], reset: null });
  assert.equal('loot' in loaded.itemAt(3, 0, 0), false);
  // untouched placements stay byte-identical — no loot key in the JSON
  assert.equal(JSON.parse(text).items.find((i) => i.x === 3).loot, undefined);
});

test('removeItemCommand undo restores the loot settings', () => {
  const world = new World();
  registerItem({ id: 'locker', name: 'Locker', cells: SIZE.SMALL, microVoxels: [] });
  world.placeItem('locker', SIZE.SMALL, 0, 0, 0, 0, { loot: { pool: null, reset: 45 } });
  const cmd = removeItemCommand(world, world.itemAt(0, 0, 0));
  assert.ok(cmd.do());
  assert.equal(world.itemAt(0, 0, 0), null);
  cmd.undo();
  assert.deepEqual(world.itemAt(0, 0, 0).loot, { pool: null, reset: 45 });
});
