// idAliases.js — the entire "save migration system", one line per rename.
//
// Saves and maps reference content (blocks, items, decals, mobs, NPCs) by
// stable string id, and definitions always come from the current build —
// so content edits reach old saves automatically. The ONE thing that can't
// be automatic is renaming an id: add `'old_id': 'new_id'` here and every
// old save and map keeps loading. Never remove an alias (old saves live
// forever); chains are not followed, so point old ids at the CURRENT id.
export const ID_ALIASES = Object.freeze({
  // 'old_id': 'new_id',
});

/** @returns {string} the current id for a possibly-renamed content id */
export function aliasId(id) {
  return ID_ALIASES[id] ?? id;
}
