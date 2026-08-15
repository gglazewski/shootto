// DoorMarker.js — architectural plan symbols for doors in the world editor.
//
// Every door draws the symbol an architect would: the closed leaf as a line
// across the opening, the open leaf as a second line at 90°, and a quarter
// arc between them sweeping from the closed position to the open one. The
// hinge is where the two lines meet. So a glance tells you which jamb the
// door pivots on and which side of the wall it swings to — the same thing
// the door settings window (LMB on a door) edits. Locked doors draw red.
//
// The symbols sit just above the door's own floor, so they read from a
// walking-height editor camera as well as from above. They are depth-tested
// like real geometry — a door behind a wall is hidden by that wall.
//
// Rebuild scheme: doors are found by scanning the voxel index, which is why
// the scan is throttled (RESCAN_SECONDS) rather than run every frame; the
// group is only actually rebuilt when the scan's signature changes, and
// refresh() forces one right after an edit.

import { CELL_SIZE } from '../engine/Space.js';
import { spanVecFor } from '../engine/VoxelShape.js';
import { isDoorVoxel, isDoorLocked, doorHinge } from '../engine/Doors.js';

const COLOR = 0x8fd3ff;
const COLOR_LOCKED = 0xff6b6b;
const RESCAN_SECONDS = 0.35;
const ARC_SEGMENTS = 12;
// Meters above the door's floor. Depth-tested lines need real clearance, not
// an epsilon: the camera's near/far range makes the depth buffer coarse a few
// meters out, and a 1-2 cm lift starts dropping out of the floor at editor
// flying height.
const LIFT = 0.06;

/**
 * Plan-symbol geometry for one door, in cell units on the XZ plane.
 * @returns {{hinge: [number, number], closed: [number, number], open: [number, number]}}
 *   hinge = pivot point, closed/open = the free end of the leaf in each phase
 */
export function doorPlanPoints(voxel) {
  const rot = (voxel.rotation ?? 0) & 3;
  const [ax, , az] = voxel.anchor;
  const [sx, , sz] = spanVecFor(voxel.size, rot);
  const alongX = (rot & 1) === 0;
  const W = Math.max(sx, sz);
  // Unit vector along the closed leaf, and the one it swings toward.
  const u = alongX ? [1, 0] : [0, 1];
  const n = alongX ? [0, rot === 0 ? 1 : -1] : [rot === 1 ? 1 : -1, 0];
  // The leaf spans the footprint's width; the wall plane runs through the
  // middle of its 1-cell depth.
  const lo = alongX ? [ax, az + 0.5] : [ax + 0.5, az];
  const hi = [lo[0] + u[0] * W, lo[1] + u[1] * W];
  const rightHung = doorHinge(voxel) === 'right';
  const hinge = rightHung ? hi : lo;
  const closed = rightHung ? lo : hi;
  return { hinge, closed, open: [hinge[0] + n[0] * W, hinge[1] + n[1] * W] };
}

export class DoorMarker {
  /**
   * @param {object} deps
   * @param {object} deps.THREE
   * @param {import('three').Scene} deps.scene
   * @param {object} deps.world
   */
  constructor({ THREE, scene, world }) {
    this.THREE = THREE;
    this.scene = scene;
    this.world = world;
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);
    this._lastSignature = null;
    this._since = RESCAN_SECONDS;
  }

  /** Sync symbols to the world's doors. Cheap most frames: the voxel scan
   *  only runs a few times a second, and a rebuild only when doors changed. */
  update(dt = 0) {
    this.group.visible = true;
    this._since += dt;
    if (this._since < RESCAN_SECONDS) return;
    this._since = 0;
    this.refresh();
  }

  /** Force an immediate rescan (after placing, removing or reconfiguring). */
  refresh() {
    const doors = [];
    this.world.forEachVoxel((v) => {
      if (isDoorVoxel(v)) doors.push(v);
    });
    const key = doors
      .map((v) => `${v.anchor.join(',')}:${v.rotation ?? 0}${doorHinge(v)}${isDoorLocked(v) ? 'L' : ''}`)
      .sort()
      .join('|');
    if (key === this._lastSignature) return;
    this._lastSignature = key;
    this._rebuild(doors);
  }

  _rebuild(doors) {
    this._clear();
    const T = this.THREE;
    for (const v of doors) {
      const { hinge, closed, open } = doorPlanPoints(v);
      const y = v.anchor[1] * CELL_SIZE + LIFT;
      const pts = [];
      const push = (p) => pts.push(new T.Vector3(p[0] * CELL_SIZE, y, p[1] * CELL_SIZE));

      // Leaf in both phases: closed across the opening, open at 90°.
      push(hinge); push(closed);
      push(hinge); push(open);
      // Quarter arc from the closed free end round to the open one.
      const a0 = Math.atan2(closed[1] - hinge[1], closed[0] - hinge[0]);
      const a1 = Math.atan2(open[1] - hinge[1], open[0] - hinge[0]);
      // Shortest way round is always the quarter turn the leaf actually makes.
      let sweep = a1 - a0;
      if (sweep > Math.PI) sweep -= 2 * Math.PI;
      if (sweep < -Math.PI) sweep += 2 * Math.PI;
      const r = Math.hypot(closed[0] - hinge[0], closed[1] - hinge[1]);
      let prev = closed;
      for (let i = 1; i <= ARC_SEGMENTS; i++) {
        const a = a0 + (sweep * i) / ARC_SEGMENTS;
        const p = [hinge[0] + Math.cos(a) * r, hinge[1] + Math.sin(a) * r];
        push(prev); push(p);
        prev = p;
      }

      const geo = new T.BufferGeometry().setFromPoints(pts);
      // Depth-tested like any other geometry: a symbol behind a wall stays
      // behind it, so a building's doors don't bleed through its walls.
      const mat = new T.LineBasicMaterial({
        color: isDoorLocked(v) ? COLOR_LOCKED : COLOR,
        transparent: true,
        opacity: 0.85,
      });
      this.group.add(new T.LineSegments(geo, mat));
    }
    this.group.visible = true;
  }

  setVisible(v) {
    this.group.visible = v;
  }

  _clear() {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      child.geometry?.dispose();
      child.material?.dispose();
    }
  }
}
