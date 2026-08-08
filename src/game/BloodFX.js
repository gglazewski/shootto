// BloodFX.js — blood splatter when a mob is hit.
//
// A pooled burst of small dark-red droplets that spray outward from the hit
// point, fall with gravity and fade in ~0.45 s, plus a few expanding splatter
// puffs (smoke-style spheres, but red) so the hit reads clearly at a glance.
// The splatter origin is nudged toward the camera by GameApp, so it sits in
// FRONT of the mob's billboard — mobs are camera-facing sprites, so blood
// spawned dead-center would be hidden behind the always-facing quad. The
// puffs additionally track the mob while they live, so a mob charging the
// player can't walk in front of (and hide) its own blood.

const DROPS = 14; // droplets per hit
const POOL_MAX = 80; // total pooled meshes
const DROP_LIFE = 0.45;
const SPLATS = 6; // expanding splatter puffs per hit
const SPLAT_POOL_MAX = 60; // total pooled splatter meshes
const SPLAT_LIFE = 0.4;

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
      // Above the mob sprites' renderOrder 1: sprites don't write depth, so
      // with the default order they'd paint over the blood no matter how far
      // in front of the billboard it sits.
      mesh.renderOrder = 2;
      mesh.visible = false;
      scene.add(mesh);
      this._mesh.push({ mesh, alive: false, vel: new THREE.Vector3(), life: 0, maxLife: DROP_LIFE, scale: 1 });
    }
    // Splatter puffs: same idea as SmokeParticles' spheres, tinted blood-red.
    const splatGeo = new THREE.SphereGeometry(0.035, 6, 5);
    this._splat = []; // { mesh, alive, vel, life, maxLife, baseScale }
    for (let i = 0; i < SPLAT_POOL_MAX; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x8a0c0c,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(splatGeo, mat);
      mesh.renderOrder = 2; // above mob sprites, same as the droplets
      mesh.visible = false;
      scene.add(mesh);
      this._splat.push({ mesh, alive: false, vel: new THREE.Vector3(), off: new THREE.Vector3(), rel: new THREE.Vector3(), mob: null, life: 0, maxLife: SPLAT_LIFE, baseScale: 1 });
    }
    this._nextSplat = 0;
    this._next = 0;
    this._active = 0;
  }

  /** Spray a blood burst at `pos`. `dir` is the splatter direction (toward the
   *  viewer): droplets fly mostly that way with a little sideways kick. Pass
   *  the hit `mob` so the splatter puffs stay anchored to its near side while
   *  it moves, instead of being left behind (and hidden) by a charging mob. */
  burst(pos, dir, mob = null) {
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
    for (let i = 0; i < SPLATS; i++) {
      const p = this._splat[this._nextSplat];
      this._nextSplat = (this._nextSplat + 1) % SPLAT_POOL_MAX;
      if (p.alive) this._active--;
      p.alive = true;
      p.life = 0;
      p.maxLife = SPLAT_LIFE * (0.8 + Math.random() * 0.4);
      p.mesh.visible = true;
      p.mob = mob;
      // Anchor at the hit point, remembered as an offset from the mob so the
      // burst rides along with it (see update); `off` is the puff's own
      // jitter + drift on top of that anchor.
      if (mob) p.rel.set(pos.x - mob.pos.x, pos.y - mob.pos.y, pos.z - mob.pos.z);
      p.off.set(
        (Math.random() - 0.5) * 0.12,
        (Math.random() - 0.5) * 0.12,
        (Math.random() - 0.5) * 0.12,
      );
      p.mesh.position.set(pos.x + p.off.x, pos.y + p.off.y, pos.z + p.off.z);
      p.mesh.material.opacity = 0.9;
      p.mesh.scale.setScalar(1);
      p.baseScale = 0.6 + Math.random() * 0.8;
      p.vel.set(
        dir.x * 0.5 + (Math.random() - 0.5) * 0.6,
        (Math.random() - 0.5) * 0.5,
        dir.z * 0.5 + (Math.random() - 0.5) * 0.6,
      );
      this._active++;
    }
  }

  /** Advance and expire droplets + splatter puffs. @param {number} dt seconds */
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
    for (const p of this._splat) {
      if (!p.alive) continue;
      p.life += dt;
      const t = Math.min(1, p.life / p.maxLife);
      if (p.mob) {
        // Ride along with the mob at the remembered hit offset: mobs close in
        // on the player fast enough to leave a world-fixed puff behind, which
        // would detach the blood from the wound it marks.
        p.off.addScaledVector(p.vel, dt);
        p.mesh.position.set(
          p.mob.pos.x + p.rel.x + p.off.x,
          p.mob.pos.y + p.rel.y + p.off.y,
          p.mob.pos.z + p.rel.z + p.off.z,
        );
      } else {
        p.mesh.position.addScaledVector(p.vel, dt);
      }
      p.mesh.scale.setScalar(p.baseScale * (1 + t * 2.2));
      p.mesh.material.opacity = Math.max(0, 0.9 * (1 - t));
      if (t >= 1) {
        p.alive = false;
        p.mob = null;
        p.mesh.visible = false;
        this._active--;
      }
    }
  }

  /** Drop all droplets and splatter puffs (world clear/load). */
  clear() {
    for (const p of this._mesh) {
      if (!p.alive) continue;
      p.alive = false;
      p.mesh.visible = false;
    }
    for (const p of this._splat) {
      p.alive = false;
      p.mob = null;
      p.mesh.visible = false;
    }
    this._active = 0;
  }
}
