// NavMesh.js — grid walkability + pathfinding for mobs.
//
// The world is immutable during play (voxels are only edited in the editor), so
// a NavMesh is built once per mob type when a game starts. It is NOT a flat
// heightmap: columns can hold several walkable layers (underground rooms, upper
// floors), so a "node" is a (x, z, yCell) triple — the cell a mob's feet sit on.
//
// A node exists where a mob-sized AABB fits standing with solid support directly
// beneath. Nodes connect to their 4 orthogonal neighbours when the target layer
// is within one step height above (mobs auto-step 0.5 m blocks, exactly like the
// player) or any allowed drop below. Multi-storey columns therefore end up in
// separate connected regions unless linked by steps or ramps. Pathfinding is
// A* over these nodes, preferring flat ground over climbs.

import { CELL_SIZE } from './Space.js';
import { aabbCells } from './Physics.js';
import { raycastVoxel, worldToCell } from './VoxelRaycaster.js';

const key3 = (x, z, y) => `${x},${z},${y}`;
const key2 = (x, z) => `${x},${z}`;

/** Small binary min-heap of [priority, id] pairs for A*. */
class MinHeap {
  constructor() {
    this.a = [];
  }
  get size() {
    return this.a.length;
  }
  push(prio, id) {
    const a = this.a;
    a.push([prio, id]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let s = i;
        if (l < a.length && a[l][0] < a[s][0]) s = l;
        if (r < a.length && a[r][0] < a[s][0]) s = r;
        if (s === i) break;
        [a[s], a[i]] = [a[i], a[s]];
        i = s;
      }
    }
    return top;
  }
}

export class NavMesh {
  /**
   * @param {object} solidWorld  world-like facade exposing get(x,y,z) (voxels
   *   plus blocking items) — the same one mobs move through.
   * @param {object} opts
   * @param {number} [opts.halfWidth]  mob half x/z footprint (m)
   * @param {number} [opts.height]     mob standing height (m)
   * @param {number} [opts.stepHeight] max climbable step (m), default 0.5
   * @param {number} [opts.maxDrop]    max drop between connected nodes (m)
   */
  constructor(solidWorld, { halfWidth = 0.25, height = 1.7, stepHeight = 0.5, maxDrop = 6 } = {}) {
    this.world = solidWorld;
    this.halfWidth = halfWidth;
    this.height = height;
    this.stepCells = Math.max(1, Math.round(stepHeight / CELL_SIZE));
    this.maxDropCells = Math.round(maxDrop / CELL_SIZE);

    const b = solidWorld.bounds();
    this.valid = !!b;
    if (!b) return;
    this.minX = b.min[0];
    this.maxX = b.max[0];
    this.minY = b.min[1];
    this.maxY = b.max[1];
    this.minZ = b.min[2];
    this.maxZ = b.max[2];

    const solid = (x, y, z) => !!solidWorld.get(x, y, z);
    this._hw = halfWidth;
    this._hgt = height;
    const fitBox = (x, y, z) => this._bodyClear(x, y, z);

    /** @type {{x:number,z:number,y:number}[]} */
    this.nodes = [];
    this.colNodes = new Map(); // "x,z" -> nodes
    this.index = new Map(); // "x,z,y" -> node id

    // Feet cells must have solid support directly below and clearance above.
    for (let x = this.minX; x <= this.maxX; x++) {
      for (let z = this.minZ; z <= this.maxZ; z++) {
        for (let y = this.minY + 1; y <= this.maxY + 2; y++) {
          if (solid(x, y, z)) continue;
          if (!solid(x, y - 1, z)) continue;
          if (!fitBox(x, y, z)) continue;
          const node = { x, z, y };
          this.index.set(key3(x, z, y), this.nodes.length);
          this.nodes.push(node);
          const ck = key2(x, z);
          const arr = this.colNodes.get(ck);
          if (arr) arr.push(node);
          else this.colNodes.set(ck, [node]);
        }
      }
    }

    this._buildEdges();
    this._labelRegions();
  }

  /** True when a mob AABB with feet at cell y in column (x,z) is clear of solids. */
  _bodyClear(x, y, z) {
    const hw = this._hw;
    const height = this._hgt;
    const fx = x * CELL_SIZE + CELL_SIZE / 2;
    const fz = z * CELL_SIZE + CELL_SIZE / 2;
    const box = {
      minX: fx - hw,
      maxX: fx + hw,
      minY: y * CELL_SIZE,
      maxY: y * CELL_SIZE + height,
      minZ: fz - hw,
      maxZ: fz + hw,
    };
    for (const [cx, cy, cz] of aabbCells(box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ)) {
      if (this.world.get(cx, cy, cz)) return false;
    }
    return true;
  }

