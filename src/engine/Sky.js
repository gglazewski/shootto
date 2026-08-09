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

const CLOUD_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uPhase;
  uniform float uSunset;
  uniform vec2 uCam;      // camera world x/z, keeps the noise world-anchored
  uniform vec2 uWind;     // world units per second
  uniform float uScale;
  uniform float uCoverage;
  uniform float uHalfSize;

  varying vec2 vLocal;

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
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += a * noise2(p);
      p = p * 2.03 + vec2(17.3, 9.1);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    // plane is rotated -PI/2 about X: local x -> world x, local y -> -world z
    vec2 world = vec2(vLocal.x + uCam.x, uCam.y - vLocal.y);
    vec2 q = (world + uWind * uTime) / uScale;
    float n = fbm(q) * 0.75 + fbm(q * 3.0 + uWind * uTime * 0.0007) * 0.25;
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
    this.cloudMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPhase: { value: 1 },
        uSunset: { value: 0 },
        uCam: { value: new THREE.Vector2() },
        uWind: { value: new THREE.Vector2(...this.cfg.wind) },
        uScale: { value: this.cfg.cloudScale },
        uCoverage: { value: this.cfg.cloudCoverage },
        uHalfSize: { value: half },
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
  }
}

function smoothstep(a, b, x) {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}
