// PlayerHand.js — first-person fists in the view.
//
// Two low-poly fists (right + left), each parented to the camera so they sit at
// the bottom corners of the view like a classic FPS pair. Each arm has a
// forearm sleeve (fixed to the player) and a hand that pivots at the WRIST:
// on attack the hand rotates about the wrist so the TOP of the fist (the
// knuckles) leans toward the target, like a real punch — the pivot stays low
// and the fist reaches out, rather than the whole fist hinging in the middle.
//
// swing() alternates right/left; each punch is wind-up -> strike -> recover
// with cubic eases.
//
// Lighting: the fists use the same map-less lit material as placed items
// (Renderer.itemMaterial), so they respond to the world's LightField like any
// other surface — dark in caves, warm near torches, dimmed at night. Each
// part's flat color is baked into a per-vertex `color` attribute and the
// sky/block light is written to a per-vertex `light` attribute, sampled from
// the hand's world cell and refreshed only when the player crosses a cell
// boundary (the whole fist shares one cell), so the per-frame cost is one
// light-field lookup per hand.

import { CELL_SIZE } from '../engine/Space.js';
import { MICRO_GRID, microCellSizeFor } from '../engine/ItemTypes.js';
import { createItemGeometry } from '../editor/ItemGeometry.three.js';

const SKIN = 0xf2d0b0;
const SKIN_DARK = 0xdbb396;
const SLEEVE = 0x46527a;

// Wall avoidance: pull the fist back so it doesn't clip into geometry. The fist
// tip extends this far past the hand group origin toward -z, we keep this much
// gap from any surface, and we only probe this far ahead (all in meters).
const TIP_OFFSET = 0.08;
const WALL_MARGIN = 0.03;
const PROBE_MAX = 1.5;

const easeInCubic = (t) => t * t * t;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

// When a weapon is equipped the hands dip down, hold, then rise back up with
// the weapon (seconds), so a picked-up weapon doesn't pop into the view.
const EQUIP_DIP = 0.6;

/** Punch extension over normalized progress u in [0,1].
 *  Returns a scalar in roughly [-0.18, 1.0]: a small wind-up (negative),
 *  a fast strike up to full extension (1.0), then a recover back to 0. */
function punchExtension(u) {
  const WIND = 0.18;
  const STRIKE = 0.40;
  if (u < WIND) return -0.18 * easeOutCubic(u / WIND);
  if (u < STRIKE) return -0.18 + 1.18 * easeInCubic((u - WIND) / (STRIKE - WIND));
  return 1.0 * (1 - easeOutCubic((u - STRIKE) / (1 - STRIKE)));
}

export class PlayerHand {
  /**
   * @param {object} deps
   * @param {object} deps.THREE
   * @param {import('three').Camera} deps.camera
   * @param {import('three').Scene} deps.scene
   * @param {object} [deps.lightField]  LightField to shade the fists with
   * @param {import('three').Material} [deps.material]  map-less lit material
   *   (Renderer.itemMaterial). When omitted the fists fall back to unlit
   *   MeshBasicMaterials.
   * @param {(maxMeters:number)=>number} [deps.probeForward]  returns the
   *   distance (meters) from the camera to the nearest surface dead ahead, or
   *   Infinity. Used to retract the fists so they don't clip into walls.
   */
  constructor({ THREE, camera, scene, lightField = null, material = null, probeForward = null }) {
    this.THREE = THREE;
    this.camera = camera;
    this._probeForward = probeForward;
    this.lightField = lightField;
    this.material = material;
    this._vec = new THREE.Vector3();
    this._duration = 0.34;
    this._t = 0; // idle sway clock

    // A shared root parented to the camera so both hands follow the view. The
    // camera must be in the scene for its children to render.
    this.group = new THREE.Group();
    camera.add(this.group);
    if (scene && !scene.getObjectById(camera.id)) scene.add(camera);

    // side: +1 = right (bottom-right of view), -1 = left (mirrored).
    this.right = this._buildHand(+1);
    this.left = this._buildHand(-1);
    this.group.add(this.right.group, this.left.group);

    // Held item state (equipped weapon rendered in the right hand).
    this._heldId = null;
    this._heldGroup = null;
    this._heldLightAttr = null;
    this._heldMuzzleLocal = null;
    this._reload = null; // { elapsed, duration } — hands-down reload dip
    this._equip = null; // { elapsed, duration } — hands-dip pickup animation

    this._next = 'right'; // which hand swings next (alternates)
  }

