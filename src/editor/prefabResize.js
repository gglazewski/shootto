// prefabResize.js — pure math for pulling a side of the prefab build volume.
//
// The build volume always spans (0,0,0)..dims in world cells, so only the
// +X/+Y/+Z faces can move for free. Pulling a MIN face is the same edit seen
// from the other end: the box grows AND every piece of content slides by the
// same amount, which puts the min corner back at the origin. That shift is
// what makes the drag feel like Figma — the side you grabbed moves, the build
// stays where it is on screen (the caller nudges the camera by the same
// vector).
//
// Everything here is coordinate math on plain arrays; the tool, the panel and
// the resize command all share it.

import { spanVecFor } from '../engine/VoxelShape.js';
import { quarterTurns } from '../engine/ItemTypes.js';
import { MAX_PREFAB_SPAN } from '../persistence/PrefabSerializer.js';

/** The six grabbable sides, in tool-ring order (min first per axis). */
export const FACES = [
  { id: '-x', axis: 0, sign: -1, label: 'left (−X)' },
  { id: '+x', axis: 0, sign: 1, label: 'right (+X)' },
  { id: '-y', axis: 1, sign: -1, label: 'bottom (−Y)' },
  { id: '+y', axis: 1, sign: 1, label: 'top (+Y)' },
  { id: '-z', axis: 2, sign: -1, label: 'back (−Z)' },
  { id: '+z', axis: 2, sign: 1, label: 'front (+Z)' },
];

export const faceId = (axis, sign) => `${sign < 0 ? '-' : '+'}${'xyz'[axis]}`;
export const faceLabel = (axis, sign) => FACES.find((f) => f.axis === axis && f.sign === sign)?.label ?? faceId(axis, sign);

/**
 * Inclusive cell box of everything the prefab would save: blocks, placed
 * objects and decals. Entries below y=0 are the session baseplate — the same
 * scaffolding serializePrefab skips — so they never hold a shrink back.
 * @returns {{min:[number,number,number], max:[number,number,number]}|null} null when empty
 */
export function contentBounds(world) {
  let min = null;
  let max = null;
  const add = (a, span) => {
    if (a[1] < 0) return;
    if (!min) {
      min = [a[0], a[1], a[2]];
      max = [a[0] + span[0] - 1, a[1] + span[1] - 1, a[2] + span[2] - 1];
      return;
    }
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], a[i]);
      max[i] = Math.max(max[i], a[i] + span[i] - 1);
    }
  };
  world.forEachVoxel((v) => add(v.anchor, spanVecFor(v.size, v.rotation ?? 0)));
  world.forEachItem((it) => add(it.anchor, spanVecFor(it.cells, quarterTurns(it.rotation ?? 0))));
  world.forEachDecal((d) => add(d.cell, [1, 1, 1]));
  return min ? { min, max } : null;
}

/**
 * How far the given face may travel, in cells, positive = outward (bigger box).
 * Inward travel stops at the content: a side never cuts through a block.
 * @param {number[]} dims
 * @param {{min:number[], max:number[]}|null} bounds  contentBounds(world)
 * @param {number} axis  0=x 1=y 2=z
 * @param {number} sign  -1 = the min side, +1 = the max side
 * @returns {{min:number, max:number}}
 */
export function resizeLimits(dims, bounds, axis, sign) {
  const size = dims[axis];
  const max = MAX_PREFAB_SPAN - size;
  // An empty volume is only limited by the 1-cell floor.
  if (!bounds) return { min: 1 - size, max };
  // A positive `min` means the content already sticks out: only growing is legal.
  const min = sign > 0
    ? Math.max(1, bounds.max[axis] + 1) - size // the max side stops past the last cell
    : Math.max(1 - size, -bounds.min[axis]); // the min side stops at the first cell
  return { min, max };
}

export const clampDelta = (delta, limits) => Math.max(limits.min, Math.min(limits.max, Math.round(delta)));

/**
 * The edit a face drag describes.
 * @returns {{dims:number[], shift:[number,number,number]}} shift = how far the
 *   content moves so the box keeps its min corner at the origin
 */
export function resizePlan(dims, axis, sign, delta) {
  const next = [...dims];
  next[axis] = dims[axis] + delta;
  const shift = [0, 0, 0];
  if (sign < 0) shift[axis] = delta;
  return { dims: next, shift };
}

/**
 * Ray vs. the build volume, in cell units. Returns the side the ray meets —
 * from outside the box that is the entry face, from inside (the usual pose
 * while building) the exit face, so aiming at a wall always names that wall.
 * @param {number[]} origin  camera position in cells
 * @param {number[]} dir     view direction (need not be normalized)
 * @param {number[]} dims
 * @returns {{axis:number, sign:number, point:number[], dist:number, inside:boolean}|null}
 */
