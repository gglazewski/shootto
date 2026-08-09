// Physics.js — pure AABB-vs-voxel collision helpers.
//
// The world is a grid of 0.5 m cells (CELL_SIZE); every occupied cell is solid
// regardless of whether it belongs to a SMALL or BIG voxel, so per-cell checks
// are correct for both sizes. These functions are deliberately free of
// three.js/DOM so they can be unit tested in Node.
//
// AABB convention: { minX, minY, minZ, maxX, maxY, maxZ } in world meters.

import { CELL_SIZE } from './Space.js';
import { solidYRange } from './VoxelShape.js';

export const GROUND_EPS = 0.002;

/**
 * Solid y-interval of an occupied cell in world meters, honoring slab
 * variants, clipped to the cell. Returns null for a full cell (the common
 * case — callers skip the interval math), or an empty interval ([a, a])
 * for the carved-away cell layer of a BIG half block.
 */
function cellSolidY(voxel, cy) {
  if (voxel.variant == null) return null;
  const [lo, hi] = solidYRange(voxel, cy);
  const y0 = Math.max(cy, lo) * CELL_SIZE;
  const y1 = Math.min(cy + 1, hi) * CELL_SIZE;
  return [y0, Math.max(y0, y1)];
}

/** World-coordinate cell indices spanned by an AABB, inclusive per axis. */
export function aabbCells(minX, minY, minZ, maxX, maxY, maxZ) {
  const x0 = Math.floor(minX / CELL_SIZE);
  const x1 = Math.ceil(maxX / CELL_SIZE) - 1;
  const y0 = Math.floor(minY / CELL_SIZE);
  const y1 = Math.ceil(maxY / CELL_SIZE) - 1;
  const z0 = Math.floor(minZ / CELL_SIZE);
  const z1 = Math.ceil(maxZ / CELL_SIZE) - 1;
  const out = [];
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++) out.push([x, y, z]);
  return out;
}

/** True when the AABB overlaps any solid cell. */
export function collides(world, box) {
  const cells = aabbCells(box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ);
  for (const [x, y, z] of cells) {
    const voxel = world.get(x, y, z);
    if (!voxel) continue;
    const span = cellSolidY(voxel, y);
    if (!span) return true;
    if (box.minY < span[1] && box.maxY > span[0]) return true;
  }
  return false;
}

const AXIS = { x: 0, y: 1, z: 2 };
const MIN = ['minX', 'minY', 'minZ'];
const MAX = ['maxX', 'maxY', 'maxZ'];

/**
 * Move an AABB along one axis by `delta` meters and resolve collisions by
 * snapping to the offending cell boundary. Returns { moved, hit }.
 * Mutates `box` in place.
 */
export function moveAxis(world, box, axis, delta) {
  if (delta === 0) return { moved: 0, hit: false };
  const i = AXIS[axis];
  const minK = MIN[i];
  const maxK = MAX[i];
  const startMin = box[minK];
  const startMax = box[maxK];
  box[minK] += delta;
  box[maxK] += delta;

  const cells = aabbCells(box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ);
  let stop = null;
  for (const c of cells) {
    const voxel = world.get(c[0], c[1], c[2]);
    if (!voxel) continue;
    // Slab variants: the cell is only solid over part of its height. Skip
    // cells the box does not overlap vertically; on the y axis the slab's
    // own top/bottom (not the cell boundary) is the snapping plane.
    const span = cellSolidY(voxel, c[1]);
    if (span && (box.minY >= span[1] || box.maxY <= span[0])) continue;
    const lo = i === 1 && span ? span[0] : c[i] * CELL_SIZE;
    const hi = i === 1 && span ? span[1] : (c[i] + 1) * CELL_SIZE;
    stop = stop === null ? (delta > 0 ? lo : hi) : delta > 0 ? Math.min(stop, lo) : Math.max(stop, hi);
  }
  if (stop === null) return { moved: delta, hit: false };

  const width = startMax - startMin;
  if (delta > 0) {
    box[maxK] = stop;
    box[minK] = stop - width;
  } else {
    box[minK] = stop;
    box[maxK] = stop + width;
  }
  return { moved: box[maxK] - startMax, hit: true };
}

