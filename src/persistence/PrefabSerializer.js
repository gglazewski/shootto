// PrefabSerializer.js — pure JSON serialization of a prefab.
//
// A prefab is a reusable building: a bounded box of world content (blocks,
// placed objects, decals) that the world editor can stamp anywhere. The
// on-disk format mirrors the voxelmap entries so both serializers stay
// mutually readable:
//   { format: 'voxelprefab', version: 1, id, name, cellSize: 0.5,
//     dims: [w, h, d],                       // build volume in small cells
//     thumb: 'data:image/jpeg;base64,...',   // optional editor screenshot
//     blocks: [{ x, y, z, size, type, rotation?, variant? }, ...],
//     items:  [{ itemId, x, y, z, cells: [w,h,d], rotation }, ...],
//     decals: [{ id, x, y, z, face, rotation? }, ...],
//     paint:  [{ x, y, z, face, type }, ...],   // per-face texture overrides
//     textDecals: [{ id, text, ... }, ...] } // specs for sign decals used
//
// All coordinates are relative to the prefab's min corner (0,0,0). Content
// outside dims is the caller's error — serializePrefab refuses it so a save
// can never silently lose voxels.

import { assertValidBlockId, SIZE, isDecalId, isBlockId, FACES, getBlock } from '../engine/VoxelTypes.js';
import { textSpecOf } from '../engine/TextDecals.js';
import { pixelSpecOf } from '../engine/PixelDecals.js';
import { legacyLightSettings } from '../engine/Lights.js';
import { canonicalDecalId } from '../engine/Switches.js';
import { isItemId } from '../engine/ItemRegistry.js';
import { isEquipId } from '../engine/EquipmentRegistry.js';
import { CELL_SIZE } from '../engine/Space.js';
import { spanVecFor } from '../engine/VoxelShape.js';

export const PREFAB_FORMAT = 'voxelprefab';
export const PREFAB_VERSION = 1;

/** Dims are clamped to sane editor bounds: at least one cell, at most 128
 *  cells (64 m) per axis — big enough for any building, small enough that a
 *  typo can't hang the editor. */
export const MAX_PREFAB_SPAN = 128;

export function normalizePrefabDims(dims) {
  const d = Array.isArray(dims) ? dims : [];
  return [0, 1, 2].map((i) => {
    const n = Math.round(Number(d[i]));
    return Number.isFinite(n) ? Math.max(1, Math.min(MAX_PREFAB_SPAN, n)) : 16;
  });
}

/** A safe id from a display name (mirrors the item editor's slugs). */
export function slugifyPrefabName(name) {
  const slug = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return slug || 'prefab';
}

/**
 * Collect the world's content into prefab entries relative to origin (0,0,0),
 * verifying everything lies inside `dims`. Entries anchored below y=0 are the
 * prefab session's scaffolding floor (the baseplate) and are excluded by
 * design; anything else outside the box is rejected, not clipped — a save can
 * never silently lose part of the build.
 * @returns {{ prefab: object|null, outside: number }}
 */
