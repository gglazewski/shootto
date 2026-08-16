// VoxelTypes.js — data-driven registry of block types.
//
// Adding a new block = adding one entry here (plus a tile generator in
// textures/TextureAtlas.js). The rest of the engine reads from this registry.

export const SIZE = Object.freeze({
  SMALL: 'small',
  BIG: 'big',
  DOOR: 'door',
  DOOR3: 'door3',
  SIDELIGHT: 'sidelight',
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
 * @property {'cube'|'pane'|'door'|'cross'} [shape]  'cube' (default) = full block faces.
 *   'pane' = a single centered quad (chain-link fence, bars, barricade
 *   boards); the tile's alpha channel cuts out the gaps and the voxel's
 *   rotation turns the pane (0/180 = along x, 90/270 = along z). Panes are
 *   depth-written cutouts (not alpha-blended), so they sort correctly
 *   against each other.
 *   'door' = a centered slab with real thickness spanning its footprint
 *   (SIZE.DOOR 2x4, SIZE.SIDELIGHT 1x2, ...); rotation orients it like a
 *   pane and picks the swing side of the open phase (see engine/Doors.js).
 *   Also used for fixed glazing panels (no doorOpen/doorClosed pair) — the
 *   blok sidelight is a static slab meshed by the same code.
 *   'cross' = two crossed diagonal cutout quads spanning the voxel (bushes,
 *   plants) — the same X the ground cover uses, as a placeable block. No
 *   rotation (the X is symmetric); still occupies its full cell for
 *   collision; takes no decals, paint or slab variants.
 * @property {boolean} [shootThrough]  true = attack rays (bullets, swings)
 *   pass through this block; it still blocks movement.
 * @property {boolean} [mixedAlpha]  true = the tile art mixes opaque and
 *   translucent texels (framed window, glazed doors). Meshed into both
 *   passes: solid texels depth-write in the opaque cutout pass, glass
 *   texels (alpha < 0.5) blend in the transparent pass.
 * @property {boolean} [glass]  true = a glass surface: attacks pass through
 *   and burst glass shards at the pane instead of puffing smoke.
 * @property {boolean} [edge]  pane shape only: the quad hugs one side of its
 *   footprint instead of centering — the rotation picks the edge (0: along x
 *   at +z, 1: along z at +x, 2: along x at -z, 3: along z at -x), so the
 *   glass sits flush with the wall face it belongs to (car glazing).
 * @property {string} [icon]  atlas tile shown as this block's palette swatch
 *   (defaults to the top tile) — lets blocks whose top is plain (car parts:
 *   painted body above, the feature art on the sides) show their real face.
 * @property {boolean} [connect]  true = the tile art merges with same-type
 *   neighbours: per face, the mesher checks the four in-plane neighbours and
 *   swaps in the `<tile>_<mask>` atlas variant (mask bits 1/2/4/8 = art
 *   left/right/top/bottom edge continues into the same block), dissolving
 *   the frame on shared edges so a run of blocks reads as one big framed
 *   pane (car windows). The 15 variants are generated alongside the base
 *   tile in textures/TextureAtlas.js.
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
 *   (internal states like a light's dark phase).
 * @property {string} [lightOff]  block id of this light's dark phase. A def
 *   carrying it is a LIGHT: one palette entry with three authored states —
 *   'on' (default), 'off', 'flicker' — stored on the voxel as `lightMode`
 *   and driven by engine/Lights.js + engine/Blinkers.js. An optional
 *   `lightFlag` on the voxel lets a game flag cut its power
 *   (see game/Reactions.js).
 * @property {string} [lightOn]   back-reference from the dark phase; also
 *   the id a light is normalized to when a map is saved.
 * @property {{tufts:string[], tuftChance:number, flowers:string[],
 *   flowerChance:number}} [cover]  ground cover sprouting from this block's
 *   exposed top: the mesher rolls a deterministic per-cell hash and grows a
 *   tuft (tuftChance), a flower (flowerChance) or nothing in the empty cell
 *   above — pure meshing, nothing stored in the world or save files.
 */

// Shared ground-cover config for the grass family: 60% of exposed tops grow
// a tuft (tinted to match the block), 20% a random flower, 20% stay bare.
const GRASS_COVER = (tuft) => ({
  tufts: [tuft],
  tuftChance: 0.6,
  flowers: ['flower_dandelion', 'flower_poppy', 'flower_cornflower', 'flower_daisy'],
  flowerChance: 0.2,
});

/** @type {BlockDef[]} */
const BLOCKS = [
  { id: 'grass', name: 'Grass', tiles: 'grass_top', cover: GRASS_COVER('tuft_grass') },
  { id: 'grass_dry', name: 'Dry Grass', tiles: 'grass_dry', cover: GRASS_COVER('tuft_grass_dry') },
  { id: 'grass_lush', name: 'Lush Grass', tiles: 'grass_lush', cover: GRASS_COVER('tuft_grass_lush') },
  { id: 'dirt', name: 'Dirt', tiles: 'dirt' },
  { id: 'dirt_dry', name: 'Dry Ground', tiles: 'dirt_dry' },
  { id: 'dirt_dark', name: 'Dark Soil', tiles: 'dirt_dark' },
  { id: 'stone', name: 'Stone', tiles: 'stone' },
  { id: 'stone_dark', name: 'Dark Rock', tiles: 'stone_dark' },
  { id: 'stone_light', name: 'Light Rock', tiles: 'stone_light' },
  { id: 'gravel', name: 'Gravel', tiles: 'gravel' },
  { id: 'sand', name: 'Sand', tiles: 'sand' },
  { id: 'sand_red', name: 'Red Sand', tiles: 'sand_red' },
  { id: 'sand_dark', name: 'Wet Sand', tiles: 'sand_dark' },
  // --- vegetation: canopies and bushes. Leaves are plain opaque cubes (use
  // them for tree crowns instead of grass, which sprouts ground cover);
  // bushes are cross-shaped cutouts you can fight through ---
  { id: 'leaves', name: 'Leaves', tiles: 'leaves' },
  { id: 'leaves_dark', name: 'Dark Leaves', tiles: 'leaves_dark' },
  { id: 'leaves_autumn', name: 'Autumn Leaves', tiles: 'leaves_autumn' },
  { id: 'bush', name: 'Bush', tiles: 'bush', shape: 'cross', opacity: 0, shootThrough: true },
  { id: 'bush_berry', name: 'Berry Bush', tiles: 'bush_berry', shape: 'cross', opacity: 0, shootThrough: true },
  { id: 'bush_dry', name: 'Dry Bush', tiles: 'bush_dry', shape: 'cross', opacity: 0, shootThrough: true },
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
  // side. Each is ONE palette entry with three authored states (on/off/
  // flicker, engine/Lights.js) toggling to its hidden *_off phase and back.
  { id: 'lamp', name: 'Ceiling Light', tiles: 'lamp', light: 15, emitFaces: ['ny'], lightOff: 'lamp_off' },
  { id: 'lamp_off', name: 'Ceiling Light (off)', tiles: 'lamp_off', hidden: true, lightOn: 'lamp' },
  { id: 'neon', name: 'Red Neon', tiles: 'neon_red', light: 9, emitFaces: ['px', 'nx', 'pz', 'nz'], lightOff: 'neon_off' },
  { id: 'neon_off', name: 'Red Neon (off)', tiles: 'neon_off', hidden: true, lightOn: 'neon' },
  // --- mid-90s Poland set: post-communist estates, bazaars, kiosks ---
  { id: 'panel', name: 'Prefab Panel', tiles: 'panel' },
  { id: 'plaster_pastel', name: 'Pastel Plaster', tiles: 'plaster_pastel' },
  { id: 'lastryko', name: 'Terrazzo Floor', tiles: 'lastryko' },
  { id: 'kiosk', name: 'Kiosk Panel', tiles: 'kiosk' },
  { id: 'blacha', name: 'Corrugated Steel', tiles: 'blacha' },
  { id: 'paving', name: 'Paving Slabs', tiles: { py: 'paving', ny: 'concrete', px: 'concrete', nx: 'concrete', pz: 'concrete', nz: 'concrete' } },
  { id: 'brick_sooty', name: 'Sooty Brick', tiles: 'brick_sooty' },
  { id: 'lino', name: 'Linoleum', tiles: 'lino' },
  { id: 'neon_white', name: 'White Neon', tiles: 'neon_white', light: 10, emitFaces: ['px', 'nx', 'pz', 'nz'], lightOff: 'neon_white_off' },
  { id: 'neon_white_off', name: 'White Neon (off)', tiles: 'neon_white_off', hidden: true, lightOn: 'neon_white' },
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
  // blinking lights, driven by engine/Doors.js; zombies can't toggle them).
  // Closed phases have default (full) opacity so they block light and mob
  // sight; open phases keep opacity 0 so light passes through the doorway ---
  { id: 'door_wood', name: 'Entrance Door', tiles: 'door_wood', shape: 'door', fixedSize: SIZE.DOOR, tileSpan: [2, 4], doorOpen: 'door_wood_open' },
  { id: 'door_wood_open', name: 'Entrance Door (open)', tiles: 'door_wood', shape: 'door', opacity: 0, hidden: true, passable: true, shootThrough: true, fixedSize: SIZE.DOOR, tileSpan: [2, 4], doorClosed: 'door_wood' },
  { id: 'door_white', name: 'Interior Door', tiles: 'door_white', shape: 'door', mixedAlpha: true, fixedSize: SIZE.DOOR, tileSpan: [2, 4], doorOpen: 'door_white_open' },
  { id: 'door_white_open', name: 'Interior Door (open)', tiles: 'door_white', shape: 'door', opacity: 0, mixedAlpha: true, hidden: true, passable: true, shootThrough: true, fixedSize: SIZE.DOOR, tileSpan: [2, 4], doorClosed: 'door_white' },
  { id: 'door_shop', name: 'Shop Door', tiles: 'door_shop', shape: 'door', mixedAlpha: true, fixedSize: SIZE.DOOR, tileSpan: [2, 4], doorOpen: 'door_shop_open' },
  { id: 'door_shop_open', name: 'Shop Door (open)', tiles: 'door_shop', shape: 'door', opacity: 0, mixedAlpha: true, hidden: true, passable: true, shootThrough: true, fixedSize: SIZE.DOOR, tileSpan: [2, 4], doorClosed: 'door_shop' },
  { id: 'door_steel', name: 'Steel Door', tiles: 'door_steel', shape: 'door', mixedAlpha: true, fixedSize: SIZE.DOOR, tileSpan: [2, 4], doorOpen: 'door_steel_open' },
  { id: 'door_steel_open', name: 'Steel Door (open)', tiles: 'door_steel', shape: 'door', opacity: 0, mixedAlpha: true, hidden: true, passable: true, shootThrough: true, fixedSize: SIZE.DOOR, tileSpan: [2, 4], doorClosed: 'door_steel' },
  // Wielka płyta stairwell entrance (pair with the domofon decal): the leaf
  // is a regular 2x4 door; the fixed wired-glass sidelight beside it is its
  // own block (1x2 panels stacked to the doorway height), so only the leaf
  // swings when the door opens.
  { id: 'door_blok', name: 'Blok Entrance Door', tiles: 'door_blok', shape: 'door', mixedAlpha: true, fixedSize: SIZE.DOOR, tileSpan: [2, 4], doorOpen: 'door_blok_open' },
  { id: 'door_blok_open', name: 'Blok Entrance Door (open)', tiles: 'door_blok', shape: 'door', opacity: 0, mixedAlpha: true, hidden: true, passable: true, shootThrough: true, fixedSize: SIZE.DOOR, tileSpan: [2, 4], doorClosed: 'door_blok' },
  { id: 'sidelight', name: 'Blok Sidelight', tiles: 'sidelight', shape: 'door', mixedAlpha: true, opacity: 0, fixedSize: SIZE.SIDELIGHT, tileSpan: [1, 2] },
  // --- Nysa van kit: each factory paint gets a plain body panel, a chrome
  // beltline panel, a grille and a headlight; the rubber-gasket window,
  // wheel and bumper are shared across colours. Feature tiles sit on the
  // four side faces so the block works whichever way the van points ---
  { id: 'car_body_blue', name: 'Car Body (blue)', tiles: 'car_body_blue' },
  { id: 'car_trim_blue', icon: 'car_trim_blue', name: 'Car Beltline (blue)', tiles: { py: 'car_body_blue', ny: 'car_body_blue', px: 'car_trim_blue', nx: 'car_trim_blue', pz: 'car_trim_blue', nz: 'car_trim_blue' } },
  { id: 'car_grille_blue', icon: 'car_grille_blue', name: 'Car Grille (blue)', tiles: { py: 'car_body_blue', ny: 'car_body_blue', px: 'car_grille_blue', nx: 'car_grille_blue', pz: 'car_grille_blue', nz: 'car_grille_blue' } },
  { id: 'car_light_blue', icon: 'car_light_blue', name: 'Car Headlight (blue)', tiles: { py: 'car_body_blue', ny: 'car_body_blue', px: 'car_light_blue', nx: 'car_light_blue', pz: 'car_light_blue', nz: 'car_light_blue' } },
  { id: 'car_tail_blue', icon: 'car_tail_blue', name: 'Car Tail Light (blue)', tiles: { py: 'car_body_blue', ny: 'car_body_blue', px: 'car_tail_blue', nx: 'car_tail_blue', pz: 'car_tail_blue', nz: 'car_tail_blue' } },
  { id: 'car_body_red', name: 'Car Body (red)', tiles: 'car_body_red' },
  { id: 'car_trim_red', icon: 'car_trim_red', name: 'Car Beltline (red)', tiles: { py: 'car_body_red', ny: 'car_body_red', px: 'car_trim_red', nx: 'car_trim_red', pz: 'car_trim_red', nz: 'car_trim_red' } },
  { id: 'car_grille_red', icon: 'car_grille_red', name: 'Car Grille (red)', tiles: { py: 'car_body_red', ny: 'car_body_red', px: 'car_grille_red', nx: 'car_grille_red', pz: 'car_grille_red', nz: 'car_grille_red' } },
  { id: 'car_light_red', icon: 'car_light_red', name: 'Car Headlight (red)', tiles: { py: 'car_body_red', ny: 'car_body_red', px: 'car_light_red', nx: 'car_light_red', pz: 'car_light_red', nz: 'car_light_red' } },
  { id: 'car_tail_red', icon: 'car_tail_red', name: 'Car Tail Light (red)', tiles: { py: 'car_body_red', ny: 'car_body_red', px: 'car_tail_red', nx: 'car_tail_red', pz: 'car_tail_red', nz: 'car_tail_red' } },
  { id: 'car_body_cream', name: 'Car Body (cream)', tiles: 'car_body_cream' },
  { id: 'car_trim_cream', icon: 'car_trim_cream', name: 'Car Beltline (cream)', tiles: { py: 'car_body_cream', ny: 'car_body_cream', px: 'car_trim_cream', nx: 'car_trim_cream', pz: 'car_trim_cream', nz: 'car_trim_cream' } },
  { id: 'car_grille_cream', icon: 'car_grille_cream', name: 'Car Grille (cream)', tiles: { py: 'car_body_cream', ny: 'car_body_cream', px: 'car_grille_cream', nx: 'car_grille_cream', pz: 'car_grille_cream', nz: 'car_grille_cream' } },
  { id: 'car_light_cream', icon: 'car_light_cream', name: 'Car Headlight (cream)', tiles: { py: 'car_body_cream', ny: 'car_body_cream', px: 'car_light_cream', nx: 'car_light_cream', pz: 'car_light_cream', nz: 'car_light_cream' } },
  { id: 'car_tail_cream', icon: 'car_tail_cream', name: 'Car Tail Light (cream)', tiles: { py: 'car_body_cream', ny: 'car_body_cream', px: 'car_tail_cream', nx: 'car_tail_cream', pz: 'car_tail_cream', nz: 'car_tail_cream' } },
  { id: 'car_window', name: 'Car Window', tiles: 'car_window', shape: 'pane', edge: true, opacity: 0, mixedAlpha: true, shootThrough: true, glass: true, connect: true },
  { id: 'car_wheel', icon: 'car_wheel', name: 'Car Wheel', tiles: { py: 'car_tire', ny: 'car_tire', px: 'car_wheel', nx: 'car_wheel', pz: 'car_wheel', nz: 'car_wheel' } },
  { id: 'car_bumper', name: 'Car Bumper', tiles: 'car_bumper' },
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

/** True if same-type neighbours merge this block's tile art: the mesher
 *  picks a `<tile>_<mask>` frame variant per face (see BlockDef.connect). */
export function isConnecting(id) {
  return REGISTRY.get(id)?.connect === true;
}

/** Ground-cover config of a block id (tufts/flowers sprouting from its
 *  exposed top), or null for bare blocks. */
export function coverFor(id) {
  return REGISTRY.get(id)?.cover ?? null;
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
 * @property {boolean} [hidden]  true = kept out of the editor palette
 *   (internal states like the wall switch's flipped-on art).
 * @property {string} [switchOn]   decal id of this switch's ON art. A def
 *   carrying it is a SWITCH: the placed decal stores the game flag it
 *   drives (`flag` on the decal entry) and E in the game flips flag and
 *   art together — see engine/Switches.js + game/Reactions.js.
 * @property {string} [switchOff]  back-reference from the ON art; also the
 *   id a switch is normalized to when a map is saved.
 * @property {boolean} [climbable]  true = a player whose AABB touches the
 *   decal's face plane can climb it (ladders) — see editor/WalkControls.js.
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
  { id: 'decal_cigs', name: 'Cigarette Butts', tile: 'decal_cigs' },
  { id: 'decal_poop', name: 'Dog Poop', tile: 'decal_poop' },
  { id: 'decal_seeds', name: 'Sunflower Seeds', tile: 'decal_seeds' },
  { id: 'decal_graffiti', name: 'Graffiti', tile: 'decal_graffiti', span: [4, 2] },
  { id: 'decal_stop', name: 'STOP Marking', tile: 'decal_stop', span: [4, 4] },
  { id: 'decal_arrow', name: 'Road Arrow', tile: 'decal_arrow', span: [2, 4] },
  // --- mid-90s Poland set ---
  { id: 'decal_poster', name: 'Peeling Poster', tile: 'decal_poster', span: [2, 2] },
  { id: 'decal_sklep', name: 'SKLEP Sign', tile: 'decal_sklep', span: [4, 1] },
  { id: 'decal_club', name: 'Club Graffiti', tile: 'decal_club', span: [4, 2] },
  { id: 'decal_hwdp', name: 'HWDP Tag', tile: 'decal_hwdp', span: [4, 2] },
  { id: 'decal_kotwica', name: 'Kotwica Stencil', tile: 'decal_kotwica', span: [2, 2] },
  { id: 'decal_anarchy', name: 'Anarchy A', tile: 'decal_anarchy', span: [2, 2] },
  { id: 'decal_damp', name: 'Damp Stain', tile: 'decal_damp', span: [2, 2] },
  { id: 'decal_ads', name: 'Tear-off Ads', tile: 'decal_ads' },
  { id: 'decal_zebra', name: 'Zebra Crossing', tile: 'decal_zebra', span: [2, 4] },
  { id: 'decal_rug', name: 'Rug', tile: 'decal_rug', span: [2, 2] },
  { id: 'decal_bottles', name: 'Bottles & Caps', tile: 'decal_bottles' },
  { id: 'decal_curtain', name: 'Lace Curtain', tile: 'decal_curtain' },
  { id: 'decal_hopscotch', name: 'Chalk Hopscotch', tile: 'decal_hopscotch', span: [1, 4] },
  { id: 'decal_domofon', name: 'Domofon Panel', tile: 'decal_domofon' },
  // --- 90s apartment interior set ---
  { id: 'decal_jelen', name: 'Deer Print', tile: 'decal_jelen', span: [2, 2] },
  { id: 'decal_photos', name: 'Family Photos', tile: 'decal_photos', span: [2, 2] },
  { id: 'decal_makatka', name: 'Makatka', tile: 'decal_makatka', span: [2, 1] },
  { id: 'decal_kalendarz', name: 'Wall Calendar', tile: 'decal_kalendarz' },
  { id: 'decal_lustro', name: 'Mirror & Shelf', tile: 'decal_lustro', span: [1, 2] },
  { id: 'decal_junkers', name: 'Gas Heater', tile: 'decal_junkers', span: [1, 2] },
  { id: 'decal_telefon', name: 'Wall Phone', tile: 'decal_telefon' },
  // Functional: touching its face lets the player climb (WalkControls).
  { id: 'decal_ladder', name: 'Ladder', tile: 'decal_ladder', span: [1, 4], climbable: true },
  // The 90s Polish flip switch (wyłącznik): cream plastic plate, one big
  // rocker. A placed one carries a `flag` — E in the game flips the flag,
  // and anything bound to it (lights, door locks) reacts. Art swaps between
  // the two ids at runtime; maps always store the OFF id (state lives in
  // the flag store, not the map).
  { id: 'decal_switch', name: 'Light Switch', tile: 'decal_switch', switchOn: 'decal_switch_on' },
  { id: 'decal_switch_on', name: 'Light Switch (on)', tile: 'decal_switch_on', hidden: true, switchOff: 'decal_switch' },
];

const DECAL_REGISTRY = new Map(DECALS.map((d) => [d.id, d]));

/** The six voxel face names a decal can attach to. */
export const FACES = Object.freeze(['px', 'nx', 'py', 'ny', 'pz', 'nz']);

// A pane is a single quad centered in its voxel, so only the two faces it
// looks along can carry a decal: rotation 0/2 runs the pane along x (it
// faces +-z), 1/3 along z (facing +-x). Doors carry none.
const PANE_FACES_Z = Object.freeze(['pz', 'nz']);
const PANE_FACES_X = Object.freeze(['px', 'nx']);
const NO_FACES = Object.freeze([]);

/** Faces of a placed voxel that can carry a decal. Cubes take all six; a
 *  shape:'pane' voxel takes only its two flat sides, so a lace curtain lands
 *  on the glass itself rather than on the cell boundary around it. */
export function decalFacesFor(id, rotation = 0) {
  const shape = shapeFor(id);
  if (shape === 'cube') return FACES;
  if (shape === 'pane') return (rotation & 1) === 0 ? PANE_FACES_Z : PANE_FACES_X;
  return NO_FACES;
}

/** True when a decal may be pinned to this face of a placed voxel. */
export function acceptsDecal(id, rotation, face) {
  return decalFacesFor(id, rotation).includes(face);
}

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

/** True when the decal id resolves to a climbable decal (ladders). */
export function isClimbableDecal(id) {
  return !!DECAL_REGISTRY.get(id)?.climbable;
}

/** Register a decal definition at runtime (text signs, mods, tests).
 *  Replaces any decal with the same id. The tile it references must exist
 *  in the atlas (static or runtime-registered). */
export function registerDecal(def) {
  DECAL_REGISTRY.set(def.id, def);
}

/** Remove a runtime-registered decal (drawn decals, text signs). The caller
 *  strips world placements first, so no map ends up referencing the id. */
export function unregisterDecal(id) {
  return DECAL_REGISTRY.delete(id);
}
