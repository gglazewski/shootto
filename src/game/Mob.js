// Mob.js — pure mob AI for the playable game.
//
// No three.js/DOM so it unit tests in Node. A mob is a feet-centered AABB moved
// against the voxel grid with the same Physics helpers as the player, following
// A* waypoints from its NavMesh. State machine: idle -> chase -> attack, plus a
// hurt flash and a dead timer. Mobs aggro on sight (LOS + radius) or on damage,
// chase while the player stays in sight, and strike melee when close enough.
// Climbing a 0.5 m step slows the mob down (slopes/stairs cost time).

import { CELL_SIZE } from '../engine/Space.js';
import { moveWithStepEx, groundedAt, moveAxis } from '../engine/Physics.js';

const CLIMB_SLOW = 0.55; // speed multiplier while stepping up a block
const WINDUP_FRAC = 0.4; // share of the attack cycle spent winding up
const GRAVITY = 24; // m/s^2, same as the player
/** Eye height above feet for LOS checks — also used by MobManager's shared LOS. */
export const MOB_EYE_HEIGHT = 1.15;
const REPATH_INTERVAL = 0.5; // s between path recomputes
const REPATH_GOAL_DIST = 4; // m the player must move to force a repath
const STUCK_TIME = 0.6; // s of no progress before the mob backs out
const DEATH_TIME = 2.2; // s a corpse lingers before it's removed
/** Knockback friction (1/s velocity decay): a shot-shoved mob bleeds its push
 *  off as it slides, so a hit carries it a fixed distance instead of leaving
 *  it drifting. */
const KNOCK_FRICTION = 4;
/** Steering acceleration (m/s^2) toward the desired velocity — full speed from
 *  standstill in ~0.25s, and the cap on how sharply a running mob can turn. */
const ACCEL = 18;
/** Neighbor separation: mobs within this range (m) push on each other... */
const SEP_RADIUS = 1.1;
/** ...with a steering acceleration capped here (m/s^2). Softer than ACCEL so
 *  the crowd spreads without overpowering path following. */
const SEP_ACCEL = 12;
/** Max waypoints the smoothed path target may look ahead (cells). */
const LOOKAHEAD_CELLS = 6;
/** Decelerate inside this range (m) of the FINAL path point (anti-orbit). */
const ARRIVE_RADIUS = 0.6;
/** How close (m) counts as having passed a waypoint. */
const ADVANCE_RADIUS = 0.3;
/** Falls shorter than this (m) keep the current path — only a real drop makes
 *  a mid-air path stale. Walking down stairs must not re-path every step. */
const FALL_REPATH_MIN = 0.55;
/** Seconds a chasing mob stands and "looks around" after losing sight of the
 *  player before resuming its path to the last known spot. */
const LOST_SIGHT_GRACE = 0.15;
const LOST_SIGHT_PAUSE = 0.45;
/** Seconds the mob backs away from a genuine wedge before repathing. */
const UNWEDGE_TIME = 0.3;
/** Within this distance (m) of the player a chasing mob spreads instead of
 *  converging on the player's exact cell — it aims at a ring point around the
 *  player so a pack fans out instead of stacking into one sprite. */
const SURROUND_DIST = 3;
/** Ring radius factor: how far out of attack range the ring point sits. */
const SURROUND_FACTOR = 0.65;
/** Flanker approach: beyond this distance (m) a mob with a flank role routes
 *  toward a point beside-and-behind the player instead of straight at them;
 *  inside it the flank is done and the normal press/surround takes over. */
const FLANK_ENGAGE_DIST = 6;
/** How far out to the player's side the flank point sits (m). */
const FLANK_SIDE_DIST = 5;
/** How far behind the player's view direction the flank point sits (m). */
const FLANK_BEHIND_DIST = 2;
/** Failed flank paths before the mob gives up and charges head-on. */
const FLANK_FAIL_MAX = 2;
/** Seconds a mob remembers being under fire after a hit. It sets the panic
 *  pacing: a recently-shot mob chains its juke hops back to back (frantic
 *  darting) and skips the stop-and-look pause; a calm panic rests between
 *  hops (agitated pacing). */
const THREAT_TIME = 6;
/** Seconds of standing still (in chase, strike not landed) before the hunt
 *  counts as stalled and flips into panic. */
const STALL_PANIC_TIME = 0.5;
/** Juke hop length (m): far enough to actually displace, short enough to
 *  stay twitchy. */
