// QuestAreaMarker.js — translucent yellow overlay on voxel top faces, shown
// while the F4 quest editor's "Mark area" mode paints a visit objective's
// area. One quad floats just above each marked cell's top face; the whole
// overlay is editor chrome (never saved, never in the game) — the marked
// cells themselves live in the quest objective.

import { CELL_SIZE } from '../engine/Space.js';

/** Meters the quad floats above the face, clear of z-fighting. */
const LIFT = 0.012;

export class QuestAreaMarker {
  /**
   * @param {object} deps
   * @param {object} deps.THREE
   * @param {import('three').Scene} deps.scene
   */
  constructor({ THREE, scene }) {
    this.THREE = THREE;
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);
    // One shared geometry/material for every quad — cells come and go per click.
    this.geo = new THREE.PlaneGeometry(CELL_SIZE, CELL_SIZE).rotateX(-Math.PI / 2);
    this.mat = new THREE.MeshBasicMaterial({
      color: 0xffdd44,
      transparent: true,
      opacity: 0.38,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }

  /** Show one quad per marked cell (on the cell's top face). */
  setCells(cells) {
    this.clear();
    for (const [x, y, z] of cells) {
      const quad = new this.THREE.Mesh(this.geo, this.mat);
      quad.position.set((x + 0.5) * CELL_SIZE, (y + 1) * CELL_SIZE + LIFT, (z + 0.5) * CELL_SIZE);
      this.group.add(quad);
    }
    this.group.visible = cells.length > 0;
  }

  clear() {
    while (this.group.children.length) this.group.remove(this.group.children[0]);
    this.group.visible = false;
  }

  dispose() {
    this.clear();
    this.scene.remove(this.group);
    this.geo.dispose();
    this.mat.dispose();
  }
}
