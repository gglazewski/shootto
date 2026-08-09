// TextDecals.js — user-defined text sign decals (SKLEP, RZEŹNIK, KWIATY…).
//
// A text sign is an ordinary decal whose tile art is rendered at runtime
// from a spec: { text, fg, bg, height, width }. The spec lives on the decal
// def (textSpec), persists in the map file (WorldSerializer `textDecals`)
// and re-registers on load, so signs survive save/load like any block.
//
// Ids are content-addressed (hash of the normalized spec): creating the
// same sign twice reuses the same decal, and a map referencing a sign id
// recreates it byte-identically.

import { registerDecal, getDecal, listDecalIds } from './VoxelTypes.js';
import { registerRuntimeTile, TILE_SIZE } from '../textures/TextureAtlas.js';
import { renderTextMask, normalizeText } from '../textures/PixelFont.js';

export const MAX_TEXT_LENGTH = 24;
export const MAX_WIDTH_CELLS = 8; // one atlas row
const MARGIN = 2; // px kept free around the text inside the tile

/** '#rgb' / '#rrggbb' -> [r,g,b], or fallback when unparsable. */
export function parseHexColor(str, fallback) {
  if (typeof str === 'string') {
    const m = str.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (m) {
      let hex = m[1];
      if (hex.length === 3) hex = hex.replace(/./g, (c) => c + c);
      const v = parseInt(hex, 16);
      return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
    }
  }
  return fallback;
}

const toHex = ([r, g, b]) => `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;

/**
 * Normalize a raw sign spec to its canonical, serializable form.
 * @returns {{text:string, fg:string, bg:string|null, height:1|2, width:number|null}}
 *   `bg: null` = transparent background (painted-on lettering);
 *   `width: null` = auto (sized to fit the text).
 */
export function normalizeSpec(raw = {}) {
  const text = normalizeText(raw.text).trim().slice(0, MAX_TEXT_LENGTH);
  const fg = toHex(parseHexColor(raw.fg, [24, 20, 16]));
  const bg = raw.bg == null ? null : toHex(parseHexColor(raw.bg, [232, 168, 32]));
  const height = Number(raw.height) === 2 ? 2 : 1;
  let width = Number.isFinite(Number(raw.width)) && raw.width !== null && raw.width !== '' && Number(raw.width) > 0
    ? Math.min(MAX_WIDTH_CELLS, Math.max(1, Math.round(Number(raw.width))))
    : null;
  return { text, fg, bg, height, width };
}

/** Text mask, integer pixel scale and cell span for a normalized spec.
 *  Scale fills the band height, then shrinks until the text fits the fixed
 *  width (or the atlas row for auto width); auto width hugs the text. */
export function signLayout(spec) {
  const mask = renderTextMask(spec.text);
  let scale = Math.max(1, Math.floor((spec.height * TILE_SIZE - MARGIN) / mask.height));
  const maxPx = (spec.width ?? MAX_WIDTH_CELLS) * TILE_SIZE - MARGIN;
  while (scale > 1 && mask.width * scale > maxPx) scale--;
  const widthCells = spec.width
    ?? Math.min(MAX_WIDTH_CELLS, Math.max(1, Math.ceil((mask.width * scale + MARGIN) / TILE_SIZE)));
  return { mask, scale, span: [widthCells, spec.height] };
}

/**
 * Pure: render a sign as flat RGBA (span*16 px). Used for the atlas tile
 * and for the editor's live preview, so both always match.
 * @returns {{width:number, height:number, data:Uint8ClampedArray}}
 */
export function renderSignPixels(spec) {
  const norm = normalizeSpec(spec);
  const { mask, scale, span } = signLayout(norm);
  const W = span[0] * TILE_SIZE;
  const H = span[1] * TILE_SIZE;
  const fg = parseHexColor(norm.fg, [24, 20, 16]);
  const bg = norm.bg == null ? null : parseHexColor(norm.bg, [232, 168, 32]);
  const rim = bg ? bg.map((v) => Math.round(v * 0.55)) : null;
  const ox = Math.round((W - mask.width * scale) / 2);
  const oy = Math.round((H - mask.height * scale) / 2);
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      let px = null;
      const mx = Math.floor((x - ox) / scale);
      const my = Math.floor((y - oy) / scale);
      const onText = mx >= 0 && mx < mask.width && my >= 0 && my < mask.height && mask.data[my * mask.width + mx];
      if (onText) px = [fg[0], fg[1], fg[2], 255];
      else if (bg) {
        const onRim = x === 0 || y === 0 || x === W - 1 || y === H - 1;
        const c = onRim ? rim : bg;
        px = [c[0], c[1], c[2], 255];
      } else px = [0, 0, 0, 0];
      data[i] = px[0]; data[i + 1] = px[1]; data[i + 2] = px[2]; data[i + 3] = px[3];
    }
  }
  return { width: W, height: H, data };
}

/** Content-addressed decal id for a spec (same sign -> same id). */
export function textDecalId(spec) {
  const norm = normalizeSpec(spec);
  const key = JSON.stringify([norm.text, norm.fg, norm.bg, norm.height, norm.width]);
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = (((h * 33) >>> 0) ^ key.charCodeAt(i)) >>> 0;
  return `decal_text_${h.toString(36)}`;
}

/**
 * Register a text sign decal (tile + decal def). Idempotent: an already
 * registered id is returned as-is. Returns null for empty text.
 * @param {object} raw  sign spec (see normalizeSpec)
 * @param {{id?: string}} [opts]  pin the decal id (map loading)
 * @returns {{id:string, span:[number,number]}|null}
 */
export function createTextDecal(raw, { id } = {}) {
  const spec = normalizeSpec(raw);
  if (!spec.text) return null;
  const decalId = id ?? textDecalId(spec);
  const existing = getDecal(decalId);
  if (existing?.textSpec) return { id: decalId, span: existing.span };
  const { span } = signLayout(spec);
  const art = renderSignPixels(spec);
  const gen = (x, y) => {
    const i = (y * art.width + x) * 4;
    return [art.data[i], art.data[i + 1], art.data[i + 2], art.data[i + 3]];
  };
  registerRuntimeTile(decalId, gen, span);
  registerDecal({ id: decalId, name: `Sign "${spec.text}"`, tile: decalId, span, textSpec: spec });
  return { id: decalId, span };
}

/** The sign spec of a decal id, or null for ordinary decals. */
export function textSpecOf(id) {
  return getDecal(id)?.textSpec ?? null;
}

/** True if the decal id is a runtime text sign. */
export function isTextDecal(id) {
  return !!textSpecOf(id);
}

/** Ids of all registered text sign decals. */
export function listTextDecalIds() {
  return listDecalIds().filter((id) => isTextDecal(id));
}
