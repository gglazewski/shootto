// BloodFX.js — blood splatter when a mob is hit.
//
// A pooled burst of small dark-red droplets that spray outward from the hit
// point, fall with gravity and fade in ~0.45 s. The splatter origin is nudged
// toward the camera by GameApp, so it sits in FRONT of the mob's billboard —
// mobs are camera-facing sprites, so blood spawned dead-center would be hidden
// behind the always-facing quad.

const DROPS = 14; // droplets per hit
const POOL_MAX = 80; // total pooled meshes
const DROP_LIFE = 0.45;

export class BloodFX {
  /**
   * @param {object} deps
   * @param {object} deps.THREE
   * @param {import('three').Scene} deps.scene
   */
  constructor({ THREE, scene }) {
    this.THREE = THREE;
    this.scene = scene;

    const geo = new THREE.OctahedronGeometry(0.02);
    this._mesh = []; // { mesh, alive, vel, life, maxLife, scale }
    for (let i = 0; i < POOL_MAX; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x9a0e0e,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      scene.add(mesh);
      this._mesh.push({ mesh, alive: false, vel: new THREE.Vector3(), life: 0, maxLife: DROP_LIFE, scale: 1 });
    }
    this._next = 0;
    this._active = 0;
  }

  /** Spray a blood burst at `pos`. `dir` is the splatter direction (toward the
   *  viewer): droplets fly mostly that way with a little sideways kick. */
  burst(pos, dir) {
    const T = this.THREE;
    for (let i = 0; i < DROPS; i++) {
      const p = this._mesh[this._next];
      this._next = (this._next + 1) % POOL_MAX;
      if (p.alive) this._active--;
      p.alive = true;
      p.life = 0;
      p.maxLife = DROP_LIFE * (0.6 + Math.random() * 0.7);
      p.mesh.visible = true;
      p.mesh.position.copy(pos);
      p.vel.set(
        (dir.x + (Math.random() - 0.5) * 0.8) * (0.8 + Math.random() * 1.4),
        0.8 + Math.random() * 1.2,
        (dir.z + (Math.random() - 0.5) * 0.8) * (0.8 + Math.random() * 1.4),
      );
      p.mesh.material.opacity = 0.9;
      p.scale = 0.6 + Math.random() * 0.9;
      p.mesh.scale.setScalar(p.scale);
      this._active++;
    }
  }

  /** Advance and expire droplets. @param {number} dt seconds */
  update(dt) {
    if (this._active === 0) return;
    for (const p of this._mesh) {
      if (!p.alive) continue;
      p.life += dt;
      const t = Math.min(1, p.life / p.maxLife);
      p.mesh.position.addScaledVector(p.vel, dt);
      p.vel.y -= 9 * dt; // gravity drags the droplets down
      p.mesh.material.opacity = Math.max(0, 0.9 * (1 - t));
      p.mesh.scale.setScalar(p.scale * (1 - t * 0.6));
      if (t >= 1) {
        p.alive = false;
        p.mesh.visible = false;
        this._active--;
      }
    }
  }

  /** Drop all droplets (world clear/load). */
  clear() {
    for (const p of this._mesh) {
      if (!p.alive) continue;
      p.alive = false;
      p.mesh.visible = false;
    }
    this._active = 0;
  }
}
