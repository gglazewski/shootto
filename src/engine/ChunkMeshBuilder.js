// ChunkMeshBuilder.js — pure mesh generation for a chunk of the world.
//
// Produces typed arrays for every exposed face within a chunk. No three.js
// dependency, so it can be unit tested in Node.
//
// Two output modes:
//  - legacy (default): world-space Float32 positions + final atlas UVs
//    (positions/normals/uvs/colors/lights/emissive/indices). Used by ghost
//    previews and most tests; unchanged format.
//  - packed (opts.packed, the renderer's path): quantized chunk-local
//    attributes (~21 B/vertex vs 56) plus greedy meshing — coplanar
//    same-tile faces with uniform AO/light merge into one quad. The shader
//    re-tiles merged quads via fract(), so the atlas still works:
//      positions  Int16   chunk-local cells * POS_QUANT
//      normals    Int8    normalized (n * 127)
//      shade      Uint8x4 [ao, skyLight, blockLight, emissive] normalized
//      uvLocal    Uint16  tile-local uv * UV_QUANT (may exceed one tile)
//      tileInfo   Float32 tile + rectW*4096 + rectH*65536 (tiles, 4 bits each)
//      indices    Uint16 (Uint32 when >64k verts)
//
// Rules:
//  - A face is emitted only when the cell just outside it is empty (opaque
//    voxels only, so interior faces between two voxels are correctly hidden),
//    or when that neighbor is transparent and THIS voxel is opaque (so an
//    opaque face remains visible through glass).
//  - Transparent voxels (glass) go into a separate `transparent` buffer so
//    they can render in a second, alpha-blended pass.
//  - shape:'pane' voxels (chain-link fence, bars, barricades) emit a single
//    quad centered in the voxel instead of cube faces, oriented by the
//    voxel's rotation; the tile's alpha channel cuts out the holes.
//    shape:'cross' voxels (bushes, plants) emit two crossed cutout diagonals
//    the same way. Both are emitted double-winded into the OPAQUE buffer
//    (depth-written, alpha-discarded), so overlapping cutouts never blend
//    in the wrong order.
//    A decal on a pane rides the pane's own plane, not the cell boundary
//    (a lace curtain hangs on the glass), and only on the two faces the
//    pane looks along.
//  - BIG voxels are expanded automatically: each of their sub-cells that has
//    an empty neighbor emits a 0.5m quad, so a 1m block renders as 4 coplanar
//    quads per exposed side (greedy re-merges them in packed mode).
//  - Simple "vertex AO": each corner is darkened based on the 3 cells that
//    meet at that corner on the outside of the face.
//  - Per-vertex light: each corner averages the sky/block light of the 4
//    cells that meet at it (the cell across the face plus the AO corners),
//    giving smooth interpolated lighting across faces.
//  - Greedy merging only ever fuses faces whose four corners share identical
//    (quantized) AO and light, so merged output is pixel-identical to the
//    per-face mesh — gradients and AO seams always stay per-face.

import { CELL_SIZE } from './Space.js';
import { opacityFor, isTransparent, isMixedAlpha, shapeFor, getDecal, getBlock, lightFor, coverFor, isConnecting, tileFor } from './VoxelTypes.js';
import { spanVecFor, solidYRange } from './VoxelShape.js';

// Packed-mode quantization: position units per cell / uv units per tile.
// 256 gives ~2mm position resolution — finer than the smallest offset the
// mesher emits (the 1cm decal float) — and 1/16 texel uv resolution.
export const POS_QUANT = 256;
export const UV_QUANT = 256;

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
const FACE_NAMES = Object.keys(FACE_TABLE);
// Cell axes of each face's in-plane u/v basis and its normal (0=x,1=y,2=z),
// used by the greedy pass to address slice masks.
const FACE_AXES = {};
for (const name of FACE_NAMES) {
  const f = FACE_TABLE[name];
  FACE_AXES[name] = {
    u: f.u.indexOf(1),
    v: f.v.indexOf(1),
    n: f.n[0] !== 0 ? 0 : f.n[1] !== 0 ? 1 : 2,
  };
}

// Brightness for AO levels 0..3 (0 = fully occluded).
const AO_BRIGHTNESS = [0.45, 0.62, 0.82, 1.0];

/**
 * Footprint of a decal on a face, in cells along the face's u/v axes, for
 * artwork spanning [w, h] cells. The artwork's width follows the face's
 * texture-x axis: on faces whose UVs are rotated (FACE_TABLE.tex = ROT90,
 * px/nz) texture-x runs along the v axis, so the span swaps there; odd decal
 * rotations swap it again. Keeps a [4,2] graffiti 4 cells WIDE on every wall.
 * @returns {[number, number]} cells along [u, v]
 */
export function decalFootprint(face, span, rotation = 0) {
  const f = FACE_TABLE[face];
  const swapped = (f.tex[0] === 0) !== ((rotation & 1) === 1);
  return swapped ? [span[1], span[0]] : [span[0], span[1]];
}

// Voxel yaw (rotation 0..3, quarter turns around +Y): a rotated voxel's
// world face shows the tile of the face that rotated into it. One CCW step
// maps world px<-pz, pz<-nx, nx<-nz, nz<-px; top/bottom keep their tile but
// spin their UVs instead (see the corner loop).
const SIDE_CYCLE = ['px', 'pz', 'nx', 'nz'];
function rotatedFace(name, rot) {
  const i = SIDE_CYCLE.indexOf(name);
  if (i < 0) return name; // py/ny
  return SIDE_CYCLE[(i + rot) & 3];
}

const DEFAULT_LIGHT = 15;

// Deterministic per-cell hash in [0,1): drives the ground-cover scatter so a
// grass cell grows the same tuft on every rebuild, on every machine.
function hash3(x, y, z) {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h);
}

/** A block is opaque for rendering/culling when it is a fully solid cube.
 *  Non-cube shapes (panes, door slabs) never cover a neighbor's face even
 *  when light-opaque, so they must not cull it. */
function isOpaqueVoxel(voxel) {
  return voxel == null || (shapeFor(voxel.type) === 'cube' && opacityFor(voxel.type) >= 255 && voxel.variant == null);
}

/** True when a neighbor's solid box covers a face spanning [lo, hi] (world
 *  cell units) on the shared cell boundary. Full opaque cubes cover
 *  everything (the old rule); slab variants cover a side face only when
 *  their own solid y-range spans it, and a top/bottom face only when their
 *  solid box actually crosses the shared plane. */
