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
// Items with a light source also get a PointLight + a small visible bulb
// sphere at the bulb cell. The chunk material ignores scene lights, so world
// lighting from items comes from the LightField block channel (seeded by
// App._refreshItemLights); the PointLight is included for materials that do
// respond to lights and as a visual affordance for the light source.

import { createItemGeometry } from './ItemGeometry.three.js';
import { getItem } from '../engine/ItemRegistry.js';
import { getEquipItem } from '../engine/EquipmentRegistry.js';
import { microCellSizeFor, rotateMicroPoint } from '../engine/ItemTypes.js';
import { CELL_SIZE } from '../engine/Space.js';

const rgbToHex = (c) => ((Math.round(c[0]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[2])) >>> 0;

/** Resolve a placed item id from either registry (equipment items can be
 *  placed on the map from the E menu's Equippable Items section). */
const resolveItem = (id) => getItem(id) ?? getEquipItem(id);

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
    this._groups = new Map(); // anchor key -> { group, mesh, geo, placement, offset }
    this._lightVersion = -1;
  }

  /** Reconcile scene groups with world.items. Call every frame (cheap). */
  update() {
    // Re-bake per-vertex light whenever the light field changed.
    const lightVersion = this.lightField?.version ?? 0;
    if (lightVersion !== this._lightVersion) {
      this._lightVersion = lightVersion;
      for (const entry of this._groups.values()) this._relight(entry);
    }

    const keys = new Set();
    this.world.forEachItem((placement) => {
      const key = placement.anchor.join(',');
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

  _build(placement) {
    const T = this.THREE;
    const item = resolveItem(placement.itemId);
    const c = microCellSizeFor(placement.size);
    const offset = [
      placement.anchor[0] * CELL_SIZE,
      placement.anchor[1] * CELL_SIZE,
      placement.anchor[2] * CELL_SIZE,
    ];
    const yaw = placement.rotation ?? 0;
    const group = new T.Group();
    const geo = createItemGeometry(T, item ? item.microVoxels : [], {
      lightField: this.lightField,
      scale: c,
      offset,
      rotation: yaw,
    });
    const mesh = new T.Mesh(geo, this.material);
    mesh.scale.setScalar(c);
    mesh.position.set(offset[0], offset[1], offset[2]);
    group.add(mesh);

    if (item && item.light) {
      const [lx, lz] = rotateMicroPoint(item.light.x, item.light.z, yaw);
      const bulbPos = new T.Vector3(
        offset[0] + (lx + 0.5) * c,
        offset[1] + (item.light.y + 0.5) * c,
        offset[2] + (lz + 0.5) * c,
      );
      const light = new T.PointLight(rgbToHex(item.light.color), 2, item.light.strength);
      light.position.copy(bulbPos);
      group.add(light);
      const bulb = new T.Mesh(
        new T.SphereGeometry(c * 0.4, 12, 12),
        new T.MeshBasicMaterial({ color: rgbToHex(item.light.color) }),
      );
      bulb.position.copy(bulbPos);
      group.add(bulb);
    }

    this.scene.add(group);
    return { group, mesh, geo, placement, offset };
  }

  /** Rebuild an item's geometry so its per-vertex light reflects the current
   *  light field (world edits, item light changes). */
  _relight(entry) {
    const item = resolveItem(entry.placement.itemId);
    const c = microCellSizeFor(entry.placement.size);
    const geo = createItemGeometry(this.THREE, item ? item.microVoxels : [], {
      lightField: this.lightField,
      scale: c,
      offset: entry.offset,
      rotation: entry.placement.rotation ?? 0,
    });
    entry.mesh.geometry.dispose();
    entry.mesh.geometry = geo;
    entry.geo = geo;
  }
}
