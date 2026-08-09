// GlassParticles.js — a pooled burst of glass shards for shots through glass.
//
// When a bullet (or swing) crosses a glass pane it doesn't stop — it bursts
// a spray of thin, spinning shards at the pane instead of the generic smoke
// puff. Same pooling scheme as SmokeParticles; shards fall under gravity and
// fade out fast.
//
// Lighting: like smoke, each burst samples the baked LightField at the pane
// so shards glint pale in daylight and go dim in dark hallways.

import { lightColorAt } from './lightColor.js';

const SHARD_COUNT = 14; // shards per burst
const POOL_MAX = 210; // total pooled meshes
const SHARD_LIFE = 0.6;
const GRAVITY = 7.5;

export class GlassParticles {
  /**
   * @param {object} deps
   * @param {object} deps.THREE
   * @param {import('three').Scene} deps.scene
   * @param {object} [deps.lightField]  LightField to shade the shards with
   * @param {import('three').Material} [deps.material]  map-less lit material
   *   whose uniforms drive the shading (Renderer.itemMaterial)
   */
  constructor({ THREE, scene, lightField = null, material = null }) {
    this.THREE = THREE;
    this.scene = scene;
    this.lightField = lightField;
    this.material = material;

    // Thin flakes read as glass better than spheres.
    const geo = new THREE.BoxGeometry(0.035, 0.05, 0.006);
    const mat = new THREE.MeshBasicMaterial({ color: 0xbfe0f2, transparent: true, opacity: 0.9, depthWrite: false });
    this._mesh = []; // { mesh, alive, vel, spin, life, maxLife }
    for (let i = 0; i < POOL_MAX; i++) {
      const mesh = new THREE.Mesh(geo, mat.clone());
      mesh.visible = false;
      scene.add(mesh);
      this._mesh.push({
        mesh, alive: false, vel: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0, maxLife: SHARD_LIFE,
      });
    }
    this._next = 0;
    this._active = 0;
  }

  /**
   * Spray shards at a world position, biased along the shot direction so
   * the pane visibly bursts away from the shooter.
   * @param {[number,number,number]} pos
   * @param {{x:number,y:number,z:number}} [dir]  shot direction (unit-ish)
   */
  burst(pos, dir = { x: 0, y: 0, z: 0 }) {
    const lit = lightColorAt(this.lightField, this.material, pos[0], pos[1], pos[2]);
    for (let i = 0; i < SHARD_COUNT; i++) {
      const p = this._mesh[this._next];
      this._next = (this._next + 1) % POOL_MAX;
      if (p.alive) this._active--;
      p.alive = true;
      p.life = 0;
      p.maxLife = SHARD_LIFE * (0.7 + Math.random() * 0.6);
      p.mesh.visible = true;
      p.mesh.position.set(pos[0], pos[1], pos[2]);
      p.mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      p.mesh.scale.setScalar(0.6 + Math.random() * 0.9);
      p.mesh.material.opacity = 0.9;
      // Pale glass-blue, tinted by the local light.
      p.mesh.material.color.setRGB(lit.r * 0.85, lit.g * 0.95, lit.b);
      p.vel.set(
        (Math.random() - 0.5) * 2.2 + dir.x * 1.6,
        Math.random() * 1.4 + 0.3 + dir.y * 1.6,
        (Math.random() - 0.5) * 2.2 + dir.z * 1.6,
      );
      p.spin.set((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14);
      this._active++;
    }
  }

  /** Advance and expire shards. @param {number} dt seconds */
  update(dt) {
    if (this._active === 0) return;
    for (const p of this._mesh) {
      if (!p.alive) continue;
      p.life += dt;
      const t = Math.min(1, p.life / p.maxLife);
      p.vel.y -= GRAVITY * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.rotation.x += p.spin.x * dt;
      p.mesh.rotation.y += p.spin.y * dt;
      p.mesh.rotation.z += p.spin.z * dt;
      p.mesh.material.opacity = Math.max(0, 0.9 * (1 - t * t));
      if (t >= 1) {
        p.alive = false;
        p.mesh.visible = false;
        this._active--;
      }
    }
  }

  /** Drop all shards (called on world clear/load). */
  clear() {
    for (const p of this._mesh) {
      if (!p.alive) continue;
      p.alive = false;
      p.mesh.visible = false;
    }
    this._active = 0;
  }
}
