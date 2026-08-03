// Mob.js — pure mob AI for the playable game.
//
// No three.js/DOM so it unit tests in Node. A mob is a feet-centered AABB moved
// against the voxel grid with the same Physics helpers as the player, following
// A* waypoints from its NavMesh. State machine: idle -> chase -> attack, plus a
// hurt flash and a dead timer. Mobs aggro on sight (LOS + radius) or on damage,
// chase while the player stays in sight, and strike melee when close enough.
// Climbing a 0.5 m step slows the mob down (slopes/stairs cost time).

import { CELL_SIZE } from '../engine/Space.js';
import { moveWithStep, groundedAt, moveAxis } from '../engine/Physics.js';

const CLIMB_SLOW = 0.55; // speed multiplier while stepping up a block
const WINDUP_FRAC = 0.4; // share of the attack cycle spent winding up
const GRAVITY = 24; // m/s^2, same as the player
/** Eye height above feet for LOS checks — also used by MobManager's shared LOS. */
export const MOB_EYE_HEIGHT = 1.15;
const REPATH_INTERVAL = 0.5; // s between path recomputes
const REPATH_GOAL_DIST = 4; // m the player must move to force a repath
const STUCK_TIME = 0.6; // s of no progress before the mob backs out
const DEATH_TIME = 2.2; // s a corpse lingers before it's removed
/** How close the mob must get to a waypoint before advancing to the next. */
const WAYPOINT_SNAP = 0.18;
/** Swing distance (in cells) past a corner waypoint along the incoming
 *  direction, so the mob rounds corners wide instead of stopping on them. */
const TURN_OVERSHOOT_CELLS = 0.5;
/** Seconds a chasing mob stands and "looks around" after losing sight of the
 *  player before resuming its path to the last known spot. */
const LOST_SIGHT_GRACE = 0.15;
const LOST_SIGHT_PAUSE = 0.45;
/** Seconds the mob backs away from a genuine wedge before repathing. */
const UNWEDGE_TIME = 0.3;
/** Within this distance (m) of the player a chasing mob flanks instead of
 *  converging on the player's exact cell — it aims at a ring point around the
 *  player so a pack spreads out instead of stacking into one sprite. */
const SURROUND_DIST = 3;
/** Ring radius factor: how far out of attack range the flank point sits. */
const SURROUND_FACTOR = 0.65;

export class Mob {
  /**
   * @param {object} deps
   * @param {object} deps.type      mob definition from mobTypes
   * @param {[number,number,number]} deps.spawnCell  feet cell (x, y, z)
   * @param {object} deps.world     collision world facade (get(x,y,z))
   * @param {import('../engine/NavMesh.js').NavMesh} deps.nav
   * @param {number} [deps.aggroDelay]  seconds a mob waits after first sight
   *   before aggroing, so a pack wakes in a wave instead of all at once
   * @param {(damage:number, pos:{x:number,y:number,z:number})=>void} deps.onDamagePlayer
   */
  constructor({ type, spawnCell, world, nav, aggroDelay = 0, onDamagePlayer }) {
    this.type = type;
    this.world = world;
    this.nav = nav;
    this.onDamagePlayer = onDamagePlayer;
    this.halfWidth = type.halfWidth;
    this.height = type.height;
    this.stepHeight = 0.5;

    // Per-mob variance so a pack feels alive: slight speed difference and a
    // fixed flank angle spread the mobs out, and a small aggro delay staggers
    // when they wake.
    this.speedJitter = 0.9 + Math.random() * 0.2;
    this.spreadAngle = Math.random() * Math.PI * 2;
    this.aggroDelay = aggroDelay;
    this._aggroTimer = 0;

    const cx = spawnCell[0];
    const cz = spawnCell[2];
    const surfaceY = nav.surfaceYAtCell(cx, cz, spawnCell[1]);
    // Spawn points can sit one cell off the floor; snap to the walkable surface.
    this.valid = surfaceY !== null;
    this.pos = {
      x: cx * CELL_SIZE + CELL_SIZE / 2,
      y: surfaceY ?? spawnCell[1] * CELL_SIZE,
      z: cz * CELL_SIZE + CELL_SIZE / 2,
    };

    this.health = type.health;
    this.aggro = false;
    this.grounded = true;
    this.velY = 0;

    this.state = 'idle';
    this.animName = 'idle';
    this.animTime = Math.random() * 2;

    this.attackTimer = 0;
    this.hurtTimer = 0;
    this.dead = false;
    this.deadTimer = 0;

    this.path = [];
    this.pathIndex = 0;
    // Jitter the first repath so a group of freshly-aggroed mobs doesn't all
    // run A* on the same frame. The idle->chase transition forces an immediate
    // repath, so the jitter only spreads later recomputes.
    this._repathTimer = Math.random() * REPATH_INTERVAL;
    this._stuckTime = 0;
    this._lastGoal = { x: this.pos.x, z: this.pos.z };
    // "Lost sight" search pause: while chasing, if the mob can't see the
    // player for LOST_SIGHT_GRACE it pauses once for LOST_SIGHT_PAUSE to look
    // around, then keeps hunting. Repeats only after it sees the player again.
    this._searching = false;
    this._searchTimer = 0;
    this._losLostTimer = 0;
    this._searched = false;
    // Fallback when genuinely wedged: back away briefly, then repath.
    this._unwedge = null; // { timer, vx, vz }
    // Set when the mob lands after being airborne: a stale mid-air path no
    // longer matches the surface it touched, so it must re-path immediately.
    this._justLanded = false;
    /** Set by MobManager each frame: whether this mob can currently see the
     *  player. Undefined (unit tests / no manager) falls back to a real ray. */
    this.sharedVisible = undefined;
  }

