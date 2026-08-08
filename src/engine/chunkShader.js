// chunkShader.js — custom ShaderMaterial for voxel chunk meshes.
//
// Lighting is precomputed on the CPU into a per-vertex `light` attribute
// (sky / block channels from LightField, 0..1), so the shader stays cheap:
// a few ALU ops per fragment. The old per-scene DirectionalLight/AmbientLight
// have no effect on this material; the directional sun term here is driven by
// the vertex normal and is gated on sky exposure, so a sealed basement gets no
// sun gradient while an open field does.
//
// A dynamic muzzle-flash light (uFlashPos / uFlashIntensity / uFlashColor /
// uFlashRange) is added on top of the baked field. It's a soft point light in
// world space, so firing a gun briefly lights the chunks, placed items and the
// player's own hands/weapon near the barrel without touching the light field.

import { CONFIG } from '../config.js';

/**
 * @param {import('three')} THREE
 * @param {object} deps
 * @param {import('three').Texture} [deps.map]  atlas texture. When omitted the
 *   material is untextured (samples tex = 1), so vertex `color` alone drives
 *   the surface — used to light placeable object meshes with the same engine.
 * @param {object} [deps.config]  overrides merged over CONFIG.lighting
 * @param {boolean} [deps.transparent]  transparent (alpha-blended) variant
 */
export function createChunkMaterial(THREE, { map, config = {}, transparent = false }) {
  const L = { ...CONFIG.lighting, ...config };
  const hasMap = !!map;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      ...(hasMap ? { map: { value: map } } : {}),
      uSunDir: { value: new THREE.Vector3(...L.sunDirection).normalize() },
      uSunColor: { value: new THREE.Color(...L.sunColor) },
      uSkyTint: { value: new THREE.Color(...L.skyTint) },
      uBlockTint: { value: new THREE.Color(...L.blockTint) },
      uSkyIntensity: { value: L.skyIntensity },
      uAmbientMin: { value: L.ambientMin },
      uLightScale: { value: L.lightScale },
      uSunStrength: { value: L.sunStrength },
      uFlashPos: { value: new THREE.Vector3() },
      uFlashColor: { value: new THREE.Color(1.0, 0.72, 0.38) },
      uFlashIntensity: { value: 0 },
      uFlashRange: { value: 6 },
    },
    transparent,
    depthWrite: !transparent,
    side: transparent ? THREE.DoubleSide : THREE.FrontSide,
    vertexShader: `
      attribute vec3 color;
      attribute vec2 light;
      uniform vec3 uSunDir;
      varying vec2 vUv;
      varying vec3 vColor;
      varying vec2 vLight;
      varying float vSun;
      varying vec3 vWorldPos;

      void main() {
        vUv = uv;
        vColor = color;
        vLight = light;
        vSun = max(0.0, dot(normalize(normal), normalize(uSunDir)));
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPos = worldPos.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: `
      ${hasMap ? 'uniform sampler2D map;' : ''}
      uniform vec3 uSunColor;
      uniform vec3 uSkyTint;
      uniform vec3 uBlockTint;
      uniform float uSkyIntensity;
      uniform float uAmbientMin;
      uniform float uLightScale;
      uniform float uSunStrength;
      uniform vec3 uFlashPos;
      uniform vec3 uFlashColor;
      uniform float uFlashIntensity;
      uniform float uFlashRange;
      ${hasMap ? 'varying vec2 vUv;' : ''}
      varying vec3 vColor;
      varying vec2 vLight;
      varying float vSun;
      varying vec3 vWorldPos;

      void main() {
        ${hasMap ? 'vec4 tex = texture2D(map, vUv);' : 'vec4 tex = vec4(1.0);'}
        // Opaque pass: cutout shapes (chain-link, bars, boards) live here so
        // they write depth and sort correctly — discard their holes. Cube
        // tiles are fully opaque, so they never hit the discard.
        ${hasMap && !transparent ? 'if (tex.a < 0.5) discard;' : ''}
        // Transparent pass: drop fully clear texels so they neither tint nor
        // haze what's behind; glass (alpha ~0.35) stays above the threshold.
        ${hasMap && transparent ? 'if (tex.a < 0.05) discard;' : ''}
        float sky = vLight.x * uSkyIntensity;
        float block = vLight.y;
        float base = max(sky, block);
        // Cool sky bounce in daylight, warm glow near artificial light.
        vec3 tint = mix(uSkyTint, uBlockTint, block / max(base, 0.0001));
        vec3 lit = tex.rgb * vColor * (uAmbientMin + tint * base * uLightScale);
        // Directional sun shading only where the surface is sky-exposed.
        lit += uSunColor * tex.rgb * vColor * vSun * sky * uSunStrength;
        // Dynamic muzzle flash: soft warm point light fading with distance.
        float dist = length(vWorldPos - uFlashPos);
        float flash = uFlashIntensity * pow(max(0.0, 1.0 - dist / uFlashRange), 2.0);
        lit += uFlashColor * tex.rgb * vColor * flash;
        gl_FragColor = vec4(lit, tex.a);
      }
    `,
  });

  return material;
}
