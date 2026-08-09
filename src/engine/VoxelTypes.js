// VoxelTypes.js — data-driven registry of block types.
//
// Adding a new block = adding one entry here (plus a tile generator in
// textures/TextureAtlas.js). The rest of the engine reads from this registry.

export const SIZE = Object.freeze({
  SMALL: 'small',
  BIG: 'big',
  DOOR: 'door',
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
 * @property {'cube'|'pane'|'door'} [shape]  'cube' (default) = full block faces.
 *   'pane' = a single centered quad (chain-link fence, bars, barricade
 *   boards); the tile's alpha channel cuts out the gaps and the voxel's
 *   rotation turns the pane (0/180 = along x, 90/270 = along z). Panes are
 *   depth-written cutouts (not alpha-blended), so they sort correctly
 *   against each other.
 *   'door' = a centered slab with real thickness spanning a SIZE.DOOR
 *   footprint (2 cells wide x 4 tall); rotation orients it like a pane and
 *   picks the swing side of the open phase (see engine/Doors.js).
 * @property {boolean} [shootThrough]  true = attack rays (bullets, swings)
 *   pass through this block; it still blocks movement.
 * @property {boolean} [mixedAlpha]  true = the tile art mixes opaque and
 *   translucent texels (framed window, glazed doors). Meshed into both
 *   passes: solid texels depth-write in the opaque cutout pass, glass
 *   texels (alpha < 0.5) blend in the transparent pass.
 * @property {boolean} [glass]  true = a glass surface: attacks pass through
 *   and burst glass shards at the pane instead of puffing smoke.
 * @property {boolean} [passable]  true = the block does not block movement
 *   (open door phases). Collision facades return null for these cells.
 * @property {string} [doorOpen]   block id of this door's open phase.
 * @property {string} [doorClosed] back-reference from the open phase; also
 *   the id a door is normalized to when a map is saved.
 * @property {string} [fixedSize]  pins the build size for this block (doors
 *   are always SIZE.DOOR regardless of the small/big toggle).
 * @property {[number,number]} [tileSpan]  atlas slots [cols, rows] of this
 *   block's tile art (doors: [2,4] = one 32x64 px artwork across the leaf).
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
  // Glass is a pane (like fences): a centered quad, alpha-blended. Attacks
  // pass through it and burst glass shards at the pane (`glass` flag).
  { id: 'glass', name: 'Glass', tiles: 'glass', shape: 'pane', opacity: 0, transparent: true, shootThrough: true, glass: true },
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
  // --- mid-90s Poland set: post-communist estates, bazaars, kiosks ---
  { id: 'panel', name: 'Prefab Panel', tiles: 'panel' },
  { id: 'plaster_pastel', name: 'Pastel Plaster', tiles: 'plaster_pastel' },
  { id: 'lastryko', name: 'Terrazzo Floor', tiles: 'lastryko' },
  { id: 'kiosk', name: 'Kiosk Panel', tiles: 'kiosk' },
  { id: 'blacha', name: 'Corrugated Steel', tiles: 'blacha' },
  { id: 'paving', name: 'Paving Slabs', tiles: { py: 'paving', ny: 'concrete', px: 'concrete', nx: 'concrete', pz: 'concrete', nz: 'concrete' } },
  { id: 'brick_sooty', name: 'Sooty Brick', tiles: 'brick_sooty' },
  { id: 'lino', name: 'Linoleum', tiles: 'lino' },
  { id: 'neon_white', name: 'White Neon', tiles: 'neon_white', light: 10, emitFaces: ['px', 'nx', 'pz', 'nz'] },
  { id: 'neon_white_blink', name: 'White Neon (blinking)', tiles: 'neon_white', light: 10, emitFaces: ['px', 'nx', 'pz', 'nz'], blink: 'flicker', blinkOff: 'neon_white_blink_off' },
  { id: 'neon_white_blink_off', name: 'White Neon (off)', tiles: 'neon_white_off', hidden: true, blinkOn: 'neon_white_blink' },
  // --- estate facades & garage colony (built from the examples/ photos) ---
  { id: 'plaster_yellow', name: 'Pastel Plaster (yellow)', tiles: 'plaster_yellow' },
  { id: 'plaster_orange', name: 'Pastel Plaster (orange)', tiles: 'plaster_orange' },
  { id: 'plaster_green', name: 'Pastel Plaster (green)', tiles: 'plaster_green' },
  { id: 'plaster_blue', name: 'Pastel Plaster (blue)', tiles: 'plaster_blue' },
  { id: 'brick_yellow', name: 'Yellow Brick', tiles: 'brick_yellow' },
  { id: 'papa', name: 'Roofing Felt', tiles: 'papa' },
  { id: 'garage_brown', name: 'Garage Door (brown)', tiles: 'garage_brown' },
  { id: 'garage_green', name: 'Garage Door (green)', tiles: 'garage_green' },
  { id: 'garage_red', name: 'Garage Door (red)', tiles: 'garage_red' },
  { id: 'window_white', name: 'Framed Window', tiles: 'window_white', opacity: 0, mixedAlpha: true, shootThrough: true, glass: true },
  { id: 'balcony_rail', name: 'Balcony Balustrade', tiles: 'balcony_rail', shape: 'pane', opacity: 0 },
  { id: 'fence', name: 'Chain-link Fence', tiles: 'chainlink', shape: 'pane', opacity: 0, shootThrough: true },
  { id: 'fence_wood', name: 'Wooden Fence', tiles: 'pickets', shape: 'pane', opacity: 0, shootThrough: true },
  { id: 'bars', name: 'Metal Bars', tiles: 'bars', shape: 'pane', opacity: 0, shootThrough: true },
  { id: 'barricade', name: 'Barricade Boards', tiles: 'boards', shape: 'pane', opacity: 0, shootThrough: true },
  // --- doors (one voxel spanning 2x4 cells; open/closed = id swap like the
  // blinking lights, driven by engine/Doors.js; zombies can't toggle them) ---
  { id: 'door_wood', name: 'Entrance Door', tiles: 'door_wood', shape: 'door', opacity: 0, fixedSize: SIZE.DOOR, tileSpan: [2, 4], doorOpen: 'door_wood_open' },
  { id: 'door_wood_open', name: 'Entrance Door (open)', tiles: 'door_wood', shape: 'door', opacity: 0, hidden: true, passable: true, shootThrough: true, fixedSize: SIZE.DOOR, tileSpan: [2, 4], doorClosed: 'door_wood' },
  { id: 'door_white', name: 'Interior Door', tiles: 'door_white', shape: 'door', opacity: 0, mixedAlpha: true, fixedSize: SIZE.DOOR, tileSpan: [2, 4], doorOpen: 'door_white_open' },
  { id: 'door_white_open', name: 'Interior Door (open)', tiles: 'door_white', shape: 'door', opacity: 0, mixedAlpha: true, hidden: true, passable: true, shootThrough: true, fixedSize: SIZE.DOOR, tileSpan: [2, 4], doorClosed: 'door_white' },
  { id: 'door_shop', name: 'Shop Door', tiles: 'door_shop', shape: 'door', opacity: 0, mixedAlpha: true, fixedSize: SIZE.DOOR, tileSpan: [2, 4], doorOpen: 'door_shop_open' },
  { id: 'door_shop_open', name: 'Shop Door (open)', tiles: 'door_shop', shape: 'door', opacity: 0, mixedAlpha: true, hidden: true, passable: true, shootThrough: true, fixedSize: SIZE.DOOR, tileSpan: [2, 4], doorClosed: 'door_shop' },
  { id: 'door_steel', name: 'Steel Door', tiles: 'door_steel', shape: 'door', opacity: 0, mixedAlpha: true, fixedSize: SIZE.DOOR, tileSpan: [2, 4], doorOpen: 'door_steel_open' },
  { id: 'door_steel_open', name: 'Steel Door (open)', tiles: 'door_steel', shape: 'door', opacity: 0, mixedAlpha: true, hidden: true, passable: true, shootThrough: true, fixedSize: SIZE.DOOR, tileSpan: [2, 4], doorClosed: 'door_steel' },
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

/** True if a block's tile art mixes opaque and translucent texels (framed
 *  windows, glazed doors). Such blocks are meshed into BOTH passes: the
 *  opaque cutout pass draws the solid texels depth-written (correct
 *  occlusion for the frame), the transparent pass alpha-blends the glass
 *  texels (alpha < 0.5, which the opaque pass discards). */
export function isMixedAlpha(id) {
  return REGISTRY.get(id)?.mixedAlpha === true;
}

/** True if a block is a glass surface: attack rays pass through it and the
 *  hit bursts glass shards instead of a smoke puff. */
export function isGlass(id) {
  return REGISTRY.get(id)?.glass === true;
}

/** Mesh shape of a block id: 'cube' (default), 'pane' (centered quad) or
 *  'door' (centered slab with thickness). */
export function shapeFor(id) {
  return REGISTRY.get(id)?.shape ?? 'cube';
}

/** True if attack rays pass through this block (it still blocks movement). */
export function isShootThrough(id) {
  return REGISTRY.get(id)?.shootThrough === true;
}

/** True if this block does not block movement (open door phases). */
export function isPassable(id) {
  return REGISTRY.get(id)?.passable === true;
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
  // --- mid-90s Poland set ---
  { id: 'decal_poster', name: 'Peeling Poster', tile: 'decal_poster', span: [2, 2] },
  { id: 'decal_sklep', name: 'SKLEP Sign', tile: 'decal_sklep', span: [4, 1] },
  { id: 'decal_club', name: 'Club Graffiti', tile: 'decal_club', span: [4, 2] },
  { id: 'decal_damp', name: 'Damp Stain', tile: 'decal_damp', span: [2, 2] },
  { id: 'decal_ads', name: 'Tear-off Ads', tile: 'decal_ads' },
  { id: 'decal_zebra', name: 'Zebra Crossing', tile: 'decal_zebra', span: [2, 4] },
  { id: 'decal_rug', name: 'Rug', tile: 'decal_rug', span: [2, 2] },
  { id: 'decal_bottles', name: 'Bottles & Caps', tile: 'decal_bottles' },
  { id: 'decal_curtain', name: 'Lace Curtain', tile: 'decal_curtain' },
  { id: 'decal_hopscotch', name: 'Chalk Hopscotch', tile: 'decal_hopscotch', span: [1, 4] },
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

/** Register a decal definition at runtime (text signs, mods, tests).
 *  Replaces any decal with the same id. The tile it references must exist
 *  in the atlas (static or runtime-registered). */
export function registerDecal(def) {
  DECAL_REGISTRY.set(def.id, def);
}
