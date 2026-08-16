// PixelDecals.js — user-drawn pixel-art decals (inventory "New Decal…").
//
// A pixel decal is an ordinary decal whose tile art is a hand-drawn RGBA
// bitmap. The spec { name, span, px } (px = base64 RGBA, span*16 pixels per
// cell) lives on the decal def (pixelSpec), persists in the map file
// (WorldSerializer `pixelDecals`) and re-registers on load, so drawn decals
// survive save/load exactly like text signs (TextDecals.js).
//
// Ids are content-addressed (hash of span + pixels): drawing the same art
// twice reuses the same decal, and a map referencing a drawn decal's id
// recreates it byte-identically.

import { registerDecal, getDecal, listDecalIds } from './VoxelTypes.js';
import { registerRuntimeTile, TILE_SIZE } from '../textures/TextureAtlas.js';

export const MAX_SPAN_CELLS = 4; // per axis — up to 4x4 cells (64x64 px)
export const MAX_NAME_LENGTH = 24;

// Hand-rolled base64 so encode/decode are byte-identical in the browser,
// node tests and the mesh worker without Buffer/atob environment checks.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_REV = new Map([...B64].map((c, i) => [c, i]));

/** RGBA bytes -> base64 string. */
export function encodePixels(data) {
  let out = '';
  for (let i = 0; i < data.length; i += 3) {
    const b0 = data[i], b1 = data[i + 1], b2 = data[i + 2];
    const n = Math.min(3, data.length - i);
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += n > 1 ? B64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)] : '=';
    out += n > 2 ? B64[b2 & 63] : '=';
  }
  return out;
}

/** base64 string -> RGBA bytes, or null when malformed. */
export function decodePixels(str) {
  if (typeof str !== 'string' || str.length % 4 !== 0) return null;
  const pad = str.endsWith('==') ? 2 : str.endsWith('=') ? 1 : 0;
  const out = new Uint8ClampedArray((str.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < str.length; i += 4) {
    const v = [0, 1, 2, 3].map((k) => {
      const c = str[i + k];
      return c === '=' ? 0 : B64_REV.get(c);
    });
    if (v.some((x) => x === undefined)) return null;
    if (o < out.length) out[o++] = (v[0] << 2) | (v[1] >> 4);
    if (o < out.length) out[o++] = ((v[1] & 15) << 4) | (v[2] >> 2);
    if (o < out.length) out[o++] = ((v[2] & 3) << 6) | v[3];
  }
  return out;
}

const clampSpan = (v) => Math.min(MAX_SPAN_CELLS, Math.max(1, Math.round(Number(v) || 1)));

/**
 * Normalize a raw pixel decal spec to its canonical, serializable form.
 * Returns null when the pixel data is missing, malformed, doesn't match the
 * span, or is fully transparent (an invisible decal can't be aimed at).
 * @returns {{name:string, span:[number,number], px:string}|null}
 */
export function normalizePixelSpec(raw = {}) {
  const name = String(raw.name ?? '').trim().slice(0, MAX_NAME_LENGTH) || 'Drawn Decal';
  const span = [clampSpan(raw.span?.[0]), clampSpan(raw.span?.[1])];
  const data = decodePixels(raw.px);
  if (!data || data.length !== span[0] * TILE_SIZE * span[1] * TILE_SIZE * 4) return null;
  let visible = false;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) { visible = true; break; }
  if (!visible) return null;
  // Re-encode so the canonical px string is ours regardless of input padding.
  return { name, span, px: encodePixels(data) };
}

/** Content-addressed decal id for a spec (same art -> same id). */
export function pixelDecalId(spec) {
  const key = `${spec.span[0]}x${spec.span[1]}:${spec.px}`;
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = (((h * 33) >>> 0) ^ key.charCodeAt(i)) >>> 0;
  return `decal_pix_${h.toString(36)}`;
}

/**
 * Register a drawn decal (tile + decal def). Idempotent: an already
 * registered id is returned as-is. Returns null for invalid pixel data.
 * @param {object} raw  pixel decal spec (see normalizePixelSpec)
 * @param {{id?: string}} [opts]  pin the decal id (map loading)
 * @returns {{id:string, span:[number,number]}|null}
 */
export function createPixelDecal(raw, { id } = {}) {
  const spec = normalizePixelSpec(raw);
  if (!spec) return null;
  const decalId = id ?? pixelDecalId(spec);
  const existing = getDecal(decalId);
  if (existing?.pixelSpec) return { id: decalId, span: existing.span };
  const W = spec.span[0] * TILE_SIZE;
  const data = decodePixels(spec.px);
  const gen = (x, y) => {
    const i = (y * W + x) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  };
  registerRuntimeTile(decalId, gen, spec.span);
  registerDecal({ id: decalId, name: spec.name, tile: decalId, span: spec.span, pixelSpec: spec });
  return { id: decalId, span: spec.span };
}

/** The pixel spec of a decal id, or null for ordinary decals. */
export function pixelSpecOf(id) {
  return getDecal(id)?.pixelSpec ?? null;
}

/** True if the decal id is a runtime drawn decal. */
export function isPixelDecal(id) {
  return !!pixelSpecOf(id);
}

/** Ids of all registered drawn decals. */
export function listPixelDecalIds() {
  return listDecalIds().filter((id) => isPixelDecal(id));
}
