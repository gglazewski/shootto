// MobMarker.js — persistent in-world markers for mob spawn points.
//
// Renders a colour-coded beacon (octahedron + beam + ring) at every editor
// mob spawn, tinted per mob type so you can tell an imp from a brute at a
// glance. Independent of chunk meshing; update() rebuilds the marker set only
// when the spawn list changes (spawn edits are rare, so a full rebuild then is
// fine) and no-ops otherwise.

import { CELL_SIZE } from '../engine/Space.js';
import { getMob } from '../engine/mobTypes.js';

export class MobMarker {
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

  /** Sync markers to world.mobSpawns; no-op unless the set changed. */
  update() {
    const sig = [];
    this.world.forEachMobSpawn((s) => sig.push(`${s.type}@${s.x},${s.y},${s.z}`));
    sig.sort();
    const key = sig.join('|');
    if (key === this._lastSignature) {
      this.group.visible = true;
      return;
    }
    this._lastSignature = key;
    this._rebuild(sig);
  }

  _rebuild(sig) {
    this._clear();
    if (!sig.length) return;
    const T = this.THREE;
    this.world.forEachMobSpawn((s) => {
      const def = getMob(s.type);
      const color = def?.markerColor ?? 0xff5544;
      const group = new T.Group();

      const octa = new T.Mesh(
        new T.OctahedronGeometry(CELL_SIZE * 0.75),
        new T.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 }),
      );
      const ring = new T.Mesh(
        new T.TorusGeometry(CELL_SIZE * 0.8, 0.02, 8, 24),
        new T.MeshBasicMaterial({ color, transparent: true, opacity: 0.7 }),
      );
      ring.rotation.x = Math.PI / 2;
      const beam = new T.Line(
        new T.BufferGeometry().setFromPoints([
          new T.Vector3(0, CELL_SIZE * 0.75, 0),
          new T.Vector3(0, CELL_SIZE * 2.6, 0),
        ]),
        new T.LineBasicMaterial({ color, transparent: true, opacity: 0.5 }),
      );
      group.add(octa, ring, beam);
      group.position.set(
        s.x * CELL_SIZE + CELL_SIZE / 2,
        s.y * CELL_SIZE + CELL_SIZE / 2,
        s.z * CELL_SIZE + CELL_SIZE / 2,
      );
      this.group.add(group);
    });
    this.group.visible = true;
  }

  _clear() {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      for (const c of child.children) c.geometry?.dispose();
    }
  }

  /** Override visibility (e.g. hide during test run / editors). */
  setVisible(visible) {
    this.group.visible = visible;
    this._lastSignature = null;
  }

  dispose() {
    this.scene?.remove(this.group);
  }
}