  _box() {
    const p = this.pos;
    return {
      minX: p.x - this.halfWidth,
      maxX: p.x + this.halfWidth,
      minY: p.y,
      maxY: p.y + this.height,
      minZ: p.z - this.halfWidth,
      maxZ: p.z + this.halfWidth,
    };
  }

  _distTo(player) {
    const dx = player.x - this.pos.x;
    const dz = player.z - this.pos.z;
    return Math.hypot(dx, dz);
  }

  /** 3D distance to the player (feet to feet). Attack reach is measured in all
   *  three axes so a mob below/above the player can't strike them. */
  _reachTo(player) {
    const dx = player.x - this.pos.x;
    const dy = player.y - this.pos.y;
    const dz = player.z - this.pos.z;
    return Math.hypot(dx, dy, dz);
  }

  _canSee(player) {
    // Prefer the manager's shared per-bucket verdict (one raycast per group of
    // mobs). Falls back to an exact ray when there's no manager (unit tests).
    if (this.sharedVisible !== undefined) return this.sharedVisible;
    return this.nav.hasLOS(
      this.pos.x, this.pos.y + MOB_EYE_HEIGHT, this.pos.z,
      player.x, player.y + MOB_EYE_HEIGHT, player.z,
    );
  }

  /**
   * Advance one frame.
   * @param {number} dt seconds
   * @param {{x:number,y:number,z:number}} player  player feet position (m)
   */
  update(dt, player) {
    this.animTime += dt;

    if (this.dead) {
      this.deadTimer -= dt;
      return;
    }
    if (this.hurtTimer > 0) this.hurtTimer -= dt;

    // Fall whenever airborne, in every state. Gravity is decoupled from
    // movement so a mob with no path (or one pausing/attacking) still comes
    // back down instead of hovering.
    this._applyGravity(dt);
    if (this._justLanded) {
      // The path was computed mid-air and points at a node we've now landed
      // on (or above). Drop it so a fresh path is traced from this surface.
      this._justLanded = false;
      this.path = [];
      this._repathTimer = 0;
    }

    const d = this._distTo(player);
    const los = this._canSee(player);

    // Aggro on sight (with a per-mob delay so the pack wakes in a wave) or
    // instantly once harmed. The timer only accumulates while the condition
    // holds — lose sight and it resets, so a mob that glanced at you from afar
    // doesn't quietly aggro later.
    if (!this.aggro && d < this.type.aggroRadius && los) {
      this._aggroTimer += dt;
      if (this._aggroTimer >= this.aggroDelay) this.aggro = true;
    } else {
      this._aggroTimer = 0;
    }

    if (this.state === 'idle' && !this.aggro) {
      this.animName = 'idle';
      return;
    }

    if (this.aggro && this.state === 'idle') {
      this.state = 'chase';
      this._repathTimer = 0; // path immediately on first aggro
    }

    // In reach + sight -> attack (wind up, then strike). Reach is 3D so a mob
    // below the player can't bite them, and the mob must be on the ground (a
    // falling one would otherwise stop mid-air and hover).
    const inReach = this.grounded && this._reachTo(player) <= this.type.attackRange && los;
    if (this.state === 'chase' && inReach) {
      this.state = 'attack';
      // Jitter the wind-up start so a pack's strikes don't land in sync.
      this.attackTimer = this.type.attackCooldown * WINDUP_FRAC + Math.random() * 0.2;
    } else if (this.state === 'attack' && !inReach) {
      this.state = 'chase';
      this._repathTimer = 0; // the player moved away — path immediately
    }

    if (this.state === 'attack') {
      this.animName = 'attack';
      this.attackTimer -= dt;
      if (this.attackTimer <= 0) {
        // Strike lands if the player is still in reach (3D) with sight.
        if (this._reachTo(player) <= this.type.attackRange && los) {
          this.onDamagePlayer(this.type.damage, {
            x: this.pos.x,
            y: this.pos.y + this.height * 0.55,
            z: this.pos.z,
          });
        }
        this.attackTimer = this.type.attackCooldown;
      }
      return;
    }

    // Chase.
    if (this._searching) {
      // Paused to "look around" after losing sight; move on once the timer
      // runs out or the player comes back into view. Gravity still applies.
      this.animName = 'idle';
      this._searchTimer -= dt;
      if (los) {
        this._searching = false;
        this._losLostTimer = 0;
        this._searched = false;
      } else if (this._searchTimer <= 0) {
        this._searching = false;
      }
      return;
    }
    if (los) {
      this._losLostTimer = 0;
      this._searched = false;
    } else if (!this._searched) {
      this._losLostTimer += dt;
      if (this._losLostTimer > LOST_SIGHT_GRACE) {
        this._searching = true;
        this._searchTimer = LOST_SIGHT_PAUSE;
        this._searched = true;
      }
    }

    if (this._unwedge) {
      // Back out along the recorded direction, then give up the path so a
      // fresh one is computed from the new spot. The stored value is a speed
      // (m/s); scale it by dt so the mob shuffles back instead of lurching.
      this._unwedge.timer -= dt;
      this._moveHorizontal(this._unwedge.vx * dt, this._unwedge.vz * dt, dt);
      if (this._unwedge.timer <= 0) {
        this._unwedge = null;
        this.path = [];
        this._stuckTime = 0;
      }
      return;
    }

    this.animName = 'walk';
    this._repathTimer -= dt;
    const goalMoved = Math.hypot(player.x - this._lastGoal.x, player.z - this._lastGoal.z);
    if (this._repathTimer <= 0 && (this.path.length === 0 || goalMoved > REPATH_GOAL_DIST)) {
      this._repath(player);
      this._repathTimer = REPATH_INTERVAL;
    }
    this._followPath(dt);
  }