const EVADE_HOP_MIN = 2;
const EVADE_HOP_MAX = 5;
/** Seconds between re-tries of the real goal while panicking (a sighted
 *  player is re-tried at every hop end instead). */
const EVADE_RETRY_INTERVAL = 2;
/** Breather between calm-panic hops (min + random spread), seconds. */
const EVADE_REST_MIN = 0.4;
const EVADE_REST_VAR = 0.8;

export class Mob {
  /**
   * @param {object} deps
   * @param {object} deps.type      mob definition from mobTypes
   * @param {[number,number,number]} deps.spawnCell  feet cell (x, y, z)
   * @param {object} deps.world     collision world facade (get(x,y,z))
   * @param {import('../engine/NavMesh.js').NavMesh} deps.nav
   * @param {number} [deps.aggroDelay]  seconds a mob waits after first sight
   *   before aggroing, so a pack wakes in a wave instead of all at once
   * @param {string} [deps.skin]  which character sheet the billboard draws
   *   (see mobSprites.MOB_SKINS) — cosmetic only, picked once at spawn
   * @param {number} [deps.height]  standing height in meters, rolled at spawn
   *   (see mobTypes.randomMobHeight); defaults to the type's own height
   * @param {(damage:number, pos:{x:number,y:number,z:number})=>void} deps.onDamagePlayer
   */
  constructor({ type, spawnCell, world, nav, aggroDelay = 0, skin = null, height = 0, onDamagePlayer }) {
    this.type = type;
    this.skin = skin;
    this.world = world;
    this.nav = nav;
    this.onDamagePlayer = onDamagePlayer;
    this.halfWidth = type.halfWidth;
    // Its own height. MobManager builds each navmesh with clearance for the
    // tallest a mob may roll, so it can always stand where its path takes it.
    this.height = height || type.height;
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
    /** Woken by a packmate's alarm cry: aggroes after aggroDelay without
     *  needing range or line of sight. See MobManager.alertNear. */
    this.alerted = false;
    /** This mob's alarm has already sounded (it shouted, or it was woken BY a
     *  shout) — alarms propagate exactly one hop, so a single shot can't
     *  cascade an entire map awake through walls. */
    this._shouted = false;
    /** Last position the player was KNOWN at: refreshed every sighted frame,
     *  seeded by the shot that hit this mob or by a packmate's alarm. A mob
     *  that can't see the player hunts this spot — not the player's live
     *  position, which it has no way of knowing. */
    this.lkp = null;
    this.grounded = true;
    this.velY = 0;
    // Horizontal velocity (m/s), driven by steering forces (seek + separation)
    // rather than direct waypoint-chasing, so crowds flow instead of clumping.
    this.vel = { x: 0, z: 0 };
    /** Nearby alive mobs, assigned by MobManager each frame (empty when there
     *  is no manager — unit tests get deterministic solo behavior). */
    this.neighbors = [];
    this._fallStartY = this.pos.y;
    this._unwedgeSide = 1;

    this.state = 'idle';
    this.animName = 'idle';
    this.animTime = Math.random() * 2;

    this.attackTimer = 0;
    this.hurtTimer = 0;
    /** Seconds a gun hit stops the mob: it can't move or attack while > 0.
     *  Set alongside hurtTimer by takeDamage's impact. */
    this.staggerTimer = 0;
    /** Knockback velocity (m/s) from a powerful shot, decaying with friction
     *  while the mob is staggered. Heavy mobs take less (see mass). */
    this.knock = { x: 0, z: 0 };
    /** Knockback resistance: the impulse a shot delivers is divided by this,
     *  so a heavy brute barely budges while a light imp is shoved back. */
    this.mass = type.mass ?? 1;
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
    /** Pack role, assigned by MobManager when an alarm raises a pack:
     *  'direct' charges head-on, 'flankL'/'flankR' swing wide to arrive from
     *  the player's sides — see the flank branch in _repath. */
    this.flankRole = 'direct';
    /** Player view direction {x,z} (unit), stamped by MobManager each frame so
     *  flankers can aim OUTSIDE the player's cone. Undefined in unit tests —
     *  the flank falls back to the approach direction. */
    this.playerFacing = undefined;
    this._flankFails = 0;
    this._flankDone = false;
    /** Seconds of "under fire" memory left (stamped by takeDamage). */
    this._threatTimer = 0;
    /** True while this.path leads to a random juke spot, not the player/lkp. */
    this._evading = false;
    /** Stall detector: last position the mob clearly moved from, and how long
     *  it has been standing there while wanting to chase. */
    this._stallPos = { x: this.pos.x, z: this.pos.z };
    this._stallTime = 0;
    this._evadeRest = 0;
    this._evadeRetry = 0;
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
    this._update(dt, player);
    // A hurt flash overrides the walk/attack/idle pose for its duration, so a
    // wounded mob visibly flinches instead of keeping its normal animation.
    if (this.hurtTimer > 0 && !this.dead) this.animName = 'hurt';
  }

