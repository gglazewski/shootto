// VoxelTypes.js — data-driven registry of block types.
//
// Adding a new block = adding one entry here (plus a tile generator in
// textures/TextureAtlas.js). The rest of the engine reads from this registry.

export const SIZE = Object.freeze({
  SMALL: 'small',
  BIG: 'big',
});

/**
 * @typedef {Object} BlockDef
 * @property {string} id        unique string id (also used in save files)
 * @property {string} name      human readable name
 * @property {string | Object<string,string>} tiles
 *   a single tile name used on every face, or a map of face name -> tile name
 * @property {number} [opacity]   255 = opaque (default). 0 = fully transparent
 *   to light (light passes freely); intermediate values are treated as
 *   transparent by the light field.
 * @property {number} [light]     block-light emitted by this voxel, 0..15
 * @property {boolean} [transparent]  true = rendered in the transparent pass
 */

/** @type {BlockDef[]} */
const BLOCKS = [
  { id: 'grass', name: 'Grass', tiles: 'grass_top' },
  { id: 'sand', name: 'Sand', tiles: 'sand' },
  { id: 'concrete', name: 'Concrete', tiles: 'concrete' },
  { id: 'wood', name: 'Wood', tiles: { py: 'wood_top', ny: 'wood_top', px: 'wood_side', nx: 'wood_side', pz: 'wood_side', nz: 'wood_side' } },
  { id: 'wood_light', name: 'Light Wood', tiles: { py: 'wood_top_light', ny: 'wood_top_light', px: 'wood_side_light', nx: 'wood_side_light', pz: 'wood_side_light', nz: 'wood_side_light' } },
  { id: 'wood_dark', name: 'Dark Wood', tiles: { py: 'wood_top_dark', ny: 'wood_top_dark', px: 'wood_side_dark', nx: 'wood_side_dark', pz: 'wood_side_dark', nz: 'wood_side_dark' } },
  { id: 'planks', name: 'Planks', tiles: 'planks' },
  { id: 'planks_light', name: 'Light Planks', tiles: 'planks_light' },
  { id: 'planks_dark', name: 'Dark Planks', tiles: 'planks_dark' },
  { id: 'glass', name: 'Glass', tiles: 'glass', opacity: 0, transparent: true },
  { id: 'torch', name: 'Torch', tiles: { py: 'torch_top', ny: 'torch_side', px: 'torch_side', nx: 'torch_side', pz: 'torch_side', nz: 'torch_side' }, light: 15, transparent: true },
];

const REGISTRY = new Map(BLOCKS.map((b) => [b.id, b]));

/** Get a block definition by id. Returns undefined for unknown ids. */
export function getBlock(id) {
  return REGISTRY.get(id);
}

/** All registered block ids, in insertion order. */
export function listBlockIds() {
  return [...REGISTRY.keys()];
}

/** True if the id resolves to a known block. */
export function isBlockId(id) {
  return REGISTRY.has(id);
}

/** Tile name for a block id on a given face. Supports a single tile string
 * (used on every face) or a per-face map with fallback to any side tile. */
export function tileFor(id, face) {
  const def = REGISTRY.get(id);
  if (!def) return null;
  const t = def.tiles;
  if (typeof t === 'string') return t;
  const f = t[face];
  if (f) return f;
  return t.px ?? t.py ?? null;
}

/** Validate a block id; used by the serializer to reject bad save files. */
export function assertValidBlockId(id) {
  if (!REGISTRY.has(id)) {
    throw new Error(`Unknown block id "${id}"`);
  }
}

/** Light opacity of a block id, 0..255 (255 = fully opaque). */
export function opacityFor(id) {
  return REGISTRY.get(id)?.opacity ?? 255;
}

/** Block light emitted by a block id, 0..15 (0 = not emissive). */
export function lightFor(id) {
  return REGISTRY.get(id)?.light ?? 0;
}

/** True if a block id renders in the transparent pass. */
export function isTransparent(id) {
  return REGISTRY.get(id)?.transparent === true;
}
