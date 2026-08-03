// Renderer.js — scene graph + chunk mesh cache.
//
// Owns the THREE scene, camera and lights, and keeps chunk meshes in sync
// with the World via dirty-chunk draining. The WebGLRenderer itself is
// injected so this class can be unit tested with a stub.
//
// World geometry is lit by a precomputed per-vertex light field (see
// LightField + chunkShader), so no scene lights are needed for chunks. The
// Ambient/Directional lights here only serve the editor overlays (selection
// ghost, spawn marker) which use stock materials.

import { ChunkMesh } from './ChunkMesh.js';
import { LightField } from './LightField.js';
import { createChunkMaterial } from './chunkShader.js';
import { CELL_SIZE } from './Space.js';
import { CONFIG } from '../config.js';

/** Max deferred (non-urgent) chunk rebuilds per frame. */
const REBUILD_BUDGET = 2;

export class Renderer {
  /**
   * @param {object} deps
   * @param {object} deps.THREE
   * @param {object} deps.webgl     a THREE.WebGLRenderer (or stub)
   * @param {object} deps.world     the World to display
   * @param {import('three').Texture} deps.atlasTexture
   * @param {(typeId:string, face:string)=>number} deps.tileIndexFor
   * @param {{width:number,height:number}} deps.atlas
   * @param {object} [deps.config]  overrides merged over CONFIG
   */
  constructor({ THREE, webgl, world, atlasTexture, tileIndexFor, atlas, config = {} }) {
    this.THREE = THREE;
    this.webgl = webgl;
    this.world = world;
    this.chunkSize = world.chunkSize;
    this.tileIndexFor = tileIndexFor;
    this.atlas = atlas;
    const cfg = {
      camera: { ...CONFIG.camera, ...(config.camera ?? {}) },
      lighting: { ...CONFIG.lighting, ...(config.lighting ?? {}) },
    };
    this.lighting = cfg.lighting;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87ceeb);

    this.camera = new THREE.PerspectiveCamera(cfg.camera.fov, 1, cfg.camera.near, cfg.camera.far);
    this.camera.position.set(4, 12, 4);
    this.camera.lookAt(0, 4, 0);

    // Editor overlay lights (no effect on the chunk shader).
    this.scene.add(new THREE.AmbientLight(0xffffff, cfg.lighting.ambient));
    const sun = new THREE.DirectionalLight(0xffffff, cfg.lighting.sun);
    sun.position.set(0.5, 1.5, 0.4);
    this.scene.add(sun);

    // Chunk materials (shared across all chunks).
    this.material = createChunkMaterial(THREE, { map: atlasTexture, config: cfg.lighting });
    this.materialTransparent = createChunkMaterial(THREE, { map: atlasTexture, config: cfg.lighting, transparent: true });
    // Untextured lit material for placeable object meshes: same light model,
    // but `tex = 1` so the per-vertex color alone drives the surface. Items
    // therefore respond to the light field like chunks instead of glowing in
    // the dark.
    this.itemMaterial = createChunkMaterial(THREE, { map: null, config: cfg.lighting });

    /** @type {Map<string, ChunkMesh>} */
    this.chunks = new Map();
    this._prevKey = null;