  _update(dt, player) {
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

    // A gun hit stops the mob: while staggered it can't move or attack, and a
    // powerful shot slides it backward along the bullet path (knock friction
    // bleeds the push off). Gravity still applies, so a mob shoved off a ledge
    // falls properly.
    if (this.staggerTimer > 0) {
      this.staggerTimer -= dt;
      this.animName = 'hurt';
      if (this.knock.x || this.knock.z) {
        const r = this._moveHorizontal(this.knock.x * dt, this.knock.z * dt);
        if (r.hitX) this.knock.x = 0;
        if (r.hitZ) this.knock.z = 0;
        const decay = Math.max(0, 1 - KNOCK_FRICTION * dt);
        this.knock.x *= decay;
        this.knock.z *= decay;
        if (Math.hypot(this.knock.x, this.knock.z) < 0.02) {
          this.knock.x = 0;
          this.knock.z = 0;
        }
      }
      if (this.staggerTimer <= 0) {
        this.staggerTimer = 0;
        this.knock.x = 0;
        this.knock.z = 0;
      }
      return;
    }

    const d = this._distTo(player);
    const los = this._canSee(player);

    // Aggro on sight (with a per-mob delay so the pack wakes in a wave), on a
    // packmate's alarm (same delay — an alerted pack also wakes as a wave, not
    // a switch), or instantly once harmed. The sight timer only accumulates
    // while the condition holds — lose sight and it resets, so a mob that
    // glanced at you from afar doesn't quietly aggro later.
    if (!this.aggro && ((d < this.type.aggroRadius && los) || this.alerted)) {
      this._aggroTimer += dt;
      if (this._aggroTimer >= this.aggroDelay) this.aggro = true;
    } else {
      this._aggroTimer = 0;
    }

    // Keep the last-known position fresh while the player is in sight.
    if (this.aggro && los) {
      if (this.lkp) {
        this.lkp.x = player.x;
        this.lkp.y = player.y;
        this.lkp.z = player.z;
      } else {
        this.lkp = { x: player.x, y: player.y, z: player.z };
      }
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
    } else if (!this._searched && this._threatTimer <= 0) {
      // (Skipped while under fire — stopping to look around is what gets a
      // mob shot twice.)
      this._losLostTimer += dt;
      if (this._losLostTimer > LOST_SIGHT_GRACE) {
        this._searching = true;
        this._searchTimer = LOST_SIGHT_PAUSE;
        this._searched = true;
      }
    }

    if (this._unwedge) {
      // Shuffle out along the recorded direction, then give up the path so a
      // fresh one is computed from the new spot. The stored value is a speed
      // (m/s); scale it by dt so the mob shuffles instead of lurching.
      this._unwedge.timer -= dt;
      this._moveHorizontal(this._unwedge.vx * dt, this._unwedge.vz * dt);
      if (this._unwedge.timer <= 0) {
        // Seed the steering velocity along the sidestep so movement resumes
        // flowing instead of restarting from a dead stop into the same wall.
        this.vel.x = this._unwedge.vx;
        this.vel.z = this._unwedge.vz;
        this._unwedge = null;
        this.path = [];
        this._stuckTime = 0;
        this._repathTimer = 0;
      }
      return;
    }

    this.animName = 'walk';
    this._repathTimer -= dt;
    if (this._threatTimer > 0) this._threatTimer -= dt;
    // Hunt the player where the mob KNOWS them to be: the live position while
    // in sight, the last-known position when blind. A mob shot from cover
    // walks to where the shot came from instead of tracking the shooter
    // through walls.
    const goal = los ? player : (this.lkp ?? player);

    // Stall detection -> panic. A chasing mob that stops moving without
    // getting its strike in has nowhere useful to go: the player is up on an
    // unreachable perch (paths only reach the ground beneath them), the goal
    // is off the navmesh entirely, or a blind mob stands at an empty
    // last-known spot. A standing mob is a free target, so a stalled hunt
    // flips into panic — juking between random nearby spots.
    if (!this._evading && this.grounded) {
      const moved = Math.hypot(this.pos.x - this._stallPos.x, this.pos.z - this._stallPos.z);
      if (moved > this.type.speed * dt * 0.3) {
        this._stallTime = 0;
        this._stallPos.x = this.pos.x;
        this._stallPos.z = this.pos.z;
      } else {
        this._stallTime += dt;
      }
      if (this._stallTime > STALL_PANIC_TIME && this._pickEvadeHop()) {
        this._evading = true;
        this._stallTime = 0;
        this._evadeRest = 0;
        this._evadeRetry = EVADE_RETRY_INTERVAL;
      }
    }

    if (this._evading) {
      this._evadeRetry -= dt;
      if (this.path.length === 0) {
        // Between hops. A calm panic takes a breather first; a mob shot
        // within THREAT_TIME chains straight into the next dart.
        if (this._threatTimer <= 0 && this._evadeRest > 0) {
          this._evadeRest -= dt;
          this.animName = 'idle';
          return;
        }
        // Periodically (at every hop end once the player is in sight) re-try
        // the real goal — a usable path resumes the hunt, and the stall
        // detector re-enters panic if it leads nowhere useful.
        if (this._evadeRetry <= 0 || los) {
          this._evadeRetry = EVADE_RETRY_INTERVAL;
          this._repath(goal);
          this._repathTimer = REPATH_INTERVAL;
          if (this.path.length > 0) {
            this._evading = false;
            this._stallTime = 0;
            this._stallPos.x = this.pos.x;
            this._stallPos.z = this.pos.z;
          }
        }
        if (this._evading && !this._pickEvadeHop()) this._evading = false; // cornered
        if (this._evading) this._evadeRest = EVADE_REST_MIN + Math.random() * EVADE_REST_VAR;
      }
      if (this._evading) {
        this._followPath(dt);
        return;
      }
    }

    const goalMoved = Math.hypot(goal.x - this._lastGoal.x, goal.z - this._lastGoal.z);
    if (this._repathTimer <= 0 && (this.path.length === 0 || goalMoved > REPATH_GOAL_DIST)) {
      this._repath(goal);
      this._repathTimer = REPATH_INTERVAL;
    }
    this._followPath(dt);
  }

