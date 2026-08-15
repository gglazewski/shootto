// PrefabLibrary.js — client-side cache over the server prefab store.
//
// The Prefab browser lists and mutates the library; the Prefab tool needs the
// selected prefab synchronously every frame — so parsed prefabs cache here by
// id, and every mutation keeps the cache coherent.

import { deserializePrefab } from './persistence/PrefabSerializer.js';

export class PrefabLibrary {
  /** @param {import('./PersistenceService.js').PersistenceService} persistence */
  constructor({ persistence }) {
    this.persistence = persistence;
    /** @type {Map<string, object>} id -> parsed prefab */
    this._cache = new Map();
  }

  /** Synchronous cache hit for the tool's per-frame lookups. */
  cached(id) {
    return this._cache.get(id) ?? null;
  }

  /** @returns {Promise<Array<{id:string,size?:number,mtime?:number}>>} */
  async list() {
    const entries = (await this.persistence.listPrefabs()) ?? [];
    return entries
      .filter((e) => e.type !== 'folder' && e.path.endsWith('.json'))
      .map((e) => ({ id: e.path.slice(0, -'.json'.length), size: e.size, mtime: e.mtime }));
  }

  /** Fetch + parse + cache a prefab. @returns {Promise<object|null>} */
  async load(id) {
    if (this._cache.has(id)) return this._cache.get(id);
    const text = await this.persistence.readPrefab(id);
    if (text == null) return null;
    const { prefab, errors } = deserializePrefab(text);
    if (!prefab) return null;
    if (errors.length) prefab._loadErrors = errors;
    this._cache.set(id, prefab);
    return prefab;
  }

  /** Persist a prefab object. @returns {Promise<boolean>} */
  async save(prefab) {
    const ok = await this.persistence.savePrefab(prefab.id, JSON.stringify(prefab));
    if (ok) this._cache.set(prefab.id, prefab);
    return ok;
  }

  async remove(id) {
    const ok = await this.persistence.deletePrefab(id);
    if (ok) this._cache.delete(id);
    return ok;
  }
}
