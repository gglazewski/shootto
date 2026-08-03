// ItemEditor.js — the F2 micro-voxel object editor.
//
// Switches the app into 'item' mode: an orbit camera looks at an 8^3 micro-voxel
// grid floating above a clean, gridded floor with the centre axes marked. The
// editor renders into its own dedicated scene (solid background, no day/night
// cycle, no world terrain). The user paints colored micro-voxels (LMB), erases
// them (RMB), picks a color (MMB / palette), toggles the item's world size
// (B), marks it blocking or traversable (Collision buttons) and configures an
// optional light source (color + strength in meters, L).
//
// Interactions:
//   LMB drag  rotate orbit   ·  MMB drag  pan   ·  wheel  zoom
//   LMB click place voxel    ·  RMB click erase ·  MMB click  pick color
//   1-0 / E   select palette color   ·  L  light settings
//   Ctrl+S    save item (file + registry)  ·  Ctrl+Z / Ctrl+Shift+Z  undo/redo
//   F2 / Esc  back to the world editor
//
// The editor is DOM-heavy by design (it is the only part of the game that is
// a true model editor); all the pure item math lives in engine/ItemTypes.js.

import {
  MICRO_GRID,
  ITEM_PALETTE,
  LIGHT_COLORS,
  emptyItem,
  microCellSizeFor,
  deserializeItem,
  slugifyName,
} from '../../engine/ItemTypes.js';
import { isItemId } from '../../engine/ItemRegistry.js';
import { createItemGeometry } from '../ItemGeometry.three.js';
import { raycastVoxel } from '../../engine/VoxelRaycaster.js';
import { Notice } from '../Notice.js';

const GRID = MICRO_GRID;
/** Background of the dedicated item-editor scene (clean, no sky). */
const BG_COLOR = 0x1a1e26;
const PITCH_LIMIT = Math.PI / 2 - 0.05;