  /** Path to a random walkable spot EVADE_HOP_MIN..MAX away (one juke hop).
   *  Unpredictability is the point — no bias away from the player, because
   *  the mob doesn't know where the shots come from. False when no nearby
   *  spot is reachable (cornered). */
  _pickEvadeHop() {
    const start = this.nav.nearestNode(this.pos.x, this.pos.y, this.pos.z);
    if (!start) return false;
    for (let i = 0; i < 6; i++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = EVADE_HOP_MIN + Math.random() * (EVADE_HOP_MAX - EVADE_HOP_MIN);
      const node = this.nav.nearestNode(
        this.pos.x + Math.cos(ang) * dist,
        this.pos.y,
        this.pos.z + Math.sin(ang) * dist,
      );
      if (!node || node === start) continue;
      const path = this.nav.findPath(start, node);
      if (!path || !path.length) continue;
      this.path = path;
      this.pathIndex = 0;
      return true;
    }
    return false;
  }

  /**
   * A packmate's alarm: prime this mob to aggro (after its usual delay) and
   * hand it the position the alarm was about. No effect on mobs already in
   * the fight. One alarm never chains into another — see _shouted.
   */
  alert(lkp) {
    if (this.dead || this.aggro || this.alerted) return;
    this.alerted = true;
    this._shouted = true;
    if (lkp) this.lkp = { x: lkp.x, y: lkp.y, z: lkp.z };
  }

