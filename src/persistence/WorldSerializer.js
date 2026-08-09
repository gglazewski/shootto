// WorldSerializer.js — pure JSON serialization of a World.
//
// The on-disk format is data-driven and versioned so future engines can
// load old maps:
//   { format: 'voxelmap', version: 1, cellSize: 0.5,
//     blocks: [{ x, y, z, size: 'small'|'big', type: <blockId> }, ...],
//     items: [{ itemId, x, y, z, cells: [w,h,d], rotation }, ...],
//     mobs: [{ type, x, y, z }, ...] }
// (item placements stored `size: 'small'|'big'` before cells footprints —
// the reader accepts both)
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
import { isNpcId } from '../engine/NpcRegistry.js';
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
      ...(v.variant ? { variant: v.variant } : {}),
    });
  });
  const items = [];
  world.forEachItem((it) => {
    items.push({
      itemId: it.itemId,
      x: it.anchor[0],
      y: it.anchor[1],
      z: it.anchor[2],
      cells: it.cells,
      rotation: it.rotation ?? 0,
    });
  });
  const spawn = world.spawn ? [...world.spawn] : null;
  const mobs = [];
  world.forEachMobSpawn((s) => mobs.push({ type: s.type, x: s.x, y: s.y, z: s.z }));
  // `npcs` is additive like `mobs`, and omitted when empty so untouched maps
  // stay byte-identical.
  const npcs = [];
  world.forEachNpcSpawn((s) => npcs.push({ type: s.type, x: s.x, y: s.y, z: s.z }));
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
  // `splashCams` is additive — authored menu-camera shots ride with the map.
  const splashCams = [];
  world.forEachSplashCam((c) => splashCams.push({
    id: c.id, pos: [...c.pos], yaw: c.yaw, pitch: c.pitch,
    ...(c.fov ? { fov: c.fov } : {}),
    ...(c.motion ? { motion: c.motion } : {}),
  }));
  return JSON.stringify({
    format: FORMAT, version: VERSION, cellSize: CELL_SIZE, spawn, spawnYaw: world.spawnYaw ?? 0,
    blocks, items, mobs, decals,
    ...(npcs.length ? { npcs } : {}),
    ...(textDecals.size ? { textDecals: [...textDecals.values()] } : {}),
    ...(splashCams.length ? { splashCams } : {}),
  }, null, 2);
}

/**
 * @returns {{world: World, errors: string[], fatal: boolean}}
 *   `fatal` = the file could not be read at all and the world is empty.
 *   Without it the errors are per-entry skips: the world holds everything
 *   that DID load, so callers must keep it rather than start over.
 */
export function deserialize(text) {
  const errors = [];
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { world: new World(), errors: [`Invalid JSON: ${e.message}`], fatal: true };
  }
  if (!data || data.format !== FORMAT) {
    return { world: new World(), errors: ['Not a voxelmap file'], fatal: true };
  }
  if (!Array.isArray(data.blocks)) {
    return { world: new World(), errors: ['Missing "blocks" array'], fatal: true };
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
    const size = b.size === SIZE.BIG || b.size === SIZE.DOOR || b.size === SIZE.DOOR3 ? b.size : SIZE.SMALL;
    try {
      assertValidBlockId(b.type);
    } catch (e) {
      errors.push(`Skipped block ${b.x},${b.y},${b.z}: ${e.message}`);
      continue;
    }
    const rotation = Number.isInteger(b.rotation) ? ((b.rotation % 4) + 4) % 4 : 0;
    // `variant` is additive like rotation — slab halves of cube blocks;
    // anything unrecognized loads as a full block.
    const variant = b.variant === 'lower' || b.variant === 'upper' ? b.variant : null;
    if (!world.place(b.type, size, b.x, b.y, b.z, rotation, variant)) {
      errors.push(`Skipped overlapping block ${b.x},${b.y},${b.z}`);
    }
  }
  if (Array.isArray(data.items)) {
    for (const it of data.items) {
      if (!it || typeof it.x !== 'number' || typeof it.y !== 'number' || typeof it.z !== 'number' || typeof it.itemId !== 'string') {
        errors.push('Skipped malformed item entry');
        continue;
      }
      // v2 placements carry a cells footprint; v1 stored 'small'/'big'
      // (placeItem coerces either via footprintCells).
      const cells = Array.isArray(it.cells) ? it.cells : it.size;
      if (!isItemId(it.itemId) && !isEquipId(it.itemId)) {
        errors.push(`Skipped item ${it.itemId} (not registered)`);
        continue;
      }
      const rotation = typeof it.rotation === 'number' ? it.rotation : 0;
      if (!world.placeItem(it.itemId, cells, it.x, it.y, it.z, rotation)) {
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
        errors.push(`Skipped decal ${d.id} at ${d.x},${d.y},${d.z}: no block face there`);
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
  if (Array.isArray(data.npcs)) {
    for (const n of data.npcs) {
      if (!n || typeof n.x !== 'number' || typeof n.y !== 'number' || typeof n.z !== 'number' || typeof n.type !== 'string') {
        errors.push('Skipped malformed NPC spawn');
        continue;
      }
      if (!isNpcId(n.type)) {
        errors.push(`Skipped NPC spawn ${n.type} (not registered)`);
        continue;
      }
      if (!world.addNpcSpawn(n.type, n.x, n.y, n.z)) {
        errors.push(`Skipped duplicate NPC spawn at ${n.x},${n.y},${n.z}`);
      }
    }
  }
  if (Array.isArray(data.splashCams)) {
    for (const c of data.splashCams) {
      const posOk = Array.isArray(c?.pos) && c.pos.length === 3 && c.pos.every((n) => Number.isFinite(n));
      if (!c || typeof c.id !== 'string' || !posOk || !Number.isFinite(c.yaw) || !Number.isFinite(c.pitch)) {
        errors.push('Skipped malformed splash camera');
        continue;
      }
      if (!world.addSplashCam({
        id: c.id, pos: [...c.pos], yaw: c.yaw, pitch: c.pitch,
        ...(Number.isFinite(c.fov) ? { fov: c.fov } : {}),
        ...(typeof c.motion === 'string' ? { motion: c.motion } : {}),
      })) {
        errors.push(`Skipped duplicate splash camera ${c.id}`);
      }
    }
  }
  return { world, errors };
}