  _repath(player) {
    const start = this.nav.nearestNode(this.pos.x, this.pos.y, this.pos.z);
    // Close in: aim at a point on a ring around the player (this mob's own
    // flank angle) instead of the player's exact cell, so a pack surrounds the
    // player instead of stacking. Fall back to the player node when the ring
    // point isn't on the nav mesh (e.g. it lands inside a wall).
    const playerNode = this.nav.nearestNode(player.x, player.y, player.z);
    if (!start || !playerNode) {
      this.path = [];
      return;
    }
    let goal = playerNode;
    if (this._distTo(player) <= SURROUND_DIST) {
      const r = this.type.attackRange * SURROUND_FACTOR;
      const gx = player.x + Math.cos(this.spreadAngle) * r;
      const gz = player.z + Math.sin(this.spreadAngle) * r;
      const flank = this.nav.nearestNode(gx, player.y, gz) ?? playerNode;
      // A flank point can sit in a different nav region (across a wall); when
      // there's no route to it, keep approaching the player's own node instead
      // of re-pathing to an unreachable point forever.
      this.path = this.nav.findPath(start, flank) ?? [];
      if (this.path.length) {
        goal = flank;
      } else {
        this.path = this.nav.findPath(start, playerNode) ?? [];
      }
    } else {
      this.path = this.nav.findPath(start, playerNode) ?? [];
    }
    this.pathIndex = 0;
    this._lastGoal = { x: player.x, z: player.z };
  }

  /**
   * Move the AABB by (nx, nz) meters with step-up, then write the result back
   * to this.pos. Gravity is handled separately (see _applyGravity). Returns the
   * horizontal distance actually travelled.
   */
  _moveHorizontal(nx, nz, dt) {
    const oldX = this.pos.x;
    const oldZ = this.pos.z;
    let box = this._box();
    box = moveWithStep(this.world, box, nx, nz, this.stepHeight, this.grounded);
    this.pos.x = box.minX + this.halfWidth;
    this.pos.y = box.minY;
    this.pos.z = box.minZ + this.halfWidth;
    this.grounded = groundedAt(this.world, box);
    return Math.hypot(this.pos.x - oldX, this.pos.z - oldZ);
  }

  /**
   * Apply gravity: when airborne, accelerate downward and move the AABB down,
   * stopping at the first solid below. The fall is capped so one frame (even a
   * lag spike with a large clamped dt) can never skip past a full block, which
   * would tunnel the mob through the floor.
   */
  _applyGravity(dt) {
    if (this.grounded) return;
    this.velY -= GRAVITY * dt;
    this.velY = Math.max(this.velY, -(CELL_SIZE * 0.9) / Math.max(dt, 1e-6));
    const box = this._box();
    const ym = moveAxis(this.world, box, 'y', this.velY * dt);
    if (ym.hit) {
      this.velY = 0;
      this.grounded = true;
      this._justLanded = true;
    }
    this.pos.y = box.minY;
  }

