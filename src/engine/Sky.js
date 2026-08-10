// Sky.js — procedural sky dome, sun, moon and drifting clouds.
//
// Everything is driven by the Renderer's day/night cycle: the same angle that
// modulates uSkyIntensity positions the sun (and the moon opposite it), tints
// the dome through day/sunset/night, fades stars in after dark and shades the
// cloud layer. The whole rig follows the camera so the sky always reads as
// infinitely far away, while cloud noise is sampled in world space so clouds
// stay put (and drift with the wind) as the player moves.
//
// Render layering: the dome ignores the depth buffer and renders first
// (renderOrder -100), so world geometry always draws over it. Sun, moon and
// clouds are transparent, depth-tested and depth-write-off, so terrain
// occludes them correctly.

const DOME_RADIUS = 1500;

const DOME_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const DOME_FRAG = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uMoonDir;
  uniform float uPhase;   // 0 = midnight .. 1 = midday
  uniform float uTime;
  uniform vec3 uNightHorizon;

  varying vec3 vDir;

  float hash3(vec3 p) {
    return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  }

  void main() {
    vec3 dir = normalize(vDir);
    float h = clamp(dir.y, 0.0, 1.0);

    // vertical gradient, day and night palettes
    vec3 dayZenith = vec3(0.22, 0.51, 0.93);
    vec3 dayHorizon = vec3(0.67, 0.82, 0.95);
    vec3 nightZenith = vec3(0.015, 0.025, 0.07);
    vec3 nightHorizon = uNightHorizon;
    vec3 dayCol = mix(dayHorizon, dayZenith, pow(h, 0.55));
    vec3 nightCol = mix(nightHorizon, nightZenith, pow(h, 0.6));
    vec3 col = mix(nightCol, dayCol, uPhase);

    // warm sunrise/sunset band near the horizon, strongest toward the sun
    float sunH = uSunDir.y;
    float sunset = 1.0 - smoothstep(0.0, 0.45, abs(sunH));
    vec3 sunAzimuth = normalize(vec3(uSunDir.x, 0.0, uSunDir.z));
    float toSun = max(dot(dir, sunAzimuth), 0.0);
    float band = pow(1.0 - h, 3.0) * sunset * (0.25 + 0.75 * pow(toSun, 2.0));
    col = mix(col, vec3(0.98, 0.48, 0.25), band * 0.55);

    // sun glow (tight core + wide haze), only when the sun is up
    float cosSun = max(dot(dir, uSunDir), 0.0);
    float sunUp = smoothstep(-0.15, 0.0, sunH);
    col += vec3(1.0, 0.85, 0.6) * (pow(cosSun, 250.0) * 0.9 + pow(cosSun, 12.0) * 0.18) * sunUp;

    // faint cool halo around the moon at night
    float cosMoon = max(dot(dir, uMoonDir), 0.0);
    col += vec3(0.6, 0.7, 0.9) * pow(cosMoon, 180.0) * 0.35 * (1.0 - uPhase);

    // stars: hashed grid over the upper hemisphere, twinkling, night only
    float night = 1.0 - uPhase;
    vec3 cell = floor(dir * 120.0);
    float sh = hash3(cell);
    float star = step(0.9975, sh);
    vec3 local = fract(dir * 120.0) - 0.5;
    star *= smoothstep(0.32, 0.08, length(local));
    float twinkle = 0.6 + 0.4 * sin(uTime * 2.0 + sh * 40.0);
    col += vec3(0.9) * star * night * twinkle * smoothstep(0.0, 0.15, dir.y);

    gl_FragColor = vec4(col, 1.0);
  }
`;

const SUN_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SUN_FRAG = /* glsl */ `
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float core = smoothstep(1.0, 0.55, d);
    vec3 col = mix(vec3(1.0, 0.75, 0.4), vec3(1.0, 0.98, 0.9), core);
    gl_FragColor = vec4(col, core * uOpacity);
  }