  /** Recompute the path toward `target` — the live player position when in
   *  sight, the last-known position when hunting blind. */
  _repath(target) {
    const start = this.nav.nearestNode(this.pos.x, this.pos.y, this.pos.z);
    const targetNode = this.nav.nearestNode(target.x, target.y, target.z);
    if (!start || !targetNode) {
      this.path = [];
      return;
    }

    // Flanker approach: while still outside engage range, route to a point
    // beside-and-behind the player's view so the pack arrives from more than
    // one direction. Unreachable flank points demote the mob to a direct
    // charge after a couple of tries; once close, the flank is done for this
    // engagement and the normal press/surround below takes over.
    if (this.flankRole !== 'direct' && !this._flankDone) {
      if (this._distTo(target) <= FLANK_ENGAGE_DIST) {
        this._flankDone = true;
      } else {
        // "Forward" is the player's view direction when the manager provides
        // it; otherwise assume the player faces this mob (they usually face
        // their attackers), which makes "behind" the far side.
        let fx;
        let fz;
        if (this.playerFacing && (this.playerFacing.x || this.playerFacing.z)) {
          fx = this.playerFacing.x;
          fz = this.playerFacing.z;
        } else {
          fx = this.pos.x - target.x;
          fz = this.pos.z - target.z;
        }
        const fl = Math.hypot(fx, fz) || 1;
        fx /= fl;
        fz /= fl;
        const sx = this.flankRole === 'flankL' ? -fz : fz;
        const sz = this.flankRole === 'flankL' ? fx : -fx;
        const gx = target.x + sx * FLANK_SIDE_DIST - fx * FLANK_BEHIND_DIST;
        const gz = target.z + sz * FLANK_SIDE_DIST - fz * FLANK_BEHIND_DIST;
        const flankNode = this.nav.nearestNode(gx, target.y, gz);
        const flankPath = flankNode ? this.nav.findPath(start, flankNode) : null;
        if (flankPath && flankPath.length) {
          this.path = flankPath;
          this.pathIndex = 0;
          this._lastGoal = { x: target.x, z: target.z };
          return;
        }
        this._flankFails++;
        if (this._flankFails >= FLANK_FAIL_MAX) this.flankRole = 'direct';
        // fall through to the direct path below
      }
    }

    let path = null;
    // Surround only when already on the target's level (within a step) — a mob
    // on a staircase or ledge must descend to the target's floor first,
    // otherwise it would stop mid-stairs to spread instead of pressing on.
    const sameLevel = Math.abs(target.y - this.pos.y) <= this.stepHeight;
    if (this._distTo(target) <= SURROUND_DIST && sameLevel) {
      const r = this.type.attackRange * SURROUND_FACTOR;
      const gx = target.x + Math.cos(this.spreadAngle) * r;
      const gz = target.z + Math.sin(this.spreadAngle) * r;
      const ring = this.nav.nearestNode(gx, target.y, gz);
      // A cell-snapped ring node can land just OUTSIDE attack range, which
      // leaves a mob parked and helpless a step away from the target — so only
      // spread to a node the mob can strike from; otherwise press to the
      // target node (or anywhere a path to it exists).
      if (ring && ring !== targetNode && this._nodeInReach(ring, target)) {
        path = this.nav.findPath(start, ring);
      }
    }
    this.path = path && path.length ? path : (this.nav.findPath(start, targetNode) ?? []);
    this.pathIndex = 0;
    this._lastGoal = { x: target.x, z: target.z };
  }

  /** True when a mob standing at `node`'s cell centre can reach the player
   *  horizontally within its attack range (flank positions must be attackable). */
  _nodeInReach(node, player) {
    const x = node.x * CELL_SIZE + CELL_SIZE / 2;
    const z = node.z * CELL_SIZE + CELL_SIZE / 2;
    return Math.hypot(x - player.x, z - player.z) <= this.type.attackRange;
  }

  /**
   * Move the AABB by (nx, nz) meters with step-up and wall slide, then write
   * the result back to this.pos. Gravity is handled separately (see
   * _applyGravity). Returns { dist, hitX, hitZ } — the horizontal distance
   * actually travelled plus which axes hit solid, so steering can zero the
   * blocked velocity components instead of grinding into walls.
   */
  _moveHorizontal(nx, nz, slideCapX = Infinity, slideCapZ = Infinity) {
    const oldX = this.pos.x;
    const oldZ = this.pos.z;
    const r = moveWithStepEx(this.world, this._box(), nx, nz, this.stepHeight, this.grounded, {
      slide: true,
      slideCapX,
      slideCapZ,
    });
    this.pos.x = r.box.minX + this.halfWidth;
    this.pos.y = r.box.minY;
    this.pos.z = r.box.minZ + this.halfWidth;
    this.grounded = groundedAt(this.world, r.box);
    return { dist: Math.hypot(this.pos.x - oldX, this.pos.z - oldZ), hitX: r.hitX, hitZ: r.hitZ };
  }

