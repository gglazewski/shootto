// PrefabResizeTool.js — pull a side of the prefab build volume, Figma style.
//
// Only exists inside a prefab session (F6). Aim at any side of the cyan box:
// the face lights up. Hold LMB and move the mouse — the camera stays put and
// the mouse now drags that wall along its own axis, an orange ghost box
// showing where it lands. Release commits, RMB (or losing the pointer lock)
// cancels. The side you grabbed is the side that moves: pulling the LEFT wall
// left grows the volume leftwards and the build stays put on screen, because
// the commit slides the content (and the camera) by the same vector.
//
// Mouse-to-cells uses the screen projection of the face's own axis, sampled
// once when the drag starts (the view cannot rotate mid-drag), so the wall
// tracks the pointer at any camera angle.

import { Tool } from '../Tool.js';
import { Notice } from '../Notice.js';
import {
  contentBounds,
  resizeLimits,
  resizePlan,
  clampDelta,
  pickBoxFace,
  faceLabel,
} from '../prefabResize.js';
import { CELL_SIZE } from '../../engine/Space.js';
import { worldToCell } from '../../engine/VoxelRaycaster.js';

/** Below this the axis points nearly at the camera and its screen direction is
 *  meaningless; fall back to "pull down = grow" at a fixed pixel rate. */
const MIN_AXIS_PIXELS = 4;
const FALLBACK_PIXELS_PER_CELL = 10;

export class PrefabResizeTool extends Tool {
  constructor(ctx) {
    super({ id: 'prefabresize', name: 'Resize', ctx });
    this.prefabOnly = true; // hidden from the tool ring outside a prefab session
    this.lastAction = '';
    this._drag = null;
  }

  get session() {
    return this.ctx.prefab?.session?.() ?? null;
  }

  get bounds() {
    return this.ctx.prefab?.bounds ?? null;
  }

  /** True while a side is being pulled — the App routes mouse deltas here. */
  get dragging() {
    return !!this._drag;
  }

  onActivate() {
    this.bounds?.setHandles(true);
    if (this.session) Notice.info('Resize: aim at a side of the box, hold left mouse and pull');
  }

  onDeactivate() {
    this.cancel();
    this.bounds?.setHandles(false);
  }

  /** The side of the build volume under the crosshair, or null. */
  aimedFace() {
    const s = this.session;
    if (!s) return null;
    const { THREE, camera } = this.ctx;
    const origin = worldToCell(camera.position.toArray());
    const dir = camera.getWorldDirection(new THREE.Vector3());
    return pickBoxFace(origin, [dir.x, dir.y, dir.z], s.dims);
  }

  onMouseDown(button) {
    if (button === 2) {
      if (this._drag) this.cancel();
      return;
    }
    if (button !== 0 || this._drag) return;
    const s = this.session;
    if (!s) {
      Notice.warn('The Resize tool works inside a prefab session (F6)');
      return;
    }
    const face = this.aimedFace();
    if (!face) {
      Notice.warn('Aim at a side of the cyan box to grab it');
      return;
    }
    const { axis, sign } = face;
    this._drag = {
      axis,
      sign,
      dims: [...s.dims],
      limits: resizeLimits(s.dims, contentBounds(this.ctx.world), axis, sign),
      pixels: this._screenAxis(s.dims, axis, sign),
      accum: 0,
      delta: 0,
    };
    this.bounds?.setDrag(axis, sign);
    this.bounds?.setHover(null);
    this.lastAction = `Grabbed ${faceLabel(axis, sign)}`;
    this._preview();
  }

  /** Raw mouse deltas while a side is held (the camera does not turn). */
  onMouseMove(dx, dy) {
    const d = this._drag;
    if (!d) return;
    const [sx, sy] = d.pixels;
    d.accum += (dx * sx + dy * sy) / (sx * sx + sy * sy);
    const delta = clampDelta(d.accum, d.limits);
    if (delta === d.delta) return;
    d.delta = delta;
    this._preview();
  }

  onMouseUp(button) {
    if (button !== 0 || !this._drag) return;
    const { axis, sign, delta } = this._drag;
    this._end();
    if (!delta) return;
    if (this.ctx.prefab?.resize?.({ axis, sign, delta })) {
      this.lastAction = `Resized ${faceLabel(axis, sign)} by ${delta > 0 ? '+' : ''}${delta}`;
    }
  }

  update() {
    this.ctx.ghost.hide();
    if (this._drag) return;
    const face = this.aimedFace();
    if (face) this.bounds?.setHover(face.axis, face.sign);
    else this.bounds?.setHover(null);
  }

  /** Pointer lock lost / tool switched — drop the pending drag. */
  cancel() {
    if (!this._drag) return;
    const dims = this.session?.dims;
    this._end();
    if (dims) this.ctx.prefab?.previewDims?.(dims);
    this.lastAction = 'Resize cancelled';
  }

  hide() {
    this.bounds?.setHover(null);
    this.ctx.ghost.hide();
  }

  // --- internals ---

  _end() {
    this._drag = null;
    this.bounds?.setDrag(null);
    this.bounds?.hidePreview();
  }

  /** Ghost box + live numbers for the drag's current delta. */
  _preview() {
    const d = this._drag;
    const { dims } = resizePlan(d.dims, d.axis, d.sign, d.delta);
    const min = [0, 0, 0];
    if (d.sign < 0) min[d.axis] = -d.delta;
    this.bounds?.showPreview(min, dims);
    this.ctx.prefab?.previewDims?.(dims);
  }

  /**
   * Screen movement, in pixels, of one cell of outward travel on this face —
   * the vector a mouse delta is projected onto.
   * @returns {[number, number]}
   */
  _screenAxis(dims, axis, sign) {
    const { THREE, camera } = this.ctx;
    const center = dims.map((n) => (n * CELL_SIZE) / 2);
    center[axis] = sign < 0 ? 0 : dims[axis] * CELL_SIZE;
    const a = new THREE.Vector3(center[0], center[1], center[2]);
    const b = a.clone();
    b.setComponent(axis, b.getComponent(axis) + sign * CELL_SIZE);
    const pa = a.project(camera);
    const pb = b.project(camera);
    const view = this.ctx.viewport?.() ?? { w: 1920, h: 1080 };
    const px = [((pb.x - pa.x) * view.w) / 2, (-(pb.y - pa.y) * view.h) / 2];
    if (Math.hypot(px[0], px[1]) >= MIN_AXIS_PIXELS) return px;
    // Face-on: no usable screen direction, so pulling down grows the volume.
    return [0, -FALLBACK_PIXELS_PER_CELL];
  }
}
