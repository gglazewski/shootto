// LightField.js — dense light propagation (sky light + block light).
//
// Pure module with no three.js or DOM dependency, so it can be unit tested
// in Node. Mirrors the voxel world as three dense typed arrays sized to the
// world bounds plus a MARGIN:
//   - lightData   (Uint8Array)  one byte per cell: sky<<4 | block
//   - opacityData (Uint8Array)  see OPEN/OPAQUE/SLAB_* below
//   - heightMap   (Int16Array)  topmost sky-blocking y per (x,z) column
//
// Half slabs fill only half a cell, so a cell is not simply open or blocked:
// a slab cell still HOLDS light (its other half is air) but blocks passage
// through the solid half. opacityData carries that as four states, and
// `passes()` decides each cell-to-cell step from the pair.
//
// skylight: 15 = exposed to open sky, 0 = sealed. Light pours straight down
// open shafts without decay and fades by 1 per cell in any other direction
// (flood fill). Opaque voxels stop it; transparent ones (glass) let it pass.
// blocklight: 0..15 emitted by emissive voxels/items, STAMPED per source
// with line-of-sight occlusion (level - manhattan distance, only where the
// source can see) — walls cast hard shadows and light never wraps around
// thin geometry onto its far side.
//
// Full recomputes (recompute) are used on load/clear/bulk edits. Single edits
// go through recomputeEdit, which re-derives only a MARGIN-wide box around the
// edit and re-floods it, keeping per-edit cost independent of world size.

import { opacityFor, lightFor, emitFacesFor } from './VoxelTypes.js';
import { cellsFor, spanFor, cellFillFor } from './VoxelShape.js';
import { effectiveLightMode } from './Lights.js';
import { CONFIG } from '../config.js';

export const MAX_LIGHT = 15;
/** Padding around the world bounds; one more than the light range, so a
 *  recomputeEdit box surface is beyond any edit's reach and its saved light
 *  values remain valid as external inflow sources. */
export const MARGIN = MAX_LIGHT + 1;

/** Int16 sentinel for "no opaque voxel in this column". */
const NONE = -32768;

/** Fraction of a flickering lamp's level baked into the field; the rest is
 *  a dynamic shader light driven per frame (see Blinkers.lampLights). */
const FLICKER_BAKED = CONFIG.lighting.flickerBakedLevel ?? 0.55;

/** Indirect-fill fraction (see CONFIG.lighting.blockBounce): each direct-lit
 *  cell leaks floor(level * BOUNCE) into adjacent darker cells, and the leak
 *  spreads as a decay-1 flood. Kept below 0.5 so a source's bounce never
 *  reaches farther than its direct stamp (d + floor((L-d)*BOUNCE) <= L-1 for
 *  all d), which keeps the MARGIN reach invariant intact. */
const BOUNCE = Math.min(0.49, CONFIG.lighting.blockBounce ?? 0.35);

// opacityData states. A slab cell is half solid, half air: it holds light
// like an open cell, but seals the side its solid half sits on.
const OPEN = 0;
const OPAQUE = 1;
const SLAB_LOWER = 2; // solid bottom half — air on top, sealed underneath
const SLAB_UPPER = 3; // solid top half — air below, sealed above
const CODE_FOR_FILL = { none: OPEN, full: OPAQUE, lower: SLAB_LOWER, upper: SLAB_UPPER };

/** True when a slab's solid half sits between two vertically adjacent cells
 *  (dy = +1 going up). Kept separate from `passes` so line-of-sight can test
 *  the barrier without also rejecting its own (opaque) source cell. */
function slabBlocks(a, b, dy) {
  return dy > 0 ? (a === SLAB_UPPER || b === SLAB_LOWER)
                : (a === SLAB_LOWER || b === SLAB_UPPER);
}

/**
 * True when light can cross from a cell in state `a` to the adjacent cell in
 * state `b`, stepping `dy` in y. Horizontally, a lower slab and an upper slab
 * meet solid-to-air with no overlap between their open halves, so nothing
 * passes there either.
 */
