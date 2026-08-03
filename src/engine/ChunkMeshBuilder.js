// ChunkMeshBuilder.js — pure mesh generation for a chunk of the world.
//
// Produces typed arrays (positions/normals/uvs/colors/lights/indices) for
// every exposed face within a chunk. No three.js dependency, so it can be
// unit tested in Node.
//
// Rules:
//  - A face is emitted only when the cell just outside it is empty (opaque
//    voxels only, so interior faces between two voxels are correctly hidden),
//    or when that neighbor is transparent and THIS voxel is opaque (so an
//    opaque face remains visible through glass).
//  - Transparent voxels (glass, torch) go into a separate `transparent`
//    buffer so they can render in a second, alpha-blended pass.
//  - BIG voxels are expanded automatically: each of their sub-cells that has
//    an empty neighbor emits a 0.5m quad, so a 1m block renders as 4 coplanar
//    quads per exposed side.
//  - Simple "vertex AO": each corner is darkened based on the 3 cells that
//    meet at that corner on the outside of the face.
//  - Per-vertex light: each corner averages the sky/block light of the 4
//    cells that meet at it (the cell across the face plus the AO corners),
//    giving smooth interpolated lighting across faces.

import { CELL_SIZE } from './Space.js';
import { opacityFor, isTransparent } from './VoxelTypes.js';

// Face table: for each face, the outward normal n, the in-plane basis u/v
// (unit axis steps with u x v === n) and the origin corner o. Corners:
// c0=o, c1=o+u, c2=o+u+v, c3=o+v. Indices (0,1,2),(0,2,3) wind outward.
//
// `tex` is the 2x2 transform applied to the corner's parametric (u,v) to get
// the atlas (du,dv). It rotates the UVs so the texture's vertical axis (v)
// aligns with world-up (+y) on side faces — the same convention Minecraft
// uses — so directional textures (planks, bark, torch) read consistently on
// all four sides. Top/bottom faces stay identity (texture laid flat).
const TEX_IDENT = [1, 0, 0, 1];        // du=u, dv=v
const TEX_ROT90 = [0, -1, 1, 0];       // du=1-v, dv=u (texture-v -> world +y)
export const FACE_TABLE = Object.freeze({
  px: { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1], o: [1, 0, 0], tex: TEX_ROT90 },
  nx: { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], o: [0, 0, 0], tex: TEX_IDENT },
  py: { n: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0], o: [0, 1, 0], tex: TEX_IDENT },
  ny: { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1], o: [0, 0, 0], tex: TEX_IDENT },
  pz: { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], o: [0, 0, 1], tex: TEX_IDENT },
  nz: { n: [0, 0, -1], u: [0, 1, 0], v: [1, 0, 0], o: [0, 0, 0], tex: TEX_ROT90 },
});

// Brightness for AO levels 0..3 (0 = fully occluded).
const AO_BRIGHTNESS = [0.45, 0.62, 0.82, 1.0];

const DEFAULT_LIGHT = 15;

/** A block is opaque for rendering/culling when fully solid. */
function isOpaqueVoxel(voxel) {
  return voxel == null || opacityFor(voxel.type) >= 255;
}

/**
 * @param {object} world  must expose get(x, y, z) -> voxel | null
 * @param {object} [lightField]  must expose get(x,y,z) -> {sky, block} (0..15)
 * @param {[number,number,number]} origin  chunk min cell coords
 * @param {number} size    chunk edge length in cells
 * @param {(typeId:string, face:string) => number} tileIndexFor  face -> atlas tile index
 * @param {{width:number,height:number,tileSize?:number}} [atlas] tiles per row/column of the atlas
 */
