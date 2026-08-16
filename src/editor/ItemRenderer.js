// ItemRenderer.js — renders placed items in the world scene.
//
// Items are not part of chunk meshing (they are separate entities), so they
// get their own meshes here: one group per placement, built from the item's
// micro-voxels and scaled to its world footprint. Item meshes use the same
// light model as chunks — per-vertex sky/block light baked from the LightField
// into a map-less shader — so placed objects darken in shadow and at night
// instead of standing out. Item geometry is re-lit whenever the light field
// changes (world edits, item light changes).
//
// Items with a light source also get a PointLight. The chunk material
// ignores scene lights, so world lighting from items comes from the
// LightField block channel (seeded by App._refreshItemLights); the
// PointLight is included for materials that do respond to lights. The
// visible bulb sphere gizmo is drawn only in the item/object editor's own
// preview scene (ItemEditor._buildExtraSceneObjects), never here — it must
// not appear in the world editor or in actual gameplay.

import { createItemGeometry, createOutlineGeometry } from './ItemGeometry.three.js';
import { getItem } from '../engine/ItemRegistry.js';
import { getEquipItem } from '../engine/EquipmentRegistry.js';
import { MICRO_SIZE, gridOf, rotateMicroPoint } from '../engine/ItemTypes.js';
import { layFlat } from '../engine/LayFlat.js';
import { CELL_SIZE } from '../engine/Space.js';