const rgbToHex = (c) => ((Math.round(c[0]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[2])) >>> 0;

export class ItemEditor {
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

    this.item = emptyItem();
    this.color = [...ITEM_PALETTE[0].color];
    this.colorIndex = 0;
    this.lightOn = false;
    this.lightColor = [...LIGHT_COLORS[0].color];
    this.lightStrength = 3;

    this.isOpen = false;
    this.onClose = null;   // () => void
    this.onSave = null;    // (item: ItemDef) => void
    this.onOpenCatalogue = null; // () => void

    // orbit camera state
    this.origin = new THREE.Vector3(0, 0, 0);
    this.target = this.origin.clone();
    this.dist = 7;
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
      new T.MeshBasicMaterial({ color: 0x33ff66, transparent: true, opacity: 0.45, depthWrite: false }),
    );
    this.ghost.visible = false;
    this.group.add(this.ghost);

    this.bulb = new T.Mesh(
      new T.SphereGeometry(1, 12, 12),
      new T.MeshBasicMaterial({ color: 0xffffff }),
    );
    this.bulb.visible = false;
    this.group.add(this.bulb);

    this.bulbLight = new T.PointLight(0xffffff, 2, 3);
    this.group.add(this.bulbLight);
  }

  /** Gridded floor on the BOTTOM face of the build canvas, plus marked centre
   *  axes. The grid is subdivided to match the 8×8 micro-voxel columns and is
   *  scaled/positioned to the canvas footprint in _positionFloor(), so the
   *  bottom of the canvas is always gridded regardless of item size. Short
   *  coloured axis stubs (red = +X, blue = +Z) and a green vertical axis line
   *  mark the world axes so the item can be aligned to them. */
  _buildFloor() {
    const T = this.THREE;
    // 1-unit grid; scaled to the canvas footprint in _positionFloor().
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
    // Local coords: the group is moved to the bottom of the canvas.
    this.axisX = axisLine(new T.Vector3(0, 0, 0), new T.Vector3(1, 0, 0), 0xff5555);
    arrow(new T.Vector3(1, 0, 0), 'x', 0xff5555);
    this.axisZ = axisLine(new T.Vector3(0, 0, 0), new T.Vector3(0, 0, 1), 0x5588ff);
    arrow(new T.Vector3(0, 0, 1), 'z', 0x5588ff);
    this.axisY = axisLine(new T.Vector3(0, 0, 0), new T.Vector3(0, 1.6, 0), 0x66d966);
    arrow(new T.Vector3(0, 1.6, 0), 'y', 0x66d966);
  }

  /** Move the floor grid + axes to the bottom face of the build canvas and
   *  scale the grid to the canvas footprint. Called whenever the item size
   *  changes (via _rebuild). */
  _positionFloor() {
    const c = microCellSizeFor(this.item.size);
    const ws = GRID * c;
    const floorY = -ws / 2;
    this.floorGrid.scale.setScalar(ws);
    this.floorGrid.position.y = floorY;
    this.axesGroup.position.y = floorY;
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
      // RMB is always "erase", like the world editor's remove.
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
      if (button === 0) this._place();
      else if (button === 1) this._pickColor();
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
    // (digits select colors, B/E/L are editor actions, Esc exits the mode).
    const t = event?.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    if (code === 'Escape') {
      // F2 is routed by the App (item.toggle binding) so it can't double-fire;
      // Escape only exists here, so it exits directly.
      this._closeModals();
      if (!this._modalOpen()) this.onClose?.();
      return;
    }
    if (code === 'KeyB') {
      this._toggleSize();
      return;
    }
    if (code === 'KeyE') {
      this._togglePalette();
      return;
    }
    if (code === 'KeyL') {
      this._toggleLightModal();
      return;
    }
    if (/^Digit[0-9]$/.test(code)) {
      // 1-9 / 0 select the first ten palette colors (matching the swatch titles).
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

  _worldToMicro(p) {
    const c = microCellSizeFor(this.item.size);
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

  /** Cells the aim ray passes through inside the 8^3 build grid, ordered from
   *  the near face to the far face. Empty when the ray misses the grid.
   *  The grid walls are NOT solid — the ray walks straight through the whole
   *  volume, so interior cells are reachable. */
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
    const c = microCellSizeFor(this.item.size);
    this.ghost.scale.set(c, c, c);
    this.ghost.position.set(
      this.origin.x + (cell[0] + 0.5 - GRID / 2) * c,
      this.origin.y + (cell[1] + 0.5 - GRID / 2) * c,
      this.origin.z + (cell[2] + 0.5 - GRID / 2) * c,
    );
    this.ghost.material.color.setHex(this._ghostBlocked ? 0xff5533 : 0x33ff66);
  }

  // --- item model updates ---

  _toggleSize() {
    this._pushSnapshot();
    this.item.size = this.item.size === 'small' ? 'big' : 'small';
    this._rebuild();
  }

  _selectColor(idx) {
    this.color = [...ITEM_PALETTE[idx].color];
    this.colorIndex = idx;
    this._renderUI();
  }

  _rebuild() {
    const c = microCellSizeFor(this.item.size);
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
    this._syncLight();
    this._renderUI();
  }

  _syncLight() {
    const light = this._currentLight();
    this.item.light = light;
    if (!light) {
      this.bulb.visible = false;
      this.bulbLight.visible = false;
      return;
    }
    const c = microCellSizeFor(this.item.size);
    this.bulb.position.set(
      this.origin.x + (light.x + 0.5 - GRID / 2) * c,
      this.origin.y + (light.y + 0.5 - GRID / 2) * c,
      this.origin.z + (light.z + 0.5 - GRID / 2) * c,
    );
    this.bulb.scale.setScalar(c * 0.8);
    this.bulb.material.color.setHex(rgbToHex(light.color));
    this.bulb.visible = true;
    this.bulbLight.color.setHex(rgbToHex(light.color));
    this.bulbLight.distance = light.strength;
    this.bulbLight.visible = true;
  }

  /** The item's light source (bulb at the bounding-box centre of the placed
   *  micro-voxels), or null when the light is off. */
  _currentLight() {
    if (!this.lightOn) return null;
    const vox = this.item.microVoxels;
    let cx;
    let cy;
    let cz;
    if (vox.length) {
      const xs = vox.map((v) => v.x);
      const ys = vox.map((v) => v.y);
      const zs = vox.map((v) => v.z);
      cx = Math.floor((Math.min(...xs) + Math.max(...xs)) / 2);
      cy = Math.floor((Math.min(...ys) + Math.max(...ys)) / 2);
      cz = Math.floor((Math.min(...zs) + Math.max(...zs)) / 2);
    } else {
      cx = cy = cz = Math.floor(GRID / 2);
    }
    return { x: cx, y: cy, z: cz, color: [...this.lightColor], strength: this.lightStrength };
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
      size: this.item.size,
      solid: this.item.solid !== false,
      light: this.item.light,
      lightOn: this.lightOn,
      lightColor: this.lightColor,
      lightStrength: this.lightStrength,
    }));
  }

  _restore(s) {
    this.item.microVoxels = s.microVoxels;
    this.item.size = s.size;
    this.item.solid = s.solid;
    this.item.light = s.light;
    this.lightOn = s.lightOn;
    this.lightColor = s.lightColor;
    this.lightStrength = s.lightStrength;
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
    this._ensureId();
    this.onSave?.(JSON.parse(JSON.stringify(this.item)));
  }

  _ensureId() {
    if (this.item.id) return;
    const base = slugifyName(this.item.name);
    let id = base;
    let n = 2;
    while (isItemId(id)) id = `${base}_${n++}`;
    this.item.id = id;
  }

  /** Load a registered item into the editor for further editing. */
  loadItem(item) {
    this.item = JSON.parse(JSON.stringify(item));
    this.lightOn = !!item.light;
    if (item.light) {
      this.lightColor = [...item.light.color];
      this.lightStrength = item.light.strength;
    }
    this._undoStack.length = 0;
    this._redoStack.length = 0;
    this._rebuild();
  }

  /** Start over with a blank item. The current one stays on the undo stack so
   *  Ctrl+Z can bring it back. */
  newItem() {
    this._pushSnapshot();
    this.item = emptyItem();
    this.lightOn = false;
    this.lightColor = [...LIGHT_COLORS[0].color];
    this.lightStrength = 3;
    this._rebuild();
    Notice.info('New item — start painting', 900);
  }

  loadText(text) {
    const { item, errors } = deserializeItem(text);
    if (!item) {
      Notice.warn(errors[0] ?? 'Failed to load item');
      return;
    }
    this.loadItem(item);
    Notice.info(`Loaded item "${item.name}"`);
  }

  // --- UI ---

  _wireUI() {
    const $ = (s) => this.doc.querySelector(s);
    const ui = {
      name: $('#ie-name'),
      sizeSmall: $('#ie-size-small'),
      sizeBig: $('#ie-size-big'),
      solidBlocking: $('#ie-solid-blocking'),
      solidTraversable: $('#ie-solid-traversable'),
      color: $('#ie-color'),
      colorName: $('#ie-color-name'),
      lightLabel: $('#ie-light-label'),
      count: $('#ie-count'),
      paletteBtn: $('#ie-palette'),
      paletteModal: $('#ie-palette-modal'),
      paletteGrid: $('#ie-palette-grid'),
      paletteClose: $('#ie-palette-close'),
      lightBtn: $('#ie-light'),
      lightModal: $('#ie-light-modal'),
      lightOn: $('#ie-light-on'),
      lightColors: $('#ie-light-colors'),
      lightStrength: $('#ie-light-strength'),
      lightStrengthVal: $('#ie-light-strength-val'),
      lightClose: $('#ie-light-close'),
      undo: $('#ie-undo'),
      newBtn: $('#ie-new'),
      load: $('#ie-load'),
      save: $('#ie-save'),
      back: $('#ie-back'),
      catalogue: $('#ie-catalogue'),
      file: $('#file-item-load'),
    };
    this._ui = ui;

    ui.name.addEventListener('change', () => {
      this.item.name = ui.name.value.trim() || 'Item';
      this._renderUI();
    });
    ui.sizeSmall.addEventListener('click', () => this._setSize('small'));
    ui.sizeBig.addEventListener('click', () => this._setSize('big'));
    ui.solidBlocking.addEventListener('click', () => this._setSolid(true));
    ui.solidTraversable.addEventListener('click', () => this._setSolid(false));

    ui.paletteBtn.addEventListener('click', () => this._openModal(ui.paletteModal));
    ui.paletteClose.addEventListener('click', () => this._closeModals());
    ui.paletteModal.addEventListener('click', (e) => {
      if (e.target === ui.paletteModal) this._closeModals();
    });
    this._buildPaletteGrid();

    ui.lightBtn.addEventListener('click', () => this._openLightModal());
    ui.lightClose.addEventListener('click', () => this._closeModals());
    ui.lightModal.addEventListener('click', (e) => {
      if (e.target === ui.lightModal) this._closeModals();
    });
    ui.lightOn.addEventListener('change', () => {
      this._pushSnapshot();
      this.lightOn = ui.lightOn.checked;
      this._rebuild();
    });
    ui.lightStrength.addEventListener('change', () => {
      this._pushSnapshot();
      this.lightStrength = Number(ui.lightStrength.value);
      this._rebuild();
    });
    this._buildLightColors();

    ui.undo.addEventListener('click', () => this.undo());
    ui.newBtn.addEventListener('click', () => this.newItem());
    ui.load.addEventListener('click', () => ui.file.click());
    ui.file.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        this.loadText(String(reader.result));
        e.target.value = '';
      };
      reader.readAsText(file);
    });
    ui.save.addEventListener('click', () => this.save());
    ui.back.addEventListener('click', () => this.onClose?.());
    ui.catalogue.addEventListener('click', () => this.onOpenCatalogue?.());

    this._renderUI();
  }

  _setSize(size) {
    if (this.item.size === size) return;
    this._pushSnapshot();
    this.item.size = size;
    this._rebuild();
  }

  _setSolid(solid) {
    if ((this.item.solid !== false) === solid) return;
    this._pushSnapshot();
    this.item.solid = solid;
    this._renderUI();
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

  _buildLightColors() {
    const grid = this._ui.lightColors;
    for (const { name, color } of LIGHT_COLORS) {
      const btn = this.doc.createElement('button');
      btn.className = 'ie-color-swatch';
      btn.title = name;
      const c = this.doc.createElement('canvas');
      c.width = 28;
      c.height = 28;
      this._fillSwatch(c, color);
      btn.appendChild(c);
      btn.addEventListener('click', () => {
        this._pushSnapshot();
        this.lightColor = [...color];
        this._rebuild();
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

  _openLightModal() {
    this._ui.lightOn.checked = this.lightOn;
    this._ui.lightStrength.value = String(this.lightStrength);
    this._ui.lightStrengthVal.textContent = `${this.lightStrength.toFixed(1)} m`;
    this._openModal(this._ui.lightModal);
  }

  _closeModals() {
    for (const id of ['#ie-palette-modal', '#ie-light-modal']) {
      this.doc.querySelector(id)?.classList.remove('open');
    }
  }

  _modalOpen() {
    return (
      this._ui.paletteModal.classList.contains('open') ||
      this._ui.lightModal.classList.contains('open')
    );
  }

  _renderUI() {
    const ui = this._ui;
    if (!ui) return;
    ui.name.value = this.item.name;
    ui.sizeSmall.classList.toggle('active', this.item.size === 'small');
    ui.sizeBig.classList.toggle('active', this.item.size === 'big');
    ui.solidBlocking.classList.toggle('active', this.item.solid !== false);
    ui.solidTraversable.classList.toggle('active', this.item.solid === false);
    this._fillSwatch(ui.color, this.color);
    const pal = ITEM_PALETTE[this.colorIndex];
    ui.colorName.textContent = pal && pal.color.every((c, i) => c === this.color[i]) ? pal.name : `#${rgbToHex(this.color).toString(16).padStart(6, '0')}`;
    ui.lightLabel.textContent = this.lightOn ? `on · ${this.lightStrength.toFixed(1)} m` : 'off';
    ui.count.textContent = String(this.item.microVoxels.length);
    ui.lightStrengthVal.textContent = `${this.lightStrength.toFixed(1)} m`;
  }
}
