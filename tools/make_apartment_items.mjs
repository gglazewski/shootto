// make_apartment_items.mjs — author the 90s Polish apartment furniture set as
// micro-voxel item defs, one importable .json file per object.
//
// Items are normally built by hand in the F2 item editor; the bedroom /
// bathroom pieces below are large enough (500-3000 micro-voxels each) that
// describing them as boxes is far easier than clicking them. Output goes to
// examples/<id>.json in exactly the format the object catalogue's Export
// writes and its Import (drag-and-drop or the Import button) reads back.
//
//   node tools/make_apartment_items.mjs [--dry] [--preview]
//
// Conventions (matching the existing PRL furniture in the bundle):
//   x = width, y = height (0 = floor), z = depth with the FRONT at low z.
//   One micro-voxel is 0.0625 m; one cell is 8 micro-voxels = 0.5 m.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeItem, MICRO_GRID } from '../src/engine/ItemTypes.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'examples');

// --- tiny voxel canvas ------------------------------------------------------

/** A [w, h, d] cell footprint's micro-voxel volume, painted with boxes. */
class Canvas {
  constructor(cells) {
    this.cells = cells;
    [this.gx, this.gy, this.gz] = cells.map((c) => c * MICRO_GRID);
    this.vox = new Map();
  }

  _key(x, y, z) {
    return `${x},${y},${z}`;
  }

  /** Inclusive box fill. Later writes win, so overpainting recolors. */
  box(x0, x1, y0, y1, z0, z1, color) {
    for (const [lo, hi, max, axis] of [[x0, x1, this.gx, 'x'], [y0, y1, this.gy, 'y'], [z0, z1, this.gz, 'z']]) {
      if (lo < 0 || hi >= max || lo > hi) throw new Error(`box out of range on ${axis}: ${lo}..${hi} of ${max}`);
    }
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) this.vox.set(this._key(x, y, z), { x, y, z, color });
      }
    }
    return this;
  }

  /** Inclusive box carve (hollows bowls, door gaps, tub interiors). */
  clear(x0, x1, y0, y1, z0, z1) {
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) this.vox.delete(this._key(x, y, z));
      }
    }
    return this;
  }

  def(id, name, { solid = true, light = null } = {}) {
    return { id, name, solid, cells: this.cells, microVoxels: [...this.vox.values()], light };
  }
}

// --- palette ----------------------------------------------------------------

const WOOD = [156, 110, 62]; // jasny orzech veneer
const WOOD_D = [110, 72, 38];
const WOOD_L = [186, 142, 88];
const MATTRESS = [226, 214, 190];
const DUVET = [154, 58, 58]; // bordo
const DUVET_D = [122, 42, 42];
const LINEN = [240, 238, 230];
const MIRROR = [178, 204, 212];
const PORCELAIN = [236, 236, 230];
const PORCELAIN_D = [204, 204, 196];
const SEAT = [246, 246, 242];
const CHROME = [198, 200, 208];
const FRAME = [172, 174, 180];
const GLASS = [148, 186, 196];
const TILE = [206, 218, 220];
const BRASS = [192, 154, 78]; // mosiężne uchwyty

// --- 1. Łóżko (bed), 1 x 1 x 2 m -------------------------------------------

function bed() {
  const c = new Canvas([2, 2, 4]); // 16 x 16 x 32
  // corner legs (front pair; the back pair is part of the headboard posts)
  for (const x0 of [1, 13]) c.box(x0, x0 + 1, 0, 2, 2, 3, WOOD_D);
  for (const x0 of [0, 14]) c.box(x0, x0 + 1, 0, 4, 30, 31, WOOD_D);
  // footboard
  c.box(0, 15, 3, 9, 0, 1, WOOD);
  c.box(0, 15, 9, 9, 0, 1, WOOD_D);
  // side rails + slat base
  c.box(0, 1, 3, 6, 2, 29, WOOD);
  c.box(14, 15, 3, 6, 2, 29, WOOD);
  c.box(2, 13, 5, 5, 2, 29, WOOD_D);
  // mattress (top face at 0.5 m)
  c.box(1, 14, 6, 7, 2, 29, MATTRESS);
  // duvet over the lower two thirds, draped down the sides
  c.box(1, 14, 8, 9, 2, 21, DUVET);
  c.box(0, 0, 6, 8, 2, 21, DUVET_D);
  c.box(15, 15, 6, 8, 2, 21, DUVET_D);
  c.box(1, 14, 9, 9, 20, 21, DUVET_D); // shaded fold under the turnback
  // turned-back sheet + pillow
  c.box(1, 14, 8, 9, 22, 23, LINEN);
  c.box(2, 13, 8, 10, 24, 29, LINEN);
  // headboard
  c.box(0, 15, 5, 15, 30, 30, WOOD);
  c.box(2, 13, 7, 13, 30, 30, WOOD_L); // inset veneer panel
  c.box(0, 15, 14, 15, 30, 31, WOOD_D); // capping trim
  return c.def('lozko_prl', 'Łóżko');
}

