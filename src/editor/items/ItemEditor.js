// ItemEditor.js — the F2 micro-voxel object editor.
//
// Switches the app into 'item' mode: an orbit camera looks at the item's
// micro-voxel build volume (its footprint in 0.5 m cells × 8 micro-voxels per
// cell) floating above a clean, gridded floor with the centre axes marked.
// The shared painting/tools/camera/undo core lives in MicroVoxelEditor (tool
// strip, inline palette, box/mirror/fill, status bar); this class adds the
// placeable-object aspect: the item's footprint in cells (W×H×D steppers —
// e.g. 2×4×1 for a big closet), whether it blocks the player (Collision
// buttons) and an optional light source (color + strength in meters, L).
//
// Extra interactions on top of the shared core:
//   L  light settings  ·  F2 / Esc  back to the world editor

import {
  MICRO_SIZE,
  LIGHT_COLORS,
  emptyItem,
  cellsOf,
  gridOf,
  normalizeCells,
  deserializeItem,
  slugifyName,
} from '../../engine/ItemTypes.js';
import { isItemId } from '../../engine/ItemRegistry.js';
import { CELL_SIZE } from '../../engine/Space.js';
import { Notice } from '../Notice.js';
import { MicroVoxelEditor, rgbToHex } from './MicroVoxelEditor.js';
import { recenterForResize } from './microOps.js';

/** Background of the dedicated item-editor scene (clean, no sky). */
const BG_COLOR = 0x1a1e26;

export class ItemEditor extends MicroVoxelEditor {
  /**
   * @param {object} deps
   * @param {object} deps.THREE
   * @param {import('three').Camera} deps.camera
   * @param {Document} [deps.doc]
   */
  constructor({ THREE, camera, doc = document }) {
    super({
      THREE,
      camera,
      doc,
      bgColor: BG_COLOR,
      prefix: 'ie',
      modalIds: ['ie-light-modal'],
    });
  }

  // --- aspect hooks ---

  _emptyModel() { return emptyItem(); }

  _cellSize() { return MICRO_SIZE; }

  _gridDims() { return gridOf(this.item); }

  _initExtra() {
    this.lightOn = false;
    this.lightColor = [...LIGHT_COLORS[0].color];
    this.lightStrength = 3;
  }

  _buildExtraSceneObjects() {
    const T = this.THREE;
    this.bulb = new T.Mesh(
      new T.SphereGeometry(1, 12, 12),
      new T.MeshBasicMaterial({ color: 0xffffff }),
    );
    this.bulb.visible = false;
    this.group.add(this.bulb);

    this.bulbLight = new T.PointLight(0xffffff, 2, 3);
    this.group.add(this.bulbLight);
  }

  _afterRebuild() { this._syncLight(); }

  _snapshotExtra() {
    return {
      cells: [...cellsOf(this.item)],
      solid: this.item.solid !== false,
      light: this.item.light,
      lightOn: this.lightOn,
      lightColor: this.lightColor,
      lightStrength: this.lightStrength,
    };
  }

  _restoreExtra(s) {
    this.item.cells = s.cells;
    this.item.solid = s.solid;
    this.item.light = s.light;
    this.lightOn = s.lightOn;
    this.lightColor = s.lightColor;
    this.lightStrength = s.lightStrength;
  }

  _resetExtraState() {
    this.lightOn = false;
    this.lightColor = [...LIGHT_COLORS[0].color];
    this.lightStrength = 3;
  }

  _onEditorKey(code, event) {
    if (code === 'KeyL') {
      this._toggleLightModal();
      return true;
    }
    return false;
  }

  _idExists(id) { return isItemId(id); }

  _slugify(name) { return slugifyName(name); }

  // --- light ---

