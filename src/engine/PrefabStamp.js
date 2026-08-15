// PrefabStamp.js — pure placement math for stamping prefabs into a world.
//
// A prefab's content lives in a [W, H, D] cell box anchored at (0,0,0). The
// stamp rotates it by quarter turns around +Y — the SAME counter-clockwise
// convention block texture rotation uses (ChunkMeshBuilder SIDE_CYCLE), so a
// rotated road line still runs along its rotated road — then translates it to
// an offset in world cells and places entry by entry. Occupied cells skip the
// individual entry (a building stamped into a hillside keeps everything that
// fits); the returned receipt lists exactly what landed so a command can
// undo it.
//
// A placement is (turns, mirror): the content is first mirrored across the
// prefab's local x axis when `mirror` is set, then turned. Mirroring is what
// makes an apartment block's twin next door — the same building handed the
// other way round, never upside down. Since a reflection turns a rotation
// into its inverse, that single flag plus the four turns covers every flip
// the editor offers (see flipPlacement).

import { spanVecFor, cellsFor } from './VoxelShape.js';
import { isDecalId } from './VoxelTypes.js';
import { createTextDecal } from './TextDecals.js';
import { applyDoorSettings } from './Doors.js';
import { applyLightSettings } from './Lights.js';

/** Prefab dims after `turns` quarter-turns (odd turns swap x/z). */
export function rotatedDims(dims, turns) {
  const [w, h, d] = dims;
  return (turns & 1) ? [d, h, w] : [w, h, d];
}

/**
 * Rotate an axis-aligned box (anchor + span, in prefab cells) by `turns`
 * quarter turns CCW around +Y inside a [W, -, D] footprint. Returns the new
 * min-corner anchor; the caller derives the rotated span itself (spans swap
 * x/z on odd turns).
 *
 * One CCW step maps a cell (x, z) -> (z, W-1-x); for a box the new min
 * corner is (z, W - sx - x).
 */
export function rotateAnchor(x, y, z, sx, sz, dims, turns) {
  let [W, , D] = dims;
  let t = ((turns % 4) + 4) % 4;
  while (t--) {
    [x, z] = [z, W - sx - x];
    [sx, sz] = [sz, sx];
    [W, D] = [D, W];
  }
  return [x, y, z];
}

/** Rotate a face name by quarter turns CCW around +Y (py/ny unchanged). */
const SIDE_CYCLE = ['px', 'nz', 'nx', 'pz']; // one CCW step: px->nz->nx->pz->px
export function rotateFace(face, turns) {
  const i = SIDE_CYCLE.indexOf(face);
  if (i < 0) return face;
  return SIDE_CYCLE[(i + turns) & 3];
}

/** Mirror a face name across the x axis (px <-> nx; every other face lies in
 *  the mirror plane and keeps its name). */
export function mirrorFaceX(face) {
  return face === 'px' ? 'nx' : face === 'nx' ? 'px' : face;
}

/** Mirror a box across the prefab's local x axis: a box [x, x+sx) inside a
 *  W-wide footprint lands at [W-sx-x, ...). y and z never move — the flip is
 *  a plane, not a roll. */
export function mirrorAnchorX(x, sx, W) {
  return W - sx - x;
}

/**
 * Flip a placement across a WORLD axis plane — what the editor's F (x) and
 * Shift+F (z) do to the prefab in hand.
 *
 * A reflection conjugates rotation into its inverse (Mx·R_t = R_-t·Mx), and
 * a z-mirror is an x-mirror turned half way round (Mz = R_2·Mx). So either
 * world flip is exactly one local x-mirror plus a change of turns, and the
 * placement never needs a second mirror flag.
 * @param {{turns?: number, mirror?: boolean}} placement
 * @param {'x'|'z'} axis  world axis the content is flipped along
 * @returns {{turns: number, mirror: boolean}}
 */
export function flipPlacement({ turns = 0, mirror = false }, axis) {
  const t = ((turns % 4) + 4) % 4;
  return { turns: (axis === 'z' ? (6 - t) : (4 - t)) & 3, mirror: !mirror };
}

/** Item rotations are radians; keep a mirrored one in [0, 2π) so a flip can
 *  never hand the world a negative (or negative-zero) angle. */
