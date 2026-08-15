// WalkControls.js — pointer-lock walk controller with gravity + AABB collision.
//
// The player is an AABB (configurable width/height) moved against the voxel
// grid via Physics.moveAxis / moveWithStep so it slides along walls, lands on
// tops, and automatically steps up onto 0.5 m blocks. WASD moves on the
// camera-yaw plane (you walk flat), C crouches (stand-up is gated on
// headroom), Space is intentionally inert (no jump, no sprint). Mouse look
// reuses the pure applyLook/clampPitch math from FlyControls.
//
// Ladders: a climbable decal (VoxelTypes `climbable`) turns the wall face it
// sits on into a ladder. Pressing into that face climbs — up normally, down
// when looking steeply down; hands-off contact slides down slowly, crouch
// holds on. No new blocks, no occupancy: the decal alone carries it.
//
// Mirrors FlyControls' public surface (update/onMouseMove/onKeyDown/onKeyUp)
// plus spawnAt() so App can swap the active movement driver.

import { applyLook } from './FlyControls.js';
import { collides, moveAxis, moveWithStep, groundedAt } from '../engine/Physics.js';
import { CELL_SIZE } from '../engine/Space.js';
import { isClimbableDecal } from '../engine/VoxelTypes.js';

// Side faces a ladder can hang on, with the face's outward normal on the
// walk plane (pointing from the wall toward the player).
const LADDER_FACES = [['px', 1, 0], ['nx', -1, 0], ['pz', 0, 1], ['nz', 0, -1]];

export class WalkControls {
  /**
   * @param {object} deps
   * @param {object} deps.THREE
   * @param {import('three').Camera} deps.camera
   * @param {HTMLElement} deps.domElement
   * @param {object} deps.world
   * @param {object} [deps.opts] player + sensitivity tunables
   */
  constructor({ THREE, camera, domElement, world, opts = {} }) {
    this.THREE = THREE;
    this.camera = camera;
    this.domElement = domElement;
    this.world = world;

    this.touchMode = !!opts.touchMode; // touch devices: never use pointer lock
    this.sensitivity = opts.sensitivity ?? 0.0022;
    this.halfWidth = opts.halfWidth ?? 0.25;
    this.height = opts.height ?? 1.8;
    this.eyeHeight = opts.eyeHeight ?? 1.62;
    this.crouchHeight = opts.crouchHeight ?? 1.5;
    this.crouchEye = opts.crouchEye ?? 1.35;
    this.stepHeight = opts.stepHeight ?? 0.5;
    this.stepClimbTime = opts.stepClimbTime ?? 0.18;
    this.gravity = opts.gravity ?? 24;
    this.walkSpeed = opts.walkSpeed ?? 4.5;
    this.crouchSpeed = opts.crouchSpeed ?? 1.6;
    this.groundAccel = opts.groundAccel ?? 12;
    this.airAccel = opts.airAccel ?? 4;
    this.climbSpeed = opts.climbSpeed ?? 3;
    this.ladderSlide = opts.ladderSlide ?? 1.4;
    this.ladderReach = opts.ladderReach ?? 0.12;

    this.yaw = 0;
    this.pitch = 0;
    this.locked = false;
    this.enabled = true; // false while in the item editor (no pointer lock)
    this.grounded = false;
    this.crouching = false;
    /** Active step-up animation: { startY, targetY, elapsed } or null. */
    this.climb = null;
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.keys = new Set();

    this._bound = this._onLockChange.bind(this);
    this.camera.rotation.order = 'YXZ';
  }

  connect() {
    if (this.touchMode) return;
    document.addEventListener('pointerlockchange', this._bound);
    this.domElement.addEventListener('mousedown', this._requestLock);
  }

  disconnect() {
    document.removeEventListener('pointerlockchange', this._bound);
    this.domElement.removeEventListener('mousedown', this._requestLock);
  }

  _requestLock = () => {
    if (this.touchMode || !this.enabled) return;
    if (!this.locked && this.domElement.requestPointerLock) {
      this.domElement.requestPointerLock();
    }
  };

  _onLockChange() {
    this.locked = document.pointerLockElement === this.domElement;
    if (this.locked) {
      this.yaw = this.camera.rotation.y;
      this.pitch = this.camera.rotation.x;
    }
  }

