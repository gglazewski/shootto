import { test } from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/engine/World.js';
import { SIZE } from '../src/engine/VoxelTypes.js';
import { registerItem } from '../src/engine/ItemRegistry.js';
import { serialize, deserialize } from '../src/persistence/WorldSerializer.js';
import { removeItemCommand } from '../src/editor/commands.js';
import { ContainerStore } from '../src/game/ContainerStore.js';
import { makeSlot } from '../src/game/SaveSlots.js';

// Storage containers: the `storage` flag rides the placement record through
// place, copy, undo and the map file; a ContainerStore holds each stash's
// contents at runtime and round-trips through save slots.

test('placeItem carries the storage flag onto the record', () => {
  const world = new World();
  registerItem({ id: 'chest', name: 'Chest', cells: SIZE.SMALL, microVoxels: [] });
  assert.ok(world.placeItem('chest', SIZE.SMALL, 0, 0, 0, 0, { storage: true }));
  assert.equal(world.itemAt(0, 0, 0).storage, true);
  // plain placement stays scenery — no storage field at all
  assert.ok(world.placeItem('chest', SIZE.SMALL, 2, 0, 0));
  assert.equal('storage' in world.itemAt(2, 0, 0), false);
  // anything but `true` is ignored (malformed data can't mark a container)
  assert.ok(world.placeItem('chest', SIZE.SMALL, 4, 0, 0, 0, { storage: 'yes' }));
  assert.equal('storage' in world.itemAt(4, 0, 0), false);
});

test('copyFrom preserves the storage flag', () => {
  const world = new World();
  registerItem({ id: 'wardrobe', name: 'Wardrobe', cells: SIZE.SMALL, microVoxels: [] });
  world.placeItem('wardrobe', SIZE.SMALL, 1, 0, 1, 0, { storage: true });
  const copy = new World();
  copy.copyFrom(world);
  assert.equal(copy.itemAt(1, 0, 1).storage, true);
});

test('serializer round-trips the storage flag and omits it when unset', () => {
  const world = new World();
  registerItem({ id: 'cabinet', name: 'Cabinet', cells: SIZE.SMALL, microVoxels: [] });
  world.placeItem('cabinet', SIZE.SMALL, 0, 0, 0, 0, { storage: true });
  world.placeItem('cabinet', SIZE.SMALL, 3, 0, 0);
  const text = serialize(world);
  const { world: loaded, errors } = deserialize(text);
  assert.deepEqual(errors, []);
  assert.equal(loaded.itemAt(0, 0, 0).storage, true);
  assert.equal('storage' in loaded.itemAt(3, 0, 0), false);
  // untouched placements stay byte-identical — no storage key in the JSON
  assert.equal(JSON.parse(text).items.find((i) => i.x === 3).storage, undefined);
});

test('removeItemCommand undo restores the storage flag', () => {
  const world = new World();
  registerItem({ id: 'trunk', name: 'Trunk', cells: SIZE.SMALL, microVoxels: [] });
  world.placeItem('trunk', SIZE.SMALL, 0, 0, 0, 0, { storage: true });
  const cmd = removeItemCommand(world, world.itemAt(0, 0, 0));
  assert.ok(cmd.do());
  assert.equal(world.itemAt(0, 0, 0), null);
  cmd.undo();
  assert.equal(world.itemAt(0, 0, 0).storage, true);
});

test('ContainerStore stashes materials and items per container', () => {
  const store = new ContainerStore();
  assert.equal(store.addMaterial('0,0,0', 'scrap', 3), 3);
  assert.equal(store.addMaterial('0,0,0', 'scrap', 2), 5);
  assert.ok(store.stow('0,0,0', 'crowbar', 2, 1));
  // a different anchor is a different stash
  assert.deepEqual(store.open('9,0,9'), { materials: {}, items: [] });
  assert.equal(store.takeMaterial('0,0,0', 'scrap', 2), 2);
  // taking more than stored drains the pile and drops the key
  assert.equal(store.takeMaterial('0,0,0', 'scrap', 99), 3);
  assert.equal('scrap' in store.open('0,0,0').materials, false);
  // items come back out with their condition intact
  assert.deepEqual(store.take('0,0,0', 0), { id: 'crowbar', wear: 2, decay: 1 });
  assert.equal(store.take('0,0,0', 0), null);
});

test('ContainerStore serialize drops empty containers and round-trips', () => {
  const store = new ContainerStore();
  store.open('1,2,3'); // opened but never filled — must not persist
  store.addMaterial('4,5,6', 'tape', 7);
  store.stow('4,5,6', 'pipe', 1, 0);
  const data = store.serialize();
  assert.deepEqual(Object.keys(data), ['4,5,6']);
  const loaded = ContainerStore.deserialize(JSON.parse(JSON.stringify(data)));
  assert.deepEqual(loaded.open('4,5,6'), {
    materials: { tape: 7 },
    items: [{ id: 'pipe', wear: 1, decay: 0 }],
  });
});

test('ContainerStore.deserialize survives missing and malformed data', () => {
  assert.deepEqual(ContainerStore.deserialize(null).serialize(), {});
  assert.deepEqual(ContainerStore.deserialize('junk').serialize(), {});
  const messy = ContainerStore.deserialize({
    '0,0,0': { materials: { scrap: '4', bad: -1, worse: 'x' }, items: ['knife', { id: 'bat', wear: '2' }, {}, null] },
    '1,1,1': null,
  });
  assert.deepEqual(messy.open('0,0,0'), {
    materials: { scrap: 4 },
    items: [{ id: 'knife', wear: 0, decay: 0 }, { id: 'bat', wear: 2, decay: 0 }],
  });
});

test('save slots carry the containers payload', () => {
  const slot = makeSlot({ bundle: {}, player: null, stats: {}, containers: { '0,0,0': { materials: { scrap: 1 }, items: [] } } });
  assert.deepEqual(slot.containers, { '0,0,0': { materials: { scrap: 1 }, items: [] } });
  // older saves without the field load as an empty store
  assert.equal(makeSlot({ bundle: {}, player: null, stats: {} }).containers, null);
});
