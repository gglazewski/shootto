// SpawnMarker.js — persistent in-world marker for the player spawn point.
//
// Rendered as a cyan beacon (octahedron + vertical beam + ground ring) at the
// spawn cell, plus a direction arrow showing which way the spawned player
// faces. The arrow follows world.spawnYaw (degrees, 0 = -Z) so <R> with the
// spawn tool rotates it. Independent of chunk meshing; update() syncs to
// world.spawn and is cheap enough to call every frame (it no-ops unless the
// spawn position or yaw changed).

import { CELL_SIZE } from '../engine/Space.js';

export class SpawnMarker {
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

    const octa = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.OctahedronGeometry(CELL_SIZE * 0.9)),
      new THREE.LineBasicMaterial({ color: 0x00e5ff }),
    );
    const beam = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, CELL_SIZE * 0.9, 0),
        new THREE.Vector3(0, CELL_SIZE * 3, 0),
      ]),
      new THREE.LineBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.6 }),
    );
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(CELL_SIZE * 0.8, 0.02, 8, 24),
      new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.8 }),
    );
    ring.rotation.x = Math.PI / 2;
    this.group.add(octa, beam, ring);

    // Direction arrow: a short line + cone pointing toward -Z (the camera's
    // forward at yaw 0), rotated about the spawn by world.spawnYaw.
    this.arrow = new THREE.Group();
    this.group.add(this.arrow);
    const ARROW_LEN = CELL_SIZE * 1.2;
    const shaft = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, CELL_SIZE * 0.9, 0),
        new THREE.Vector3(0, CELL_SIZE * 0.9, -ARROW_LEN),
      ]),
      new THREE.LineBasicMaterial({ color: 0x00ffcc, transparent: true, opacity: 0.9 }),
    );
    this.arrow.add(shaft);
    const head = new THREE.Mesh(
      new THREE.ConeGeometry(CELL_SIZE * 0.28, CELL_SIZE * 0.5, 10),
      new THREE.MeshBasicMaterial({ color: 0x00ffcc }),
    );
    head.position.set(0, CELL_SIZE * 0.9, -ARROW_LEN);
    head.rotation.x = -Math.PI / 2; // cone's +Y (tip) points toward -Z
    this.arrow.add(head);

    this._lastKey = null;
  }

  /** Sync to world.spawn + spawnYaw; no-op unless either changed. */
  update() {
    const s = this.world.spawn;
    const key = s ? `${s.join(',')}|${this.world.spawnYaw ?? 0}` : null;
    if (key === this._lastKey) return;
    this._lastKey = key;
    if (!s) {
      this.group.visible = false;
      return;
    }
    this.group.position.set(
      s[0] * CELL_SIZE + CELL_SIZE / 2,
      s[1] * CELL_SIZE + CELL_SIZE / 2,
      s[2] * CELL_SIZE + CELL_SIZE / 2,
    );
    this.arrow.rotation.set(0, ((this.world.spawnYaw ?? 0) * Math.PI) / 180, 0);
    this.group.visible = true;
  }

  /**
   * Override visibility (e.g. hide during test-run mode). Resets the sync key
   * so the next update() re-applies the world's actual spawn state.
   */
  setVisible(visible) {
    this.group.visible = visible;
    this._lastKey = null;
  }

  dispose() {
    this.scene?.remove(this.group);
    for (const c of this.group.children) c.geometry?.dispose();
  }
}
