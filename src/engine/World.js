// World.js — sparse voxel storage.
//
// The internal grid unit is one SMALL cell = 0.5m in world space.
// A voxel occupies a cuboid of cells:
//   SMALL -> 1x1x1 starting at its anchor cell.
//   BIG   -> 2x2x2 starting at its anchor cell (anchor coords are even).
//
// Every occupied cell resolves to the same Voxel object, so a BIG voxel owns
// 8 entries. Lookup of any sub-cell returns the owning voxel in O(1).
//
// Cell storage is chunked: each non-empty chunk holds a dense ref array of
// chunkSize^3 slots addressed by numeric index, keyed by a packed numeric
// chunk coordinate. Compared to the old Map<"x,y,z", Voxel> this cuts memory
// roughly 5x (no per-cell key strings) and makes get() allocation-free —
// which matters because meshing, physics and raycasting all hammer it.

import { anchorFor, cellsFor } from './VoxelShape.js';
import { footprintCells, quarterTurns } from './ItemTypes.js';
import { DEFAULT_CHUNK_SIZE } from './Space.js';
import { getDecal, acceptsDecal, shapeFor, isBlockId, FACES } from './VoxelTypes.js';
import { FACE_TABLE, decalFootprint } from './ChunkMeshBuilder.js';
import { applyDoorSettings } from './Doors.js';
import { applyLightSettings } from './Lights.js';

export { DEFAULT_CHUNK_SIZE, anchorFor, cellsFor };

/**
 * @typedef {Object} Voxel
 * @property {string}  type
 * @property {'small'|'big'|'door'} size
 * @property {[number, number, number]} anchor
 */

const key = (x, y, z) => `${x},${y},${z}`;

// Packed numeric chunk key: 16 bits per axis (offset so negatives pack too),
// exact in a double up to ±32768 chunks per axis (±262 km). Numeric keys keep
// the hot cell path free of string allocation.
const CK_OFF = 32768;
const CK_SPAN = 65536;

