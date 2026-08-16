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
import { randomMobSkin } from './mobSprites.js';
import { NavMesh, hasLineOfSight } from '../engine/NavMesh.js';
import { getMob, randomMobHeight, MOB_HEIGHT_MAX } from '../engine/mobTypes.js';
import { collisionWorld } from '../editor/itemPick.js';

/** Edge length of a shared-LOS bucket in meters (kept small so walls split
 *  buckets instead of being straddled). */
const LOS_BUCKET = 1.5;
/** Seconds a non-aggro bucket's LOS verdict is reused before recompute. */
const LOS_REFRESH = 0.2;
/** Cap on cached LOS entries (drops stale ones past this). */
const LOS_CACHE_MAX = 256;
/** Max meters a mob may be pushed by overlap resolution in a single frame, so
 *  a pile eases apart over a few frames instead of teleporting a mob clear
 *  across a room. Small: crowd spacing is the mobs' own steering separation
 *  now — this pass only fixes true overlaps (e.g. mobs parked in attack). */
const OVERLAP_RELAX = 0.08;
/** Packs smaller than this never flank — everyone charges. */
const FLANK_MIN_PACK = 3;

/** Respawn delay rolled anew for every cleared wave (seconds, uniform). */
const RESPAWN_DELAY_MIN = 20;
const RESPAWN_DELAY_MAX = 50;
/** Proximity radius rolled once per spawn point (meters): the countdown only
 *  runs while the player is farther than this — camping a cleared spawn holds
 *  it empty, walking away starts the clock. */
const RESPAWN_CLEAR_MIN = 10;
const RESPAWN_CLEAR_MAX = 18;
/** A ripe spawn holds while its point sits inside the player's view cone
 *  (ground-plane cos threshold) — mobs never pop in on screen. */
