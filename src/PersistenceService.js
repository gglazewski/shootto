// PersistenceService.js — save/load/export of worlds to files and bundles.
//
// Handles the storage/file mechanics only; the App owns world replacement and
// renderer invalidation. Uses the pure WorldSerializer, so everything here is
// browser API on top of a tested core. Bundles (map + item registry together)
// come from WorldBundle; the world shipped with a deployment lives in
// map/voxelbundle.json and is embedded at build time via bundledWorld.js.
//
// Everything authored in the editor is FILE driven: the live world is written
// to map/voxelbundle.json via the server.mjs API. There is no localStorage
// shadow copy — it used to desync across browsers and after deployments.

import { serialize, deserialize } from './persistence/WorldSerializer.js';
import { serializeBundle, deserializeBundle, BUNDLE_FORMAT } from './persistence/WorldBundle.js';
import { serializeItem } from './engine/ItemTypes.js';
import { serializeEquipItem } from './engine/EquipmentRegistry.js';
import { BUNDLED_WORLD } from './bundledWorld.js';

export class PersistenceService {
  constructor({ world, notice }) {
    this.world = world;
    this.notice = notice;
  }

  /** Deserialize text into a fresh World. Handles both plain maps and bundles.
   *  Bundles register their items first. @returns {{world, errors}} */
  parse(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return deserialize(text);
    }
    if (data && data.format === BUNDLE_FORMAT) return deserializeBundle(text);
    return deserialize(text);
  }

  /** The world embedded in this deployment, or null when none is bundled. */
  bundledWorld() {
    return BUNDLED_WORLD ?? null;
  }

  /** Deserialize the bundled world (registers its items). @returns {{world, errors, itemCount}} */
  loadBundled() {
    const data = BUNDLED_WORLD;
    if (!data) return { world: null, errors: [], itemCount: 0 };
    return deserializeBundle(JSON.stringify(data));
  }

  /** Download the current world + objects as voxelbundle.json. */
  exportBundle() {
    const blob = new Blob([serializeBundle(this.world)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'voxelbundle.json';
    a.click();
    URL.revokeObjectURL(a.href);
    this.notice.info('Exported voxelbundle.json');
  }

  // --- server filesystem access ---
  //
  // The editor is served by server.mjs and reads/writes the world file
  // directly on disk (map/voxelbundle.json) so the map + objects live in the
  // repo and ship with the build. The server is always present for the editor
  // (it is never deployed statically); the guards below only protect against
  // a transient network failure.

  /** True when this page is served over http(s) and can reach the server API. */
  get serverAvailable() {
    return typeof location !== 'undefined' && /^https?:$/.test(location.protocol);
  }

  /** Write the world file to disk. @param {{silent?:boolean, keepalive?:boolean}} [opts]
   *  silent skips the toast (autosaves); keepalive lets a flush during tab-hide
   *  survive the page unloading. @returns {Promise<boolean>} true when written */
  async saveToServer({ silent = false, keepalive = false } = {}) {
    if (!this.serverAvailable) return false;
    try {
      const res = await fetch('/api/world', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: serializeBundle(this.world),
        keepalive,
      });
      if (!res.ok) return false;
      if (!silent) this.notice.info('Saved to map/voxelbundle.json');
      return true;
    } catch {
      return false;
    }
  }

  /** @returns {Promise<string|null>} the world text from the server, or null */
  async readServerWorld() {
    if (!this.serverAvailable) return null;
    try {
      const res = await fetch('/api/world');
      if (!res.ok) return null;
      const text = await res.text();
      return text === 'null' ? null : text;
    } catch {
      return null;
    }
  }

  // --- editor UI state (which library world is open) ---

  /** @returns {Promise<object|null>} persisted editor state, or null */
  async readEditorState() {
    if (!this.serverAvailable) return null;
    try {
      const res = await fetch('/api/editor-state');
      if (!res.ok) return null;
      const data = await res.json();
      return data && typeof data === 'object' ? data : null;
    } catch {
      return null;
    }
  }

  /** @returns {Promise<boolean>} */
  async writeEditorState(state) {
    if (!this.serverAvailable) return false;
    try {
      const res = await fetch('/api/editor-state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // --- world library (map/worlds/ tree on the server) ---

  /** URL-encode a library path, keeping the folder separators. */
  _worldUrl(path) {
    return `/api/worlds/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  /** @returns {Promise<Array<{path:string,type:string,size?:number,mtime?:number}>|null>}
   *  flat listing of the world library, or null when no server is reachable */
  async listWorlds() {
    if (!this.serverAvailable) return null;
    try {
      const res = await fetch('/api/worlds');
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }

  /** @returns {Promise<string|null>} world text from the library, or null */
  async readWorld(path) {
    if (!this.serverAvailable) return null;
    try {
      const res = await fetch(this._worldUrl(path));
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  }

  /** Save the current world + objects into the library. @returns {Promise<boolean>} */
  async saveWorld(path) {
    if (!this.serverAvailable) return false;
    try {
      const res = await fetch(this._worldUrl(path), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: serializeBundle(this.world),
      });
      if (!res.ok) return false;
      this.notice.info(`Saved to worlds/${path}`);
      return true;
    } catch {
      return false;
    }
  }

  /** Delete a world file, or a folder with everything in it. */
  async deleteWorld(path) {
    if (!this.serverAvailable) return false;
    try {
      return (await fetch(this._worldUrl(path), { method: 'DELETE' })).ok;
    } catch {
      return false;
    }
  }

  async moveWorld(from, to) {
    return this._worldOp({ op: 'move', from, to });
  }

  async mkdirWorlds(path) {
    return this._worldOp({ op: 'mkdir', path });
  }

  async _worldOp(op) {
    if (!this.serverAvailable) return false;
    try {
      return (await fetch('/api/worlds-ops', { method: 'POST', body: JSON.stringify(op) })).ok;
    } catch {
      return false;
    }
  }

  // --- prefab library (map/prefabs/ on the server) ---

  _prefabUrl(id) {
    return `/api/prefabs/${encodeURIComponent(id)}.json`;
  }

  /** @returns {Promise<Array<{path:string,size?:number,mtime?:number}>|null>}
   *  flat listing of the prefab library, or null when no server is reachable */
  async listPrefabs() {
    if (!this.serverAvailable) return null;
    try {
      const res = await fetch('/api/prefabs');
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }

  /** @returns {Promise<string|null>} prefab JSON text, or null */
  async readPrefab(id) {
    if (!this.serverAvailable) return null;
    try {
      const res = await fetch(this._prefabUrl(id));
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  }

  /** Write a serialized prefab into the library. @returns {Promise<boolean>} */
  async savePrefab(id, text) {
    if (!this.serverAvailable) return false;
    try {
      const res = await fetch(this._prefabUrl(id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: text,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async deletePrefab(id) {
    if (!this.serverAvailable) return false;
    try {
      return (await fetch(this._prefabUrl(id), { method: 'DELETE' })).ok;
    } catch {
      return false;
    }
  }

  /** Explicit export: download a prefab as <id>.json. */
  downloadPrefab(prefab) {
    const blob = new Blob([JSON.stringify(prefab, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${prefab.id}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // --- splash manifest (worlds + cameras behind the game's main menu) ---

  /** @returns {Promise<object|null>} parsed splash manifest, or null */
  async readSplash() {
    if (!this.serverAvailable) return null;
    try {
      const res = await fetch('/api/splash');
      if (!res.ok) return null;
      const data = await res.json();
      return data && typeof data === 'object' ? data : null;
    } catch {
      return null;
    }
  }

  /** @returns {Promise<boolean>} */
  async writeSplash(manifest) {
    if (!this.serverAvailable) return false;
    try {
      const res = await fetch('/api/splash', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manifest, null, 2),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Download the current world as voxelmap.json. */
  export() {
    const blob = new Blob([serialize(this.world)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'voxelmap.json';
    a.click();
    URL.revokeObjectURL(a.href);
    this.notice.info('Exported voxelmap.json');
  }

  /** Download a single item as <id>.json. */
  downloadItem(item) {
    const blob = new Blob([serializeItem(item)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${item.id ?? 'item'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /** Download a single equippable item as <id>.json. */
  downloadEquipItem(item) {
    const blob = new Blob([serializeEquipItem(item)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${item.id ?? 'item'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
}