`;

const MOON_FRAG = /* glsl */ `
  uniform float uOpacity;
  varying vec2 vUv;

  float hash2(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float noise2(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash2(i), hash2(i + vec2(1.0, 0.0)), f.x),
      mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), f.x), f.y);
  }

  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float disc = smoothstep(1.0, 0.92, d);
    // mare-like blotches + a soft terminator so it doesn't read as a flat dot
    float n = noise2(vUv * 7.0);
    float shade = 1.0 - 0.28 * smoothstep(0.45, 0.75, n);
    float terminator = 0.82 + 0.18 * smoothstep(0.15, 0.85, vUv.x);
    vec3 col = vec3(0.86, 0.89, 0.97) * shade * terminator;
    gl_FragColor = vec4(col, disc * uOpacity);
  }
`;

const CLOUD_VERT = /* glsl */ `
  varying vec2 vLocal;
  void main() {
    vLocal = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Cloud density comes from a baked tileable FBM texture (see
// buildCloudNoiseData) instead of eight per-pixel noise octaves: the shader
// pays two texture samples per fragment, which is a fraction of the ALU cost
// whenever the sky fills the screen.
const CLOUD_FRAG = /* glsl */ `
  uniform sampler2D uNoise;
  uniform float uTime;
  uniform float uPhase;
  uniform float uSunset;
  uniform vec2 uCam;      // camera world x/z, keeps the noise world-anchored
  uniform vec2 uWind;     // world units per second
  uniform float uTexWorld; // world meters per texture repeat
  uniform float uCoverage;
  uniform float uHalfSize;
  uniform vec2 uDrift;    // slow extra drift of the fine layer (texture uv)

  varying vec2 vLocal;

  void main() {
    // plane is rotated -PI/2 about X: local x -> world x, local y -> -world z
    vec2 world = vec2(vLocal.x + uCam.x, uCam.y - vLocal.y);
    vec2 q = (world + uWind * uTime) / uTexWorld;
    float n = texture2D(uNoise, q).r * 0.75 + texture2D(uNoise, q * 3.0 + uDrift).r * 0.25;
    float density = smoothstep(uCoverage, uCoverage + 0.22, n);

    vec3 dayCol = vec3(1.0);
    vec3 nightCol = vec3(0.10, 0.12, 0.20);
    vec3 col = mix(nightCol, dayCol, uPhase);
    col = mix(col, vec3(1.0, 0.62, 0.42), uSunset * 0.45);
    // slightly darker flat bottoms where the noise is densest
    col *= 1.0 - 0.25 * smoothstep(uCoverage + 0.15, uCoverage + 0.4, n) * uPhase;

    float fade = smoothstep(1.0, 0.55, length(vLocal) / uHalfSize);
    gl_FragColor = vec4(col, density * fade * 0.85);
  }
`;

/** Texture edge in texels and lattice cells of the base octave per repeat.
 *  One texture repeat spans cloudScale * CLOUD_TEX_CELLS world meters; 4
 *  cells per repeat leaves 8 texels per finest-octave cell in both samples
 *  (base and the 3x layer), which resolves the cloud density cleanly. */
export const CLOUD_TEX_SIZE = 256;
export const CLOUD_TEX_CELLS = 4;

const bakeHash = (x, y) => {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
};

/** Tileable value noise on an integer lattice whose indices wrap mod period. */
function tileNoise(px, py, period) {
  const ix = Math.floor(px), iy = Math.floor(py);
  let fx = px - ix, fy = py - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const w = (v) => ((v % period) + period) % period;
  const h00 = bakeHash(w(ix), w(iy));
  const h10 = bakeHash(w(ix + 1), w(iy));
  const h01 = bakeHash(w(ix), w(iy + 1));
  const h11 = bakeHash(w(ix + 1), w(iy + 1));
  const a = h00 + (h10 - h00) * fx;
  const b = h01 + (h11 - h01) * fx;
  return a + (b - a) * fy;
}

/** Bake the cloud FBM into tileable RGBA data (R = density). Same 4-octave
 *  structure as the old shader (0.5/0.25/0.125/0.0625 weights, 17.3/9.1
 *  per-octave offset), but with exact octave doubling so every layer tiles
 *  with the base period. The default size is baked once and cached.
 *  @returns {Uint8Array} size*size*4 */
let _noiseCache = null;
export function buildCloudNoiseData(size = CLOUD_TEX_SIZE, cells = CLOUD_TEX_CELLS) {
  if (_noiseCache && size === CLOUD_TEX_SIZE && cells === CLOUD_TEX_CELLS) return _noiseCache;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      let amp = 0.5;
      for (let o = 0; o < 4; o++) {
        const freq = 1 << o;
        v += amp * tileNoise((x / size) * cells * freq + o * 17.3, (y / size) * cells * freq + o * 9.1, cells * freq);
        amp *= 0.5;
      }
      const c = Math.min(255, Math.round(v * 255));
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = c;
      data[i + 3] = 255;
    }
  }
  if (size === CLOUD_TEX_SIZE && cells === CLOUD_TEX_CELLS) _noiseCache = data;
  return data;
}

