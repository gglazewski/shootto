// AtlasTexture.three.js — browser/three adapter that turns the pure atlas
// pixel buffer into a THREE.CanvasTexture.
//
// Kept separate from TextureAtlas.js so the pure tile generators stay 100%
// three/DOM-free and unit-testable in Node.

import { renderAtlasRGBA, tilesForBlocks, TILE_SIZE } from './TextureAtlas.js';
import { tileFor, getDecal } from '../engine/VoxelTypes.js';

/**
 * Browser: build a THREE texture + a face->index resolver for meshing.
 * The returned `rebuild()` re-renders the atlas in place after runtime
 * tiles were registered (text signs): the name->index map is mutated, not
 * replaced, so every captured `tileIndexFor` closure stays valid — callers
 * only need to remesh chunks afterwards.
 * @param {import('three')} THREE
 */
export function createAtlasTexture(THREE) {
  const canvas = document.createElement('canvas');
  const map = new Map();
  let atlasDims = { width: 0, height: 0 };
  const paint = () => {
    const r = renderAtlasRGBA(tilesForBlocks());
    canvas.width = r.width;
    canvas.height = r.height;
    canvas.getContext('2d').putImageData(new ImageData(r.data, r.width, r.height), 0, 0);
    map.clear();
    for (const [name, index] of r.map) map.set(name, index);
    atlasDims = r.atlas;
  };
  paint();
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.flipY = true;
  // Resolves block ids (per-face tiles), decal ids (single tile) AND raw
  // tile names (ground-cover tufts/flowers, which belong to no block face),
  // so the mesher can look everything up through the same callback.
  const tileIndexFor = (typeId, face) => map.get(getDecal(typeId)?.tile ?? tileFor(typeId, face) ?? typeId);
  // Live tile-map ref for the mesh worker pool: `map` is mutated in place by
  // paint(), `rev` tells the pool when to re-send it to its workers.
  const tiles = { map, rev: 0 };
  const rebuild = () => {
    paint();
    tiles.rev++;
    texture.needsUpdate = true;
  };
  return { texture, tileIndexFor, atlas: { ...atlasDims, tileSize: TILE_SIZE }, rebuild, tiles };
}