// --- 2. Szafa (wardrobe), 1 x 2 x 0.5 m ------------------------------------

function wardrobe() {
  const c = new Canvas([2, 4, 1]); // 16 x 32 x 8
  c.box(0, 15, 0, 1, 0, 7, WOOD_D); // plinth
  c.box(0, 0, 2, 31, 0, 7, WOOD); // sides
  c.box(15, 15, 2, 31, 0, 7, WOOD);
  c.box(1, 14, 2, 31, 7, 7, WOOD_D); // back panel
  c.box(0, 15, 29, 31, 0, 7, WOOD); // top
  c.box(0, 15, 31, 31, 0, 7, WOOD_D); // cornice
  // two doors, recessed one voxel behind the carcass edge
  c.box(1, 14, 2, 28, 1, 2, WOOD_L);
  c.clear(7, 8, 2, 28, 1, 1); // groove between the leaves
  c.box(2, 5, 8, 26, 1, 1, MIRROR); // mirror on the left leaf, clear of the handle
  // handles
  c.box(6, 6, 14, 18, 0, 0, CHROME);
  c.box(9, 9, 14, 18, 0, 0, CHROME);
  return c.def('szafa_prl', 'Szafa');
}

// --- 3. Sedes (toilet), 0.5 x 1 x 1 m --------------------------------------

function toilet() {
  const c = new Canvas([1, 2, 2]); // 8 x 16 x 16
  c.box(2, 5, 0, 4, 6, 11, PORCELAIN_D); // pedestal
  c.box(1, 6, 5, 8, 4, 11, PORCELAIN); // bowl body
  c.box(1, 6, 9, 9, 3, 11, PORCELAIN); // rim
  c.clear(2, 5, 8, 9, 4, 10); // bowl interior
  c.box(1, 6, 10, 10, 3, 11, SEAT); // seat, down
  c.clear(2, 5, 10, 10, 4, 10);
  c.box(1, 6, 10, 15, 12, 12, SEAT); // lid, up against the cistern
  c.box(0, 7, 9, 15, 13, 15, PORCELAIN); // cistern (spłuczka)
  c.box(3, 4, 8, 9, 11, 12, PORCELAIN_D); // flush pipe down to the bowl
  c.box(2, 5, 15, 15, 14, 14, CHROME); // push button
  return c.def('sedes', 'Sedes');
}

// --- 4. Kabina prysznicowa (shower), 1 x 2 x 1 m ---------------------------

function shower() {
  const c = new Canvas([2, 4, 2]); // 16 x 32 x 16
  // brodzik: floor slab + raised rim
  c.box(0, 15, 0, 0, 0, 15, PORCELAIN);
  c.box(0, 15, 1, 2, 0, 0, PORCELAIN_D);
  c.box(0, 15, 1, 2, 15, 15, PORCELAIN_D);
  c.box(0, 0, 1, 2, 0, 15, PORCELAIN_D);
  c.box(15, 15, 1, 2, 0, 15, PORCELAIN_D);
  c.box(7, 8, 0, 0, 7, 8, CHROME); // drain
  // back + side panels
  c.box(0, 15, 3, 29, 15, 15, TILE);
  c.box(0, 0, 3, 29, 0, 15, TILE);
  c.box(15, 15, 3, 29, 0, 15, TILE);
  // one fixed glass leaf at the front; the other half is the entry
  c.box(1, 7, 3, 29, 0, 0, GLASS);
  c.box(7, 7, 3, 29, 0, 0, FRAME); // leading edge of the leaf
  // frame: corner posts and the top rail
  c.box(0, 0, 3, 30, 0, 0, FRAME);
  c.box(15, 15, 3, 30, 0, 0, FRAME);
  c.box(0, 15, 30, 30, 0, 15, FRAME);
  c.clear(1, 14, 30, 30, 1, 14); // open the roof to a rail, so the cabin reads as a cabin
  // fittings
  c.box(6, 9, 27, 28, 12, 13, CHROME); // shower head
  c.box(7, 8, 28, 28, 13, 14, CHROME); // arm into the wall
  c.box(6, 9, 14, 15, 13, 14, CHROME); // mixer
  c.box(7, 8, 16, 26, 14, 14, CHROME); // riser rail
  return c.def('prysznic', 'Kabina prysznicowa');
}

