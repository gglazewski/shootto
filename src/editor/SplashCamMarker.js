// SplashCamMarker.js — in-world gizmos for authored splash cameras.
//
// Each splash camera (a saved menu-shot pose) shows up in the editor as a
// small camera body with a lens cone pointing along its view direction, so
// authors can see where their menu shots are and re-frame or delete them
// (F8 captures, Shift+F8 deletes the nearest). Same rebuild-on-change scheme
// as MobMarker: update() no-ops until the cam list actually changes.

import { CELL_SIZE } from '../engine/Space.js';

const COLOR = 0x66ccff;

export class SplashCamMarker {
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
  }

  /** Sync gizmos to the world's splash cams; no-op unless they changed. */
  update() {
    const sig = [];
    this.world.forEachSplashCam((c) => sig.push(`${c.id}@${c.pos.join(',')},${c.yaw},${c.pitch}`));
    const key = sig.join('|');
    if (key === this._lastSignature) {
      this.group.visible = true;
      return;
    }
    this._lastSignature = key;
    this._rebuild();
  }

  _rebuild() {
    this._clear();
    const T = this.THREE;
    this.world.forEachSplashCam((c) => {
      const g = new T.Group();

      const body = new T.Mesh(
        new T.BoxGeometry(CELL_SIZE * 0.7, CELL_SIZE * 0.5, CELL_SIZE * 0.9),
        new T.MeshBasicMaterial({ color: COLOR, transparent: true, opacity: 0.8 }),
      );
      g.add(body);

      // Lens cone opens along -Z (the camera's view direction).
      const lens = new T.Mesh(
        new T.ConeGeometry(CELL_SIZE * 0.45, CELL_SIZE * 0.9, 12, 1, true),
        new T.MeshBasicMaterial({ color: COLOR, transparent: true, opacity: 0.4, side: T.DoubleSide }),
      );
      lens.rotation.x = -Math.PI / 2;
      lens.position.z = -CELL_SIZE * 0.9;
      g.add(lens);

      g.position.set(c.pos[0], c.pos[1], c.pos[2]);
      g.rotation.order = 'YXZ';
      g.rotation.y = c.yaw;
      g.rotation.x = c.pitch;
      g.userData.camId = c.id;
      this.group.add(g);
    });
    this.group.visible = true;
  }

  setVisible(v) {
    this.group.visible = v;
  }

  /** The splash cam under the given camera's crosshair, or null. Pass a
   *  shared Raycaster; the pointer is locked, so the ray leaves dead centre. */
  pick(raycaster, camera) {
    if (!this.group.visible || !this.group.children.length) return null;
    raycaster.setFromCamera({ x: 0, y: 0 }, camera);
    const hit = raycaster.intersectObjects(this.group.children, true)[0];
    if (!hit) return null;
    let o = hit.object;
    while (o && o.parent !== this.group) o = o.parent;
    return o?.userData.camId ?? null;
  }

  _clear() {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      child.traverse((o) => {
        o.geometry?.dispose();
        o.material?.dispose();
      });
    }
  }
}
