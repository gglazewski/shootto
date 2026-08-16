// WorldSerializer.js — pure JSON serialization of a World.
//
// The on-disk format is data-driven and versioned so future engines can
// load old maps:
//   { format: 'voxelmap', version: 1, cellSize: 0.5,
//     blocks: [{ x, y, z, size: 'small'|'big', type: <blockId> }, ...],
//     items: [{ itemId, x, y, z, cells: [w,h,d], rotation, loot? }, ...],
//     mobs: [{ type, x, y, z }, ...] }
// (item placements stored `size: 'small'|'big'` before cells footprints —
// the reader accepts both)
//
// Only unique voxels (anchors) are written; sub-cells of BIG voxels are
// recomputed on load. `mobs` is an additive field — maps without it (and
// readers that ignore it) still load fine.

import { World } from '../engine/World.js';
import { assertValidBlockId, getBlock, SIZE, isDecalId, isBlockId, FACES } from '../engine/VoxelTypes.js';
import { createTextDecal, textSpecOf } from '../engine/TextDecals.js';
import { createPixelDecal, pixelSpecOf } from '../engine/PixelDecals.js';
import { isItemId } from '../engine/ItemRegistry.js';
import { isEquipId, getEquipItem } from '../engine/EquipmentRegistry.js';
import { layFlatCells } from '../engine/LayFlat.js';
import { isMobId } from '../engine/mobTypes.js';
import { isNpcId } from '../engine/NpcRegistry.js';
import { applyDoorSettings } from '../engine/Doors.js';
import { applyLightSettings, legacyLightSettings } from '../engine/Lights.js';
import { canonicalDecalId } from '../engine/Switches.js';
import { CELL_SIZE } from '../engine/Space.js';
import { aliasId } from './idAliases.js';

export const FORMAT = 'voxelmap';
export const VERSION = 1;

/** Everything in a world EXCEPT blocks and paint — the sections that stay
 *  small (dozens of entries) however big the map grows. Also the source of
 *  the object-placement lists that save-slot pickup tombstones diff against
 *  (SaveStore.diffPickedUp). */
export function collectSparse(world) {
  const items = [];
  world.forEachItem((it) => {
    // `loot` is additive — search-loot config on container objects (pool
    // omitted = default pool, reset omitted = never restocks).
    items.push({
      itemId: it.itemId,
      x: it.anchor[0],
      y: it.anchor[1],
      z: it.anchor[2],
      cells: it.cells,
      rotation: it.rotation ?? 0,
      ...(it.loot ? {
        loot: {
          ...(it.loot.pool ? { pool: [...it.loot.pool] } : {}),
          ...(it.loot.reset != null ? { reset: it.loot.reset } : {}),
        },
      } : {}),
      // `storage` is additive — a storage container the game opens as a
      // persistent stash (contents live in save slots, not the map).
      ...(it.storage ? { storage: true } : {}),
    });
  });
  const spawn = world.spawn ? [...world.spawn] : null;
  const mobs = [];
  // Per-spawner settings (`loot` pool, respawn `delay` range, `skins` pool)
  // are additive — omitted when unset so untouched maps stay byte-identical.
  world.forEachMobSpawn((s) => mobs.push({
    type: s.type, x: s.x, y: s.y, z: s.z,
    ...(s.loot ? { loot: [...s.loot] } : {}),
    ...(s.delay ? { delay: [...s.delay] } : {}),
    ...(s.skins ? { skins: [...s.skins] } : {}),
  }));
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
  const pixelDecals = new Map();
  world.forEachDecal((d) => {
    // A switch caught showing its ON art stores the canonical OFF id —
    // its state lives in the game's flag store, not the map.
    decals.push({
      id: canonicalDecalId(d.decalId), x: d.cell[0], y: d.cell[1], z: d.cell[2], face: d.face,
      ...(d.rotation ? { rotation: d.rotation } : {}),
      ...(d.flag ? { flag: d.flag } : {}),
      ...(d.startOn ? { startOn: true } : {}),
    });
    const spec = textSpecOf(d.decalId);
    if (spec && !textDecals.has(d.decalId)) textDecals.set(d.decalId, { id: d.decalId, ...spec });
    const pspec = pixelSpecOf(d.decalId);
    if (pspec && !pixelDecals.has(d.decalId)) pixelDecals.set(d.decalId, { id: d.decalId, ...pspec });
  });
  // `splashCams` is additive — authored menu-camera shots ride with the map.
  const splashCams = [];
  world.forEachSplashCam((c) => splashCams.push({
    id: c.id, pos: [...c.pos], yaw: c.yaw, pitch: c.pitch,
    ...(c.fov ? { fov: c.fov } : {}),
    ...(c.motion ? { motion: c.motion } : {}),
  }));
  return {
    spawn, spawnYaw: world.spawnYaw ?? 0,
    items, mobs, npcs, decals,
    textDecals: [...textDecals.values()],
    pixelDecals: [...pixelDecals.values()],
    splashCams,
  };
}