  /** True when the path turns perpendicularly at `wp` (not straight or reversed). */
  _isTurn(prev, wp, next) {
    const inX = wp.x - prev.x;
    const inZ = wp.z - prev.z;
    const outX = next.x - wp.x;
    const outZ = next.z - wp.z;
    return inX * outX + inZ * outZ === 0;
  }

  _followPath(dt) {
    while (this.path.length > 0) {
      const i = this.pathIndex;
      const wp = this.path[i];
      let tx = wp.x * CELL_SIZE + CELL_SIZE / 2;
      let tz = wp.z * CELL_SIZE + CELL_SIZE / 2;

      // Swing wide at corners: aim slightly PAST a turning waypoint along the
      // incoming direction, so the mob rounds the corner instead of stopping
      // on it. Only when there's room — the cell just past the corner must be
      // walkable (keeps the swing inside corridors/ledges).
      const prev = i > 0 ? this.path[i - 1] : null;
      const next = i < this.path.length - 1 ? this.path[i + 1] : null;
      if (prev && next && this._isTurn(prev, wp, next)) {
        const inX = wp.x - prev.x;
        const inZ = wp.z - prev.z;
        const len = Math.hypot(inX, inZ) || 1;
        const ox = wp.x + (inX / len) * TURN_OVERSHOOT_CELLS;
        const oz = wp.z + (inZ / len) * TURN_OVERSHOOT_CELLS;
        if (this.nav.nearestNodeAtCell(Math.round(ox), Math.round(oz), wp.y)) {
          tx = ox * CELL_SIZE + CELL_SIZE / 2;
          tz = oz * CELL_SIZE + CELL_SIZE / 2;
        }
      }

      const dx = tx - this.pos.x;
      const dz = tz - this.pos.z;
      const dist = Math.hypot(dx, dz);
      // Advance only when the mob is actually AT this waypoint's surface. A
      // drop waypoint sits below the mob's current ledge, so being 2D-close
      // isn't enough — otherwise it would "arrive" without falling, exhaust the
      // path and strand the mob on the ledge.
      const yDist = Math.abs(wp.y * CELL_SIZE - this.pos.y);
      if (dist < WAYPOINT_SNAP && yDist < this.stepHeight - 0.05) {
        this.pathIndex++;
        if (this.pathIndex >= this.path.length) {
          this.path = [];
          return;
        }
        continue;
      }

      // Climbing a step above the current surface is slower.
      const targetY = wp.y * CELL_SIZE;
      let speed = this.type.speed * this.speedJitter;
      if (targetY > this.pos.y + 0.05) speed *= CLIMB_SLOW;

      // Clamp each axis to a full step toward the target. This makes the mob
      // converge EXACTLY on the waypoint instead of approaching it
      // asymptotically — an asymptote left the AABB straddling a wall column by
      // a hair, permanently blocking the perpendicular move at corners.
      const step = speed * dt;
      const nx = Math.max(-step, Math.min(step, dx));
      const nz = Math.max(-step, Math.min(step, dz));
      const requested = Math.hypot(nx, nz);

      const actual = this._moveHorizontal(nx, nz, dt);

      // Stuck detection: not moving while a path expects movement.
      if (requested > 0.03 && actual < 0.01) this._stuckTime += dt;
      else this._stuckTime = 0;
      if (this._stuckTime > STUCK_TIME) {
        this._stuckTime = 0;
        this._startUnwedge();
      }
      return;
    }

    // No path: stand and face the player (unreachable / aggro without path).
    this.animName = 'idle';
  }

  /** Back away from the blocked target briefly, so a fresh repath has room. */
  _startUnwedge() {
    const wp = this.path[this.pathIndex];
    if (!wp) {
      this.path = [];
      return;
    }
    const tx = wp.x * CELL_SIZE + CELL_SIZE / 2;
    const tz = wp.z * CELL_SIZE + CELL_SIZE / 2;
    let dx = this.pos.x - tx; // away from the target
    let dz = this.pos.z - tz;
    const len = Math.hypot(dx, dz) || 1;
    const back = this.type.speed * 0.5 * this.speedJitter;
    this._unwedge = { timer: UNWEDGE_TIME, vx: (dx / len) * back, vz: (dz / len) * back };
  }

  /**
   * Take damage. Always aggroes; may die.
   * @returns {boolean} true when this killed the mob
   */
  takeDamage(amount) {
    if (this.dead) return false;
    this.health -= amount;
    this.aggro = true;
    this.hurtTimer = 0.18;
    if (this.health <= 0) {
      this.dead = true;
      this.deadTimer = DEATH_TIME;
      this.state = 'dead';
      this.animName = 'dead';
      this.animTime = 0;
      return true;
    }
    if (this.state !== 'attack') this.state = 'chase';
    return false;
  }
}
