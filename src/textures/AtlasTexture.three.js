// AtlasTexture.three.js — browser/three adapter that turns the pure atlas
// pixel buffer into a THREE.CanvasTexture.
//
// Kept separate from TextureAtlas.js so the pure tile generators stay 100%
// three/DOM-free and unit-testable in Node.

import { renderAtlasRGBA, tilesForBlocks, TILE_SIZE } from './TextureAtlas.js';
import { tileFor } from '../engine/VoxelTypes.js';

/**
 * Browser: build a THREE texture + a face->index resolver for meshing.
 * @param {import('three')} THREE
 */
export function createAtlasTexture(THREE) {
  const { width, height, data, map, atlas } = renderAtlasRGBA(tilesForBlocks());
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.flipY = true;
  const tileIndexFor = (typeId, face) => map.get(tileFor(typeId, face));
  return { texture, tileIndexFor, atlas: { ...atlas, tileSize: TILE_SIZE } };
}