function coversFace(neighbor, name, neighborY, lo, hi) {
  if (shapeFor(neighbor.type) !== 'cube' || opacityFor(neighbor.type) < 255) return false;
  const [nlo, nhi] = solidYRange(neighbor, neighborY);
  if (name === 'py') return nlo <= hi && nhi > hi;
  if (name === 'ny') return nhi >= lo && nlo < lo;
  return nlo <= lo && nhi >= hi;
}

/**
 * Effective atlas UV of one packed vertex — the same math the packed shader
 * runs (tileInfo decode + wrap + half-texel inset). For tests and tooling.
 * @param {{uvLocal: Uint16Array, tileInfo: Float32Array}} data packed buffers
 * @param {number} vi  vertex index
 * @param {{width:number,height:number,tileSize?:number}} atlas
 * @returns {[number, number]}
 */
export function packedAtlasUV(data, vi, atlas) {
  const { width: AW, height: AH, tileSize = 16 } = atlas;
  const info = data.tileInfo[vi];
  const th = Math.floor(info / 65536);
  const rem = info - th * 65536;
  const tw = Math.floor(rem / 4096);
  const tile = rem - tw * 4096;
  const row = Math.floor(tile / AW);
  const col = tile - row * AW;
  const rectX = col / AW;
  const rectY = 1 - (row + th) / AH;
  const rectW = tw / AW;
  const rectH = th / AH;
  const padU = 0.5 / (AW * tileSize);
  const padV = 0.5 / (AH * tileSize);
  const wrap = (x) => (x >= 1.0001 ? x - Math.floor(x) : x);
  const u = data.uvLocal[vi * 2] / UV_QUANT;
  const v = data.uvLocal[vi * 2 + 1] / UV_QUANT;
  return [rectX + padU + wrap(u) * (rectW - 2 * padU), rectY + padV + wrap(v) * (rectH - 2 * padV)];
}

/**
 * @param {object} world  must expose get(x, y, z) -> voxel | null
 * @param {object} [lightField]  must expose skyAt/blockAt(x,y,z) -> 0..15
 * @param {[number,number,number]} origin  chunk min cell coords
 * @param {number} size    chunk edge length in cells
 * @param {(typeId:string, face:string) => number} tileIndexFor  face -> atlas tile index
 * @param {{width:number,height:number,tileSize?:number}} [atlas] tiles per row/column of the atlas
 * @param {{packed?: boolean}} [opts]  packed = quantized attributes + greedy meshing
 */
