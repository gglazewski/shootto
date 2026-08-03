// LightField.js — dense light propagation (sky light + block light).
//
// Pure module with no three.js or DOM dependency, so it can be unit tested
// in Node. Mirrors the voxel world as three dense typed arrays sized to the
// world bounds plus a MARGIN:
//   - lightData   (Uint8Array)  one byte per cell: sky<<4 | block
//   - opacityData (Uint8Array)  1 = blocks light (opaque), 0 = lets it pass
//   - heightMap   (Int16Array)  topmost opaque y per (x,z) column
//
// skylight: 15 = exposed to open sky, 0 = sealed. Light pours straight down
// open shafts without decay and fades by 1 per cell in any other direction.
// Opaque voxels stop it; transparent ones (glass) let it through.
// blocklight: 0..15 emitted by emissive voxels (torches), fades 1 per cell.
//
// Full recomputes (recompute) are used on load/clear/bulk edits. Single edits
// go through recomputeEdit, which re-derives only a MARGIN-wide box around the
// edit and re-floods it, keeping per-edit cost independent of world size.

import { opacityFor, lightFor } from './VoxelTypes.js';
import { cellsFor } from './VoxelShape.js';

export const MAX_LIGHT = 15;
/** Padding around the world bounds; one more than the light range, so a
 *  recomputeEdit box surface is beyond any edit's reach and its saved light
 *  values remain valid as external inflow sources. */
export const MARGIN = MAX_LIGHT + 1;

/** Int16 sentinel for "no opaque voxel in this column". */
const NONE = -32768;

