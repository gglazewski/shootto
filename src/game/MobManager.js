// MobManager.js — owns the live mobs for the playable game.
//
// Builds a NavMesh per mob type from the (immutable) world, instantiates a Mob
// for every editor-placed spawn point, advances them each frame and handles
// player attacks that aim at a mob. Player-facing callbacks (damage taken, kill
// counts) are delegated out so GameApp can own HUD/death logic.
//
// Per-frame line-of-sight is shared between mobs that stand near each other:
// mobs are grouped into coarse 3D buckets and ONE ray is cast per occupied
// bucket each frame, from the group's eye centroid to the player. Buckets with
// aggro mobs always recompute (strikes depend on it); other buckets only matter
// while a mob is within aggro range and reuse a recent verdict. A mob in a
// distant bucket gets its own blocked/clear result, so a cluster can spot you
// without magically aggroing mobs on the other side of a wall.

import { Mob } from './Mob.js';
import { MOB_EYE_HEIGHT } from './Mob.js';
import { MobRenderer } from './MobRenderer.js';
import { NavMesh, hasLineOfSight } from '../engine/NavMesh.js';
import { getMob } from '../engine/mobTypes.js';
import { collisionWorld } from '../editor/itemPick.js';

/** Edge length of a shared-LOS bucket in meters (kept small so walls split
 *  buckets instead of being straddled). */
const LOS_BUCKET = 1.5;
/** Seconds a non-aggro bucket's LOS verdict is reused before recompute. */
const LOS_REFRESH = 0.2;
/** Cap on cached LOS entries (drops stale ones past this). */
const LOS_CACHE_MAX = 256;
/** Max meters a mob may be pushed by separation in a single frame, so a large
 *  cluster eases apart over a few frames instead of teleporting a mob clear
 *  across a room. */
const MAX_SEPARATION = 0.2;

/** Ray vs AABB intersection (slab method). @returns distance t or Infinity. */
function rayAabb(ox, oy, oz, dx, dy, dz, box) {
  const invX = dx === 0 ? Infinity : 1 / dx;
  const invY = dy === 0 ? Infinity : 1 / dy;
  const invZ = dz === 0 ? Infinity : 1 / dz;
  const tx1 = (box.minX - ox) * invX;
  const tx2 = (box.maxX - ox) * invX;
  const ty1 = (box.minY - oy) * invY;
  const ty2 = (box.maxY - oy) * invY;
  const tz1 = (box.minZ - oz) * invZ;
  const tz2 = (box.maxZ - oz) * invZ;
  const tmin = Math.max(Math.min(tx1, tx2), Math.min(ty1, ty2), Math.min(tz1, tz2));
  const tmax = Math.min(Math.max(tx1, tx2), Math.max(ty1, ty2), Math.max(tz1, tz2));
  if (tmax < 0 || tmin > tmax) return Infinity;
  return tmin < 0 ? tmax : tmin;
}

export class MobManager {
  /**
   * @param {object} deps
   * @param {object} deps.THREE
   * @param {import('three').Scene} deps.scene  ignored when `renderer` is given
   * @param {import('../engine/World.js').World} deps.world  raw world (not a
   *   facade) — spawn points and bounds come from here
   * @param {(damage:number, pos:{x:number,y:number,z:number})=>void} deps.onDamagePlayer
   * @param {object} [deps.lightField]  passed to the billboard renderer so mobs
   *   are lit by the world's light engine
   * @param {object} [deps.material]  map-less lit ShaderMaterial whose uniforms
   *   drive the sprite tint (see MobRenderer)
   * @param {import('three').Camera} [deps.camera]
   * @param {object} [deps.renderer]  billboard renderer (injectable for tests;
   *   defaults to MobRenderer)
   */
  constructor({ THREE, scene, world, onDamagePlayer, lightField = null, material = null, camera = null, renderer }) {
    this.THREE = THREE;
    this.world = world;
    this.solidWorld = collisionWorld(world);
    this.onDamagePlayer = onDamagePlayer;

    this.renderer = renderer ?? new MobRenderer({ THREE, scene, lightField, material, camera });
    this.mobs = [];
    this.navs = new Map(); // typeId -> NavMesh
    this.kills = 0;
    this._losCache = new Map(); // bucketKey -> { time, visible }
    this._losClock = 0;
  }