  /** World-space feet position for a spawn cell (bottom of the cell, centered). */
  feetAt(cx, cy, cz) {
    return [
      cx * CELL_SIZE + CELL_SIZE / 2,
      cy * CELL_SIZE,
      cz * CELL_SIZE + CELL_SIZE / 2,
    ];
  }

  /** True when a standing AABB at the given feet world position fits in air. */
  canStand(fx, fy, fz) {
    return !collides(this.world, this._boxAt(fx, fy, fz, this.height));
  }

  /** Place the player at a spawn cell (feet at the cell bottom) facing the
   *  given yaw (radians; 0 = -Z, the camera default). */
  spawnAt(cx, cy, cz, yaw = 0) {
    const [x, y, z] = this.feetAt(cx, cy, cz);
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.grounded = false;
    this.crouching = false;
    this.climb = null;
    this.camera.position.set(x, y + this.eyeHeight, z);
    this.camera.rotation.set(0, yaw, 0, 'YXZ');
  }

  /**
   * Integrate one frame. @param {number} dt seconds since last frame.
   */
  update(dt) {
    const k = this.keys;
    const wantCrouch = k.has('KeyC');
    // A player that couldn't stand up last frame stays crouched until it can.
    const crouched = wantCrouch || this.crouching;
    const height = crouched ? this.crouchHeight : this.height;

    // horizontal wish on the yaw plane (walk flat, ignore pitch)
    const forward = new this.THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new this.THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const wish = new this.THREE.Vector3();
    if (k.has('KeyW') || k.has('ArrowUp')) wish.add(forward);
    if (k.has('KeyS') || k.has('ArrowDown')) wish.sub(forward);
    if (k.has('KeyD') || k.has('ArrowRight')) wish.add(right);
    if (k.has('KeyA') || k.has('ArrowLeft')) wish.sub(right);

    // Ladder contact replaces gravity with directed climb velocity: pressing
    // into the rungs climbs (down when looking steeply below the horizon),
    // crouch holds on, hands-off contact bleeds down slowly.
    const ladder = this.climb ? null : this._ladderContact(height);
    if (ladder) {
      const pressing = wish.x * ladder[0] + wish.z * ladder[1] < -0.01;
      if (pressing) this.velocity.y = this.pitch < -0.6 ? -this.climbSpeed : this.climbSpeed;
      else if (crouched) this.velocity.y = 0;
      else this.velocity.y = -this.ladderSlide;
    } else if (!this.grounded && !this.climb) {
      this.velocity.y -= this.gravity * dt;
    }

    const maxSpeed = crouched ? this.crouchSpeed : this.walkSpeed;
    const accel = this.grounded || this.climb ? this.groundAccel : this.airAccel;
    const t = Math.min(1, dt * accel);
    if (wish.lengthSq() > 0) {
      wish.normalize().multiplyScalar(maxSpeed);
      this.velocity.x += (wish.x - this.velocity.x) * t;
      this.velocity.z += (wish.z - this.velocity.z) * t;
    } else {
      this.velocity.x += -this.velocity.x * t;
      this.velocity.z += -this.velocity.z * t;
    }

    let box;
    if (this.climb) {
      // scripted step-up: rise smoothly to the step top while sliding forward
      this.climb.elapsed += dt;
      const u = Math.min(1, this.climb.elapsed / this.stepClimbTime);
      const eased = u * u * (3 - 2 * u); // smoothstep
      this.position.y = this.climb.startY + (this.climb.targetY - this.climb.startY) * eased;
      box = this._boxAt(this.position.x, this.position.y, this.position.z, height);
      this._step(box, 'x', this.velocity.x * dt);
      this._step(box, 'z', this.velocity.z * dt);
      if (u >= 1) {
        this.climb = null;
        this.grounded = groundedAt(this.world, box);
      } else {
        this.grounded = true;
      }
    } else {
      // moveWithStep auto-steps 0.5m blocks; when it would snap up, animate
      // the rise instead so the player climbs fluidly rather than teleporting.
      const startY = this.position.y;
      box = moveWithStep(
        this.world,
        this._boxAt(this.position.x, this.position.y, this.position.z, height),
        this.velocity.x * dt,
        this.velocity.z * dt,
        this.stepHeight,
        this.grounded,
      );
      if (box.minY > startY + 1e-9) {
        this.climb = { startY, targetY: box.minY, elapsed: 0 };
        // stay put this frame; the climb branch starts rising next frame
        box = this._boxAt(this.position.x, this.position.y, this.position.z, height);
        this._step(box, 'x', this.velocity.x * dt);
        this._step(box, 'z', this.velocity.z * dt);
      } else {
        this.grounded = false;
        const ym = this._step(box, 'y', this.velocity.y * dt);
        if (ym.hit) {
          this.grounded = this.velocity.y <= 0;
          this.velocity.y = 0;
        } else {
          // Standing still (vy === 0) would never hit, so detect the floor
          // below the feet directly. Keeps `grounded` stable.
          this.grounded = groundedAt(this.world, box);
        }
      }
    }

    this.position.set(box.minX + this.halfWidth, box.minY, box.minZ + this.halfWidth);

    // stand up only when the full height fits; otherwise keep crouching
    if (wantCrouch) this.crouching = true;
    else if (this.crouching && !collides(this.world, this._boxAt(this.position.x, this.position.y, this.position.z, this.height))) {
      this.crouching = false;
    }

    const eye = this.crouching ? this.crouchEye : this.eyeHeight;
    this.camera.position.set(this.position.x, this.position.y + eye, this.position.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  /** Move the box on one axis, mutating it in place. */
  _step(box, axis, delta) {
    return moveAxis(this.world, box, axis, delta);
  }

  /**
   * Climbable decal (ladder) whose face plane the player AABB touches within
   * ladderReach, or null. Returns the face's outward normal [nx, nz] so the
   * caller can tell "pressing into the ladder" from brushing past it.
   */
  _ladderContact(height) {
    const w = this.world;
    if (!w.decalAt) return null;
    const m = this.ladderReach;
    const box = this._boxAt(this.position.x, this.position.y, this.position.z, height);
    const x0 = Math.floor((box.minX - m) / CELL_SIZE);
    const x1 = Math.floor((box.maxX + m) / CELL_SIZE);
    const y0 = Math.floor(box.minY / CELL_SIZE);
    const y1 = Math.floor(box.maxY / CELL_SIZE);
    const z0 = Math.floor((box.minZ - m) / CELL_SIZE);
    const z1 = Math.floor((box.maxZ + m) / CELL_SIZE);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          for (const [face, nx, nz] of LADDER_FACES) {
            const decal = w.decalAt(cx, cy, cz, face);
            if (!decal || !isClimbableDecal(decal.decalId)) continue;
            // The rungs live on the face plane; touch = plane inside the
            // reach-expanded box, which also rejects a ladder hanging on the
            // far side of the wall the player leans against.
            const plane = nx
              ? (face === 'px' ? cx + 1 : cx) * CELL_SIZE
              : (face === 'pz' ? cz + 1 : cz) * CELL_SIZE;
            const lo = (nx ? box.minX : box.minZ) - m;
            const hi = (nx ? box.maxX : box.maxZ) + m;
            if (plane >= lo && plane <= hi) return [nx, nz];
          }
        }
      }
    }
    return null;
  }

  _boxAt(fx, fy, fz, height) {
    return {
      minX: fx - this.halfWidth,
      maxX: fx + this.halfWidth,
      minY: fy,
      maxY: fy + height,
      minZ: fz - this.halfWidth,
      maxZ: fz + this.halfWidth,
    };
  }

  /** @param {number} dx raw mousemove deltaX */
  /** @param {number} dy raw mousemove deltaY */
  onMouseMove(dx, dy) {
    if (!this.locked) return;
    this.look(dx, dy);
  }

  /** Apply a look delta (touch drag or mouse) regardless of pointer lock. */
  look(dx, dy) {
    const l = applyLook(this.yaw, this.pitch, dx, dy, this.sensitivity);
    this.yaw = l.yaw;
    this.pitch = l.pitch;
  }

  onKeyDown(code) {
    this.keys.add(code);
  }

  onKeyUp(code) {
    this.keys.delete(code);
  }
}