function passes(a, b, dy) {
  if (a === OPAQUE || b === OPAQUE) return false;
  if (dy !== 0) return !slabBlocks(a, b, dy);
  return !((a === SLAB_LOWER && b === SLAB_UPPER) || (a === SLAB_UPPER && b === SLAB_LOWER));
}

const NEIGHBORS = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
];
const COL_NEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Outward normal per face name (for directional emitters). */
const FACE_NORMALS = {
  px: [1, 0, 0], nx: [-1, 0, 0],
  py: [0, 1, 0], ny: [0, -1, 0],
  pz: [0, 0, 1], nz: [0, 0, -1],
};

export class LightField {
  constructor(world) {
    this.world = world;
    /** @type {Uint8Array} sky<<4|block per cell */
    this.lightData = new Uint8Array(0);
    /** @type {Uint8Array} DIRECT (line-of-sight stamped) block light only,
     *  before the bounce pass. The nibble in lightData holds the final
     *  max(direct, bounce); bounce seeds are derived from this array so
     *  bounced light never re-bounces, and incremental box updates can tell
     *  direct from bounced light at their boundary. */
    this.blockDirect = new Uint8Array(0);
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
    /** The box (cell coords, inclusive) the most recent recomputeEdit
      *  actually touched, so consumers can re-bake only the geometry inside
      *  it. Null after a full recompute/clear (everything may have changed). */
    this.lastBox = null;
    /** Precise box list of the most recent recomputeEdit (far-apart edits get
      *  separate boxes); lastBox is their union. Null after full recompute. */
    this.lastBoxes = null;
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
    this.blockDirect = new Uint8Array(0);
    this.opacityData = new Uint8Array(0);
    this.heightMap = new Int16Array(0);
    this.region = null;
    this.lastBox = null;
    this.lastBoxes = null;
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
    this.blockDirect = new Uint8Array(this._sx * this._sy * this._sz);
    this.opacityData = new Uint8Array(this._sx * this._sy * this._sz);
    this.heightMap = new Int16Array(this._sx * this._sz).fill(NONE);
    this.region = { min: [this._ox, this._oy, this._oz], max: [this._ox + this._sx - 1, this._oy + this._sy - 1, this._oz + this._sz - 1] };
  }

  /** Opacity state of one cell, read from the world. */
  _cellCode(x, y, z) {
    const v = this.world.get(x, y, z);
    if (!v || opacityFor(v.type) < 255) return OPEN;
    return CODE_FOR_FILL[cellFillFor(v, y)];
  }

  /** Highest y a cell in state `code` at height y leaves in shadow. A lower
   *  slab's own cell is open on top, so direct sky still reaches into it. */
  _shadowTop(code, y) {
    return code === SLAB_LOWER ? y - 1 : y;
  }

  /** Build opacityData + heightMap from the world's occupied cells. */
  _buildOccupancy() {
    this.world.forEachCell((x, y, z, v) => {
      if (opacityFor(v.type) < 255) return;
      const code = CODE_FOR_FILL[cellFillFor(v, y)];
      if (code === OPEN) return; // carved-away layer of a BIG slab
      this.opacityData[this._idx(x, y, z)] = code;
      const ci = this._colIdx(x, z);
      const top = this._shadowTop(code, y);
      if (top > this.heightMap[ci]) this.heightMap[ci] = top;
    });
  }

