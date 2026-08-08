// SelectionGhost.js — in-world placement/removal preview.
//
// Parts:
//  - a textured translucent preview of the actual block (tiles, rotation,
//    pane shape) where a new voxel would go — green-tinted when placeable,
//    red when blocked; falls back to a plain cube without an atlas,
//  - a wireframe box around the voxel currently under the cursor (removal),
//  - an InstancedMesh of cubes for multi-cell previews (line / square tools).

import { CELL_SIZE } from '../engine/Space.js';
import { spanFor } from '../engine/VoxelShape.js';
import { buildChunkMesh, FACE_TABLE, decalFootprint } from '../engine/ChunkMeshBuilder.js';
import { getDecal } from '../engine/VoxelTypes.js';

const PLACE_COLOR = 0x33ff66;
const BLOCKED_COLOR = 0xff5533;
const SPAWN_COLOR = 0x00e5ff;
// Soft green for the textured preview: keeps the "can place" signal while
// the tile art (line direction, crack, board angle) stays readable.
const PREVIEW_FREE_COLOR = 0xbfffd4;

export class SelectionGhost {
  /**
   * @param {object} deps
   * @param {object} deps.THREE
   * @param {import('three').Scene} deps.scene
   * @param {import('three').Texture} [deps.atlasTexture]  block atlas; when
   *   given, the placement preview shows the real block textures.
   * @param {(typeId:string, face:string)=>number} [deps.tileIndexFor]
   * @param {{width:number,height:number}} [deps.atlas]  atlas grid dims
   */
  constructor({ THREE, scene, atlasTexture = null, tileIndexFor = null, atlas = null }) {
    this.THREE = THREE;
    this.scene = scene;

    this.place = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: PLACE_COLOR, transparent: true, opacity: 0.45, depthWrite: false }),
    );
    this.place.visible = false;
    scene.add(this.place);

    // Textured preview of the actual block (rotation, per-face tiles, pane
    // shape). Geometry is produced by the same mesher as the world chunks
    // and cached per (block, size, rotation).
    this.texPlace = null;
    this._tileIndexFor = tileIndexFor;
    this._atlasDims = atlas;
    this._previewCache = new Map();
    if (atlasTexture && tileIndexFor && atlas) {
      this.texPlace = new THREE.Mesh(
        new THREE.BufferGeometry(),
        new THREE.MeshBasicMaterial({
          map: atlasTexture,
          transparent: true,
          opacity: 0.75,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      this.texPlace.visible = false;
      scene.add(this.texPlace);
    }

    this.remove = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0xff5555 }),
    );
    this.remove.visible = false;
    scene.add(this.remove);

    this.spawnGhost = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.OctahedronGeometry(CELL_SIZE * 0.7)),
      new THREE.LineBasicMaterial({ color: SPAWN_COLOR }),
    );
    this.spawnGhost.visible = false;
    scene.add(this.spawnGhost);

    this._cellsCap = 0;
    this.cells = null;
    // White base color: the per-instance colors (green/red) multiply it.
    this._cellsMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4, depthWrite: false });
    this._cellsGeo = new THREE.BoxGeometry(1, 1, 1);
  }

  /**
   * Show the placement preview. anchor is in cell coords, size 'small'|'big'.
   * With `spec` ({blockId, rotation}) and an atlas, the preview shows the
   * block's real textures (so a rotated road line or pane reads correctly);
   * otherwise it falls back to the plain translucent cube.
   */
  showPlacement(anchor, size, blocked, spec = null) {
    const s = spanFor(size) * CELL_SIZE;
    this.hideCells();
    if (this.texPlace && spec?.blockId) {
      const geo = this._previewGeometry(spec.blockId, size, spec.rotation ?? 0);
      if (geo) {
        this.place.visible = false;
        if (this.texPlace.geometry !== geo) this.texPlace.geometry = geo;
        this.texPlace.position.set(anchor[0] * CELL_SIZE, anchor[1] * CELL_SIZE, anchor[2] * CELL_SIZE);
        this.texPlace.material.color.setHex(blocked ? BLOCKED_COLOR : PREVIEW_FREE_COLOR);
        this.texPlace.visible = true;
        return;
      }
    }
    if (this.texPlace) this.texPlace.visible = false;
    this.place.visible = true;
    this.place.scale.set(s, s, s);
    this.place.position.set(
      anchor[0] * CELL_SIZE + s / 2,
      anchor[1] * CELL_SIZE + s / 2,
      anchor[2] * CELL_SIZE + s / 2,
    );
    this.place.material.color.setHex(blocked ? BLOCKED_COLOR : PLACE_COLOR);
  }

  /** Preview geometry for a block at a size/rotation, built by the chunk
   *  mesher over a one-voxel stub world and cached. Returns null when the
   *  block has no tiles in the atlas. */
  _previewGeometry(blockId, size, rotation) {
    const key = `${blockId}|${size}|${rotation}`;
    const cached = this._previewCache.get(key);
    if (cached) return cached;
    const span = spanFor(size);
    const voxel = { type: blockId, size, rotation, anchor: [0, 0, 0] };
    const stub = {
      get: (x, y, z) =>
        x >= 0 && x < span && y >= 0 && y < span && z >= 0 && z < span ? voxel : null,
    };
    let data;
    try {
      data = buildChunkMesh(stub, null, [0, 0, 0], span, this._tileIndexFor, this._atlasDims);
    } catch {
      return null;
    }
    // Merge the opaque and transparent buffers — the preview material blends
    // everything anyway.
    const t = data.transparent;
    const positions = t ? Float32Array.of(...data.positions, ...t.positions) : data.positions;
    const uvs = t ? Float32Array.of(...data.uvs, ...t.uvs) : data.uvs;
    const base = data.positions.length / 3;
    const indices = t
      ? Uint32Array.of(...data.indices, ...[...t.indices].map((i) => i + base))
      : data.indices;
    if (!indices.length) return null;
    const geo = new this.THREE.BufferGeometry();
    geo.setAttribute('position', new this.THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new this.THREE.BufferAttribute(uvs, 2));
    geo.setIndex(new this.THREE.BufferAttribute(indices, 1));
    this._previewCache.set(key, geo);
    return geo;
  }

  /**
   * Preview a decal on one face of the voxel occupying `cell` — the actual
   * decal texture, pinned a hair off the face. Red-tinted when the face is
   * blocked (already carries a decal). Needs the atlas; no-op without it.
   */
  showDecal(cell, face, decalId, rotation, blocked) {
    if (!this.texPlace) return;
    this.hideCells();
    this.place.visible = false;
    this.remove.visible = false;
    const geo = this._decalGeometry(decalId, face, rotation ?? 0);
    if (!geo) return;
    if (this.texPlace.geometry !== geo) this.texPlace.geometry = geo;
    this.texPlace.position.set(cell[0] * CELL_SIZE, cell[1] * CELL_SIZE, cell[2] * CELL_SIZE);
    // No green tint here — decals are recognizable art; dim red only when blocked.
    this.texPlace.material.color.setHex(blocked ? BLOCKED_COLOR : 0xffffff);
    this.texPlace.visible = true;
  }

  /** Cached quad geometry for a decal on a given face/rotation — spans the
   *  decal's whole footprint, using the same UV math as the chunk mesher. */
  _decalGeometry(decalId, face, rotation) {
    const key = `decal|${decalId}|${face}|${rotation}`;
    const cached = this._previewCache.get(key);
    if (cached) return cached;
    const f = FACE_TABLE[face];
    const tile = this._tileIndexFor(decalId, face);
    if (f == null || tile == null) return null;
    const [cw, ch] = getDecal(decalId)?.span ?? [1, 1];
    const [eu, ev] = decalFootprint(face, [cw, ch], rotation); // cells along u/v
    const { width: AW, height: AH, tileSize = 16 } = this._atlasDims;
    const tileW = 1 / AW, tileH = 1 / AH;
    const rectW = cw * tileW, rectH = ch * tileH;
    const baseU = (tile % AW) * tileW;
    const baseV = 1 - (Math.floor(tile / AW) + ch) * tileH;
    const htU = 0.5 / (AW * tileSize), htV = 0.5 / (AH * tileSize);
    const EPS = 0.03;
    const positions = new Float32Array(4 * 3);
    const uvs = new Float32Array(4 * 2);
    [{ u: 0, v: 0 }, { u: 1, v: 0 }, { u: 1, v: 1 }, { u: 0, v: 1 }].forEach((c, i) => {
      for (let a = 0; a < 3; a++) {
        positions[i * 3 + a] = (f.o[a] + c.u * eu * f.u[a] + c.v * ev * f.v[a] + f.n[a] * EPS) * CELL_SIZE;
      }
      let cu = c.u, cv = c.v;
      for (let k = 0; k < rotation; k++) { const tmp = cu; cu = cv; cv = 1 - tmp; }
      const t = f.tex;
      const du = 0.5 + t[0] * (cu - 0.5) + t[1] * (cv - 0.5);
      const dv = 0.5 + t[2] * (cu - 0.5) + t[3] * (cv - 0.5);
      uvs[i * 2] = baseU + htU + du * (rectW - 2 * htU);
      uvs[i * 2 + 1] = baseV + htV + dv * (rectH - 2 * htV);
    });
    const geo = new this.THREE.BufferGeometry();
    geo.setAttribute('position', new this.THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new this.THREE.BufferAttribute(uvs, 2));
    geo.setIndex(new this.THREE.BufferAttribute(Uint32Array.of(0, 1, 2, 0, 2, 3), 1));
    this._previewCache.set(key, geo);
    return geo;
  }

  /** Show the removal outline around the hovered voxel. */
  showRemoval(anchor, size) {
    const s = spanFor(size) * CELL_SIZE;
    this.remove.visible = true;
    this.remove.scale.set(s, s, s);
    this.remove.position.set(
      anchor[0] * CELL_SIZE + s / 2,
      anchor[1] * CELL_SIZE + s / 2,
      anchor[2] * CELL_SIZE + s / 2,
    );
  }

  /** Show the spawn-point preview at a cell (cyan, red when blocked). */
  showSpawn(cell, blocked) {
    this.hideCells();
    this.place.visible = false;
    if (this.texPlace) this.texPlace.visible = false;
    this.remove.visible = false;
    this.spawnGhost.visible = true;
    this.spawnGhost.position.set(
      cell[0] * CELL_SIZE + CELL_SIZE / 2,
      cell[1] * CELL_SIZE + CELL_SIZE / 2,
      cell[2] * CELL_SIZE + CELL_SIZE / 2,
    );
    this.spawnGhost.material.color.setHex(blocked ? BLOCKED_COLOR : SPAWN_COLOR);
  }

  /** Show the mob-spawn preview (tinted by mob type, red when blocked). */
  showMob(cell, blocked, colorHex = 0xff5544) {
    this.hideCells();
    this.place.visible = false;
    if (this.texPlace) this.texPlace.visible = false;
    this.remove.visible = false;
    this.spawnGhost.visible = true;
    this.spawnGhost.position.set(
      cell[0] * CELL_SIZE + CELL_SIZE / 2,
      cell[1] * CELL_SIZE + CELL_SIZE / 2,
      cell[2] * CELL_SIZE + CELL_SIZE / 2,
    );
    this.spawnGhost.material.color.setHex(blocked ? BLOCKED_COLOR : colorHex);
  }

  /**
   * Preview many cells at once (line / square). anchors are cell coords.
   * `blocked` is a single flag or a per-anchor boolean array — blocked cells
   * render red, free ones green, so a partially blocked line/rect shows
   * exactly which voxels will be skipped.
   * `keepPlacement` leaves the single placement cube visible (the build
   * tool shows the aim cube alongside its snapped line preview).
   */
  showCells(anchors, size, blocked, { keepPlacement = false } = {}) {
    const s = spanFor(size) * CELL_SIZE;
    if (!keepPlacement) {
      this.place.visible = false;
      if (this.texPlace) this.texPlace.visible = false;
    }
    this.remove.visible = false;
    this._ensureCellsCapacity(anchors.length);
    const m = new this.THREE.Matrix4();
    const col = new this.THREE.Color();
    const perCell = Array.isArray(blocked);
    anchors.forEach((a, i) => {
      m.makeScale(s, s, s);
      m.setPosition(a[0] * CELL_SIZE + s / 2, a[1] * CELL_SIZE + s / 2, a[2] * CELL_SIZE + s / 2);
      this.cells.setMatrixAt(i, m);
      col.setHex((perCell ? blocked[i] : blocked) ? BLOCKED_COLOR : PLACE_COLOR);
      this.cells.setColorAt(i, col);
    });
    this.cells.count = anchors.length;
    this.cells.instanceMatrix.needsUpdate = true;
    if (this.cells.instanceColor) this.cells.instanceColor.needsUpdate = true;
    this.cells.visible = true;
  }

  hideCells() {
    if (this.cells) this.cells.visible = false;
  }

  _ensureCellsCapacity(n) {
    if (this.cells && this._cellsCap >= n) return;
    this._cellsCap = Math.max(128, n * 2);
    if (this.cells) this.scene.remove(this.cells);
    this.cells = new this.THREE.InstancedMesh(this._cellsGeo, this._cellsMat, this._cellsCap);
    // Pre-size the per-instance color buffer to the full capacity so
    // setColorAt never writes past a lazily created, smaller buffer.
    this.cells.instanceColor = new this.THREE.InstancedBufferAttribute(
      new Float32Array(this._cellsCap * 3).fill(1), 3,
    );
    this.cells.visible = false;
    this.scene.add(this.cells);
  }

  hide() {
    this.place.visible = false;
    if (this.texPlace) this.texPlace.visible = false;
    this.remove.visible = false;
    this.spawnGhost.visible = false;
    this.hideCells();
  }
}