// --- 5. Wanna (bathtub), 1.5 x 1 x 1 m -------------------------------------

function bathtub() {
  const c = new Canvas([3, 2, 2]); // 24 x 16 x 16
  // enamelled shell — open on top, so the inner faces are meant to be seen
  c.box(0, 0, 0, 9, 0, 15, PORCELAIN);
  c.box(23, 23, 0, 9, 0, 15, PORCELAIN);
  c.box(1, 22, 0, 9, 0, 0, PORCELAIN);
  c.box(1, 22, 0, 9, 15, 15, PORCELAIN);
  c.box(1, 22, 0, 0, 1, 14, PORCELAIN_D); // basin floor
  // Rim highlight — a ring on top of the walls only; filling the whole y=9
  // plane would cap the basin and turn the tub into a box.
  c.box(0, 0, 9, 9, 0, 15, LINEN);
  c.box(23, 23, 9, 9, 0, 15, LINEN);
  c.box(1, 22, 9, 9, 0, 0, LINEN);
  c.box(1, 22, 9, 9, 15, 15, LINEN);
  c.box(11, 12, 0, 0, 7, 8, CHROME); // plug hole
  // mixer at the back edge
  c.box(11, 12, 10, 12, 13, 14, CHROME);
  c.box(11, 12, 12, 12, 11, 13, CHROME); // spout over the basin
  c.box(9, 9, 11, 11, 13, 14, CHROME); // taps
  c.box(14, 14, 11, 11, 13, 14, CHROME);
  return c.def('wanna', 'Wanna');
}

// --- 6. Kredens (sideboard with glazed display top), 1.5 x 2 x 0.5 m -------

function kredens() {
  const c = new Canvas([3, 4, 1]); // 24 x 32 x 8
  // plinth, inset at the front so the base reads as a skirting
  c.box(1, 22, 0, 1, 1, 7, WOOD_D);
  // lower carcass: sides, back, floor
  c.box(0, 0, 2, 11, 0, 7, WOOD);
  c.box(23, 23, 2, 11, 0, 7, WOOD);
  c.box(1, 22, 2, 11, 7, 7, WOOD_D); // back panel
  c.box(1, 22, 2, 2, 0, 7, WOOD_D); // carcass floor
  // two cupboard doors, recessed one voxel behind the carcass edge
  c.box(1, 22, 2, 7, 1, 2, WOOD_L);
  c.clear(11, 12, 2, 7, 1, 1); // groove between the leaves
  c.box(1, 22, 8, 8, 1, 2, WOOD_D); // rail under the drawer band
  // three drawers above the doors
  c.box(1, 22, 9, 11, 1, 2, WOOD_L);
  c.clear(8, 8, 9, 11, 1, 1); // grooves between drawer fronts
  c.clear(15, 15, 9, 11, 1, 1);
  // brass drawer bars and door handles
  c.box(3, 5, 10, 10, 0, 0, BRASS);
  c.box(10, 13, 10, 10, 0, 0, BRASS);
  c.box(18, 20, 10, 10, 0, 0, BRASS);
  c.box(10, 10, 4, 6, 0, 0, BRASS);
  c.box(13, 13, 4, 6, 0, 0, BRASS);
  // countertop slab with a lighter worktop face
  c.box(0, 23, 12, 12, 0, 7, WOOD_D);
  c.box(0, 23, 13, 13, 0, 7, WOOD_L);
  // open niche: side cheeks and back panel only
  c.box(0, 0, 14, 18, 0, 7, WOOD);
  c.box(23, 23, 14, 18, 0, 7, WOOD);
  c.box(1, 22, 14, 18, 7, 7, WOOD);
  // serwetka + kryształowy wazon in the niche
  c.box(9, 14, 14, 14, 2, 5, LINEN);
  c.box(11, 12, 15, 17, 3, 4, GLASS);
  // upper display cabinet: shelf, sides, back
  c.box(0, 23, 19, 19, 0, 7, WOOD);
  c.box(0, 0, 20, 29, 0, 7, WOOD);
  c.box(23, 23, 20, 29, 0, 7, WOOD);
  c.box(1, 22, 20, 29, 7, 7, WOOD_D);
  // glazed doors: wooden leaves with big panes, groove between them
  c.box(1, 22, 20, 29, 1, 2, WOOD_L);
  c.clear(11, 12, 20, 29, 1, 1);
  c.box(2, 9, 21, 28, 1, 1, MIRROR); // left pane
  c.box(14, 21, 21, 28, 1, 1, MIRROR); // right pane
  // brass knobs on the meeting stiles
  c.box(10, 10, 23, 24, 0, 0, BRASS);
  c.box(13, 13, 23, 24, 0, 0, BRASS);
  // top + cornice, like the wardrobe
  c.box(0, 23, 30, 30, 0, 7, WOOD);
  c.box(0, 23, 31, 31, 0, 7, WOOD_D);
  return c.def('kredens', 'Kredens');
}