  /** (Re)build the nav meshes and spawn every placed mob. */
  rebuild() {
    this.renderer.clear();
    this.mobs = [];
    this.navs.clear();
    this.kills = 0;
    this._losCache.clear();
    this._losClock = 0;

    const types = new Set();
    this.world.forEachMobSpawn((s) => types.add(s.type));
    for (const id of types) {
      const def = getMob(id);
      if (!def) continue;
      this.navs.set(id, new NavMesh(this.solidWorld, { halfWidth: def.halfWidth, height: def.height }));
    }

    this.world.forEachMobSpawn((s) => {
      const def = getMob(s.type);
      if (!def) return;
      const nav = this.navs.get(s.type);
      if (!nav) return;
      const mob = new Mob({
        type: def,
        spawnCell: [s.x, s.y, s.z],
        world: this.solidWorld,
        nav,
        aggroDelay: Math.random() * 0.3,
        onDamagePlayer: this.onDamagePlayer,
      });
      if (!mob.valid) return; // spawn has no walkable surface — skip
      this.mobs.push(mob);
      this.renderer.addMob(mob);
    });
  }

  /** Advance all mobs + their billboards. @param {number} dt seconds */
  update(dt, player) {
    this._losClock += dt;
    this._updateSharedLOS(player);
    this.renderer.update(dt);
    for (let i = this.mobs.length - 1; i >= 0; i--) {
      const mob = this.mobs[i];
      mob.update(dt, player);
      if (mob.dead && mob.deadTimer <= 0) {
        this.mobs.splice(i, 1);
        this.renderer.removeMob(mob);
      }
    }
    this._separate(player);
  }

  /**
   * Push overlapping mobs apart so a pack doesn't stack into one sprite, and
   * nudge mobs off the player's own body. Horizontal only (mobs on different
   * floors may legitimately share x/z).
   *
   * Each mob accumulates ONE separation vector from every overlapping neighbor
   * plus the player, clamps it to a small per-frame maximum, then applies it
   * through Mob.nudge — which resolves against solid cells, so a mob slides
   * along walls instead of clipping into them. Clamping keeps a big cluster
   * from shoving any single mob several meters in one frame (no teleports).
   */
  _separate(player) {
    const mobs = this.mobs;
    for (let i = 0; i < mobs.length; i++) {
      const a = mobs[i];
      if (a.dead) continue;
      let dx = 0;
      let dz = 0;

      // Off the player's body (the player doesn't move, so the mob takes the
      // full overlap).
      const pdx = a.pos.x - player.x;
      const pdz = a.pos.z - player.z;
      const pd = Math.hypot(pdx, pdz);
      const minP = a.halfWidth + 0.28;
      if (pd > 1e-4 && pd < minP) {
        const push = minP - pd;
        dx += (pdx / pd) * push;
        dz += (pdz / pd) * push;
      }

      // Away from every overlapping mob on the same floor.
      for (let j = i + 1; j < mobs.length; j++) {
        const b = mobs[j];
        if (b.dead) continue;
        if (Math.abs(a.pos.y - b.pos.y) > 0.4) continue;
        const ox = a.pos.x - b.pos.x;
        const oz = a.pos.z - b.pos.z;
        const d = Math.hypot(ox, oz);
        const min = (a.halfWidth + b.halfWidth) * 2 + 0.05;
        if (d >= min) continue;
        if (d < 1e-4) {
          dx += 0.06;
          dz += 0.06;
          continue;
        }
        const push = (min - d) * 0.5; // each mob takes half the overlap
        dx += (ox / d) * push;
        dz += (oz / d) * push;
      }

      const len = Math.hypot(dx, dz);
      if (len < 1e-4) continue;
      const s = Math.min(len, MAX_SEPARATION);
      a.nudge((dx / len) * s, (dz / len) * s);
    }
  }

