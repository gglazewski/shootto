// SelectionGhost.js — in-world placement/removal preview.
//
// Three parts:
//  - a translucent filled cube where a new voxel would go (green when
//    placeable, red when blocked),
//  - a wireframe box around the voxel currently under the cursor (removal),
//  - an InstancedMesh of cubes for multi-cell previews (line / square tools).

import { CELL_SIZE } from '../engine/Space.js';
import { spanFor } from '../engine/VoxelShape.js';

const PLACE_COLOR = 0x33ff66;
const BLOCKED_COLOR = 0xff5533;
const SPAWN_COLOR = 0x00e5ff;

export class SelectionGhost {
  /**
   * @param {object} deps
   * @param {object} deps.THREE
   * @param {import('three').Scene} deps.scene
   */
  constructor({ THREE, scene }) {
    this.THREE = THREE;
    this.scene = scene;

    this.place = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: PLACE_COLOR, transparent: true, opacity: 0.45, depthWrite: false }),
    );
    this.place.visible = false;
    scene.add(this.place);

    this.remove = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0xff5555 }),
    );
    this.remove.visible = false;
    scene.add(this.remove);

    this.spawnGhost = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.OctahedronGeometry(CELL_SIZE * 0.7)),
      new THREE.LineBasicMaterial({ color: SPAWN_COLOR }),
    );
    this.spawnGhost.visible = false;
    scene.add(this.spawnGhost);

    this._cellsCap = 0;
    this.cells = null;
    this._cellsMat = new THREE.MeshBasicMaterial({ color: PLACE_COLOR, transparent: true, opacity: 0.4, depthWrite: false });
    this._cellsGeo = new THREE.BoxGeometry(1, 1, 1);
  }

  /**
   * Show the placement cube. anchor is in cell coords, size 'small'|'big'.
   */
  showPlacement(anchor, size, blocked) {
    const s = spanFor(size) * CELL_SIZE;
    this.hideCells();
    this.place.visible = true;
    this.place.scale.set(s, s, s);
    this.place.position.set(
      anchor[0] * CELL_SIZE + s / 2,
      anchor[1] * CELL_SIZE + s / 2,
      anchor[2] * CELL_SIZE + s / 2,
    );
    this.place.material.color.setHex(blocked ? BLOCKED_COLOR : PLACE_COLOR);
  }

  /** Show the removal outline around the hovered voxel. */
  showRemoval(anchor, size) {
    const s = spanFor(size) * CELL_SIZE;
    this.remove.visible = true;
    this.remove.scale.set(s, s, s);
    this.remove.position.set(
      anchor[0] * CELL_SIZE + s / 2,
      anchor[1] * CELL_SIZE + s / 2,
      anchor[2] * CELL_SIZE + s / 2,
    );
  }

  /** Show the spawn-point preview at a cell (cyan, red when blocked). */
  showSpawn(cell, blocked) {
    this.hideCells();
    this.place.visible = false;
    this.remove.visible = false;
    this.spawnGhost.visible = true;
    this.spawnGhost.position.set(
      cell[0] * CELL_SIZE + CELL_SIZE / 2,
      cell[1] * CELL_SIZE + CELL_SIZE / 2,
      cell[2] * CELL_SIZE + CELL_SIZE / 2,
    );
    this.spawnGhost.material.color.setHex(blocked ? BLOCKED_COLOR : SPAWN_COLOR);
  }

  /** Show the mob-spawn preview (tinted by mob type, red when blocked). */
  showMob(cell, blocked, colorHex = 0xff5544) {
    this.hideCells();
    this.place.visible = false;
    this.remove.visible = false;
    this.spawnGhost.visible = true;
    this.spawnGhost.position.set(
      cell[0] * CELL_SIZE + CELL_SIZE / 2,
      cell[1] * CELL_SIZE + CELL_SIZE / 2,
      cell[2] * CELL_SIZE + CELL_SIZE / 2,
    );
    this.spawnGhost.material.color.setHex(blocked ? BLOCKED_COLOR : colorHex);
  }

  /** Preview many cells at once (line / square). anchors are cell coords. */
  showCells(anchors, size, blocked) {
    const s = spanFor(size) * CELL_SIZE;
    this.place.visible = false;
    this.remove.visible = false;
    this._ensureCellsCapacity(anchors.length);
    const m = new this.THREE.Matrix4();
    anchors.forEach((a, i) => {
      m.makeScale(s, s, s);
      m.setPosition(a[0] * CELL_SIZE + s / 2, a[1] * CELL_SIZE + s / 2, a[2] * CELL_SIZE + s / 2);
      this.cells.setMatrixAt(i, m);
    });
    this.cells.count = anchors.length;
    this.cells.instanceMatrix.needsUpdate = true;
    this.cells.material.color.setHex(blocked ? BLOCKED_COLOR : PLACE_COLOR);
    this.cells.visible = true;
  }

  hideCells() {
    if (this.cells) this.cells.visible = false;
  }

  _ensureCellsCapacity(n) {
    if (this.cells && this._cellsCap >= n) return;
    this._cellsCap = Math.max(128, n * 2);
    if (this.cells) this.scene.remove(this.cells);
    this.cells = new this.THREE.InstancedMesh(this._cellsGeo, this._cellsMat, this._cellsCap);
    this.cells.visible = false;
    this.scene.add(this.cells);
  }

  hide() {
    this.place.visible = false;
    this.remove.visible = false;
    this.spawnGhost.visible = false;
    this.hideCells();
  }
}
