// MuzzleFX.js — short-lived muzzle particles for ranged weapons.
//
// Two pooled particle types spawned at the barrel when a gun fires:
//   - sparks:  a few tiny additive flecks that burst mostly forward with a
//              little spread, fall with gravity and fade in ~0.25 s,
//   - smoke:   gentle gray puffs that drift forward, expand and fade in ~0.4 s.
//
// Small, world-space and short-lived, so the gun's own movement doesn't matter
// (the flash that must "stick" to the muzzle lives on the held weapon in
// PlayerHand; these are the ambient by-products).

const SPARK_COUNT = 6;
const SMOKE_COUNT = 4;
const SPARK_LIFE = 0.25;
const SMOKE_LIFE = 0.45;

export class MuzzleFX {
  /**
   * @param {object} deps
   * @param {object} deps.THREE
   * @param {import('three').Scene} deps.scene
   */
  constructor({ THREE, scene }) {
    this.THREE = THREE;
    this.scene = scene;

    this._sparks = [];
    const sparkGeo = new THREE.OctahedronGeometry(0.012);
    for (let i = 0; i < SPARK_COUNT; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffcc66,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(sparkGeo, mat);
      mesh.visible = false;
      scene.add(mesh);
      this._sparks.push({ mesh, mat, vel: new THREE.Vector3(), alive: false, life: 0, maxLife: SPARK_LIFE });
    }

    this._smoke = [];
    const smokeGeo = new THREE.SphereGeometry(0.02, 6, 5);
    for (let i = 0; i < SMOKE_COUNT; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xaaaaaa,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(smokeGeo, mat);
      mesh.visible = false;
      scene.add(mesh);
      this._smoke.push({ mesh, mat, vel: new THREE.Vector3(), alive: false, life: 0, maxLife: SMOKE_LIFE, baseScale: 1 });
    }
  }

  /** Spawn sparks + smoke at the muzzle, biased along `dir` (the shot direction). */
  burst(pos, dir) {
    const T = this.THREE;
    for (const s of this._sparks) {
      const v = new T.Vector3(
        dir.x + (Math.random() - 0.5) * 0.9,
        dir.y + (Math.random() - 0.5) * 0.9,
        dir.z + (Math.random() - 0.5) * 0.9,
      ).normalize();
      s.vel.copy(v).multiplyScalar(2.2 + Math.random() * 3.2);
      s.mesh.position.copy(pos);
      s.mesh.scale.setScalar(1);
      s.mat.opacity = 1;
      s.alive = true;
      s.life = 0;
      s.maxLife = SPARK_LIFE * (0.6 + Math.random() * 0.6);
    }
    for (const p of this._smoke) {
      p.vel.set(
        dir.x * (0.4 + Math.random() * 0.5) + (Math.random() - 0.5) * 0.4,
        dir.y * (0.4 + Math.random() * 0.5) + (Math.random() - 0.5) * 0.25,
        dir.z * (0.4 + Math.random() * 0.5) + (Math.random() - 0.5) * 0.4,
      );
      p.mesh.position.set(
        pos.x + (Math.random() - 0.5) * 0.03,
        pos.y + (Math.random() - 0.5) * 0.03,
        pos.z + (Math.random() - 0.5) * 0.03,
      );
      p.mesh.scale.setScalar(1);
      p.mat.opacity = 0.22;
      p.baseScale = 1 + Math.random() * 0.8;
      p.alive = true;
      p.life = 0;
      p.maxLife = SMOKE_LIFE * (0.7 + Math.random() * 0.6);
    }
  }

  /** Advance and expire particles. @param {number} dt seconds */
  update(dt) {
    for (const s of this._sparks) {
      if (!s.alive) continue;
      s.life += dt;
      const t = Math.min(1, s.life / s.maxLife);
      s.mesh.position.addScaledVector(s.vel, dt);
      s.vel.y -= 9 * dt; // gravity pulls the sparks down
      s.mat.opacity = Math.max(0, 1 - t);
      s.mesh.scale.setScalar(1 - t * 0.5);
      if (t >= 1) {
        s.alive = false;
        s.mesh.visible = false;
      }
    }
    for (const p of this._smoke) {
      if (!p.alive) continue;
      p.life += dt;
      const t = Math.min(1, p.life / p.maxLife);
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.scale.setScalar(p.baseScale * (1 + t * 2.6));
      p.mat.opacity = Math.max(0, 0.22 * (1 - t));
      if (t >= 1) {
        p.alive = false;
        p.mesh.visible = false;
      }
    }
  }

  /** Drop all particles. */
  clear() {
    for (const s of this._sparks) {
      s.alive = false;
      s.mesh.visible = false;
    }
    for (const p of this._smoke) {
      p.alive = false;
      p.mesh.visible = false;
    }
  }
}
