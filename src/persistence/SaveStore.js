// SaveStore.js — async save-slot storage on IndexedDB.
//
// Why IndexedDB and not localStorage: structured clone stores the snapshot's
// typed arrays and plain objects directly (no JSON.stringify on the save
// path at all), writes are async (no frame hitch from I/O), a readwrite
// transaction over both stores is atomic (a crash mid-save never corrupts a
// slot), and quota is a share of the disk instead of ~10 MB.
//
// Two object stores, so the slot menu never touches multi-MB payloads:
//   meta:    slotKey -> { savedAt, ... }        (tiny, listed every menu open)
//   payload: slotKey -> the full save payload   (read only on load)
//
// Slot keys are strings: 'slot0'..'slotN' for manual slots, 'auto_a'/'auto_b'
// reserved for the rotating autosave pair. MemorySaveStore is the same
// contract for tests and non-browser environments.

export const SAVE_DB = 'voxelgame.saves';
export const SAVE_FORMAT = 'voxelsave';
/** v3 = static-world save: the payload carries NO world data at all, only
 *  `pickedUp` tombstones for objects the player removed from the map, plus
 *  player/stats/quests/flags/containers. Loading = the CURRENT authored map
 *  minus the tombstones — so map edits reach every existing save.
 *  v2 stored the whole world as a snapshot (its `world` field is ignored by
 *  the loader now — picked-up objects respawn once); v1 was the legacy
 *  localStorage slot with an embedded WorldBundle. */
export const SAVE_VERSION = 3;

const META_STORE = 'meta';
const PAYLOAD_STORE = 'payload';

/** @returns {string} store key for manual slot i */
export function manualSlotKey(i) {
  return `slot${i}`;
}

/** Build a v3 save payload. `pickedUp` is the tombstone list — objects the
 *  player removed from the authored map, as [{ itemId, x, y, z }]. */
export function makeSave({ pickedUp = [], player, stats, quests = null, flags = null, containers = null }) {
  return {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    savedAt: Date.now(),
    pickedUp,
    player,
    stats,
    quests,
    flags,
    containers,
  };
}

const itemKey = (it) => `${it.itemId}@${it.x},${it.y},${it.z}`;

/** The tombstones: every base-map object placement missing from the live
 *  world. Keyed by item id + anchor cell, so a map edit that moves or
 *  replaces an object simply stops matching and the object comes back —
 *  tolerant in the same per-entry spirit as the map loader. */
export function diffPickedUp(baseItems, currentItems) {
  const live = new Set(currentItems.map(itemKey));
  return baseItems
    .filter((it) => !live.has(itemKey(it)))
    .map(({ itemId, x, y, z }) => ({ itemId, x, y, z }));
}

/** In-memory SaveStore — tests and environments without IndexedDB. */
export class MemorySaveStore {
  constructor() {
    this._meta = new Map();
    this._payload = new Map();
  }

  async list() {
    return [...this._meta.entries()].map(([slot, meta]) => ({ slot, ...meta }));
  }

  async readMeta(slot) {
    return this._meta.get(slot) ?? null;
  }

  async read(slot) {
    return this._payload.get(slot) ?? null;
  }

  async write(slot, payload, meta) {
    this._payload.set(slot, payload);
    this._meta.set(slot, { ...meta });
  }

  async remove(slot) {
    this._meta.delete(slot);
    this._payload.delete(slot);
  }
}

const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

export class IdbSaveStore {
  constructor(db) {
    this.db = db;
  }

  static async open(dbName = SAVE_DB) {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
      if (!db.objectStoreNames.contains(PAYLOAD_STORE)) db.createObjectStore(PAYLOAD_STORE);
    };
    return new IdbSaveStore(await req(request));
  }

  async list() {
    const store = this.db.transaction(META_STORE).objectStore(META_STORE);
    const [keys, metas] = await Promise.all([req(store.getAllKeys()), req(store.getAll())]);
    return keys.map((slot, i) => ({ slot, ...metas[i] }));
  }

  async readMeta(slot) {
    const store = this.db.transaction(META_STORE).objectStore(META_STORE);
    return (await req(store.get(slot))) ?? null;
  }

  async read(slot) {
    const store = this.db.transaction(PAYLOAD_STORE).objectStore(PAYLOAD_STORE);
    return (await req(store.get(slot))) ?? null;
  }

  /** Atomic: meta and payload land in one transaction or not at all. */
  async write(slot, payload, meta) {
    const tx = this.db.transaction([META_STORE, PAYLOAD_STORE], 'readwrite');
    tx.objectStore(PAYLOAD_STORE).put(payload, slot);
    tx.objectStore(META_STORE).put(meta, slot);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('save transaction aborted'));
    });
  }

  async remove(slot) {
    const tx = this.db.transaction([META_STORE, PAYLOAD_STORE], 'readwrite');
    tx.objectStore(PAYLOAD_STORE).delete(slot);
    tx.objectStore(META_STORE).delete(slot);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('delete transaction aborted'));
    });
  }
}

/** The store for this environment: IndexedDB in the browser, memory
 *  otherwise (saves then last for the session — better than crashing). */
export async function openSaveStore() {
  if (typeof indexedDB === 'undefined') return new MemorySaveStore();
  try {
    return await IdbSaveStore.open();
  } catch (e) {
    console.warn('IndexedDB unavailable, saves are session-only:', e);
    return new MemorySaveStore();
  }
}