/** @returns {string} JSON text of the world. */
export function serialize(world) {
  const blocks = [];
  world.forEachVoxel((v) => {
    // rotation is additive and omitted when 0, so old readers and untouched
    // maps stay byte-identical. A light caught in its dark phase is
    // normalized back to its lit id, an open door back to its closed id —
    // maps always store the canonical block (a light's state is `lightMode`).
    const def = getBlock(v.type);
    const type = def?.lightOn ?? def?.doorClosed ?? v.type;
    blocks.push({
      x: v.anchor[0], y: v.anchor[1], z: v.anchor[2], size: v.size, type,
      ...(v.rotation ? { rotation: v.rotation } : {}),
      ...(v.variant ? { variant: v.variant } : {}),
      // door/light settings — additive and omitted at their defaults, so maps
      // without configured doors or lights stay byte-identical
      ...(v.locked ? { locked: true } : {}),
      ...(v.hinge === 'right' ? { hinge: 'right' } : {}),
      ...(v.unlockFlag ? { unlockFlag: v.unlockFlag } : {}),
      ...(v.lightMode && v.lightMode !== 'on' ? { lightMode: v.lightMode } : {}),
      ...(v.lightFlag ? { lightFlag: v.lightFlag } : {}),
    });
  });
  // `paint` is additive — per-face texture overrides. Omitted when nothing is
  // painted, so untouched maps stay byte-identical.
  const paint = [];
  world.forEachPaint?.((p) => paint.push({ x: p.x, y: p.y, z: p.z, face: p.face, type: p.type }));
  const { spawn, spawnYaw, items, mobs, npcs, decals, textDecals, pixelDecals, splashCams } = collectSparse(world);
  // Compact JSON: maps can hold a lot of voxels, and the file is written on
  // every autosave — the pretty-printed form doubled the bytes for no reader.
  return JSON.stringify({
    format: FORMAT, version: VERSION, cellSize: CELL_SIZE, spawn, spawnYaw,
    blocks, items, mobs, decals,
    ...(npcs.length ? { npcs } : {}),
    ...(paint.length ? { paint } : {}),
    ...(textDecals.length ? { textDecals } : {}),
    ...(pixelDecals.length ? { pixelDecals } : {}),
    ...(splashCams.length ? { splashCams } : {}),
  });
}

/**
 * @returns {{world: World, errors: string[], fatal: boolean}}
 *   `fatal` = the file could not be read at all and the world is empty.
 *   Without it the errors are per-entry skips: the world holds everything
 *   that DID load, so callers must keep it rather than start over.
 */
export function deserialize(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { world: new World(), errors: [`Invalid JSON: ${e.message}`], fatal: true };
  }
  return deserializeData(data);
}

/** The same tolerant loader, from an already-parsed data object. Renamed
 *  content ids are mapped through the alias table (idAliases.js) here, so
 *  every load path benefits. */