const NEIGHBORS = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
];
const COL_NEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export class LightField {
  constructor(world) {
    this.world = world;
    /** @type {Uint8Array} sky<<4|block per cell */
    this.lightData = new Uint8Array(0);
    /** @type {Uint8Array} 1 = opaque (blocks light) */
    this.opacityData = new Uint8Array(0);
    /** @type {Int16Array} topmost opaque y per column */
    this.heightMap = new Int16Array(0);
    /** @type {{min:[number,number,number], max:[number,number,number]}|null} */
    this.region = null;
    this._ox = this._oy = this._oz = 0;
    this._sx = this._sy = this._sz = 1;
    /** Item light sources: [{x,y,z,level}] in cell units. Supplied by the App
     *  from placed items; seeded alongside torch block light. The item light
     *  color is not carried here — the block channel is a single intensity
     *  (tinted warm by the shader). */
    this.itemLights = [];
    /** Monotonic version bumped on every light recompute/clear, so renderers
     *  of dynamic geometry (placeable objects) know when to re-bake light. */
    this.version = 0;
  }

  /** Replace the item light source list (cell coords + 0..15 level). */
  setItemLights(lights) {
    this.itemLights = lights ?? [];
  }

  _idx(x, y, z) {
    return (x - this._ox) + (z - this._oz) * this._sx + (y - this._oy) * this._sx * this._sz;
  }

  _colIdx(x, z) {
    return (x - this._ox) + (z - this._oz) * this._sx;
  }

  _inRegion(x, y, z) {
    return x >= this._ox && x <= this._ox + this._sx - 1 &&
           y >= this._oy && y <= this._oy + this._sy - 1 &&
           z >= this._oz && z <= this._oz + this._sz - 1;
  }

  /** Sky light 0..15 at a cell. Out-of-region reads return 0. */
  skyAt(x, y, z) {
    return this.lightData[this._idx(x, y, z)] >> 4;
  }

  /** Block light 0..15 at a cell. Out-of-region reads return 0. */
  blockAt(x, y, z) {
    return this.lightData[this._idx(x, y, z)] & 0xf;
  }

  /** Light at a cell. Out-of-region cells default to zero. */
  get(x, y, z) {
    return { sky: this.skyAt(x, y, z), block: this.blockAt(x, y, z) };
  }

  /** Drop all storage (empty world). */
  clear() {
    this.lightData = new Uint8Array(0);
    this.opacityData = new Uint8Array(0);
    this.heightMap = new Int16Array(0);
    this.region = null;
    this.version++;
  }

  /** Reallocate arrays for the current world bounds. */
  _alloc(b) {
    this._ox = b.min[0] - MARGIN;
    this._oy = b.min[1] - MARGIN;
    this._oz = b.min[2] - MARGIN;
    this._sx = b.max[0] - b.min[0] + 1 + 2 * MARGIN;
    this._sy = b.max[1] - b.min[1] + 1 + 2 * MARGIN;
    this._sz = b.max[2] - b.min[2] + 1 + 2 * MARGIN;
    this.lightData = new Uint8Array(this._sx * this._sy * this._sz);
    this.opacityData = new Uint8Array(this._sx * this._sy * this._sz);
    this.heightMap = new Int16Array(this._sx * this._sz).fill(NONE);
    this.region = { min: [this._ox, this._oy, this._oz], max: [this._ox + this._sx - 1, this._oy + this._sy - 1, this._oz + this._sz - 1] };
  }

  /** Build opacityData + heightMap from the world's occupied cells. */
  _buildOccupancy() {
    for (const [k, v] of this.world.cells) {
      if (opacityFor(v.type) < 255) continue;
      const [x, y, z] = k.split(',').map(Number);
      this.opacityData[this._idx(x, y, z)] = 1;
      const ci = this._colIdx(x, z);
      if (y > this.heightMap[ci]) this.heightMap[ci] = y;
    }
  }

  /** Topmost opaque y in column (x,z) by scanning the opacity mirror. */
  _scanTop(x, z) {
    for (let y = this._oy + this._sy - 1; y >= this._oy; y--) {
      if (this.opacityData[this._idx(x, y, z)]) return y;
    }
    return NONE;
  }

  /** True when a sky cell at (x,y,z) has a horizontal neighbor column whose
   *  top is at or above this height (i.e. it borders shadow and can spread). */
  _skySpreads(x, y, z) {
    for (const [dx, dz] of COL_NEIGHBORS) {
      const nci = this._colIdx(x + dx, z + dz);
      if (nci < 0 || nci >= this.heightMap.length) return true;
      if (y <= this.heightMap[nci]) return true;
    }
    return false;
  }

  /** Full recompute of the whole light field from current world state. */
  recompute() {
    this.version++;
    this.clear();
    const b = this.world.bounds();
    if (!b) return;
    this._alloc(b);
    this._buildOccupancy();
    this._seedSky();
    this._seedBlock();
  }

  /**
   * Write sky=MAX to every sky-exposed cell (above its column's top) and flood.
   * Only boundary sky cells are enqueued as sources: interior open sky has
   * nothing to spread to, so a flat field costs a few writes, not a full flood.
   */
  _seedSky() {
    const queue = [];
    const { _ox, _oy, _oz, _sx, _sz } = this;
    const mx = this._ox + this._sx - 1;
    const my = this._oy + this._sy - 1;
    const mz = this._oz + this._sz - 1;
    for (let x = _ox; x <= mx; x++) {
      for (let z = _oz; z <= mz; z++) {
        const top = this.heightMap[this._colIdx(x, z)];
        const start = Math.max(top + 1, _oy);
        for (let y = start; y <= my; y++) {
          const i = this._idx(x, y, z);
          this.lightData[i] = (MAX_LIGHT << 4) | (this.lightData[i] & 0xf);
          if (this._skySpreads(x, y, z)) queue.push(x, y, z);
        }
      }
    }
    this._flood(queue, true);
  }

  /** Seed block light from emissive voxels and flood. */
  _seedBlock() {
    const queue = [];
    this.world.forEachVoxel((voxel) => {
      const lvl = lightFor(voxel.type);
      if (lvl <= 0) return;
      for (const [cx, cy, cz] of cellsFor(voxel.anchor[0], voxel.anchor[1], voxel.anchor[2], voxel.size)) {
        if (!this._inRegion(cx, cy, cz)) continue;
        const k = this._idx(cx, cy, cz);
        const cur = this.lightData[k];
        if (lvl > (cur & 0xf)) {
          this.lightData[k] = ((cur >> 4) << 4) | lvl;
          queue.push(cx, cy, cz);
        }
      }
    });
    this._seedItemLights(queue);
    this._flood(queue, false);
  }

  /** Seed block light from placed item light sources (full region pass). */
  _seedItemLights(queue) {
    for (const { x, y, z, level } of this.itemLights) {
      if (level <= 0 || !this._inRegion(x, y, z)) continue;
      const k = this._idx(x, y, z);
      const cur = this.lightData[k];
      if (level > (cur & 0xf)) {
        this.lightData[k] = ((cur >> 4) << 4) | level;
        queue.push(x, y, z);
      }
    }
  }

  /**
   * Multi-source flood fill over the whole region. `isSky` gives downward
   * no-decay (open shafts stay lit to the bottom); otherwise uniform decay.
   * Opaque voxels are impassable.
   * @param {number[]} queue  flat [x,y,z,...] seed list
   */
  _flood(queue, isSky) {
    const { lightData, opacityData, _ox, _oy, _oz } = this;
    const mx = this._ox + this._sx - 1;
    const my = this._oy + this._sy - 1;
    const mz = this._oz + this._sz - 1;
    let i = 0;
    while (i < queue.length) {
      const x = queue[i++], y = queue[i++], z = queue[i++];
      const cur = lightData[this._idx(x, y, z)];
      const lvl = isSky ? cur >> 4 : cur & 0xf;
      if (lvl <= 0) continue;
      for (const [dx, dy, dz] of NEIGHBORS) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (nx < _ox || nx > mx || ny < _oy || ny > my || nz < _oz || nz > mz) continue;
        const nk = this._idx(nx, ny, nz);
        if (opacityData[nk]) continue;
        let next = lvl - 1;
        if (isSky && dy === -1) next = lvl;
        if (next <= 0) continue;
        const nc = lightData[nk];
        if (isSky ? next > (nc >> 4) : next > (nc & 0xf)) {
          lightData[nk] = isSky ? (next << 4) | (nc & 0xf) : ((nc >> 4) << 4) | next;
          queue.push(nx, ny, nz);
        }
      }
    }
  }

  /**
   * Incremental update for a batch of small edits (a few voxels). Only the
   * MARGIN-wide box around the edited cells is re-derived; the box surface is
   * restored from its pre-edit values so external light keeps flowing in.
   * Falls back to a full recompute when the edits are too many/spread out or
   * the world outgrew the current arrays.
   * @param {Array<{cells:[number,number,number][], remove:boolean}>} edits
   */
  recomputeEdit(edits) {
    if (!this.region || edits.length > 8) {
      this.recompute();
      return;
    }
    this.version++;
    let ex0 = Infinity, ey0 = Infinity, ez0 = Infinity;
    let ex1 = -Infinity, ey1 = -Infinity, ez1 = -Infinity;
    for (const e of edits) {
      for (const [x, y, z] of e.cells) {
        if (x < ex0) ex0 = x; if (x > ex1) ex1 = x;
        if (y < ey0) ey0 = y; if (y > ey1) ey1 = y;
        if (z < ez0) ez0 = z; if (z > ez1) ez1 = z;
      }
    }
    if (!this._inRegion(ex0, ey0, ez0) || !this._inRegion(ex1, ey1, ez1)) {
      this.recompute();
      return;
    }

    // Patch the opacity mirror + heightmap for the edited cells/columns.
    const editedCols = new Set();
    for (const e of edits) {
      const blocking = e.remove ? 0 : (opacityFor(e.type) >= 255 ? 1 : 0);
      for (const [x, y, z] of e.cells) {
        this.opacityData[this._idx(x, y, z)] = blocking;
        editedCols.add(this._colIdx(x, z));
      }
    }
    for (const ci of editedCols) {
      const colX = this._ox + (ci % this._sx);
      const colZ = this._oz + ((ci / this._sx) | 0);
      this.heightMap[ci] = this._scanTop(colX, colZ);
    }

    // Bounded box around the edits, clamped to the region.
    const bx0 = Math.max(ex0 - MARGIN, this._ox), by0 = Math.max(ey0 - MARGIN, this._oy), bz0 = Math.max(ez0 - MARGIN, this._oz);
    const bx1 = Math.min(ex1 + MARGIN, this._ox + this._sx - 1), by1 = Math.min(ey1 + MARGIN, this._oy + this._sy - 1), bz1 = Math.min(ez1 + MARGIN, this._oz + this._sz - 1);

    // Snapshot the box surface (light inflow from beyond the box), then clear.
    const shell = [];
    for (let x = bx0; x <= bx1; x++) {
      for (let y = by0; y <= by1; y++) {
        for (let z = bz0; z <= bz1; z++) {
          if (x === bx0 || x === bx1 || y === by0 || y === by1 || z === bz0 || z === bz1) {
            shell.push(x, y, z, this.lightData[this._idx(x, y, z)]);
          }
        }
      }
    }
    for (let x = bx0; x <= bx1; x++) {
      for (let y = by0; y <= by1; y++) {
        for (let z = bz0; z <= bz1; z++) this.lightData[this._idx(x, y, z)] = 0;
      }
    }

    // Re-seed direct sky inside the box.
    const skyQueue = [];
    for (let x = bx0; x <= bx1; x++) {
      for (let z = bz0; z <= bz1; z++) {
        const top = this.heightMap[this._colIdx(x, z)];
        const start = Math.max(top + 1, by0);
        for (let y = start; y <= by1; y++) {
          const k = this._idx(x, y, z);
          this.lightData[k] = (MAX_LIGHT << 4) | (this.lightData[k] & 0xf);
          if (this._skySpreads(x, y, z)) skyQueue.push(x, y, z);
        }
      }
    }

    // Re-seed block light sources inside the box.
    const blockQueue = [];
    this.world.forEachVoxel((voxel) => {
      const lvl = lightFor(voxel.type);
      if (lvl <= 0) return;
      for (const [cx, cy, cz] of cellsFor(voxel.anchor[0], voxel.anchor[1], voxel.anchor[2], voxel.size)) {
        if (cx < bx0 || cx > bx1 || cy < by0 || cy > by1 || cz < bz0 || cz > bz1) continue;
        const k = this._idx(cx, cy, cz);
        const cur = this.lightData[k];
        if (lvl > (cur & 0xf)) {
          this.lightData[k] = ((cur >> 4) << 4) | lvl;
          blockQueue.push(cx, cy, cz);
        }
      }
    });

    // Re-seed item light sources inside the box too.
    for (const { x, y, z, level } of this.itemLights) {
      if (level <= 0 || x < bx0 || x > bx1 || y < by0 || y > by1 || z < bz0 || z > bz1) continue;
      const k = this._idx(x, y, z);
      const cur = this.lightData[k];
      if (level > (cur & 0xf)) {
        this.lightData[k] = ((cur >> 4) << 4) | level;
        blockQueue.push(x, y, z);
      }
    }

    // Restore the surface as inflow sources, then flood the box.
    for (let s = 0; s < shell.length; s += 4) {
      const x = shell[s], y = shell[s + 1], z = shell[s + 2], v = shell[s + 3];
      this.lightData[this._idx(x, y, z)] = v;
      skyQueue.push(x, y, z);
      blockQueue.push(x, y, z);
    }
    this._floodBox(skyQueue, true, bx0, by0, bz0, bx1, by1, bz1);
    this._floodBox(blockQueue, false, bx0, by0, bz0, bx1, by1, bz1);
  }

  /** Flood fill restricted to a box (writes clamped to the box bounds). */
  _floodBox(queue, isSky, bx0, by0, bz0, bx1, by1, bz1) {
    const { lightData, opacityData } = this;
    let i = 0;
    while (i < queue.length) {
      const x = queue[i++], y = queue[i++], z = queue[i++];
      const cur = lightData[this._idx(x, y, z)];
      const lvl = isSky ? cur >> 4 : cur & 0xf;
      if (lvl <= 0) continue;
      for (const [dx, dy, dz] of NEIGHBORS) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (nx < bx0 || nx > bx1 || ny < by0 || ny > by1 || nz < bz0 || nz > bz1) continue;
        const nk = this._idx(nx, ny, nz);
        if (opacityData[nk]) continue;
        let next = lvl - 1;
        if (isSky && dy === -1) next = lvl;
        if (next <= 0) continue;
        const nc = lightData[nk];
        if (isSky ? next > (nc >> 4) : next > (nc & 0xf)) {
          lightData[nk] = isSky ? (next << 4) | (nc & 0xf) : ((nc >> 4) << 4) | next;
          queue.push(nx, ny, nz);
        }
      }
    }
  }
}
