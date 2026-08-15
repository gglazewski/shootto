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
//  - Transparent voxels (glass) go into a separate `transparent` buffer so
//    they can render in a second, alpha-blended pass.
//  - shape:'pane' voxels (chain-link fence, bars, barricades) emit a single
//    quad centered in the voxel instead of cube faces, oriented by the
//    voxel's rotation; the tile's alpha channel cuts out the holes. Panes
//    are emitted double-winded into the OPAQUE buffer (depth-written,
//    alpha-discarded), so overlapping panes never blend in the wrong order.
//    A decal on a pane rides the pane's own plane, not the cell boundary
//    (a lace curtain hangs on the glass), and only on the two faces the
//    pane looks along.
//  - BIG voxels are expanded automatically: each of their sub-cells that has
//    an empty neighbor emits a 0.5m quad, so a 1m block renders as 4 coplanar
//    quads per exposed side.
//  - Simple "vertex AO": each corner is darkened based on the 3 cells that
//    meet at that corner on the outside of the face.
//  - Per-vertex light: each corner averages the sky/block light of the 4
//    cells that meet at it (the cell across the face plus the AO corners),
//    giving smooth interpolated lighting across faces.

import { CELL_SIZE } from './Space.js';
import { opacityFor, isTransparent, isMixedAlpha, shapeFor, getDecal, getBlock, lightFor } from './VoxelTypes.js';
import { spanVecFor, solidYRange } from './VoxelShape.js';

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

  const makeBuffer = () => ({ positions: [], normals: [], uvs: [], colors: [], lights: [], emissive: [], indices: [] });
  const opaqueBuf = makeBuffer();
  const transparentBuf = makeBuffer();

  const [ox, oy, oz] = origin;
  // Dense halo cache: neighbor/AO probes dominate meshing cost, and each raw
  // world.get builds a string key. Prefetch the chunk + a 1-cell border into
  // a flat array once, then answer all those probes with O(1) index reads.
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

  const pushCorner = (buf, x, y, z, nx, ny, nz, u, v, r, g, b, ls, lb, e) => {
    buf.positions.push(x * CELL_SIZE, y * CELL_SIZE, z * CELL_SIZE);
    buf.normals.push(nx, ny, nz);
    buf.uvs.push(u, v);
    buf.colors.push(r, g, b);
    buf.lights.push(ls, lb);
    buf.emissive.push(e);
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
    for (const name of Object.keys(FACE_TABLE)) {
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
      const tile = painted
        ? tileIndexFor(painted, name)
        : tileIndexFor(voxel.type, rot ? rotatedFace(name, rot) : name);
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

      const cornerData = [];
      const quad = []; // per-corner vertex data, emitted into every target buffer
      for (const c of corners) {
        const cx = fx + c.x, cy = fy + (c.y ? y1f : y0f), cz = fz + c.z;
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

        // Affine UVs: each corner samples a (possibly rotated) (u,v) so the
        // tile maps cleanly (no diagonal fold) and, on side faces, the texture
        // vertical axis follows world-up (see FACE_TABLE.tex).
        // Voxel yaw spins the top/bottom tile in quarter turns (rotating a
        // road line or crack); side faces stay upright and only swap tiles.
        let cu = c.u, cv = c.v;
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
        const u = baseU + htU + du * (tileW - 2 * htU);
        const v = baseV + htV + dv * (tileH - 2 * htV);
        quad.push([cx, cy, cz, f.n[0], f.n[1], f.n[2], u, v, b, b, b, ls, lb, em]);
        cornerData.push({ cx, cy, cz, b, ls, lb, u0: c.u, v0: c.v });
      }
      for (const target of bufs) {
        const first = target.positions.length / 3;
        for (const q of quad) pushCorner(target, ...q);
        target.indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
      }

      // Decal covering this face: a second quad a hair off the surface,
      // reusing the face's AO/light so it blends in. Only visible faces get
      // here, so a decal on a buried face costs nothing. Multi-cell decals
      // emit one quad per covered face, each sampling its sub-rect of the
      // (span-sized) artwork, so culling/AO/light stay per-face.
      const decal = world.decalAt?.(fx, fy, fz, name);
      if (decal) {
        const [cw, ch] = getDecal(decal.decalId)?.span ?? [1, 1];
        const dRot = decal.rotation ?? 0;
        const [eu, ev] = decalFootprint(name, [cw, ch], dRot); // cells along u/v
        const [ax, ay, az] = decal.cell ?? [fx, fy, fz];
        // this cell's offset inside the footprint, along the face's axes
        const iOff = (fx - ax) * f.u[0] + (fy - ay) * f.u[1] + (fz - az) * f.u[2];
        const jOff = (fx - ax) * f.v[0] + (fy - ay) * f.v[1] + (fz - az) * f.v[2];
        const dTile = tileIndexFor(decal.decalId, name);
        const rectW = cw * tileW, rectH = ch * tileH; // art rect in the atlas
        const dBaseU = (dTile % AW) * tileW;
        const dBaseV = 1 - (Math.floor(dTile / AW) + ch) * tileH;
        const dFirst = buf.positions.length / 3;
        const EPS = 0.02; // 1cm in cell units — clears z-fighting
        for (const cd of cornerData) {
          // footprint-space fraction -> spin by the decal rotation -> face
          // orientation (f.tex) -> atlas rect
          let cu = (iOff + cd.u0) / eu, cv = (jOff + cd.v0) / ev;
          for (let k = 0; k < dRot; k++) { const tmp = cu; cu = cv; cv = 1 - tmp; }
          const t = f.tex;
          const du = 0.5 + t[0] * (cu - 0.5) + t[1] * (cv - 0.5);
          const dv = 0.5 + t[2] * (cu - 0.5) + t[3] * (cv - 0.5);
          const u = dBaseU + htU + du * (rectW - 2 * htU);
          const v = dBaseV + htV + dv * (rectH - 2 * htV);
          pushCorner(
            buf,
            cd.cx + f.n[0] * EPS, cd.cy + f.n[1] * EPS, cd.cz + f.n[2] * EPS,
            f.n[0], f.n[1], f.n[2], u, v, cd.b, cd.b, cd.b, cd.ls, cd.lb, 0,
          );
        }
        buf.indices.push(dFirst, dFirst + 1, dFirst + 2, dFirst, dFirst + 2, dFirst + 3);
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
    const pem = lightFor(voxel.type) > 0 ? 1 : 0;
    const span = voxel.size === 'big' ? 2 : 1;
    const tile = tileIndexFor(voxel.type, 'px');
    const tileW = 1 / AW;
    const tileH = 1 / AH;
    const baseU = (tile % AW) * tileW;
    const baseV = 1 - (Math.floor(tile / AW) + 1) * tileH;
    const htU = 0.5 / (AW * tileSize);
    const htV = 0.5 / (AH * tileSize);
    const cc = (p, a) => Math.max(a, Math.min(a + span - 1, Math.floor(p)));
    const half = span / 2;
    const alongX = ((voxel.rotation ?? 0) & 1) === 0;
    const n = alongX ? [0, 0, 1] : [1, 0, 0];

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
    const q = aq + half;
    // The pane voxel covering a cell, described in ITS run/plane terms.
    const paneAt = (r, row) => {
      const v = alongX ? hget(r, ay, row) : hget(row, ay, r);
      if (!v || shapeFor(v.type) !== 'pane') return null;
      const [nax, , naz] = v.anchor ?? (alongX ? [r, ay, row] : [row, ay, r]);
      const nspan = v.size === 'big' ? 2 : 1;
      const nAlongX = ((v.rotation ?? 0) & 1) === 0;
      const nr = nAlongX ? nax : naz;
      const nq = (nAlongX ? naz : nax) + nspan / 2;
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

    const emitRun = (rA, rB, uA, uB) => {
      const corners = alongX
        ? [[rA, ay, q], [rB, ay, q], [rB, ay + span, q], [rA, ay + span, q]]
        : [[q, ay, rA], [q, ay, rB], [q, ay + span, rB], [q, ay + span, rA]];
      const us = [uA, uB, uB, uA];
      const vs = [0, 0, 1, 1]; // uv-v follows world +y
      for (const flip of paneTransparent ? [1] : [1, -1]) {
        const order = flip === 1 ? [0, 1, 2, 3] : [0, 3, 2, 1];
        const first = paneBuf.positions.length / 3;
        for (const i of order) {
          const c = corners[i];
          const lx = cc(c[0], ax), ly = cc(c[1], ay), lz = cc(c[2], az);
          const ls = sky(lx, ly, lz) / 15;
          const lb = block(lx, ly, lz) / 15;
          const u = baseU + htU + us[i] * (tileW - 2 * htU);
          const v = baseV + htV + vs[i] * (tileH - 2 * htV);
          pushCorner(paneBuf, c[0], c[1], c[2], n[0] * flip, n[1] * flip, n[2] * flip, u, v, 1, 1, 1, ls, lb, pem);
        }
        paneBuf.indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
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
      const rectW = cw * tileW, rectH = ch * tileH; // art rect in the atlas
      const dBaseU = (dTile % AW) * tileW;
      const dBaseV = 1 - (Math.floor(dTile / AW) + ch) * tileH;
      // start at the pane's plane along the face normal, at the anchor in-plane
      const nAxis = f.n[0] ? 0 : f.n[1] ? 1 : 2;
      const base = [ax, ay, az];
      base[nAxis] += half + f.n[nAxis] * 0.02; // 1cm clear of the pane
      const dFirst = paneBuf.positions.length / 3;
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
          dBaseU + htU + du * (rectW - 2 * htU),
          dBaseV + htV + dv * (rectH - 2 * htV),
          1, 1, 1, sky(lx, ly, lz) / 15, block(lx, ly, lz) / 15, 0,
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
    const tileW = 1 / AW;
    const tileH = 1 / AH;
    const rectW = cw * tileW;
    const rectH = ch * tileH;
    const baseU = (tile % AW) * tileW;
    const baseV = 1 - (Math.floor(tile / AW) + ch) * tileH;
    const htU = 0.5 / (AW * tileSize);
    const htV = 0.5 / (AH * tileSize);

    const d = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const clamp = (p, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(p)));
    // Glazed doors (mixedAlpha) render like framed windows: the opaque pass
    // draws the leaf and discards the glass texels, the transparent pass
    // blends the glass in.
    const doorBufs = isMixedAlpha(voxel.type) ? [opaqueBuf, transparentBuf] : [opaqueBuf];
    for (const name of Object.keys(FACE_TABLE)) {
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
        const u = baseU + htU + fu * (rectW - 2 * htU);
        const v = baseV + htV + fv * (rectH - 2 * htV);
        quad.push([px, py, pz, f.n[0], f.n[1], f.n[2], u, v, 1, 1, 1, ls, lb, dem]);
      }
      for (const target of doorBufs) {
        const first = target.positions.length / 3;
        for (const q of quad) pushCorner(target, ...q);
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