export function deserializeData(data) {
  const errors = [];
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
  for (let b of data.blocks) {
    if (!b || typeof b.x !== 'number' || typeof b.y !== 'number' || typeof b.z !== 'number') {
      errors.push('Skipped malformed block entry');
      continue;
    }
    if (aliasId(b.type) !== b.type) b = { ...b, type: aliasId(b.type) };
    // Maps from the one-block-per-state era: *_blink ids load as the unified
    // light with its mode authored to 'flicker'.
    const legacy = legacyLightSettings(b.type);
    if (legacy) b = { ...b, ...legacy };
    const size = b.size === SIZE.BIG || b.size === SIZE.DOOR || b.size === SIZE.DOOR3 || b.size === SIZE.SIDELIGHT ? b.size : SIZE.SMALL;
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
      continue;
    }
    applyDoorSettings(world.get(b.x, b.y, b.z), b);
    applyLightSettings(world.get(b.x, b.y, b.z), b);
  }
  if (Array.isArray(data.items)) {
    for (let it of data.items) {
      if (!it || typeof it.x !== 'number' || typeof it.y !== 'number' || typeof it.z !== 'number' || typeof it.itemId !== 'string') {
        errors.push('Skipped malformed item entry');
        continue;
      }
      if (aliasId(it.itemId) !== it.itemId) it = { ...it, itemId: aliasId(it.itemId) };
      // v2 placements carry a cells footprint; v1 stored 'small'/'big'
      // (placeItem coerces either via footprintCells).
      const cells = Array.isArray(it.cells) ? it.cells : it.size;
      if (!isItemId(it.itemId) && !isEquipId(it.itemId)) {
        errors.push(`Skipped item ${it.itemId} (not registered)`);
        continue;
      }
      const rotation = typeof it.rotation === 'number' ? it.rotation : 0;
      // Equipment renders in its resting pose (cropped + laid flat, see
      // LayFlat.js), so its footprint follows that pose, not whatever an
      // older save stored (pre-flat placements claimed a single cell). If the
      // corrected footprint no longer fits (something now overlaps the extra
      // cells), fall back to the stored one rather than drop the item.
      const equip = !isItemId(it.itemId) && isEquipId(it.itemId) ? getEquipItem(it.itemId) : null;
      const flatCells = equip ? layFlatCells(equip) : null;
      // Additive search-loot / storage config; malformed entries load as
      // plain scenery.
      const loot = it.loot && typeof it.loot === 'object'
        ? {
            pool: Array.isArray(it.loot.pool) ? it.loot.pool.filter((id) => typeof id === 'string') : null,
            reset: Number.isFinite(it.loot.reset) && it.loot.reset > 0 ? it.loot.reset : null,
          }
        : null;
      const storage = it.storage === true;
      const settings = loot || storage
        ? { ...(loot ? { loot } : {}), ...(storage ? { storage: true } : {}) }
        : null;
      const placed =
        (flatCells && world.placeItem(it.itemId, flatCells, it.x, it.y, it.z, rotation, settings)) ||
        world.placeItem(it.itemId, cells, it.x, it.y, it.z, rotation, settings);
      if (!placed) {
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
  // Drawn decals re-register the same way, before placements reference them.
  if (Array.isArray(data.pixelDecals)) {
    for (const p of data.pixelDecals) {
      if (!p || typeof p.id !== 'string' || typeof p.px !== 'string' || !/^decal_pix_[a-z0-9]+$/.test(p.id)) {
        errors.push('Skipped malformed pixel decal definition');
        continue;
      }
      if (!createPixelDecal(p, { id: p.id })) {
        errors.push(`Skipped pixel decal ${p.id}: bad pixel data`);
      }
    }
  }
  if (Array.isArray(data.decals)) {
    for (let d of data.decals) {
      if (!d || typeof d.x !== 'number' || typeof d.y !== 'number' || typeof d.z !== 'number' || typeof d.id !== 'string') {
        errors.push('Skipped malformed decal entry');
        continue;
      }
      if (aliasId(d.id) !== d.id) d = { ...d, id: aliasId(d.id) };
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
        continue;
      }
      // Additive switch wiring: the flag the decal drives — and whether it
      // starts raised — ride the entry.
      if (typeof d.flag === 'string' && d.flag) world.decalAt(d.x, d.y, d.z, d.face).flag = d.flag;
      if (d.startOn === true) world.decalAt(d.x, d.y, d.z, d.face).startOn = true;
    }
  }
  // Paint loads AFTER blocks (a painted face needs its block) and is dropped
  // silently-per-entry: a face whose block did not load keeps no paint.
  if (Array.isArray(data.paint)) {
    for (let p of data.paint) {
      if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.z !== 'number' || typeof p.type !== 'string') {
        errors.push('Skipped malformed paint entry');
        continue;
      }
      if (aliasId(p.type) !== p.type) p = { ...p, type: aliasId(p.type) };
      if (!isBlockId(p.type)) {
        errors.push(`Skipped paint ${p.type} (not a known block)`);
        continue;
      }
      if (!FACES.includes(p.face)) {
        errors.push(`Skipped paint at ${p.x},${p.y},${p.z}: bad face "${p.face}"`);
        continue;
      }
      if (!world.paintFace(p.x, p.y, p.z, p.face, p.type)) {
        errors.push(`Skipped paint at ${p.x},${p.y},${p.z} ${p.face}: no block face there`);
      }
    }
  }
  if (Array.isArray(data.mobs)) {
    for (let m of data.mobs) {
      if (!m || typeof m.x !== 'number' || typeof m.y !== 'number' || typeof m.z !== 'number' || typeof m.type !== 'string') {
        errors.push('Skipped malformed mob spawn');
        continue;
      }
      if (aliasId(m.type) !== m.type) m = { ...m, type: aliasId(m.type) };
      if (!isMobId(m.type)) {
        errors.push(`Skipped mob spawn ${m.type} (not registered)`);
        continue;
      }
      const settings = {
        loot: Array.isArray(m.loot) ? m.loot.filter((id) => typeof id === 'string') : null,
        delay: Array.isArray(m.delay) && m.delay.length === 2
          && Number.isFinite(m.delay[0]) && Number.isFinite(m.delay[1])
          ? m.delay : null,
        skins: Array.isArray(m.skins) ? m.skins.filter((id) => typeof id === 'string') : null,
      };
      if (!world.addMobSpawn(m.type, m.x, m.y, m.z, settings)) {
        errors.push(`Skipped duplicate mob spawn at ${m.x},${m.y},${m.z}`);
      }
    }
  }
  if (Array.isArray(data.npcs)) {
    for (let n of data.npcs) {
      if (!n || typeof n.x !== 'number' || typeof n.y !== 'number' || typeof n.z !== 'number' || typeof n.type !== 'string') {
        errors.push('Skipped malformed NPC spawn');
        continue;
      }
      if (aliasId(n.type) !== n.type) n = { ...n, type: aliasId(n.type) };
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