  /** Coarse 3D bucket a mob belongs to (x, z, and floor all matter). */
  _bucketKey(mob) {
    return `${Math.floor(mob.pos.x / LOS_BUCKET)}|${Math.floor(mob.pos.z / LOS_BUCKET)}|${Math.floor(mob.pos.y / LOS_BUCKET)}`;
  }

  _inAggroRange(mob, player) {
    const dx = player.x - mob.pos.x;
    const dz = player.z - mob.pos.z;
    const r = mob.type.aggroRadius;
    return dx * dx + dz * dz < r * r;
  }

  /**
   * Compute ONE line-of-sight verdict per bucket of mobs and stamp it on every
   * mob in that bucket (`mob.sharedVisible`). Only buckets that matter this
   * frame cast a ray:
   *  - buckets holding an aggro mob always recompute (attack/strike need it),
   *  - buckets with a mob inside aggro range recompute at most every LOS_REFRESH,
   *  - everything else is stamped false without casting anything, so a far-away
   *    idle mob never "sees" the player and never pays for a raycast.
   */
  _updateSharedLOS(player) {
    for (const mob of this.mobs) mob.sharedVisible = false;

    const buckets = new Map(); // key -> { ex, ey, ez, count, need, hasAggro }
    for (const mob of this.mobs) {
      if (mob.dead) continue;
      const key = this._bucketKey(mob);
      mob._losKey = key;
      let b = buckets.get(key);
      if (!b) {
        b = { ex: 0, ey: 0, ez: 0, count: 0, need: false, hasAggro: false };
        buckets.set(key, b);
      }
      b.ex += mob.pos.x;
      b.ey += mob.pos.y + MOB_EYE_HEIGHT;
      b.ez += mob.pos.z;
      b.count++;
      if (mob.aggro) b.hasAggro = true;
      else if (this._inAggroRange(mob, player)) b.need = true;
    }

    const py = player.y + MOB_EYE_HEIGHT;
    for (const [key, b] of buckets) {
      if (!b.need && !b.hasAggro) continue; // nobody here can aggro this frame
      const cached = this._losCache.get(key);
      const fresh = cached && this._losClock - cached.time < LOS_REFRESH;
      if (!b.hasAggro && fresh) {
        b.visible = cached.visible;
      } else {
        b.visible = hasLineOfSight(
          this.solidWorld,
          b.ex / b.count, b.ey / b.count, b.ez / b.count,
          player.x, py, player.z,
        );
        this._losCache.set(key, { time: this._losClock, visible: b.visible });
      }
    }
    if (this._losCache.size > LOS_CACHE_MAX) {
      for (const [k, v] of this._losCache) {
        if (this._losClock - v.time > 1) this._losCache.delete(k);
      }
    }

    for (const mob of this.mobs) {
      if (mob.dead) continue;
      const b = buckets.get(mob._losKey);
      if (b && (b.need || b.hasAggro)) mob.sharedVisible = b.visible;
    }
  }

  /**
   * Closest alive mob the camera ray hits, or null.
   * @param {import('three').Camera} camera
   * @param {import('three').Vector3} [dir]  aim direction; defaults to the
   *   camera's forward so it can match a weapon's spread ray.
   * @returns {{mob: import('./Mob.js').Mob, dist: number}|null}
   */
  aimHit(camera, dir) {
    const origin = camera.position;
    const d = dir ?? camera.getWorldDirection(new this.THREE.Vector3());
    let best = null;
    let bestT = Infinity;
    for (const mob of this.mobs) {
      if (mob.dead) continue;
      const t = rayAabb(
        origin.x, origin.y, origin.z,
        d.x, d.y, d.z,
        {
          minX: mob.pos.x - mob.halfWidth,
          maxX: mob.pos.x + mob.halfWidth,
          minY: mob.pos.y,
          maxY: mob.pos.y + mob.height,
          minZ: mob.pos.z - mob.halfWidth,
          maxZ: mob.pos.z + mob.halfWidth,
        },
      );
      if (t < bestT) {
        bestT = t;
        best = mob;
      }
    }
    return best ? { mob: best, dist: bestT } : null;
  }
}
