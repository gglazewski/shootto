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
 * @property {'cube'|'pane'} [shape]  'cube' (default) = full block faces.
 *   'pane' = a single centered quad (chain-link fence, bars, barricade
 *   boards); the tile's alpha channel cuts out the gaps and the voxel's
 *   rotation turns the pane (0/180 = along x, 90/270 = along z). Panes are
 *   depth-written cutouts (not alpha-blended), so they sort correctly
 *   against each other.
 * @property {boolean} [shootThrough]  true = attack rays (bullets, swings)
 *   pass through this block; it still blocks movement.
 * @property {boolean} [hidden]  true = kept out of the editor palette
 *   (internal states like the blinking lights' off phase).
 * @property {'flicker'} [blink]  the game strobes this block between itself
 *   and `blinkOff` — horror-movie cadence: lit stretches broken by fits of
 *   rapid erratic chatter (see GameApp._flickerState).
 * @property {string} [blinkOff]  block id of the dark phase.
 * @property {string} [blinkOn]   back-reference from the dark phase.
 */

/** @type {BlockDef[]} */
const BLOCKS = [
  { id: 'grass', name: 'Grass', tiles: 'grass_top' },
  { id: 'dirt', name: 'Dirt', tiles: 'dirt' },
  { id: 'stone', name: 'Stone', tiles: 'stone' },
  { id: 'gravel', name: 'Gravel', tiles: 'gravel' },
  { id: 'sand', name: 'Sand', tiles: 'sand' },
  { id: 'concrete', name: 'Concrete', tiles: 'concrete' },
  { id: 'asphalt', name: 'Asphalt', tiles: 'asphalt' },
  { id: 'asphalt_line', name: 'Road Marking', tiles: { py: 'asphalt_line', ny: 'asphalt', px: 'asphalt', nx: 'asphalt', pz: 'asphalt', nz: 'asphalt' } },
  { id: 'asphalt_corner', name: 'Road Marking Corner', tiles: { py: 'asphalt_corner', ny: 'asphalt', px: 'asphalt', nx: 'asphalt', pz: 'asphalt', nz: 'asphalt' } },
  { id: 'brick', name: 'Brick', tiles: 'brick' },
  { id: 'rubble', name: 'Rubble', tiles: 'rubble' },
  { id: 'metal', name: 'Scrap Metal', tiles: 'metal' },
  { id: 'sandbags', name: 'Sandbags', tiles: 'sandbags' },
  { id: 'curb', name: 'Curb', tiles: { py: 'curb_top', ny: 'concrete', px: 'curb_side', nx: 'curb_side', pz: 'curb_side', nz: 'curb_side' } },
  { id: 'canopy', name: 'Canopy Panel', tiles: 'canopy' },
  { id: 'canopy_trim', name: 'Canopy Trim', tiles: { py: 'canopy', ny: 'canopy', px: 'canopy_trim', nx: 'canopy_trim', pz: 'canopy_trim', nz: 'canopy_trim' } },
  { id: 'tile_floor', name: 'Floor Tiles', tiles: 'tile_floor' },
  { id: 'plaster', name: 'Plaster', tiles: 'plaster' },
  { id: 'shutter', name: 'Roller Shutter', tiles: 'shutter' },
  { id: 'wood', name: 'Wood', tiles: { py: 'wood_top', ny: 'wood_top', px: 'wood_side', nx: 'wood_side', pz: 'wood_side', nz: 'wood_side' } },
  { id: 'wood_light', name: 'Light Wood', tiles: { py: 'wood_top_light', ny: 'wood_top_light', px: 'wood_side_light', nx: 'wood_side_light', pz: 'wood_side_light', nz: 'wood_side_light' } },
  { id: 'wood_dark', name: 'Dark Wood', tiles: { py: 'wood_top_dark', ny: 'wood_top_dark', px: 'wood_side_dark', nx: 'wood_side_dark', pz: 'wood_side_dark', nz: 'wood_side_dark' } },
  { id: 'planks', name: 'Planks', tiles: 'planks' },
  { id: 'planks_light', name: 'Light Planks', tiles: 'planks_light' },
  { id: 'planks_dark', name: 'Dark Planks', tiles: 'planks_dark' },
  { id: 'glass', name: 'Glass', tiles: 'glass', opacity: 0, transparent: true },
  // Lights are directional (emitFaces): a ceiling panel shines DOWN only, a
  // neon tube sideways — embedded in a wall or roof they never light the far
  // side. Blinking variants (driven by engine/Blinkers.js in both the game
  // and the editor) toggle to their hidden *_off phase and back.
  { id: 'lamp', name: 'Ceiling Light', tiles: 'lamp', light: 15, emitFaces: ['ny'] },
  { id: 'neon', name: 'Red Neon', tiles: 'neon_red', light: 9, emitFaces: ['px', 'nx', 'pz', 'nz'] },
  { id: 'lamp_blink', name: 'Ceiling Light (blinking)', tiles: 'lamp', light: 15, emitFaces: ['ny'], blink: 'flicker', blinkOff: 'lamp_blink_off' },
  { id: 'lamp_blink_off', name: 'Ceiling Light (off)', tiles: 'lamp_off', hidden: true, blinkOn: 'lamp_blink' },
  { id: 'neon_blink', name: 'Red Neon (blinking)', tiles: 'neon_red', light: 9, emitFaces: ['px', 'nx', 'pz', 'nz'], blink: 'flicker', blinkOff: 'neon_blink_off' },
  { id: 'neon_blink_off', name: 'Red Neon (off)', tiles: 'neon_off', hidden: true, blinkOn: 'neon_blink' },
  { id: 'fence', name: 'Chain-link Fence', tiles: 'chainlink', shape: 'pane', opacity: 0, shootThrough: true },
  { id: 'bars', name: 'Metal Bars', tiles: 'bars', shape: 'pane', opacity: 0, shootThrough: true },
  { id: 'barricade', name: 'Barricade Boards', tiles: 'boards', shape: 'pane', opacity: 0, shootThrough: true },
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

/** Faces an emissive block shines through, or null = omnidirectional
 *  (seeded in its own cells, escaping every open face). Directional lights
 *  seed the open cells beyond the listed faces instead, so a panel embedded
 *  in a wall or ceiling never lights the far side. */
export function emitFacesFor(id) {
  return REGISTRY.get(id)?.emitFaces ?? null;
}

/** True if a block id renders in the transparent pass. */
export function isTransparent(id) {
  return REGISTRY.get(id)?.transparent === true;
}

/** Mesh shape of a block id: 'cube' (default) or 'pane' (centered quad). */
export function shapeFor(id) {
  return REGISTRY.get(id)?.shape ?? 'cube';
}

/** True if attack rays pass through this block (it still blocks movement). */
export function isShootThrough(id) {
  return REGISTRY.get(id)?.shootThrough === true;
}

/** Register a block definition at runtime (mods/tests). Replaces any block
 *  with the same id. The tile(s) it references must exist in the atlas. */
export function registerBlock(def) {
  REGISTRY.set(def.id, def);
}

// --- decals ---
//
// A decal is a cutout tile pinned onto one face of a placed voxel (blood
// splatter, crack, bullet holes). Decals are not voxels: they have no
// collision, no light interaction and no occupancy — they ride on the face
// they are attached to and are meshed into the same chunk geometry.

/**
 * @typedef {Object} DecalDef
 * @property {string} id    unique string id (also used in save files)
 * @property {string} name  human readable name
 * @property {string} tile  atlas tile name (alpha channel = cutout)
 * @property {[number,number]} [span]  footprint in cells (default [1,1]).
 *   The atlas art is span*16px (one 16px slot per covered cell), so big
 *   decals — graffiti, road text — keep the same texel density as blocks.
 *   Rotation turns the footprint with the artwork (odd rotations swap w/h).
 */

/** @type {DecalDef[]} */
const DECALS = [
  { id: 'decal_blood', name: 'Blood Splatter', tile: 'decal_blood' },
  { id: 'decal_blood2', name: 'Blood Runs', tile: 'decal_blood2' },
  { id: 'decal_blood3', name: 'Blood Mist', tile: 'decal_blood3' },
  { id: 'decal_blood_pool', name: 'Blood Pool', tile: 'decal_blood_pool', span: [2, 2] },
  { id: 'decal_crack', name: 'Crack', tile: 'decal_crack' },
  { id: 'decal_bullets', name: 'Bullet Holes', tile: 'decal_bullets' },
  { id: 'decal_clothes', name: 'Old Clothes', tile: 'decal_clothes' },
  { id: 'decal_glass', name: 'Broken Glass', tile: 'decal_glass' },
  { id: 'decal_papers', name: 'Papers', tile: 'decal_papers' },
  { id: 'decal_cans', name: 'Cans', tile: 'decal_cans' },
  { id: 'decal_stain', name: 'Oil Stain', tile: 'decal_stain' },
  { id: 'decal_food', name: 'Food Scraps', tile: 'decal_food' },
  { id: 'decal_graffiti', name: 'Graffiti', tile: 'decal_graffiti', span: [4, 2] },
  { id: 'decal_stop', name: 'STOP Marking', tile: 'decal_stop', span: [4, 4] },
  { id: 'decal_arrow', name: 'Road Arrow', tile: 'decal_arrow', span: [2, 4] },
];

const DECAL_REGISTRY = new Map(DECALS.map((d) => [d.id, d]));

/** The six voxel face names a decal can attach to. */
export const FACES = Object.freeze(['px', 'nx', 'py', 'ny', 'pz', 'nz']);

/** Get a decal definition by id. Returns undefined for unknown ids. */
export function getDecal(id) {
  return DECAL_REGISTRY.get(id);
}

/** All registered decal ids, in insertion order. */
export function listDecalIds() {
  return [...DECAL_REGISTRY.keys()];
}

/** True if the id resolves to a known decal. */
export function isDecalId(id) {
  return DECAL_REGISTRY.has(id);
}
