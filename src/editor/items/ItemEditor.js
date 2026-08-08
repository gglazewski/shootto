// ItemEditor.js — the F2 micro-voxel object editor.
//
// Switches the app into 'item' mode: an orbit camera looks at an 8^3 micro-voxel
// grid floating above a clean, gridded floor with the centre axes marked. The
// shared painting/tools/camera/undo core lives in MicroVoxelEditor (tool strip,
// inline palette, box/mirror/fill, status bar); this class adds the
// placeable-object aspect: the item's world size (B), whether it blocks the
// player (Collision buttons) and an optional light source (color + strength
// in meters, L).
//
// Extra interactions on top of the shared core:
//   B  toggle world size (0.5 m / 1 m)  ·  L  light settings
//   F2 / Esc  back to the world editor

import {
  MICRO_GRID,
  LIGHT_COLORS,
  emptyItem,
  microCellSizeFor,
  deserializeItem,
  slugifyName,
} from '../../engine/ItemTypes.js';
import { isItemId } from '../../engine/ItemRegistry.js';
import { Notice } from '../Notice.js';
import { MicroVoxelEditor, rgbToHex } from './MicroVoxelEditor.js';

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

  _cellSize() { return microCellSizeFor(this.item.size); }

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
      size: this.item.size,
      solid: this.item.solid !== false,
      light: this.item.light,
      lightOn: this.lightOn,
      lightColor: this.lightColor,
      lightStrength: this.lightStrength,
    };
  }

  _restoreExtra(s) {
    this.item.size = s.size;
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
    if (code === 'KeyB') {
      this._toggleSize();
      return true;
    }
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
      cx = cy = cz = Math.floor(MICRO_GRID / 2);
    }
    return { x: cx, y: cy, z: cz, color: [...this.lightColor], strength: this.lightStrength };
  }

  // --- item model updates ---

  _toggleSize() {
    this._pushSnapshot();
    this.item.size = this.item.size === 'small' ? 'big' : 'small';
    this._rebuild();
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

  // --- save / load ---

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
      sizeSmall: $('#ie-size-small'),
      sizeBig: $('#ie-size-big'),
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

    ui.sizeSmall.addEventListener('click', () => this._setSize('small'));
    ui.sizeBig.addEventListener('click', () => this._setSize('big'));
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
    this._ui.lightStrengthVal.textContent = `${this.lightStrength.toFixed(1)} m`;
    this._openModal(this._ui.lightModal);
  }

  _renderExtraUI() {
    const ui = this._ui;
    ui.sizeSmall?.classList.toggle('active', this.item.size === 'small');
    ui.sizeBig?.classList.toggle('active', this.item.size === 'big');
    ui.solidBlocking?.classList.toggle('active', this.item.solid !== false);
    ui.solidTraversable?.classList.toggle('active', this.item.solid === false);
    if (ui.lightLabel) ui.lightLabel.textContent = this.lightOn ? `on · ${this.lightStrength.toFixed(1)} m` : 'off';
    if (ui.lightStrengthVal) ui.lightStrengthVal.textContent = `${this.lightStrength.toFixed(1)} m`;
  }
}
