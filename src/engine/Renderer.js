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
//
// Huge worlds: chunks stream around the camera (CONFIG.render.viewDistance) —
// content chunks inside the radius mesh on demand (nearest first, budgeted
// per frame), chunks beyond the unload radius are disposed. Distance fog
// hides the streaming edge. The whole frame can optionally run through the
// PostFX pipeline (bloom + polaroid grade).

import { ChunkMesh } from './ChunkMesh.js';
import { Sky } from './Sky.js';
import { LightField } from './LightField.js';
import { MAX_LAMPS } from './chunkShader.js';
import { PostFX } from './PostFX.js';
import { createChunkMaterial } from './chunkShader.js';
import { CELL_SIZE } from './Space.js';
import { CONFIG } from '../config.js';

/** Time budget (ms) for deferred chunk rebuilds per frame. A dense chunk
 *  costs ~5-12 ms to remesh, so a count budget would let a few of them blow
 *  the frame; the time budget keeps catch-up work bounded regardless of how
 *  heavy the chunks are. */
const REBUILD_BUDGET_MS = 6;
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
/** Worlds with at most this many chunks load fully; bigger ones stream. */
const FULL_LOAD_MAX = 30000;

const smoothstep = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

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
      render: { ...CONFIG.render, ...(config.render ?? {}) },
      postfx: { ...CONFIG.postfx, ...(config.postfx ?? {}) },
    };
    this.lighting = cfg.lighting;
    this.renderCfg = cfg.render;
    this.postfxEnabled = cfg.postfx.enabled !== false;
    this._postfxCfg = cfg.postfx;
    this._w = 0;
    this._h = 0;
    this._bw = 0;
    this._bh = 0;
    this._postTime = 0;
    /** @type {PostFX|null} built lazily on the first real render */
    this.postfx = null;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87ceeb);

    this.camera = new THREE.PerspectiveCamera(cfg.camera.fov, 1, cfg.camera.near, cfg.camera.far);
    this.camera.position.set(4, 12, 4);
    this.camera.lookAt(0, 4, 0);

    // Procedural sky: dome + sun/moon/clouds, driven by the day/night cycle.
    this.sky = new Sky({ THREE, config: config.sky ?? CONFIG.sky });
    this.scene.add(this.sky.group);

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
    this._litMaterials = [this.material, this.materialTransparent, this.itemMaterial];

    // Distance fog derived from the streaming radius, so the world fades into
    // the sky exactly where chunks stop loading. fogFar <= 0 = derive.
    const edgeMeters = this.chunkSize * CELL_SIZE;
    let fogFar = this.renderCfg.fogFar;
    let fogNear = this.renderCfg.fogNear;
    if (fogFar <= 0) {
      fogFar = this.renderCfg.viewDistance > 0 ? this.renderCfg.viewDistance * edgeMeters : 1e9;
      fogNear = fogFar * 0.62;
    }
    this._fogFar = fogFar;
    this._fogNear = fogNear;
    for (const mat of this._litMaterials) {
      mat.uniforms.uFogNear.value = fogNear;
      mat.uniforms.uFogFar.value = fogFar;
    }

    /** @type {Map<string, ChunkMesh>} */
    this.chunks = new Map();
    this._prevKey = null;

    /** @type {LightField} */
    this.light = new LightField(world);
    // Seed the cycle clock so the sky starts at the configured time of day.
    this._skyTime = this.lighting.dayNightSpeed
      ? (this.lighting.dayNightStart ?? 0) / this.lighting.dayNightSpeed
      : 0;
    this._sunScratch = new THREE.Vector3();
    this._colorScratch = new THREE.Color();
    this._sunNoon = new THREE.Color(1, 0.97, 0.9);
    this._sunWarm = new THREE.Color(1, 0.5, 0.22);
    this._dayBg = new THREE.Color(0x87ceeb);
    this._fogDay = new THREE.Color(...this.lighting.fogColor);
    this._fogNight = new THREE.Color(...this.lighting.nightSky);
  }

  resize(w, h) {
    this._w = w;
    this._h = h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // renderScale trades image sharpness for fill rate: the drawing buffer
    // shrinks while the canvas keeps filling the viewport (updateStyle=false
    // + explicit CSS size, so a scaled buffer never crops the view). At scale
    // 1 this behaves exactly like the old setSize(w, h, true) path.
    const scale = Math.min(1, Math.max(0.25, this.renderCfg.renderScale ?? 1));
    const bw = Math.max(1, Math.round(w * scale));
    const bh = Math.max(1, Math.round(h * scale));
    this._bw = bw;
    this._bh = bh;
    this.webgl.setSize(bw, bh, false);
    const el = this.webgl.domElement;
    if (el && el.style) {
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
    }
    const pr = this.webgl.getPixelRatio ? this.webgl.getPixelRatio() : 1;
    this.postfx?.setSize(bw * pr, bh * pr, this.webgl);
  }

  /** Push a dynamic muzzle-flash light (world position + 0..1 intensity) into
   *  every material driven by the light engine, so chunks, placed items and
   *  the player's own hands/weapon briefly light up near the barrel when a gun
   *  fires. Call every frame with the current flash state (intensity 0 = off). */
  setFlashLight(pos, intensity) {
    for (const mat of this._litMaterials) {
      mat.uniforms.uFlashIntensity.value = intensity;
      mat.uniforms.uFlashPos.value.copy(pos);
    }
  }

  /** Drive the dynamic flicker-lamp lights (Blinkers.lampLights): world
   *  center, range and 0..1 gutter signal per LIT flickering lamp. The
   *  nearest MAX_LAMPS to the camera win when a map has more. Call every
   *  frame; an empty list switches the effect off. */
  setLampLights(lights) {
    let list = lights ?? [];
    if (list.length > MAX_LAMPS) {
      const c = this.camera.position;
      const d2 = (l) => (l.x - c.x) ** 2 + (l.y - c.y) ** 2 + (l.z - c.z) ** 2;
      list = [...list].sort((a, b) => d2(a) - d2(b)).slice(0, MAX_LAMPS);
    }
    for (const mat of this._litMaterials) {
      const u = mat.uniforms;
      u.uLampCount.value = list.length;
      for (let i = 0; i < list.length; i++) {
        u.uLamps.value[i].set(list[i].x, list[i].y, list[i].z, list[i].range);
        u.uLampI.value[i] = list[i].intensity;
      }
    }
  }

  /** Toggle the polaroid/bloom pipeline at runtime. @returns {boolean} new state */
  togglePostFX() {
    this.postfxEnabled = !this.postfxEnabled;
    return this.postfxEnabled;
  }

  /**
   * Rebuild chunks flagged dirty since the last drain, and keep light in sync.
   *
   * Light updates come from the World's edit records (place/remove deltas):
   * small batches are patched incrementally in a bounded box, big batches fall
   * back to a full recompute. Chunk rebuilds are time-sliced: chunks touched
   * by a hard (player) edit rebuild this frame so the block appears instantly,
   * while soft edits (blinking lights) and plain dirty chunks rebuild within
   * the REBUILD_BUDGET_MS time budget; the rest stay dirty and catch up over
   * the next frames (their border AO/light follows).
   * Dirty chunks that aren't loaded are skipped — streaming builds them fresh
   * from live world state when the camera approaches. Call every frame.
   */
  syncChunks() {
    const edits = this.world.drainEdits();
    if (edits.length) this.light.recomputeEdit(edits);

    const keys = this.world.drainDirty();

    // Player edits rebuild instantly so placed blocks appear the same frame;
    // soft edits (blinking lights) tolerate a frame of latency and queue up
    // with the deferred, budgeted work.
    const urgent = new Set();
    for (const e of edits) {
      if (e.soft) continue;
      for (const [x, y, z] of e.cells) urgent.add(this.world.chunkKey(x, y, z));
    }

    const rebuilt = new Set();
    for (const ckey of keys) {
      if (urgent.has(ckey)) { this._rebuildChunk(ckey); rebuilt.add(ckey); }
    }
    const t0 = nowMs();
    for (const ckey of keys) {
      if (rebuilt.has(ckey)) continue;
      if (!this.chunks.has(ckey)) continue; // streamed in fresh later
      if (nowMs() - t0 > REBUILD_BUDGET_MS) break;
      this._rebuildChunk(ckey);
      rebuilt.add(ckey);
    }
    for (const ckey of keys) {
      if (!rebuilt.has(ckey) && this.chunks.has(ckey)) this.world.dirty.add(ckey);
    }

    // Occupancy changed somewhere -> the set of streamable chunks may have too
    // (type-only edits like blinking lights leave the chunk set alone).
    if (this.world.drainOccupancyChanged()) this._streamDirty = true;
    this._streamChunks();
  }

  /**
   * Stream chunk meshes around the camera: dispose meshes beyond the unload
   * radius, build the nearest unloaded content chunks (budgeted per frame).
   * No-op when viewDistance is 0 (streaming off). The full scan only runs
   * when the camera moved at least half a chunk or the world's content
   * changed, so a standing-still frame pays nothing for streaming.
   */
  _streamChunks() {
    const R = this.renderCfg;
    if (!R.viewDistance) return;
    const s = this.world.chunkSize;
    const edge = s * CELL_SIZE; // chunk edge length in meters
    const cam = this.camera.position;
    if (!this._streamDirty && this._streamPos) {
      const dx = cam.x - this._streamPos.x, dy = cam.y - this._streamPos.y, dz = cam.z - this._streamPos.z;
      if (dx * dx + dy * dy + dz * dz < edge * edge * 0.25) return;
    }
    this._streamDirty = false;
    (this._streamPos ??= new this.THREE.Vector3()).copy(cam);

    const loadR = R.viewDistance * edge;
    const unloadR = Math.max(R.unloadDistance ?? R.viewDistance, R.viewDistance) * edge;
    const cx0 = cam.x, cy0 = cam.y, cz0 = cam.z;

    const centerDist2FromCoords = (fx, fy, fz) => {
      const dx = (fx + 0.5) * edge - cx0;
      const dy = (fy + 0.5) * edge - cy0;
      const dz = (fz + 0.5) * edge - cz0;
      return dx * dx + dy * dy + dz * dz;
    };

    for (const [ckey, mesh] of this.chunks) {
      const coords = this.world.chunkCoords.get(ckey)
        ?? this.world.chunkOrigin(ckey).map((c) => c / s); // emptied chunk
      if (centerDist2FromCoords(coords[0], coords[1], coords[2]) > unloadR * unloadR) {
        mesh.dispose();
        this.scene.remove(mesh.mesh);
        if (mesh.meshTransparent) this.scene.remove(mesh.meshTransparent);
        this.chunks.delete(ckey);
      }
    }

    const pending = [];
    for (const [ckey, [fx, fy, fz]] of this.world.chunkCoords) {
      if (this.chunks.has(ckey)) continue;
      const d2 = centerDist2FromCoords(fx, fy, fz);
      if (d2 <= loadR * loadR) pending.push([d2, ckey]);
    }
    if (!pending.length) return;
    pending.sort((a, b) => a[0] - b[0]);
    // A cold world gets a bigger first burst so the view fills quickly;
    // afterwards the count + time budgets keep streaming hitches out of the
    // frame time (a dense chunk can take >10 ms to mesh).
    const cold = this.chunks.size === 0;
    const budget = cold ? Math.max(R.maxLoadsPerFrame, 32) : R.maxLoadsPerFrame;
    const t0 = nowMs();
    for (let i = 0; i < pending.length && i < budget; i++) {
      if (!cold && nowMs() - t0 > REBUILD_BUDGET_MS) break;
      this._rebuildChunk(pending[i][1]);
    }
  }

  /** Build or refresh the mesh for one chunk. Chunks emptied of content are
   *  dropped entirely instead of lingering as dead geometry. */
  _rebuildChunk(ckey) {
    let mesh = this.chunks.get(ckey);
    if (!this.world.chunkCounts.has(ckey)) {
      if (mesh) {
        mesh.dispose();
        this.scene.remove(mesh.mesh);
        if (mesh.meshTransparent) this.scene.remove(mesh.meshTransparent);
        this.chunks.delete(ckey);
      }
      return;
    }
    if (!mesh) {
      const origin = this.world.chunkOrigin(ckey);
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
   * scratch, so any pending edits/dirty flags are drained here. Huge worlds
   * (beyond FULL_LOAD_MAX chunks) only mesh the camera's neighborhood; the
   * rest streams in as the camera moves.
   */
  loadWorldBounds() {
    const b = this.world.bounds();
    if (!b) {
      this.light.clear();
      this.world.drainEdits();
      this.world.drainDirty();
      this._invalidateStream();
      return [];
    }
    this.light.recompute();
    this.world.drainEdits();
    this.world.drainDirty();
    let origins = this.world.chunkOriginsInRegion(b.min, b.max);
    if (this.renderCfg.viewDistance && origins.length > FULL_LOAD_MAX) {
      const s = this.world.chunkSize;
      const edge = s * CELL_SIZE;
      const loadR = this.renderCfg.viewDistance * edge;
      const cam = this.camera.position;
      origins = origins.filter(([cx, cy, cz]) => {
        const dx = (cx + s / 2) * CELL_SIZE - cam.x;
        const dy = (cy + s / 2) * CELL_SIZE - cam.y;
        const dz = (cz + s / 2) * CELL_SIZE - cam.z;
        return dx * dx + dy * dy + dz * dz <= loadR * loadR;
      });
    }
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
    this._invalidateStream();
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
    this._invalidateStream();
  }

  /** Force the next streaming pass to re-scan (after bulk chunk changes). */
  _invalidateStream() {
    this._streamDirty = true;
    this._streamPos = null;
  }

  /** Advance the day/night cycle and push time-based uniforms. @param {number} dt seconds */
  _updateSky(dt) {
    const L = this.lighting;
    if (!L.dayNight) return;
    this._skyTime += dt;
    // phase 1 = full day; start at day (angle offset of PI/2). The same angle
    // drives the visual sky (sun/moon position, dome tint, stars, clouds).
    const angle = this._skyTime * L.dayNightSpeed * Math.PI * 2 + Math.PI / 2;
    const phase = 0.5 + 0.5 * Math.sin(angle);
    const intensity = 0.15 + 0.85 * phase; // 0.15 .. 1.0

    // The sky rig moves first so the directional shading below can follow the
    // SAME sun the player sees in the dome (no more static sun direction).
    this.sky.update(dt, this.camera.position, angle, phase);
    const sunDir = this._sunScratch.copy(this.sky.sunDirection);
    const sunUp = smoothstep(-0.1, 0.12, sunDir.y);
    // Warm low-sun light at dawn/dusk, white at noon; fades out below horizon.
    const warm = 1 - smoothstep(0.05, 0.45, Math.max(sunDir.y, 0));
    const sunColor = this._colorScratch.copy(this._sunNoon).lerp(this._sunWarm, warm);
    const sunStrength = L.sunStrength * (0.25 + 0.75 * phase) * sunUp;

    for (const mat of this._litMaterials) {
      mat.uniforms.uSkyIntensity.value = intensity;
      mat.uniforms.uSunDir.value.copy(sunDir);
      mat.uniforms.uSunColor.value.copy(sunColor);
      mat.uniforms.uSunStrength.value = sunStrength;
      mat.uniforms.uFogColor.value.copy(this._fogDay).lerp(this._fogNight, 1 - phase);
    }

    // Backdrop color behind the dome (visible only if the dome is hidden).
    this.scene.background.copy(this._dayBg).lerp(this._fogNight, 1 - phase);
  }

  /** True when the injected renderer is a real WebGLRenderer (not a stub). */
  _postfxSupported() {
    return typeof this.webgl.setRenderTarget === 'function';
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
      this._sortTransparentChunks();
      this._updateSky(dt);
      this._postTime += dt;
      // Fog is measured from the camera; keep the shared uniform current.
      for (const mat of this._litMaterials) mat.uniforms.uCamPos.value.copy(this.camera.position);
    }
    if (scene === this.scene && this.postfxEnabled && this._postfxSupported() && this._w > 0 && this._h > 0) {
      if (!this.postfx) this.postfx = new PostFX({ THREE: this.THREE, config: this._postfxCfg });
      const pr = this.webgl.getPixelRatio ? this.webgl.getPixelRatio() : 1;
      this.postfx.setSize((this._bw || this._w) * pr, (this._bh || this._h) * pr, this.webgl);
      this.postfx.render(this.webgl, scene, this.camera, this._postTime);
      return;
    }
    this.webgl.render(scene, this.camera);
  }

  /** Order chunk transparent meshes back-to-front for this frame.
   *  Chunk geometry is baked in world space with every mesh parked at the
   *  origin, so three.js's own transparent sort (by object position) sees all
   *  chunks at the same depth and falls back to insertion order — glass in a
   *  far chunk could blend over nearer glass. Nearer chunks get a higher
   *  renderOrder; every value stays above the default 0 so glass keeps
   *  blending after sprites/particles (see ChunkMesh). */
  _sortTransparentChunks() {
    const cam = this.camera.position;
    const half = (this.chunkSize * CELL_SIZE) / 2;
    for (const mesh of this.chunks.values()) {
      const t = mesh.meshTransparent;
      if (!t || !t.visible) continue;
      const dx = mesh.origin[0] * CELL_SIZE + half - cam.x;
      const dy = mesh.origin[1] * CELL_SIZE + half - cam.y;
      const dz = mesh.origin[2] * CELL_SIZE + half - cam.z;
      t.renderOrder = 1 + 1 / (1 + dx * dx + dy * dy + dz * dz);
    }
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
