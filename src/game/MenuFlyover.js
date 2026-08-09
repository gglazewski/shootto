// MenuFlyover.js — the cinematic drone shot behind the main menu.
//
// Two modes. Without an authored shot, the camera flies a slow closed loop
// over the loaded map, visiting its points of interest (player spawn, NPCs,
// mob nests — or a plain ring over the map when there are none) and looking
// down at each one as it drifts past; camera waypoints ride above the
// world's tallest voxel, so the path never clips through buildings.
// With a splash camera (setSplash — an editor-captured pose), the camera sits
// at that pose and keeps it alive with a subtle motion instead: a slow orbit
// around what it looks at, a zoom toward or away from it, or a near-still
// drift — picked per camera in the editor (click its gizmo).

import { CELL_SIZE } from '../engine/Space.js';

/** Seconds for one full lap of the loop. */
const LAP_SECONDS = 60;
/** Camera clearance above the world's tallest voxel, in cells. Alternating
 *  waypoints breathe between the two so the flight bobs gently. */
const CLEAR_LOW = 9;
const CLEAR_HIGH = 18;
/** Horizontal pull-back from the looked-at location, in meters. */
const PULL_BACK = 14;
/** Points of interest closer than this (meters) collapse into one. */
const MIN_POI_GAP = 6;
/** Cap on loop waypoints — more just makes the lap fidgety. */
const MAX_POIS = 10;

// --- splash-shot motion ---
// Shots rotate after a few seconds on the menu, so every motion reads within
// the first moments and simply keeps going if the shot stays up longer.
/** Meters ahead of the captured pose the orbit pivots around. */
const SPLASH_ORBIT_DIST = 14;
/** Radians/second of orbit — one lap in 90 s. */
const SPLASH_ORBIT_SPEED = (Math.PI * 2) / 90;
/** Zoom in/out: meters/second along the view direction, and the travel cap
 *  where the push settles (a lone shot must not drift into the geometry). */
const SPLASH_ZOOM_SPEED = 0.8;
const SPLASH_ZOOM_MAX = 8;
/** Static drift: max yaw sway in radians, and its cycle speed. */
const SPLASH_SWAY = 0.02;
const SPLASH_SWAY_SPEED = 0.25;

export class MenuFlyover {
  /**
   * @param {object} deps
   * @param {typeof import('three')} deps.THREE
   * @param {import('../engine/World.js').World} deps.world
   * @param {import('three').PerspectiveCamera} deps.camera
   */
  constructor({ THREE, world, camera }) {
    this.THREE = THREE;
    this.world = world;
    this.camera = camera;
    this.t = Math.random(); // start each visit somewhere else on the lap
    this.posCurve = null;
    this.lookCurve = null;
    this._pos = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this.splash = null; // authored shot; null = procedural POI lap
    this._splashT = 0;
    this._base = new THREE.Vector3();
    this._dir = new THREE.Vector3();
  }

  /** Pin the camera to an authored splash shot ({pos, yaw, pitch, motion}),
   *  or null to fall back to the procedural flyover. */
  setSplash(cam) {
    this.splash = cam ?? null;
    this._splashT = 0;
    if (!cam) return;
    this._base.set(cam.pos[0], cam.pos[1], cam.pos[2]);
    // View direction of a YXZ yaw/pitch pose (matches FlyControls).
    const cp = Math.cos(cam.pitch);
    this._dir.set(-Math.sin(cam.yaw) * cp, Math.sin(cam.pitch), -Math.cos(cam.yaw) * cp);
  }

  /** Rebuild the loop from the currently loaded world. Call after a world
   *  loads/changes; with no world bounds the flyover goes inert. */
  rebuild() {
    const b = this.world.bounds();
    if (!b) {
      this.posCurve = this.lookCurve = null;
      return;
    }
    const T = this.THREE;
    const cx = ((b.min[0] + b.max[0]) / 2 + 0.5) * CELL_SIZE;
    const cz = ((b.min[2] + b.max[2]) / 2 + 0.5) * CELL_SIZE;
    const pois = this._pois(b, cx, cz);
    // Visit order sweeps around the map centre, so the lap circles the map
    // instead of criss-crossing it.
    pois.sort((p, q) => Math.atan2(p.z - cz, p.x - cx) - Math.atan2(q.z - cz, q.x - cx));

    const pos = [];
    const look = [];
    pois.forEach((p, i) => {
      // Pull the camera back from the POI away from the map centre, so every
      // shot looks inward across its location.
      let dx = p.x - cx;
      let dz = p.z - cz;
      const len = Math.hypot(dx, dz);
      if (len < 1e-3) {
        // POI at the very centre: pick a stable arbitrary direction.
        const a = (i / pois.length) * Math.PI * 2;
        dx = Math.cos(a);
        dz = Math.sin(a);
      } else {
        dx /= len;
        dz /= len;
      }
      const camY = (b.max[1] + (i % 2 ? CLEAR_HIGH : CLEAR_LOW)) * CELL_SIZE;
      pos.push(new T.Vector3(p.x + dx * PULL_BACK, camY, p.z + dz * PULL_BACK));
      look.push(new T.Vector3(p.x, p.y + CELL_SIZE * 2, p.z));
    });
    this.posCurve = new T.CatmullRomCurve3(pos, true, 'centripetal');
    this.lookCurve = new T.CatmullRomCurve3(look, true, 'centripetal');
  }