export function buildChunkMesh(world, lightField, origin, size, tileIndexFor, atlas = { width: 4, height: 2 }, opts = {}) {
  const packed = opts.packed === true;
  const { width: AW, height: AH, tileSize = 16 } = atlas;
  const sky = lightField ? lightField.skyAt.bind(lightField) : () => DEFAULT_LIGHT;
  const block = lightField ? lightField.blockAt.bind(lightField) : () => 0;

  const tileW = 1 / AW;
  const tileH = 1 / AH;
  // Half-texel UV inset so nearest filtering never samples the neighbouring
  // (or empty) tile at shared face edges -> no black seams. In packed mode
  // the shader applies the same inset per wrapped tile.
  const htU = 0.5 / (AW * tileSize);
  const htV = 0.5 / (AH * tileSize);

  const makeBuffer = packed
    ? () => ({ count: 0, positions: [], normals: [], shade: [], uvLocal: [], tileInfo: [], indices: [] })
    : () => ({ count: 0, positions: [], normals: [], uvs: [], colors: [], lights: [], emissive: [], indices: [] });
  const opaqueBuf = makeBuffer();
  const transparentBuf = makeBuffer();

  const [ox, oy, oz] = origin;
  // Dense halo cache: neighbor/AO probes dominate meshing cost. Prefetch the
  // chunk + a 1-cell border into a flat array once, then answer all those
  // probes with O(1) index reads.
  const hs = size + 2;
  const hx0 = ox - 1, hy0 = oy - 1, hz0 = oz - 1;
  const halo = new Array(hs * hs * hs);
  for (let x = hx0; x < hx0 + hs; x++)
    for (let y = hy0; y < hy0 + hs; y++)
      for (let z = hz0; z < hz0 + hs; z++)
        halo[(x - hx0) + (y - hy0) * hs + (z - hz0) * hs * hs] = world.get(x, y, z);
  const hget = (x, y, z) => {
    const lx = x - hx0, ly = y - hy0, lz = z - hz0;
    if ((lx | ly | lz) < 0 || lx >= hs || ly >= hs || lz >= hs) return world.get(x, y, z);
    return halo[lx + ly * hs + lz * hs * hs];
  };

  // Face paint (per-cell texture overrides) is looked up per VOXEL, not per
  // face, and only when the world has any paint at all — an unpainted world
  // pays a single boolean check for the whole chunk. Painted faces emit no
  // extra geometry: the override only swaps which atlas tile the existing
  // quad samples, so the render cost is exactly zero.
  const paintFor = world.paintCount > 0 ? world.paintFor.bind(world) : null;

  // One vertex. (du, dv) are tile-local (0..1 for a single tile; merged
  // greedy quads pass 0..N and the shader wraps), (tile, tw, th) locate the
  // sampled atlas rect in tiles, ao is the grey AO factor (legacy writes it
  // as an rgb color).
  const pushCorner = packed
    ? (buf, x, y, z, nx, ny, nz, du, dv, tile, tw, th, ao, ls, lb, e) => {
      buf.positions.push(
        Math.round((x - ox) * POS_QUANT),
        Math.round((y - oy) * POS_QUANT),
        Math.round((z - oz) * POS_QUANT),
      );
      buf.normals.push(Math.round(nx * 127), Math.round(ny * 127), Math.round(nz * 127));
      buf.shade.push(
        Math.min(255, Math.round(ao * 255)),
        Math.min(255, Math.round(ls * 255)),
        Math.min(255, Math.round(lb * 255)),
        e ? 255 : 0,
      );
      buf.uvLocal.push(
        Math.max(0, Math.round(du * UV_QUANT)),
        Math.max(0, Math.round(dv * UV_QUANT)),
      );
      buf.tileInfo.push(tile + tw * 4096 + th * 65536);
      buf.count++;
    }
    : (buf, x, y, z, nx, ny, nz, du, dv, tile, tw, th, ao, ls, lb, e) => {
      const baseU = (tile % AW) * tileW;
      // The atlas texture is uploaded with flipY=true (v=0 is the canvas
      // bottom row), so a rect ending in row `ty` spans v from
      // 1-(ty+th)/AH upward.
      const baseV = 1 - (Math.floor(tile / AW) + th) * tileH;
      const u = baseU + htU + du * (tw * tileW - 2 * htU);
      const v = baseV + htV + dv * (th * tileH - 2 * htV);
      buf.positions.push(x * CELL_SIZE, y * CELL_SIZE, z * CELL_SIZE);
      buf.normals.push(nx, ny, nz);
      buf.uvs.push(u, v);
      buf.colors.push(ao, ao, ao);
      buf.lights.push(ls, lb);
      buf.emissive.push(e);
      buf.count++;
    };

  // --- greedy merge state (packed mode only) ---
  // Faces whose four corners share identical quantized shading defer into
  // per-direction slice masks; a 2D greedy pass fuses equal runs afterwards.
  const keyIds = packed ? new Map() : null;
  const keyDefs = packed ? [] : null;
  const masks = {};
  if (packed) for (const name of FACE_NAMES) masks[name] = new Map();
  const q255 = (x) => Math.round(x * 255);
  const recordMask = (name, fx, fy, fz, tile, rotSpin, cd, em, kindCode) => {
    const kk = `${name}|${tile}|${rotSpin}|${q255(cd.b)}|${q255(cd.ls)}|${q255(cd.lb)}|${em}|${kindCode}`;
    let id = keyIds.get(kk);
    if (id == null) {
      id = keyDefs.push({ tile, rotSpin, ao: cd.b, ls: cd.ls, lb: cd.lb, em, kindCode });
      keyIds.set(kk, id);
    }
    const ax = FACE_AXES[name];
    const cell = [fx - ox, fy - oy, fz - oz];
    let m = masks[name].get(cell[ax.n]);
    if (!m) {
      m = new Int32Array(size * size);
      masks[name].set(cell[ax.n], m);
    }
    m[cell[ax.u] + cell[ax.v] * size] = id;
  };

  const face = (fx, fy, fz, voxel) => {
    const selfTransparent = isTransparent(voxel.type);
    // Mixed-alpha art (framed window, glazed doors) is meshed into BOTH
    // passes: the opaque cutout pass depth-writes the solid texels (frame
    // occludes correctly) and discards the glass (alpha < 0.5); the
    // transparent pass blends the glass and re-blends the solid texels over
    // themselves at equal depth (a no-op).
    const mixed = isMixedAlpha(voxel.type);
    const buf = selfTransparent ? transparentBuf : opaqueBuf;
    const bufs = mixed ? [opaqueBuf, transparentBuf] : [buf];
    const kindCode = selfTransparent ? 1 : mixed ? 2 : 0;
    const rot = voxel.rotation ?? 0;
    // Emissive voxels (lamps, torches) flag their vertices so the shader can
    // keep them bright + feed the bloom pass regardless of baked light.
    const em = lightFor(voxel.type) > 0 ? 1 : 0;
    // Slab variants: the voxel's solid box may cover only part of this cell
    // vertically. y0f/y1f are the solid bounds within the cell (0..1 in cell
    // units): a small 'lower' slab spans [0, 0.5]; a BIG one halves at a cell
    // boundary, leaving its carved-away cell layer empty (y1f <= y0f).
    const [vy0, vy1] = solidYRange(voxel, fy);
    const y0f = Math.max(0, vy0 - fy);
    const y1f = Math.min(1, vy1 - fy);
    if (y1f <= y0f) return;
    const paint = paintFor ? paintFor(fx, fy, fz) : null;
    for (const name of FACE_NAMES) {
      const f = FACE_TABLE[name];
      const nx = fx + f.n[0], ny = fy + f.n[1], nz = fz + f.n[2];
      const neighbor = hget(nx, ny, nz);
      // Cull when the neighbor blocks this face: a neighbor whose solid box
      // covers the emitted span hides it; two transparent voxels hide each
      // other (glass-on-glass), as do two mixed-alpha voxels of the same type
      // (window-on-window). A face pulled inside the cell (a slab's inner
      // horizontal face) can never be covered by a neighbor.
      const inset = (name === 'py' && y1f < 1) || (name === 'ny' && y0f > 0);
      if (!inset && neighbor && (coversFace(neighbor, name, ny, fy + y0f, fy + y1f) || selfTransparent || (mixed && neighbor.type === voxel.type))) continue;

      // A painted face shows the source block's tile for THIS world face:
      // the painter picked what they saw, so the voxel's own yaw (which
      // permutes its side tiles) must not permute the paint as well.
      const painted = paint ? paint[name] : null;
      // Connecting blocks (car windows) dissolve the frame edge shared with
      // a same-type neighbour: check the four in-plane neighbours and pick
      // the `<tile>_<mask>` variant. The art axes are recovered from f.tex —
      // art-x runs along whichever tangent feeds du, art-top along whichever
      // feeds dv (dv grows toward the art's top row) — so the mask follows
      // the texture orientation on every face.
      let connTile = null;
      if (!painted && isConnecting(voxel.type)) {
        const t = f.tex;
        const R = t[0] ? [f.u[0] * t[0], f.u[1] * t[0], f.u[2] * t[0]] : [f.v[0] * t[1], f.v[1] * t[1], f.v[2] * t[1]];
        const T = t[2] ? [f.u[0] * t[2], f.u[1] * t[2], f.u[2] * t[2]] : [f.v[0] * t[3], f.v[1] * t[3], f.v[2] * t[3]];
        const same = (sx, sy, sz) => hget(fx + sx, fy + sy, fz + sz)?.type === voxel.type;
        const mask = (same(-R[0], -R[1], -R[2]) ? 1 : 0) | (same(R[0], R[1], R[2]) ? 2 : 0)
          | (same(T[0], T[1], T[2]) ? 4 : 0) | (same(-T[0], -T[1], -T[2]) ? 8 : 0);
        if (mask) connTile = `${tileFor(voxel.type, name)}_${mask}`;
      }
      const tile = painted
        ? tileIndexFor(painted, name)
        : connTile
          ? tileIndexFor(connTile, name)
          : tileIndexFor(voxel.type, rot ? rotatedFace(name, rot) : name);

      const decal = world.decalAt?.(fx, fy, fz, name);

      // corner data: offset coords, ao sample coords
      const corners = [
        { u: 0, v: 0, x: f.o[0], y: f.o[1], z: f.o[2] },
        { u: 1, v: 0, x: f.o[0] + f.u[0], y: f.o[1] + f.u[1], z: f.o[2] + f.u[2] },
        { u: 1, v: 1, x: f.o[0] + f.u[0] + f.v[0], y: f.o[1] + f.u[1] + f.v[1], z: f.o[2] + f.u[2] + f.v[2] },
        { u: 0, v: 1, x: f.o[0] + f.v[0], y: f.o[1] + f.v[1], z: f.o[2] + f.v[2] },
      ];

      const cornerData = [];
      for (const c of corners) {
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
        const s1 = !!hget(ux, uy, uz);
        const s2 = !!hget(vx, vy, vz);
        const d = !!hget(dx, dy, dz);
        const level = s1 && s2 ? 0 : 3 - (s1 + s2 + d);
        const b = AO_BRIGHTNESS[level];

        // Smooth light: average sky/block of the 4 cells meeting at this
        // corner — the cell across the face, the two edge cells, and the
        // diagonal cell.
        const ls = (sky(bx, by, bz) + sky(ux, uy, uz) + sky(vx, vy, vz) + sky(dx, dy, dz)) / 60;
        const lb = (block(bx, by, bz) + block(ux, uy, uz) + block(vx, vy, vz) + block(dx, dy, dz)) / 60;
        cornerData.push({
          u0: c.u, v0: c.v,
          cx: fx + c.x, cy: fy + (c.y ? y1f : y0f), cz: fz + c.z,
          b, ls, lb,
        });
      }

      // Greedy candidate: a full-cell face with no decal whose corners share
      // one shade — defer it into the merge mask instead of emitting.
      if (packed && !decal && y0f === 0 && y1f === 1) {
        const [c0, c1, c2, c3] = cornerData;
        const b0 = q255(c0.b), s0 = q255(c0.ls), l0 = q255(c0.lb);
        if (
          b0 === q255(c1.b) && b0 === q255(c2.b) && b0 === q255(c3.b)
          && s0 === q255(c1.ls) && s0 === q255(c2.ls) && s0 === q255(c3.ls)
          && l0 === q255(c1.lb) && l0 === q255(c2.lb) && l0 === q255(c3.lb)
        ) {
          recordMask(name, fx, fy, fz, tile, f.n[1] !== 0 ? rot : 0, c0, em, kindCode);
          continue;
        }
      }

      const quad = []; // per-corner vertex data, emitted into every target buffer
      for (const cd of cornerData) {
        // Affine UVs: each corner samples a (possibly rotated) (u,v) so the
        // tile maps cleanly (no diagonal fold) and, on side faces, the texture
        // vertical axis follows world-up (see FACE_TABLE.tex).
        // Voxel yaw spins the top/bottom tile in quarter turns (rotating a
        // road line or crack); side faces stay upright and only swap tiles.
        let cu = cd.u0, cv = cd.v0;
        // Slab side faces sample only their half of the tile, split along
        // world y (the parametric axis that runs up: u on px/nz, v on nx/pz).
        if (f.u[1]) cu = y0f + cu * (y1f - y0f);
        else if (f.v[1]) cv = y0f + cv * (y1f - y0f);
        if (rot && f.n[1] !== 0) {
          for (let k = 0; k < rot; k++) { const tmp = cu; cu = cv; cv = 1 - tmp; }
        }
        const t = f.tex;
        const du = 0.5 + t[0] * (cu - 0.5) + t[1] * (cv - 0.5);
        const dv = 0.5 + t[2] * (cu - 0.5) + t[3] * (cv - 0.5);
        quad.push([cd.cx, cd.cy, cd.cz, f.n[0], f.n[1], f.n[2], du, dv, tile, 1, 1, cd.b, cd.ls, cd.lb, em]);
      }
      for (const target of bufs) {
        const first = target.count;
        for (const qd of quad) pushCorner(target, ...qd);
        target.indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
      }

      // Decal covering this face: a second quad a hair off the surface,
      // reusing the face's AO/light so it blends in. Only visible faces get
      // here, so a decal on a buried face costs nothing. Multi-cell decals
      // emit one quad per covered face, each sampling its sub-rect of the
      // (span-sized) artwork, so culling/AO/light stay per-face.
      if (decal) {
        const [cw, ch] = getDecal(decal.decalId)?.span ?? [1, 1];
        const dRot = decal.rotation ?? 0;
        const [eu, ev] = decalFootprint(name, [cw, ch], dRot); // cells along u/v
        const [ax, ay, az] = decal.cell ?? [fx, fy, fz];
        // this cell's offset inside the footprint, along the face's axes
        const iOff = (fx - ax) * f.u[0] + (fy - ay) * f.u[1] + (fz - az) * f.u[2];
        const jOff = (fx - ax) * f.v[0] + (fy - ay) * f.v[1] + (fz - az) * f.v[2];
        const dTile = tileIndexFor(decal.decalId, name);
        const dFirst = buf.count;
        const EPS = 0.02; // 1cm in cell units — clears z-fighting
        for (const cd of cornerData) {
          // footprint-space fraction -> spin by the decal rotation -> face
          // orientation (f.tex) -> atlas rect
          let cu = (iOff + cd.u0) / eu, cv = (jOff + cd.v0) / ev;
          for (let k = 0; k < dRot; k++) { const tmp = cu; cu = cv; cv = 1 - tmp; }
          const t = f.tex;
          const du = 0.5 + t[0] * (cu - 0.5) + t[1] * (cv - 0.5);
          const dv = 0.5 + t[2] * (cu - 0.5) + t[3] * (cv - 0.5);
          pushCorner(
            buf,
            cd.cx + f.n[0] * EPS, cd.cy + f.n[1] * EPS, cd.cz + f.n[2] * EPS,
            f.n[0], f.n[1], f.n[2], du, dv, dTile, cw, ch, cd.b, cd.ls, cd.lb, 0,
          );
        }
        buf.indices.push(dFirst, dFirst + 1, dFirst + 2, dFirst, dFirst + 2, dFirst + 3);
      }
    }
  };

  // Ground cover: blocks with a `cover` config (the grass family) sprout a
  // cutout X — two crossed diagonal quads — in the empty cell above their
  // exposed top. Nothing is stored in the world: a per-cell hash decides
  // tuft / flower / bare, so the scatter is stable across rebuilds. Like the
  // cutout panes the quads are double-winded into the OPAQUE buffer (depth-
  // written, alpha-discarded); no AO, light sampled in the cell the cover
  // stands in.
  const cover = (fx, fy, fz, voxel) => {
    const cfg = coverFor(voxel.type);
    if (!cfg) return;
    if (hget(fx, fy + 1, fz)) return;                 // needs air above
    const [, vy1] = solidYRange(voxel, fy);
    if (vy1 < fy + 1) return;                         // carved slab tops stay bare
    const r = hash3(fx, fy, fz);
    const tc = cfg.tuftChance ?? 0.6;
    const fc = cfg.flowerChance ?? 0.2;
    let pool = null;
    if (r < tc) pool = cfg.tufts;
    else if (r < tc + fc) pool = cfg.flowers;
    if (!pool || !pool.length) return;
    const tile = tileIndexFor(pool[(hash3(fx, fy, fz + 101) * pool.length) | 0], 'py');
    if (tile == null) return;
    const ls = sky(fx, fy + 1, fz) / 15;
    const lb = block(fx, fy + 1, fz) / 15;
    const y0 = fy + 1, y1 = fy + 2;
    // Two diagonals, inset from the cell corners so cover in adjacent cells
    // never shares an edge. 0.7071 ≈ the diagonals' unit normals.
    const i0 = 0.15, i1 = 0.85;
    const diags = [
      { a: [fx + i0, fz + i0], b: [fx + i1, fz + i1], n: [-0.7071, 0, 0.7071] },
      { a: [fx + i1, fz + i0], b: [fx + i0, fz + i1], n: [0.7071, 0, 0.7071] },
    ];
    for (const dq of diags) {
      const corners = [
        [dq.a[0], y0, dq.a[1]], [dq.b[0], y0, dq.b[1]],
        [dq.b[0], y1, dq.b[1]], [dq.a[0], y1, dq.a[1]],
      ];
      const us = [0, 1, 1, 0];
      const vs = [0, 0, 1, 1]; // uv-v follows world +y (art roots at the ground)
      for (const flip of [1, -1]) {
        const order = flip === 1 ? [0, 1, 2, 3] : [0, 3, 2, 1];
        const first = opaqueBuf.count;
        for (const i of order) {
          const c = corners[i];
          pushCorner(opaqueBuf, c[0], c[1], c[2], dq.n[0] * flip, dq.n[1] * flip, dq.n[2] * flip, us[i], vs[i], tile, 1, 1, 1, ls, lb, 0);
        }
        opaqueBuf.indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
      }
    }
  };

  // shape:'cross' — a placeable X (bushes, plants): the same two crossed
  // cutout quads the ground cover uses, spanning the voxel's full extent.
  // Emitted once per voxel at its anchor (a BIG bush is one 1m X, not eight
  // 0.5m ones), double-winded into the opaque buffer, no AO; light is
  // sampled per corner inside the voxel's own cells (crosses are transparent
  // to light, so the field is defined there).
  const cross = (voxel, ax, ay, az) => {
    const span = voxel.size === 'big' ? 2 : 1;
    const xem = lightFor(voxel.type) > 0 ? 1 : 0;
    const tile = tileIndexFor(voxel.type, 'px');
    const cc = (p, a) => Math.max(a, Math.min(a + span - 1, Math.floor(p)));
    // Diagonal ends inset from the cell corners so adjacent bushes never
    // share an edge; 0.7071 ≈ the diagonals' unit normals.
    const i0 = 0.15 * span, i1 = span - i0;
    const diags = [
      { a: [ax + i0, az + i0], b: [ax + i1, az + i1], n: [-0.7071, 0, 0.7071] },
      { a: [ax + i1, az + i0], b: [ax + i0, az + i1], n: [0.7071, 0, 0.7071] },
    ];
    for (const dq of diags) {
      const corners = [
        [dq.a[0], ay, dq.a[1]], [dq.b[0], ay, dq.b[1]],
        [dq.b[0], ay + span, dq.b[1]], [dq.a[0], ay + span, dq.a[1]],
      ];
      const us = [0, 1, 1, 0];
      const vs = [0, 0, 1, 1]; // uv-v follows world +y (art roots at the ground)
      for (const flip of [1, -1]) {
        const order = flip === 1 ? [0, 1, 2, 3] : [0, 3, 2, 1];
        const first = opaqueBuf.count;
        for (const i of order) {
          const c = corners[i];
          const lx = cc(c[0], ax), ly = cc(c[1], ay), lz = cc(c[2], az);
          const ls = sky(lx, ly, lz) / 15;
          const lb = block(lx, ly, lz) / 15;
          pushCorner(opaqueBuf, c[0], c[1], c[2], dq.n[0] * flip, dq.n[1] * flip, dq.n[2] * flip, us[i], vs[i], tile, 1, 1, 1, ls, lb, xem);
        }
        opaqueBuf.indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
      }
    }
  };

  // shape:'pane' — one quad centered in the voxel, spanning its full extent.
  // The voxel's rotation turns it: 0/180 = pane runs along x (normal z),
  // 90/270 = along z (normal x). Emitted once per voxel (at its anchor
  // cell), so a BIG fence is one 1m pane, not eight 0.5m ones. Both windings
  // go into the OPAQUE buffer: the material there is front-side but writes
  // depth, and the shader discards fully transparent texels — so panes
  // occlude each other correctly instead of alpha-blend ghosting. No AO
  // (colors stay 1); light is sampled inside the voxel's own cells (the
  // field is defined there since panes are transparent to light).
  const pane = (voxel, ax, ay, az) => {
    // Transparent panes (glass) go to the alpha-blended pass; that material
    // is double-sided, so a single winding suffices. Cutout panes (fences,
    // bars) stay in the opaque pass, double-winded as before.
    const paneTransparent = isTransparent(voxel.type);
    const paneBuf = paneTransparent ? transparentBuf : opaqueBuf;
    // Mixed-alpha glazing (car windows) is meshed into BOTH passes like
    // mixed cubes: the opaque cutout pass depth-writes the frame texels and
    // discards the glass, the transparent pass blends the glass.
    const mixed = isMixedAlpha(voxel.type);
    const targets = paneTransparent
      ? [[transparentBuf, [1]]]
      : mixed
        ? [[opaqueBuf, [1, -1]], [transparentBuf, [1]]]
        : [[opaqueBuf, [1, -1]]];
    const pem = lightFor(voxel.type) > 0 ? 1 : 0;
    const span = voxel.size === 'big' ? 2 : 1;
    const cc = (p, a) => Math.max(a, Math.min(a + span - 1, Math.floor(p)));
    const half = span / 2;
    const rot = voxel.rotation ?? 0;
    const alongX = (rot & 1) === 0;
    const n = alongX ? [0, 0, 1] : [1, 0, 0];
    // An edge pane (def.edge — car glazing) hugs one side of its footprint
    // instead of centering: the rotation picks the edge (0: along x at +z,
    // 1: along z at +x, 2: along x at -z, 3: along z at -x), so rotating
    // walks the pane around the cell and the glass sits flush with the wall
    // face it belongs to. Downstream only ever sees the fixed plane q.
    const edge = getBlock(voxel.type)?.edge === true;

    // Corner mitering. In run coordinates: the pane runs along r ∈ [ar,
    // ar+span] on its run axis (x when alongX, else z) and sits on the fixed
    // plane q on the other axis. A perpendicular neighbor's plane is a run
    // coordinate of ours and vice versa, so the two mesh naturally:
    //  - extend: a perpendicular pane just past one of our ends whose run
    //    covers our plane — stretch that end to its plane so the edges meet.
    //  - trim: a perpendicular pane beside us whose plane cuts our run
    //    interior extends to our plane (its own extend rule); if our run
    //    continues past exactly one end, cut the stub on the dead side at
    //    that plane, closing the L into a mitered corner.
    // All coordinates are multiples of 0.5, so float compares are exact.
    const ar = alongX ? ax : az;
    const aq = alongX ? az : ax;
    const q = aq + (edge ? (rot < 2 ? span : 0) : half);
    // The pane voxel covering a cell, described in ITS run/plane terms.
    const paneAt = (r, row) => {
      const v = alongX ? hget(r, ay, row) : hget(row, ay, r);
      if (!v || shapeFor(v.type) !== 'pane') return null;
      const [nax, , naz] = v.anchor ?? (alongX ? [r, ay, row] : [row, ay, r]);
      const nspan = v.size === 'big' ? 2 : 1;
      const nRot = v.rotation ?? 0;
      const nAlongX = (nRot & 1) === 0;
      const nr = nAlongX ? nax : naz;
      const nq = (nAlongX ? naz : nax)
        + (getBlock(v.type)?.edge ? (nRot < 2 ? nspan : 0) : nspan / 2);
      return { perp: nAlongX !== alongX, r0: nr, r1: nr + nspan, plane: nq };
    };
    let m0 = ar, m1 = ar + span; // final run interval of the main quad
    let ext0 = 0, ext1 = 0;      // mirrored extension quads past each end
    let contLo = false, contHi = false;
    for (let i = 0; i < span; i++) {
      const row = aq + i;
      const nLo = paneAt(ar - 1, row);
      if (nLo && nLo.perp && nLo.r0 <= q && q <= nLo.r1 && nLo.plane < m0)
        ext0 = Math.max(ext0, m0 - nLo.plane);
      contLo = contLo || (nLo && !nLo.perp && nLo.plane === q);
      const nHi = paneAt(ar + span, row);
      if (nHi && nHi.perp && nHi.r0 <= q && q <= nHi.r1 && nHi.plane > m1)
        ext1 = Math.max(ext1, nHi.plane - m1);
      contHi = contHi || (nHi && !nHi.perp && nHi.plane === q);
    }
    if (contLo !== contHi) {
      for (const side of [aq - 1, aq + span]) {
        for (let i = 0; i < span; i++) {
          const s = paneAt(ar + i, side);
          if (!s || !s.perp || s.plane <= m0 || s.plane >= m1) continue;
          if (contLo) { m1 = Math.min(m1, s.plane); ext1 = 0; }
          else { m0 = Math.max(m0, s.plane); ext0 = 0; }
        }
      }
    }

    // Connected glazing (see the cube path in face()): a coplanar same-type
    // pane continuing the run or stacked above/below dissolves the shared
    // frame edge. Pane art runs its x along +run and its top along +y, so
    // the mask is 1 = -run, 2 = +run, 4 = above, 8 = below. Perpendicular
    // meetings keep their frame — the corner pillar stays.
    let tileName = voxel.type;
    if (isConnecting(voxel.type)) {
      const planeOf = (v2, cx, cz) => {
        const [nax, , naz] = v2.anchor ?? [cx, 0, cz];
        const nspan = v2.size === 'big' ? 2 : 1;
        const nRot = v2.rotation ?? 0;
        return (((nRot & 1) === 0) ? naz : nax) + (edge ? (nRot < 2 ? nspan : 0) : nspan / 2);
      };
      const same = (dr, dy) => {
        const cx = alongX ? ar + dr : aq;
        const cz = alongX ? aq : ar + dr;
        const v2 = hget(cx, ay + dy, cz);
        return !!v2 && v2.type === voxel.type && ((v2.rotation ?? 0) & 1) === (rot & 1)
          && planeOf(v2, cx, cz) === q;
      };
      const mask = (same(-1, 0) ? 1 : 0) | (same(span, 0) ? 2 : 0)
        | (same(0, span) ? 4 : 0) | (same(0, -1) ? 8 : 0);
      if (mask) tileName = `${tileFor(voxel.type, 'px')}_${mask}`;
    }
    const tile = tileIndexFor(tileName, 'px');

    const emitRun = (rA, rB, uA, uB) => {
      const corners = alongX
        ? [[rA, ay, q], [rB, ay, q], [rB, ay + span, q], [rA, ay + span, q]]
        : [[q, ay, rA], [q, ay, rB], [q, ay + span, rB], [q, ay + span, rA]];
      const us = [uA, uB, uB, uA];
      const vs = [0, 0, 1, 1]; // uv-v follows world +y
      for (const [tbuf, flips] of targets) {
        for (const flip of flips) {
          const order = flip === 1 ? [0, 1, 2, 3] : [0, 3, 2, 1];
          const first = tbuf.count;
          for (const i of order) {
            const c = corners[i];
            const lx = cc(c[0], ax), ly = cc(c[1], ay), lz = cc(c[2], az);
            const ls = sky(lx, ly, lz) / 15;
            const lb = block(lx, ly, lz) / 15;
            pushCorner(tbuf, c[0], c[1], c[2], n[0] * flip, n[1] * flip, n[2] * flip, us[i], vs[i], tile, 1, 1, 1, ls, lb, pem);
          }
          tbuf.indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
        }
      }
    };
    // The main quad samples its own sub-range of the tile (trims keep texel
    // density); extensions mirror the tile past its edge so the pattern stays
    // continuous into the corner instead of stretching.
    const u0 = (m0 - ar) / span, u1 = (m1 - ar) / span;
    emitRun(m0, m1, u0, u1);
    if (ext0 > 0) emitRun(m0 - ext0, m0, u0 + ext0 / span, u0);
    if (ext1 > 0) emitRun(m1, m1 + ext1, u1, u1 - ext1 / span);

    // Decals on a pane ride the pane's own plane (a hair off it), not the
    // cell boundary — a lace curtain hangs on the glass. Only the two faces
    // the pane looks along can carry one (see decalFacesFor), and the quad
    // spans the whole pane, sampling its sub-rect of a multi-cell artwork.
    for (const name of alongX ? ['pz', 'nz'] : ['px', 'nx']) {
      const decal = paneDecalAt(ax, ay, az, span, name);
      if (!decal) continue;
      const f = FACE_TABLE[name];
      const [cw, ch] = getDecal(decal.decalId)?.span ?? [1, 1];
      const dRot = decal.rotation ?? 0;
      const [eu, ev] = decalFootprint(name, [cw, ch], dRot); // cells along u/v
      const [dx, dy, dz] = decal.cell ?? [ax, ay, az];
      // the pane anchor's offset inside the footprint, along the face's axes
      const iOff = (ax - dx) * f.u[0] + (ay - dy) * f.u[1] + (az - dz) * f.u[2];
      const jOff = (ax - dx) * f.v[0] + (ay - dy) * f.v[1] + (az - dz) * f.v[2];
      const dTile = tileIndexFor(decal.decalId, name);
      // start at the pane's plane along the face normal, at the anchor in-plane
      const nAxis = f.n[0] ? 0 : f.n[1] ? 1 : 2;
      const base = [ax, ay, az];
      base[nAxis] += half + f.n[nAxis] * 0.02; // 1cm clear of the pane
      const dFirst = paneBuf.count;
      for (const [su, sv] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        const wx = base[0] + su * span * f.u[0] + sv * span * f.v[0];
        const wy = base[1] + su * span * f.u[1] + sv * span * f.v[1];
        const wz = base[2] + su * span * f.u[2] + sv * span * f.v[2];
        const lx = cc(wx, ax), ly = cc(wy, ay), lz = cc(wz, az);
        let cu = (iOff + su * span) / eu, cv = (jOff + sv * span) / ev;
        for (let k = 0; k < dRot; k++) { const tmp = cu; cu = cv; cv = 1 - tmp; }
        const t = f.tex;
        const du = 0.5 + t[0] * (cu - 0.5) + t[1] * (cv - 0.5);
        const dv = 0.5 + t[2] * (cu - 0.5) + t[3] * (cv - 0.5);
        pushCorner(
          paneBuf, wx, wy, wz, f.n[0], f.n[1], f.n[2],
          du, dv, dTile, cw, ch,
          1, sky(lx, ly, lz) / 15, block(lx, ly, lz) / 15, 0,
        );
      }
      paneBuf.indices.push(dFirst, dFirst + 1, dFirst + 2, dFirst, dFirst + 2, dFirst + 3);
    }
  };

  /** The decal on one face of a pane voxel, or null. A BIG pane covers 2x2x2
   *  cells, so the decal may be keyed to any of them — scan the footprint. */
  const paneDecalAt = (ax, ay, az, span, face) => {
    for (let x = ax; x < ax + span; x++)
      for (let y = ay; y < ay + span; y++)
        for (let z = az; z < az + span; z++) {
          const d = world.decalAt?.(x, y, z, face);
          if (d) return d;
        }
    return null;
  };

  // shape:'door' — a slab with real thickness, emitted once per voxel at its
  // anchor (like panes). Closed: the leaf spans the whole 2x4-cell opening,
  // centered in the 1-cell depth. Open: the leaf swings 90° around the hinge
  // at the anchor-side jamb — rotation 0/2 = closed leaf along x opening
  // toward +z/-z, 1/3 = along z opening toward +x/-x. The two big faces map
  // the door's multi-slot art (see tileSpan) with one shared world->u
  // mapping, so the back face is the mirror view of the front, exactly like
  // a real door; the thin edges collapse their UVs onto the art's border
  // texels and read as frame color. No AO (like panes); open leaves sample
  // light in the voxel's own footprint cells, closed (light-opaque) leaves
  // sample the cell beyond each face so each side shows its room's light.
  const DOOR_THICK = 0.24; // leaf thickness in cells (12 cm)
  // An open leaf folds back flat against the wall beside the doorway, and its
  // hinge-side face would land exactly on that wall's face plane — two coplanar
  // quads z-fighting. Float the open leaf this far (in cells: 1 cm) off the
  // jamb so it wins the depth test cleanly; the gap is invisible.
  const DOOR_WALL_GAP = 0.02;
  const door = (voxel, ax, ay, az) => {
    const rot = voxel.rotation ?? 0;
    const open = !!getBlock(voxel.type)?.doorClosed;
    const dem = lightFor(voxel.type) > 0 ? 1 : 0;
    const [sx, sy, sz] = spanVecFor(voxel.size, rot);
    const W = Math.max(sx, sz); // leaf width in cells
    const H = sy;
    const T = DOOR_THICK;
    const alongX = (rot & 1) === 0;
    // Hinge side: 'left' pivots on the anchor-side jamb (the default), so the
    // open leaf hugs the low end of the closed leaf's width; 'right' pivots
    // on the far jamb and hugs the high end.
    const hingeMax = voxel.hinge === 'right';
    let min, max, wAxis;
    if (!open) {
      min = alongX ? [ax, ay, az + 0.5 - T / 2] : [ax + 0.5 - T / 2, ay, az];
      max = alongX ? [ax + W, ay + H, az + 0.5 + T / 2] : [ax + 0.5 + T / 2, ay + H, az + W];
      wAxis = alongX ? 0 : 2;
    } else if (alongX) {
      const z0 = rot === 0 ? az + 0.5 - T / 2 : az + 0.5 + T / 2 - W;
      const x0 = hingeMax ? ax + W - T - DOOR_WALL_GAP : ax + DOOR_WALL_GAP;
      min = [x0, ay, z0];
      max = [x0 + T, ay + H, z0 + W];
      wAxis = 2;
    } else {
      const x0 = rot === 1 ? ax + 0.5 - T / 2 : ax + 0.5 + T / 2 - W;
      const z0 = hingeMax ? az + W - T - DOOR_WALL_GAP : az + DOOR_WALL_GAP;
      min = [x0, ay, z0];
      max = [x0 + W, ay + H, z0 + T];
      wAxis = 0;
    }
    // The art always runs from the hinge edge toward the handle. Closed, the
    // hinge edge is the leaf's low end unless the door is right-hung (a
    // right-hung door shows the mirrored face, handle on the other side).
    // Open, the hinge edge is the one at the wall, so a leaf swinging toward
    // -z/-x runs backwards along its new width axis.
    const flipU = open ? rot === 2 || rot === 3 : hingeMax;

    const [cw, ch] = getBlock(voxel.type)?.tileSpan ?? [1, 1];
    const tile = tileIndexFor(voxel.type, 'px');

    const d = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const clamp = (p, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(p)));
    // Glazed doors (mixedAlpha) render like framed windows: the opaque pass
    // draws the leaf and discards the glass texels, the transparent pass
    // blends the glass in.
    const doorBufs = isMixedAlpha(voxel.type) ? [opaqueBuf, transparentBuf] : [opaqueBuf];
    for (const name of FACE_NAMES) {
      const f = FACE_TABLE[name];
      const quad = [];
      for (const c of [{ u: 0, v: 0 }, { u: 1, v: 0 }, { u: 1, v: 1 }, { u: 0, v: 1 }]) {
        const px = min[0] + (f.o[0] + c.u * f.u[0] + c.v * f.v[0]) * d[0];
        const py = min[1] + (f.o[1] + c.u * f.u[1] + c.v * f.v[1]) * d[1];
        const pz = min[2] + (f.o[2] + c.u * f.u[2] + c.v * f.v[2]) * d[2];
        // Open doors are transparent to light, so the field is defined in
        // the footprint cells — sample there. A closed leaf is light-opaque
        // (its cells read 0), so each face samples the cell just beyond it
        // along its normal instead: the outside face reads the daylight,
        // the inside face the room's darkness.
        const solid = opacityFor(voxel.type) >= 255;
        const lx = clamp(px, ax, ax + sx - 1) + (solid ? f.n[0] : 0);
        const ly = clamp(py, ay, ay + sy - 1) + (solid ? f.n[1] : 0);
        const lz = clamp(pz, az, az + sz - 1) + (solid ? f.n[2] : 0);
        const ls = sky(lx, ly, lz) / 15;
        const lb = block(lx, ly, lz) / 15;
        const pw = wAxis === 0 ? px : pz;
        const fu = flipU ? (max[wAxis] - pw) / W : (pw - min[wAxis]) / W;
        const fv = (py - ay) / H;
        quad.push([px, py, pz, f.n[0], f.n[1], f.n[2], fu, fv, tile, cw, ch, 1, ls, lb, dem]);
      }
      for (const target of doorBufs) {
        const first = target.count;
        for (const qd of quad) pushCorner(target, ...qd);
        target.indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
      }
    }
  };

  for (let x = ox; x < ox + size; x++) {
    for (let y = oy; y < oy + size; y++) {
      for (let z = oz; z < oz + size; z++) {
        const voxel = hget(x, y, z);
        if (!voxel) continue;
        if (shapeFor(voxel.type) === 'door') {
          const [ax, ay, az] = voxel.anchor ?? [x, y, z];
          if (x === ax && y === ay && z === az) door(voxel, ax, ay, az);
          continue;
        }
        if (shapeFor(voxel.type) === 'pane') {
          // Emit at the anchor cell only (worlds without anchors fall back to
          // per-cell emission, which only matters for synthetic test worlds).
          const [ax, ay, az] = voxel.anchor ?? [x, y, z];
          if (x === ax && y === ay && z === az) pane(voxel, ax, ay, az);
          continue;
        }
        if (shapeFor(voxel.type) === 'cross') {
          const [ax, ay, az] = voxel.anchor ?? [x, y, z];
          if (x === ax && y === ay && z === az) cross(voxel, ax, ay, az);
          continue;
        }
        face(x, y, z, voxel);
        cover(x, y, z, voxel);
      }
    }
  }

  // Greedy merge (packed mode): fuse maximal rectangles of identical deferred
  // faces per direction slice. Each merged quad spans (w, h) cells and passes
  // tile-local UVs 0..w/0..h — the packed shader wraps them per tile.
  if (packed) {
    const emitMerged = (f, base, w, h, def) => {
      const targets = def.kindCode === 1
        ? [transparentBuf]
        : def.kindCode === 2
          ? [opaqueBuf, transparentBuf]
          : [opaqueBuf];
      const quad = [];
      for (const [cu, cv] of [[0, 0], [w, 0], [w, h], [0, h]]) {
        const px = base[0] + f.o[0] + f.u[0] * cu + f.v[0] * cv;
        const py = base[1] + f.o[1] + f.u[1] * cu + f.v[1] * cv;
        const pz = base[2] + f.o[2] + f.u[2] * cu + f.v[2] * cv;
        // Voxel yaw spins each tile of the run (extent-aware generalization
        // of the per-tile spin: rotating the whole uv lattice rotates every
        // tile of the same art identically), then FACE_TABLE.tex maps the
        // parametric axes onto the art axes.
        let U = cu, V = cv, W = w, H = h;
        for (let k = 0; k < def.rotSpin; k++) {
          const tU = U; U = V; V = W - tU;
          const tW = W; W = H; H = tW;
        }
        const t = f.tex;
        const du = t[0] === 1 ? U : t[0] === -1 ? W - U : t[1] === 1 ? V : H - V;
        const dv = t[2] === 1 ? U : t[2] === -1 ? W - U : t[3] === 1 ? V : H - V;
        quad.push([px, py, pz, f.n[0], f.n[1], f.n[2], du, dv, def.tile, 1, 1, def.ao, def.ls, def.lb, def.em]);
      }
      for (const target of targets) {
        const first = target.count;
        for (const qd of quad) pushCorner(target, ...qd);
        target.indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
      }
    };
    for (const name of FACE_NAMES) {
      const f = FACE_TABLE[name];
      const ax = FACE_AXES[name];
      for (const [slice, m] of masks[name]) {
        for (let vi = 0; vi < size; vi++) {
          for (let ui = 0; ui < size; ui++) {
            const id = m[ui + vi * size];
            if (!id) continue;
            let w = 1;
            while (ui + w < size && m[ui + w + vi * size] === id) w++;
            let h = 1;
            grow: while (vi + h < size) {
              for (let k = 0; k < w; k++) if (m[ui + k + (vi + h) * size] !== id) break grow;
              h++;
            }
            for (let dv = 0; dv < h; dv++)
              for (let du = 0; du < w; du++) m[ui + du + (vi + dv) * size] = 0;
            const base = [ox, oy, oz];
            base[ax.u] += ui;
            base[ax.v] += vi;
            base[ax.n] += slice;
            emitMerged(f, base, w, h, keyDefs[id - 1]);
            ui += w - 1;
          }
        }
      }
    }
  }

  const toArrays = packed
    ? (buf) => ({
      packed: true,
      positions: new Int16Array(buf.positions),
      normals: new Int8Array(buf.normals),
      shade: new Uint8Array(buf.shade),
      uvLocal: new Uint16Array(buf.uvLocal),
      tileInfo: new Float32Array(buf.tileInfo),
      indices: buf.count < 65536 ? new Uint16Array(buf.indices) : new Uint32Array(buf.indices),
    })
    : (buf) => ({
      positions: new Float32Array(buf.positions),
      normals: new Float32Array(buf.normals),
      uvs: new Float32Array(buf.uvs),
      colors: new Float32Array(buf.colors),
      lights: new Float32Array(buf.lights),
      emissive: new Float32Array(buf.emissive),
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
