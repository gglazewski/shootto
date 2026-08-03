// World.js — sparse voxel storage.
//
// The internal grid unit is one SMALL cell = 0.5m in world space.
// A voxel occupies a cuboid of cells:
//   SMALL -> 1x1x1 starting at its anchor cell.
//   BIG   -> 2x2x2 starting at its anchor cell (anchor coords are even).
//
// Every occupied cell maps to the same Voxel object, so a BIG voxel owns
// 8 entries. Lookup of any sub-cell returns the owning voxel in O(1).

import { anchorFor, cellsFor } from './VoxelShape.js';
import { DEFAULT_CHUNK_SIZE } from './Space.js';

export { DEFAULT_CHUNK_SIZE, anchorFor, cellsFor };

/**
 * @typedef {Object} Voxel
 * @property {string}  type
 * @property {'small'|'big'} size
 * @property {[number, number, number]} anchor
 */

const key = (x, y, z) => `${x},${y},${z}`;

export class World {
  /**
   * @param {number} [chunkSize] edge length of a chunk in small cells
   */
  constructor(chunkSize = DEFAULT_CHUNK_SIZE) {
    this.chunkSize = chunkSize;
    /** @type {Map<string, Voxel>} cellKey -> voxel */
    this.cells = new Map();
    this.dirty = new Set();
    /** Edit records since the last drain (for incremental light updates). */
    this.edits = [];
    /** @type {[number, number, number]|null} player spawn cell, if any */
    this.spawn = null;
    /** Facing direction of the spawned player, in degrees (0 = -Z, matching
     *  the camera yaw). Used by the spawn marker's arrow and test run. */
    this.spawnYaw = 0;
    /** Placed items: anchor key -> { itemId, anchor, size }. Items are
     *  separate from voxels: they occupy space (see itemCells / isAreaFree)
     *  but are meshed independently (ItemRenderer), not into chunks. */
    this.items = new Map();
    /** cell key -> item anchor key, so any cell of a footprint resolves to
     *  its owning item in O(1). */
    this.itemCells = new Map();
    /** Mob spawn points: cell key -> { type, x, y, z }. Mobs are gameplay
     *  entities (not voxels or items): the editor places spawns here and the
     *  game's MobManager reads them when a game starts. */
    this.mobSpawns = new Map();
  }

  /** Set the player spawn point to a cell. @returns {[number,number,number]} */
  setSpawn(x, y, z) {
    this.spawn = [x, y, z];
    return this.spawn;
  }

  clearSpawn() {
    this.spawn = null;
    this.spawnYaw = 0;
  }

  /** Voxel occupying a cell, or null. */
  get(x, y, z) {
    return this.cells.get(key(x, y, z)) ?? null;
  }

  /**
   * Try to place a voxel. Occupancy is checked across all its cells; if any
   * cell is taken the whole placement is rejected (atomic).
   * @returns {boolean} true when placed
   */
  place(type, size, ax, ay, az) {
    if (!this.isAreaFree(ax, ay, az, size)) return false;
    const voxel = { type, size, anchor: [ax, ay, az] };
    const cells = [...cellsFor(ax, ay, az, size)];
    for (const [x, y, z] of cells) {
      this.cells.set(key(x, y, z), voxel);
      this.markDirty(x, y, z);
    }
    this.edits.push({ cells, remove: false, type });
    return true;
  }

  /** True when every cell of the cuboid is empty (no voxel, no item). */
  isAreaFree(ax, ay, az, size) {
    for (const [x, y, z] of cellsFor(ax, ay, az, size)) {
      if (this.cells.has(key(x, y, z))) return false;
      if (this.itemCells.has(key(x, y, z))) return false;
    }
    return true;
  }

  /** Convenience: place a voxel snapping coordinates to size parity. */
  placeAt(type, size, x, y, z) {
    const [ax, ay, az] = anchorFor(x, y, z, size);
    return this.place(type, size, ax, ay, az);
  }

  /** Remove the whole voxel occupying a cell. Returns the removed voxel or null. */
  remove(x, y, z) {
    const voxel = this.get(x, y, z);
    if (!voxel) return null;
    const [ax, ay, az] = voxel.anchor;
    const cells = [...cellsFor(ax, ay, az, voxel.size)];
    for (const [cx, cy, cz] of cells) {
      this.cells.delete(key(cx, cy, cz));
      this.markDirty(cx, cy, cz);
    }
    this.edits.push({ cells, remove: true, type: voxel.type });
    return voxel;
  }

  /** Remove every voxel, item and the spawn point. */
  clear() {
    this.cells.clear();
    this.dirty.clear();
    this.edits.length = 0;
    this.spawn = null;
    this.spawnYaw = 0;
    this.items.clear();
    this.itemCells.clear();
    this.mobSpawns.clear();
  }

  /**
   * Try to place an item at an anchor cell. The whole footprint must be free
   * of both voxels and other items. Items do not dirty chunks (they are not
   * part of chunk meshing); the caller triggers light + mesh refresh.
   * @param {number} [rotation] yaw in radians about the footprint centre
   * @returns {boolean} true when placed
   */
  placeItem(itemId, size, ax, ay, az, rotation = 0) {
    if (!this.isAreaFree(ax, ay, az, size)) return false;
    const anchorKey = key(ax, ay, az);
    if (this.items.has(anchorKey)) return false;
    const cells = [...cellsFor(ax, ay, az, size)];
    for (const [x, y, z] of cells) this.itemCells.set(key(x, y, z), anchorKey);
    this.items.set(anchorKey, { itemId, anchor: [ax, ay, az], size, rotation });
    return true;
  }

