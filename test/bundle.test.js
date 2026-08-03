import { test } from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/engine/World.js';
import { SIZE } from '../src/engine/VoxelTypes.js';
import { registerItem, getItem, clearItems, isItemId } from '../src/engine/ItemRegistry.js';
import { serialize, deserialize } from '../src/persistence/WorldSerializer.js';
import { serializeBundle, deserializeBundle, BUNDLE_FORMAT } from '../src/persistence/WorldBundle.js';

test('bundle serializes a map and its item registry together', () => {
  clearItems();
  registerItem({ id: 'lamp', name: 'Lamp', size: 'small', microVoxels: [{ x: 0, y: 0, z: 0, color: [10, 20, 30] }], light: null });
  const world = new World();
  world.place('grass', SIZE.BIG, 0, 0, 0);
  world.placeItem('lamp', SIZE.SMALL, 0, 2, 0, Math.PI / 2);
  world.setSpawn(1, 4, 1);

  const text = serializeBundle(world);
  const data = JSON.parse(text);
  assert.equal(data.format, BUNDLE_FORMAT);
  assert.deepEqual(data.map, JSON.parse(serialize(world)), 'bundle must embed the plain map');
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].id, 'lamp');
});

test('bundle deserializes items first so the map can reference them', () => {
  clearItems();
  registerItem({ id: 'lamp', name: 'Lamp', size: 'small', microVoxels: [], light: null });
  const world = new World();
  world.place('grass', SIZE.BIG, 0, 0, 0);
  world.placeItem('lamp', SIZE.SMALL, 0, 2, 0);
  const text = serializeBundle(world);

  clearItems(); // bundle must re-register the object on load
  const { world: loaded, errors, itemCount } = deserializeBundle(text);
  assert.deepEqual(errors, []);
  assert.equal(itemCount, 1);
  assert.equal(isItemId('lamp'), true, 'bundle must register its objects');
  assert.equal(loaded.count, world.count);
  assert.equal(loaded.itemAt(0, 2, 0).itemId, 'lamp');
});

test('bundle without items still loads and reports zero item count', () => {
  clearItems();
  const world = new World();
  world.place('grass', SIZE.SMALL, 0, 0, 0);
  const { world: loaded, errors, itemCount } = deserializeBundle(serializeBundle(world));
  assert.deepEqual(errors, []);
  assert.equal(itemCount, 0);
  assert.equal(loaded.count, 1);
});

test('bundle rejects non-bundle input', () => {
  const { world, errors } = deserializeBundle('{"format":"voxelmap"}');
  assert.equal(world.count, 0);
  assert.ok(errors.some((e) => e.includes('voxelbundle')));
});

test('bundle with an unregistered item id skips it with a warning', () => {
  clearItems();
  const text = JSON.stringify({
    format: BUNDLE_FORMAT,
    version: 1,
    items: [],
    map: { format: 'voxelmap', version: 1, cellSize: 0.5, blocks: [], items: [{ itemId: 'nope', x: 0, y: 0, z: 0, size: 'small' }] },
  });
  const { world, errors } = deserializeBundle(text);
  assert.equal(world.count, 0);
  assert.ok(errors.some((e) => e.includes('nope')));
  clearItems();
});

test('plain map parse still works through bundle-free deserialize', () => {
  clearItems();
  const world = new World();
  world.place('grass', SIZE.SMALL, 0, 0, 0);
  const { world: loaded } = deserialize(serialize(world));
  assert.equal(loaded.count, 1);
  clearItems();
});

test('bundle round-trip keeps getItem consistent', () => {
  clearItems();
  registerItem({ id: 'post', name: 'Post', size: 'big', microVoxels: [], light: null });
  const world = new World();
  world.placeItem('post', SIZE.BIG, 4, 2, 4, Math.PI);
  deserializeBundle(serializeBundle(world));
  assert.equal(getItem('post').name, 'Post');
  clearItems();
});