const rgbToHex = (c) => ((Math.round(c[0]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[2])) >>> 0;

/** Min ms between item relight passes. Blinking lights bump the light field's
 *  version many times per second; relighting at up to ~10 Hz keeps the strobe
 *  visible without paying the per-frame cost of touching every item near the
 *  flicker. */
const RELIGHT_INTERVAL_MS = 100;

/** Resolve a placed item id from either registry (equipment items can be
 *  placed on the map from the E menu's Equippable Items section). */
const resolveItem = (id) => getItem(id) ?? getEquipItem(id);

/** Micro-voxels + grid a placement renders with. Placeable objects use their
 *  authored volume; equipment (pickables) uses the resting pose — cropped to
 *  its painted voxels and laid flat on the surface (see LayFlat.js). */
const modelFor = (id) => {
  const placeable = getItem(id);
  if (placeable) return { microVoxels: placeable.microVoxels, grid: gridOf(placeable) };
  const equip = getEquipItem(id);
  if (equip) return layFlat(equip);
  return { microVoxels: [], grid: [8, 8, 8] };
};

export class ItemRenderer {
  /**
   * @param {object} deps
   * @param {object} deps.THREE
   * @param {import('three').Scene} deps.scene
   * @param {object} deps.world
   * @param {object} deps.lightField   the LightField to bake light from
   * @param {import('three').Material} deps.material  map-less lit material
   */
  constructor({ THREE, scene, world, lightField, material }) {
    this.THREE = THREE;
    this.scene = scene;
    this.world = world;
    this.lightField = lightField;
    this.material = material;
    this._groups = new Map(); // anchor key -> { group, mesh, geo, placement, offset, lightCells }
    this._lightVersion = -1;
    this._lastRelight = 0;
    /** placement object -> anchor key string (avoids re-joining every frame). */
    this._keyCache = new WeakMap();
  }

  _keyOf(placement) {
    let k = this._keyCache.get(placement);
    if (k === undefined) {
      k = placement.anchor.join(',');
      this._keyCache.set(placement, k);
    }
    return k;
  }

  /** Reconcile scene groups with world.items. Call every frame (cheap). */
  update() {
    // Re-bake per-vertex light whenever the light field changed. Incremental
    // edits only touch their recomputeEdit box, so only the items inside it
    // need new baked light — full worlds (lastBox null) re-bake everything.
    // Throttled: blinking lights change the version many times per second and
    // a relight pass over a furnished room is the expensive part of the frame.
    const lightVersion = this.lightField?.version ?? 0;
    if (lightVersion !== this._lightVersion) {
      const now = typeof performance !== 'undefined' ? performance.now() : 0;
      if (now - this._lastRelight >= RELIGHT_INTERVAL_MS) {
        this._lightVersion = lightVersion;
        this._lastRelight = now;
        // Far-apart edits produce separate boxes (lastBoxes); an item relights
        // when it touches any of them. Full worlds (no boxes) re-bake all.
        const lf = this.lightField;
        const boxes = lf?.lastBoxes ?? (lf?.lastBox ? [lf.lastBox] : null);
        for (const entry of this._groups.values()) {
          if (!boxes || boxes.some((b) => this._touchesBox(entry, b))) this._relight(entry);
        }
      }
    }

    const keys = new Set();
    this.world.forEachItem((placement) => {
      const key = this._keyOf(placement);
      keys.add(key);
      if (!this._groups.has(key)) {
        this._groups.set(key, this._build(placement));
      }
    });
    for (const [key, entry] of this._groups) {
      if (!keys.has(key)) {
        this.scene.remove(entry.group);
        entry.geo?.dispose();
        this._groups.delete(key);
      }
    }
  }

  /** True when an item's cell footprint overlaps the light edit box. The
   *  span uses the largest grid axis so any yaw rotation (and height) fits. */
  _touchesBox(entry, [bx0, by0, bz0, bx1, by1, bz1]) {
    const g = entry.grid;
    const span = Math.ceil(Math.max(g[0], g[1], g[2]) * (MICRO_SIZE / CELL_SIZE));
    const [ax, ay, az] = entry.placement.anchor;
    return ax + span >= bx0 && ax <= bx1 + span &&
           ay + span >= by0 && ay <= by1 &&
           az + span >= bz0 && az <= bz1 + span;
  }

  /** Drop all item meshes (before clear/load). */
  clear() {
    for (const entry of this._groups.values()) {
      this.scene.remove(entry.group);
      entry.geo?.dispose();
    }
    this._groups.clear();
  }

  /** Clear + resync (after loading a map or registering a re-saved item). */
  rebuildAll() {
    this.clear();
    this.update();
  }

  /** Silhouette hull of a placed item's own shape (not the cell footprint it
   *  occupies), ready to hang on the pickup-highlight mesh: `{ geometry,
   *  scale, position }` in world space. The geometry carries an `outlineDir`
   *  attribute the highlight shader inflates along (see
   *  createOutlineGeometry). Null until the item's mesh exists (the first
   *  update() after it was placed). The caller owns the returned geometry and
   *  must dispose it. */
  outlineFor(placement) {
    const entry = this._groups.get(this._keyOf(placement));
    if (!entry) return null;
    return {
      geometry: createOutlineGeometry(this.THREE, entry.geo),
      scale: MICRO_SIZE,
      position: entry.offset,
    };
  }

  _build(placement) {
    const T = this.THREE;
    const item = resolveItem(placement.itemId);
    const c = MICRO_SIZE;
    const { microVoxels, grid } = modelFor(placement.itemId);
    const offset = [
      placement.anchor[0] * CELL_SIZE,
      placement.anchor[1] * CELL_SIZE,
      placement.anchor[2] * CELL_SIZE,
    ];
    const yaw = placement.rotation ?? 0;
    const group = new T.Group();
    const geo = createItemGeometry(T, microVoxels, {
      lightField: this.lightField,
      scale: c,
      offset,
      rotation: yaw,
      grid,
    });
    const mesh = new T.Mesh(geo, this.material);
    mesh.scale.setScalar(c);
    mesh.position.set(offset[0], offset[1], offset[2]);
    group.add(mesh);

    if (item && item.light) {
      const [lx, lz] = rotateMicroPoint(item.light.x, item.light.z, yaw, grid[0], grid[2]);
      const bulbPos = new T.Vector3(
        offset[0] + (lx + 0.5) * c,
        offset[1] + (item.light.y + 0.5) * c,
        offset[2] + (lz + 0.5) * c,
      );
      const light = new T.PointLight(rgbToHex(item.light.color), 2, item.light.strength);
      light.position.copy(bulbPos);
      group.add(light);
    }

    this.scene.add(group);
    const entry = { group, mesh, geo, grid, placement, offset, lightCells: null };
    this._cacheLightCells(entry);
    return entry;
  }

  /** Cache each vertex's world light cell once, so relighting rewrites only
   *  the `light` attribute instead of rebuilding the whole geometry. Positions
   *  are rotated (by createItemGeometry) but unscaled — the mesh's scale and
   *  position turn them into world meters. */
  _cacheLightCells(entry) {
    const attr = entry.geo.getAttribute('position');
    if (!attr || !this.lightField) return;
    const cells = new Int16Array(attr.count * 3);
    const o = entry.offset;
    for (let i = 0; i < attr.count; i++) {
      cells[i * 3] = Math.floor((o[0] + attr.getX(i) * MICRO_SIZE) / CELL_SIZE);
      cells[i * 3 + 1] = Math.floor((o[1] + attr.getY(i) * MICRO_SIZE) / CELL_SIZE);
      cells[i * 3 + 2] = Math.floor((o[2] + attr.getZ(i) * MICRO_SIZE) / CELL_SIZE);
    }
    entry.lightCells = cells;
  }

  /** Rewrite the baked per-vertex light from the current light field. The
   *  vertex positions never change between relights, so only the `light`
   *  attribute is touched — no geometry rebuild, no allocation. */
  _relight(entry) {
    const light = entry.mesh.geometry.getAttribute('light');
    const cells = entry.lightCells;
    if (!light || !cells || !this.lightField) return;
    const arr = light.array;
    const lf = this.lightField;
    for (let i = 0; i < cells.length / 3; i++) {
      arr[i * 2] = lf.skyAt(cells[i * 3], cells[i * 3 + 1], cells[i * 3 + 2]) / 15;
      arr[i * 2 + 1] = lf.blockAt(cells[i * 3], cells[i * 3 + 1], cells[i * 3 + 2]) / 15;
    }
    light.needsUpdate = true;
  }
}