/** True when a box shifted just below its feet touches anything (on ground). */
export function groundedAt(world, box) {
  const probe = {
    minX: box.minX,
    minY: box.minY - GROUND_EPS,
    minZ: box.minZ,
    maxX: box.maxX,
    maxY: box.maxY - GROUND_EPS,
    maxZ: box.maxZ,
  };
  return collides(world, probe);
}

/**
 * Move an AABB horizontally, automatically stepping up onto low obstacles
 * (up to `stepHeight`, e.g. 0.5 m blocks) when grounded. Tries the move at the
 * current height first; if it is blocked and a box raised by stepHeight fits
 * (no ceiling, no overlap at the destination) and gets further, that result is
 * used instead. Returns a new box. Does not mutate `box`.
 */
export function moveWithStep(world, box, dx, dz, stepHeight, grounded) {
  return moveWithStepEx(world, box, dx, dz, stepHeight, grounded).box;
}

/**
 * Like moveWithStep, but returns hit metadata alongside the box:
 * { box, hitX, hitZ, steppedUp }. The horizontal move is attempted in BOTH
 * axis orders (x-then-z and z-then-x) and the order that travels further wins —
 * resolving one axis first snaps the box flush against a face, which used to
 * block the other axis on diagonal approaches to corners. The step-up retry is
 * judged by total travel too, so a 0.5 m block approached diagonally (where no
 * single axis improves on its own) still steps.
 *
 * opts.slide: when exactly one axis hit (and no step happened), spend the
 * unused magnitude along the free axis so the mover keeps its speed along a
 * wall instead of grinding into it. Off by default — the player's feel and
 * tests expect the plain per-axis clamp. opts.slideCapX / opts.slideCapZ bound
 * the EXTRA distance slide may add on that axis, so a mover aiming almost
 * straight at a narrow gap converges onto the gap line instead of being flung
 * past it by the redirected speed.
 */
export function moveWithStepEx(world, box, dx, dz, stepHeight, grounded, opts = {}) {
  const attempt = (src, xFirst) => {
    const b = { ...src };
    let rx, rz;
    if (xFirst) {
      rx = moveAxis(world, b, 'x', dx);
      rz = moveAxis(world, b, 'z', dz);
    } else {
      rz = moveAxis(world, b, 'z', dz);
      rx = moveAxis(world, b, 'x', dx);
    }
    return { box: b, hitX: rx.hit, hitZ: rz.hit, travel: Math.hypot(rx.moved, rz.moved) };
  };
  const pick = (src) => {
    const a = attempt(src, true);
    if (!a.hitX && !a.hitZ) return a; // free move: both orders are identical
    const b = attempt(src, false);
    return b.travel > a.travel + 1e-9 ? b : a;
  };

  let best = pick(box);
  let steppedUp = false;

  if (grounded && (best.hitX || best.hitZ)) {
    const raisedSrc = { ...box };
    if (!moveAxis(world, raisedSrc, 'y', stepHeight).hit) {
      const raised = pick(raisedSrc);
      if (!collides(world, raised.box) && raised.travel > best.travel + 1e-9) {
        best = raised;
        steppedUp = true;
      }
    }
  }

  if (opts.slide && !steppedUp && best.hitX !== best.hitZ) {
    const want = Math.hypot(dx, dz);
    const got = Math.hypot(best.box.minX - box.minX, best.box.minZ - box.minZ);
    const leftover = want - got;
    if (leftover > 1e-6) {
      // Slide only along an axis the mover already intended to travel — a
      // head-on hit must not invent sideways motion.
      if (best.hitX && dz !== 0) {
        const amount = Math.min(leftover, opts.slideCapZ ?? Infinity);
        if (amount > 0 && moveAxis(world, best.box, 'z', Math.sign(dz) * amount).hit) best.hitZ = true;
      } else if (best.hitZ && dx !== 0) {
        const amount = Math.min(leftover, opts.slideCapX ?? Infinity);
        if (amount > 0 && moveAxis(world, best.box, 'x', Math.sign(dx) * amount).hit) best.hitX = true;
      }
    }
  }

  return { box: best.box, hitX: best.hitX, hitZ: best.hitZ, steppedUp };
}
