// BloodDecals.js — blood stains stamped onto the world when mobs are hit.
//
// Complements BloodFX (the flying droplets): where droplets are eye-candy
// that fades in half a second, these pin the 'decal_blood' cutout onto voxel
// faces through the world's decal system, so a firefight leaves the room
// painted with the story of what happened there.
//
// Mechanics:
//  - Wall spray: the shot's momentum carries blood PAST the mob — a short
//    jittered ray from the mob's chest along the bullet path stamps the
//    first surface it hits within WALL_REACH, spun a random quarter turn.
//    Shooting a mob against a wall paints the wall; near a floor edge the
//    spray can land on the ground behind it instead.
//  - Floor drips: wounds drip straight down — each hit has DRIP_CHANCE to
//    stain the ground under a random spot near the mob's feet; a kill pours
//    a big 2x2 'decal_blood_pool' under the corpse (falling back to
//    KILL_POOL small stamps when the pool doesn't fit).
//  - Variety: each stamp picks a random tile for its surface — walls favor
//    'decal_blood2' (runs bleeding down), floors favor the classic splatter;
//    'decal_blood3' (fine mist) shows up on both — plus a random quarter
//    turn, so no two fights paint the same pattern.
//  - Stains never overwrite existing decals (editor-placed art is safe, and
//    an already-bloody face stays as it is — density self-limits), only land
//    on full cube faces, and live in a FIFO budget: past MAX_STAINS the
//    oldest stain is peeled off, so long sessions don't paint the whole map.
//
// The game world is a runtime copy (World.copyFrom on load), so stains are
// transient per session and never reach the editor's save.

import { raycastVoxel } from '../engine/VoxelRaycaster.js';
import { worldToCell } from '../engine/Space.js';
import { shapeFor } from '../engine/VoxelTypes.js';
import { bulletWorld } from '../editor/itemPick.js';

// Stamp tiles by surface: runs read as gravity on walls, splatter on floors;
// repeats weight the pick.
const WALL_STAMPS = ['decal_blood', 'decal_blood2', 'decal_blood2', 'decal_blood3'];
const FLOOR_STAMPS = ['decal_blood', 'decal_blood', 'decal_blood3'];
const POOL_ID = 'decal_blood_pool'; // 2x2 pool poured under a kill
const MAX_STAINS = 64;   // live-stain budget; oldest peels off past this
const WALL_REACH = 8;    // cells the wall spray travels past the mob (4 m)
const DRIP_REACH = 6;    // cells to search down for a floor under the mob
const DRIP_CHANCE = 0.6; // per-hit chance of a floor drip
const KILL_POOL = 3;     // floor stamps dumped under a kill

/** Decal face name for a raycast hit normal. */
function faceFromNormal(n) {
  if (n[0]) return n[0] > 0 ? 'px' : 'nx';
  if (n[1]) return n[1] > 0 ? 'py' : 'ny';
  if (n[2]) return n[2] > 0 ? 'pz' : 'nz';
  return null;
}

export class BloodDecals {
  /** @param {object} deps @param {import('../engine/World.js').World} deps.world */
  constructor({ world }) {
    this.world = world;
    /** @type {{cell:[number,number,number], face:string}[]} oldest first */
    this._stains = [];
  }

  /** Splatter for one hit on `mob`. `dir` is the shot/swing direction
   *  ({x,y,z} unit vector); `killed` dumps the kill pool under the corpse. */
  splatter(mob, dir, killed = false) {
    // Wall spray behind the mob, jittered so a burst fans out over the wall.
    const chest = worldToCell([mob.pos.x, mob.pos.y + mob.height * 0.5, mob.pos.z]);
    this._stampRay(chest, [
      dir.x + (Math.random() - 0.5) * 0.3,
      dir.y + (Math.random() - 0.5) * 0.3,
      dir.z + (Math.random() - 0.5) * 0.3,
    ], WALL_REACH);
    // A kill pours the big pool under the corpse; small drips otherwise (or
    // when the pool found no room).
    if (killed && this._stampPool(mob)) return;
    const drips = killed ? KILL_POOL : (Math.random() < DRIP_CHANCE ? 1 : 0);
    const spread = mob.halfWidth + (killed ? 0.5 : 0.2); // meters around the feet
    for (let i = 0; i < drips; i++) {
      const feet = worldToCell([
        mob.pos.x + (Math.random() - 0.5) * 2 * spread,
        mob.pos.y + 0.1,
        mob.pos.z + (Math.random() - 0.5) * 2 * spread,
      ]);
      this._stampRay(feet, [0, -1, 0], DRIP_REACH);
    }
  }

  /** Walk a ray (cell units) and stamp a stain on the face it enters.
   *  Shoot-through blocks (fences, bars) let the blood pass, like bullets. */
  _stampRay(origin, dir, reach) {
    const len = Math.hypot(dir[0], dir[1], dir[2]);
    if (len < 1e-6) return false;
    const hit = raycastVoxel(bulletWorld(this.world), origin, [dir[0] / len, dir[1] / len, dir[2] / len], reach);
    if (!hit) return false;
    const face = faceFromNormal(hit.normal);
    if (!face) return false; // ray started inside a block
    return this._stamp(hit.cell, face);
  }

  _stamp(cell, face) {
    const set = (face === 'py' || face === 'ny') ? FLOOR_STAMPS : WALL_STAMPS;
    return this._place(set[Math.floor(Math.random() * set.length)], cell, face);
  }

  /** Pour the 2x2 kill pool on the floor under the mob: find the ground with
   *  a down-ray, then try the four anchors that put the corpse inside the
   *  pool's footprint. False when none fits (broken floor, crowded faces). */
  _stampPool(mob) {
    const feet = worldToCell([mob.pos.x, mob.pos.y + 0.1, mob.pos.z]);
    const hit = raycastVoxel(bulletWorld(this.world), feet, [0, -1, 0], DRIP_REACH);
    if (!hit || faceFromNormal(hit.normal) !== 'py') return false;
    const [fx, fy, fz] = hit.cell;
    for (const [ox, oz] of [[-1, -1], [-1, 0], [0, -1], [0, 0]]) {
      if (this._place(POOL_ID, [fx + ox, fy, fz + oz], 'py')) return true;
    }
    return false;
  }

  _place(decalId, [x, y, z], face) {
    const voxel = this.world.get(x, y, z);
    if (!voxel || shapeFor(voxel.type) !== 'cube') return false;
    const rotation = Math.floor(Math.random() * 4);
    // placeDecal refuses occupied faces — existing decals (ours or the
    // editor's) win, so blood never paints over placed art.
    if (!this.world.placeDecal(decalId, x, y, z, face, rotation)) return false;
    this._stains.push({ cell: [x, y, z], face });
    while (this._stains.length > MAX_STAINS) {
      const old = this._stains.shift();
      this.world.removeDecal(old.cell[0], old.cell[1], old.cell[2], old.face);
    }
    return true;
  }

  /** Forget all bookkeeping (world reload — copyFrom already reset decals). */
  reset() {
    this._stains.length = 0;
  }
}