    /** @type {LightField} */
    this.light = new LightField(world);
    this._skyTime = 0;
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.webgl.setSize(w, h, false);
  }

  /**
   * Rebuild chunks flagged dirty since the last drain, and keep light in sync.
   *
   * Light updates come from the World's edit records (place/remove deltas):
   * small batches are patched incrementally in a bounded box, big batches fall
   * back to a full recompute. Chunk rebuilds are time-sliced: the chunk(s)
   * directly touched by an edit rebuild this frame so the block appears
   * instantly, while up to REBUILD_BUDGET neighbors rebuild per frame and the
   * rest stay dirty (their border AO/light catches up over a few frames).
   * Call every frame.
   */
  syncChunks() {
    const edits = this.world.drainEdits();
    if (edits.length) this.light.recomputeEdit(edits);

    const keys = this.world.drainDirty();
    if (!keys.length) return;

    const urgent = new Set();
    for (const e of edits) {
      for (const [x, y, z] of e.cells) urgent.add(this.world.chunkKey(x, y, z));
    }

    const rebuilt = new Set();
    for (const ckey of keys) {
      if (urgent.has(ckey)) { this._rebuildChunk(ckey); rebuilt.add(ckey); }
    }
    let deferred = 0;
    for (const ckey of keys) {
      if (rebuilt.has(ckey) || deferred >= REBUILD_BUDGET) continue;
      this._rebuildChunk(ckey);
      rebuilt.add(ckey);
      deferred++;
    }
    for (const ckey of keys) {
      if (!rebuilt.has(ckey)) this.world.dirty.add(ckey);
    }
  }

  /** Build or refresh the mesh for one dirty chunk. */
  _rebuildChunk(ckey) {
    const origin = this.world.chunkOrigin(ckey);
    let mesh = this.chunks.get(ckey);
    if (!mesh) {
      mesh = new ChunkMesh({
        THREE: this.THREE,
        world: this.world,
        origin,
        size: this.chunkSize,
        tileIndexFor: this.tileIndexFor,
        atlas: this.atlas,
        material: this.material,
        materialTransparent: this.materialTransparent,
        lightField: this.light,
      });
      this.chunks.set(ckey, mesh);
      this.scene.add(mesh.mesh);
      if (mesh.meshTransparent) this.scene.add(mesh.meshTransparent);
    }
    mesh.update();
  }

  /** Rebuild every loaded chunk mesh so baked per-vertex light reflects the
   *  current light field. Used after item light changes — placing/removing an
   *  item updates the light field but doesn't mark chunks dirty, so without
   *  this the surrounding surfaces would keep their old (dark) baked light.
   */
  rebakeChunkLight() {
    for (const mesh of this.chunks.values()) mesh.update();
  }

  /**
   * Rebuild every currently loaded chunk (used after load/clear/seed).
   * @returns {string[]} the chunk keys that were loaded
   */
  rebuildAll() {
    this.light.recompute();
    this.world.drainEdits();
    this.world.drainDirty();
    const keys = [];
    for (const [ckey, mesh] of this.chunks) {
      keys.push(ckey);
      mesh.update();
    }
    return keys;
  }

  /**
   * Load chunks covering the current world bounds (used on startup and after
   * loading a map from disk). Builds every mesh and recomputes the light from
   * scratch, so any pending edits/dirty flags are drained here.
   */
  loadWorldBounds() {
    const b = this.world.bounds();
    if (!b) {
      this.light.clear();
      this.world.drainEdits();
      this.world.drainDirty();
      return [];
    }
    this.light.recompute();
    this.world.drainEdits();
    this.world.drainDirty();
    const origins = this.world.chunkOriginsInRegion(b.min, b.max);
    for (const origin of origins) {
      const ckey = this.world.chunkKey(origin[0], origin[1], origin[2]);
      if (this.chunks.has(ckey)) continue;
      const mesh = new ChunkMesh({
        THREE: this.THREE,
        world: this.world,
        origin,
        size: this.chunkSize,
        tileIndexFor: this.tileIndexFor,
        atlas: this.atlas,
        material: this.material,
        materialTransparent: this.materialTransparent,
        lightField: this.light,
      });
      mesh.update();
      this.chunks.set(ckey, mesh);
      this.scene.add(mesh.mesh);
      if (mesh.meshTransparent) this.scene.add(mesh.meshTransparent);
    }
    return origins.length;
  }

  /** Drop all loaded chunk meshes (before clear/load). */
  clearChunks() {
    for (const mesh of this.chunks.values()) mesh.dispose();
    this.chunks.clear();
    this.light.clear();
    // remove all chunk meshes from the scene
    for (const child of [...this.scene.children]) {
      if (child.name.startsWith('chunk-')) this.scene.remove(child);
    }
  }

  /** Advance the day/night cycle and push time-based uniforms. @param {number} dt seconds */
  _updateSky(dt) {
    const L = this.lighting;
    if (!L.dayNight) return;
    this._skyTime += dt;
    // phase 1 = full day; start at day (angle offset of PI/2).
    const phase = 0.5 + 0.5 * Math.sin(this._skyTime * L.dayNightSpeed * Math.PI * 2 + Math.PI / 2);
    const intensity = 0.15 + 0.85 * phase; // 0.15 .. 1.0
    this.material.uniforms.uSkyIntensity.value = intensity;
    this.materialTransparent.uniforms.uSkyIntensity.value = intensity;
    this.itemMaterial.uniforms.uSkyIntensity.value = intensity;
    const day = new this.THREE.Color(0x87ceeb);
    const night = new this.THREE.Color(...L.nightSky);
    this.scene.background.copy(day).lerp(night, 1 - phase);
  }

  /**
   * @param {number} [dt]  seconds since last frame (drives day/night)
   * @param {import('three').Scene} [scene]  scene to render (defaults to the
   *   world scene). Rendering any other scene (e.g. the item editor's clean
   *   scene) skips the world's chunk sync and the day/night cycle.
   */
  render(dt = 0, scene = this.scene) {
    if (scene === this.scene) {
      this.syncChunks();
      this._updateSky(dt);
    }
    this.webgl.render(scene, this.camera);
  }

  /** Move the camera to a good vantage point above the world. */
  frameCamera() {
    const b = this.world.bounds();
    const cx = b ? (b.min[0] + b.max[0]) / 2 * CELL_SIZE : 0;
    const cz = b ? (b.min[2] + b.max[2]) / 2 * CELL_SIZE : 0;
    const top = b ? (b.max[1] + 3) * CELL_SIZE : 8;
    this.camera.position.set(cx, top, cz + Math.max(6, top));
    this.camera.lookAt(cx, top * 0.5, cz);
  }
}