// --- ASCII preview (--preview) ---------------------------------------------

/** Orthographic letter-per-color projections, for eyeballing a shape without
 *  loading the editor. Front looks along +z, side along +x, top along -y. */
function preview(def) {
  const [gx, gy, gz] = def.cells.map((c) => c * MICRO_GRID);
  const letters = new Map();
  const glyph = (color) => {
    const k = color.join(',');
    if (!letters.has(k)) letters.set(k, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[letters.size % 26]);
    return letters.get(k);
  };
  const grid = new Map(def.microVoxels.map((v) => [`${v.x},${v.y},${v.z}`, v]));
  const at = (x, y, z) => grid.get(`${x},${y},${z}`);

  const plane = (title, cols, rows, pick) => {
    const lines = [`  ${title}`];
    for (let r = rows - 1; r >= 0; r--) {
      let line = '  ';
      for (let c = 0; c < cols; c++) {
        const v = pick(c, r);
        line += v ? glyph(v.color) : '.';
      }
      lines.push(line);
    }
    return lines.join('\n');
  };

  const scanFront = (x, y) => { for (let z = 0; z < gz; z++) { const v = at(x, y, z); if (v) return v; } return null; };
  const scanSide = (z, y) => { for (let x = 0; x < gx; x++) { const v = at(x, y, z); if (v) return v; } return null; };
  const scanTop = (x, z) => { for (let y = gy - 1; y >= 0; y--) { const v = at(x, y, z); if (v) return v; } return null; };

  console.log(`\n=== ${def.name} (${def.id}) ${def.cells.join('x')} cells = ${def.cells.map((c) => c * 0.5).join(' x ')} m, ${def.microVoxels.length} voxels`);
  console.log(plane('front (from -z, y up)', gx, gy, scanFront));
  console.log(plane('side (from -x, y up)', gz, gy, scanSide));
  console.log(plane('top (from +y, z up)', gx, gz, scanTop));
  console.log('  legend: ' + [...letters].map(([c, g]) => `${g}=${c}`).join('  '));
}

// --- write one importable file per object -----------------------------------

const defs = [bed(), wardrobe(), toilet(), shower(), bathtub(), kredens()];

if (process.argv.includes('--preview')) {
  for (const def of defs) preview(def);
  process.exit(0);
}

const dry = process.argv.includes('--dry');
if (!dry) mkdirSync(OUT_DIR, { recursive: true });
for (const def of defs) {
  // serializeItem is the catalogue's own Export encoder, so the files are
  // byte-identical to what pressing Export on the object would download.
  const text = serializeItem(def);
  const file = join(OUT_DIR, `${def.id}.json`);
  if (!dry) writeFileSync(file, text);
  console.log(`${def.id.padEnd(12)} ${def.cells.join('x')} cells, ${String(def.microVoxels.length).padStart(4)} voxels -> ${dry ? '(dry)' : file}`);
}
