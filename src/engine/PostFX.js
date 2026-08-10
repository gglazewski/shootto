// PostFX.js — screen-space post pipeline: bloom + polaroid grade.
//
// Pure three.js core (no examples/jsm imports, so the offline single-file
// build keeps working): the scene renders into an HDR target, a bright pass
// extracts the highlights, two separable Gaussian blurs at quarter resolution
// build a wide, cheap bloom, and a final composite pass adds the bloom back
// and grades the frame like a faded polaroid print — film curve, warm
// highlights / cool shadows, lowered saturation, vignette and grain.
//
// Everything runs at low cost: the scene renders once, all bloom work happens
// at 1/4 resolution, and the grade is a handful of ALU ops per pixel.

import { CONFIG } from '../config.js';

const FULLSCREEN_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const BRIGHT_FRAG = /* glsl */ `
  uniform sampler2D tInput;
  uniform float uThreshold;
  uniform float uKnee;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tInput, vUv).rgb;
    float m = max(max(c.r, c.g), c.b);
    float k = smoothstep(uThreshold, uThreshold + uKnee, m);
    gl_FragColor = vec4(c * k, 1.0);
  }
`;

// 9-tap Gaussian via 5 linear-sample taps. uDir is one texel step (times a
// radius scale), so the same material does horizontal and vertical passes.
const BLUR_FRAG = /* glsl */ `
  uniform sampler2D tInput;
  uniform vec2 uDir;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tInput, vUv).rgb * 0.227027;
    c += (texture2D(tInput, vUv + uDir * 1.3846154).rgb
        + texture2D(tInput, vUv - uDir * 1.3846154).rgb) * 0.3162162;
    c += (texture2D(tInput, vUv + uDir * 3.2307692).rgb
        + texture2D(tInput, vUv - uDir * 3.2307692).rgb) * 0.0702703;
    gl_FragColor = vec4(c, 1.0);
  }
`;

const COMPOSITE_FRAG = /* glsl */ `
  uniform sampler2D tScene;
  uniform sampler2D tBloom;
  uniform float uBloomIntensity;
  uniform float uExposure;
  uniform float uSaturation;
  uniform float uFade;
  uniform float uVignette;
  uniform float uGrain;
  uniform float uAberration;
  uniform float uTime;
  varying vec2 vUv;

  float hash21(vec2 p) {
    p = fract(p * vec2(234.34, 435.345));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
  }

  void main() {
    vec2 uv = vUv;
    vec2 cc = uv - 0.5;

    // Subtle radial chromatic aberration — the cheap lens feel.
    vec2 off = cc * uAberration;
    vec3 col;
    col.r = texture2D(tScene, uv + off).r;
    col.g = texture2D(tScene, uv).g;
    col.b = texture2D(tScene, uv - off).b;

    // Bloom: lights, the sun and emissive blocks bleed into the frame.
    col += texture2D(tBloom, uv).rgb * uBloomIntensity;
    col *= uExposure;

    float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));

    // Film curve: soft shoulder rolls off highlights, gentle gamma lift.
    col = col / (1.0 + col * 0.25);
    col = pow(max(col, vec3(0.0)), vec3(0.92));

    // Split tone: cool shadows, warm highlights (aged print chemistry).
    col *= mix(vec3(0.92, 0.97, 1.06), vec3(1.07, 1.01, 0.90), smoothstep(0.0, 1.0, luma));

    // Desaturate toward print ink.
    float l2 = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(vec3(l2), col, uSaturation);

    // Fade: lift the blacks toward paper cream, soften the contrast.
    col = mix(col, col * 0.82 + vec3(0.055, 0.052, 0.045), uFade);

    // Vignette, strongest in the frame corners like a lens shadow.
    col *= 1.0 - uVignette * smoothstep(0.32, 0.85, length(cc));

    // Animated film grain, most visible in the shadows.
    float g = hash21(gl_FragCoord.xy + vec2(fract(uTime * 13.7) * 61.0, fract(uTime * 7.3) * 47.0)) - 0.5;
    col += g * uGrain * (1.2 - min(l2, 1.0));

    gl_FragColor = vec4(col, 1.0);
  }
`;

