// PersistenceService.js — save/load/export of worlds to storage and files.
//
// Handles the storage/file mechanics only; the App owns world replacement and
// renderer invalidation. Uses the pure WorldSerializer, so everything here is
// browser API on top of a tested core. Bundles (map + item registry together)
// come from WorldBundle; the world shipped with a deployment lives in
// map/voxelbundle.json and is embedded at build time via bundledWorld.js.

import { serialize, deserialize } from './persistence/WorldSerializer.js';
import { serializeBundle, deserializeBundle, BUNDLE_FORMAT } from './persistence/WorldBundle.js';
import { serializeItem } from './engine/ItemTypes.js';
import { serializeRegistry } from './engine/ItemRegistry.js';
import { serializeEquipItem, serializeEquipRegistry } from './engine/EquipmentRegistry.js';
import { serializeNpcRegistry } from './engine/NpcRegistry.js';
import { serializeQuestRegistry } from './engine/QuestRegistry.js';
import { BUNDLED_WORLD } from './bundledWorld.js';

export class PersistenceService {
  constructor({ world, saveKey, itemSaveKey, equipSaveKey, npcSaveKey, questSaveKey, notice }) {
    this.world = world;
    this.saveKey = saveKey;
    this.itemSaveKey = itemSaveKey;
    this.equipSaveKey = equipSaveKey;
    this.npcSaveKey = npcSaveKey;
    this.questSaveKey = questSaveKey;
    this.notice = notice;
  }

  save() {
    try {
      localStorage.setItem(this.saveKey, serialize(this.world));
      this.notice.info('Saved to browser storage');
      return true;
    } catch (e) {
      this.notice.error('Save failed', e);
      return false;
    }
  }

  /** @returns {string|null} saved text, or null when nothing stored */
  readSaved() {
    return localStorage.getItem(this.saveKey);
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
  // When the game is served by server.mjs, the editor writes/reads the world
  // file directly on disk (map/voxelbundle.json) so the map + objects live in
  // the repo and ship with the build. Falls back to a silent no-op (false)
  // when there is no server, so file:// and static hosting still work.

  /** True when this page is served over http(s) and can reach the server API. */
  get serverAvailable() {
    return typeof location !== 'undefined' && /^https?:$/.test(location.protocol);
  }

  /** @returns {Promise<boolean>} true when the world was written to disk */
  async saveToServer() {
    if (!this.serverAvailable) return false;
    try {
      const res = await fetch('/api/world', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: serializeBundle(this.world),
      });
      if (!res.ok) return false;
      this.notice.info('Saved to map/voxelbundle.json');
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

  // --- item registry persistence ---

  saveItemRegistry() {
    localStorage.setItem(this.itemSaveKey, serializeRegistry());
  }

  /** @returns {string|null} saved item registry text, or null when empty */
  readItemRegistry() {
    return localStorage.getItem(this.itemSaveKey);
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

  // --- equipment registry persistence (F3 equippable items) ---

  saveEquipRegistry() {
    localStorage.setItem(this.equipSaveKey, serializeEquipRegistry());
  }

  /** @returns {string|null} saved equipment registry text, or null when empty */
  readEquipRegistry() {
    return localStorage.getItem(this.equipSaveKey);
  }

  // --- NPC + quest registry persistence (F4 editor) ---

  saveNpcRegistry() {
    if (this.npcSaveKey) localStorage.setItem(this.npcSaveKey, serializeNpcRegistry());
  }

  /** @returns {string|null} saved NPC registry text, or null when empty */
  readNpcRegistry() {
    return this.npcSaveKey ? localStorage.getItem(this.npcSaveKey) : null;
  }

  saveQuestRegistry() {
    if (this.questSaveKey) localStorage.setItem(this.questSaveKey, serializeQuestRegistry());
  }

  /** @returns {string|null} saved quest registry text, or null when empty */
  readQuestRegistry() {
    return this.questSaveKey ? localStorage.getItem(this.questSaveKey) : null;
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