  _syncLight() {
    const light = this._currentLight();
    this.item.light = light;
    if (!light) {
      this.bulb.visible = false;
      this.bulbLight.visible = false;
      return;
    }
    const c = this._cellSize();
    const [wx, wy, wz] = this._cellCenterToWorld([light.x, light.y, light.z]);
    this.bulb.position.set(wx, wy, wz);
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
      const [gx, gy, gz] = this._gridDims();
      cx = Math.floor(gx / 2);
      cy = Math.floor(gy / 2);
      cz = Math.floor(gz / 2);
    }
    return { x: cx, y: cy, z: cz, color: [...this.lightColor], strength: this.lightStrength };
  }

  // --- item model updates ---

  /** Resize the footprint (cells [w, h, d]), keeping content centred in the
   *  new build volume. Refused when the placed voxels don't fit — nothing is
   *  ever silently dropped. */
  _setCells(cells) {
    const next = normalizeCells(cells);
    const cur = cellsOf(this.item);
    if (next[0] === cur[0] && next[1] === cur[1] && next[2] === cur[2]) return;
    const curGrid = this._gridDims();
    const nextGrid = gridOf({ cells: next });
    const moved = recenterForResize(this.item.microVoxels, curGrid, nextGrid);
    if (!moved) {
      Notice.warn(`Content doesn't fit ${next.join('×')} cells — erase voxels or pick a bigger footprint`);
      this._renderUI(); // snap the steppers back to the real dims
      return;
    }
    this._pushSnapshot();
    this.item.cells = next;
    this.item.microVoxels = moved;
    this._boxAnchor = null;
    this._rebuild();
    this._setView('iso'); // reframe the camera for the new volume
  }

  _setSolid(solid) {
    if ((this.item.solid !== false) === solid) return;
    this._pushSnapshot();
    this.item.solid = solid;
    this._renderUI();
  }

  // --- save / load ---

  /** Load a registered item into the editor for further editing. */
  loadItem(item) {
    this.item = JSON.parse(JSON.stringify(item));
    this.item.cells = cellsOf(this.item);
    this.lightOn = !!item.light;
    if (item.light) {
      this.lightColor = [...item.light.color];
      this.lightStrength = item.light.strength;
    }
    this._undoStack.length = 0;
    this._redoStack.length = 0;
    this._rebuild();
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

  _wireExtraUI($) {
    const ui = this._ui;
    Object.assign(ui, {
      cellsX: $('#ie-cells-x'),
      cellsY: $('#ie-cells-y'),
      cellsZ: $('#ie-cells-z'),
      cellsSize: $('#ie-cells-size'),
      solidBlocking: $('#ie-solid-blocking'),
      solidTraversable: $('#ie-solid-traversable'),
      lightLabel: $('#ie-light-label'),
      lightBtn: $('#ie-light'),
      lightModal: $('#ie-light-modal'),
      lightOn: $('#ie-light-on'),
      lightColors: $('#ie-light-colors'),
      lightStrength: $('#ie-light-strength'),
      lightStrengthVal: $('#ie-light-strength-val'),
      lightClose: $('#ie-light-close'),
      load: $('#ie-load'),
      file: $('#file-item-load'),
    });

    for (const [el, axis] of [[ui.cellsX, 0], [ui.cellsY, 1], [ui.cellsZ, 2]]) {
      el?.addEventListener('change', () => {
        const cells = [...cellsOf(this.item)];
        cells[axis] = Number(el.value);
        this._setCells(cells);
      });
    }
    ui.solidBlocking.addEventListener('click', () => this._setSolid(true));
    ui.solidTraversable.addEventListener('click', () => this._setSolid(false));

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
    // Live readout + track fill while dragging ('change' alone only fires on release).
    ui.lightStrength.addEventListener('input', () => this._paintStrength());
    this._buildLightColors();

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
  }

  /** Sync the strength slider's readout and painted track to its value. */
  _paintStrength() {
    const el = this._ui.lightStrength;
    if (!el) return;
    const v = Number(el.value);
    const min = Number(el.min) || 0;
    const max = Number(el.max) || 1;
    el.style?.setProperty?.('--fill', `${(((v - min) / (max - min)) * 100).toFixed(1)}%`);
    if (this._ui.lightStrengthVal) this._ui.lightStrengthVal.textContent = `${v.toFixed(1)} m`;
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

  _toggleLightModal() {
    if (this._ui.lightModal.classList.contains('open')) this._closeModals();
    else this._openLightModal();
  }

  _openLightModal() {
    this._ui.lightOn.checked = this.lightOn;
    this._ui.lightStrength.value = String(this.lightStrength);
    this._paintStrength();
    this._openModal(this._ui.lightModal);
  }

  _renderExtraUI() {
    const ui = this._ui;
    const cells = cellsOf(this.item);
    if (ui.cellsX && this.doc.activeElement !== ui.cellsX) ui.cellsX.value = String(cells[0]);
    if (ui.cellsY && this.doc.activeElement !== ui.cellsY) ui.cellsY.value = String(cells[1]);
    if (ui.cellsZ && this.doc.activeElement !== ui.cellsZ) ui.cellsZ.value = String(cells[2]);
    if (ui.cellsSize) {
      ui.cellsSize.textContent = cells.map((c) => (c * CELL_SIZE).toFixed(1).replace(/\.0$/, '')).join(' × ') + ' m';
    }
    ui.solidBlocking?.classList.toggle('active', this.item.solid !== false);
    ui.solidTraversable?.classList.toggle('active', this.item.solid === false);
    if (ui.lightLabel) ui.lightLabel.textContent = this.lightOn ? `on · ${this.lightStrength.toFixed(1)} m` : 'off';
    if (ui.lightStrength) ui.lightStrength.value = String(this.lightStrength);
    this._paintStrength();
  }
}