export class PostFX {
  /**
   * @param {object} deps
   * @param {object} deps.THREE
   * @param {object} [deps.config]  overrides merged over CONFIG.postfx
   */
  constructor({ THREE, config = {} }) {
    this.THREE = THREE;
    this.cfg = {
      bloom: { ...CONFIG.postfx.bloom, ...(config.bloom ?? {}) },
      polaroid: { ...CONFIG.postfx.polaroid, ...(config.polaroid ?? {}) },
    };
    // MSAA sample count of the scene target (WebGL2 only). 0 disables.
    this.msaa = config.msaa ?? CONFIG.postfx.msaa ?? 4;

    this._quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._quadScene = new THREE.Scene();
    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this._quad.frustumCulled = false;
    this._quadScene.add(this._quad);

    this._brightMat = new THREE.ShaderMaterial({
      uniforms: {
        tInput: { value: null },
        uThreshold: { value: this.cfg.bloom.threshold },
        uKnee: { value: this.cfg.bloom.knee },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: BRIGHT_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this._blurMat = new THREE.ShaderMaterial({
      uniforms: {
        tInput: { value: null },
        uDir: { value: new THREE.Vector2() },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: BLUR_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    const p = this.cfg.polaroid;
    this._compositeMat = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null },
        tBloom: { value: null },
        uBloomIntensity: { value: this.cfg.bloom.intensity },
        uExposure: { value: p.exposure },
        uSaturation: { value: p.saturation },
        uFade: { value: p.fade },
        uVignette: { value: p.vignette },
        uGrain: { value: p.grain },
        uAberration: { value: p.aberration },
        uTime: { value: 0 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this._rtScene = null;
    this._rtA = null;
    this._rtB = null;
    this._w = 0;
    this._h = 0;
  }

  /** (Re)allocate the render targets for a new drawing-buffer size. */
  setSize(w, h, webgl) {
    w = Math.max(1, Math.floor(w));
    h = Math.max(1, Math.floor(h));
    if (w === this._w && h === this._h && this._rtScene) return;
    this.disposeTargets();
    const T = this.THREE;
    const webgl2 = !!webgl.capabilities?.isWebGL2;
    const type = webgl2 ? T.HalfFloatType : T.UnsignedByteType;
    this._rtScene = new T.WebGLRenderTarget(w, h, {
      type,
      // MSAA on the scene target replaces the canvas's built-in antialiasing
      // (render targets don't get it for free).
      samples: webgl2 ? this.msaa : 0,
    });
    const bw = Math.max(1, w >> 2), bh = Math.max(1, h >> 2);
    this._rtA = new T.WebGLRenderTarget(bw, bh, { type, depthBuffer: false });
    this._rtB = new T.WebGLRenderTarget(bw, bh, { type, depthBuffer: false });
    this._w = w;
    this._h = h;
  }

  /**
   * Render one framed: scene -> HDR target, bright+blur -> bloom, composite
   * to the canvas. `time` drives the grain animation.
   */
  render(webgl, scene, camera, time) {
    if (!this._rtScene) this.setSize(this._w || 1, this._h || 1, webgl);

    webgl.setRenderTarget(this._rtScene);
    webgl.render(scene, camera);

    const bw = this._rtA.width, bh = this._rtA.height;

    this._brightMat.uniforms.tInput.value = this._rtScene.texture;
    this._draw(webgl, this._brightMat, this._rtA);

    // Two blur iterations, the second at double radius -> wide soft bloom.
    this._blur(webgl, this._rtA, this._rtB, bw, bh, 1, 0);
    this._blur(webgl, this._rtB, this._rtA, bw, bh, 0, 1);
    this._blur(webgl, this._rtA, this._rtB, bw, bh, 2, 0);
    this._blur(webgl, this._rtB, this._rtA, bw, bh, 0, 2);

    const cu = this._compositeMat.uniforms;
    cu.tScene.value = this._rtScene.texture;
    cu.tBloom.value = this._rtA.texture;
    cu.uTime.value = time;
    this._draw(webgl, this._compositeMat, null);
  }

  _blur(webgl, src, dst, bw, bh, dx, dy) {
    this._blurMat.uniforms.tInput.value = src.texture;
    this._blurMat.uniforms.uDir.value.set(dx / bw, dy / bh);
    this._draw(webgl, this._blurMat, dst);
  }

  _draw(webgl, material, target) {
    this._quad.material = material;
    webgl.setRenderTarget(target);
    webgl.render(this._quadScene, this._quadCam);
  }

  disposeTargets() {
    this._rtScene?.dispose();
    this._rtA?.dispose();
    this._rtB?.dispose();
    this._rtScene = this._rtA = this._rtB = null;
  }

  dispose() {
    this.disposeTargets();
    this._quad.geometry.dispose();
    this._brightMat.dispose();
    this._blurMat.dispose();
    this._compositeMat.dispose();
  }
}
