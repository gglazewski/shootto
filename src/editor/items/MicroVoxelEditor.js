// MicroVoxelEditor.js — shared core of the F2 (placeable object) and F3
// (equippable item) editors.
//
// Owns everything the two editors have in common: the dedicated clean scene
// (solid background, floor grid, marked axes), the orbit camera, micro-voxel
// painting with the ghost cursor, the explicit tool strip, the inline palette
// with custom + recent colors, undo/redo, the status bar and the shared panel
// wiring. Subclasses add their aspect on top (size/collision/light for
// placeables, build volume/grip/muzzle/stats for equipment) through the hook
// methods listed near the constructor.
//
// The build volume is per-axis ([gx, gy, gz] cells, default 8^3) so long
// weapons (shotguns, spears, axes) can extend one axis; the cell size is a
// subclass decision and stays fixed while the volume changes.
//
// Shared interactions:
//   LMB drag        rotate orbit  ·  MMB drag  pan  ·  wheel  zoom
//   LMB click       apply the active tool  ·  RMB click  always erase
//   MMB click       pick the color under the cursor
//   Shift+LMB drag  paint stroke (erase stroke with the Erase tool)
//   Shift+RMB drag  erase stroke
//   P / E / V / F   Paint / Erase / Box / Fill tool (a tool's key re-selects Paint)
//   X               mirror painting off → X → Z → XZ
//   arrows          nudge the model in X/Z (Shift+↑/↓ = up/down)
//   1-0             select the first ten palette colors
//   Ctrl+S          save  ·  Ctrl+Z / Ctrl+Shift+Z  undo/redo
//   Esc             cancel box corner → back to Paint → close modal → exit

import { ITEM_PALETTE } from '../../engine/ItemTypes.js';
import { createItemGeometry } from '../ItemGeometry.three.js';
import { raycastVoxel } from '../../engine/VoxelRaycaster.js';
import { Notice } from '../Notice.js';
import { buildItemSwatch } from './itemSwatch.js';
import {
  cellKey,
  buildVoxelIndex,
  nextMirrorMode,
  mirrorCells,
  boxCells,
  floodRegion,
  translateVoxels,
} from './microOps.js';

const PITCH_LIMIT = Math.PI / 2 - 0.05;

const OK_GHOST_COLOR = 0x33ff66;
const BLOCKED_GHOST_COLOR = 0xff5533;
const ERASE_GHOST_COLOR = 0xff5533;
const ANCHOR_COLOR = 0xffcc44;

