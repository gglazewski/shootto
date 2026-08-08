import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyEquipItem,
  normalizeGrid,
  serializeEquipItem,
  deserializeEquipItem,
  registerEquipItem,
  getEquipItem,
  clearEquipItems,
  DEFAULT_EQUIP_GRID,
  EQUIP_GRID_PRESETS,
  MIN_EQUIP_GRID,
  MAX_EQUIP_GRID,
} from '../src/engine/EquipmentRegistry.js';

test('a new equip item gets the default 8^3 build volume', () => {
  assert.deepEqual(emptyEquipItem().grid, [8, 8, 8]);
});

test('normalizeGrid clamps, rounds and falls back', () => {
  assert.deepEqual(normalizeGrid(undefined), [...DEFAULT_EQUIP_GRID]);
  assert.deepEqual(normalizeGrid([8, 8]), [...DEFAULT_EQUIP_GRID]);
  assert.deepEqual(normalizeGrid([2, 16.4, 99]), [MIN_EQUIP_GRID, 16, MAX_EQUIP_GRID]);
  assert.deepEqual(normalizeGrid(['a', 8, 8]), [8, 8, 8]);
});

test('grid presets are within the allowed range', () => {
  for (const p of EQUIP_GRID_PRESETS) {
    for (const g of p.dims) {
      assert.ok(g >= MIN_EQUIP_GRID && g <= MAX_EQUIP_GRID, `${p.id}: ${g}`);
    }
  }
});

test('serialize/deserialize round-trips a long weapon grid', () => {
  const item = emptyEquipItem('Pump Shotgun');
  item.id = 'pump_shotgun';
  item.grid = [8, 8, 16];
  item.microVoxels = [
    { x: 4, y: 4, z: 0, color: [40, 40, 44] },
    { x: 4, y: 4, z: 15, color: [90, 60, 30] },
  ];
  const { item: parsed, errors } = deserializeEquipItem(serializeEquipItem(item));
  assert.deepEqual(errors, []);
  assert.deepEqual(parsed.grid, [8, 8, 16]);
  assert.equal(parsed.microVoxels.length, 2);
});

test('files without a grid load as the classic 8^3 volume', () => {
  const legacy = JSON.stringify({
    format: 'voxelequip',
    version: 1,
    id: 'old_knife',
    name: 'Old Knife',
    kind: 'weapon',
    microVoxels: [{ x: 4, y: 4, z: 4, color: [200, 200, 210] }],
  });
  const { item, errors } = deserializeEquipItem(legacy);
  assert.deepEqual(errors, []);
  assert.deepEqual(item.grid, [8, 8, 8]);
  assert.equal(item.microVoxels.length, 1);
});

test('voxels outside the build volume are dropped on load', () => {
  const text = JSON.stringify({
    format: 'voxelequip',
    version: 1,
    id: 'broken',
    name: 'Broken',
    kind: 'weapon',
    grid: [8, 8, 8],
    microVoxels: [
      { x: 4, y: 4, z: 4, color: [1, 2, 3] },
      { x: 4, y: 4, z: 12, color: [1, 2, 3] }, // outside 8^3
    ],
  });
  const { item } = deserializeEquipItem(text);
  assert.equal(item.microVoxels.length, 1);
});

test('grip is clamped into the build volume on load', () => {
  const text = JSON.stringify({
    format: 'voxelequip',
    version: 1,
    id: 'clamped',
    name: 'Clamped',
    kind: 'weapon',
    grid: [8, 8, 8],
    microVoxels: [{ x: 1, y: 1, z: 1, color: [1, 2, 3] }],
    grip: { x: 20, y: -3, z: 4 },
  });
  const { item } = deserializeEquipItem(text);
  assert.deepEqual(item.grip, { x: 7, y: 0, z: 4 });
});

test('registry normalizes the grid on register', () => {
  clearEquipItems();
  registerEquipItem({ id: 'g1', name: 'G1', microVoxels: [], grid: [64, 8, 8] });
  assert.deepEqual(getEquipItem('g1').grid, [MAX_EQUIP_GRID, 8, 8]);
  clearEquipItems();
});
