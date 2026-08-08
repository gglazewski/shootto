// EquipmentEditor.js — the F3 equippable-item editor.
//
// A sibling of the F2 placeable-object editor (ItemEditor) built on the same
// MicroVoxelEditor core (orbit camera, painting, palette, undo, box/mirror/
// fill tools), but for HOLDABLE items instead of world-placed objects. The
// Kind selector (Weapon / Ammo) picks what the item is: weapons expose grip /
// direction / stats / attack fields and are held and fought with; ammo items
// expose an ammo type + granted amount the player carries.
//
// Equipment-specific concepts on top of the shared core:
//   - grid:  the per-item build volume [gx, gy, gz] (cells, fixed 6.25 cm cell
//            size). Presets cover the common silhouettes (sidearm, long gun,
//            spear, axe); steppers allow any 4–32 cells per axis. Resizing
//            keeps the sculpture centred and refuses when it wouldn't fit.
//   - grip:  a highlighted voxel cell marking where the player's right hand
//            grips the item — the Grip R tool (G); a cyan "handle" cube shows
//            it. grip2 is the left-hand cell of a two-handed weapon — the
//            Grip L tool (H); a magenta cube shows it.
//   - muzzle: the barrel-end cell of a ranged weapon — the Muzzle tool (M).
//   - yaw:   the item's forward direction, drawn as a cyan arrow from the grip
//            cell. R / "Direction" rotates it 90° at a time. Default +Z.
//   - stats: damage / reach (m) / cooldown (s) — the attack profile the game
//            uses when the item is equipped.
//
// Extra interactions on top of the shared core:
//   G  right-grip tool  ·  H  left-grip tool  ·  M  muzzle tool  ·  R  rotate direction
//   F3 / Esc  back to the world editor

import { microCellSizeFor, slugifyName } from '../../engine/ItemTypes.js';
import {
  emptyEquipItem,
  deserializeEquipItem,
  isEquipId,
  DEFAULT_WEAPON,
  DEFAULT_AMMO,
  DEFAULT_EQUIP_GRID,
  EQUIP_GRID_PRESETS,
  MIN_EQUIP_GRID,
  MAX_EQUIP_GRID,
  normalizeGrid,
  ATTACK_ANIMS,
  RANGED_SPREAD,
} from '../../engine/EquipmentRegistry.js';
import { listAmmoTypes } from '../../engine/AmmoTypes.js';
import { Notice } from '../Notice.js';
import { MicroVoxelEditor } from './MicroVoxelEditor.js';
import { syncSelect, recenterForResize, resizeShift } from './microOps.js';

/** Background of the dedicated items-editor scene (clean, no sky). */
const BG_COLOR = 0x151921;

// Held items always preview on the small (0.5 m) footprint grid.
const PREVIEW_SIZE = 'small';

/** Grip marker + direction-arrow colour (distinct from the red/green/blue axes). */
const HANDLE_COLOR = 0x33eeff;
const HANDLE2_COLOR = 0xff66dd;
const MUZZLE_COLOR = 0xffcc44;
const GRIP_GHOST_COLOR = 0x33eeff;
const GRIP2_GHOST_COLOR = 0xff66dd;
const MUZZLE_GHOST_COLOR = 0xffcc44;
const OK_GHOST_COLOR = 0x33ff66;
const BLOCKED_GHOST_COLOR = 0xff5533;

/** Axis label for a yaw angle (0 = +Z, 90 = +X, ...). */
function yawLabel(deg) {
  const d = ((deg % 360) + 360) % 360;
  const axes = { 0: '+Z', 90: '+X', 180: '-Z', 270: '-X' };
  return `${axes[d] ?? `${d}°`} (${d}°)`;
}

