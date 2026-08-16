import { test } from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/engine/World.js';
import { SIZE } from '../src/engine/VoxelTypes.js';
import { registerItem } from '../src/engine/ItemRegistry.js';
import { collectSparse } from '../src/persistence/WorldSerializer.js';
import {
  MemorySaveStore, makeSave, manualSlotKey, diffPickedUp, SAVE_FORMAT, SAVE_VERSION,
} from '../src/persistence/SaveStore.js';
import { importLegacySlots } from '../src/persistence/LegacySaves.js';
import { writeSlot, makeSlot, slotKey } from '../src/game/SaveSlots.js';

// SaveStore: async slot storage (IndexedDB in the browser, this memory fake
// in tests), the pickup-tombstone diff that v3 saves store instead of any
// world data, and the one-time import of legacy v1 localStorage slots.

function storageStub() {
  const map = new Map();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    has: (k) => map.has(k),
  };
}

test('MemorySaveStore round-trips payload and meta, lists and removes', async () => {
  const store = new MemorySaveStore();
  assert.equal(await store.read('slot0'), null);
  assert.equal(await store.readMeta('slot0'), null);

  const payload = makeSave({ pickedUp: [], player: { x: 1 }, stats: { hp: 80 } });
  assert.equal(payload.format, SAVE_FORMAT);
  assert.equal(payload.version, SAVE_VERSION);

  await store.write('slot0', payload, { savedAt: payload.savedAt });
  assert.equal((await store.read('slot0')).stats.hp, 80);
  assert.equal((await store.readMeta('slot0')).savedAt, payload.savedAt);
  assert.deepEqual(await store.list(), [{ slot: 'slot0', savedAt: payload.savedAt }]);

  await store.remove('slot0');
  assert.equal(await store.read('slot0'), null);
  assert.deepEqual(await store.list(), []);
});

test('diffPickedUp finds map objects missing from the live world, by id + anchor', () => {
  registerItem({ id: 'ss_can', name: 'Can', cells: SIZE.SMALL, microVoxels: [] });
  const base = new World();
  base.placeItem('ss_can', SIZE.SMALL, 0, 0, 0);
  base.placeItem('ss_can', SIZE.SMALL, 2, 0, 0);
  base.placeItem('ss_can', SIZE.SMALL, 4, 0, 0);
  const baseItems = collectSparse(base).items;

  // player picked up the middle can
  base.removeItemAt(2, 0, 0);
  const picked = diffPickedUp(baseItems, collectSparse(base).items);
  assert.deepEqual(picked, [{ itemId: 'ss_can', x: 2, y: 0, z: 0 }]);

  // nothing picked up -> empty diff; everything picked up -> full list
  assert.deepEqual(diffPickedUp(baseItems, baseItems), []);
  assert.equal(diffPickedUp(baseItems, []).length, 3);
});

test('legacy v1 slots import as v3 saves (state only) and free localStorage', async () => {
  const storage = storageStub();
  const legacy = makeSlot({
    bundle: '{"whatever":"the bundle is dropped — the world is static"}',
    player: { x: 1, y: 2, z: 3, yaw: 0.5, pitch: 0 },
    stats: { hp: 42 },
    containers: { '0,0,0': { materials: { scrap: 1 }, items: [] } },
  });
  legacy.savedAt = 12345;
  writeSlot(1, legacy, storage);

  const store = new MemorySaveStore();
  assert.equal(await importLegacySlots(storage, store), 1);

  const imported = await store.read(manualSlotKey(1));
  assert.equal(imported.format, SAVE_FORMAT);
  assert.equal(imported.version, SAVE_VERSION);
  assert.deepEqual(imported.pickedUp, [], 'no world data — pickups respawn once');
  assert.equal('bundle' in imported, false);
  assert.equal(imported.savedAt, 12345, 'original save time survives');
  assert.deepEqual(imported.player, { x: 1, y: 2, z: 3, yaw: 0.5, pitch: 0 });
  assert.equal(imported.stats.hp, 42);
  assert.deepEqual(imported.containers, { '0,0,0': { materials: { scrap: 1 }, items: [] } });
  assert.equal(storage.has(slotKey(1)), false, 'legacy key removed, quota freed');
  // second run is a no-op
  assert.equal(await importLegacySlots(storage, store), 0);
});

test('a legacy slot never clobbers an existing save, but still frees quota', async () => {
  const storage = storageStub();
  writeSlot(0, makeSlot({ bundle: '{}', player: null, stats: {} }), storage);

  const store = new MemorySaveStore();
  const newer = makeSave({ player: null, stats: { hp: 99 } });
  await store.write(manualSlotKey(0), newer, { savedAt: newer.savedAt });

  assert.equal(await importLegacySlots(storage, store), 0);
  assert.equal((await store.read(manualSlotKey(0))).stats.hp, 99);
  assert.equal(storage.has(slotKey(0)), false);
});

test('unreadable legacy slots are skipped and left in place', async () => {
  const storage = storageStub();
  storage.setItem(slotKey(0), 'not json at all');

  const store = new MemorySaveStore();
  assert.equal(await importLegacySlots(storage, store), 0);
  assert.equal(await store.read(manualSlotKey(0)), null);
  assert.equal(storage.has(slotKey(0)), true);
});
