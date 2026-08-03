// EquipmentEditor.js — the F3 equippable-item editor.
//
// A sibling of the F2 placeable-object editor (ItemEditor), sharing its orbit
// camera, micro-voxel painting and palette, but for HOLDABLE items instead of
// world-placed objects. The Kind selector (Weapon / Ammo) picks what the item
// is: weapons expose grip / direction / stats / attack fields and are held and
// fought with; ammo items expose a max stack + starting amount and define an
// ammo type that weapons consume and the player carries.
//
// Weapon fields (set this editor apart from the object editor):
//   - grip:  a highlighted voxel cell marking where the player's hand grips the
//            item. Toggle grip mode (G / "Grip" button); while it's on, the
//            ghost turns cyan and a left click sets the grip cell instead of
//            painting a voxel. A cyan "handle" cube shows the current grip.
//   - yaw:   the item's forward direction, drawn as a cyan arrow from the grip
//            cell (like the object editor's axis arrows). R / "Direction"
//            rotates it 90° at a time. Default +Z.
//   - stats: damage / reach (m) / cooldown (s) — the attack profile the game
//            uses when the item is equipped.
//
// Interactions:
//   LMB drag  rotate orbit   ·  MMB drag  pan   ·  wheel  zoom
//   LMB click place voxel    ·  RMB click erase ·  MMB click  pick color
//   G         grip mode (click to set the grip) ·  R  rotate direction
//   1-0 / E   select palette color
//   Ctrl+S    save item (registry)  ·  Ctrl+Z / Ctrl+Shift+Z  undo/redo
//   F3 / Esc  back to the world editor

import { MICRO_GRID, ITEM_PALETTE, microCellSizeFor, slugifyName } from '../../engine/ItemTypes.js';
import { emptyEquipItem, deserializeEquipItem, isEquipId, DEFAULT_WEAPON, DEFAULT_AMMO, ATTACK_ANIMS } from '../../engine/EquipmentRegistry.js';
import { listAmmoTypes } from '../../engine/AmmoTypes.js';
import { createItemGeometry } from '../ItemGeometry.three.js';
import { raycastVoxel } from '../../engine/VoxelRaycaster.js';
import { Notice } from '../Notice.js';

const GRID = MICRO_GRID;
/** Background of the dedicated items-editor scene (clean, no sky). */
const BG_COLOR = 0x151921;
const PITCH_LIMIT = Math.PI / 2 - 0.05;

// Held items always preview on the small (0.5 m) footprint grid.
const PREVIEW_SIZE = 'small';

/** Grip marker + direction-arrow colour (distinct from the red/green/blue axes). */
const HANDLE_COLOR = 0x33eeff;
const MUZZLE_COLOR = 0xffcc44;
const GRIP_GHOST_COLOR = 0x33eeff;
const MUZZLE_GHOST_COLOR = 0xffcc44;
const OK_GHOST_COLOR = 0x33ff66;
const BLOCKED_GHOST_COLOR = 0xff5533;