export const rgbToHex = (c) => ((Math.round(c[0]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[2])) >>> 0;

const MIRROR_LABELS = { '': 'off', x: 'X', z: 'Z', xz: 'XZ' };

/** Camera presets for the view buttons (yaw/pitch of the orbit). */
const VIEWS = {
  front: { yaw: 0, pitch: 0.12 },
  side: { yaw: Math.PI / 2, pitch: 0.12 },
  top: { yaw: 0, pitch: PITCH_LIMIT },
  iso: { yaw: 0.7, pitch: 0.35 },
};

/** Tool metadata: panel label, shortcut and the status-bar hint. */
const TOOL_INFO = {
  paint: { label: 'Paint', hint: 'LMB paints · RMB erases · MMB picks color · Shift+drag strokes' },
  erase: { label: 'Erase', hint: 'LMB erases · Shift+drag erases a stroke' },
  box: { label: 'Box', hint: 'Click two corners to fill a cuboid · RMB erases the box · Esc cancels' },
  fill: { label: 'Fill', hint: 'Click a voxel to recolor its connected region' },
  grip: { label: 'Grip', hint: 'Click a cell to set where the hand grips the item' },
  muzzle: { label: 'Muzzle', hint: 'Click a cell to set the barrel end (muzzle flash origin)' },
};

export class MicroVoxelEditor {
  /**
   * @param {object} deps
   * @param {object} deps.THREE
   * @param {import('three').Camera} deps.camera
   * @param {Document} [deps.doc]
   * @param {number} deps.bgColor    background of the dedicated scene
   * @param {string} deps.prefix     panel element id prefix ('ie' or 'ep')
   * @param {string[]} deps.modalIds modal element ids this editor can open
   *
   * Subclass hooks (override as needed):
   *   _emptyModel()            fresh item model
   *   _cellSize()              world size of one micro cell
   *   _gridDims()              build volume [gx, gy, gz] (default 8^3)
   *   _initExtra()             subclass state, runs before the UI is wired
   *   _buildExtraSceneObjects() subclass markers (grip handle, arrow, bulb…)
   *   _afterRebuild()          keep subclass markers in sync
   *   _snapshotExtra()/_restoreExtra(s) subclass undo state
   *   _wireExtraUI($)          subclass panel fields
   *   _renderExtraUI()         subclass panel refresh
   *   _onEditorKey(code, ev)   subclass shortcuts; return true when handled
   *   _toolIds()               extra tool names this editor offers
   *   _applyTool(tool)         handle a primary click for a subclass tool
   *   _ghostHex(occupied)      ghost color override
   *   _validateForSave()       error string, or null when the item can save
   *   _idExists(id)            id collision check for _ensureId
   *   _onEnter()/_onExit()     mode lifecycle extras
   */
  constructor({ THREE, camera, doc = document, bgColor, prefix, modalIds }) {
    this.THREE = THREE;
    this.camera = camera;
    this.doc = doc;
    this._prefix = prefix;
    this._modalIds = modalIds;

    // Dedicated clean scene: solid background, no day/night cycle, no world.
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(bgColor);

    this.item = this._emptyModel();
    this.color = [...ITEM_PALETTE[0].color];
    this.colorIndex = 0;
    this.recentColors = []; // last few custom (non-palette) colors

    this.isOpen = false;
    this.onClose = null;         // () => void
    this.onSave = null;          // (item) => void
    this.onOpenCatalogue = null; // () => void

    // orbit camera state
    this.origin = new THREE.Vector3(0, 0, 0);
    this.target = this.origin.clone();
    this.dist = 4;
    this.yaw = VIEWS.iso.yaw;
    this.pitch = VIEWS.iso.pitch;
    this._drag = null;
    this._pointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

    this._voxIndex = buildVoxelIndex(this.item.microVoxels);
    this.microWorld = { get: (x, y, z) => this._microAt(x, y, z) };
    this._ghostCell = null;
    this._ghostBlocked = false;
    this._undoStack = [];
    this._redoStack = [];

    // tools
    this.tool = 'paint';
    this.mirrorMode = '';     // '' | 'x' | 'z' | 'xz'
    this._boxAnchor = null;   // first corner of the pending box
    this._stroke = null;      // active shift-drag paint/erase stroke
    this._floorKey = '';      // cached floor-grid geometry key

    this._initExtra();
    this._buildSceneObjects();
    this._buildExtraSceneObjects();
    this._buildFloor();
    this._wireUI();
  }

  /** Back-compat: box mode is now just the box tool being active. */
  get boxMode() { return this.tool === 'box'; }

  // --- subclass hooks (defaults) ---

  _initExtra() {}
  _buildExtraSceneObjects() {}
  _afterRebuild() {}
  _snapshotExtra() { return {}; }
  _restoreExtra(s) {}
  _wireExtraUI($) {}
  _renderExtraUI() {}
  _onEditorKey(code, event) { return false; }
  _toolIds() { return []; }
  _applyTool(tool) { return false; }
  _ghostHex(occupied) {
    if (this.tool === 'erase') return ERASE_GHOST_COLOR;
    return occupied ? BLOCKED_GHOST_COLOR : OK_GHOST_COLOR;
  }
  _validateForSave() { return null; }
  _idExists(id) { return false; }
  _onEnter() {}
  _onExit() {}
  _gridDims() { return [8, 8, 8]; }

  /** Build volume in world units: [wx, wy, wz]. */
  _worldSize() {
    const c = this._cellSize();
    return this._gridDims().map((g) => g * c);
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

    // First corner of a pending box fill.
    this.anchorMarker = new T.Mesh(
      new T.BoxGeometry(1, 1, 1),
      new T.MeshBasicMaterial({ color: ANCHOR_COLOR, transparent: true, opacity: 0.45, depthWrite: false }),
    );
    this.anchorMarker.visible = false;
    this.group.add(this.anchorMarker);
  }

  /** Marked centre axes plus a rectangular floor grid on the BOTTOM face of
   *  the build volume. The grid is rebuilt to match the volume's footprint
   *  (per-axis cell counts) in _positionFloor(). Short coloured axis stubs
   *  (red = +X, blue = +Z) and a green vertical axis line mark the world axes
   *  so the item can be aligned to them. */
  _buildFloor() {
    const T = this.THREE;
    this.floorGrid = null; // built lazily in _positionFloor (needs dims)

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

  /** (Re)build the rectangular floor grid for the current volume footprint and
   *  move it (plus the axes) to the bottom face. Cached per footprint. */
  _positionFloor() {
    const T = this.THREE;
    const c = this._cellSize();
    const [gx, , gz] = this._gridDims();
    const [wx, wy, wz] = this._worldSize();
    const floorY = -wy / 2;

    const key = `${gx}|${gz}|${c}`;
    if (key !== this._floorKey) {
      this._floorKey = key;
      if (this.floorGrid) {
        this.scene.remove(this.floorGrid);
        this.floorGrid.geometry.dispose();
      }
      // One line per cell boundary along both footprint axes.
      const pts = [];
      for (let i = 0; i <= gx; i++) {
        const x = i * c - wx / 2;
        pts.push(new T.Vector3(x, 0, -wz / 2), new T.Vector3(x, 0, wz / 2));
      }
      for (let k = 0; k <= gz; k++) {
        const z = k * c - wz / 2;
        pts.push(new T.Vector3(-wx / 2, 0, z), new T.Vector3(wx / 2, 0, z));
      }
      this.floorGrid = new T.LineSegments(
        new T.BufferGeometry().setFromPoints(pts),
        new T.LineBasicMaterial({ color: 0x2c3442, transparent: true, opacity: 0.9 }),
      );
      this.scene.add(this.floorGrid);
    }
    this.floorGrid.position.y = floorY;
    this.axesGroup.position.y = floorY;
  }

  // --- mode lifecycle ---

  enter() {
    this.isOpen = true;
    this.group.visible = true;
    this._drag = null;
    this._stroke = null;
    this._boxAnchor = null;
    this.tool = 'paint';
    this._setView('iso');
    this._rebuild();
    this._applyCamera();
    this._closeModals();
    this._onEnter();
  }

  exit() {
    this.isOpen = false;
    this.group.visible = false;
    this._stroke = null;
    this._boxAnchor = null;
    this.tool = 'paint';
    this._closeModals();
    this._onExit();
  }

  // --- per-frame update ---

  update(dt) {
    if (!this.isOpen) return;
    this._applyCamera();
    this._updateGhost();
  }

  _applyCamera() {
    const ep = Math.cos(this.pitch);
    this.camera.position.set(
      this.target.x + this.dist * ep * Math.sin(this.yaw),
      this.target.y + this.dist * Math.sin(this.pitch),
      this.target.z + this.dist * ep * Math.cos(this.yaw),
    );
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld(true);
  }

  /** Orbit distance that frames the whole build volume. */
  _frameDist() {
    const maxDim = Math.max(...this._gridDims());
    return Math.max(4, Math.min(14, 4 * (maxDim / 8)));
  }

  _setView(name) {
    const v = VIEWS[name];
    if (!v) return;
    this.yaw = v.yaw;
    this.pitch = v.pitch;
    this.target.copy(this.origin);
    this.dist = this._frameDist();
  }

  // --- input (called by App) ---

  onMouseDown({ button, x, y, shiftKey }) {
    if (!this.isOpen || this._modalOpen()) return;
    this._pointer.x = x;
    this._pointer.y = y;
    if (button === 2) {
      if (this.tool === 'box' && this._boxAnchor) {
        this._boxErase();
        return;
      }
      if (shiftKey) {
        // Shift+RMB drag: erase every voxel the stroke crosses.
        this._stroke = { mode: 'erase', started: false };
        this._strokeErase();
        return;
      }
      // RMB is always "erase", like the world editor's remove.
      this._remove();
      this._drag = null;
      return;
    }
    if (button === 0 && shiftKey && (this.tool === 'paint' || this.tool === 'erase')) {
      // Shift+LMB drag: a stroke of the active tool.
      this._stroke = { mode: this.tool === 'erase' ? 'erase' : 'place', started: false };
      this._updateGhost();
      if (this._stroke.mode === 'place') this._strokePlace();
      else this._strokeErase();
      return;
    }
    this._drag = { button, startX: x, startY: y, moved: 0 };
  }

  onMouseUp({ button, x, y }) {
    if (!this.isOpen) return;
    this._stroke = null;
    const d = this._drag;
    this._drag = null;
    if (!d || d.button !== button) return;
    this._pointer.x = x;
    this._pointer.y = y;
    if (d.moved < 6) {
      if (button === 0) this._primaryClick();
      else if (button === 1) this._pickColor();
    }
  }

  onMouseMove({ dx, dy, x, y }) {
    if (!this.isOpen) return;
    this._pointer.x = x;
    this._pointer.y = y;
    if (this._stroke) {
      this._updateGhost();
      if (this._stroke.mode === 'place') this._strokePlace();
      else this._strokeErase();
      return;
    }
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
    // (digits select colors, letters are editor actions, Esc exits the mode).
    const t = event?.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (code === 'Escape') {
      // F2/F3 are routed by the App (toggle bindings) so they can't
      // double-fire; Escape only exists here. It peels back one layer:
      // pending box corner → non-default tool → open modal → the editor.
      if (this._boxAnchor) {
        this._boxAnchor = null;
        this._renderUI();
        return;
      }
      if (this.tool !== 'paint') {
        this.setTool('paint');
        return;
      }
      this._closeModals();
      if (!this._modalOpen()) this.onClose?.();
      return;
    }
    if (this._onEditorKey(code, event)) return;
    if (code === 'KeyP') {
      this.setTool('paint');
      return;
    }
    if (code === 'KeyE') {
      this.setTool('erase');
      return;
    }
    if (code === 'KeyV') {
      this.setTool('box');
      return;
    }
    if (code === 'KeyF') {
      this.setTool('fill');
      return;
    }
    if (code === 'KeyX') {
      this._cycleMirror();
      return;
    }
    if (code.startsWith('Arrow')) {
      event?.preventDefault?.();
      const d = {
        ArrowLeft: [-1, 0, 0],
        ArrowRight: [1, 0, 0],
        ArrowUp: event?.shiftKey ? [0, 1, 0] : [0, 0, -1],
        ArrowDown: event?.shiftKey ? [0, -1, 0] : [0, 0, 1],
      }[code];
      if (d) this._nudge(d);
      return;
    }
    if (/^Digit[0-9]$/.test(code)) {
      // 1-9 / 0 select the first ten palette colors (matching the swatch titles).
      this._selectColor((Number(code.slice(5)) - 1 + 10) % 10);
      return;
    }
    if ((code === 'KeyZ' || event.key?.toLowerCase() === 'z') && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (event.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if ((code === 'KeyS' || event.key?.toLowerCase() === 's') && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.save();
    }
  }

  _pan(dx, dy) {
    const T = this.THREE;
    const k = this.dist * 0.0016;
    const right = new T.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this.target.addScaledVector(right, -dx * k);
    this.target.y += dy * k;
  }

  // --- tools ---

  /** Select a tool; selecting the active tool returns to Paint. */
  setTool(tool) {
    const next = this.tool === tool ? 'paint' : tool;
    if (next === this.tool) return;
    this.tool = next;
    if (next !== 'box') this._boxAnchor = null;
    this._renderUI();
    Notice.info(`${TOOL_INFO[next].label}: ${TOOL_INFO[next].hint}`, 1400);
  }

  _primaryClick() {
    switch (this.tool) {
      case 'paint':
        this._place();
        return;
      case 'erase':
        this._remove();
        return;
      case 'box':
        this._boxClick();
        return;
      case 'fill':
        this._fillRegion();
        return;
      default:
        this._applyTool(this.tool);
    }
  }

  // --- micro-voxel painting ---

  _microAt(x, y, z) {
    return this._voxIndex.get(cellKey(x, y, z)) ?? null;
  }

  _cellCenterToWorld(cell) {
    const c = this._cellSize();
    const [gx, gy, gz] = this._gridDims();
    return [
      this.origin.x + (cell[0] + 0.5 - gx / 2) * c,
      this.origin.y + (cell[1] + 0.5 - gy / 2) * c,
      this.origin.z + (cell[2] + 0.5 - gz / 2) * c,
    ];
  }

  _worldToMicro(p) {
    const c = this._cellSize();
    const [gx, gy, gz] = this._gridDims();
    return [
      (p[0] - this.origin.x) / c + gx / 2,
      (p[1] - this.origin.y) / c + gy / 2,
      (p[2] - this.origin.z) / c + gz / 2,
    ];
  }

  _inGrid(x, y, z) {
    const [gx, gy, gz] = this._gridDims();
    return x >= 0 && x < gx && y >= 0 && y < gy && z >= 0 && z < gz;
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
   *  near face to the far face. Empty when the ray misses the grid. The grid
   *  walls are NOT solid — the ray walks straight through the whole volume, so
   *  interior cells are reachable. */
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
    let tMaxX = dx !== 0 ? ((dx > 0 ? x + 1 - ox : ox - x) * tDeltaX) : Infinity;
    let tMaxY = dy !== 0 ? ((dy > 0 ? y + 1 - oy : oy - y) * tDeltaY) : Infinity;
    let tMaxZ = dz !== 0 ? ((dz > 0 ? z + 1 - oz : oz - z) * tDeltaZ) : Infinity;
    let t = 0;

    const cells = [];
    let wasInside = this._inGrid(x, y, z);
    for (let i = 0; i < 1024; i++) {
      if (this._inGrid(x, y, z)) {
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

  /** Target micro-cell under the cursor. The grid walls are ignored (the ray
   *  passes through the whole volume), but building is clamped to the grid so
   *  nothing can be placed outside.
   *
   *  When the aim hits a placed micro-voxel, the target sticks to the cell
   *  adjacent to the face you're looking at — like the world editor — so
   *  building onto the top or side of an existing voxel is easy (the ghost
   *  turns red when that cell is already filled). When the ray hits nothing
   *  (empty space), the target is the DEEPEST empty cell along the ray —
   *  scanning from the far/bottom wall inward — so a fresh grid is painted
   *  from the back, interior cells stay reachable, and if the whole path is
   *  filled the far/bottom wall cell remains as a fallback target. */
  _targetCellFromRay() {
    const hit = this._raycast();
    if (hit) {
      const x = hit.cell[0] + hit.normal[0];
      const y = hit.cell[1] + hit.normal[1];
      const z = hit.cell[2] + hit.normal[2];
      if (this._inGrid(x, y, z)) {
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

  /** Place the current color into every listed cell that is empty. Pushes one
   *  undo snapshot for the whole batch (unless told not to — strokes snapshot
   *  once at stroke start). Returns how many voxels were placed. */
  _placeCells(cells, { snapshot = true } = {}) {
    const empty = cells.filter(([x, y, z]) => !this._microAt(x, y, z));
    if (!empty.length) return 0;
    if (snapshot) this._pushSnapshot();
    for (const [x, y, z] of empty) {
      this.item.microVoxels.push({ x, y, z, color: [...this.color] });
    }
    this._rebuild();
    return empty.length;
  }

  /** Remove every listed cell that holds a voxel. Same snapshot contract as
   *  _placeCells. Returns how many voxels were removed. */
  _removeCells(cells, { snapshot = true } = {}) {
    const filled = cells.filter(([x, y, z]) => this._microAt(x, y, z));
    if (!filled.length) return 0;
    if (snapshot) this._pushSnapshot();
    const doomed = new Set(filled.map(([x, y, z]) => cellKey(x, y, z)));
    this.item.microVoxels = this.item.microVoxels.filter((v) => !doomed.has(cellKey(v.x, v.y, v.z)));
    this._rebuild();
    return filled.length;
  }

  _place() {
    const cell = this._ghostCell;
    if (!cell) return;
    if (this._ghostBlocked) {
      Notice.warn('Cannot place there');
      return;
    }
    this._placeCells(mirrorCells(cell, this.mirrorMode, this._gridDims()));
  }

  _remove() {
    const hit = this._raycast();
    if (!hit) return;
    if (!this._microAt(hit.cell[0], hit.cell[1], hit.cell[2])) return;
    this._removeCells(mirrorCells(hit.cell, this.mirrorMode, this._gridDims()));
  }

  // --- stroke painting (Shift+drag) ---

  _strokePlace() {
    const cell = this._ghostCell;
    if (!cell || this._ghostBlocked) return;
    const placed = this._placeCells(mirrorCells(cell, this.mirrorMode, this._gridDims()), {
      snapshot: !this._stroke.started,
    });
    if (placed) this._stroke.started = true;
  }

  _strokeErase() {
    const hit = this._raycast();
    if (!hit || !this._microAt(hit.cell[0], hit.cell[1], hit.cell[2])) return;
    const removed = this._removeCells(mirrorCells(hit.cell, this.mirrorMode, this._gridDims()), {
      snapshot: !this._stroke.started,
    });
    if (removed) this._stroke.started = true;
  }

  // --- box tool ---

  _boxClick() {
    const cell = this._ghostCell;
    if (!cell) return;
    if (!this._boxAnchor) {
      this._boxAnchor = [...cell];
      this._renderUI();
      return;
    }
    const cells = this._mirrored(boxCells(this._boxAnchor, cell));
    const placed = this._placeCells(cells);
    this._boxAnchor = null;
    this._renderUI();
    Notice.info(placed ? `Box: +${placed} voxels` : 'Box was already filled', 900);
  }

  _boxErase() {
    // RMB in box mode with a pending corner erases the box instead.
    const hit = this._raycast();
    const cell = hit ? hit.cell : this._ghostCell;
    if (!cell) return;
    const cells = this._mirrored(boxCells(this._boxAnchor, cell));
    const removed = this._removeCells(cells);
    this._boxAnchor = null;
    this._renderUI();
    Notice.info(removed ? `Box: -${removed} voxels` : 'Box was empty', 900);
  }

  _mirrored(cells) {
    if (!this.mirrorMode) return cells;
    const dims = this._gridDims();
    const out = [];
    const seen = new Set();
    for (const c of cells) {
      for (const m of mirrorCells(c, this.mirrorMode, dims)) {
        const k = cellKey(m[0], m[1], m[2]);
        if (!seen.has(k)) {
          seen.add(k);
          out.push(m);
        }
      }
    }
    return out;
  }

  // --- mirror / fill / nudge ---

  _cycleMirror() {
    this.mirrorMode = nextMirrorMode(this.mirrorMode);
    this._renderUI();
    Notice.info(`Mirror: ${MIRROR_LABELS[this.mirrorMode]}`, 800);
  }

  /** Recolor the connected same-color region under the cursor with the
   *  current color. */
  _fillRegion() {
    const hit = this._raycast();
    if (!hit) {
      Notice.warn('Aim at a voxel to fill its region');
      return;
    }
    const region = floodRegion(this.item.microVoxels, hit.cell);
    const stale = region.filter((v) => v.color.some((c, i) => c !== this.color[i]));
    if (!stale.length) return;
    this._pushSnapshot();
    for (const v of stale) v.color = [...this.color];
    this._rebuild();
    Notice.info(`Recolored ${stale.length} voxels`, 800);
  }

  /** Move the whole model one cell; refused (not clamped) at the walls. */
  _nudge(d) {
    if (!this.item.microVoxels.length) return;
    const moved = translateVoxels(this.item.microVoxels, d, this._gridDims());
    if (!moved) {
      Notice.warn('No room to move there', 700);
      return;
    }
    this._pushSnapshot();
    this.item.microVoxels = moved;
    this._translateExtras(d);
    this._rebuild();
  }

  /** Subclass hook: shift model-attached markers (grip, muzzle) with a nudge. */
  _translateExtras(d) {}

  _pickColor() {
    const hit = this._raycast();
    if (!hit) return;
    const v = this._microAt(hit.cell[0], hit.cell[1], hit.cell[2]);
    if (!v) return;
    const idx = ITEM_PALETTE.findIndex((p) => p.color.every((c, i) => c === v.color[i]));
    this.color = [...v.color];
    this.colorIndex = idx; // -1 = custom color
    if (idx < 0) this._rememberColor(v.color);
    this._renderUI();
    Notice.info('Color picked', 600);
  }

  _updateGhost() {
    const cell = this._targetCellFromRay();
    if (!cell) {
      this.ghost.visible = false;
      this._ghostCell = null;
      this._syncAnchorMarker();
      return;
    }
    const occupied = !!this._microAt(cell[0], cell[1], cell[2]);
    this._ghostCell = cell;
    this._ghostBlocked = occupied;
    this.ghost.visible = true;
    const c = this._cellSize();
    this.ghost.scale.set(c, c, c);
    const [wx, wy, wz] = this._cellCenterToWorld(cell);
    this.ghost.position.set(wx, wy, wz);
    this.ghost.material.color.setHex(this._ghostHex(occupied));
    this._syncAnchorMarker();
  }

  _syncAnchorMarker() {
    if (!this._boxAnchor) {
      this.anchorMarker.visible = false;
      return;
    }
    const c = this._cellSize();
    const [wx, wy, wz] = this._cellCenterToWorld(this._boxAnchor);
    this.anchorMarker.visible = true;
    this.anchorMarker.scale.set(c, c, c);
    this.anchorMarker.position.set(wx, wy, wz);
  }

  // --- colors ---

  _selectColor(idx) {
    if (idx < 0 || idx >= ITEM_PALETTE.length) return;
    this.color = [...ITEM_PALETTE[idx].color];
    this.colorIndex = idx;
    this._renderUI();
  }

  setCustomColor(rgb) {
    this.color = [...rgb];
    this.colorIndex = -1;
    this._rememberColor(rgb);
    this._renderUI();
  }

  /** Keep the last few custom colors for one-click reuse. */
  _rememberColor(rgb) {
    const hex = rgbToHex(rgb);
    this.recentColors = [
      [...rgb],
      ...this.recentColors.filter((c) => rgbToHex(c) !== hex),
    ].slice(0, 4);
  }

  _rebuild() {
    const c = this._cellSize();
    const [wx, wy, wz] = this._worldSize();
    this._voxIndex = buildVoxelIndex(this.item.microVoxels);
    const geo = createItemGeometry(this.THREE, this.item.microVoxels);
    this.itemMesh.geometry.dispose();
    this.itemMesh.geometry = geo;
    this.itemMesh.scale.setScalar(c);
    this.itemMesh.position.set(
      this.origin.x - wx / 2,
      this.origin.y - wy / 2,
      this.origin.z - wz / 2,
    );
    this.bounds.scale.set(wx, wy, wz);
    this.bounds.position.copy(this.origin);
    this._positionFloor();
    this._afterRebuild();
    this._renderUI();
    this._updateThumb();
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
      ...this._snapshotExtra(),
    }));
  }

  _restore(s) {
    this.item.microVoxels = s.microVoxels;
    this._restoreExtra(s);
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

  // --- save ---

  save() {
    if (!this.item.microVoxels.length) {
      Notice.warn('Item is empty — place some micro voxels first');
      return;
    }
    this.item.name = (this._ui.name?.value ?? this.item.name).trim() || 'Item';
    const err = this._validateForSave();
    if (err) {
      Notice.warn(err);
      return;
    }
    this._ensureId();
    this.onSave?.(JSON.parse(JSON.stringify(this.item)));
  }

  _ensureId() {
    if (this.item.id) return;
    const base = this._slugify(this.item.name);
    let id = base;
    let n = 2;
    while (this._idExists(id)) id = `${base}_${n++}`;
    this.item.id = id;
  }

  /** Subclasses point this at their registry's slugifier. */
  _slugify(name) { return name.toLowerCase().replace(/[^a-z0-9]+/g, '_'); }

  /** Start over with a blank item. The current one stays on the undo stack so
   *  Ctrl+Z can bring it back. */
  newItem() {
    this._pushSnapshot();
    this.item = this._emptyModel();
    this._resetExtraState();
    this._boxAnchor = null;
    this.tool = 'paint';
    this._rebuild();
    Notice.info('New item — start painting', 900);
  }

  /** Subclass hook: clear per-item editing state (light, grip mode, …). */
  _resetExtraState() {}

  // --- shared UI ---

  /** Wire the panel elements shared by both editors. Elements are looked up by
   *  the panel prefix; missing ones are skipped so the two panels can differ. */
  _wireUI() {
    const p = this._prefix;
    const $ = (s) => this.doc.querySelector(s);
    const el = (name) => $(`#${p}-${name}`);
    const ui = {
      name: el('name'),
      color: el('color'),
      colorName: el('color-name'),
      colorCustom: el('color-custom'),
      count: el('count'),
      paletteStrip: el('palette-strip'),
      recent: el('recent'),
      mirrorBtn: el('mirror'),
      views: el('views'),
      thumb: el('thumb'),
      status: el('status'),
      undo: el('undo'),
      newBtn: el('new'),
      save: el('save'),
      back: el('back'),
      catalogue: el('catalogue'),
    };
    // One button per tool this editor offers (#<p>-tool-<name>).
    ui.toolBtns = {};
    for (const tool of ['paint', 'erase', 'box', 'fill', ...this._toolIds()]) {
      const btn = el(`tool-${tool}`);
      if (!btn) continue;
      ui.toolBtns[tool] = btn;
      btn.addEventListener('click', () => this.setTool(tool));
    }
    this._ui = ui;

    // Live name sync: the model is always current, so Ctrl+S mid-typing and
    // the panel never disagree.
    ui.name?.addEventListener('input', () => {
      this.item.name = ui.name.value.trim() || 'Item';
    });

    this._buildPaletteStrip();

    ui.colorCustom?.addEventListener('input', () => {
      const hex = ui.colorCustom.value; // "#rrggbb"
      this.setCustomColor([
        parseInt(hex.slice(1, 3), 16),
        parseInt(hex.slice(3, 5), 16),
        parseInt(hex.slice(5, 7), 16),
      ]);
    });

    ui.mirrorBtn?.addEventListener('click', () => this._cycleMirror());
    ui.views?.querySelectorAll('button[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => this._setView(btn.dataset.view));
    });
    ui.undo?.addEventListener('click', () => this.undo());
    ui.newBtn?.addEventListener('click', () => this.newItem());
    ui.save?.addEventListener('click', () => this.save());
    ui.back?.addEventListener('click', () => this.onClose?.());
    ui.catalogue?.addEventListener('click', () => this.onOpenCatalogue?.());

    this._wireExtraUI($);
    this._renderUI();
  }

  /** The always-visible palette strip (replaces the old palette modal). */
  _buildPaletteStrip() {
    const strip = this._ui.paletteStrip;
    if (!strip) return;
    this._swatchEls = [];
    for (let i = 0; i < ITEM_PALETTE.length; i++) {
      const { name, color } = ITEM_PALETTE[i];
      const btn = this.doc.createElement('button');
      btn.className = 'ie-color-swatch';
      btn.title = i < 10 ? `${(i + 1) % 10} — ${name}` : name;
      const c = this.doc.createElement('canvas');
      c.width = 22;
      c.height = 22;
      this._fillSwatch(c, color);
      btn.appendChild(c);
      btn.addEventListener('click', () => this._selectColor(i));
      strip.appendChild(btn);
      this._swatchEls.push(btn);
    }
  }

  /** Re-render the recent (custom) colors row. */
  _renderRecent() {
    const box = this._ui.recent;
    if (!box) return;
    box.innerHTML = '';
    for (const color of this.recentColors) {
      const btn = this.doc.createElement('button');
      btn.className = 'ie-color-swatch';
      btn.title = `#${rgbToHex(color).toString(16).padStart(6, '0')}`;
      const c = this.doc.createElement('canvas');
      c.width = 22;
      c.height = 22;
      this._fillSwatch(c, color);
      btn.appendChild(c);
      btn.classList.toggle('selected', this.colorIndex === -1 && rgbToHex(color) === rgbToHex(this.color));
      btn.addEventListener('click', () => {
        this.color = [...color];
        this.colorIndex = -1;
        this._renderUI();
      });
      box.appendChild(btn);
    }
  }

  _fillSwatch(canvas, rgb) {
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  /** Redraw the live isometric preview thumbnail. */
  _updateThumb() {
    const canvas = this._ui?.thumb;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!this.item.microVoxels.length) return;
    ctx.drawImage(buildItemSwatch(this.item, canvas.width), 0, 0);
  }

  _openModal(modal) {
    this._closeModals();
    modal.classList.add('open');
  }

  _closeModals() {
    for (const id of this._modalIds) {
      this.doc.querySelector(`#${id}`)?.classList.remove('open');
    }
  }

  _modalOpen() {
    return this._modalIds.some((id) => this.doc.querySelector(`#${id}`)?.classList.contains('open'));
  }

  /** Status-bar line: active tool, mirror state and the tool's hint. */
  _statusText() {
    const info = TOOL_INFO[this.tool];
    const parts = [`${info.label}`];
    if (this.mirrorMode) parts.push(`Mirror ${MIRROR_LABELS[this.mirrorMode]}`);
    if (this.tool === 'box' && this._boxAnchor) {
      parts.push('click the opposite corner · RMB erases · Esc cancels');
    } else {
      parts.push(info.hint);
    }
    return parts.join(' · ');
  }

  _renderUI() {
    const ui = this._ui;
    if (!ui) return;
    if (ui.name && this.doc.activeElement !== ui.name) ui.name.value = this.item.name;
    if (ui.color) this._fillSwatch(ui.color, this.color);
    if (ui.colorName) {
      const pal = ITEM_PALETTE[this.colorIndex];
      ui.colorName.textContent = pal && pal.color.every((c, i) => c === this.color[i])
        ? pal.name
        : `#${rgbToHex(this.color).toString(16).padStart(6, '0')}`;
    }
    if (ui.count) ui.count.textContent = String(this.item.microVoxels.length);
    for (const [tool, btn] of Object.entries(ui.toolBtns ?? {})) {
      btn.classList.toggle('active', this.tool === tool);
    }
    if (this._swatchEls) {
      this._swatchEls.forEach((btn, i) => btn.classList.toggle('selected', i === this.colorIndex));
    }
    this._renderRecent();
    if (ui.mirrorBtn) {
      ui.mirrorBtn.classList.toggle('active', !!this.mirrorMode);
      ui.mirrorBtn.textContent = `Mirror: ${MIRROR_LABELS[this.mirrorMode]} (X)`;
    }
    if (ui.status) ui.status.textContent = this._statusText();
    this._renderExtraUI();
  }
}
