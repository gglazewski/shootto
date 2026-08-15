// ItemMeshBuilder.js — pure geometry for a micro-voxel item.
//
// Produces a greedily merged mesh in item-local units: each micro cell is
// 1x1x1 and the whole item spans [0, MICRO_GRID]^3. The caller scales the
// mesh by MICRO_SIZE to get world meters. Interior faces between two filled
// micro-voxels are culled; coplanar runs of faces with the same color are
// merged into single rectangles (classic greedy meshing), which cuts the
// triangle count of furnished rooms by ~4-5x. Items are untextured, so color
// equality is the only merge constraint — no UVs or AO to preserve. A simple
// per-face brightness is baked into the vertex colors so items read as 3D
// without scene lights.

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

// Per-face merge metadata derived once from the corner table: the normal axis,
// the plane offset of the face within its cell (0 or 1), the two in-plane axes
// and, per corner, whether it sits at the rect's min or max along each of
// them. Mapping the unit-cell corners through a merged rect this way keeps the
// original winding for any rectangle size.
const FACE_PLAN = Object.freeze(Object.entries(FACES).map(([name, f]) => {
  const axis = f.n[0] ? 0 : f.n[1] ? 1 : 2;
  const plane = f.corners[0][axis];
  const axisA = (axis + 1) % 3;
  const axisB = (axis + 2) % 3;
  const bits = f.corners.map((c) => [c[axisA], c[axisB]]);
  return { name, n: f.n, axis, plane, axisA, axisB, bits };
}));

const keyOf = (x, y, z) => `${x},${y},${z}`;
const AX = ['x', 'y', 'z'];

/**
 * @param {{x:number,y:number,z:number,color:[number,number,number]}[]} microVoxels
 * @returns {{positions:Float32Array, normals:Float32Array, colors:Float32Array, indices:Uint32Array}}
 */
export function buildItemGeometry(microVoxels) {
  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];
  if (!microVoxels.length) {
    return {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      colors: new Float32Array(0),
      indices: new Uint32Array(0),
    };
  }

  // Occupancy -> palette index, so color equality is one integer compare.
  const palette = [];
  const paletteIdx = new Map();
  const occ = new Map();
  for (const v of microVoxels) {
    const ck = (v.color[0] << 16) | (v.color[1] << 8) | v.color[2];
    let ci = paletteIdx.get(ck);
    if (ci === undefined) {
      ci = palette.length;
      paletteIdx.set(ck, ci);
      palette.push(v.color);
    }
    occ.set(keyOf(v.x, v.y, v.z), ci);
  }

  for (const plan of FACE_PLAN) {
    const { name, n, axis, plane, axisA, axisB, bits } = plan;
    const bright = BRIGHTNESS[name];

    // Collect emitting faces grouped by their slice (cell coord along the
    // normal axis): the face exists when the neighbor across it is empty.
    const slices = new Map();
    let aMin = MICRO_GRID, aMax = -1, bMin = MICRO_GRID, bMax = -1;
    for (const v of microVoxels) {
      if (occ.has(keyOf(v.x + n[0], v.y + n[1], v.z + n[2]))) continue;
      const slice = v[AX[axis]];
      let list = slices.get(slice);
      if (!list) { list = []; slices.set(slice, list); }
      const a = v[AX[axisA]], b = v[AX[axisB]];
      list.push(a, b, occ.get(keyOf(v.x, v.y, v.z)));
      if (a < aMin) aMin = a; if (a > aMax) aMax = a;
      if (b < bMin) bMin = b; if (b > bMax) bMax = b;
    }
    if (!slices.size) continue;

    const width = bMax - bMin + 1;
    const mask = new Int32Array((aMax - aMin + 1) * width);
    for (const [slice, list] of slices) {
      // Greedy-merge the slice: run-length along axisB, then grow each run
      // along axisA while the whole run stays color-identical.
      mask.fill(-1);
      for (let i = 0; i < list.length; i += 3) {
        mask[(list[i] - aMin) * width + (list[i + 1] - bMin)] = list[i + 2];
      }
      for (let a = 0; a <= aMax - aMin; a++) {
        let b = 0;
        while (b < width) {
          const ci = mask[a * width + b];
          if (ci < 0) { b++; continue; }
          let b1 = b;
          while (b1 + 1 < width && mask[a * width + b1 + 1] === ci) b1++;
          let a1 = a;
          grow: while (a1 + 1 <= aMax - aMin) {
            for (let bb = b; bb <= b1; bb++) {
              if (mask[(a1 + 1) * width + bb] !== ci) break grow;
            }
            a1++;
          }
          for (let aa = a; aa <= a1; aa++) {
            for (let bb = b; bb <= b1; bb++) mask[aa * width + bb] = -1;
          }

          // Emit one quad for the merged rect [a..a1]x[b..b1] (cell coords).
          const lo = [0, 0, 0];
          const hi = [0, 0, 0];
          lo[axisA] = aMin + a; hi[axisA] = aMin + a1 + 1;
          lo[axisB] = bMin + b; hi[axisB] = bMin + b1 + 1;
          const [r, g, bl] = palette[ci];
          const cr = (r * bright) / 255, cg = (g * bright) / 255, cb = (bl * bright) / 255;
          const first = positions.length / 3;
          for (const [bitA, bitB] of bits) {
            const p = [0, 0, 0];
            p[axis] = slice + plane;
            p[axisA] = bitA ? hi[axisA] : lo[axisA];
            p[axisB] = bitB ? hi[axisB] : lo[axisB];
            positions.push(p[0], p[1], p[2]);
            normals.push(n[0], n[1], n[2]);
            colors.push(cr, cg, cb);
          }
          indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
          b = b1 + 1;
        }
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
  };
}