  /** Advance the flight. No-op until rebuild() saw a world (or a splash shot
   *  was set — an authored pose needs no world bounds). */
  update(dt) {
    if (this.splash) {
      this._updateSplash(dt);
      return;
    }
    if (!this.posCurve) return;
    this.t = (this.t + dt / LAP_SECONDS) % 1;
    this.camera.position.copy(this.posCurve.getPointAt(this.t, this._pos));
    this.camera.lookAt(this.lookCurve.getPointAt(this.t, this._look));
  }

  /** Keep an authored shot alive: orbit, dolly or drift around the pose. */
  _updateSplash(dt) {
    this._splashT += dt;
    const t = this._splashT;
    const cam = this.camera;
    const motion = this.splash.motion ?? 'orbit';
    if (motion === 'zoomin' || motion === 'zoomout' || motion === 'dolly') {
      // Glide along the view direction ('dolly' is the old name for zoomin),
      // settling at the travel cap. Zoom out starts ON the pose and retreats.
      const travel = Math.min(t * SPLASH_ZOOM_SPEED, SPLASH_ZOOM_MAX);
      const s = motion === 'zoomout' ? -travel : travel;
      cam.position.copy(this._dir).multiplyScalar(s).add(this._base);
      cam.lookAt(this._look.copy(this._dir).multiplyScalar(30).add(this._base));
    } else if (motion === 'static') {
      // Barely-there yaw sway, so the shot still reads as live.
      cam.position.copy(this._base);
      const sway = Math.sin(t * SPLASH_SWAY_SPEED) * SPLASH_SWAY;
      const dx = this._dir.x * Math.cos(sway) - this._dir.z * Math.sin(sway);
      const dz = this._dir.x * Math.sin(sway) + this._dir.z * Math.cos(sway);
      cam.lookAt(this._look.set(dx, this._dir.y, dz).multiplyScalar(20).add(this._base));
    } else {
      // Orbit: circle the point the author framed, keeping their distance
      // and height, starting exactly on the captured pose.
      const target = this._pos.copy(this._dir).multiplyScalar(SPLASH_ORBIT_DIST).add(this._base);
      const angle = t * SPLASH_ORBIT_SPEED;
      const ox = this._base.x - target.x;
      const oz = this._base.z - target.z;
      cam.position.set(
        target.x + ox * Math.cos(angle) - oz * Math.sin(angle),
        this._base.y,
        target.z + ox * Math.sin(angle) + oz * Math.cos(angle),
      );
      cam.lookAt(target);
    }
  }

  /** Points of interest in world meters: spawn, NPCs, mob spawns — thinned
   *  to a spread-out handful, padded with a ring over the map if too few. */
  _pois(b, cx, cz) {
    const out = [];
    const push = (x, y, z) => {
      const wx = (x + 0.5) * CELL_SIZE;
      const wz = (z + 0.5) * CELL_SIZE;
      if (out.some((p) => Math.hypot(p.x - wx, p.z - wz) < MIN_POI_GAP)) return;
      out.push({ x: wx, y: y * CELL_SIZE, z: wz });
    };
    if (this.world.spawn) push(...this.world.spawn);
    this.world.forEachNpcSpawn((s) => push(s.x, s.y, s.z));
    this.world.forEachMobSpawn((s) => push(s.x, s.y, s.z));
    if (out.length > MAX_POIS) {
      // keep an even sample instead of whichever spawns came first
      const step = out.length / MAX_POIS;
      const kept = [];
      for (let i = 0; i < MAX_POIS; i++) kept.push(out[Math.floor(i * step)]);
      out.length = 0;
      out.push(...kept);
    }
    // Too few POIs to shape a lap: complete the loop with a ring over the map.
    if (out.length < 4) {
      const rx = Math.max(8, ((b.max[0] - b.min[0]) / 2) * CELL_SIZE * 0.7);
      const rz = Math.max(8, ((b.max[2] - b.min[2]) / 2) * CELL_SIZE * 0.7);
      const ringY = (b.min[1] + Math.max(1, (b.max[1] - b.min[1]) * 0.25)) * CELL_SIZE;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const x = cx + Math.cos(a) * rx;
        const z = cz + Math.sin(a) * rz;
        if (!out.some((p) => Math.hypot(p.x - x, p.z - z) < MIN_POI_GAP)) out.push({ x, y: ringY, z });
      }
    }
    return out;
  }
}