  /**
   * Push the mob horizontally by (nx, nz) meters, resolving against solid cells
   * so it slides along walls instead of clipping into them. No speed cap and no
   * step-up (separation pushes shouldn't climb). Grounded is re-checked so a
   * nudge that leaves a ledge is caught by gravity on the next frame. Used by
   * the manager's separation pass, which clamps the per-frame displacement.
   */
  nudge(nx, nz) {
    const box = this._box();
    moveAxis(this.world, box, 'x', nx);
    moveAxis(this.world, box, 'z', nz);
    this.pos.x = box.minX + this.halfWidth;
    this.pos.y = box.minY;
    this.pos.z = box.minZ + this.halfWidth;
    this.grounded = groundedAt(this.world, box);
  }

  /**
   * Apply gravity: when airborne, accelerate downward and move the AABB down,
   * stopping at the first solid below. The fall is capped so one frame (even a
   * lag spike with a large clamped dt) can never skip past a full block, which
   * would tunnel the mob through the floor.
   */
  _applyGravity(dt) {
    if (this.grounded) {
      this._fallStartY = this.pos.y;
      return;
    }
    this._fallStartY = Math.max(this._fallStartY, this.pos.y);
    this.velY -= GRAVITY * dt;
    this.velY = Math.max(this.velY, -(CELL_SIZE * 0.9) / Math.max(dt, 1e-6));
    const box = this._box();
    const ym = moveAxis(this.world, box, 'y', this.velY * dt);
    if (ym.hit) {
      this.velY = 0;
      this.grounded = true;
      // Only a genuine drop invalidates the path — stepping down half-blocks
      // (stairs) would otherwise re-run A* on every step and stutter.
      if (this._fallStartY - box.minY > FALL_REPATH_MIN) this._justLanded = true;
    }
    this.pos.y = box.minY;
  }

  /**
   * Pick the point the steering aims at: drop passed waypoints, then
   * string-pull — aim at the FURTHEST waypoint reachable in a straight
   * walkable line (footprint-aware), so the mob cuts corners smoothly instead
   * of tracing the staircase of cell centres A* returns.
   * @returns {{x:number,y:number,z:number,last:boolean}|null} world-space
   *   target (y = feet), or null when the path is done/empty.
   */
  _pickPathTarget() {
    while (this.path.length > 0) {
      const wp = this.path[this.pathIndex];
      const tx = wp.x * CELL_SIZE + CELL_SIZE / 2;
      const tz = wp.z * CELL_SIZE + CELL_SIZE / 2;
      const dist = Math.hypot(tx - this.pos.x, tz - this.pos.z);
      // Advance only when the mob is actually AT this waypoint's surface. A
      // drop waypoint sits below the mob's current ledge, so being 2D-close
      // isn't enough — otherwise it would "arrive" without falling, exhaust
      // the path and strand the mob on the ledge.
      const yDist = Math.abs(wp.y * CELL_SIZE - this.pos.y);
      if (dist < ADVANCE_RADIUS && yDist < this.stepHeight - 0.05) {
        this.pathIndex++;
        if (this.pathIndex >= this.path.length) {
          this.path = [];
          return null;
        }
        continue;
      }
      break;
    }
    if (this.path.length === 0) return null;

    let idx = this.pathIndex;
    const yCell0 = Math.round(this.pos.y / CELL_SIZE);
    const maxAhead = Math.min(this.path.length - 1, this.pathIndex + LOOKAHEAD_CELLS);
    for (let j = this.pathIndex + 1; j <= maxAhead; j++) {
      const wp = this.path[j];
      const wx = wp.x * CELL_SIZE + CELL_SIZE / 2;
      const wz = wp.z * CELL_SIZE + CELL_SIZE / 2;
      if (!this.nav.hasWalkableLine(this.pos.x, this.pos.z, yCell0, wx, wz)) break;
      idx = j;
    }
    this.pathIndex = idx;
    const wp = this.path[idx];
    return {
      x: wp.x * CELL_SIZE + CELL_SIZE / 2,
      y: wp.y * CELL_SIZE,
      z: wp.z * CELL_SIZE + CELL_SIZE / 2,
      last: idx === this.path.length - 1,
    };
  }