  /** Render an equipped item in the right hand (null hides it). The item's
   *  grip voxel is anchored to the palm; its forward direction (editor yaw)
   *  points toward the view. No-op when the item id is unchanged. One-handed
   *  weapons keep the left hand lowered (hidden); fists and two-handed weapons
   *  show both hands. */
  setHeldItem(def) {
    const id = def?.id ?? null;
    if (id === this._heldId) return;
    this._heldId = id;
    if (this._heldGroup) {
      this.right.pivot.remove(this._heldGroup);
      this._heldGroup.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material && o.material !== this.material) o.material.dispose();
      });
      this._heldGroup = null;
      this._heldLightAttr = null;
      this._heldMuzzleLocal = null;
      this._heldFlash = null;
      this._flashLight = null;
      this._flashStarMat = null;
      this._flashGlowMat = null;
      this._flashT = 0;
    }
    this.left.group.visible = !(def && def.weapon?.hands === 'one');
    if (def) {
      this._buildHeld(def);
      // The new held item's `light` attribute starts zeroed; drop the hand's
      // cell cache so _refreshLight fills it on the next frame even when the
      // player hasn't moved (otherwise a freshly picked-up weapon stays black
      // until they cross a cell boundary).
      this.right.cell = null;
      // The hands dip down and rise back up with the new weapon.
      this._equip = { elapsed: 0, duration: EQUIP_DIP };
    } else {
      this._equip = null;
    }
  }

  _buildHeld(def) {
    const T = this.THREE;
    const c = microCellSizeFor(def.size ?? 'small');
    // Grip cell: the editor's grip voxel, falling back to the centre of the
    // item's build volume (per-item since long weapons; default 8^3).
    const dims = Array.isArray(def.grid) && def.grid.length === 3
      ? def.grid
      : [MICRO_GRID, MICRO_GRID, MICRO_GRID];
    const g = def.grip
      ? { x: def.grip.x, y: def.grip.y, z: def.grip.z }
      : { x: Math.floor(dims[0] / 2), y: Math.floor(dims[1] / 2), z: Math.floor(dims[2] / 2) };

    const group = new T.Group();
    const geo = createItemGeometry(T, def.microVoxels ?? []);
    // Bake per-vertex light later (the lit material needs a `light` attribute);
    // _refreshLight fills it from the hand's world cell, like the fist parts.
    const count = geo.attributes.position.count;
    const light = new T.BufferAttribute(new Float32Array(count * 2), 2);
    geo.setAttribute('light', light);

    const mesh = new T.Mesh(geo, this.material ?? new T.MeshBasicMaterial({ vertexColors: true }));
    mesh.scale.setScalar(c);
    // Shift the grid so the grip cell's centre sits on the group origin.
    mesh.position.set(-(g.x + 0.5) * c, -(g.y + 0.5) * c, -(g.z + 0.5) * c);
    group.add(mesh);

    // Item forward (grid +Z rotated by yaw) maps to hand forward (-Z).
    group.rotation.y = Math.PI - (def.yaw ?? 0) * (Math.PI / 180);
    // Anchor the grip to the palm (pivot-local), so swings lean the weapon too.
    group.position.set(0, 0.06, 0);
    this.right.pivot.add(group);

    // Barrel end: the weapon muzzle voxel's offset from the grip, in the held
    // group's local space (used to place the muzzle flash when firing).
    const muzzle = def.weapon?.muzzle;
    this._heldMuzzleLocal = muzzle
      ? new T.Vector3((muzzle.x - g.x) * c, (muzzle.y - g.y) * c, (muzzle.z - g.z) * c)
      : null;

    this._heldGroup = group;
    this._heldLightAttr = light;
    this._buildMuzzleFlash(group);
  }

  /** A small additive star+glow at the barrel, parented to the held weapon so
   *  it sticks to the muzzle while the player moves. A warm PointLight rides
   *  along, so firing actually sheds light on the area (the muzzle smoke and
   *  any standard-lit geometry nearby catch it). Animated by _updateFlash. */
  _buildMuzzleFlash(group) {
    const T = this.THREE;
    this._heldFlash = new T.Group();
    this._heldFlash.visible = false;
    group.add(this._heldFlash);
    // Sit at the muzzle voxel (or just ahead of the grip when unset).
    if (this._heldMuzzleLocal) this._heldFlash.position.copy(this._heldMuzzleLocal);
    else this._heldFlash.position.set(0, 0, -0.08);

    // The light emitting from the flash (off until a shot fires).
    this._flashLight = new T.PointLight(0xffbb55, 0, 8, 2);
    this._heldFlash.add(this._flashLight);
    this._flashPeak = 6;

    // Crossed star planes facing the camera (held -Z) + a soft glow core.
    this._flashStarMat = new T.MeshBasicMaterial({
      color: 0xfff2c0, transparent: true, depthWrite: false,
      blending: T.AdditiveBlending, side: T.DoubleSide,
    });
    this._flashGlowMat = new T.MeshBasicMaterial({
      color: 0xffaa33, transparent: true, depthWrite: false,
      blending: T.AdditiveBlending,
    });
    const plane = new T.PlaneGeometry(1, 1);
    const p1 = new T.Mesh(plane, this._flashStarMat);
    const p2 = new T.Mesh(plane, this._flashStarMat);
    p2.rotation.z = Math.PI / 2;
    this._heldFlash.add(p1, p2);
    this._heldFlash.add(new T.Mesh(new T.SphereGeometry(0.5, 8, 6), this._flashGlowMat));
    this._flashBase = 0.12;
    this._flashT = 0;
    this._flashDur = 0.08;
  }

  /** Trigger the attached muzzle flash (brief pop + fade). */
  muzzleFlash() {
    if (!this._heldFlash) return;
    this._heldFlash.visible = true;
    this._heldFlash.rotation.z = Math.random() * Math.PI;
    this._flashT = this._flashDur;
  }

  /** Advance the attached muzzle flash: pop big + bright, then shrink + fade.
   *  The light rides the same curve, ramping off as the flash dies. */
  _updateFlash(dt) {
    if (!this._heldFlash || this._flashT <= 0) return;
    this._flashT -= dt;
    const u = Math.max(0, this._flashT / this._flashDur); // 1 -> 0
    this._heldFlash.visible = u > 0;
    this._heldFlash.scale.setScalar(this._flashBase * (1 + u * 1.2));
    const o = u * u;
    this._flashStarMat.opacity = o;
    this._flashGlowMat.opacity = o * 0.85;
    if (this._flashLight) this._flashLight.intensity = u > 0 ? this._flashPeak * u : 0;
  }

  /** World position of the held weapon's muzzle voxel (null when unset).
   *  @param {Vector3} [out] scratch vector to fill (allocates when omitted) */
  heldMuzzleWorld(out = new this.THREE.Vector3()) {
    if (!this._heldGroup || !this._heldMuzzleLocal) return null;
    this.camera.updateMatrixWorld(true);
    this.group.updateMatrixWorld(true);
    out.copy(this._heldMuzzleLocal);
    return this._heldGroup.localToWorld(out);
  }

  /** Current muzzle flash as a world-space light, or null when off. The
   *  intensity is 0..1 matching the flash's remaining life, so callers can push
   *  it into the light engine (Renderer.setFlashLight) and light the scene.
   *  @param {Vector3} [out] scratch vector to fill (allocates when omitted)
   *  @returns {{pos: Vector3, intensity: number}|null} */
  flashWorld(out = new this.THREE.Vector3()) {
    if (!this._heldFlash || this._flashT <= 0) return null;
    this.camera.updateMatrixWorld(true);
    this.group.updateMatrixWorld(true);
    this._heldFlash.updateMatrixWorld(true);
    out.setFromMatrixPosition(this._heldFlash.matrixWorld);
    return { pos: out, intensity: this._flashT / this._flashDur };
  }

  /** Build one arm. @param {number} side +1 right, -1 left */
  _buildHand(side) {
    const THREE = this.THREE;
    const lightAttrs = [];

    const g = new THREE.Group(); // arm root (placement + forward thrust)

    // Build one part. Each part is a box with its flat color baked into a
    // per-vertex `color` attribute and a (zeroed) per-vertex `light` attribute
    // so the shared lit material can shade it; _refreshLight fills the light in.
    const addPart = (w, h, d, color) => {
      const geo = new THREE.BoxGeometry(w, h, d);
      const n = geo.attributes.position.count;
      const c = new THREE.Color(color);
      const colors = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        colors[i * 3] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      const light = new THREE.BufferAttribute(new Float32Array(n * 2), 2);
      geo.setAttribute('light', light);
      lightAttrs.push(light);
      return new THREE.Mesh(geo, this.material ?? new THREE.MeshBasicMaterial({ color }));
    };

    // forearm sleeve: hangs below the wrist, anchors the hand to the player.
    const forearm = addPart(0.12, 0.24, 0.11, SLEEVE);
    forearm.position.set(0, -0.17, 0.01);
    g.add(forearm);

    // ---- wrist pivot: the hand rotates around THIS point (low, at the wrist)
    const pivot = new THREE.Group();
    pivot.position.set(0, -0.05, 0.01);
    g.add(pivot);

    // cuff trim where the sleeve meets the wrist.
    const cuff = addPart(0.118, 0.022, 0.108, SKIN_DARK);
    cuff.position.set(0, -0.005, 0);
    pivot.add(cuff);

    // palm body.
    const palm = addPart(0.112, 0.125, 0.10, SKIN);
    palm.position.set(0, 0.06, 0);
    pivot.add(palm);

    // back-of-hand panel (slightly darker for form).
    const back = addPart(0.10, 0.085, 0.006, SKIN_DARK);
    back.position.set(0, 0.095, 0.04);
    pivot.add(back);

    // thumb: wrapped across the front on the inner side.
    const thumb = addPart(0.036, 0.046, 0.09, SKIN);
    thumb.position.set(side * 0.05, 0.076, -0.045);
    thumb.rotation.set(0.1, side * -0.45, side * -0.2);
    pivot.add(thumb);

    const basePos = new THREE.Vector3(0.30 * side, -0.27, -0.6);
    const baseRot = new THREE.Euler(0.12, 0, -0.1 * side);
    g.position.copy(basePos);
    g.rotation.copy(baseRot);

    return { group: g, pivot, basePos, baseRot, swing: null, cell: null, lightAttrs };
  }

  /** Start an attack with the given animation name. With a weapon held the
   *  right hand always plays it (it carries the item); bare fists alternate
   *  right/left. No-op while the relevant hand is busy. */
  attack(name, opts = {}) {
    let target;
    if (this._heldId) {
      target = this.right;
      if (target.anim) return;
    } else {
      const first = this._next === 'right' ? this.right : this.left;
      const second = first === this.right ? this.left : this.right;
      target = first.anim ? (second.anim ? null : second) : first;
      if (!target) return;
      this._next = target === this.right ? 'left' : 'right';
    }
    target.anim = {
      name,
      elapsed: 0,
      duration: opts.duration ?? (name === 'gun' ? 0.2 : this._duration),
      recoil: opts.recoil ?? 0.05,
    };
  }

  /** Back-compat: a bare punch (fists alternate hands; a weapon swings the
   *  right hand). */
  swing() {
    this.attack('punch');
  }

  /** Advance the animations. @param {number} dt seconds */
  update(dt) {
    this._t += dt;
    // One forward probe per frame, shared by both hands (single view-center
    // ray). d = meters to the nearest surface ahead, or Infinity.
    const d = this._probeForward ? this._probeForward(PROBE_MAX) : Infinity;
    this._updateHand(this.right, +1, dt, d);
    this._updateHand(this.left, -1, dt, d);
    this._refreshLight(this.right);
    this._refreshLight(this.left);
    this._updateFlash(dt);
    this._updateReload(dt);
    this._updateEquip(dt);
  }

  /** Start a reload: both hands dip down, hold, then come back up. The caller
   *  refills ammo when it finishes (GameApp times it against the duration). */
  reload(duration) {
    this._reload = { elapsed: 0, duration: Math.max(0.1, duration) };
  }

  /** Hands-down dip for the reload: fast drop, hold, fast rise. */
  _reloadDip(u) {
    if (u < 0.15) return -0.16 * (u / 0.15);
    if (u < 0.85) return -0.16;
    return -0.16 * (1 - (u - 0.85) / 0.15);
  }

  _updateReload(dt) {
    if (!this._reload) return;
    this._reload.elapsed += dt;
    const u = Math.min(1, this._reload.elapsed / this._reload.duration);
    this.group.position.y = this._reloadDip(u);
    if (u >= 1) {
      this._reload = null;
      this.group.position.y = 0;
    }
  }

  /** A freshly equipped weapon arrives with the hands: the whole hand group
   *  dips down, holds, then eases back up with the weapon in the grip — the
   *  weapon visibly rises into the view instead of popping in. Applied to the
   *  shared root, so both hands move together. */
  _updateEquip(dt) {
    if (!this._equip || !this._heldGroup) {
      this._equip = null;
      return;
    }
    this._equip.elapsed += dt;
    const u = Math.min(1, this._equip.elapsed / this._equip.duration);
    this.group.position.y = this._equipDip(u);
    if (u >= 1) {
      this.group.position.y = 0;
      this._equip = null;
    }
  }

  /** Hands-down dip for a freshly equipped weapon: fast drop, brief hold, then
   *  a slow ease back up to the resting position. */
  _equipDip(u) {
    if (u < 0.18) return -0.26 * easeOutCubic(u / 0.18);
    if (u < 0.45) return -0.26;
    return -0.26 * (1 - easeOutCubic((u - 0.45) / 0.55));
  }

  /** Sample the light field at the hand's world position and bake it into the
   *  per-vertex `light` attribute. The whole fist spans a cell or two, so one
   *  lookup per hand suffices; it only re-uploads when the hand crosses a cell
   *  boundary, keeping the per-frame cost to a single light-field sample. The
   *  held item (right hand) shares the same cell, so it's lit in the same pass. */
  _refreshLight(hand) {
    if (!this.lightField) return;
    const p = this._vec;
    hand.group.getWorldPosition(p);
    const cx = Math.floor(p.x / CELL_SIZE);
    const cy = Math.floor(p.y / CELL_SIZE);
    const cz = Math.floor(p.z / CELL_SIZE);
    const cell = hand.cell;
    if (cell && cell[0] === cx && cell[1] === cy && cell[2] === cz) return;
    hand.cell = [cx, cy, cz];
    const sky = this.lightField.skyAt(cx, cy, cz) / 15;
    const block = this.lightField.blockAt(cx, cy, cz) / 15;
    for (const attr of hand.lightAttrs) {
      const arr = attr.array;
      for (let i = 0; i < arr.length; i += 2) {
        arr[i] = sky;
        arr[i + 1] = block;
      }
      attr.needsUpdate = true;
    }
    if (this._heldLightAttr) {
      const arr = this._heldLightAttr.array;
      for (let i = 0; i < arr.length; i += 2) {
        arr[i] = sky;
        arr[i + 1] = block;
      }
      this._heldLightAttr.needsUpdate = true;
    }
  }

  _updateHand(hand, side, dt, d) {
    const p = hand.basePos;
    const r = hand.baseRot;
    if (hand.anim) {
      hand.anim.elapsed += dt;
      const u = Math.min(1, hand.anim.elapsed / hand.anim.duration);
      const pose = this._animPose(hand, side, u);
      hand.group.position.set(pose.px, pose.py, pose.pz);
      hand.group.rotation.set(pose.rx, pose.ry, pose.rz);
      hand.pivot.rotation.set(pose.wx, pose.wy, pose.wz);
      if (u >= 1) {
        hand.anim = null;
        hand.group.position.copy(p);
        hand.group.rotation.copy(r);
        hand.pivot.rotation.set(0, 0, 0);
      }
    } else {
      // idle: a subtle sway so the hands feel alive while at rest.
      const bob = Math.sin(this._t * 1.8 + side) * 0.005;
      const sway = Math.cos(this._t * 1.3 + side) * 0.004;
      hand.group.position.set(p.x, p.y + bob, p.z);
      hand.group.rotation.set(r.x + sway, r.y, r.z);
      hand.pivot.rotation.set(0, 0, 0);
    }

    // Wall avoidance: if a surface is closer dead-ahead than the fist tip,
    // pull the hand back along the view ray so the tip stays clear of it.
    // floorZ is the most-negative (furthest-forward) z the group may have.
    if (Number.isFinite(d)) {
      const floorZ = -d + WALL_MARGIN + TIP_OFFSET;
      if (hand.group.position.z < floorZ) hand.group.position.z = floorZ;
    }
  }

  /** Pose for the current attack animation at normalized time u ∈ [0,1].
   *  Names: punch (wrist lean), slash (horizontal sweep), stab (straight
   *  thrust), gun (recoil kick). Returns { px,py,pz, rx,ry,rz, wx,wy,wz }. */
  _animPose(hand, side, u) {
    const p = hand.basePos;
    const r = hand.baseRot;
    const name = hand.anim.name;
    if (name === 'punch') {
      const ext = punchExtension(u); // [-0.18 .. 1.0]
      return {
        px: p.x + ext * -0.04 * side,
        py: p.y + ext * -0.05,
        pz: p.z + ext * -0.42,
        rx: r.x, ry: r.y, rz: r.z,
        wx: -ext * 0.6, wy: 0, wz: 0,
      };
    }
    if (name === 'slash') {
      const s = Math.sin(u * Math.PI);
      return {
        px: p.x,
        py: p.y,
        pz: p.z + s * 0.22,
        rx: r.x, ry: r.y, rz: r.z,
        wx: -s * 0.15, wy: side * s * 0.8, wz: s * -0.25,
      };
    }
    if (name === 'stab') {
      const ext = punchExtension(u);
      return {
        px: p.x,
        py: p.y,
        pz: p.z + ext * -0.5,
        rx: r.x, ry: r.y, rz: r.z,
        wx: ext * 0.1, wy: 0, wz: 0,
      };
    }
    // 'gun' — recoil: quick kickback (+Z) with a slight barrel-up pitch, then
    // recover. recoil is the kick distance in meters.
    const s = Math.sin(u * Math.PI);
    const recoil = hand.anim.recoil ?? 0.05;
    return {
      px: p.x,
      py: p.y + s * 0.02,
      pz: p.z + recoil * s,
      rx: r.x, ry: r.y, rz: r.z,
      wx: s * 0.12, wy: s * 0.08 * side, wz: 0,
    };
  }
}
