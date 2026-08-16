import { test } from 'node:test';
import assert from 'node:assert/strict';

import { objectToEquip, equipToObject, voxelBounds } from '../src/engine/itemConvert.js';
import { MICRO_GRID, MAX_ITEM_CELLS } from '../src/engine/ItemTypes.js';
import { MIN_EQUIP_GRID, MAX_EQUIP_GRID, registerEquipItem, clearEquipItems } from '../src/engine/EquipmentRegistry.js';
import { registerItem, clearItems } from '../src/engine/ItemRegistry.js';

const RED = [220, 40, 30];

/** Solid box of micro-voxels with its min corner at (ox, oy, oz). */
const box = (w, h, d, ox = 0, oy = 0, oz = 0) => {
  const out = [];
  for (let x = 0; x < w; x++)
    for (let y = 0; y < h; y++)
      for (let z = 0; z < d; z++) out.push({ x: ox + x, y: oy + y, z: oz + z, color: [...RED] });
  return out;
};

test('voxelBounds measures the tight box, null when empty', () => {
  assert.equal(voxelBounds([]), null);
  const b = voxelBounds(box(2, 3, 4, 5, 1, 0));
  assert.deepEqual(b.min, [5, 1, 0]);
  assert.deepEqual(b.dims, [2, 3, 4]);
});

test('object → equipment keeps every voxel and lands centred on the floor', () => {
  const veg = { id: 'veg_box', name: 'Veg Box', cells: [1, 1, 1], solid: true, microVoxels: box(2, 2, 2), light: null };
  const { item, dropped, lightLost } = objectToEquip(veg);

  assert.equal(dropped, 0);
  assert.equal(lightLost, false);
  assert.equal(item.id, null); // the caller assigns an id free in both registries
  assert.equal(item.name, 'Veg Box');
  assert.equal(item.kind, 'quest'); // pickable by default
  // The 2³ shape is smaller than the smallest legal build volume.
  assert.deepEqual(item.grid, [MIN_EQUIP_GRID, MIN_EQUIP_GRID, MIN_EQUIP_GRID]);
  assert.equal(item.microVoxels.length, 8);
  const b = voxelBounds(item.microVoxels);
  assert.deepEqual(b.dims, [2, 2, 2]);
  assert.deepEqual(b.min, [1, 0, 1]); // centred on x/z, resting on the floor
  assert.deepEqual(item.microVoxels[0].color, RED);
});

test('object → equipment shrinks the build volume to the sculpture', () => {
  // A shape built in the far corner of a 2×2×2-cell object volume.
  const src = { name: 'Crate', cells: [2, 2, 2], microVoxels: box(6, 10, 6, 8, 4, 8) };
  const { item, dropped } = objectToEquip(src);
  assert.equal(dropped, 0);
  assert.deepEqual(item.grid, [6, 10, 6]);
  assert.equal(item.microVoxels.length, 6 * 10 * 6);
});

test('object → equipment crops what will not fit the 32-cell volume', () => {
  // A 4 m long object (8 cells → 64 micro-voxels) overflows the equipment volume.
  const src = { name: 'Fence', cells: [MAX_ITEM_CELLS, 1, 1], microVoxels: box(64, 1, 1) };
  const { item, dropped } = objectToEquip(src);
  assert.deepEqual(item.grid, [MAX_EQUIP_GRID, MIN_EQUIP_GRID, MIN_EQUIP_GRID]);
  assert.equal(item.microVoxels.length, MAX_EQUIP_GRID);
  assert.equal(dropped, 64 - MAX_EQUIP_GRID);
  for (const v of item.microVoxels) assert.ok(v.x >= 0 && v.x < MAX_EQUIP_GRID);
});

test('object → equipment reports a dropped light (equipment carries none)', () => {
  const lamp = {
    name: 'Lamp',
    cells: [1, 1, 1],
    microVoxels: box(2, 2, 2),
    light: { x: 1, y: 1, z: 1, color: [255, 224, 178], strength: 3 },
  };
  const { item, lightLost } = objectToEquip(lamp);
  assert.equal(lightLost, true);
  assert.equal(item.light, undefined); // equipment defs have no light field
});

