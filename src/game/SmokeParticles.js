// SmokeParticles.js — a small pool of smoke puffs for hit feedback.
//
// Each attack that connects spawns a burst of tiny spheres at the hit point
// that expand, drift and fade over ~0.5s. Meshes are pooled and reused so
// repeated attacks never leak geometry; the pool is capped and the oldest
// puff is recycled when it overflows.
//
// Lighting: each puff samples the world's baked LightField at its spawn cell
// and tints its (unlit) material with that color, so smoke is dark in caves,
// warm near torchlight and dimmed at night — never a bright blob in darkness.

import { lightColorAt } from './lightColor.js';

const PUFF_COUNT = 12; // particles per hit
const POOL_MAX = 240; // total pooled meshes
const PUFF_LIFE = 0.55;

export class SmokeParticles {
  /**
   * @param {object} deps
   * @param {object} deps.THREE
   * @param {import('three').Scene} deps.scene
   * @param {object} [deps.lightField]  LightField to shade the puffs with
   * @param {import('three').Material} [deps.material]  map-less lit material
   *   whose uniforms drive the shading (Renderer.itemMaterial)
   */
  constructor({ THREE, scene, lightField = null, material = null }) {
    this.THREE = THREE;
    this.scene = scene;
    this.lightField = lightField;
    this.material = material;

    const geo = new THREE.SphereGeometry(0.04, 6, 5);
    const mat = new THREE.MeshBasicMaterial({ color: 0xcccccc, transparent: true, opacity: 0.85, depthWrite: false });
    this._mesh = []; // { mesh, alive, vel, life, maxLife, baseScale }
    for (let i = 0; i < POOL_MAX; i++) {
      const mesh = new THREE.Mesh(geo, mat.clone());
      mesh.visible = false;
      scene.add(mesh);
      this._mesh.push({ mesh, alive: false, vel: new THREE.Vector3(), life: 0, maxLife: PUFF_LIFE, baseScale: 1 });
    }
    this._next = 0;
    this._active = 0;
  }

  /** Spawn a smoke burst at a world position. @param {[number,number,number]} pos */
  puff(pos) {
    const T = this.THREE;
    // Shade by the light at the spawn point (one lookup for the whole burst).
    const lit = lightColorAt(this.lightField, this.material, pos[0], pos[1], pos[2]);
    for (let i = 0; i < PUFF_COUNT; i++) {
      const p = this._mesh[this._next];
      this._next = (this._next + 1) % POOL_MAX;
      if (p.alive) this._active--;
      p.alive = true;
      p.life = 0;
      p.maxLife = PUFF_LIFE * (0.8 + Math.random() * 0.4);
      p.mesh.visible = true;
      p.mesh.position.set(pos[0], pos[1], pos[2]);
      p.mesh.material.opacity = 0.85;
      p.mesh.material.color.setRGB(lit.r, lit.g, lit.b);
      p.mesh.scale.setScalar(1);
      p.baseScale = 0.6 + Math.random() * 0.8;
      p.vel.set(
        (Math.random() - 0.5) * 1.2,
        Math.random() * 0.9 + 0.15, // rise
        (Math.random() - 0.5) * 1.2,
      );
      this._active++;
    }
  }

  /** Advance and expire particles. @param {number} dt seconds */
  update(dt) {
    if (this._active === 0) return;
    for (const p of this._mesh) {
      if (!p.alive) continue;
      p.life += dt;
      const t = Math.min(1, p.life / p.maxLife);
      p.mesh.position.addScaledVector(p.vel, dt);
      const s = p.baseScale * (1 + t * 2.6);
      p.mesh.scale.setScalar(s);
      p.mesh.material.opacity = Math.max(0, 0.85 * (1 - t));
      if (t >= 1) {
        p.alive = false;
        p.mesh.visible = false;
        this._active--;
      }
    }
  }

  /** Drop all particles (called on world clear/load). */
  clear() {
    for (const p of this._mesh) {
      if (!p.alive) continue;
      p.alive = false;
      p.mesh.visible = false;
      this._active = 0;
    }
  }
}