  /** Topmost sky-blocking y in column (x,z) by scanning the opacity mirror. */
  _scanTop(x, z) {
    for (let y = this._oy + this._sy - 1; y >= this._oy; y--) {
      const code = this.opacityData[this._idx(x, y, z)];
      if (code !== OPEN) return this._shadowTop(code, y);
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
    this._bounceBlock(
      this._ox, this._oy, this._oz,
      this._ox + this._sx - 1, this._oy + this._sy - 1, this._oz + this._sz - 1,
    );
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

  /**
   * Cells an emissive voxel seeds. Omnidirectional emitters (no emitFaces)
   * seed their own cells, so light escapes every open face. Directional
   * emitters seed the cells just OUTSIDE their listed faces instead — and
   * only where those cells are not sealed by an opaque block — so a ceiling
   * panel embedded flush in a roof lights the room below and nothing above.
   * @returns {[number,number,number][]}
   */
  _emissionCells(voxel) {
    const faces = emitFacesFor(voxel.type);
    const [ax, ay, az] = voxel.anchor;
    if (!faces) return [...cellsFor(ax, ay, az, voxel.size, voxel.rotation ?? 0)];
    const span = spanFor(voxel.size);
    const out = [];
    for (const face of faces) {
      const n = FACE_NORMALS[face];
      if (!n) continue;
      for (const [cx, cy, cz] of cellsFor(ax, ay, az, voxel.size)) {
        // only the footprint cells on that face's outer layer emit
        if (n[0] === 1 && cx !== ax + span - 1) continue;
        if (n[0] === -1 && cx !== ax) continue;
        if (n[1] === 1 && cy !== ay + span - 1) continue;
        if (n[1] === -1 && cy !== ay) continue;
        if (n[2] === 1 && cz !== az + span - 1) continue;
        if (n[2] === -1 && cz !== az) continue;
        const tx = cx + n[0], ty = cy + n[1], tz = cz + n[2];
        if (this._cellCode(tx, ty, tz) === OPAQUE) continue; // face sealed
        out.push([tx, ty, tz]);
      }
    }
    return out;
  }

  /** Every block-light source cell: emissive voxels (respecting their
   *  emitFaces) plus placed item lights. @returns {[x,y,z,level][]} */
  _collectBlockSources() {
    const sources = [];
    this.world.forEachVoxel((voxel) => {
      let lvl = lightFor(voxel.type);
      if (lvl <= 0) return;
      // Flickering lamps bake dim: the remainder rides on a dynamic shader
      // light that gutters per frame (Blinkers.lampLights), so the field
      // only re-floods on real blackouts, never while the lamp chatters.
      if (effectiveLightMode(voxel) === 'flicker') lvl = Math.max(1, Math.round(lvl * FLICKER_BAKED));
      for (const [cx, cy, cz] of this._emissionCells(voxel)) sources.push([cx, cy, cz, lvl]);
    });
    for (const { x, y, z, level } of this.itemLights) {
      if (level > 0) sources.push([x, y, z, level]);
    }
    return sources;
  }

  /**
   * Block light is STAMPED with line-of-sight occlusion, not flooded: each
   * source lights exactly the cells it can see (level - manhattan distance),
   * so walls cast real shadows and light never wraps around thin geometry
   * onto the far side. Sky light keeps the flood (soft daylight).
   */
  _seedBlock() {
    for (const [sx, sy, sz, lvl] of this._collectBlockSources()) {
      this._stampSource(
        sx, sy, sz, lvl,
        this._ox, this._oy, this._oz,
        this._ox + this._sx - 1, this._oy + this._sy - 1, this._oz + this._sz - 1,
      );
    }
  }

  /** Stamp one source's light into (the box-clamped part of) its range. */
  _stampSource(sx, sy, sz, level, bx0, by0, bz0, bx1, by1, bz1) {
    if (!this._inRegion(sx, sy, sz)) return;
    const r = level - 1;
    const x0 = Math.max(sx - r, bx0), x1 = Math.min(sx + r, bx1);
    const y0 = Math.max(sy - r, by0), y1 = Math.min(sy + r, by1);
    const z0 = Math.max(sz - r, bz0), z1 = Math.min(sz + r, bz1);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          const v = level - (Math.abs(x - sx) + Math.abs(y - sy) + Math.abs(z - sz));
          if (v <= 0) continue;
          const k = this._idx(x, y, z);
          if (this.opacityData[k] === OPAQUE && !(x === sx && y === sy && z === sz)) continue;
          const cur = this.lightData[k];
          if (v <= this.blockDirect[k] && v <= (cur & 0xf)) continue;
          if (!this._los(sx, sy, sz, x, y, z)) continue;
          // blockDirect is written on its own guard: after an edit-box clear
          // the nibble may hold restored (bounced) light that is brighter
          // than v, but the direct record still has to be rebuilt.
          if (v > this.blockDirect[k]) this.blockDirect[k] = v;
          if (v > (cur & 0xf)) this.lightData[k] = ((cur >> 4) << 4) | v;
        }
      }
    }
  }

  /** Line of sight between two cell centers: false when any cell along the
   *  segment (excluding the endpoints) is opaque, or when the walk steps
   *  vertically through a slab's solid half — a slab floor shadows the room
   *  below it even though its own cell still takes light. Endpoints keep
   *  their exemption (an emissive block lights its own surroundings). */
  _los(sx, sy, sz, tx, ty, tz) {
    const dx = tx - sx, dy = ty - sy, dz = tz - sz;
    const n = (Math.abs(dx) + Math.abs(dy) + Math.abs(dz)) * 2;
    if (n <= 2) return true;
    let px = sx, py = sy, pz = sz;
    let pcode = this.opacityData[this._idx(sx, sy, sz)];
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const cx = Math.round(sx + dx * t);
      const cy = Math.round(sy + dy * t);
      const cz = Math.round(sz + dz * t);
      if (cx === px && cy === py && cz === pz) continue;
      const code = this.opacityData[this._idx(cx, cy, cz)];
      const endpoint = (cx === sx && cy === sy && cz === sz) || (cx === tx && cy === ty && cz === tz);
      if (!endpoint && code === OPAQUE) return false;
      if (cy !== py && slabBlocks(pcode, code, cy - py)) return false;
      px = cx; py = cy; pz = cz; pcode = code;
    }
    return true;
  }

  /**
   * Bounce pass for the block channel, run after stamping over the given box
   * (inclusive cell coords). The line-of-sight stamp is binary — a cell
   * either sees a source or gets nothing — so shadow boundaries are 1-cell
   * cliffs and the far side of thin geometry is pitch black. Here every
   * direct-lit cell leaks floor(direct * BOUNCE) into any passable adjacent
   * cell the stamp left darker, and the leak spreads as a decay-1 flood:
   * shadows stay shadows, but get a soft penumbra and concave corners get a
   * dim indirect fill, like light bouncing off the lit surfaces.
   *
   * Seeds are derived from blockDirect — never from already-bounced light —
   * so there is exactly one bounce generation, and writes only ever RAISE
   * the nibble, so direct light is untouched.
   *
   * The seed scan runs over the box grown by one cell, and ring cells whose
   * final value exceeds their direct value (bounce-dominated inflow) are
   * enqueued as flood sources. Together these reproduce inside the box
   * exactly what a full-region pass computes — recomputeEdit relies on this
   * to stay equal to a full recompute.
   */
  _bounceBlock(bx0, by0, bz0, bx1, by1, bz1) {
    if (BOUNCE <= 0) return;
    const queue = [];
    const gx0 = Math.max(bx0 - 1, this._ox), gy0 = Math.max(by0 - 1, this._oy), gz0 = Math.max(bz0 - 1, this._oz);
    const gx1 = Math.min(bx1 + 1, this._ox + this._sx - 1);
    const gy1 = Math.min(by1 + 1, this._oy + this._sy - 1);
    const gz1 = Math.min(bz1 + 1, this._oz + this._sz - 1);
    for (let x = gx0; x <= gx1; x++) {
      for (let y = gy0; y <= gy1; y++) {
        for (let z = gz0; z <= gz1; z++) {
          const k = this._idx(x, y, z);
          const direct = this.blockDirect[k];
          const inBox = x >= bx0 && x <= bx1 && y >= by0 && y <= by1 && z >= bz0 && z <= bz1;
          if (!inBox && (this.lightData[k] & 0xf) > direct) {
            // ring cell already carrying bounced light: unchanged inflow
            queue.push(x, y, z);
            continue;
          }
          const v = (direct * BOUNCE) | 0;
          if (v <= 0) continue;
          const here = this.opacityData[k];
          for (const [dx, dy, dz] of NEIGHBORS) {
            const nx = x + dx, ny = y + dy, nz = z + dz;
            if (nx < bx0 || nx > bx1 || ny < by0 || ny > by1 || nz < bz0 || nz > bz1) continue;
            const nk = this._idx(nx, ny, nz);
            if (!passes(here, this.opacityData[nk], dy)) continue;
            const nc = this.lightData[nk];
            if (v <= (nc & 0xf)) continue;
            this.lightData[nk] = ((nc >> 4) << 4) | v;
            queue.push(nx, ny, nz);
          }
        }
      }
    }
    this._floodBox(queue, false, bx0, by0, bz0, bx1, by1, bz1);
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
      const k = this._idx(x, y, z);
      const cur = lightData[k];
      const lvl = isSky ? cur >> 4 : cur & 0xf;
      if (lvl <= 0) continue;
      const here = opacityData[k];
      for (const [dx, dy, dz] of NEIGHBORS) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (nx < _ox || nx > mx || ny < _oy || ny > my || nz < _oz || nz > mz) continue;
        const nk = this._idx(nx, ny, nz);
        if (!passes(here, opacityData[nk], dy)) continue;
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
   * Incremental update for a batch of small edits (a few voxels). Only
   * MARGIN-wide boxes around the edited cells are re-derived; each box
   * surface is restored from its pre-edit values so external light keeps
   * flowing in. Far-apart edits get separate boxes, so three distant lamps
   * blinking cost three small updates, not one giant box spanning the map.
   *
   * Emission-only edits (a `prevType` is given and its opacity matches the
   * new type — e.g. blinking lights swapping lit/dark phases) take a fast
   * path: opacity and sky light cannot have changed, so only the block
   * channel is cleared and re-stamped inside the boxes.
   *
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

    const emissionOnly = edits.every((e) =>
      !e.remove && e.prevType != null && opacityFor(e.prevType) === opacityFor(e.type));

    if (!emissionOnly) {
      // Patch the opacity mirror + heightmap for the edited cells/columns.
      // Read the new state back from the world rather than from e.type: the
      // record carries no variant, and a slab fills only part of its cell.
      const editedCols = new Set();
      for (const e of edits) {
        for (const [x, y, z] of e.cells) {
          this.opacityData[this._idx(x, y, z)] = this._cellCode(x, y, z);
          editedCols.add(this._colIdx(x, z));
        }
      }
      for (const ci of editedCols) {
        const colX = this._ox + (ci % this._sx);
        const colZ = this._oz + ((ci / this._sx) | 0);
        this.heightMap[ci] = this._scanTop(colX, colZ);
      }
    }

    const boxes = this._editBoxes(edits);
    // Consumers that can only handle one box see the union; the precise list
    // lives in lastBoxes (relighting/rebaking can test either).
    this.lastBox = boxes.reduce((u, b) => [
      Math.min(u[0], b[0]), Math.min(u[1], b[1]), Math.min(u[2], b[2]),
      Math.max(u[3], b[3]), Math.max(u[4], b[4]), Math.max(u[5], b[5]),
    ]);
    this.lastBoxes = boxes;

    // Block sources are re-stamped into every box; collect them once.
    const sources = this._collectBlockSources();

    for (const [bx0, by0, bz0, bx1, by1, bz1] of boxes) {
      if (emissionOnly) {
        // Sky light is untouched — drop only the stale block channel.
        for (let x = bx0; x <= bx1; x++) {
          for (let y = by0; y <= by1; y++) {
            for (let z = bz0; z <= bz1; z++) {
              const k = this._idx(x, y, z);
              this.lightData[k] &= 0xf0;
              this.blockDirect[k] = 0;
            }
          }
        }
      } else {
        this._refloodSkyBox(bx0, by0, bz0, bx1, by1, bz1);
      }
      // Re-stamp block light: every source whose range can touch the box
      // (including sources OUTSIDE it) writes its line-of-sight light into
      // the box-clamped part of its radius.
      for (const [sx, sy, sz, lvl] of sources) {
        if (sx + lvl < bx0 || sx - lvl > bx1 || sy + lvl < by0 || sy - lvl > by1 || sz + lvl < bz0 || sz - lvl > bz1) continue;
        this._stampSource(sx, sy, sz, lvl, bx0, by0, bz0, bx1, by1, bz1);
      }
      this._bounceBlock(bx0, by0, bz0, bx1, by1, bz1);
    }
  }

  /** ±MARGIN boxes around each edit, clamped to the region, with overlapping
   *  boxes merged — distant edits stay separate, nearby ones coalesce. */
  _editBoxes(edits) {
    const boxes = [];
    for (const e of edits) {
      let x0 = Infinity, y0 = Infinity, z0 = Infinity;
      let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (const [x, y, z] of e.cells) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      boxes.push([
        Math.max(x0 - MARGIN, this._ox), Math.max(y0 - MARGIN, this._oy), Math.max(z0 - MARGIN, this._oz),
        Math.min(x1 + MARGIN, this._ox + this._sx - 1), Math.min(y1 + MARGIN, this._oy + this._sy - 1), Math.min(z1 + MARGIN, this._oz + this._sz - 1),
      ]);
    }
    let merged = true;
    while (merged) {
      merged = false;
      outer: for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i], b = boxes[j];
          if (a[0] <= b[3] && b[0] <= a[3] && a[1] <= b[4] && b[1] <= a[4] && a[2] <= b[5] && b[2] <= a[5]) {
            boxes[i] = [
              Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]),
              Math.max(a[3], b[3]), Math.max(a[4], b[4]), Math.max(a[5], b[5]),
            ];
            boxes.splice(j, 1);
            merged = true;
            break outer;
          }
        }
      }
    }
    return boxes;
  }

  /** Re-derive sky light inside one box: snapshot the surface (light inflow
   *  from beyond), clear, re-seed direct sky, restore the surface and flood.
   *  The block channel is handled by the caller's source stamping. */
  _refloodSkyBox(bx0, by0, bz0, bx1, by1, bz1) {
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
        for (let z = bz0; z <= bz1; z++) {
          const k = this._idx(x, y, z);
          this.lightData[k] = 0;
          this.blockDirect[k] = 0;
        }
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

    // Restore the surface as sky inflow sources, then flood sky in the box.
    // (The shell's block nibble is also correct as-is: the box extends MARGIN
    // beyond the edit, farther than any block light can reach.)
    for (let s = 0; s < shell.length; s += 4) {
      const x = shell[s], y = shell[s + 1], z = shell[s + 2], v = shell[s + 3];
      this.lightData[this._idx(x, y, z)] = v;
      skyQueue.push(x, y, z);
    }
    this._floodBox(skyQueue, true, bx0, by0, bz0, bx1, by1, bz1);
  }

  /** Flood fill restricted to a box (writes clamped to the box bounds). */
  _floodBox(queue, isSky, bx0, by0, bz0, bx1, by1, bz1) {
    const { lightData, opacityData } = this;
    let i = 0;
    while (i < queue.length) {
      const x = queue[i++], y = queue[i++], z = queue[i++];
      const k = this._idx(x, y, z);
      const cur = lightData[k];
      const lvl = isSky ? cur >> 4 : cur & 0xf;
      if (lvl <= 0) continue;
      const here = opacityData[k];
      for (const [dx, dy, dz] of NEIGHBORS) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (nx < bx0 || nx > bx1 || ny < by0 || ny > by1 || nz < bz0 || nz > bz1) continue;
        const nk = this._idx(nx, ny, nz);
        if (!passes(here, opacityData[nk], dy)) continue;
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