  /** Item occupying the cell (by footprint), or null. */
  itemAt(x, y, z) {
    const anchorKey = this.itemCells.get(key(x, y, z));
    return anchorKey ? this.items.get(anchorKey) ?? null : null;
  }

  /** Remove the whole item whose footprint contains the cell. */
  removeItemAt(x, y, z) {
    const anchorKey = this.itemCells.get(key(x, y, z));
    if (!anchorKey) return null;
    const item = this.items.get(anchorKey) ?? null;
    this.items.delete(anchorKey);
    for (const [cell, owner] of this.itemCells) {
      if (owner === anchorKey) this.itemCells.delete(cell);
    }
    return item;
  }

  /** Remove every placed item with the given itemId (catalogue delete).
   *  @returns {number} how many were removed */
  removeItemsById(itemId) {
    let removed = 0;
    for (const [anchorKey, item] of this.items) {
      if (item.itemId === itemId) {
        this.items.delete(anchorKey);
        removed++;
      }
    }
    if (removed) {
      for (const [cell, owner] of this.itemCells) {
        if (!this.items.has(owner)) this.itemCells.delete(cell);
      }
    }
    return removed;
  }

  /** Iterate every placed item once. */
  forEachItem(fn) {
    for (const item of this.items.values()) fn(item);
  }

  // --- mob spawns (gameplay entities placed in the editor) ---

  /** Mob spawn at an exact cell, or null. */
  mobSpawnAt(x, y, z) {
    return this.mobSpawns.get(key(x, y, z)) ?? null;
  }

  /** Add a mob spawn at a cell (rejects overlaps). @returns {boolean} */
  addMobSpawn(type, x, y, z) {
    const k = key(x, y, z);
    if (this.mobSpawns.has(k)) return false;
    this.mobSpawns.set(k, { type, x, y, z });
    return true;
  }

  /** Remove the mob spawn at a cell. @returns {object|null} */
  removeMobSpawnAt(x, y, z) {
    const k = key(x, y, z);
    const spawn = this.mobSpawns.get(k) ?? null;
    if (spawn) this.mobSpawns.delete(k);
    return spawn;
  }

  /** Iterate every mob spawn once. */
  forEachMobSpawn(fn) {
    for (const s of this.mobSpawns.values()) fn(s);
  }

  chunkKey(x, y, z) {
    const s = this.chunkSize;
    const fx = Math.floor(x / s), fy = Math.floor(y / s), fz = Math.floor(z / s);
    return `${fx},${fy},${fz}`;
  }

  /**
   * Mark the chunk containing (x,y,z) and all its 26 neighbors dirty.
   * Culling and AO for a chunk depend on cells in adjacent chunks, so any
   * edit must force those neighbors to rebuild too.
   */
  markDirty(x, y, z) {
    const s = this.chunkSize;
    const cx = Math.floor(x / s), cy = Math.floor(y / s), cz = Math.floor(z / s);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (let k = -1; k <= 1; k++)
          this.dirty.add(`${cx + i},${cy + j},${cz + k}`);
  }

  /** Chunk coordinates (min cell) for a chunk key. */
  chunkOrigin(ckey) {
    const [cx, cy, cz] = ckey.split(',').map(Number);
    const s = this.chunkSize;
    return [cx * s, cy * s, cz * s];
  }

  /** Keys of chunks modified since the last drain. */
  drainDirty() {
    const out = [...this.dirty];
    this.dirty.clear();
    return out;
  }

  /** Edit records (voxel add/remove deltas) since the last drain. */
  drainEdits() {
    const out = this.edits;
    this.edits = [];
    return out;
  }

  /** Iterate every occupied cell (BIG voxels yield all 8 sub-cells). */
  forEachCell(fn) {
    for (const [k, v] of this.cells) {
      const [x, y, z] = k.split(',').map(Number);
      fn(x, y, z, v);
    }
  }

  /** Iterate each unique voxel once, keyed by anchor. */
  forEachVoxel(fn) {
    const seen = new Set();
    for (const v of this.cells.values()) {
      const a = v.anchor;
      const ak = `${a[0]},${a[1]},${a[2]}`;
      if (seen.has(ak)) continue;
      seen.add(ak);
      fn(v);
    }
  }

  /** Number of unique voxels. */
  get count() {
    let n = 0;
    const seen = new Set();
    for (const v of this.cells.values()) {
      const a = v.anchor;
      const ak = `${a[0]},${a[1]},${a[2]}`;
      if (!seen.has(ak)) { seen.add(ak); n++; }
    }
    return n;
  }

  /** Inclusive min/max cell bounds over all occupied cells, or null. */
  bounds() {
    let min = null, max = null;
    for (const k of this.cells.keys()) {
      const [x, y, z] = k.split(',').map(Number);
      min = min ? [Math.min(min[0], x), Math.min(min[1], y), Math.min(min[2], z)] : [x, y, z];
      max = max ? [Math.max(max[0], x), Math.max(max[1], y), Math.max(max[2], z)] : [x, y, z];
    }
    return min && max ? { min, max } : null;
  }

  /**
   * Enumerate chunks in [originMin, originMax] (inclusive, in cell coords)
   * that contain any occupied cell. Used for a full mesh rebuild.
   */
  chunkOriginsInRegion(min, max) {
    const s = this.chunkSize;
    const out = new Set();
    this.forEachCell((x, y, z) => {
      if (x < min[0] || x > max[0] || y < min[1] || y > max[1] || z < min[2] || z > max[2]) return;
      out.add(this.chunkKey(x, y, z));
    });
    return [...out].map((k) => this.chunkOrigin(k));
  }
}