export function serializePrefab(world, { id, name, dims, thumb = null }) {
  const [W, H, D] = normalizePrefabDims(dims);
  const inside = (x, y, z, sx, sy, sz) =>
    x >= 0 && y >= 0 && z >= 0 && x + sx <= W && y + sy <= H && z + sz <= D;
  let outside = 0;

  const blocks = [];
  world.forEachVoxel((v) => {
    const [sx, sy, sz] = spanVecFor(v.size, v.rotation ?? 0);
    const [x, y, z] = v.anchor;
    if (y < 0) return; // session baseplate — scaffolding, not content
    if (!inside(x, y, z, sx, sy, sz)) {
      outside++;
      return;
    }
    const def = getBlock(v.type);
    const type = def?.lightOn ?? def?.doorClosed ?? v.type;
    blocks.push({
      x, y, z, size: v.size, type,
      ...(v.rotation ? { rotation: v.rotation } : {}),
      ...(v.variant ? { variant: v.variant } : {}),
      ...(v.locked ? { locked: true } : {}),
      ...(v.hinge === 'right' ? { hinge: 'right' } : {}),
      ...(v.unlockFlag ? { unlockFlag: v.unlockFlag } : {}),
      ...(v.lightMode && v.lightMode !== 'on' ? { lightMode: v.lightMode } : {}),
      ...(v.lightFlag ? { lightFlag: v.lightFlag } : {}),
    });
  });

  const items = [];
  world.forEachItem((it) => {
    const [x, y, z] = it.anchor;
    if (y < 0) return;
    const [sx, sy, sz] = spanVecFor(it.cells, Math.round((it.rotation ?? 0) / (Math.PI / 2)) & 3);
    if (!inside(x, y, z, sx, sy, sz)) {
      outside++;
      return;
    }
    items.push({ itemId: it.itemId, x, y, z, cells: it.cells, rotation: it.rotation ?? 0 });
  });

  const decals = [];
  const textDecals = new Map();
  const pixelDecals = new Map();
  world.forEachDecal((d) => {
    const [x, y, z] = d.cell;
    if (y < 0) return;
    if (!inside(x, y, z, 1, 1, 1)) {
      outside++;
      return;
    }
    decals.push({
      id: canonicalDecalId(d.decalId), x, y, z, face: d.face,
      ...(d.rotation ? { rotation: d.rotation } : {}),
      ...(d.flag ? { flag: d.flag } : {}),
      ...(d.startOn ? { startOn: true } : {}),
    });
    const spec = textSpecOf(d.decalId);
    if (spec && !textDecals.has(d.decalId)) textDecals.set(d.decalId, { id: d.decalId, ...spec });
    const pspec = pixelSpecOf(d.decalId);
    if (pspec && !pixelDecals.has(d.decalId)) pixelDecals.set(d.decalId, { id: d.decalId, ...pspec });
  });

  // Paint rides the faces of blocks already checked above, so it needs no
  // bounds test of its own beyond the baseplate cut.
  const paint = [];
  world.forEachPaint?.((p) => {
    if (p.y < 0) return;
    if (!inside(p.x, p.y, p.z, 1, 1, 1)) return;
    paint.push({ x: p.x, y: p.y, z: p.z, face: p.face, type: p.type });
  });

  if (outside) return { prefab: null, outside };

  return {
    prefab: {
      format: PREFAB_FORMAT,
      version: PREFAB_VERSION,
      id,
      name,
      cellSize: CELL_SIZE,
      dims: [W, H, D],
      ...(thumb ? { thumb } : {}),
      blocks,
      items,
      decals,
      ...(paint.length ? { paint } : {}),
      ...(textDecals.size ? { textDecals: [...textDecals.values()] } : {}),
      ...(pixelDecals.size ? { pixelDecals: [...pixelDecals.values()] } : {}),
    },
    outside: 0,
  };
}

/**
 * Parse and validate prefab JSON. Per-entry problems are skipped with an
 * error message; only an unreadable file is fatal.
 * @returns {{ prefab: object|null, errors: string[] }}
 */