const TAU = Math.PI * 2;
function normAngle(a) {
  return ((a % TAU) + TAU) % TAU;
}

/**
 * All placements of a prefab mirrored (optional), rotated by `turns` and
 * shifted by `offset` (world cells). Pure — nothing touches the world yet.
 * @param {boolean} [mirror]  flip the content across the prefab's local x axis
 *   BEFORE turning it
 */
export function prefabPlacements(prefab, offset, turns, mirror = false) {
  const t = ((turns % 4) + 4) % 4;
  const m = !!mirror;
  const [ox, oy, oz] = offset;
  const dims = prefab.dims;
  const W0 = dims[0]; // pre-rotation width — the mirror runs in prefab coords

  const blocks = prefab.blocks.map((b) => {
    const r0 = (b.rotation ?? 0) & 3;
    // A reflection reverses the sense of rotation, so the block's own turns
    // subtract instead of add once the prefab is mirrored.
    const rot = (m ? t - r0 : t + r0) & 3;
    // Span BEFORE the extra turns: doors swap footprint on their own odd
    // rotations, so measure with the stored rotation — mirroring keeps its
    // parity, hence its span — then mirror and rotate the box.
    const [sx, , sz] = spanVecFor(b.size, r0);
    const bx = m ? mirrorAnchorX(b.x, sx, W0) : b.x;
    const [x, y, z] = rotateAnchor(bx, b.y, b.z, sx, sz, dims, t);
    // Locking rides along untouched, and so does the hinge under rotation:
    // it names an end of the leaf ('left' = the low one), and turning carries
    // leaf and ends together. A mirror swaps those two ends — but only for a
    // leaf that runs along the mirrored axis (even rotations), since a leaf
    // along z lies in the mirror plane.
    const hinge = (m && (r0 & 1) === 0)
      ? (b.hinge === 'right' ? 'left' : 'right')
      : (b.hinge ?? 'left');
    return {
      type: b.type, size: b.size, x: x + ox, y: y + oy, z: z + oz, rotation: rot, variant: b.variant ?? null,
      ...(b.locked ? { locked: true } : {}),
      ...(hinge === 'right' ? { hinge: 'right' } : {}),
      ...(b.unlockFlag ? { unlockFlag: b.unlockFlag } : {}),
      ...(b.lightMode ? { lightMode: b.lightMode } : {}),
      ...(b.lightFlag ? { lightFlag: b.lightFlag } : {}),
    };
  });

  const items = prefab.items.map((it) => {
    const rot0 = it.rotation ?? 0;
    const turns0 = Math.round(rot0 / (Math.PI / 2)) & 3;
    const [sx, , sz] = spanVecFor(it.cells, turns0);
    const ix = m ? mirrorAnchorX(it.x, sx, W0) : it.x;
    const [x, y, z] = rotateAnchor(ix, it.y, it.z, sx, sz, dims, t);
    // An object has no mirrored mesh, so a flipped one is turned to face the
    // way its reflection would — as close as an unmirrorable model gets.
    const rotation = m ? normAngle(t * (Math.PI / 2) - rot0) : rot0 + t * (Math.PI / 2);
    return { itemId: it.itemId, cells: it.cells, x: x + ox, y: y + oy, z: z + oz, rotation };
  });

  const decals = prefab.decals.map((d) => {
    const dx = m ? mirrorAnchorX(d.x, 1, W0) : d.x;
    const [x, y, z] = rotateAnchor(dx, d.y, d.z, 1, 1, dims, t);
    const face0 = m ? mirrorFaceX(d.face) : d.face;
    const face = rotateFace(face0, t);
    // Horizontal faces spin their artwork instead of moving; side faces keep
    // their in-plane rotation. A mirror reverses the spin on either.
    const r0 = m ? (-(d.rotation ?? 0)) & 3 : (d.rotation ?? 0);
    const rotation = (face0 === 'py' || face0 === 'ny') ? (r0 + t) & 3 : r0;
    return { id: d.id, x: x + ox, y: y + oy, z: z + oz, face, rotation, ...(d.flag ? { flag: d.flag } : {}), ...(d.startOn ? { startOn: true } : {}) };
  });

  // Face paint rotates like a decal on a side face: the cell moves, the face
  // name turns with it. Horizontal faces (py/ny) keep their name; the tile
  // itself is what the painter chose, so nothing spins.
  const paint = (prefab.paint ?? []).map((p) => {
    const px = m ? mirrorAnchorX(p.x, 1, W0) : p.x;
    const [x, y, z] = rotateAnchor(px, p.y, p.z, 1, 1, dims, t);
    return { type: p.type, x: x + ox, y: y + oy, z: z + oz, face: rotateFace(m ? mirrorFaceX(p.face) : p.face, t) };
  });

  return { blocks, items, decals, paint };
}

