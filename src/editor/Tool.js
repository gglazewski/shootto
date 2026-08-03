// Tool.js — base class + shared helpers for editor tools.
//
// Tools receive a context object { THREE, world, camera, ghost, state,
// history, input } and implement the lifecycle:
//   onActivate() / onDeactivate()
//   onMouseDown(button) / onMouseUp(button)
//   update(dt)                     — called each frame (ghost refresh, drags)

import { raycastVoxel, worldToCell } from '../engine/VoxelRaycaster.js';
import { anchorFor } from '../engine/VoxelShape.js';

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
