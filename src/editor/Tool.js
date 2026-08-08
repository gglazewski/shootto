// Tool.js — base class + shared helpers for editor tools.
//
// Tools receive a context object { THREE, world, camera, ghost, state,
// history, input } and implement the lifecycle:
//   onActivate() / onDeactivate()
//   onMouseDown(button) / onMouseUp(button)
//   update(dt)                     — called each frame (ghost refresh, drags)

import { raycastVoxel, worldToCell } from '../engine/VoxelRaycaster.js';
import { anchorFor, spanFor } from '../engine/VoxelShape.js';

export class Tool {
  constructor({ id, name, ctx }) {
    this.id = id;
    this.name = name;
    this.ctx = ctx;
    this._lastHit = null;
  }

  /** @returns {{cell:[number,number,number], normal:[number,number,number], dist:number}|null} */
  pick() {
    const { THREE, world, camera } = this.ctx;
    const origin = worldToCell(camera.position.toArray());
    const dir = camera.getWorldDirection(new THREE.Vector3());
    return raycastVoxel(world, origin, [dir.x, dir.y, dir.z]);
  }

  /** Anchor cell where a voxel would be placed adjacent to the hovered face. */
  placementAnchor(hit, size) {
    const [x, y, z] = anchorFor(
      hit.cell[0] + hit.normal[0],
      hit.cell[1] + hit.normal[1],
      hit.cell[2] + hit.normal[2],
      size,
    );
    return [x, y, z];
  }

  /**
   * Unique voxels overlapping the given anchor cells, scanning the full
   * span volume of `size` at each anchor so small voxels inside a big-size
   * footprint (and vice versa) are all caught.
   * @param {[number,number,number][]} anchors
   * @param {string} size
   * @returns {object[]} voxels, deduped by anchor
   */
  voxelsAt(anchors, size) {
    const { world } = this.ctx;
    const span = spanFor(size);
    const seen = new Set();
    const out = [];
    for (const a of anchors) {
      for (let dx = 0; dx < span; dx++) {
        for (let dy = 0; dy < span; dy++) {
          for (let dz = 0; dz < span; dz++) {
            const v = world.get(a[0] + dx, a[1] + dy, a[2] + dz);
            if (!v) continue;
            const key = v.anchor.join(',');
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(v);
          }
        }
      }
    }
    return out;
  }

  get isShift() {
    const input = this.ctx.input;
    return !!(input && (input.isDown('ShiftLeft') || input.isDown('ShiftRight')));
  }

  onActivate() {}
  onDeactivate() {}
  onMouseDown(button) {} // eslint-disable-line no-unused-vars
  onMouseUp(button) {} // eslint-disable-line no-unused-vars
  update(dt) {} // eslint-disable-line no-unused-vars
  cancel() {}
  hide() {}
}
