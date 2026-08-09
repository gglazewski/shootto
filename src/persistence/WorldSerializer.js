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
import { assertValidBlockId, getBlock, SIZE, isDecalId, FACES } from '../engine/VoxelTypes.js';
import { createTextDecal, textSpecOf } from '../engine/TextDecals.js';
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
    // rotation is additive and omitted when 0, so old readers and untouched
    // maps stay byte-identical. A blinking light caught in its dark phase is
    // normalized back to its lit id, an open door back to its closed id —
    // maps always store the canonical block.
    const def = getBlock(v.type);
    const type = def?.blinkOn ?? def?.doorClosed ?? v.type;
    blocks.push({
      x: v.anchor[0], y: v.anchor[1], z: v.anchor[2], size: v.size, type,
      ...(v.rotation ? { rotation: v.rotation } : {}),
    });
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
  // `decals` is additive — readers that ignore it still load the map.
  // Text signs also write their specs (`textDecals`) so a loading engine can
  // re-register the runtime decals the placements reference; the field is
  // omitted when no sign is placed, keeping untouched maps byte-identical.
  const decals = [];
  const textDecals = new Map();
  world.forEachDecal((d) => {
    decals.push({
      id: d.decalId, x: d.cell[0], y: d.cell[1], z: d.cell[2], face: d.face,
      ...(d.rotation ? { rotation: d.rotation } : {}),
    });
    const spec = textSpecOf(d.decalId);
    if (spec && !textDecals.has(d.decalId)) textDecals.set(d.decalId, { id: d.decalId, ...spec });
  });
  return JSON.stringify({
    format: FORMAT, version: VERSION, cellSize: CELL_SIZE, spawn, spawnYaw: world.spawnYaw ?? 0,
    blocks, items, mobs, decals,
    ...(textDecals.size ? { textDecals: [...textDecals.values()] } : {}),
  }, null, 2);
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
    const size = b.size === SIZE.BIG || b.size === SIZE.DOOR ? b.size : SIZE.SMALL;
    try {
      assertValidBlockId(b.type);
    } catch (e) {
      errors.push(`Skipped block ${b.x},${b.y},${b.z}: ${e.message}`);
      continue;
    }
    const rotation = Number.isInteger(b.rotation) ? ((b.rotation % 4) + 4) % 4 : 0;
    if (!world.place(b.type, size, b.x, b.y, b.z, rotation)) {
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
  // Re-register text sign decals BEFORE placing decals, so placements that
  // reference them pass the isDecalId check. Ids are pinned from the file:
  // a sign keeps its identity even if the hash scheme evolves.
  if (Array.isArray(data.textDecals)) {
    for (const t of data.textDecals) {
      if (!t || typeof t.id !== 'string' || typeof t.text !== 'string' || !/^decal_text_[a-z0-9]+$/.test(t.id)) {
        errors.push('Skipped malformed text decal definition');
        continue;
      }
      if (!createTextDecal(t, { id: t.id })) {
        errors.push(`Skipped text decal ${t.id}: empty text`);
      }
    }
  }
  if (Array.isArray(data.decals)) {
    for (const d of data.decals) {
      if (!d || typeof d.x !== 'number' || typeof d.y !== 'number' || typeof d.z !== 'number' || typeof d.id !== 'string') {
        errors.push('Skipped malformed decal entry');
        continue;
      }
      if (!isDecalId(d.id)) {
        errors.push(`Skipped decal ${d.id} (not registered)`);
        continue;
      }
      if (!FACES.includes(d.face)) {
        errors.push(`Skipped decal ${d.id} at ${d.x},${d.y},${d.z}: bad face "${d.face}"`);
        continue;
      }
      const rotation = Number.isInteger(d.rotation) ? ((d.rotation % 4) + 4) % 4 : 0;
      if (!world.placeDecal(d.id, d.x, d.y, d.z, d.face, rotation)) {
        errors.push(`Skipped decal ${d.id} at ${d.x},${d.y},${d.z}: no block there`);
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
