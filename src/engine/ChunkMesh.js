// ChunkMesh.js — three.js mesh for one chunk.
//
// Thin adapter: the vertex data comes from the pure ChunkMeshBuilder; this
// class just moves it into BufferGeometries and owns the THREE.Mesh lifecycle.
// A chunk can render in two passes: an opaque mesh and an optional transparent
// mesh (glass, torch) sharing the scene-level materials. `geometry` / `mesh`
// always refer to the opaque pass (back-compat with tests); the transparent
// pass lives in `meshTransparent` (null when the chunk has none).

import { buildChunkMesh } from './ChunkMeshBuilder.js';

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

    this.transparentGeometry = null;
    this.meshTransparent = null;
    if (materialTransparent) {
      this.transparentGeometry = new THREE.BufferGeometry();
      this.meshTransparent = new THREE.Mesh(this.transparentGeometry, materialTransparent);
      this.meshTransparent.name = `chunk-${this.key}-t`;
      this.meshTransparent.visible = false;
    }
  }

  /** Rebuild the geometry in place from the current world state. */
  update() {
    const T = this.THREE;
    const data = buildChunkMesh(this.world, this.lightField, this.origin, this.size, this.tileIndexFor, this.atlas);

    const setAttrs = (geo, d) => {
      geo.setAttribute('position', new T.BufferAttribute(d.positions, 3));
      geo.setAttribute('normal', new T.BufferAttribute(d.normals, 3));
      geo.setAttribute('uv', new T.BufferAttribute(d.uvs, 2));
      geo.setAttribute('color', new T.BufferAttribute(d.colors, 3));
      geo.setAttribute('light', new T.BufferAttribute(d.lights, 2));
      geo.setIndex(new T.BufferAttribute(d.indices, 1));
      geo.computeBoundingSphere();
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
