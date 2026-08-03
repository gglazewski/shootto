// ItemGeometry.three.js — three.js adapter that turns the pure item geometry
// (from ItemMeshBuilder) into a BufferGeometry. Kept separate so the pure
// builder stays DOM/three-free and unit-testable in Node.
//
// When a `lightField` is supplied the per-vertex sky/block light is baked into
// a `light` attribute (sampled at each vertex's world cell), so item meshes
// respond to the world's light engine exactly like chunks.

import { buildItemGeometry } from '../engine/ItemMeshBuilder.js';
import { rotateMicroPoint } from '../engine/ItemTypes.js';
import { CELL_SIZE } from '../engine/Space.js';

/**
 * @param {import('three')} THREE
 * @param {{x:number,y:number,z:number,color:[number,number,number]}[]} microVoxels
 * @param {object} [opts]
 * @param {object} [opts.lightField]  LightField to sample sky/block per vertex
 * @param {number} [opts.scale]       world meters per micro-cell (item footprint)
 * @param {[number,number,number]} [opts.offset]  world min corner of the item
 * @param {number} [opts.rotation]    yaw in radians about the footprint centre (placed items)
 * @returns {import('three').BufferGeometry}
 */
export function createItemGeometry(THREE, microVoxels, opts = {}) {
  const d = buildItemGeometry(microVoxels);
  const geo = new THREE.BufferGeometry();
  const count = d.positions.length / 3;
  const positions = d.positions.slice();
  const normals = d.normals.slice();
  const { lightField, scale, offset, rotation = 0 } = opts;
  if (rotation !== 0) {
    // Rotate vertices + normals about the vertical centre axis so the mesh
    // stays axis-aligned (light is baked from the rotated world position).
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    for (let i = 0; i < count; i++) {
      const [rx, rz] = rotateMicroPoint(positions[i * 3], positions[i * 3 + 2], rotation);
      positions[i * 3] = rx;
      positions[i * 3 + 2] = rz;
      const nx = normals[i * 3];
      const nz = normals[i * 3 + 2];
      normals[i * 3] = nx * cos - nz * sin;
      normals[i * 3 + 2] = nx * sin + nz * cos;
    }
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(d.colors, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));

  if (lightField) {
    const s = scale ?? 1;
    const o = offset ?? [0, 0, 0];
    const lights = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const wx = o[0] + positions[i * 3] * s;
      const wy = o[1] + positions[i * 3 + 1] * s;
      const wz = o[2] + positions[i * 3 + 2] * s;
      const sky = lightField.skyAt(Math.floor(wx / CELL_SIZE), Math.floor(wy / CELL_SIZE), Math.floor(wz / CELL_SIZE));
      const block = lightField.blockAt(Math.floor(wx / CELL_SIZE), Math.floor(wy / CELL_SIZE), Math.floor(wz / CELL_SIZE));
      lights[i * 2] = sky / 15;
      lights[i * 2 + 1] = block / 15;
    }
    geo.setAttribute('light', new THREE.BufferAttribute(lights, 2));
  }

  geo.setIndex(new THREE.BufferAttribute(d.indices, 1));
  geo.computeBoundingSphere();
  return geo;
}