/**
 * Stamp a prefab into the world. Blocked entries are skipped (counted), and
 * the receipt holds everything actually placed for a clean undo.
 * @returns {{ blocks: object[], items: object[], decals: object[], paint: object[], skipped: number }}
 */
export function stampPrefab(world, prefab, offset, turns, mirror = false) {
  // Text signs used by the prefab register before their placements are
  // checked (ids are pinned; re-registering an existing id is a no-op).
  for (const t of prefab.textDecals ?? []) {
    if (!isDecalId(t.id)) createTextDecal(t, { id: t.id });
  }

  const { blocks, items, decals, paint } = prefabPlacements(prefab, offset, turns, mirror);
  const receipt = { blocks: [], items: [], decals: [], paint: [], skipped: 0 };

  // Cells this stamp actually filled. Paint may only land on them: where a
  // block was blocked, the cell holds someone else's voxel and repainting it
  // would vandalise the world the prefab was dropped into.
  const mine = new Set();
  for (const b of blocks) {
    if (world.place(b.type, b.size, b.x, b.y, b.z, b.rotation, b.variant)) {
      applyDoorSettings(world.get(b.x, b.y, b.z), b);
      applyLightSettings(world.get(b.x, b.y, b.z), b);
      receipt.blocks.push(b);
      for (const [cx, cy, cz] of cellsFor(b.x, b.y, b.z, b.size, b.rotation)) mine.add(`${cx},${cy},${cz}`);
    } else {
      receipt.skipped++;
    }
  }
  for (const it of items) {
    if (world.placeItem(it.itemId, it.cells, it.x, it.y, it.z, it.rotation)) receipt.items.push(it);
    else receipt.skipped++;
  }
  for (const d of decals) {
    if (isDecalId(d.id) && world.placeDecal(d.id, d.x, d.y, d.z, d.face, d.rotation)) {
      if (d.flag) world.decalAt(d.x, d.y, d.z, d.face).flag = d.flag;
      if (d.startOn) world.decalAt(d.x, d.y, d.z, d.face).startOn = true;
      receipt.decals.push(d);
    } else {
      receipt.skipped++;
    }
  }
  for (const p of paint) {
    if (mine.has(`${p.x},${p.y},${p.z}`) && world.paintFace(p.x, p.y, p.z, p.face, p.type)) receipt.paint.push(p);
    else receipt.skipped++;
  }
  return receipt;
}

/** Remove everything a stampPrefab receipt placed (for undo). */
export function unstampPrefab(world, receipt) {
  for (const p of receipt.paint ?? []) world.unpaintFace(p.x, p.y, p.z, p.face);
  for (const d of receipt.decals) world.removeDecal(d.x, d.y, d.z, d.face);
  for (const it of receipt.items) world.removeItemAt(it.x, it.y, it.z);
  for (const b of receipt.blocks) world.remove(b.x, b.y, b.z);
}

/** How many of the prefab's block placements would collide at this offset —
 *  drives the ghost's free/blocked tint without touching the world. */
export function countBlocked(world, prefab, offset, turns, mirror = false) {
  const { blocks, items } = prefabPlacements(prefab, offset, turns, mirror);
  let blocked = 0;
  for (const b of blocks) {
    if (!world.isAreaFree(b.x, b.y, b.z, b.size, b.rotation)) blocked++;
  }
  for (const it of items) {
    const q = Math.round((it.rotation ?? 0) / (Math.PI / 2)) & 3;
    if (!world.isAreaFree(it.x, it.y, it.z, it.cells, q)) blocked++;
  }
  return blocked;
}
