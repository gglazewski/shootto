// PrefabBounds.js — wireframe build-volume gizmo for the prefab editor.
//
// A cyan cell-aligned box from (0,0,0) to dims, so the author always sees
// the volume the prefab will claim when stamped. Rebuild with update() when
// the dims steppers change.
//
// With the Resize tool active the six sides also become grab handles: each
// face is a translucent quad that lights up when aimed at and glows while
// dragged, plus an orange ghost box showing where the side would land. The
// quads are visuals only — the pick is ray/box math in prefabResize.js — so
// they carry no raycast cost and never block the crosshair.

import { CELL_SIZE } from '../engine/Space.js';
import { faceId } from './prefabResize.js';

const BOUNDS_COLOR = 0x00e5ff;
const PREVIEW_COLOR = 0xffaa44;
const HOVER_OPACITY = 0.22;
const DRAG_OPACITY = 0.3;

export class PrefabBounds {
  constructor({ THREE, scene }) {
    this.THREE = THREE;
    this.scene = scene;
    this.lines = null;
    this.faces = null; // Group of 6 handle quads, keyed by userData.face
    this.preview = null; // ghost box while a side is being dragged
    this._dims = [1, 1, 1];
    this._handles = false;
    this._hover = null; // face id under the crosshair
    this._drag = null; // face id being pulled
  }

  update(dims) {
    this.dispose();
    this._dims = [...dims];
    const T = this.THREE;
    this.lines = this._box([0, 0, 0], dims, BOUNDS_COLOR, 0.8);
    this.lines.name = 'prefab-bounds';
    this.scene.add(this.lines);

    this.faces = new T.Group();
    this.faces.name = 'prefab-bounds-faces';
    this.faces.visible = this._handles;
    for (let axis = 0; axis < 3; axis++) {
      for (const sign of [-1, 1]) this.faces.add(this._faceQuad(dims, axis, sign));
    }
    this.scene.add(this.faces);
    this._paintFaces();
  }

  /** Show/hide the grab handles (the Resize tool owns this). */
  setHandles(on) {
    this._handles = !!on;
    if (this.faces) this.faces.visible = this._handles;
    if (!on) {
      this._hover = null;
      this._drag = null;
      this.hidePreview();
      this._paintFaces();
    }
  }

  /** Light the side under the crosshair. Pass null for "nothing aimed at". */
  setHover(axis, sign) {
    const id = axis == null ? null : faceId(axis, sign);
    if (id === this._hover) return;
    this._hover = id;
    this._paintFaces();
  }

  /** Mark the side being pulled (null when the drag ends). */
  setDrag(axis, sign) {
    const id = axis == null ? null : faceId(axis, sign);
    if (id === this._drag) return;
    this._drag = id;
    this._paintFaces();
  }

  /**
   * Ghost box for the volume a drag would produce. `min` is the box's min
   * corner in cells — it goes negative while a min side is pulled outward,
   * which is exactly what the author sees: that wall moving away.
   */
  showPreview(min, dims) {
    const T = this.THREE;
    const pos = this._boxPositions(min, dims);
    if (!this.preview) {
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.BufferAttribute(pos, 3));
      this.preview = new T.LineSegments(geo, new T.LineBasicMaterial({ color: PREVIEW_COLOR }));
      this.preview.name = 'prefab-bounds-preview';
      this.scene.add(this.preview);
      return;
    }
    this.preview.geometry.attributes.position.array.set(pos);
    this.preview.geometry.attributes.position.needsUpdate = true;
    this.preview.visible = true;
  }

  hidePreview() {
    if (this.preview) this.preview.visible = false;
  }

  dispose() {
    for (const key of ['lines', 'faces', 'preview']) {
      const obj = this[key];
      if (!obj) continue;
      this.scene.remove(obj);
      obj.traverse?.((o) => {
        o.geometry?.dispose?.();
        o.material?.dispose?.();
      });
      obj.geometry?.dispose?.();
      obj.material?.dispose?.();
      this[key] = null;
    }
  }

  // --- geometry helpers ---

  /** The 24 line-segment endpoints of a box, in world units. */
  _boxPositions(min, dims) {
    const [x0, y0, z0] = min.map((n) => n * CELL_SIZE);
    const [w, h, d] = dims.map((n) => n * CELL_SIZE);
    const [x1, y1, z1] = [x0 + w, y0 + h, z0 + d];
    const c = [
      [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
      [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1],
    ];
    const edges = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
    return new Float32Array(edges.flatMap((i) => c[i]));
  }

  _box(min, dims, color, opacity = 1) {
    const T = this.THREE;
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(this._boxPositions(min, dims), 3));
    return new T.LineSegments(geo, new T.LineBasicMaterial({ color, transparent: true, opacity }));
  }

  /** One grab quad, sitting exactly on its side of the volume. */
  _faceQuad(dims, axis, sign) {
    const T = this.THREE;
    const [w, h, d] = dims.map((n) => n * CELL_SIZE);
    const size = [w, h, d];
    const [u, v] = axis === 0 ? [2, 1] : axis === 1 ? [0, 2] : [0, 1];
    const geo = new T.PlaneGeometry(size[u], size[v]);
    const mat = new T.MeshBasicMaterial({
      color: BOUNDS_COLOR,
      transparent: true,
      opacity: 0,
      side: T.DoubleSide,
      depthWrite: false,
    });
    const mesh = new T.Mesh(geo, mat);
    // PlaneGeometry is XY-facing: turn it onto the wanted axis, then park it.
    if (axis === 0) mesh.rotation.y = Math.PI / 2;
    else if (axis === 1) mesh.rotation.x = Math.PI / 2;
    const pos = [w / 2, h / 2, d / 2];
    pos[axis] = sign < 0 ? 0 : size[axis];
    mesh.position.set(pos[0], pos[1], pos[2]);
    mesh.userData.face = faceId(axis, sign);
    mesh.renderOrder = 3;
    return mesh;
  }

  _paintFaces() {
    if (!this.faces) return;
    for (const mesh of this.faces.children) {
      const id = mesh.userData.face;
      const active = this._drag ? id === this._drag : id === this._hover;
      mesh.material.opacity = !active ? 0 : this._drag ? DRAG_OPACITY : HOVER_OPACITY;
      mesh.material.color.setHex(this._drag === id ? PREVIEW_COLOR : BOUNDS_COLOR);
    }
  }
}