export class World {
  /**
   * @param {number} [chunkSize] edge length of a chunk in small cells
   */
  constructor(chunkSize = DEFAULT_CHUNK_SIZE) {
    this.chunkSize = chunkSize;
    /** @type {Map<number, {arr: (Voxel|null)[], count: number, x0: number,
     *  y0: number, z0: number, ckey: string}>} packed chunk coord -> dense
     *  cell chunk (see the header comment). */
    this._cellChunks = new Map();
    /** One-entry chunk cache: consecutive get()s cluster heavily (meshing
     *  halo prefetch, physics sweeps), so the repeat lookup is a compare. */
    this._lastNk = NaN;
    this._lastChunk = null;
    /** @type {Map<string, Voxel>} anchorKey -> voxel. One entry per voxel (a
     *  BIG voxel is one entry, not 8), so iteration, counting and bounds are
     *  O(#voxels) instead of O(#cells) — the difference between a quick
     *  pass and a multi-second stall on huge worlds. */
    this.voxels = new Map();
    /** @type {Map<string, number>} chunkKey -> number of occupied cells in
     *  that chunk. Lets meshing/streaming skip empty chunks and enumerate
     *  only chunks with content without scanning every cell. */
    this.chunkCounts = new Map();
    /** @type {Map<string, [number,number,number]>} chunkKey -> chunk coords,
     *  kept in sync with chunkCounts so hot loops (renderer streaming) never
     *  re-parse the string keys. */
    this.chunkCoords = new Map();
    /** Set when place/remove/clear changed WHICH cells are occupied (type
     *  swaps like blinking lights don't). The renderer drains it to know when
     *  the set of streamable chunks may have changed. */
    this._occupancyChanged = false;
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
    /** NPC spawn points: cell key -> { type, x, y, z }. Same shape as mob
     *  spawns; `type` names an NpcRegistry def. The game's NPCManager reads
     *  them when a world loads. */
    this.npcSpawns = new Map();
    /** Decals pinned to voxel faces: `x,y,z,face` -> { decalId, cell, face,
     *  rotation }. A decal rides the face it is attached to (meshed into the
     *  chunk); removing the voxel removes its decals. */
    this.decals = new Map();
    /** @type {Map<string, Object<string,string>>} Face paint: cellKey ->
     *  { face -> blockId }. A painted face renders the source block's tile
     *  instead of its own; nothing else changes (opacity, light, collision
     *  and shape all still come from the voxel's own type). Stored per CELL
     *  and per face — one record per cell, so meshing costs a single map
     *  lookup per voxel instead of one per face. */
    this.paint = new Map();
    /** Painted faces in total. The mesher reads this to skip the paint path
     *  entirely on unpainted worlds (the common case), so the feature costs
     *  nothing until it is used. */
    this.paintCount = 0;
    /** Revision counters bumped on any paint/decal mutation. Consumers that
     *  index paint/decals by chunk (worker mesh snapshots) key their caches
     *  on these instead of re-scanning the maps per chunk. */
    this.paintRev = 0;
    this.decalRev = 0;
    /** Splash cameras: authored camera shots the main menu can show. Each is
     *  { id, pos: [x,y,z] (meters), yaw, pitch (radians), fov, motion }. */
    this.splashCams = [];
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

  /** Voxel occupying a cell, or null. Allocation-free (hot path). */
  get(x, y, z) {
    // Cells are integer-addressed; fractional probes (physics sweeps) found
    // no string key in the old storage and must stay null here too — a
    // fractional offset can otherwise alias onto a valid array index.
    if ((x | 0) !== x || (y | 0) !== y || (z | 0) !== z) return null;
    const s = this.chunkSize;
    const fx = Math.floor(x / s), fy = Math.floor(y / s), fz = Math.floor(z / s);
    const nk = ((fx + CK_OFF) * CK_SPAN + (fy + CK_OFF)) * CK_SPAN + (fz + CK_OFF);
    let c;
    if (nk === this._lastNk) {
      c = this._lastChunk;
    } else {
      c = this._cellChunks.get(nk) ?? null;
      this._lastNk = nk;
      this._lastChunk = c;
    }
    if (!c) return null;
    return c.arr[((x - c.x0) * s + (y - c.y0)) * s + (z - c.z0)];
  }

  /** Write one cell (voxel ref or null), maintaining chunk records and the
   *  chunkCounts/chunkCoords indices the renderer streams from. */
  _setCell(x, y, z, voxel) {
    const s = this.chunkSize;
    const fx = Math.floor(x / s), fy = Math.floor(y / s), fz = Math.floor(z / s);
    const nk = ((fx + CK_OFF) * CK_SPAN + (fy + CK_OFF)) * CK_SPAN + (fz + CK_OFF);
    let c = this._cellChunks.get(nk);
    if (!c) {
      if (!voxel) return;
      const ckey = `${fx},${fy},${fz}`;
      c = { arr: new Array(s * s * s).fill(null), count: 0, x0: fx * s, y0: fy * s, z0: fz * s, ckey };
      this._cellChunks.set(nk, c);
      this.chunkCoords.set(ckey, [fx, fy, fz]);
      // A get() miss may have cached null for this key — refresh it.
      this._lastNk = nk;
      this._lastChunk = c;
    }
    const i = ((x - c.x0) * s + (y - c.y0)) * s + (z - c.z0);
    const prev = c.arr[i];
    c.arr[i] = voxel;
    if (!prev === !voxel) return; // same occupancy (type swap) — counts hold
    c.count += voxel ? 1 : -1;
    if (c.count > 0) {
      this.chunkCounts.set(c.ckey, c.count);
    } else {
      this._cellChunks.delete(nk);
      this.chunkCounts.delete(c.ckey);
      this.chunkCoords.delete(c.ckey);
      if (this._lastChunk === c) {
        this._lastNk = NaN;
        this._lastChunk = null;
      }
    }
  }

  /**
   * Try to place a voxel. Occupancy is checked across all its cells; if any
   * cell is taken the whole placement is rejected (atomic).
   * @param {number} [rotation] yaw in quarter turns (0..3); rotates the
   *   textures only (top face spins, side tiles permute), never the shape.
   * @param {'lower'|'upper'|null} [variant] slab variant — keep only the
   *   lower or upper half of the block (cube-shaped blocks only; ignored for
   *   panes and doors). The voxel still occupies its full cell footprint.
   * @returns {boolean} true when placed
   */
  place(type, size, ax, ay, az, rotation = 0, variant = null) {
    const rot = ((rotation % 4) + 4) % 4;
    if (!this.isAreaFree(ax, ay, az, size, rot)) return false;
    const voxel = { type, size, anchor: [ax, ay, az] };
    if (rot) voxel.rotation = rot;
    if ((variant === 'lower' || variant === 'upper') && shapeFor(type) === 'cube') {
      voxel.variant = variant;
    }
    const cells = [...cellsFor(ax, ay, az, size, rot)];
    for (const [x, y, z] of cells) {
      this._setCell(x, y, z, voxel);
      this.markDirty(x, y, z);
    }
    this.voxels.set(key(ax, ay, az), voxel);
    this._occupancyChanged = true;
    this.edits.push({ cells, remove: false, type });
    return true;
  }

  /** True when every cell of the cuboid is empty (no voxel, no item).
   *  Rotation matters only for non-square footprints (doors). */
  isAreaFree(ax, ay, az, size, rotation = 0) {
    for (const [x, y, z] of cellsFor(ax, ay, az, size, rotation)) {
      if (this.get(x, y, z)) return false;
      if (this.itemCells.has(key(x, y, z))) return false;
    }
    return true;
  }

  /** Convenience: place a voxel snapping coordinates to size parity. */
  placeAt(type, size, x, y, z, rotation = 0) {
    const [ax, ay, az] = anchorFor(x, y, z, size);
    return this.place(type, size, ax, ay, az, rotation);
  }

  /** Remove the whole voxel occupying a cell. Returns the removed voxel or null. */
  remove(x, y, z) {
    const voxel = this.get(x, y, z);
    if (!voxel) return null;
    const [ax, ay, az] = voxel.anchor;
    const cells = [...cellsFor(ax, ay, az, voxel.size, voxel.rotation ?? 0)];
    for (const [cx, cy, cz] of cells) {
      this._setCell(cx, cy, cz, null);
      this.markDirty(cx, cy, cz);
      // decals ride the voxel's faces — they go with it, whole footprints
      // included (a multi-cell decal loses its backing when any cell goes)
      for (const face of ['px', 'nx', 'py', 'ny', 'pz', 'nz']) {
        if (this.decals.has(`${key(cx, cy, cz)},${face}`)) this.removeDecal(cx, cy, cz, face);
      }
      // paint rides the faces too — no block, no painted face
      if (this.paintCount) this._clearPaintAt(cx, cy, cz);
    }
    this.voxels.delete(key(ax, ay, az));
    this._occupancyChanged = true;
    this.edits.push({ cells, remove: true, type: voxel.type });
    return voxel;
  }

  // --- decals (cutout tiles pinned to voxel faces) ---

  /** Cells a decal's footprint covers: from the anchor cell, `w` cells along
   *  the face's u axis and `h` along v (odd rotations swap w/h, matching the
   *  spun artwork). Multi-cell decals share one object across all keys, like
   *  BIG voxels. */
  _decalCells(decalId, x, y, z, face, rotation) {
    const span = getDecal(decalId)?.span ?? [1, 1];
    const f = FACE_TABLE[face];
    if (!f) return [];
    const [eu, ev] = decalFootprint(face, span, rotation);
    const out = [];
    for (let i = 0; i < eu; i++) {
      for (let j = 0; j < ev; j++) {
        out.push([
          x + i * f.u[0] + j * f.v[0],
          y + i * f.u[1] + j * f.v[1],
          z + i * f.u[2] + j * f.v[2],
        ]);
      }
    }
    return out;
  }

  /** True when a decal could be pinned here: every footprint cell holds a
   *  voxel whose shape accepts this face (cubes take all six, panes only the
   *  two sides they look along) and none of the covered faces already
   *  carries a decal. */
  canPlaceDecal(decalId, x, y, z, face, rotation = 0) {
    const rot = ((rotation % 4) + 4) % 4;
    const cells = this._decalCells(decalId, x, y, z, face, rot);
    if (!cells.length) return false;
    for (const [cx, cy, cz] of cells) {
      const voxel = this.get(cx, cy, cz);
      if (!voxel) return false;
      if (!acceptsDecal(voxel.type, voxel.rotation ?? 0, face)) return false;
      if (this.decals.has(`${key(cx, cy, cz)},${face}`)) return false;
    }
    return true;
  }

  /**
   * Pin a decal onto a voxel face. The anchor cell is the footprint's
   * min-corner along the face's u/v axes; multi-cell decals need backing
   * voxels under every covered cell.
   * @param {number} [rotation] quarter turns spinning the decal on its face
   * @returns {boolean} true when placed
   */
  placeDecal(decalId, x, y, z, face, rotation = 0) {
    const rot = ((rotation % 4) + 4) % 4;
    if (!this.canPlaceDecal(decalId, x, y, z, face, rot)) return false;
    const decal = { decalId, cell: [x, y, z], face };
    if (rot) decal.rotation = rot;
    for (const [cx, cy, cz] of this._decalCells(decalId, x, y, z, face, rot)) {
      this.decals.set(`${key(cx, cy, cz)},${face}`, decal);
      this.markDirty(cx, cy, cz);
    }
    this.decalRev++;
    return true;
  }

  /** Remove the decal covering a cell face (the whole footprint goes).
   *  Returns the removed decal or null. */
  removeDecal(x, y, z, face) {
    const decal = this.decals.get(`${key(x, y, z)},${face}`) ?? null;
    if (!decal) return null;
    const [ax, ay, az] = decal.cell;
    for (const [cx, cy, cz] of this._decalCells(decal.decalId, ax, ay, az, face, decal.rotation ?? 0)) {
      this.decals.delete(`${key(cx, cy, cz)},${face}`);
      this.markDirty(cx, cy, cz);
    }
    this.decalRev++;
    return decal;
  }

  /** Decal covering a cell face, or null. */
  decalAt(x, y, z, face) {
    return this.decals.get(`${key(x, y, z)},${face}`) ?? null;
  }

  /** Iterate every decal once (multi-cell decals share one object). */
  forEachDecal(fn) {
    for (const decal of new Set(this.decals.values())) fn(decal);
  }

  // --- face paint (per-cell, per-face texture override) ---
  //
  // Paint swaps the TILE a face draws, nothing else: the voxel keeps its own
  // opacity, light, shape and collision. Only cube-shaped voxels take paint —
  // panes and doors mesh their art as a whole slab, so a per-face override
  // there would store data that never renders.

  /**
   * Override the texture of one cell face with another block's tile.
   * @param {string} blockId  the block whose tile the face should show
   * @returns {boolean} true when the paint changed
   */
  paintFace(x, y, z, face, blockId) {
    if (!FACES.includes(face) || !isBlockId(blockId)) return false;
    const voxel = this.get(x, y, z);
    if (!voxel || shapeFor(voxel.type) !== 'cube') return false;
    const k = key(x, y, z);
    let rec = this.paint.get(k);
    if (rec?.[face] === blockId) return false;
    if (!rec) {
      rec = {};
      this.paint.set(k, rec);
    }
    if (rec[face] == null) this.paintCount++;
    rec[face] = blockId;
    this.paintRev++;
    this.markDirty(x, y, z);
    return true;
  }

  /** Strip a face back to its block's own texture.
   *  @returns {string|null} the block id it was painted with, or null */
  unpaintFace(x, y, z, face) {
    const k = key(x, y, z);
    const rec = this.paint.get(k);
    const prev = rec?.[face] ?? null;
    if (prev == null) return null;
    delete rec[face];
    this.paintCount--;
    this.paintRev++;
    if (Object.keys(rec).length === 0) this.paint.delete(k);
    this.markDirty(x, y, z);
    return prev;
  }

  /** Block id painted on a cell face, or null. */
  paintAt(x, y, z, face) {
    return this.paint.get(key(x, y, z))?.[face] ?? null;
  }

  /** Every painted face of a cell as { face -> blockId }, or null. The
   *  mesher's fast path: one lookup covers all six faces of a voxel. */
  paintFor(x, y, z) {
    return this.paint.get(key(x, y, z)) ?? null;
  }

  /** Drop every painted face of a cell (its voxel is going away).
   *  @returns {number} faces stripped */
  _clearPaintAt(x, y, z) {
    const k = key(x, y, z);
    const rec = this.paint.get(k);
    if (!rec) return 0;
    const n = Object.keys(rec).length;
    this.paint.delete(k);
    this.paintCount -= n;
    this.paintRev++;
    return n;
  }

  /** Iterate every painted face as { x, y, z, face, type }. */
  forEachPaint(fn) {
    for (const [k, rec] of this.paint) {
      const [x, y, z] = k.split(',').map(Number);
      for (const face of Object.keys(rec)) fn({ x, y, z, face, type: rec[face] });
    }
  }

  /**
   * Replace this world's contents with a copy of another world's — voxels
   * (including rotation), decals, items, mob spawns and the player spawn.
   * THE single world-copy path: the editor's map load and the game's world
   * load both go through here, so a new voxel/world field only needs to be
   * threaded once. Keeps this instance's identity, so renderers/physics
   * holding a reference stay valid.
   */
  copyFrom(other) {
    this.clear();
    other.forEachVoxel((v) => {
      this.place(v.type, v.size, v.anchor[0], v.anchor[1], v.anchor[2], v.rotation ?? 0, v.variant ?? null);
      // authored door/light settings (locked/hinge/flags/mode) ride on the
      // voxel itself, not on place()'s arguments — without this a locked
      // door loads unlocked and a flag-wired light loses its signal name
      const placed = this.get(v.anchor[0], v.anchor[1], v.anchor[2]);
      applyDoorSettings(placed, v);
      applyLightSettings(placed, v);
    });
    other.forEachDecal((d) => {
      this.placeDecal(d.decalId, d.cell[0], d.cell[1], d.cell[2], d.face, d.rotation ?? 0);
      // switch wiring rides the decal entry the same way
      const entry = this.decalAt(d.cell[0], d.cell[1], d.cell[2], d.face);
      if (entry) {
        if (d.flag) entry.flag = d.flag;
        if (d.startOn) entry.startOn = true;
      }
    });
    other.forEachPaint?.((p) => this.paintFace(p.x, p.y, p.z, p.face, p.type));
    other.forEachItem((it) => this.placeItem(it.itemId, it.cells ?? it.size, it.anchor[0], it.anchor[1], it.anchor[2], it.rotation ?? 0, it));
    other.forEachMobSpawn((s) => this.addMobSpawn(s.type, s.x, s.y, s.z, s));
    other.forEachNpcSpawn((s) => this.addNpcSpawn(s.type, s.x, s.y, s.z));
    other.forEachSplashCam((c) => this.addSplashCam({ ...c, pos: [...c.pos] }));
    if (other.spawn) {
      this.setSpawn(other.spawn[0], other.spawn[1], other.spawn[2]);
      this.spawnYaw = other.spawnYaw ?? 0;
    }
  }

  /** Remove every voxel, item and the spawn point. */
  clear() {
    this._cellChunks.clear();
    this._lastNk = NaN;
    this._lastChunk = null;
    this.voxels.clear();
    this.chunkCounts.clear();
    this.chunkCoords.clear();
    this._occupancyChanged = true;
    this.dirty.clear();
    this.edits.length = 0;
    this.spawn = null;
    this.spawnYaw = 0;
    this.items.clear();
    this.itemCells.clear();
    this.mobSpawns.clear();
    this.npcSpawns.clear();
    this.decals.clear();
    this.paint.clear();
    this.paintCount = 0;
    this.paintRev++;
    this.decalRev++;
    this.splashCams.length = 0;
  }

  /**
   * Try to place an item at an anchor cell. The whole footprint must be free
   * of both voxels and other items. `cells` is the footprint in 0.5 m cells
   * along [w, h, d] (legacy 'small'/'big' strings still accepted); odd
   * quarter-turn rotations swap the x/z span, like doors. Items do not dirty
   * chunks (they are not part of chunk meshing); the caller triggers light +
   * mesh refresh.
   * @param {number} [rotation] yaw in radians about the footprint centre
   * @param {object} [settings] per-placement settings riding on the record:
   *   `loot` = search-loot config ({ pool: string[]|null, reset: number|null };
   *   pool null = default pool, reset null = never restocks). An object with
   *   a `loot` field is searchable in game; without one it is plain scenery.
   *   `storage` = true marks a storage container: in game E opens a
   *   persistent stash instead of a one-shot search.
   * @returns {boolean} true when placed
   */
  placeItem(itemId, cells, ax, ay, az, rotation = 0, settings = null) {
    const span = footprintCells(cells);
    const turns = quarterTurns(rotation);
    if (!this.isAreaFree(ax, ay, az, span, turns)) return false;
    const anchorKey = key(ax, ay, az);
    if (this.items.has(anchorKey)) return false;
    const covered = [...cellsFor(ax, ay, az, span, turns)];
    for (const [x, y, z] of covered) this.itemCells.set(key(x, y, z), anchorKey);
    const record = { itemId, anchor: [ax, ay, az], cells: span, rotation };
    if (settings?.loot && typeof settings.loot === 'object') {
      record.loot = {
        pool: Array.isArray(settings.loot.pool) ? [...settings.loot.pool] : null,
        reset: Number.isFinite(settings.loot.reset) && settings.loot.reset > 0 ? settings.loot.reset : null,
      };
    }
    if (settings?.storage === true) record.storage = true;
    this.items.set(anchorKey, record);
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

  /** Add a mob spawn at a cell (rejects overlaps). Optional per-spawner
   *  settings ride on the record: `loot` (equip item ids the spawner's mobs
   *  may drop; null = default pool, [] = no drops), `delay` ([min,max]
   *  respawn wait in seconds; null = game default) and `skins` (character
   *  sheet names the spawner's mobs wear — nurses in a hospital, police in
   *  a station; null/empty = any character). @returns {boolean} */
  addMobSpawn(type, x, y, z, settings = null) {
    const k = key(x, y, z);
    if (this.mobSpawns.has(k)) return false;
    const spawn = { type, x, y, z };
    if (Array.isArray(settings?.loot)) spawn.loot = [...settings.loot];
    if (Array.isArray(settings?.delay) && settings.delay.length === 2) {
      spawn.delay = [Number(settings.delay[0]), Number(settings.delay[1])];
    }
    if (Array.isArray(settings?.skins) && settings.skins.length) {
      spawn.skins = [...settings.skins];
    }
    this.mobSpawns.set(k, spawn);
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

  // --- NPC spawns (talkable characters placed in the editor) ---

  /** NPC spawn at an exact cell, or null. */
  npcSpawnAt(x, y, z) {
    return this.npcSpawns.get(key(x, y, z)) ?? null;
  }

  /** Add an NPC spawn at a cell (rejects overlaps). @returns {boolean} */
  addNpcSpawn(type, x, y, z) {
    const k = key(x, y, z);
    if (this.npcSpawns.has(k)) return false;
    this.npcSpawns.set(k, { type, x, y, z });
    return true;
  }

  /** Remove the NPC spawn at a cell. @returns {object|null} */
  removeNpcSpawnAt(x, y, z) {
    const k = key(x, y, z);
    const spawn = this.npcSpawns.get(k) ?? null;
    if (spawn) this.npcSpawns.delete(k);
    return spawn;
  }

  /** Iterate every NPC spawn once. */
  forEachNpcSpawn(fn) {
    for (const s of this.npcSpawns.values()) fn(s);
  }

  // --- splash cameras (menu splash-screen shots authored in the editor) ---

  /** Add a splash camera. Ids must be unique per world. @returns {boolean} */
  addSplashCam(cam) {
    if (!cam || typeof cam.id !== 'string') return false;
    if (this.splashCams.some((c) => c.id === cam.id)) return false;
    this.splashCams.push(cam);
    return true;
  }

  /** Remove a splash camera by id. @returns {object|null} the removed cam */
  removeSplashCam(id) {
    const i = this.splashCams.findIndex((c) => c.id === id);
    return i === -1 ? null : this.splashCams.splice(i, 1)[0];
  }

  /** Iterate every splash camera once. */
  forEachSplashCam(fn) {
    for (const c of this.splashCams) fn(c);
  }

  chunkKey(x, y, z) {
    const s = this.chunkSize;
    const fx = Math.floor(x / s), fy = Math.floor(y / s), fz = Math.floor(z / s);
    return `${fx},${fy},${fz}`;
  }

  /** Keys of chunks holding at least one occupied cell. */
  chunkKeys() {
    return [...this.chunkCounts.keys()];
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

  /** True once since the last drain if occupancy (which cells are filled)
   *  changed — type-only swaps (blinking lights) do not set it. */
  drainOccupancyChanged() {
    const v = this._occupancyChanged;
    this._occupancyChanged = false;
    return v;
  }

  /** Iterate every occupied cell (BIG voxels yield all 8 sub-cells). */
  forEachCell(fn) {
    const s = this.chunkSize;
    for (const c of this._cellChunks.values()) {
      const { arr, x0, y0, z0 } = c;
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (!v) continue;
        const z = z0 + (i % s);
        const y = y0 + (((i / s) | 0) % s);
        const x = x0 + ((i / (s * s)) | 0);
        fn(x, y, z, v);
      }
    }
  }

  /** Total number of occupied cells (a BIG voxel counts 8). */
  get cellCount() {
    let n = 0;
    for (const c of this.chunkCounts.values()) n += c;
    return n;
  }

  /** Iterate each unique voxel once, keyed by anchor. */
  forEachVoxel(fn) {
    for (const v of this.voxels.values()) fn(v);
  }

  /** Number of unique voxels. */
  get count() {
    return this.voxels.size;
  }

  /** Inclusive min/max cell bounds over all occupied cells, or null.
   *  Derived from the voxel index (O(#voxels)), expanding each voxel's
   *  footprint rather than scanning every occupied cell. */
  bounds() {
    let min = null, max = null;
    for (const v of this.voxels.values()) {
      for (const [x, y, z] of cellsFor(v.anchor[0], v.anchor[1], v.anchor[2], v.size, v.rotation ?? 0)) {
        min = min ? [Math.min(min[0], x), Math.min(min[1], y), Math.min(min[2], z)] : [x, y, z];
        max = max ? [Math.max(max[0], x), Math.max(max[1], y), Math.max(max[2], z)] : [x, y, z];
      }
    }
    return min && max ? { min, max } : null;
  }

  /**
   * Enumerate chunks in [originMin, originMax] (inclusive, in cell coords)
   * that contain any occupied cell. Used for a full mesh rebuild. Walks the
   * chunk counter index (O(#chunks)), not every cell.
   */
  chunkOriginsInRegion(min, max) {
    const s = this.chunkSize;
    const out = [];
    for (const ckey of this.chunkCounts.keys()) {
      const [cx, cy, cz] = ckey.split(',').map(Number);
      const x0 = cx * s, y0 = cy * s, z0 = cz * s;
      if (x0 + s - 1 < min[0] || x0 > max[0]) continue;
      if (y0 + s - 1 < min[1] || y0 > max[1]) continue;
      if (z0 + s - 1 < min[2] || z0 > max[2]) continue;
      out.push([x0, y0, z0]);
    }
    return out;
  }
}