export function buildChunkMesh(world, lightField, origin, size, tileIndexFor, atlas = { width: 4, height: 2 }) {
  const { width: AW, height: AH, tileSize = 16 } = atlas;
  const sky = lightField ? lightField.skyAt.bind(lightField) : () => DEFAULT_LIGHT;
  const block = lightField ? lightField.blockAt.bind(lightField) : () => 0;

  const makeBuffer = () => ({ positions: [], normals: [], uvs: [], colors: [], lights: [], indices: [] });
  const opaqueBuf = makeBuffer();
  const transparentBuf = makeBuffer();

  const [ox, oy, oz] = origin;
  const pushCorner = (buf, x, y, z, nx, ny, nz, u, v, r, g, b, ls, lb) => {
    buf.positions.push(x * CELL_SIZE, y * CELL_SIZE, z * CELL_SIZE);
    buf.normals.push(nx, ny, nz);
    buf.uvs.push(u, v);
    buf.colors.push(r, g, b);
    buf.lights.push(ls, lb);
  };

  const face = (fx, fy, fz, voxel) => {
    const selfTransparent = isTransparent(voxel.type);
    const buf = selfTransparent ? transparentBuf : opaqueBuf;
    for (const name of Object.keys(FACE_TABLE)) {
      const f = FACE_TABLE[name];
      const nx = fx + f.n[0], ny = fy + f.n[1], nz = fz + f.n[2];
      const neighbor = world.get(nx, ny, nz);
      // Cull when the neighbor blocks this face: opaque neighbor always hides
      // it; two transparent voxels hide each other (glass-on-glass).
      if (neighbor && (isOpaqueVoxel(neighbor) || selfTransparent)) continue;

      const tile = tileIndexFor(voxel.type, name);
      const tileW = 1 / AW;
      const tileH = 1 / AH;
      const baseU = (tile % AW) * tileW;
      // The atlas texture is uploaded with flipY=true (v=0 is the canvas
      // bottom row), so a tile in row `ty` spans v in [1-(ty+1)/AH, 1-ty/AH].
      const baseV = 1 - (Math.floor(tile / AW) + 1) * tileH;
      // Inset UVs by half a texel so nearest filtering never samples the
      // neighbouring (or empty) tile at shared face edges -> no black seams.
      const htU = 0.5 / (AW * tileSize);
      const htV = 0.5 / (AH * tileSize);

      // corner data: offset coords, ao sample coords
      const corners = [
        { u: 0, v: 0, x: f.o[0], y: f.o[1], z: f.o[2] },
        { u: 1, v: 0, x: f.o[0] + f.u[0], y: f.o[1] + f.u[1], z: f.o[2] + f.u[2] },
        { u: 1, v: 1, x: f.o[0] + f.u[0] + f.v[0], y: f.o[1] + f.u[1] + f.v[1], z: f.o[2] + f.u[2] + f.v[2] },
        { u: 0, v: 1, x: f.o[0] + f.v[0], y: f.o[1] + f.v[1], z: f.o[2] + f.v[2] },
      ];

      const first = buf.positions.length / 3;
      for (const c of corners) {
        const cx = fx + c.x, cy = fy + c.y, cz = fz + c.z;
        // Classic face AO: sample the three cells that meet at this corner on
        // the outside of the face. They are at the cell *across* the face
        // (cell + normal), shifted by the corner's tangent offsets. NOTE: the
        // corner already contains the face-plane offset, so the base is the
        // face cell (fx,fy,fz), not the corner position.
        const o = (k) => (k ? 1 : 0);
        const bx = fx + f.n[0], by = fy + f.n[1], bz = fz + f.n[2];
        const ux = bx + o(c.u) * f.u[0], uy = by + o(c.u) * f.u[1], uz = bz + o(c.u) * f.u[2];
        const vx = bx + o(c.v) * f.v[0], vy = by + o(c.v) * f.v[1], vz = bz + o(c.v) * f.v[2];
        const dx = ux + o(c.v) * f.v[0], dy = uy + o(c.v) * f.v[1], dz = uz + o(c.v) * f.v[2];
        const s1 = !!world.get(ux, uy, uz);
        const s2 = !!world.get(vx, vy, vz);
        const d = !!world.get(dx, dy, dz);
        const level = s1 && s2 ? 0 : 3 - (s1 + s2 + d);
        const b = AO_BRIGHTNESS[level];

        // Smooth light: average sky/block of the 4 cells meeting at this
        // corner — the cell across the face, the two edge cells, and the
        // diagonal cell.
        const ls = (sky(bx, by, bz) + sky(ux, uy, uz) + sky(vx, vy, vz) + sky(dx, dy, dz)) / 60;
        const lb = (block(bx, by, bz) + block(ux, uy, uz) + block(vx, vy, vz) + block(dx, dy, dz)) / 60;

        // Affine UVs: each corner samples a (possibly rotated) (u,v) so the
        // tile maps cleanly (no diagonal fold) and, on side faces, the texture
        // vertical axis follows world-up (see FACE_TABLE.tex).
        const t = f.tex;
        const du = 0.5 + t[0] * (c.u - 0.5) + t[1] * (c.v - 0.5);
        const dv = 0.5 + t[2] * (c.u - 0.5) + t[3] * (c.v - 0.5);
        const u = baseU + htU + du * (tileW - 2 * htU);
        const v = baseV + htV + dv * (tileH - 2 * htV);
        pushCorner(buf, cx, cy, cz, f.n[0], f.n[1], f.n[2], u, v, b, b, b, ls, lb);
      }
      buf.indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
    }
  };

  for (let x = ox; x < ox + size; x++) {
    for (let y = oy; y < oy + size; y++) {
      for (let z = oz; z < oz + size; z++) {
        const voxel = world.get(x, y, z);
        if (!voxel) continue;
        face(x, y, z, voxel);
      }
    }
  }

  const toArrays = (buf) => ({
    positions: new Float32Array(buf.positions),
    normals: new Float32Array(buf.normals),
    uvs: new Float32Array(buf.uvs),
    colors: new Float32Array(buf.colors),
    lights: new Float32Array(buf.lights),
    indices: new Uint32Array(buf.indices),
  });

  const opaque = toArrays(opaqueBuf);
  const transparent = transparentBuf.indices.length ? toArrays(transparentBuf) : null;
  return { ...opaque, transparent };
}

/** Number of triangles a full non-empty chunk could hold (sanity helper). */
export function maxQuads(size) {
  return size * size * size * 6;
}