export function deserializePrefab(text) {
  const errors = [];
  let data;
  try {
    data = typeof text === 'string' ? JSON.parse(text) : text;
  } catch (e) {
    return { prefab: null, errors: [`Invalid JSON: ${e.message}`] };
  }
  if (!data || data.format !== PREFAB_FORMAT) {
    return { prefab: null, errors: ['Not a voxelprefab file'] };
  }
  if (!Array.isArray(data.blocks)) {
    return { prefab: null, errors: ['Missing "blocks" array'] };
  }
  const dims = normalizePrefabDims(data.dims);

  const blocks = [];
  for (let b of data.blocks) {
    if (!b || typeof b.x !== 'number' || typeof b.y !== 'number' || typeof b.z !== 'number') {
      errors.push('Skipped malformed block entry');
      continue;
    }
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
    const variant = b.variant === 'lower' || b.variant === 'upper' ? b.variant : null;
    blocks.push({
      x: b.x, y: b.y, z: b.z, size, type: b.type, rotation, variant,
      ...(b.locked ? { locked: true } : {}),
      ...(b.hinge === 'right' ? { hinge: 'right' } : {}),
      ...(typeof b.unlockFlag === 'string' && b.unlockFlag ? { unlockFlag: b.unlockFlag } : {}),
      ...(b.lightMode === 'off' || b.lightMode === 'flicker' ? { lightMode: b.lightMode } : {}),
      ...(typeof b.lightFlag === 'string' && b.lightFlag ? { lightFlag: b.lightFlag } : {}),
    });
  }

  const items = [];
  if (Array.isArray(data.items)) {
    for (const it of data.items) {
      if (!it || typeof it.x !== 'number' || typeof it.y !== 'number' || typeof it.z !== 'number' || typeof it.itemId !== 'string') {
        errors.push('Skipped malformed item entry');
        continue;
      }
      if (!isItemId(it.itemId) && !isEquipId(it.itemId)) {
        errors.push(`Skipped item ${it.itemId} (not registered)`);
        continue;
      }
      items.push({
        itemId: it.itemId, x: it.x, y: it.y, z: it.z,
        cells: it.cells, rotation: typeof it.rotation === 'number' ? it.rotation : 0,
      });
    }
  }

  // Text sign specs ride with the prefab; ids are pinned like the world file.
  const textDecals = [];
  if (Array.isArray(data.textDecals)) {
    for (const t of data.textDecals) {
      if (!t || typeof t.id !== 'string' || typeof t.text !== 'string' || !/^decal_text_[a-z0-9]+$/.test(t.id)) {
        errors.push('Skipped malformed text decal definition');
        continue;
      }
      textDecals.push(t);
    }
  }

  // Drawn decal specs ride along the same way.
  const pixelDecals = [];
  if (Array.isArray(data.pixelDecals)) {
    for (const p of data.pixelDecals) {
      if (!p || typeof p.id !== 'string' || typeof p.px !== 'string' || !/^decal_pix_[a-z0-9]+$/.test(p.id)) {
        errors.push('Skipped malformed pixel decal definition');
        continue;
      }
      pixelDecals.push(p);
    }
  }

  const decals = [];
  if (Array.isArray(data.decals)) {
    for (const d of data.decals) {
      if (!d || typeof d.x !== 'number' || typeof d.y !== 'number' || typeof d.z !== 'number' || typeof d.id !== 'string') {
        errors.push('Skipped malformed decal entry');
        continue;
      }
      if (!FACES.includes(d.face)) {
        errors.push(`Skipped decal ${d.id}: bad face "${d.face}"`);
        continue;
      }
      decals.push({
        id: d.id, x: d.x, y: d.y, z: d.z, face: d.face,
        rotation: Number.isInteger(d.rotation) ? ((d.rotation % 4) + 4) % 4 : 0,
        ...(typeof d.flag === 'string' && d.flag ? { flag: d.flag } : {}),
        ...(d.startOn === true ? { startOn: true } : {}),
      });
    }
  }

  const paint = [];
  if (Array.isArray(data.paint)) {
    for (const p of data.paint) {
      if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.z !== 'number' || typeof p.type !== 'string') {
        errors.push('Skipped malformed paint entry');
        continue;
      }
      if (!isBlockId(p.type)) {
        errors.push(`Skipped paint ${p.type} (not a known block)`);
        continue;
      }
      if (!FACES.includes(p.face)) {
        errors.push(`Skipped paint at ${p.x},${p.y},${p.z}: bad face "${p.face}"`);
        continue;
      }
      paint.push({ x: p.x, y: p.y, z: p.z, face: p.face, type: p.type });
    }
  }

  return {
    prefab: {
      format: PREFAB_FORMAT,
      version: PREFAB_VERSION,
      id: typeof data.id === 'string' && data.id ? data.id : slugifyPrefabName(data.name),
      name: typeof data.name === 'string' && data.name ? data.name : 'Prefab',
      cellSize: CELL_SIZE,
      dims,
      ...(typeof data.thumb === 'string' && data.thumb.startsWith('data:image/') ? { thumb: data.thumb } : {}),
      blocks,
      items,
      decals,
      paint,
      ...(textDecals.length ? { textDecals } : {}),
      ...(pixelDecals.length ? { pixelDecals } : {}),
    },
    errors,
  };
}
