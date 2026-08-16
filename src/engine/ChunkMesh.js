// ChunkMesh.js — three.js mesh for one chunk.
//
// Thin adapter: the vertex data comes from the pure ChunkMeshBuilder (packed
// format: quantized chunk-local attributes + greedy meshing); this class just
// moves it into BufferGeometries and owns the THREE.Mesh lifecycle. Geometry
// is chunk-local — the meshes are parked at the chunk's world origin — so
// positions fit Int16 regardless of where the chunk sits in the world.
// A chunk can render in two passes: an opaque mesh and an optional transparent
// mesh (glass, torch) sharing the scene-level materials. `geometry` / `mesh`
// always refer to the opaque pass (back-compat with tests); the transparent
// pass lives in `meshTransparent` (null when the chunk has none).
//
// update() rebuilds synchronously; applyData() accepts prebuilt packed data
// (from the mesh worker) without touching the world.

import { buildChunkMesh } from './ChunkMeshBuilder.js';
import { CELL_SIZE } from './Space.js';

export class ChunkMesh {
  /**
   * @param {object} deps
   * @param {object} deps.THREE
   * @param {object} deps.world
   * @param {[number,number,number]} deps.origin
   * @param {number} deps.size
   * @param {(typeId:string, face:string)=>number} deps.tileIndexFor
   * @param {{width:number,height:number}} deps.atlas
   * @param {import('three').Material} deps.material       opaque material
   * @param {import('three').Material} [deps.materialTransparent]
   * @param {object} [deps.lightField]
   */
  constructor({ THREE, world, origin, size, tileIndexFor, atlas, material, materialTransparent, lightField }) {
    this.THREE = THREE;
    this.world = world;
    this.origin = origin;
    this.size = size;
    this.tileIndexFor = tileIndexFor;
    this.atlas = atlas;
    this.lightField = lightField;
    this.key = `${origin[0]},${origin[1]},${origin[2]}`;

    this.geometry = new THREE.BufferGeometry();
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.name = `chunk-${this.key}`;
    this.mesh.position.set(origin[0] * CELL_SIZE, origin[1] * CELL_SIZE, origin[2] * CELL_SIZE);

    this.transparentGeometry = null;
    this.meshTransparent = null;
    if (materialTransparent) {
      this.transparentGeometry = new THREE.BufferGeometry();
      this.meshTransparent = new THREE.Mesh(this.transparentGeometry, materialTransparent);
      this.meshTransparent.name = `chunk-${this.key}-t`;
      this.meshTransparent.position.copy(this.mesh.position);
      this.meshTransparent.visible = false;
      // Glass blends LAST among transparent objects, so depth-writing
      // cutout sprites (mobs) and particles drawn before it are correctly
      // tinted when they stand behind a pane. Initial value only: the
      // Renderer re-assigns a back-to-front order (still > 0) every frame,
      // since chunk-sized meshes defeat three.js's own point-position sort.
      this.meshTransparent.renderOrder = 1;
    }
  }

  /** Rebuild the geometry in place from the current world state. */
  update() {
    const data = buildChunkMesh(
      this.world, this.lightField, this.origin, this.size,
      this.tileIndexFor, this.atlas, { packed: true },
    );
    return this.applyData(data);
  }

  /**
   * Load prebuilt packed mesh data (same shape buildChunkMesh returns with
   * {packed: true}) into the geometries. Used directly by the async worker
   * path; update() funnels through here too.
   * @returns {boolean} true when the chunk has any visible geometry
   */
  applyData(data) {
    const T = this.THREE;
    const setAttrs = (geo, d) => {
      geo.setAttribute('position', new T.BufferAttribute(d.positions, 3));
      // Int8 normalized -> [-1,1]; the shader re-normalizes anyway.
      geo.setAttribute('normal', new T.BufferAttribute(d.normals, 3, true));
      geo.setAttribute('shade', new T.BufferAttribute(d.shade, 4, true));
      geo.setAttribute('uvLocal', new T.BufferAttribute(d.uvLocal, 2));
      geo.setAttribute('tileInfo', new T.BufferAttribute(d.tileInfo, 1));
      geo.setIndex(new T.BufferAttribute(d.indices, 1));
      // Positions are quantized ints, so computeBoundingSphere() would be
      // wildly wrong — set the sphere from the chunk's known local box
      // instead. Doors/panes/cover overhang their chunk by up to ~2 m, hence
      // the pad. (Frustum culling transforms this by the mesh's matrixWorld.)
      const e = this.size * CELL_SIZE;
      const sphere = geo.boundingSphere ?? new T.Sphere();
      sphere.center.set(e / 2, e / 2, e / 2);
      sphere.radius = Math.sqrt(3) * (e / 2) + 2.5;
      geo.boundingSphere = sphere;
    };

    setAttrs(this.geometry, data);
    const hasOpaque = data.indices.length > 0;

    if (this.transparentGeometry && this.meshTransparent) {
      this._hasTransparent = !!data.transparent;
      if (data.transparent) {
        setAttrs(this.transparentGeometry, data.transparent);
      }
      this._applyVisibility();
    }

    return hasOpaque || this._hasTransparent === true;
  }

  _applyVisibility() {
    this.meshTransparent.visible = this._hasTransparent && this.mesh.visible;
  }

  get visible() {
    return this.mesh.visible;
  }

  set visible(v) {
    this.mesh.visible = v;
    this._applyVisibility();
  }

  dispose() {
    this.geometry.dispose();
    this.transparentGeometry?.dispose();
  }
}
