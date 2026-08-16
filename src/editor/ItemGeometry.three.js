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
 * @param {[number,number,number]} [opts.grid]  micro build volume (rotation centre; default 8³)
 * @returns {import('three').BufferGeometry}
 */
export function createItemGeometry(THREE, microVoxels, opts = {}) {
  const d = buildItemGeometry(microVoxels);
  const geo = new THREE.BufferGeometry();
  const count = d.positions.length / 3;
  const positions = d.positions.slice();
  const normals = d.normals.slice();
  const { lightField, scale, offset, rotation = 0, grid } = opts;
  if (rotation !== 0) {
    // Rotate vertices + normals about the vertical centre axis so the mesh
    // stays axis-aligned (light is baked from the rotated world position).
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    for (let i = 0; i < count; i++) {
      const [rx, rz] = rotateMicroPoint(positions[i * 3], positions[i * 3 + 2], rotation, grid?.[0], grid?.[2]);
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

/**
 * Silhouette-hull geometry for the pickup highlight: a clone of an item's
 * geometry carrying an `outlineDir` attribute — at each vertex the normalized
 * average of the face normals meeting at that position. A shader pushes the
 * vertices outward along it and draws back faces only (inverted hull), so the
 * item shows one closed halo around its form instead of a wire over every
 * voxel edge. Averaging by shared position keeps the inflated shell
 * watertight where the voxel mesh has hard per-face normals.
 * @param {import('three')} THREE
 * @param {import('three').BufferGeometry} geo  an item geometry (createItemGeometry)
 * @returns {import('three').BufferGeometry}  caller owns (and disposes) the clone
 */
export function createOutlineGeometry(THREE, geo) {
  const out = geo.clone();
  const pos = out.getAttribute('position');
  const nor = out.getAttribute('normal');
  const keyAt = (i) => `${pos.getX(i)},${pos.getY(i)},${pos.getZ(i)}`;
  const sums = new Map();
  for (let i = 0; i < pos.count; i++) {
    const k = keyAt(i);
    let s = sums.get(k);
    if (!s) sums.set(k, (s = [0, 0, 0]));
    s[0] += nor.getX(i);
    s[1] += nor.getY(i);
    s[2] += nor.getZ(i);
  }
  const dirs = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    let [x, y, z] = sums.get(keyAt(i));
    let len = Math.hypot(x, y, z);
    if (len < 1e-6) {
      // Opposing faces cancelled out — fall back to this vertex's own normal.
      x = nor.getX(i);
      y = nor.getY(i);
      z = nor.getZ(i);
      len = Math.hypot(x, y, z) || 1;
    }
    dirs[i * 3] = x / len;
    dirs[i * 3 + 1] = y / len;
    dirs[i * 3 + 2] = z / len;
  }
  out.setAttribute('outlineDir', new THREE.BufferAttribute(dirs, 3));
  return out;
}