  _buildEdges() {
    const n = this.nodes.length;
    /** @type {number[][]} */
    this.edges = new Array(n);
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let i = 0; i < n; i++) {
      const node = this.nodes[i];
      const list = [];
      for (const [dx, dz] of dirs) {
        const arr = this.colNodes.get(key2(node.x + dx, node.z + dz));
        if (!arr) continue;
        for (const m of arr) {
          const dy = m.y - node.y;
          if (dy > this.stepCells) continue; // too tall to step up
          if (dy < -this.maxDropCells) continue; // too far to drop
          if (dy < 0 && !this._dropOpen(node, m, arr)) continue; // no real ledge
          let cost = 1;
          if (dy > 0) cost = 1 + dy * 2.5; // climbing up is slow
          else if (dy < 0) cost = 1 + dy * dy; // long drops are avoided (stairs win)
          list.push([this.index.get(key3(m.x, m.z, m.y)), cost]);
        }
      }
      this.edges[i] = list;
    }
  }

  /**
   * True when a mob can actually fall from `node`'s surface to the lower node
   * `m` in the adjacent column — i.e. there is a real ledge to walk off:
   * the cell at the source's feet level in the target column is open, and no
   * walkable surface in that column lies between the two levels (otherwise the
   * mob would land there instead of on `m`). Without this, adjacent columns
   * connect "through" solid rock, and a path can order a mob to walk straight
   * down into a floor.
   */
  _dropOpen(node, m, arr) {
    // The mob's FULL body must clear the target column at the source's feet
    // level — otherwise an overhang (or the far side of a step) clips it while
    // it walks off the ledge. Note world.get(x, y, z) order.
    if (!this._bodyClear(m.x, node.y, m.z)) return false;
    // A surface between m and node would catch the fall first.
    for (const other of arr) {
      if (other !== m && other.y > m.y && other.y <= node.y) return false;
    }
    return true;
  }

  _labelRegions() {
    const n = this.nodes.length;
    this.region = new Int32Array(n).fill(-1);
    let id = 0;
    for (let i = 0; i < n; i++) {
      if (this.region[i] !== -1) continue;
      const q = [i];
      this.region[i] = id;
      while (q.length) {
        const u = q.pop();
        for (const [v] of this.edges[u]) {
          if (this.region[v] === -1) {
            this.region[v] = id;
            q.push(v);
          }
        }
      }
      id++;
    }
  }

  /** Node in a column nearest the given feet-cell y, or null. */
  nearestNodeAtCell(x, z, y) {
    if (!this.valid) return null;
    const arr = this.colNodes.get(key2(x, z));
    if (!arr) return null;
    let best = null;
    let bestD = Infinity;
    for (const m of arr) {
      const d = Math.abs(m.y - y);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    return best;
  }

  /**
   * Node nearest a world-space point (m). Searches the point's column, then
   * rings outwards to a small radius. Used for the player's current position.
   */
  nearestNode(x, y, z) {
    if (!this.valid) return null;
    const cx = Math.floor(x / CELL_SIZE);
    const cz = Math.floor(z / CELL_SIZE);
    const cy = Math.floor(y / CELL_SIZE);
    for (let r = 0; r <= 3; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const node = this.nearestNodeAtCell(cx + dx, cz + dz, cy);
          if (node) return node;
        }
      }
    }
    return null;
  }

  /** World-space feet Y (m) of a walkable surface in a column, or null. */
  surfaceYAtCell(x, z, y) {
    const node = this.nearestNodeAtCell(x, z, y);
    return node ? node.y * CELL_SIZE : null;
  }

  /** Node id for a node object (or pass-through for an id). */
  nodeId(node) {
    if (node == null) return undefined;
    if (typeof node === 'number') return node;
    return this.index.get(key3(node.x, node.z, node.y));
  }

  /** Region id of a node (or id), -1 when unknown/absent. */
  regionOf(node) {
    const id = this.nodeId(node);
    return id === undefined ? -1 : this.region[id];
  }

  /**
   * A* path between two nodes.
   * @param {object|number} start node object (or id)
   * @param {object|number} goal  node object (or id)
   * @returns {{x:number,z:number,y:number}[]|null} node list (start..goal)
   */
  findPath(start, goal) {
    if (!this.valid) return null;
    start = this.nodeId(start);
    goal = this.nodeId(goal);
    if (start === undefined || goal === undefined) return null;
    if (this.region[start] !== this.region[goal]) return null;
    if (start === goal) return [this.nodes[start]];

    const n = this.nodes.length;
    const g = new Float64Array(n).fill(Infinity);
    const came = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    g[start] = 0;
    const open = new MinHeap();
    open.push(this._h(start, goal), start);

    let iter = 0;
    while (open.size && iter < 50000) {
      iter++;
      const [, u] = open.pop();
      if (u === goal) {
        const path = [];
        for (let v = goal; v !== -1; v = came[v]) path.push(this.nodes[v]);
        return path.reverse();
      }
      if (closed[u]) continue;
      closed[u] = 1;
      for (const [v, cost] of this.edges[u]) {
        if (closed[v]) continue;
        const t = g[u] + cost;
        if (t < g[v]) {
          g[v] = t;
          came[v] = u;
          open.push(t + this._h(v, goal), v);
        }
      }
    }
    return null;
  }

  _h(a, b) {
    const na = this.nodes[a];
    const nb = this.nodes[b];
    return Math.abs(na.x - nb.x) + Math.abs(na.z - nb.z) + Math.abs(na.y - nb.y) * 2;
  }

  /**
   * True when nothing solid blocks the straight line between two world points.
   * The origin/target cells themselves are ignored (mobs stand next to walls).
   */
  hasLOS(x1, y1, z1, x2, y2, z2) {
    if (!this.valid) return true;
    return hasLineOfSight(this.world, x1, y1, z1, x2, y2, z2);
  }
}

/**
 * Shared, world-free line-of-sight check: does the straight line between two
 * world-space points pass through a solid cell in `world`? `world` only needs
 * get(x, y, z). MobManager uses this to compute ONE ray per group of mobs
 * instead of one per mob.
 */
export function hasLineOfSight(world, x1, y1, z1, x2, y2, z2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dz = z2 - z1;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-4) return true;
  const origin = worldToCell([x1, y1, z1]);
  const dir = [dx / len, dy / len, dz / len];
  const targetCells = len / CELL_SIZE;
  const hit = raycastVoxel(world, origin, dir, Math.ceil(targetCells) + 2);
  if (!hit) return true;
  return hit.dist >= targetCells - 0.5;
}