  _followPath(dt) {
    const target = this._pickPathTarget();
    if (!target) {
      // No path: stand and face the player (unreachable / aggro without path).
      this.vel.x = 0;
      this.vel.z = 0;
      this.animName = 'idle';
      return;
    }

    // Desired velocity: straight at the smoothed target, slower when climbing,
    // decelerating on approach to the final point so the mob settles onto it
    // instead of orbiting.
    const dx = target.x - this.pos.x;
    const dz = target.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    const maxSpeed = this.type.speed * this.speedJitter;
    let speed = maxSpeed;
    if (target.y > this.pos.y + 0.05) speed *= CLIMB_SLOW;
    if (target.last && dist < ARRIVE_RADIUS) speed *= dist / ARRIVE_RADIUS;
    const inv = dist > 1e-6 ? 1 / dist : 0;

    // Steer toward the desired velocity, capped at ACCEL.
    let ax = dx * inv * speed - this.vel.x;
    let az = dz * inv * speed - this.vel.z;
    const alen = Math.hypot(ax, az);
    if (alen > ACCEL) {
      ax = (ax / alen) * ACCEL;
      az = (az / alen) * ACCEL;
    }

    // Separation: same-floor neighbors push, harder the closer they are, so a
    // pack flows around itself instead of stacking. Skipped mid-air (falling
    // mobs shouldn't be shoved off their landing).
    if (this.grounded && this.neighbors.length) {
      let sx = 0;
      let sz = 0;
      for (const n of this.neighbors) {
        if (n.dead) continue;
        if (Math.abs(n.pos.y - this.pos.y) > 0.4) continue;
        const ox = this.pos.x - n.pos.x;
        const oz = this.pos.z - n.pos.z;
        const d = Math.hypot(ox, oz);
        if (d >= SEP_RADIUS || d < 1e-4) continue;
        const w = (SEP_RADIUS - d) / SEP_RADIUS / d;
        sx += ox * w;
        sz += oz * w;
      }
      const sl = Math.hypot(sx, sz);
      if (sl > 1e-6) {
        const sa = Math.min(sl * SEP_ACCEL, SEP_ACCEL);
        ax += (sx / sl) * sa;
        az += (sz / sl) * sa;
      }
    }

    this.vel.x += ax * dt;
    this.vel.z += az * dt;
    const v = Math.hypot(this.vel.x, this.vel.z);
    if (v > maxSpeed) {
      this.vel.x = (this.vel.x / v) * maxSpeed;
      this.vel.z = (this.vel.z / v) * maxSpeed;
    }

    // Surface guard: a grounded mob's centre must stay over the nav mesh —
    // steering momentum must not carry it off the world edge or over a void.
    // Genuine ledge drops stay allowed (the landing column has a node below).
    let mx = this.vel.x * dt;
    let mz = this.vel.z * dt;
    if (this.grounded && !this._destWalkable(this.pos.x + mx, this.pos.z + mz)) {
      if (this._destWalkable(this.pos.x + mx, this.pos.z)) {
        mz = 0;
        this.vel.z = 0;
      } else if (this._destWalkable(this.pos.x, this.pos.z + mz)) {
        mx = 0;
        this.vel.x = 0;
      } else {
        mx = 0;
        mz = 0;
        this.vel.x = 0;
        this.vel.z = 0;
      }
    }

    // Never overshoot the target on either axis within one frame — precision
    // alignment (threading gaps barely wider than the mob) needs the exact
    // convergence the old waypoint-chaser had, and per-frame overshoot is what
    // makes steering oscillate around a line it can't quite settle on.
    if (mx * dx > 0 && Math.abs(mx) > Math.abs(dx)) mx = dx;
    if (mz * dz > 0 && Math.abs(mz) > Math.abs(dz)) mz = dz;

    const requested = Math.hypot(mx, mz);
    // Wall slide may redirect blocked speed, but never carry an axis further
    // than the target actually needs.
    const r = this._moveHorizontal(
      mx,
      mz,
      Math.max(0, Math.abs(dx) - Math.abs(mx)),
      Math.max(0, Math.abs(dz) - Math.abs(mz)),
    );
    // A blocked axis kills that velocity component — otherwise phantom speed
    // pins the mob against the wall and steering can't rebuild along it.
    if (r.hitX) this.vel.x = 0;
    if (r.hitZ) this.vel.z = 0;

    // Stuck detection: not moving while a path expects movement.
    if (requested > 0.03 && r.dist < 0.01) this._stuckTime += dt;
    else this._stuckTime = 0;
    if (this._stuckTime > STUCK_TIME) {
      this._stuckTime = 0;
      this._startUnwedge();
    }
  }

