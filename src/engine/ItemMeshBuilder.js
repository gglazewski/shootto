// ItemMeshBuilder.js — pure geometry for a micro-voxel item.
//
// Produces a box-per-micro-voxel mesh in item-local units: each micro cell is
// 1x1x1 and the whole item spans [0, MICRO_GRID]^3. The caller scales the mesh
// by MICRO_SIZE to get world meters. Interior faces between two
// filled micro-voxels are culled; a simple per-face brightness is baked into
// the vertex colors so items read as 3D without scene lights.

import { MICRO_GRID } from './ItemTypes.js';

// Face table: outward normal + the 4 corner offsets (counter-clockwise as seen
// from outside). Indices (0,1,2),(0,2,3) wind outward.
const FACES = Object.freeze({
  px: { n: [1, 0, 0], corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
  nx: { n: [-1, 0, 0], corners: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
  py: { n: [0, 1, 0], corners: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
  ny: { n: [0, -1, 0], corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  pz: { n: [0, 0, 1], corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  nz: { n: [0, 0, -1], corners: [[0, 1, 0], [1, 1, 0], [1, 0, 0], [0, 0, 0]] },
});

const BRIGHTNESS = Object.freeze({ py: 1.0, ny: 0.5, px: 0.8, nx: 0.8, pz: 0.8, nz: 0.8 });

/**
 * @param {{x:number,y:number,z:number,color:[number,number,number]}[]} microVoxels
 * @returns {{positions:Float32Array, normals:Float32Array, colors:Float32Array, indices:Uint32Array}}
 */
export function buildItemGeometry(microVoxels) {
  const occupied = new Set(microVoxels.map((v) => `${v.x},${v.y},${v.z}`));
  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];

  for (const v of microVoxels) {
    for (const [name, f] of Object.entries(FACES)) {
      const nx = v.x + f.n[0];
      const ny = v.y + f.n[1];
      const nz = v.z + f.n[2];
      if (occupied.has(`${nx},${ny},${nz}`)) continue;
      const first = positions.length / 3;
      const bright = BRIGHTNESS[name];
      for (const c of f.corners) {
        positions.push(v.x + c[0], v.y + c[1], v.z + c[2]);
        normals.push(f.n[0], f.n[1], f.n[2]);
        colors.push((v.color[0] * bright) / 255, (v.color[1] * bright) / 255, (v.color[2] * bright) / 255);
      }
      indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
  };
}