export function pickBoxFace(origin, dir, dims) {
  let tEnter = -Infinity;
  let tExit = Infinity;
  let enterAxis = -1;
  let enterSign = 0;
  let exitAxis = -1;
  let exitSign = 0;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(dir[a]) < 1e-9) {
      if (origin[a] < 0 || origin[a] > dims[a]) return null; // parallel and outside the slab
      continue;
    }
    let t1 = (0 - origin[a]) / dir[a];
    let t2 = (dims[a] - origin[a]) / dir[a];
    let s1 = -1;
    let s2 = 1;
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      [s1, s2] = [s2, s1];
    }
    if (t1 > tEnter) {
      tEnter = t1;
      enterAxis = a;
      enterSign = s1;
    }
    if (t2 < tExit) {
      tExit = t2;
      exitAxis = a;
      exitSign = s2;
    }
    if (tEnter > tExit) return null;
  }
  if (tExit < 0 || exitAxis < 0) return null; // the box is behind the camera
  const inside = tEnter < 0;
  const t = inside ? tExit : tEnter;
  const axis = inside ? exitAxis : enterAxis;
  const sign = inside ? exitSign : enterSign;
  return {
    axis,
    sign,
    inside,
    dist: t,
    point: [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t],
  };
}

/**
 * Slide every piece of prefab content by `shift` cells. The baseplate (y<0) is
 * left alone — the session re-lays it under the new volume — and so are the
 * chunk/light refreshes, which are the caller's job.
 * @returns {number} how many things moved
 */
export function translatePrefabContent(world, shift) {
  if (!shift || shift.every((n) => n === 0)) return 0;
  const [dx, dy, dz] = shift;
  const voxels = [];
  const items = [];
  const decals = [];
  const mobs = [];
  const npcs = [];
  world.forEachVoxel((v) => {
    if (v.anchor[1] < 0) return;
    voxels.push({ type: v.type, size: v.size, anchor: [...v.anchor], rotation: v.rotation ?? 0, variant: v.variant ?? null });
  });
  world.forEachItem((it) => {
    if (it.anchor[1] < 0) return;
    items.push({ itemId: it.itemId, cells: it.cells, anchor: [...it.anchor], rotation: it.rotation ?? 0 });
  });
  world.forEachDecal((d) => {
    if (d.cell[1] < 0) return;
    decals.push({ decalId: d.decalId, cell: [...d.cell], face: d.face, rotation: d.rotation ?? 0 });
  });
  // Face paint is keyed to cells, and removing a voxel strips its paint, so
  // it has to be captured here and re-applied after the blocks land again.
  const paint = [];
  world.forEachPaint?.((p) => {
    if (p.y < 0) return;
    paint.push({ x: p.x, y: p.y, z: p.z, face: p.face, type: p.type });
  });
  world.forEachMobSpawn((s) => mobs.push({ type: s.type, x: s.x, y: s.y, z: s.z }));
  world.forEachNpcSpawn((s) => npcs.push({ type: s.type, x: s.x, y: s.y, z: s.z }));

  // Clear first, then re-place: a shift smaller than the build would otherwise
  // overwrite cells it is about to read.
  for (const d of decals) world.removeDecal(d.cell[0], d.cell[1], d.cell[2], d.face);
  for (const it of items) world.removeItemAt(it.anchor[0], it.anchor[1], it.anchor[2]);
  for (const v of voxels) world.remove(v.anchor[0], v.anchor[1], v.anchor[2]);
  for (const s of mobs) world.removeMobSpawnAt(s.x, s.y, s.z);
  for (const s of npcs) world.removeNpcSpawnAt(s.x, s.y, s.z);

  for (const v of voxels) world.place(v.type, v.size, v.anchor[0] + dx, v.anchor[1] + dy, v.anchor[2] + dz, v.rotation, v.variant);
  for (const it of items) world.placeItem(it.itemId, it.cells, it.anchor[0] + dx, it.anchor[1] + dy, it.anchor[2] + dz, it.rotation);
  for (const d of decals) world.placeDecal(d.decalId, d.cell[0] + dx, d.cell[1] + dy, d.cell[2] + dz, d.face, d.rotation);
  for (const p of paint) world.paintFace(p.x + dx, p.y + dy, p.z + dz, p.face, p.type);
  for (const s of mobs) world.addMobSpawn(s.type, s.x + dx, s.y + dy, s.z + dz);
  for (const s of npcs) world.addNpcSpawn(s.type, s.x + dx, s.y + dy, s.z + dz);
  return voxels.length + items.length + decals.length + mobs.length + npcs.length;
}