export class EquipmentEditor extends MicroVoxelEditor {
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
      prefix: 'ep',
      modalIds: [],
    });
  }

  // --- aspect hooks ---

  _emptyModel() { return emptyEquipItem(); }

  _cellSize() { return microCellSizeFor(PREVIEW_SIZE); }

  _gridDims() { return this.item.grid ?? [...DEFAULT_EQUIP_GRID]; }

  /** Back-compat: grip/muzzle "modes" are now the matching tool being active. */
  get gripMode() { return this.tool === 'grip'; }
  get grip2Mode() { return this.tool === 'grip2'; }
  get muzzleMode() { return this.tool === 'muzzle'; }

  _toolIds() { return ['grip', 'grip2', 'muzzle']; }

  _applyTool(tool) {
    if (tool === 'grip') {
      this._setGrip();
      return true;
    }
    if (tool === 'grip2') {
      this._setGrip2();
      return true;
    }
    if (tool === 'muzzle') {
      this._setMuzzle();
      return true;
    }
    return false;
  }

  _buildExtraSceneObjects() {
    const T = this.THREE;

    // Grip handle: a cyan cube slightly larger than a micro voxel so it reads
    // as the "where the hand holds" marker.
    this.gripMarker = new T.Mesh(
      new T.BoxGeometry(1, 1, 1),
      new T.MeshBasicMaterial({ color: HANDLE_COLOR, transparent: true, opacity: 0.55, depthWrite: false }),
    );
    this.gripMarker.visible = false;
    this.group.add(this.gripMarker);

    // Left-hand grip handle: the second grip cell of a two-handed weapon,
    // shown in magenta so both hands read at a glance.
    this.grip2Marker = new T.Mesh(
      new T.BoxGeometry(1, 1, 1),
      new T.MeshBasicMaterial({ color: HANDLE2_COLOR, transparent: true, opacity: 0.55, depthWrite: false }),
    );
    this.grip2Marker.visible = false;
    this.group.add(this.grip2Marker);

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

  _afterRebuild() { this._updateGripAndArrow(); }

  _snapshotExtra() {
    return {
      grid: this.item.grid,
      grip: this.item.grip,
      grip2: this.item.grip2,
      yaw: this.item.yaw,
      kind: this.item.kind,
      stats: this.item.stats,
      weapon: this.item.weapon,
      ammo: this.item.ammo,
    };
  }

  _restoreExtra(s) {
    this.item.grid = s.grid ?? [...DEFAULT_EQUIP_GRID];
    this.item.grip = s.grip;
    this.item.grip2 = s.grip2 ?? null;
    this.item.yaw = s.yaw;
    this.item.kind = s.kind ?? 'weapon';
    this.item.stats = s.stats;
    this.item.weapon = s.weapon;
    this.item.ammo = s.ammo ?? { ...DEFAULT_AMMO };
  }

  _onEditorKey(code, event) {
    // Grip / muzzle / direction only mean something on held weapons.
    if (this.item.kind !== 'ammo') {
      if (code === 'KeyG') {
        this.setTool('grip');
        return true;
      }
      if (code === 'KeyH') {
        this.setTool('grip2');
        return true;
      }
      if (code === 'KeyM') {
        this.setTool('muzzle');
        return true;
      }
      if (code === 'KeyR') {
        this._rotateDirection();
        return true;
      }
    }
    return false;
  }

  _ghostHex(occupied) {
    if (this.gripMode) return GRIP_GHOST_COLOR;
    if (this.grip2Mode) return GRIP2_GHOST_COLOR;
    if (this.muzzleMode) return MUZZLE_GHOST_COLOR;
    return super._ghostHex(occupied);
  }

  _idExists(id) { return isEquipId(id); }

  _slugify(name) { return slugifyName(name); }

  /** Grip and muzzle ride along when the model is nudged (clamped to grid). */
  _translateExtras(d) {
    const dims = this._gridDims();
    const clamp = (n, axis) => Math.max(0, Math.min(dims[axis] - 1, n));
    if (this.item.grip) {
      this.item.grip = {
        x: clamp(this.item.grip.x + d[0], 0),
        y: clamp(this.item.grip.y + d[1], 1),
        z: clamp(this.item.grip.z + d[2], 2),
      };
    }
    if (this.item.grip2) {
      this.item.grip2 = {
        x: clamp(this.item.grip2.x + d[0], 0),
        y: clamp(this.item.grip2.y + d[1], 1),
        z: clamp(this.item.grip2.z + d[2], 2),
      };
    }
    if (this.item.weapon?.muzzle) {
      const m = this.item.weapon.muzzle;
      this.item.weapon.muzzle = {
        x: clamp(m.x + d[0], 0),
        y: clamp(m.y + d[1], 1),
        z: clamp(m.z + d[2], 2),
      };
    }
  }

  // --- build volume ---

  /** Resize the build volume, keeping content centred. Refused (with the
   *  reason) when the placed voxels don't fit the new volume — nothing is
   *  ever silently dropped. */
  _setGridDims(dims) {
    const next = normalizeGrid(dims);
    const cur = this._gridDims();
    if (next[0] === cur[0] && next[1] === cur[1] && next[2] === cur[2]) return;
    const moved = recenterForResize(this.item.microVoxels, cur, next);
    if (!moved) {
      Notice.warn(`Content doesn't fit ${next.join('×')} — erase voxels or pick a bigger volume`);
      this._renderUI(); // snap the steppers back to the real dims
      return;
    }
    this._pushSnapshot();
    const shift = resizeShift(cur, next);
    this.item.grid = next;
    this.item.microVoxels = moved;
    this._translateExtras(shift);
    this._boxAnchor = null;
    this._rebuild();
    this._setView('iso'); // reframe the camera for the new volume
  }

  // --- grip + direction + muzzle ---

  _toggleGripMode() { this.setTool('grip'); }

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
    Notice.info(`Right-hand grip set at (${cell[0]}, ${cell[1]}, ${cell[2]})`, 900);
  }

  /** Set the left-hand grip (two-handed weapons) to the hovered cell. */
  _setGrip2() {
    const cell = this._ghostCell;
    if (!cell) {
      Notice.warn('Click a voxel to set the left-hand grip');
      return;
    }
    this._pushSnapshot();
    this.item.grip2 = { x: cell[0], y: cell[1], z: cell[2] };
    this._rebuild();
    Notice.info(`Left-hand grip set at (${cell[0]}, ${cell[1]}, ${cell[2]})`, 900);
  }

  _toggleMuzzleMode() { this.setTool('muzzle'); }

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
    const c = this._cellSize();
    const dims = this._gridDims();
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

    const g2 = held && this.item.grip2;
    if (g2) {
      const [wx, wy, wz] = this._cellCenterToWorld([g2.x, g2.y, g2.z]);
      this.grip2Marker.visible = true;
      this.grip2Marker.scale.set(c * 1.25, c * 1.25, c * 1.25);
      this.grip2Marker.position.set(wx, wy, wz);
    } else {
      this.grip2Marker.visible = false;
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

    // Arrow originates at the grip (or the volume centre when unset).
    const o = base
      ? this._cellCenterToWorld(base)
      : this._cellCenterToWorld(dims.map((g) => Math.floor(g / 2)));
    this.dirArrow.visible = held;
    this.dirArrow.position.set(o[0], o[1], o[2]);
    this.dirArrow.rotation.set(0, (this.item.yaw * Math.PI) / 180, 0);
  }

  // --- kind / stats ---

  /** Switch the item kind (weapon vs ammo) and drop any held-item marker tool. */
  _setItemKind(kind) {
    if (this.item.kind === kind) return;
    this._pushSnapshot();
    this.item.kind = kind;
    if (this.gripMode || this.muzzleMode) this.tool = 'paint';
    this._rebuild();
    Notice.info(kind === 'ammo' ? 'Ammo item — defines an ammo type' : 'Weapon item — held and fought with', 1100);
  }

  /** Switch the weapon kind and snap the attack animation to a valid default.
   *  Ranged weapons get the standard aim spread unless one is already set, so a
   *  freshly-made gun drifts like the game's default instead of being laser
   *  accurate until the user tunes the Spread field. */
  _setKind(kind) {
    if (this.item.weapon.kind === kind) return;
    this._pushSnapshot();
    this.item.weapon.kind = kind;
    if (!ATTACK_ANIMS[kind].includes(this.item.weapon.anim)) {
      this.item.weapon.anim = kind === 'ranged' ? 'gun' : 'punch';
    }
    if (kind === 'ranged' && this.item.weapon.spread === 0) {
      this.item.weapon.spread = RANGED_SPREAD;
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

  // --- save / load ---

  _validateForSave() {
    if (this.item.kind === 'ammo') {
      this._syncAmmoFromUI();
      if (!this.item.ammo.type) return 'Pick an ammo type for the pack';
    } else {
      this._syncStatsFromUI();
    }
    return null;
  }

  /** Load a registered item into the editor for further editing. */
  loadEquipItem(item) {
    this.item = JSON.parse(JSON.stringify(item));
    this.item.grid = normalizeGrid(this.item.grid);
    if (!this.item.stats) this.item.stats = { damage: 10, reach: 2, cooldown: 0.35 };
    if (!this.item.weapon) this.item.weapon = { ...DEFAULT_WEAPON };
    if (!this.item.kind) this.item.kind = 'weapon';
    if (!this.item.ammo) this.item.ammo = { ...DEFAULT_AMMO };
    this._undoStack.length = 0;
    this._redoStack.length = 0;
    this._rebuild();
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

  _wireExtraUI($) {
    const ui = this._ui;
    Object.assign(ui, {
      title: $('#ep-title'),
      catWeapon: $('#ep-cat-weapon'),
      catAmmo: $('#ep-cat-ammo'),
      weaponFields: $('#ep-weapon-fields'),
      ammoFields: $('#ep-ammo-fields'),
      gripLabel: $('#ep-grip-label'),
      grip2Label: $('#ep-grip2-label'),
      yawLabel: $('#ep-yaw-label'),
      damage: $('#ep-damage'),
      reach: $('#ep-reach'),
      cooldown: $('#ep-cooldown'),
      rotateBtn: $('#ep-rotate'),
      shapeRow: $('#ep-shape'),
      gridX: $('#ep-grid-x'),
      gridY: $('#ep-grid-y'),
      gridZ: $('#ep-grid-z'),
      gridSize: $('#ep-grid-size'),
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
      spread: $('#ep-spread'),
      spreadRow: $('#ep-spread-row'),
      pellets: $('#ep-pellets'),
      pelletsRow: $('#ep-pellets-row'),
      totalRow: $('#ep-total-row'),
      totalDmg: $('#ep-total-dmg'),
      ammoType: $('#ep-ammo-type'),
      grant: $('#ep-grant'),
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

    // Build-volume presets + per-axis steppers.
    for (const preset of EQUIP_GRID_PRESETS) {
      const btn = this.doc.createElement('button');
      btn.id = `ep-shape-${preset.id}`;
      btn.title = `${preset.dims.join('×')} cells (${preset.dims.map((g) => (g * this._cellSize()).toFixed(1)).join('×')} m)`;
      btn.textContent = preset.name;
      btn.addEventListener('click', () => this._setGridDims(preset.dims));
      ui.shapeRow?.appendChild(btn);
    }
    for (const [el, axis] of [[ui.gridX, 0], [ui.gridY, 1], [ui.gridZ, 2]]) {
      el?.addEventListener('change', () => {
        const dims = [...this._gridDims()];
        dims[axis] = Number(el.value);
        this._setGridDims(dims);
      });
    }

    ui.rotateBtn.addEventListener('click', () => this._rotateDirection());
    ui.kindMelee.addEventListener('click', () => this._setKind('melee'));
    ui.kindRanged.addEventListener('click', () => this._setKind('ranged'));
    ui.anim.addEventListener('change', () => {
      this._pushSnapshot();
      this.item.weapon.anim = ui.anim.value;
      this._renderUI();
      Notice.info(`Attack animation: ${ui.anim.value}`, 700);
    });
    ui.handsOne.addEventListener('click', () => this._setHands('one'));
    ui.handsTwo.addEventListener('click', () => this._setHands('two'));
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
    ui.spread.addEventListener('change', () => {
      this._pushSnapshot();
      const v = Number(ui.spread.value);
      const deg = Number.isFinite(v) ? Math.max(0, Math.min(11.5, v)) : 0;
      this.item.weapon.spread = (deg * Math.PI) / 180;
      this._renderUI();
      Notice.info(`Aim spread: ${deg.toFixed(1)}°`, 700);
    });
    ui.pellets.addEventListener('change', () => {
      this._pushSnapshot();
      const v = Number(ui.pellets.value);
      this.item.weapon.pellets = Number.isFinite(v) ? Math.max(1, Math.min(20, Math.round(v))) : 1;
      this._renderUI();
    });
  }

  _renderExtraUI() {
    const ui = this._ui;
    if (!ui.title) return;
    const w = this.item.weapon ?? DEFAULT_WEAPON;
    const isAmmo = this.item.kind === 'ammo';
    ui.title.textContent = isAmmo ? 'Ammo Item' : 'Weapon Item';
    ui.catWeapon.classList.toggle('active', !isAmmo);
    ui.catAmmo.classList.toggle('active', isAmmo);
    ui.weaponFields.classList.toggle('hidden', isAmmo);
    ui.ammoFields.classList.toggle('hidden', !isAmmo);

    // Ammo pack: the type it grants + how many rounds per pickup.
    const choices = listAmmoTypes();
    syncSelect(ui.ammoType, choices, this.doc);
    const ammoPack = this.item.ammo ?? DEFAULT_AMMO;
    ui.ammoType.value = choices.some((c) => c.id === ammoPack.type) ? ammoPack.type : '';
    ui.grant.value = String(ammoPack.amount ?? 0);
    ui.grant.disabled = !ammoPack.type;

    // Build volume: steppers, meter label and preset highlighting.
    const dims = this._gridDims();
    const c = this._cellSize();
    if (ui.gridX && this.doc.activeElement !== ui.gridX) ui.gridX.value = String(dims[0]);
    if (ui.gridY && this.doc.activeElement !== ui.gridY) ui.gridY.value = String(dims[1]);
    if (ui.gridZ && this.doc.activeElement !== ui.gridZ) ui.gridZ.value = String(dims[2]);
    if (ui.gridSize) ui.gridSize.textContent = dims.map((g) => (g * c).toFixed(2).replace(/0$/, '')).join(' × ') + ' m';
    if (ui.shapeRow) {
      for (const preset of EQUIP_GRID_PRESETS) {
        const btn = this.doc.querySelector(`#ep-shape-${preset.id}`);
        btn?.classList.toggle('active', preset.dims.every((g, i) => g === dims[i]));
      }
    }

    ui.gripLabel.textContent = this.item.grip ? `${this.item.grip.x},${this.item.grip.y},${this.item.grip.z}` : 'unset';
    if (ui.grip2Label) ui.grip2Label.textContent = this.item.grip2 ? `${this.item.grip2.x},${this.item.grip2.y},${this.item.grip2.z}` : 'unset';
    ui.yawLabel.textContent = yawLabel(this.item.yaw);
    ui.damage.value = String(this.item.stats.damage);
    ui.reach.value = String(this.item.stats.reach);
    ui.cooldown.value = String(this.item.stats.cooldown);
    ui.kindMelee.classList.toggle('active', w.kind === 'melee');
    ui.kindRanged.classList.toggle('active', w.kind === 'ranged');
    ui.handsOne.classList.toggle('active', w.hands !== 'two');
    ui.handsTwo.classList.toggle('active', w.hands === 'two');
    // Grip/muzzle tools only exist for held weapons; muzzle dims for melee.
    if (ui.toolBtns?.grip) ui.toolBtns.grip.disabled = isAmmo;
    if (ui.toolBtns?.grip2) {
      ui.toolBtns.grip2.disabled = isAmmo;
      ui.toolBtns.grip2.style.opacity = !isAmmo && w.hands === 'two' ? '' : '0.45';
    }
    if (ui.toolBtns?.muzzle) {
      ui.toolBtns.muzzle.disabled = isAmmo;
      ui.toolBtns.muzzle.style.opacity = !isAmmo && w.kind === 'ranged' ? '' : '0.45';
    }
    ui.magazineRow.classList.toggle('hidden-row', w.kind !== 'ranged');
    ui.magazine.value = String(w.magazine ?? 0);
    ui.ammoRow.classList.toggle('hidden-row', w.kind !== 'ranged');
    ui.reloadRow.classList.toggle('hidden-row', w.kind !== 'ranged');
    ui.reload.value = String(w.reload ?? 1.4);
    ui.spreadRow.classList.toggle('hidden-row', w.kind !== 'ranged');
    ui.spread.value = String(Math.round(((w.spread ?? 0) * 180) / Math.PI * 100) / 100);
    // Pellets per shot + the damage a full hit deals (damage is per pellet).
    const pellets = Math.max(1, Math.round(w.pellets ?? 1));
    ui.pelletsRow.classList.toggle('hidden-row', w.kind !== 'ranged');
    ui.pellets.value = String(pellets);
    ui.totalRow.classList.toggle('hidden-row', w.kind !== 'ranged' || pellets <= 1);
    ui.totalDmg.textContent = `${this.item.stats.damage * pellets} (${pellets} × ${this.item.stats.damage})`;

    // The weapon's consumed ammo type (None + every built-in/custom type).
    syncSelect(ui.ammo, choices, this.doc);
    ui.ammo.value = choices.some((c) => c.id === w.ammo) ? w.ammo : '';

    // Rebuild the anim options for the current kind, keeping the selection.
    const opts = ATTACK_ANIMS[w.kind] ?? [];
    if (ui.anim.options.length !== opts.length || [...ui.anim.options].some((o, i) => o.value !== opts[i])) {
      ui.anim.innerHTML = '';
      for (const name of opts) {
        const o = this.doc.createElement('option');
        o.value = name;
        o.textContent = name[0].toUpperCase() + name.slice(1);
        ui.anim.appendChild(o);
      }
    }
    ui.anim.value = ATTACK_ANIMS[w.kind].includes(w.anim) ? w.anim : opts[0];
  }
}