const RESPAWN_VIEW_DOT = 0.2;
/** Waves grow by one mob every other clear, capped here. */
const RESPAWN_WAVE_MAX = 3;
/** Seconds before a ripe spawn that found no walkable cell retries. */
const RESPAWN_RETRY = 5;

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
    this.respawns = []; // one entry per viable spawn point (see rebuild)
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
    this.respawns = [];
    this._losCache.clear();
    this._losClock = 0;

    const types = new Set();
    this.world.forEachMobSpawn((s) => types.add(s.type));
    for (const id of types) {
      const def = getMob(id);
      if (!def) continue;
      // Clearance for the tallest a mob of this type may roll, so every one of
      // them fits everywhere its shared navmesh says it can walk.
      const height = Math.max(def.height, MOB_HEIGHT_MAX);
      this.navs.set(id, new NavMesh(this.solidWorld, { halfWidth: def.halfWidth, height }));
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
        // A spawn point says what a mob *is*; which of the drawn characters it
        // looks like, and how tall it stands, are rolled here so a crowd is a
        // mix rather than a row of clones. Stats and AI are untouched.
        skin: randomMobSkin(),
        height: randomMobHeight(),
        onDamagePlayer: this.onDamagePlayer,
      });
      if (!mob.valid) return; // spawn has no walkable surface — skip
      // Every viable spawn point respawns forever: proximity radius rolled
      // once per point, delay re-rolled per wave (see _updateRespawns).
      const entry = {
        type: s.type,
        cell: [s.x, s.y, s.z],
        x: mob.pos.x,
        z: mob.pos.z,
        clearRadius: RESPAWN_CLEAR_MIN + Math.random() * (RESPAWN_CLEAR_MAX - RESPAWN_CLEAR_MIN),
        alive: 1,
        timer: 0,
        waves: 0,
        // authored spawner settings (see World.addMobSpawn): loot pool the
        // point's mobs may drop, and its respawn-delay range override
        loot: s.loot ?? null,
        delay: s.delay ?? null,
      };
      mob._respawn = entry;
      this.respawns.push(entry);
      this.mobs.push(mob);
      this.renderer.addMob(mob);
    });
  }

  /** The navmesh for a mob type, built on demand — dynamic spawns (quest
   *  packs) may use types no editor-placed spawn point did. */
  _navFor(typeId) {
    let nav = this.navs.get(typeId);
    if (!nav) {
      const def = getMob(typeId);
      if (!def) return null;
      const height = Math.max(def.height, MOB_HEIGHT_MAX);
      nav = new NavMesh(this.solidWorld, { halfWidth: def.halfWidth, height });
      this.navs.set(typeId, nav);
    }
    return nav;
  }

  /**
   * Spawn `count` live mobs around a feet cell at runtime — quest slay packs
   * (see GameApp._spawnQuestMobs). Mobs fan out over a ring of nearby cells
   * so a pack doesn't materialize inside one another; cells with no walkable
   * surface are skipped (the candidate ring cycles, so a valid cell can host
   * more than one mob — overlap resolution eases them apart).
   * @param {string} typeId  mob type
   * @param {[number,number,number]} cell  feet cell to spawn around
   * @param {number} [count]
   * @param {object} [origin]  respawn entry the new mobs count against — only
   *   passed by _updateRespawns; quest packs stay untracked
   * @returns {number} how many actually spawned
   */
  spawnAt(typeId, cell, count = 1, origin = null) {
    const def = getMob(typeId);
    const nav = this._navFor(typeId);
    if (!def || !nav) return 0;
    const ring = [
      [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1],
      [2, 0], [-2, 0], [0, 2], [0, -2], [2, 1], [-2, -1], [1, 2], [-1, -2],
    ];
    let spawned = 0;
    let slot = 0;
    for (let attempts = 0; spawned < count && attempts < count * ring.length; attempts++) {
      const [dx, dz] = ring[slot % ring.length];
      slot++;
      const mob = new Mob({
        type: def,
        spawnCell: [cell[0] + dx, cell[1], cell[2] + dz],
        world: this.solidWorld,
        nav,
        aggroDelay: Math.random() * 0.3,
        skin: randomMobSkin(),
        height: randomMobHeight(),
        onDamagePlayer: this.onDamagePlayer,
      });
      if (!mob.valid) continue;
      if (origin) mob._respawn = origin;
      this.mobs.push(mob);
      this.renderer.addMob(mob);
      spawned++;
    }
    return spawned;
  }

  /** Rebuild the nav meshes over the current solid world without touching
   *  the live mobs — doors opening and closing change what is walkable, and
   *  mobs can't toggle doors themselves, so this is how a closed door makes
   *  them re-route. Every mob is pointed at its type's fresh mesh and forced
   *  to repath on its next update. */
  refreshNav() {
    for (const id of [...this.navs.keys()]) {
      const def = getMob(id);
      if (!def) continue;
      const height = Math.max(def.height, MOB_HEIGHT_MAX);
      this.navs.set(id, new NavMesh(this.solidWorld, { halfWidth: def.halfWidth, height }));
    }
    for (const mob of this.mobs) {
      const nav = this.navs.get(mob.type.id);
      if (!nav) continue;
      mob.nav = nav;
      mob.path = [];
      mob.pathIndex = 0;
      mob._repathTimer = 0;
    }
    this._losCache.clear();
  }

  /**
   * Advance all mobs + their billboards.
   * @param {number} dt seconds
   * @param {{x:number,y:number,z:number}} player  player feet position (m)
   * @param {{x:number,z:number}|null} [facing]  player view direction on the
   *   ground plane (unit), so flankers can aim outside the player's cone;
   *   null/omitted when unknown (tests, looking straight up/down)
   */
  update(dt, player, facing = null) {
    this._losClock += dt;
    this._updateSharedLOS(player);
    this._assignNeighbors();
    this.renderer.update(dt);
    let shouters = null;
    for (let i = this.mobs.length - 1; i >= 0; i--) {
      const mob = this.mobs[i];
      mob.playerFacing = facing ?? undefined;
      mob.update(dt, player);
      // A tracked mob's death is what clears its spawn point — the countdown
      // arms the moment the last one drops, not when the corpse fades.
      if (mob.dead && mob._respawn && !mob._respawnCounted) {
        mob._respawnCounted = true;
        const r = mob._respawn;
        if (--r.alive <= 0) {
          r.waves++;
          const [lo, hi] = r.delay ?? [RESPAWN_DELAY_MIN, RESPAWN_DELAY_MAX];
          r.timer = lo + Math.random() * Math.max(0, hi - lo);
        }
      }
      // Any aggro mob that hasn't sounded its alarm yet shouts, exactly once —
      // whether it aggroed from sight, from damage, or was one-shot before its
      // own update (a kill should still raise the pack).
      if (mob.aggro && !mob._shouted) (shouters ??= []).push(mob);
      if (mob.dead && mob.deadTimer <= 0) {
        this.mobs.splice(i, 1);
        this.renderer.removeMob(mob);
      }
    }
    if (shouters) {
      for (const mob of shouters) {
        mob._shouted = true;
        this.alertNear(mob);
      }
    }
    this._resolveOverlaps(player);
    this._updateRespawns(dt, player, facing);
  }

  /**
   * Endless-waves respawn (Dying Light style): a cleared spawn point re-arms
   * itself. Once every mob a point owns is dead, its randomized countdown
   * runs — but only while the player is beyond the point's clearRadius, so
   * camping the spot holds it empty and walking away starts the clock. A ripe
   * point spawns its next wave only while OUTSIDE the player's view cone
   * (ground-plane dot test), so mobs never pop in on screen; until then it
   * holds at zero, ready the moment the player turns away. Waves grow by one
   * mob every other clear (capped at RESPAWN_WAVE_MAX) — the world presses
   * harder the longer you stay.
   */
  _updateRespawns(dt, player, facing) {
    for (const r of this.respawns) {
      if (r.alive > 0) continue;
      const dx = r.x - player.x;
      const dz = r.z - player.z;
      const dist = Math.hypot(dx, dz);
      if (dist < r.clearRadius) continue; // player still on top of it — hold
      r.timer -= dt;
      if (r.timer > 0) continue;
      // Ripe. Spawning while the point is on screen would pop mobs in — hold
      // until the player faces away (unknown facing spawns; it means the
      // player is looking straight up or down).
      if (facing && (dx * facing.x + dz * facing.z) / dist > RESPAWN_VIEW_DOT) continue;
      const count = Math.min(RESPAWN_WAVE_MAX, 1 + (r.waves >> 1));
      const spawned = this.spawnAt(r.type, r.cell, count, r);
      if (spawned > 0) r.alive = spawned;
      else r.timer = RESPAWN_RETRY; // nothing walkable right now — retry later
    }
  }

  /**
   * A mob's alarm cry: every packmate within ITS OWN alertRadius of the
   * shouter is alerted — primed to aggro after its usual wake delay, handed
   * the shouter's last-known player position to hunt. Deliberately NOT gated
   * on line of sight (sound carries through walls; the modest radius keeps
   * distant rooms asleep) and deliberately single-hop: alerted mobs never
   * re-shout (see Mob._shouted), so one sniped mob wakes its pack, not the
   * whole map in a chain.
   */
  alertNear(source) {
    const group = [source];
    for (const mob of this.mobs) {
      if (mob === source || mob.dead) continue;
      const dx = mob.pos.x - source.pos.x;
      const dz = mob.pos.z - source.pos.z;
      const r = mob.type.alertRadius;
      if (dx * dx + dz * dz > r * r) continue;
      // Mobs already in the fight still count toward the pack size (and may
      // pick up a flank role); only sleepers get the actual alert.
      if (!mob.aggro && !mob.alerted) mob.alert(source.lkp);
      group.push(mob);
    }
    this._assignFlankRoles(group);
  }

  /**
   * Split an engagement group into chargers and flankers: at most a third
   * flank (alternating left/right), the rest press head-on so the player is
   * never left unpressured. Small packs never flank. Assignment order follows
   * the mob list, so it is deterministic and testable; the shouter itself
   * always charges (the mob you just shot coming straight at you reads
   * better than it veering off sideways).
   */
  _assignFlankRoles(group) {
    if (group.length < FLANK_MIN_PACK) return;
    const quota = Math.floor(group.length / 3);
    let flankers = 0;
    for (const m of group) {
      if (m.flankRole !== 'direct') flankers++;
    }
    for (let i = 1; i < group.length && flankers < quota; i++) {
      const m = group[i];
      if (m.flankRole !== 'direct' || m._flankDone) continue;
      m.flankRole = flankers % 2 === 0 ? 'flankL' : 'flankR';
      flankers++;
    }
  }

  /**
   * Hand every mob its nearby alive packmates for this frame — the input to
   * each mob's own steering separation. Buckets on the same coarse grid as the
   * shared-LOS pass (a mob's separation radius fits within one bucket ring),
   * so the cost is O(mobs), not O(mobs^2).
   */
  _assignNeighbors() {
    const buckets = new Map();
    for (const mob of this.mobs) {
      if (mob.dead) {
        mob.neighbors = [];
        continue;
      }
      const kx = Math.floor(mob.pos.x / LOS_BUCKET);
      const kz = Math.floor(mob.pos.z / LOS_BUCKET);
      mob._nbKx = kx;
      mob._nbKz = kz;
      const key = `${kx}|${kz}`;
      let arr = buckets.get(key);
      if (!arr) buckets.set(key, (arr = []));
      arr.push(mob);
    }
    for (const mob of this.mobs) {
      if (mob.dead) continue;
      const list = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const arr = buckets.get(`${mob._nbKx + dx}|${mob._nbKz + dz}`);
          if (!arr) continue;
          for (const m of arr) if (m !== mob) list.push(m);
        }
      }
      mob.neighbors = list;
    }
  }

  /**
   * Safety net under the mobs' own steering separation: fix true overlaps only
   * — mobs standing inside each other (a pack parked in attack state doesn't
   * steer) — and keep mobs off the player's body. Horizontal only (mobs on
   * different floors may legitimately share x/z).
   *
   * Each mob accumulates ONE push from every overlapping neighbor plus the
   * player, clamps it to a small per-frame maximum, then applies it through
   * Mob.nudge — which resolves against solid cells, so a mob slides along
   * walls instead of clipping into them. Clamping keeps a pile from shoving
   * any single mob several meters in one frame (no teleports).
   */
  _resolveOverlaps(player) {
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

      // Away from every crowding mob on the same floor. The spacing target
      // matches the mobs' own steering separation; this pass mostly matters
      // for mobs parked in attack state (which don't steer) — the gentle
      // per-frame clamp is what keeps it from fighting path following.
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
      const s = Math.min(len, OVERLAP_RELAX);
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
