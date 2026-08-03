// WorldSerializer.js — pure JSON serialization of a World.
//
// The on-disk format is data-driven and versioned so future engines can
// load old maps:
//   { format: 'voxelmap', version: 1, cellSize: 0.5,
//     blocks: [{ x, y, z, size: 'small'|'big', type: <blockId> }, ...],
//     items: [...], mobs: [{ type, x, y, z }, ...] }
//
// Only unique voxels (anchors) are written; sub-cells of BIG voxels are
// recomputed on load. `mobs` is an additive field — maps without it (and
// readers that ignore it) still load fine.

import { World } from '../engine/World.js';
import { assertValidBlockId, SIZE } from '../engine/VoxelTypes.js';
import { isItemId } from '../engine/ItemRegistry.js';
import { isEquipId } from '../engine/EquipmentRegistry.js';
import { isMobId } from '../engine/mobTypes.js';
import { CELL_SIZE } from '../engine/Space.js';

export const FORMAT = 'voxelmap';
export const VERSION = 1;

/** @returns {string} JSON text of the world. */
export function serialize(world) {
  const blocks = [];
  world.forEachVoxel((v) => {
    blocks.push({ x: v.anchor[0], y: v.anchor[1], z: v.anchor[2], size: v.size, type: v.type });
  });
  const items = [];
  world.forEachItem((it) => {
    items.push({
      itemId: it.itemId,
      x: it.anchor[0],
      y: it.anchor[1],
      z: it.anchor[2],
      size: it.size,
      rotation: it.rotation ?? 0,
    });
  });
  const spawn = world.spawn ? [...world.spawn] : null;
  const mobs = [];
  world.forEachMobSpawn((s) => mobs.push({ type: s.type, x: s.x, y: s.y, z: s.z }));
  return JSON.stringify({ format: FORMAT, version: VERSION, cellSize: CELL_SIZE, spawn, spawnYaw: world.spawnYaw ?? 0, blocks, items, mobs }, null, 2);
}

/** @returns {{world: World, errors: string[]}} */
export function deserialize(text) {
  const errors = [];
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { world: new World(), errors: [`Invalid JSON: ${e.message}`] };
  }
  if (!data || data.format !== FORMAT) {
    return { world: new World(), errors: ['Not a voxelmap file'] };
  }
  if (!Array.isArray(data.blocks)) {
    return { world: new World(), errors: ['Missing "blocks" array'] };
  }

  const world = new World();
  const spawn = data.spawn;
  if (Array.isArray(spawn) && spawn.length === 3 && spawn.every((n) => typeof n === 'number')) {
    world.setSpawn(spawn[0], spawn[1], spawn[2]);
    // Old maps carry no yaw — default to facing -Z, matching a fresh spawn.
    world.spawnYaw = typeof data.spawnYaw === 'number' && Number.isFinite(data.spawnYaw)
      ? ((data.spawnYaw % 360) + 360) % 360
      : 0;
  } else if (spawn != null) {
    errors.push('Skipped malformed spawn point');
  }
  for (const b of data.blocks) {
    if (!b || typeof b.x !== 'number' || typeof b.y !== 'number' || typeof b.z !== 'number') {
      errors.push('Skipped malformed block entry');
      continue;
    }
    const size = b.size === SIZE.BIG ? SIZE.BIG : SIZE.SMALL;
    try {
      assertValidBlockId(b.type);
    } catch (e) {
      errors.push(`Skipped block ${b.x},${b.y},${b.z}: ${e.message}`);
      continue;
    }
    if (!world.place(b.type, size, b.x, b.y, b.z)) {
      errors.push(`Skipped overlapping block ${b.x},${b.y},${b.z}`);
    }
  }
  if (Array.isArray(data.items)) {
    for (const it of data.items) {
      if (!it || typeof it.x !== 'number' || typeof it.y !== 'number' || typeof it.z !== 'number' || typeof it.itemId !== 'string') {
        errors.push('Skipped malformed item entry');
        continue;
      }
      const size = it.size === SIZE.BIG ? SIZE.BIG : SIZE.SMALL;
      if (!isItemId(it.itemId) && !isEquipId(it.itemId)) {
        errors.push(`Skipped item ${it.itemId} (not registered)`);
        continue;
      }
      const rotation = typeof it.rotation === 'number' ? it.rotation : 0;
      if (!world.placeItem(it.itemId, size, it.x, it.y, it.z, rotation)) {
        errors.push(`Skipped overlapping item ${it.itemId} at ${it.x},${it.y},${it.z}`);
      }
    }
  }
  if (Array.isArray(data.mobs)) {
    for (const m of data.mobs) {
      if (!m || typeof m.x !== 'number' || typeof m.y !== 'number' || typeof m.z !== 'number' || typeof m.type !== 'string') {
        errors.push('Skipped malformed mob spawn');
        continue;
      }
      if (!isMobId(m.type)) {
        errors.push(`Skipped mob spawn ${m.type} (not registered)`);
        continue;
      }
      if (!world.addMobSpawn(m.type, m.x, m.y, m.z)) {
        errors.push(`Skipped duplicate mob spawn at ${m.x},${m.y},${m.z}`);
      }
    }
  }
  return { world, errors };
}
