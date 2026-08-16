// MeshWorkerPool.js — main-thread wrapper around the mesh worker(s).
//
// Owns N Web Workers running meshWorkerMain.js, round-robins snapshot
// requests across them and resolves each with the packed mesh data. The
// atlas' name->index tile map (plus the decal registry, for runtime text
// signs) is pushed to every worker on first use and re-pushed whenever the
// tiles ref's `rev` changes (atlas rebuild).
//
// Fails soft: if Workers are unavailable (node tests, file:// pages) or a
// worker errors, the pool marks itself dead and every request resolves null —
// the Renderer then meshes synchronously as before.

import { listDecalIds, getDecal } from './VoxelTypes.js';

export class MeshWorkerPool {
  /**
   * @param {object} deps
   * @param {string} deps.workerUrl  script URL (bundle of meshWorkerMain.js)
   * @param {number} [deps.count]    worker count
   * @param {{map: Map<string,number>, rev: number}} deps.tiles  live atlas tile map
   * @param {{width:number,height:number,tileSize?:number}} deps.atlas
   */
  constructor({ workerUrl, count = 2, tiles, atlas }) {
    this.tiles = tiles;
    this.atlas = atlas;
    this.dead = false;
    this.workers = [];
    this._pending = new Map(); // id -> resolve
    this._nextId = 1;
    this._rr = 0;
    this._sentRev = -1;
    try {
      if (typeof Worker === 'undefined') throw new Error('no Worker');
      for (let i = 0; i < Math.max(1, count); i++) {
        const w = new Worker(workerUrl);
        w.onmessage = (e) => this._onReply(e.data);
        w.onerror = () => this._fail();
        this.workers.push(w);
      }
    } catch {
      this._fail();
    }
  }

  /** True while workers are usable. */
  available() {
    return !this.dead && this.workers.length > 0;
  }

  _fail() {
    this.dead = true;
    for (const w of this.workers) { try { w.terminate(); } catch { /* gone */ } }
    this.workers = [];
    for (const resolve of this._pending.values()) resolve(null);
    this._pending.clear();
  }

  _onReply(msg) {
    const resolve = this._pending.get(msg.id);
    if (!resolve) return; // stale/unknown
    this._pending.delete(msg.id);
    resolve(msg.data);
  }

  _syncTiles() {
    if (this._sentRev === this.tiles.rev) return;
    const init = {
      type: 'init',
      tiles: [...this.tiles.map],
      atlas: this.atlas,
      decalDefs: listDecalIds().map((id) => getDecal(id)),
    };
    for (const w of this.workers) w.postMessage(init);
    this._sentRev = this.tiles.rev;
  }

  /**
   * Mesh one chunk snapshot off-thread.
   * @returns {Promise<object|null>} packed mesh data, or null when the pool
   *   is unavailable (caller should mesh synchronously)
   */
  request(snapshot) {
    if (!this.available()) return Promise.resolve(null);
    this._syncTiles();
    const id = this._nextId++;
    const w = this.workers[this._rr++ % this.workers.length];
    return new Promise((resolve) => {
      this._pending.set(id, resolve);
      try {
        w.postMessage(
          { type: 'mesh', id, snapshot },
          [snapshot.vox.buffer, ...(snapshot.light ? [snapshot.light.buffer] : [])],
        );
      } catch {
        this._pending.delete(id);
        this._fail();
        resolve(null);
      }
    });
  }

  dispose() {
    this._fail();
  }
}
