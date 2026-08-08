// mobSprites.js — Doom-style mob sprite sheets cut from the hand-drawn art.
//
// The poses were chroma-keyed off the source sheets' magenta backdrop and
// packed into one horizontal strip of equal-sized frames per character,
// bottom-aligned on the ground line so a mob's feet stay planted across the
// whole animation. The strips ship as base64 data URLs (mobSheetData.js) and
// are painted into a canvas here, one per character, because the renderer wants
// a canvas per sprite sheet. See tools/cut_mob_sheet.py for the cut itself.
//
// Animation strip frames:
//   idle[0,1]  walk[2,3,4]  attack[5,6]  hurt[7,8]  dead[9,10,11]
//
// Decoding an <img> is asynchronous even for a data URL, so buildMobSpriteSheet
// hands back the canvas immediately (blank on the very first call) plus a
// `ready` promise that resolves once the art has been painted into it. Callers
// that upload the canvas to the GPU must re-upload when `ready` settles.

import {
  MOB_SHEET_URLS,
  SHEET_FRAME_W,
  SHEET_FRAME_H,
  SHEET_FRAME_COUNT,
  SHEET_STAND_ROWS,
  SHEET_GROUND_ROW,
} from './mobSheetData.js';

export { SHEET_STAND_ROWS, SHEET_GROUND_ROW };

/** Layout of the sheet: animation state -> indices into the strip */
export const FRAMES = Object.freeze({
  idle: [0, 1],
  // Two drawn strides make a four-beat cycle: stride, pass, mirrored stride,
  // pass again — frame 4 is frame 3 flipped, so the opposite leg leads.
  walk: [2, 3, 2, 4],
  attack: [5, 6],
  hurt: [7, 8],
  // Collapse, hit the floor, lie still. Played once (see frameFor).
  dead: [9, 10, 11],
});
export const FRAME_COUNT = SHEET_FRAME_COUNT;

/**
 * The characters that can walk out of a spawn point, in a fixed order so a
 * seeded pick stays stable between runs. Every mob type draws from all of them
 * — a spawn's type decides its stats and size, its skin only decides its look.
 */
export const MOB_SKINS = Object.freeze(Object.keys(MOB_SHEET_URLS));
const DEFAULT_SKIN = MOB_SKINS[0];

/** A random character for a freshly spawned mob. @param {() => number} [rng] */
export function randomMobSkin(rng = Math.random) {
  return MOB_SKINS[Math.floor(rng() * MOB_SKINS.length) % MOB_SKINS.length];
}

/** Decoded strips, shared by every sheet built from them. Keyed by skin name. */
const strips = new Map();

function loadStrip(skin) {
  let entry = strips.get(skin);
  if (entry) return entry;
  const img = new Image();
  entry = {
    img,
    load: new Promise((resolve, reject) => {
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`mob sprite strip "${skin}" failed to decode`));
    }),
  };
  img.src = MOB_SHEET_URLS[skin] ?? MOB_SHEET_URLS[DEFAULT_SKIN];
  strips.set(skin, entry);
  return entry;
}

/** Paints a strip into its sheet canvas. */
function paint(sheet, img) {
  const { ctx } = sheet;
  ctx.clearRect(0, 0, SHEET_FRAME_W * FRAME_COUNT, SHEET_FRAME_H);
  ctx.drawImage(img, 0, 0);
  sheet.painted = true;
}

/**
 * Builds the sprite sheet canvas strip for one character.
 *
 * @param {string} skin Character name (see MOB_SKINS)
 * @returns {{ canvas: HTMLCanvasElement, frameW: number, frameH: number,
 *            frames: typeof FRAMES, ready: Promise<HTMLCanvasElement> }}
 */
export function buildMobSpriteSheet(skin) {
  const canvas = document.createElement('canvas');
  canvas.width = SHEET_FRAME_W * FRAME_COUNT;
  canvas.height = SHEET_FRAME_H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const sheet = { ctx, painted: false };
  const strip = loadStrip(skin);
  const ready = strip.load.then((img) => {
    if (!sheet.painted) paint(sheet, img);
    return canvas;
  });
  // A strip that has already decoded (a second mob wearing the same skin) can
  // be painted right away, skipping a frame of blank billboard.
  if (strip.img.complete && strip.img.naturalWidth > 0) paint(sheet, strip.img);

  return {
    canvas,
    frameW: SHEET_FRAME_W,
    frameH: SHEET_FRAME_H,
    frames: FRAMES,
    ready,
  };
}

/** Utility check to verify DOM canvas availability */
export function canDrawSprites() {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}