  /** True when the column under (x, z) holds a surface a mob standing at the
   *  current level could be on after this move: at most a step above, at most
   *  a max drop below. No node at all = void (e.g. past the world edge). */
  _destWalkable(x, z) {
    const yCell = Math.round(this.pos.y / CELL_SIZE);
    const node = this.nav.nearestNodeAtCell(Math.floor(x / CELL_SIZE), Math.floor(z / CELL_SIZE), yCell);
    return !!node && node.y <= yCell + this.nav.stepCells && node.y >= yCell - this.nav.maxDropCells;
  }

  /**
   * Genuinely wedged: sidestep TANGENTIALLY to the blocked target (alternating
   * sides between attempts so repeated wedges don't loop), preferring a side
   * whose probe cell is walkable; fall back to backing straight away. A fresh
   * path is traced when the shuffle ends.
   */
  _startUnwedge() {
    const wp = this.path[this.pathIndex];
    if (!wp) {
      this.path = [];
      return;
    }
    const tx = wp.x * CELL_SIZE + CELL_SIZE / 2;
    const tz = wp.z * CELL_SIZE + CELL_SIZE / 2;
    let ux = tx - this.pos.x; // toward the blocked target
    let uz = tz - this.pos.z;
    const len = Math.hypot(ux, uz) || 1;
    ux /= len;
    uz /= len;
    this._unwedgeSide = -this._unwedgeSide;
    const s = this._unwedgeSide;
    const candidates = [
      [-uz * s, ux * s], // preferred tangent
      [uz * s, -ux * s], // other tangent
      [-ux, -uz], // straight back (last resort)
    ];
    const yCell = Math.round(this.pos.y / CELL_SIZE);
    let pick = candidates[2];
    for (const [cx, cz] of candidates) {
      const node = this.nav.nearestNodeAtCell(
        Math.floor((this.pos.x + cx * 0.6) / CELL_SIZE),
        Math.floor((this.pos.z + cz * 0.6) / CELL_SIZE),
        yCell,
      );
      if (node && Math.abs(node.y - yCell) <= this.nav.stepCells) {
        pick = [cx, cz];
        break;
      }
    }
    const back = this.type.speed * 0.5 * this.speedJitter;
    this._unwedge = { timer: UNWEDGE_TIME, vx: pick[0] * back, vz: pick[1] * back };
  }

  /**
   * Take damage. Always aggroes; may die.
   * @param {number} amount
   * @param {{x:number,y:number,z:number}} [fromPos]  where the hit came from —
   *   becomes the mob's last-known player position, so a mob shot from cover
   *   hunts the shooter's spot instead of magically tracking them.
   * @param {{stagger:number,knockX:number,knockZ:number}|null} [impact]  gun
   *   stopping power: `stagger` (s) halts the mob's movement and cancels any
   *   attack; `knockX/knockZ` (m/s) shove it back along the shot, divided by
   *   its mass. Null/omitted for melee hits, which only flinch.
   * @returns {boolean} true when this killed the mob
   */
  takeDamage(amount, fromPos = null, impact = null) {
    if (this.dead) return false;
    this.health -= amount;
    this.aggro = true;
    this._threatTimer = THREAT_TIME;
    if (fromPos) this.lkp = { x: fromPos.x, y: fromPos.y, z: fromPos.z };
    this.hurtTimer = 0.18;
    if (this.health <= 0) {
      this.dead = true;
      this.deadTimer = DEATH_TIME;
      this.state = 'dead';
      this.animName = 'dead';
      this.animTime = 0;
      this.hurtTimer = 0;
      return true;
    }
    // Flinch immediately; update() keeps the hurt pose while hurtTimer runs.
    this.animName = 'hurt';
    if (this.state !== 'attack') this.state = 'chase';
    // Stopping power: a gun hit interrupts an attack wind-up and staggers the
    // mob; a powerful shot also knocks it back along the shot (reduced by mass).
    if (impact?.stagger) {
      this.staggerTimer = Math.max(this.staggerTimer, impact.stagger);
      this.state = 'chase';
      this.attackTimer = 0;
    }
    if (impact?.knockX !== undefined) {
      const scale = this.mass > 0 ? 1 / this.mass : 1;
      this.knock.x = impact.knockX * scale;
      this.knock.z = impact.knockZ * scale;
    }
    return false;
  }
}