test('object → equipment honours an explicit kind', () => {
  const { item } = objectToEquip({ name: 'Scrap', microVoxels: box(1, 1, 1) }, { kind: 'material' });
  assert.equal(item.kind, 'material');
});

test('equipment → object picks the smallest whole-cell footprint', () => {
  const gun = { id: 'shotgun', name: 'Shotgun', kind: 'weapon', grid: [8, 8, 16], microVoxels: box(3, 3, 14) };
  const { item, dropped } = equipToObject(gun);

  assert.equal(dropped, 0);
  assert.equal(item.id, null);
  assert.equal(item.name, 'Shotgun');
  assert.equal(item.solid, true);
  assert.equal(item.light, null);
  // 3×3×14 micro-voxels → 1×1×2 cells of 8.
  assert.deepEqual(item.cells, [1, 1, 2]);
  assert.equal(item.microVoxels.length, 3 * 3 * 14);
  const b = voxelBounds(item.microVoxels);
  assert.deepEqual(b.min, [2, 0, 1]); // centred on x/z, resting on the floor
});

test('equipment → object can land traversable', () => {
  const { item } = equipToObject({ name: 'Knife', grid: [8, 8, 8], microVoxels: box(2, 2, 6) }, { solid: false });
  assert.equal(item.solid, false);
});

test('a round trip preserves the sculpture', () => {
  const src = { name: 'Axe', kind: 'weapon', grid: [8, 16, 8], microVoxels: box(4, 12, 3, 2, 1, 2) };
  const { item: asObject } = equipToObject(src);
  const { item: backToEquip, dropped } = objectToEquip(asObject);

  assert.equal(dropped, 0);
  assert.equal(backToEquip.microVoxels.length, src.microVoxels.length);
  assert.deepEqual(voxelBounds(backToEquip.microVoxels).dims, voxelBounds(src.microVoxels).dims);
  assert.deepEqual(backToEquip.grid, [4, 12, MIN_EQUIP_GRID]); // depth 3 clamps up to the min volume
});

test('converted defs survive registration in the target registry', () => {
  clearItems();
  clearEquipItems();

  const { item: equip } = objectToEquip({ name: 'Veg Box', cells: [1, 1, 1], microVoxels: box(3, 3, 3) });
  equip.id = 'veg_box_item';
  const stored = registerEquipItem(equip);
  assert.equal(stored.kind, 'quest');
  assert.deepEqual(stored.grid, [4, 4, 4]);
  assert.equal(stored.microVoxels.length, 27); // parse keeps every in-volume voxel

  const { item: object } = equipToObject(stored);
  object.id = 'veg_box_prop';
  const back = registerItem(object);
  assert.deepEqual(back.cells, [1, 1, 1]);
  assert.equal(back.microVoxels.length, 27);
  assert.equal(back.light, null);

  clearItems();
  clearEquipItems();
});

test('a converted object never exceeds its own build volume', () => {
  const { item } = objectToEquip({ name: 'Blob', cells: [3, 3, 3], microVoxels: box(20, 20, 20, 4, 4, 4) });
  const [gx, gy, gz] = item.grid;
  assert.ok(gx <= MAX_EQUIP_GRID && gy <= MAX_EQUIP_GRID && gz <= MAX_EQUIP_GRID);
  for (const v of item.microVoxels) {
    assert.ok(v.x >= 0 && v.x < gx && v.y >= 0 && v.y < gy && v.z >= 0 && v.z < gz);
  }
  const { item: obj } = equipToObject(item);
  const [cx, cy, cz] = obj.cells.map((c) => c * MICRO_GRID);
  for (const v of obj.microVoxels) {
    assert.ok(v.x >= 0 && v.x < cx && v.y >= 0 && v.y < cy && v.z >= 0 && v.z < cz);
  }
});