const rgbToHex = (c) => ((Math.round(c[0]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[2])) >>> 0;

/** Axis label for a yaw angle (0 = +Z, 90 = +X, ...). */
function yawLabel(deg) {
  const d = ((deg % 360) + 360) % 360;
  const axes = { 0: '+Z', 90: '+X', 180: '-Z', 270: '-X' };
  return `${axes[d] ?? `${d}°`} (${d}°)`;
}

export class EquipmentEditor {
  /**
   * @param {object} deps
   * @param {object} deps.THREE
   * @param {import('three').Camera} deps.camera
   * @param {Document} [deps.doc]
   */
  constructor({ THREE, camera, doc = document }) {
    this.THREE = THREE;
    this.camera = camera;
    this.doc = doc;

    // Dedicated clean scene: solid background, no day/night cycle, no world.
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BG_COLOR);

    this.item = emptyEquipItem();
    this.color = [...ITEM_PALETTE[0].color];
    this.colorIndex = 0;
    this.gripMode = false;
    this.muzzleMode = false;

    this.isOpen = false;
    this.onClose = null;        // () => void
    this.onSave = null;         // (item: EquipDef) => void
    this.onOpenCatalogue = null; // () => void

    // orbit camera state
    this.origin = new THREE.Vector3(0, 0, 0);
    this.target = this.origin.clone();
    this.dist = 4;
    this.yaw = 0.7;
    this.pitch = 0.35;
    this._drag = null;
    this._pointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

    this.microWorld = { get: (x, y, z) => this._microAt(x, y, z) };
    this._ghostCell = null;
    this._ghostBlocked = false;
    this._undoStack = [];
    this._redoStack = [];

    this._buildSceneObjects();
    this._buildFloor();
    this._wireUI();
  }

  // --- scene objects ---

  _buildSceneObjects() {
    const T = this.THREE;
    this.group = new T.Group();
    this.group.visible = false;
    this.scene.add(this.group);

    this.itemMesh = new T.Mesh(
      new T.BufferGeometry(),
      new T.MeshBasicMaterial({ vertexColors: true }),
    );
    this.group.add(this.itemMesh);

    this.bounds = new T.LineSegments(
      new T.EdgesGeometry(new T.BoxGeometry(1, 1, 1)),
      new T.LineBasicMaterial({ color: 0x9aa4b2, transparent: true, opacity: 0.35 }),
    );
    this.group.add(this.bounds);

    this.ghost = new T.Mesh(
      new T.BoxGeometry(1, 1, 1),
      new T.MeshBasicMaterial({ color: OK_GHOST_COLOR, transparent: true, opacity: 0.45, depthWrite: false }),
    );
    this.ghost.visible = false;
    this.group.add(this.ghost);

    // Grip handle: a cyan cube slightly larger than a micro voxel so it reads
    // as the "where the hand holds" marker.
    this.gripMarker = new T.Mesh(
      new T.BoxGeometry(1, 1, 1),
      new T.MeshBasicMaterial({ color: HANDLE_COLOR, transparent: true, opacity: 0.55, depthWrite: false }),
    );
    this.gripMarker.visible = false;
    this.group.add(this.gripMarker);

    // Muzzle marker: the barrel-end voxel (where a ranged weapon shoots from),
    // shown in yellow — like the grip handle but for the muzzle.
    this.muzzleMarker = new T.Mesh(
      new T.BoxGeometry(1, 1, 1),
      new T.MeshBasicMaterial({ color: MUZZLE_COLOR, transparent: true, opacity: 0.55, depthWrite: false }),
    );
    this.muzzleMarker.visible = false;
    this.group.add(this.muzzleMarker);

    // Direction arrow: shaft line + cone head, oriented by item.yaw. Built at
    // world size (~0.6 grid widths) so it reads clearly against the floor.
    this.dirArrow = new T.Group();
    this.dirArrow.visible = false;
    this.group.add(this.dirArrow);

    const ARROW_LEN = 0.3;
    const shaft = new T.Line(
      new T.BufferGeometry().setFromPoints([
        new T.Vector3(0, 0, 0),
        new T.Vector3(0, 0, ARROW_LEN),
      ]),
      new T.LineBasicMaterial({ color: HANDLE_COLOR, transparent: true, opacity: 0.9 }),
    );
    this.dirArrow.add(shaft);

    const head = new T.Mesh(
      new T.ConeGeometry(0.05, 0.12, 10),
      new T.MeshBasicMaterial({ color: HANDLE_COLOR }),
    );
    head.position.z = ARROW_LEN;
    head.rotation.x = Math.PI / 2; // cone's +Y (tip) points toward +Z
    this.dirArrow.add(head);
  }

  /** Gridded floor on the BOTTOM face of the build canvas, plus marked centre
   *  axes (identical to the object editor's floor). */
  _buildFloor() {
    const T = this.THREE;
    this.floorGrid = new T.GridHelper(1, GRID, 0x7a8fc0, 0x2c3442);
    this.scene.add(this.floorGrid);

    this.axesGroup = new T.Group();
    this.scene.add(this.axesGroup);

    const axisLine = (a, b, color) => {
      const line = new T.Line(
        new T.BufferGeometry().setFromPoints([a, b]),
        new T.LineBasicMaterial({ color, transparent: true, opacity: 0.75 }),
      );
      this.axesGroup.add(line);
      return line;
    };
    const arrow = (tip, dir, color) => {
      const cone = new T.Mesh(new T.ConeGeometry(0.06, 0.16, 10), new T.MeshBasicMaterial({ color }));
      cone.position.copy(tip);
      if (dir === 'x') cone.rotation.z = -Math.PI / 2;
      else if (dir === 'z') cone.rotation.x = Math.PI / 2;
      this.axesGroup.add(cone);
      return cone;
    };
    this.axisX = axisLine(new T.Vector3(0, 0, 0), new T.Vector3(1, 0, 0), 0xff5555);
    arrow(new T.Vector3(1, 0, 0), 'x', 0xff5555);
    this.axisZ = axisLine(new T.Vector3(0, 0, 0), new T.Vector3(0, 0, 1), 0x5588ff);
    arrow(new T.Vector3(0, 0, 1), 'z', 0x5588ff);
    this.axisY = axisLine(new T.Vector3(0, 0, 0), new T.Vector3(0, 1.6, 0), 0x66d966);
    arrow(new T.Vector3(0, 1.6, 0), 'y', 0x66d966);
  }

  /** Move the floor grid + axes to the bottom face of the build canvas and
   *  scale the grid to the (fixed, small) footprint. */
  _positionFloor() {
    const c = microCellSizeFor(PREVIEW_SIZE);
    const ws = GRID * c;
    this.floorGrid.scale.setScalar(ws);
    this.floorGrid.position.y = -ws / 2;
    this.axesGroup.position.y = -ws / 2;
  }

  // --- mode lifecycle ---

  enter() {
    this.isOpen = true;
    this.group.visible = true;
    this.target.copy(this.origin);
    this.dist = 4;
    this.yaw = 0.7;
    this.pitch = 0.35;
    this._drag = null;
    this._rebuild();
    this._applyCamera();
    this._closeModals();
  }

  exit() {
    this.isOpen = false;
    this.group.visible = false;
    this.gripMode = false;
    this.muzzleMode = false;
    this._closeModals();
  }

  // --- per-frame update ---

  update(dt) {
    if (!this.isOpen) return;
    this._applyCamera();
    this._updateGhost();
  }

  _applyCamera() {
    const T = this.THREE;
    const ep = Math.cos(this.pitch);
    this.camera.position.set(
      this.target.x + this.dist * ep * Math.sin(this.yaw),
      this.target.y + this.dist * Math.sin(this.pitch),
      this.target.z + this.dist * ep * Math.cos(this.yaw),
    );
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld(true);
  }

  // --- input (called by App) ---

  onMouseDown({ button, x, y }) {
    if (!this.isOpen || this._modalOpen()) return;
    this._pointer.x = x;
    this._pointer.y = y;
    if (button === 2) {
      // RMB is always "erase", like the object editor's remove.
      this._remove();
      this._drag = null;
      return;
    }
    this._drag = { button, startX: x, startY: y, moved: 0 };
  }

  onMouseUp({ button, x, y }) {
    if (!this.isOpen) return;
    const d = this._drag;
    this._drag = null;
    if (!d || d.button !== button) return;
    this._pointer.x = x;
    this._pointer.y = y;
    if (d.moved < 6) {
      if (button === 0) {
        if (this.gripMode) this._setGrip();
        else if (this.muzzleMode) this._setMuzzle();
        else this._place();
      } else if (button === 1) {
        this._pickColor();
      }
    }
  }

  onMouseMove({ dx, dy, x, y }) {
    if (!this.isOpen) return;
    this._pointer.x = x;
    this._pointer.y = y;
    if (!this._drag) return;
    this._drag.moved += Math.abs(dx) + Math.abs(dy);
    if (this._drag.button === 0) {
      this.yaw -= dx * 0.006;
      this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - dy * 0.006));
    } else if (this._drag.button === 1) {
      this._pan(dx, dy);
    }
  }

  onWheel({ deltaY }) {
    if (!this.isOpen) return;
    const f = deltaY > 0 ? 1.12 : 1 / 1.12;
    this.dist = Math.max(1.2, Math.min(40, this.dist * f));
  }

  onKeyDown(code, event) {
    if (!this.isOpen) return;
    // Typing in the panel's form fields must not trigger editor shortcuts
    // (digits select colors, G/R/E are editor actions, Esc exits the mode).
    const t = event?.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (code === 'Escape') {
      this._closeModals();
      if (!this._modalOpen()) this.onClose?.();
      return;
    }
    // Grip / muzzle / direction only mean something on held weapons.
    if (this.item.kind !== 'ammo') {
      if (code === 'KeyG') {
        this._toggleGripMode();
        return;
      }
      if (code === 'KeyM') {
        this._toggleMuzzleMode();
        return;
      }
      if (code === 'KeyR') {
        this._rotateDirection();
        return;
      }
    }
    if (code === 'KeyE') {
      this._togglePalette();
      return;
    }
    if (/^Digit[0-9]$/.test(code)) {
      this._selectColor((Number(code.slice(5)) - 1 + 10) % 10);
      return;
    }
    if (code === 'KeyZ' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (event.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (code === 'KeyS' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.save();
    }
  }

  _pan(dx, dy) {
    const T = this.THREE;
    const k = this.dist * 0.0016;
    const forward = new T.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new T.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.target.addScaledVector(right, -dx * k);
    this.target.y += dy * k;
  }

  // --- micro-voxel painting ---

  _microAt(x, y, z) {
    for (const v of this.item.microVoxels) {
      if (v.x === x && v.y === y && v.z === z) return v;
    }
    return null;
  }

  _cellCenterToWorld(cell) {
    const c = microCellSizeFor(PREVIEW_SIZE);
    return [
      this.origin.x + (cell[0] + 0.5 - GRID / 2) * c,
      this.origin.y + (cell[1] + 0.5 - GRID / 2) * c,
      this.origin.z + (cell[2] + 0.5 - GRID / 2) * c,
    ];
  }

  _worldToMicro(p) {
    const c = microCellSizeFor(PREVIEW_SIZE);
    return [
      (p[0] - this.origin.x) / c + GRID / 2,
      (p[1] - this.origin.y) / c + GRID / 2,
      (p[2] - this.origin.z) / c + GRID / 2,
    ];
  }

  /** Camera ray through the current pointer position, in world units. */
  _cameraRay() {
    const T = this.THREE;
    const ndcX = (this._pointer.x / Math.max(1, window.innerWidth)) * 2 - 1;
    const ndcY = -((this._pointer.y / Math.max(1, window.innerHeight)) * 2 - 1);
    const v = new T.Vector3(ndcX, ndcY, 0.5).unproject(this.camera);
    const dir = v.sub(this.camera.position).normalize();
    return { origin: this.camera.position, dir };
  }

  /** Cells the aim ray passes through inside the build grid, ordered from the
   *  near face to the far face. Empty when the ray misses the grid. */
  _cellsAlongRay() {
    const { origin, dir } = this._cameraRay();
    const [ox, oy, oz] = this._worldToMicro([origin.x, origin.y, origin.z]);
    const dx = dir.x;
    const dy = dir.y;
    const dz = dir.z;

    let x = Math.floor(ox);
    let y = Math.floor(oy);
    let z = Math.floor(oz);
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;
    const fracX = dx !== 0 ? ((dx > 0 ? x + 1 - ox : ox - x) * tDeltaX) : Infinity;
    const fracY = dy !== 0 ? ((dy > 0 ? y + 1 - oy : oy - y) * tDeltaY) : Infinity;
    const fracZ = dz !== 0 ? ((dz > 0 ? z + 1 - oz : oz - z) * tDeltaZ) : Infinity;
    let tMaxX = fracX;
    let tMaxY = fracY;
    let tMaxZ = fracZ;
    let t = 0;

    const inBounds = (a, b, c) => a >= 0 && a < GRID && b >= 0 && b < GRID && c >= 0 && c < GRID;
    const cells = [];
    let wasInside = inBounds(x, y, z);
    for (let i = 0; i < 1024; i++) {
      if (inBounds(x, y, z)) {
        cells.push([x, y, z]);
        wasInside = true;
      } else if (wasInside) {
        break; // left the grid
      }
      if (tMaxX < tMaxY && tMaxX < tMaxZ) { x += stepX; t = tMaxX; tMaxX += tDeltaX; }
      else if (tMaxY < tMaxZ) { y += stepY; t = tMaxY; tMaxY += tDeltaY; }
      else { z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; }
      if (t > 1e9) break;
    }
    return cells;
  }

  /** Target micro-cell under the cursor (same rules as the object editor:
   *  the cell adjacent to a hit voxel's face, else the deepest empty cell
   *  along the ray). */
  _targetCellFromRay() {
    const hit = this._raycast();
    if (hit) {
      const x = hit.cell[0] + hit.normal[0];
      const y = hit.cell[1] + hit.normal[1];
      const z = hit.cell[2] + hit.normal[2];
      if (x >= 0 && x < GRID && y >= 0 && y < GRID && z >= 0 && z < GRID) {
        return [x, y, z];
      }
    }
    const cells = this._cellsAlongRay();
    if (!cells.length) return null;
    for (let i = cells.length - 1; i >= 0; i--) {
      const c = cells[i];
      if (!this._microAt(c[0], c[1], c[2])) return c;
    }
    return cells[cells.length - 1];
  }

  /** DDA raycast against occupied micro-voxels only (used by erase / pick). */
  _raycast() {
    const { origin, dir } = this._cameraRay();
    return raycastVoxel(this.microWorld, this._worldToMicro([origin.x, origin.y, origin.z]), [dir.x, dir.y, dir.z]);
  }

  _place() {
    const cell = this._ghostCell;
    if (!cell) return;
    if (this._ghostBlocked) {
      Notice.warn('Cannot place there');
      return;
    }
    this._pushSnapshot();
    this.item.microVoxels.push({ x: cell[0], y: cell[1], z: cell[2], color: [...this.color] });
    this._rebuild();
  }

  _remove() {
    const hit = this._raycast();
    if (!hit) return;
    const v = this._microAt(hit.cell[0], hit.cell[1], hit.cell[2]);
    if (!v) return;
    this._pushSnapshot();
    this.item.microVoxels = this.item.microVoxels.filter(
      (m) => !(m.x === hit.cell[0] && m.y === hit.cell[1] && m.z === hit.cell[2]),
    );
    this._rebuild();
  }

  _pickColor() {
    const hit = this._raycast();
    if (!hit) return;
    const v = this._microAt(hit.cell[0], hit.cell[1], hit.cell[2]);
    if (!v) return;
    const idx = ITEM_PALETTE.findIndex((p) => p.color.every((c, i) => c === v.color[i]));
    this.color = [...v.color];
    this.colorIndex = idx;
    this._renderUI();
    Notice.info('Color picked', 600);
  }

  _updateGhost() {
    const cell = this._targetCellFromRay();
    if (!cell) {
      this.ghost.visible = false;
      this._ghostCell = null;
      return;
    }
    const occupied = !!this._microAt(cell[0], cell[1], cell[2]);
    this._ghostCell = cell;
    this._ghostBlocked = occupied;
    this.ghost.visible = true;
    const c = microCellSizeFor(PREVIEW_SIZE);
    this.ghost.scale.set(c, c, c);
    const [wx, wy, wz] = this._cellCenterToWorld(cell);
    this.ghost.position.set(wx, wy, wz);
    this.ghost.material.color.setHex(
      this.gripMode ? GRIP_GHOST_COLOR
        : this.muzzleMode ? MUZZLE_GHOST_COLOR
        : (occupied ? BLOCKED_GHOST_COLOR : OK_GHOST_COLOR),
    );
  }

  // --- grip + direction + muzzle ---

  _toggleGripMode() {
    this.gripMode = !this.gripMode;
    this.muzzleMode = false;
    this._renderUI();
    Notice.info(this.gripMode ? 'Grip mode: click a voxel to set the grip' : 'Grip mode off', 1200);
  }

  /** Set the grip to the hovered cell (only the cell position is stored; the
   *  hand can grip a filled or empty cell). */
  _setGrip() {
    const cell = this._ghostCell;
    if (!cell) {
      Notice.warn('Click a voxel to set the grip');
      return;
    }
    this._pushSnapshot();
    this.item.grip = { x: cell[0], y: cell[1], z: cell[2] };
    this._rebuild();
    Notice.info(`Grip set at (${cell[0]}, ${cell[1]}, ${cell[2]})`, 900);
  }

  _toggleMuzzleMode() {
    this.muzzleMode = !this.muzzleMode;
    this.gripMode = false;
    this._renderUI();
    Notice.info(
      this.muzzleMode ? 'Muzzle mode: click a voxel to set the barrel end' : 'Muzzle mode off',
      1200,
    );
  }

  /** Set the muzzle (barrel end) to the hovered cell. */
  _setMuzzle() {
    const cell = this._ghostCell;
    if (!cell) {
      Notice.warn('Click a voxel to set the muzzle');
      return;
    }
    this._pushSnapshot();
    this.item.weapon.muzzle = { x: cell[0], y: cell[1], z: cell[2] };
    this._rebuild();
    Notice.info(`Muzzle set at (${cell[0]}, ${cell[1]}, ${cell[2]})`, 900);
  }

  _rotateDirection() {
    this._pushSnapshot();
    this.item.yaw = (this.item.yaw + 90) % 360;
    this._rebuild();
    Notice.info(`Direction: ${yawLabel(this.item.yaw)}`, 700);
  }

  /** Keep the grip marker, muzzle marker and direction arrow in sync. Held-item
   *  markers (grip / muzzle / arrow) only apply to weapons, so ammo items get
   *  none. */
  _updateGripAndArrow() {
    const T = this.THREE;
    const c = microCellSizeFor(PREVIEW_SIZE);
    const held = this.item.kind !== 'ammo';
    const base = held && this.item.grip ? [this.item.grip.x, this.item.grip.y, this.item.grip.z] : null;

    if (base) {
      const [wx, wy, wz] = this._cellCenterToWorld(base);
      this.gripMarker.visible = true;
      this.gripMarker.scale.set(c * 1.25, c * 1.25, c * 1.25);
      this.gripMarker.position.set(wx, wy, wz);
    } else {
      this.gripMarker.visible = false;
    }

    const muzzle = held && this.item.weapon?.muzzle;
    if (muzzle) {
      const [wx, wy, wz] = this._cellCenterToWorld([muzzle.x, muzzle.y, muzzle.z]);
      this.muzzleMarker.visible = true;
      this.muzzleMarker.scale.set(c * 1.25, c * 1.25, c * 1.25);
      this.muzzleMarker.position.set(wx, wy, wz);
    } else {
      this.muzzleMarker.visible = false;
    }

    // Arrow originates at the grip (or the grid centre when unset).
    const o = base
      ? this._cellCenterToWorld(base)
      : this._cellCenterToWorld([Math.floor(GRID / 2), Math.floor(GRID / 2), Math.floor(GRID / 2)]);
    this.dirArrow.visible = held;
    this.dirArrow.position.set(o[0], o[1], o[2]);
    this.dirArrow.rotation.set(0, (this.item.yaw * Math.PI) / 180, 0);
  }

  // --- item model updates ---

  _selectColor(idx) {
    this.color = [...ITEM_PALETTE[idx].color];
    this.colorIndex = idx;
    this._renderUI();
  }

  _rebuild() {
    const c = microCellSizeFor(PREVIEW_SIZE);
    const ws = GRID * c;
    const geo = createItemGeometry(this.THREE, this.item.microVoxels);
    this.itemMesh.geometry.dispose();
    this.itemMesh.geometry = geo;
    this.itemMesh.scale.setScalar(c);
    this.itemMesh.position.set(
      this.origin.x - ws / 2,
      this.origin.y - ws / 2,
      this.origin.z - ws / 2,
    );
    this.bounds.scale.setScalar(ws);
    this.bounds.position.copy(this.origin);
    this._positionFloor();
    this._updateGripAndArrow();
    this._renderUI();
  }

  // --- undo / redo ---

  _pushSnapshot() {
    this._undoStack.push(this._snapshot());
    if (this._undoStack.length > 50) this._undoStack.shift();
    this._redoStack.length = 0;
  }

  _snapshot() {
    return JSON.parse(JSON.stringify({
      microVoxels: this.item.microVoxels,
      grip: this.item.grip,
      yaw: this.item.yaw,
      kind: this.item.kind,
      stats: this.item.stats,
      weapon: this.item.weapon,
      ammo: this.item.ammo,
    }));
  }

  _restore(s) {
    this.item.microVoxels = s.microVoxels;
    this.item.grip = s.grip;
    this.item.yaw = s.yaw;
    this.item.kind = s.kind ?? 'weapon';
    this.item.stats = s.stats;
    this.item.weapon = s.weapon;
    this.item.ammo = s.ammo ?? { ...DEFAULT_AMMO };
    this._rebuild();
  }

  undo() {
    if (!this._undoStack.length) return false;
    this._redoStack.push(this._snapshot());
    this._restore(this._undoStack.pop());
    return true;
  }

  redo() {
    if (!this._redoStack.length) return false;
    this._undoStack.push(this._snapshot());
    this._restore(this._redoStack.pop());
    return true;
  }

  // --- save / load ---

  save() {
    if (!this.item.microVoxels.length) {
      Notice.warn('Item is empty — place some micro voxels first');
      return;
    }
    this.item.name = this._ui.name.value.trim() || 'Item';
    if (this.item.kind === 'ammo') {
      this._syncAmmoFromUI();
      if (!this.item.ammo.type) {
        Notice.warn('Pick an ammo type for the pack');
        return;
      }
    } else {
      this._syncStatsFromUI();
    }
    this._ensureId();
    this.onSave?.(JSON.parse(JSON.stringify(this.item)));
  }

  _ensureId() {
    if (this.item.id) return;
    const base = slugifyName(this.item.name);
    let id = base;
    let n = 2;
    while (isEquipId(id)) id = `${base}_${n++}`;
    this.item.id = id;
  }

  /** Load a registered item into the editor for further editing. */
  loadEquipItem(item) {
    this.item = JSON.parse(JSON.stringify(item));
    if (!this.item.stats) this.item.stats = { damage: 10, reach: 2, cooldown: 0.35 };
    if (!this.item.weapon) this.item.weapon = { ...DEFAULT_WEAPON };
    if (!this.item.kind) this.item.kind = 'weapon';
    if (!this.item.ammo) this.item.ammo = { ...DEFAULT_AMMO };
    this._undoStack.length = 0;
    this._redoStack.length = 0;
    this._rebuild();
  }

  /** Start over with a blank item. The current one stays on the undo stack so
   *  Ctrl+Z can bring it back. */
  newItem() {
    this._pushSnapshot();
    this.item = emptyEquipItem();
    this.gripMode = false;
    this.muzzleMode = false;
    this._rebuild();
    Notice.info('New item — start painting', 900);
  }

  loadText(text) {
    const { item, errors } = deserializeEquipItem(text);
    if (!item) {
      Notice.warn(errors[0] ?? 'Failed to load item');
      return;
    }
    this.loadEquipItem(item);
    Notice.info(`Loaded item "${item.name}"`);
  }

  // --- UI ---

  _wireUI() {
    const $ = (s) => this.doc.querySelector(s);
    const ui = {
      title: $('#ep-title'),
      name: $('#ep-name'),
      catWeapon: $('#ep-cat-weapon'),
      catAmmo: $('#ep-cat-ammo'),
      weaponFields: $('#ep-weapon-fields'),
      ammoFields: $('#ep-ammo-fields'),
      gripLabel: $('#ep-grip-label'),
      yawLabel: $('#ep-yaw-label'),
      color: $('#ep-color'),
      colorName: $('#ep-color-name'),
      damage: $('#ep-damage'),
      reach: $('#ep-reach'),
      cooldown: $('#ep-cooldown'),
      count: $('#ep-count'),
      paletteBtn: $('#ep-palette'),
      gripBtn: $('#ep-grip'),
      muzzleBtn: $('#ep-muzzle'),
      rotateBtn: $('#ep-rotate'),
      kindMelee: $('#ep-kind-melee'),
      kindRanged: $('#ep-kind-ranged'),
      handsOne: $('#ep-hands-one'),
      handsTwo: $('#ep-hands-two'),
      anim: $('#ep-anim'),
      magazine: $('#ep-magazine'),
      magazineRow: $('#ep-magazine-row'),
      ammo: $('#ep-ammo'),
      ammoRow: $('#ep-ammo-row'),
      reload: $('#ep-reload'),
      reloadRow: $('#ep-reload-row'),
      ammoType: $('#ep-ammo-type'),
      grant: $('#ep-grant'),
      paletteModal: $('#ep-palette-modal'),
      paletteGrid: $('#ep-palette-grid'),
      paletteClose: $('#ep-palette-close'),
      undo: $('#ep-undo'),
      newBtn: $('#ep-new'),
      save: $('#ep-save'),
      back: $('#ep-back'),
      catalogue: $('#ep-catalogue'),
    };
    this._ui = ui;

    ui.name.addEventListener('change', () => {
      this.item.name = ui.name.value.trim() || 'Item';
      this._renderUI();
    });
    ui.catWeapon.addEventListener('click', () => this._setItemKind('weapon'));
    ui.catAmmo.addEventListener('click', () => this._setItemKind('ammo'));
    for (const key of ['damage', 'reach', 'cooldown']) {
      ui[key].addEventListener('change', () => {
        this._pushSnapshot();
        this._syncStatsFromUI();
        this._renderUI();
      });
    }
    for (const key of ['ammoType', 'grant']) {
      ui[key].addEventListener('change', () => {
        this._pushSnapshot();
        this._syncAmmoFromUI();
        this._renderUI();
      });
    }

    ui.paletteBtn.addEventListener('click', () => this._openModal(ui.paletteModal));
    ui.paletteClose.addEventListener('click', () => this._closeModals());
    ui.paletteModal.addEventListener('click', (e) => {
      if (e.target === ui.paletteModal) this._closeModals();
    });
    this._buildPaletteGrid();

    ui.gripBtn.addEventListener('click', () => this._toggleGripMode());
    ui.muzzleBtn.addEventListener('click', () => this._toggleMuzzleMode());
    ui.rotateBtn.addEventListener('click', () => this._rotateDirection());
    ui.kindMelee.addEventListener('click', () => this._setKind('melee'));
    ui.kindRanged.addEventListener('click', () => this._setKind('ranged'));
    ui.handsOne.addEventListener('click', () => this._setHands('one'));
    ui.handsTwo.addEventListener('click', () => this._setHands('two'));
    ui.anim.addEventListener('change', () => {
      this._pushSnapshot();
      this.item.weapon.anim = ui.anim.value;
      this._renderUI();
      Notice.info(`Attack animation: ${ui.anim.value}`, 700);
    });
    ui.magazine.addEventListener('change', () => {
      this._pushSnapshot();
      const v = Number(ui.magazine.value);
      this.item.weapon.magazine = Number.isFinite(v) ? Math.max(0, Math.min(500, Math.round(v))) : 0;
      this._renderUI();
    });
    ui.ammo.addEventListener('change', () => {
      this._pushSnapshot();
      this.item.weapon.ammo = ui.ammo.value;
      this._renderUI();
    });
    ui.reload.addEventListener('change', () => {
      this._pushSnapshot();
      const v = Number(ui.reload.value);
      this.item.weapon.reload = Number.isFinite(v) ? Math.max(0.2, Math.min(10, v)) : 1.4;
      this._renderUI();
    });
    ui.undo.addEventListener('click', () => this.undo());
    ui.newBtn.addEventListener('click', () => this.newItem());
    ui.save.addEventListener('click', () => this.save());
    ui.back.addEventListener('click', () => this.onClose?.());
    ui.catalogue.addEventListener('click', () => this.onOpenCatalogue?.());

    this._renderUI();
  }

  /** Switch the item kind (weapon vs ammo) and drop any held-item marker mode. */
  _setItemKind(kind) {
    if (this.item.kind === kind) return;
    this._pushSnapshot();
    this.item.kind = kind;
    this.gripMode = false;
    this.muzzleMode = false;
    this._rebuild();
    Notice.info(kind === 'ammo' ? 'Ammo item — defines an ammo type' : 'Weapon item — held and fought with', 1100);
  }

  /** Switch the weapon kind and snap the attack animation to a valid default. */
  _setKind(kind) {
    if (this.item.weapon.kind === kind) return;
    this._pushSnapshot();
    this.item.weapon.kind = kind;
    if (!ATTACK_ANIMS[kind].includes(this.item.weapon.anim)) {
      this.item.weapon.anim = kind === 'ranged' ? 'gun' : 'punch';
    }
    this._rebuild();
    Notice.info(kind === 'ranged' ? 'Ranged weapon — set the muzzle (M)' : 'Melee weapon', 1000);
  }

  _setHands(hands) {
    if (this.item.weapon.hands === hands) return;
    this._pushSnapshot();
    this.item.weapon.hands = hands;
    this._renderUI();
  }

  /** Read damage/reach/cooldown from the panel into item.stats. */
  _syncStatsFromUI() {
    const n = (el, fallback) => {
      const v = Number(el.value);
      return Number.isFinite(v) ? v : fallback;
    };
    this.item.stats = {
      damage: Math.max(1, Math.min(100, n(this._ui.damage, 10))),
      reach: Math.max(0.5, Math.min(1000, n(this._ui.reach, 2))),
      cooldown: Math.max(0.1, Math.min(3, n(this._ui.cooldown, 0.35))),
    };
  }

  /** Read the ammo type + granted amount from the panel into item.ammo. */
  _syncAmmoFromUI() {
    const n = (el, fallback) => {
      const v = Number(el.value);
      return Number.isFinite(v) ? v : fallback;
    };
    const type = this._ui.ammoType.value;
    this.item.ammo = {
      type,
      amount: type ? Math.max(1, Math.min(9999, Math.round(n(this._ui.grant, DEFAULT_AMMO.amount)))) : 0,
    };
  }

  _buildPaletteGrid() {
    const grid = this._ui.paletteGrid;
    for (let i = 0; i < ITEM_PALETTE.length; i++) {
      const { name, color } = ITEM_PALETTE[i];
      const btn = this.doc.createElement('button');
      btn.className = 'ie-color-swatch';
      btn.title = `${i + 1} — ${name}`;
      const c = this.doc.createElement('canvas');
      c.width = 28;
      c.height = 28;
      this._fillSwatch(c, color);
      btn.appendChild(c);
      btn.addEventListener('click', () => {
        this._selectColor(i);
        this._closeModals();
      });
      grid.appendChild(btn);
    }
  }

  _fillSwatch(canvas, rgb) {
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  _openModal(modal) {
    this._closeModals();
    modal.classList.add('open');
  }

  _togglePalette() {
    if (this._ui.paletteModal.classList.contains('open')) this._closeModals();
    else this._openModal(this._ui.paletteModal);
  }

  _closeModals() {
    this.doc.querySelector('#ep-palette-modal')?.classList.remove('open');
  }

  _modalOpen() {
    return this._ui.paletteModal.classList.contains('open');
  }

  _renderUI() {
    const ui = this._ui;
    if (!ui) return;
    const w = this.item.weapon ?? DEFAULT_WEAPON;
    const isAmmo = this.item.kind === 'ammo';
    ui.title.textContent = isAmmo ? 'Ammo Item' : 'Weapon Item';
    ui.name.value = this.item.name;
    ui.catWeapon.classList.toggle('active', !isAmmo);
    ui.catAmmo.classList.toggle('active', isAmmo);
    ui.weaponFields.classList.toggle('hidden', isAmmo);
    ui.ammoFields.classList.toggle('hidden', !isAmmo);
    // Ammo pack: the type it grants + how many rounds per pickup.
    const typeChoices = listAmmoTypes();
    const typeSelect = ui.ammoType;
    if (
      typeSelect.options.length !== typeChoices.length + 1 ||
      [...typeSelect.options].some((o, i) => i > 0 && o.value !== typeChoices[i - 1].id)
    ) {
      typeSelect.innerHTML = '';
      const none = document.createElement('option');
      none.value = '';
      none.textContent = 'None';
      typeSelect.appendChild(none);
      for (const { id, name } of typeChoices) {
        const o = document.createElement('option');
        o.value = id;
        o.textContent = name;
        typeSelect.appendChild(o);
      }
    }
    const ammoPack = this.item.ammo ?? DEFAULT_AMMO;
    typeSelect.value = typeChoices.some((c) => c.id === ammoPack.type) ? ammoPack.type : '';
    ui.grant.value = String(ammoPack.amount ?? 0);
    ui.grant.disabled = !ammoPack.type;
    ui.gripLabel.textContent = this.item.grip ? `${this.item.grip.x},${this.item.grip.y},${this.item.grip.z}` : 'unset';
    ui.yawLabel.textContent = yawLabel(this.item.yaw);
    ui.damage.value = String(this.item.stats.damage);
    ui.reach.value = String(this.item.stats.reach);
    ui.cooldown.value = String(this.item.stats.cooldown);
    ui.gripBtn.classList.toggle('active', this.gripMode);
    ui.muzzleBtn.classList.toggle('active', this.muzzleMode);
    ui.kindMelee.classList.toggle('active', w.kind === 'melee');
    ui.kindRanged.classList.toggle('active', w.kind === 'ranged');
    ui.handsOne.classList.toggle('active', w.hands !== 'two');
    ui.handsTwo.classList.toggle('active', w.hands === 'two');
    ui.muzzleBtn.style.opacity = w.kind === 'ranged' ? '' : '0.45';
    ui.magazineRow.classList.toggle('hidden-row', w.kind !== 'ranged');
    ui.magazine.value = String(w.magazine ?? 0);
    ui.ammoRow.classList.toggle('hidden-row', w.kind !== 'ranged');
    ui.ammo.value = w.ammo ?? '';
    ui.reloadRow.classList.toggle('hidden-row', w.kind !== 'ranged');
    ui.reload.value = String(w.reload ?? 1.4);
    // Rebuild the ammo dropdown (None + every built-in/custom ammo type).
    const ammoChoices = listAmmoTypes();
    const ammoSelect = ui.ammo;
    if (
      ammoSelect.options.length !== ammoChoices.length + 1 ||
      [...ammoSelect.options].some((o, i) => i > 0 && o.value !== ammoChoices[i - 1].id)
    ) {
      ammoSelect.innerHTML = '';
      const none = document.createElement('option');
      none.value = '';
      none.textContent = 'None';
      ammoSelect.appendChild(none);
      for (const { id, name } of ammoChoices) {
        const o = document.createElement('option');
        o.value = id;
        o.textContent = name;
        ammoSelect.appendChild(o);
      }
    }
    ammoSelect.value = ammoChoices.some((c) => c.id === w.ammo) ? w.ammo : '';
    // Rebuild the anim options for the current kind, keeping the selection.
    const opts = ATTACK_ANIMS[w.kind] ?? [];
    if (ui.anim.options.length !== opts.length || [...ui.anim.options].some((o, i) => o.value !== opts[i])) {
      ui.anim.innerHTML = '';
      for (const name of opts) {
        const o = document.createElement('option');
        o.value = name;
        o.textContent = name[0].toUpperCase() + name.slice(1);
        ui.anim.appendChild(o);
      }
    }
    ui.anim.value = ATTACK_ANIMS[w.kind].includes(w.anim) ? w.anim : opts[0];
    this._fillSwatch(ui.color, this.color);
    const pal = ITEM_PALETTE[this.colorIndex];
    ui.colorName.textContent = pal && pal.color.every((c, i) => c === this.color[i]) ? pal.name : `#${rgbToHex(this.color).toString(16).padStart(6, '0')}`;
    ui.count.textContent = String(this.item.microVoxels.length);
  }
}
