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
import { CELL_SIZE } from './Space.js';
import { POS_QUANT, UV_QUANT } from './ChunkMeshBuilder.js';

/** Max dynamic flicker-lamp lights the shader evaluates per fragment; the
 *  Renderer keeps the nearest ones when a map has more lit flickering lamps. */
export const MAX_LAMPS = 8;

/**
 * @param {import('three')} THREE
 * @param {object} deps
 * @param {import('three').Texture} [deps.map]  atlas texture. When omitted the
 *   material is untextured (samples tex = 1), so vertex `color` alone drives
 *   the surface — used to light placeable object meshes with the same engine.
 * @param {object} [deps.config]  overrides merged over CONFIG.lighting
 * @param {boolean} [deps.transparent]  transparent (alpha-blended) variant
 * @param {boolean} [deps.packed]  consume the mesher's packed vertex format
 *   (quantized chunk-local positions, shade vec4, tile-local UVs re-tiled in
 *   the shader so greedy-merged quads repeat their tile). Requires `map` and
 *   `atlas`.
 * @param {{width:number,height:number,tileSize?:number}} [deps.atlas]
 */
export function createChunkMaterial(THREE, { map, config = {}, transparent = false, packed = false, atlas = null }) {
  const L = { ...CONFIG.lighting, ...config };
  const hasMap = !!map;
  if (packed && (!hasMap || !atlas)) throw new Error('packed chunk material needs map + atlas');
  const AW = atlas?.width ?? 1;
  const AH = atlas?.height ?? 1;
  const tileSize = atlas?.tileSize ?? 16;

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
      uEmissiveBoost: { value: L.emissiveBoost },
      uFogColor: { value: new THREE.Color(...(L.fogColor ?? [0.7, 0.8, 0.9])) },
      uFogNear: { value: L.fogNear ?? 60 },
      uFogFar: { value: L.fogFar ?? 180 },
      uCamPos: { value: new THREE.Vector3() },
      uFlashPos: { value: new THREE.Vector3() },
      uFlashColor: { value: new THREE.Color(1.0, 0.72, 0.38) },
      uFlashIntensity: { value: 0 },
      uFlashRange: { value: 6 },
      uLamps: { value: Array.from({ length: MAX_LAMPS }, () => new THREE.Vector4()) },
      uLampI: { value: new Float32Array(MAX_LAMPS) },
      uLampCount: { value: 0 },
      uLampGain: { value: L.flickerGain ?? 0.5 },
      ...(packed ? {
        uAtlasGrid: { value: new THREE.Vector2(AW, AH) },
        uTexelPad: { value: new THREE.Vector2(0.5 / (AW * tileSize), 0.5 / (AH * tileSize)) },
        uPosScale: { value: CELL_SIZE / POS_QUANT },
        uUvScale: { value: 1 / UV_QUANT },
      } : {}),
      ...(hasMap ? {} : {
        uNoiseAmp: { value: L.itemNoiseAmp ?? 0.05 },
        uNoiseScale: { value: L.itemNoiseScale ?? 1 },
      }),
    },
    transparent,
    // The transparent pass writes depth too: chunk transparent buffers hold
    // glass panes AND glazed door leaves in one unsorted draw call, so a
    // depth-writing pane rejects mis-ordered translucent geometry behind it
    // (a door blending on top of the glass in front of it) instead of letting
    // it poke through. Costs only some glass-behind-glass tint on mis-order.
    depthWrite: true,
    side: transparent ? THREE.DoubleSide : THREE.FrontSide,
    vertexShader: `
      ${packed ? `
      // Packed chunk vertices (see ChunkMeshBuilder): quantized chunk-local
      // positions, shade = [ao, sky, block, emissive], tile-local UVs plus a
      // packed atlas-rect descriptor decoded here once per vertex.
      attribute vec2 uvLocal;
      attribute float tileInfo;
      attribute vec4 shade;
      uniform vec2 uAtlasGrid;
      uniform float uPosScale;
      uniform float uUvScale;
      varying vec4 vTileRect;` : `
      attribute vec3 color;
      attribute vec2 light;
      attribute float emissive;`}
      uniform vec3 uSunDir;
      varying vec2 vUv;
      varying vec3 vColor;
      varying vec2 vLight;
      varying float vSun;
      varying float vEmissive;
      varying vec3 vWorldPos;
      ${hasMap ? '' : 'varying vec3 vNoisePos;'}

      void main() {
        ${packed ? `
        vUv = uvLocal * uUvScale;
        float ti = tileInfo;
        float th = floor(ti / 65536.0); ti -= th * 65536.0;
        float tw = floor(ti / 4096.0); ti -= tw * 4096.0;
        float row = floor((ti + 0.5) / uAtlasGrid.x);
        float col = ti - row * uAtlasGrid.x;
        // Atlas is flipY: a rect ending in row \`row\` spans v upward from
        // 1-(row+h)/AH (same math as the CPU packer).
        vTileRect = vec4(col / uAtlasGrid.x, 1.0 - (row + th) / uAtlasGrid.y, tw / uAtlasGrid.x, th / uAtlasGrid.y);
        vColor = vec3(shade.x);
        vLight = shade.yz;
        vEmissive = shade.w;
        vec3 pos = position * uPosScale;` : `
        vUv = uv;
        vColor = color;
        vLight = light;
        vEmissive = emissive;
        vec3 pos = position;`}
        // Sample point for the per-micro-cell grain: pulled half a cell into
        // the voxel the face belongs to, in object-local units, so the grain
        // is stable under movement/rotation and unambiguous on cell borders.
        ${hasMap ? '' : 'vNoisePos = pos - normal * 0.5;'}
        vSun = max(0.0, dot(normalize(normal), normalize(uSunDir)));
        vec4 worldPos = modelMatrix * vec4(pos, 1.0);
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
      uniform float uEmissiveBoost;
      uniform vec3 uFogColor;
      uniform float uFogNear;
      uniform float uFogFar;
      uniform vec3 uCamPos;
      uniform vec3 uFlashPos;
      uniform vec3 uFlashColor;
      uniform float uFlashIntensity;
      uniform float uFlashRange;
      uniform vec4 uLamps[${MAX_LAMPS}]; // xyz world pos, w range (m)
      uniform float uLampI[${MAX_LAMPS}]; // 0..1 gutter signal per lamp
      uniform int uLampCount;
      uniform float uLampGain;
      ${hasMap ? 'varying vec2 vUv;' : `varying vec3 vNoisePos;
      uniform float uNoiseAmp;
      uniform float uNoiseScale;`}
      ${packed ? `varying vec4 vTileRect;
      uniform vec2 uTexelPad;` : ''}
      varying vec3 vColor;
      varying vec2 vLight;
      varying float vSun;
      varying float vEmissive;
      varying vec3 vWorldPos;

      void main() {
        ${packed ? `
        // Re-tile: merged greedy quads carry tile-local UVs spanning 0..N —
        // wrap each unit back into the (half-texel inset) atlas rect. Values
        // in [0,1] pass through untouched so single quads sample exactly the
        // rect the CPU packer intended, endpoints included. The clamp guards
        // MSAA extrapolation on sliver triangles.
        vec2 wuv = clamp(vUv - floor(vUv) * step(1.0001, vUv), 0.0, 1.0);
        vec2 tuv = vTileRect.xy + uTexelPad + wuv * (vTileRect.zw - 2.0 * uTexelPad);
        vec4 tex = texture2D(map, tuv);` : hasMap ? 'vec4 tex = texture2D(map, vUv);' : 'vec4 tex = vec4(1.0);'}
        // Opaque pass: cutout shapes (chain-link, bars, boards) live here so
        // they write depth and sort correctly — discard their holes. Cube
        // tiles are fully opaque, so they never hit the discard.
        ${hasMap && !transparent ? 'if (tex.a < 0.5) discard;' : ''}
        // Transparent pass: drop fully clear texels so they neither tint nor
        // haze what's behind; glass (alpha ~0.35) stays above the threshold.
        ${hasMap && transparent ? 'if (tex.a < 0.05) discard;' : ''}
        // MSAA shades edge fragments at the pixel centre, which can fall
        // OUTSIDE a sliver triangle (faces seen at grazing angles). Varyings
        // are then EXTRAPOLATED and can land far past their vertex range;
        // unclamped they explode into blinding white glints on object edges
        // once bloom picks them up, so every interpolated attribute is pulled
        // back to its valid range first.
        vec2 lightIn = clamp(vLight, 0.0, 1.0);
        vec3 vertCol = clamp(vColor, 0.0, 1.0);
        // Untextured objects are flat single-color voxels; a luminance-only
        // jitter hashed per object-local micro-cell gives them the same
        // "texel" grain the atlas tiles bake in. Greedy-merged quads still
        // resolve per-cell because vNoisePos interpolates across the rect.
        // The hash MUST match src/editor/microNoise.js (editor previews) so
        // what you paint is what you place.
        ${hasMap ? '' : `
        vec3 noiseCell = floor(vNoisePos * uNoiseScale);
        float grain = fract(sin(dot(noiseCell, vec3(127.1, 311.7, 74.7))) * 43758.5453);
        vertCol = clamp(vertCol * (1.0 + uNoiseAmp * (grain * 2.0 - 1.0)), 0.0, 1.0);`}
        float sunIn = clamp(vSun, 0.0, 1.0);
        float emissiveIn = clamp(vEmissive, 0.0, 1.0);
        float sky = lightIn.x * uSkyIntensity;
        float block = lightIn.y;
        float base = max(sky, block);
        // Cool sky bounce in daylight, warm glow near artificial light.
        vec3 tint = mix(uSkyTint, uBlockTint, block / max(base, 0.0001));
        vec3 lit = tex.rgb * vertCol * (uAmbientMin + tint * base * uLightScale);
        // Directional sun shading only where the surface is sky-exposed.
        lit += uSunColor * tex.rgb * vertCol * sunIn * sky * uSunStrength;
        // Dynamic flicker lamps: each lit flickering lamp adds its guttering
        // remainder on top of its dimmed baked base — smooth per-frame
        // flicker with zero chunk rebuilds. The baked block channel gates the
        // add: the flood fill already solved occlusion, and the lamp's own
        // baked base guarantees block > 0 anywhere it can legitimately reach,
        // so fragments behind a wall (block ~ 0) get no leak. The bulb factor
        // drags the lamp's emissive faces (and their bloom) through the same
        // gutter.
        float lampAdd = 0.0;
        float bulb = 1.0;
        float lampOcc = smoothstep(0.02, 0.25, block);
        for (int i = 0; i < ${MAX_LAMPS}; i++) {
          if (i >= uLampCount) break;
          vec4 lamp = uLamps[i];
          float ld = distance(vWorldPos, lamp.xyz);
          float att = max(0.0, 1.0 - ld / lamp.w);
          lampAdd += uLampI[i] * att * att * lampOcc;
          bulb = min(bulb, mix(mix(0.3, 1.0, uLampI[i]), 1.0, smoothstep(0.9, 1.4, ld)));
        }
        lit += uBlockTint * tex.rgb * vertCol * lampAdd * uLampGain * uLightScale;
        // Self-emission: lamps/torches stay bright regardless of baked light
        // and push past 1.0 so the bloom pass picks them up.
        lit += tex.rgb * vertCol * emissiveIn * uEmissiveBoost * bulb;
        // Dynamic muzzle flash: soft warm point light fading with distance.
        float dist = length(vWorldPos - uFlashPos);
        float flash = uFlashIntensity * pow(max(0.0, 1.0 - dist / uFlashRange), 2.0);
        lit += uFlashColor * tex.rgb * vertCol * flash;
        // Distance fog blends the world into the sky at the render edge
        // (measured from the camera, not the flash).
        float camDist = length(vWorldPos - uCamPos);
        float fog = smoothstep(uFogNear, uFogFar, camDist);
        lit = mix(lit, uFogColor, fog);
        gl_FragColor = vec4(lit, tex.a);
      }
    `,
  });

  return material;
}