export class Sky {
  /**
   * @param {object} deps
   * @param {object} deps.THREE
   * @param {object} [deps.config]  overrides merged over the defaults below
   */
  constructor({ THREE, config = {} }) {
    this.THREE = THREE;
    this.cfg = {
      sunDistance: 1350,
      sunSize: 65,
      moonSize: 48,
      orbitTilt: 0.25, // z-lean of the sun/moon track so it isn't dead overhead
      cloudHeight: 140, // world y of the cloud layer
      cloudHalfSize: 1600,
      cloudScale: 620, // world units per noise tile
      cloudCoverage: 0.52, // higher = fewer clouds
      wind: [5.5, 2.0], // world units/sec drift
      nightHorizon: [0.05, 0.07, 0.15],
      ...config,
    };

    this.group = new THREE.Group();
    this.group.name = 'sky';
    this._time = 0;
    this._sunDir = new THREE.Vector3(0, 1, 0);
    this._moonDir = new THREE.Vector3(0, -1, 0);

    // --- dome ---
    this.domeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uSunDir: { value: this._sunDir },
        uMoonDir: { value: this._moonDir },
        uPhase: { value: 1 },
        uTime: { value: 0 },
        uNightHorizon: { value: new THREE.Vector3(...this.cfg.nightHorizon) },
      },
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 32, 16), this.domeMaterial);
    this.dome.renderOrder = -100;
    this.dome.frustumCulled = false;
    this.group.add(this.dome);

    // --- sun / moon discs (billboarded each frame) ---
    this.sunMaterial = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 1 } },
      vertexShader: SUN_VERT,
      fragmentShader: SUN_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.sun = new THREE.Mesh(new THREE.CircleGeometry(this.cfg.sunSize, 24), this.sunMaterial);
    this.sun.frustumCulled = false;
    this.group.add(this.sun);

    this.moonMaterial = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0 } },
      vertexShader: SUN_VERT,
      fragmentShader: MOON_FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.moon = new THREE.Mesh(new THREE.CircleGeometry(this.cfg.moonSize, 24), this.moonMaterial);
    this.moon.frustumCulled = false;
    this.group.add(this.moon);

    // --- cloud layer ---
    const half = this.cfg.cloudHalfSize;
    const T = this.THREE;
    // Baked tileable FBM — one upload, then two samples per pixel at runtime.
    this.cloudNoise = new T.DataTexture(buildCloudNoiseData(), CLOUD_TEX_SIZE, CLOUD_TEX_SIZE, T.RGBAFormat);
    this.cloudNoise.wrapS = this.cloudNoise.wrapT = T.RepeatWrapping;
    this.cloudNoise.magFilter = T.LinearFilter;
    this.cloudNoise.minFilter = T.LinearFilter;
    this.cloudNoise.generateMipmaps = false;
    this.cloudNoise.needsUpdate = true;
    this.cloudMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uNoise: { value: this.cloudNoise },
        uTime: { value: 0 },
        uPhase: { value: 1 },
        uSunset: { value: 0 },
        uCam: { value: new THREE.Vector2() },
        uWind: { value: new THREE.Vector2(...this.cfg.wind) },
        uTexWorld: { value: this.cfg.cloudScale * CLOUD_TEX_CELLS },
        uCoverage: { value: this.cfg.cloudCoverage },
        uHalfSize: { value: half },
        uDrift: { value: new THREE.Vector2() },
      },
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.clouds = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, half * 2), this.cloudMaterial);
    this.clouds.rotation.x = -Math.PI / 2;
    this.clouds.frustumCulled = false;
    this.group.add(this.clouds);
  }

  /** Current unit vector pointing at the sun (updated each frame). The
   *  Renderer uses it to align the chunk shader's directional sun term with
   *  the sun actually drawn in the dome. */
  get sunDirection() {
    return this._sunDir;
  }

  /**
   * Sync the sky with the day/night cycle. Call once per rendered frame.
   * @param {number} dt      seconds since last frame
   * @param {import('three').Vector3} camPos  camera world position
   * @param {number} angle   cycle angle in radians (PI/2 = midday)
   * @param {number} phase   0 = midnight .. 1 = midday
   */
  update(dt, camPos, angle, phase) {
    this._time += dt;
    this.group.position.copy(camPos);

    // sun rides the cycle angle, moon sits opposite; both on a tilted track
    const tilt = this.cfg.orbitTilt;
    this._sunDir.set(Math.cos(angle), Math.sin(angle), tilt).normalize();
    this._moonDir.set(-Math.cos(angle), -Math.sin(angle), tilt).normalize();

    const d = this.cfg.sunDistance;
    this.sun.position.copy(this._sunDir).multiplyScalar(d);
    this.moon.position.copy(this._moonDir).multiplyScalar(d);
    this.sun.lookAt(camPos);
    this.moon.lookAt(camPos);

    // fade discs out as they dip below the horizon
    const night = 1 - phase;
    this.sunMaterial.uniforms.uOpacity.value = smoothstep(-0.12, 0.02, this._sunDir.y);
    this.moonMaterial.uniforms.uOpacity.value =
      smoothstep(-0.12, 0.02, this._moonDir.y) * (0.35 + 0.65 * night);

    this.domeMaterial.uniforms.uPhase.value = phase;
    this.domeMaterial.uniforms.uTime.value = this._time;

    // clouds: world-anchored noise, fixed world altitude (clamped above camera)
    const sunset = 1 - smoothstep(0, 0.35, Math.abs(this._sunDir.y));
    const cu = this.cloudMaterial.uniforms;
    cu.uTime.value = this._time;
    cu.uPhase.value = phase;
    cu.uSunset.value = sunset;
    cu.uCam.value.set(camPos.x, camPos.z);
    // The fine (3x) layer drifts slightly against the base — the old shader's
    // q*3 + wind*t*0.0007 term, converted from noise units to texture uv
    // (one noise unit spans 1/CLOUD_TEX_CELLS of a texture repeat).
    const uvPerNoiseUnit = 1 / CLOUD_TEX_CELLS;
    cu.uDrift.value.set(
      this.cfg.wind[0] * this._time * 0.0007 * uvPerNoiseUnit,
      this.cfg.wind[1] * this._time * 0.0007 * uvPerNoiseUnit,
    );
    this.clouds.position.y = Math.max(this.cfg.cloudHeight - camPos.y, 60);
  }

  dispose() {
    this.dome.geometry.dispose();
    this.sun.geometry.dispose();
    this.moon.geometry.dispose();
    this.clouds.geometry.dispose();
    this.domeMaterial.dispose();
    this.sunMaterial.dispose();
    this.moonMaterial.dispose();
    this.cloudMaterial.dispose();
    this.cloudNoise.dispose();
  }
}

function smoothstep(a, b, x) {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}
