// mobSprites.js — procedural Doom-style pixel art blob mob sprite sheets with crisp black outlines.
//
// Draws pixel art blobs onto horizontal frame strips, upscaled with nearest-neighbor scaling
// so pixels stay sharp and crisp. Fits modular game architectures and works offline without binary image assets.
//
// Animation strip frames:
//   idle[0,1]  walk[0..3]  attack[0,1]  hurt[0]  dead[0]

import { getMob } from '../engine/mobTypes.js';

/** Scale multiplier (logical pixel to output canvas pixel) */
const SCALE = 3;

/** Layout of the sheet: animation state -> indices into the strip */
export const FRAMES = Object.freeze({
  idle: [0, 1],
  walk: [2, 3, 4, 5],
  attack: [6, 7],
  hurt: [8],
  dead: [9],
});
export const FRAME_COUNT = 10;

/** Per-type sheet dimensions (logical px) + color palettes & procedural types */
const SHEETS = {
  imp: {
    w: 22,
    h: 24,
    type: 'magma',
    pal: {
      outline: '#000000',
      body: '#e64a19',
      shade: '#8e24aa',
      highlight: '#ffb74d',
      eye: '#ffff00',
      eyePupil: '#d50000',
      mouth: '#200000',
      decor: '#ff6d00',
    },
  },
  brute: {
    w: 30,
    h: 30,
    type: 'toxic',
    pal: {
      outline: '#000000',
      body: '#2e7d32',
      shade: '#1b4332',
      highlight: '#a7f3d0',
      eye: '#ff1744',
      eyePupil: '#300000',
      mouth: '#081c15',
      decor: '#76ff03',
    },
  },
  slime: {
    w: 20,
    h: 20,
    type: 'slime',
    pal: {
      outline: '#000000',
      body: '#0284c7',
      shade: '#0369a1',
      highlight: '#bae6fd',
      eye: '#ffffff',
      eyePupil: '#0284c7',
      mouth: '#032b42',
      decor: '#38bdf8',
    },
  },
  void: {
    w: 24,
    h: 26,
    type: 'void',
    pal: {
      outline: '#000000',
      body: '#6b21a8',
      shade: '#3b0764',
      highlight: '#f0abfc',
      eye: '#22d3ee',
      eyePupil: '#f43f5e',
      mouth: '#12001c',
      decor: '#c084fc',
    },
  },
};

/**
 * Procedurally draws a pixel art blob into a logical frame grid buffer.
 * Uses integer matrix tracking to apply crisp 8-directional black outlines around body and features.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} W Logical frame width
 * @param {number} H Logical frame height
 * @param {object} pal Color palette
 * @param {object} options Pose, animation frame index, and mob archetype
 */
function drawPixelBlob(ctx, W, H, pal, options) {
  const { pose, frameIdx, mobType } = options;

  const cx = Math.floor(W / 2);
  const groundY = H - 2;

  // Grid buffer: 0 = empty, 1 = body interior, 2 = feature (horn, bubble, tendril)
  const grid = Array.from({ length: H }, () => Array(W).fill(0));

  // Morph deformers
  let scaleX = 1.0;
  let scaleY = 1.0;
  let offsetY = 0;
  let offsetX = 0;
  let lunge = 0;
  let eyeState = 'normal';
  let mouthState = 'none';

  if (pose === 'idle') {
    if (frameIdx === 1) {
      scaleX = 1.08;
      scaleY = 0.92;
      offsetY = 1;
    }
  } else if (pose === 'walk') {
    const cycle = frameIdx % 4;
    if (cycle === 0) {
      scaleX = 0.92;
      scaleY = 1.08;
      offsetY = -1;
    } else if (cycle === 1) {
      scaleX = 1.15;
      scaleY = 0.85;
      offsetY = 1;
      offsetX = 1;
    } else if (cycle === 2) {
      scaleX = 0.95;
      scaleY = 1.05;
    } else if (cycle === 3) {
      scaleX = 1.15;
      scaleY = 0.85;
      offsetY = 1;
      offsetX = -1;
    }
  } else if (pose === 'attack') {
    if (frameIdx === 0) {
      scaleX = 0.82;
      scaleY = 1.2;
      offsetY = -2;
      eyeState = 'squint';
      mouthState = 'snarl';
    } else {
      scaleX = 1.35;
      scaleY = 0.75;
      offsetY = 1;
      lunge = 3;
      eyeState = 'openWide';
      mouthState = 'openWide';
    }
  } else if (pose === 'hurt') {
    scaleX = 1.25;
    scaleY = 0.7;
    offsetY = 2;
    offsetX = -2;
    eyeState = 'hurt';
    mouthState = 'snarl';
  } else if (pose === 'dead') {
    scaleX = 1.6;
    scaleY = 0.35;
    offsetY = 4;
    eyeState = 'dead';
    mouthState = 'splat';
  }

  const rx = Math.floor((W * 0.38) * scaleX);
  const ry = Math.floor((H * 0.38) * scaleY);
  const blobCenterY = groundY - ry + offsetY;
  const blobCenterX = cx + offsetX + lunge;

  // 1. Draw subtle ground shadow beneath blob
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.beginPath();
  ctx.ellipse(blobCenterX, groundY + 0.5, Math.max(2, rx + 1), Math.max(1, Math.floor(ry * 0.25)), 0, 0, Math.PI * 2);
  ctx.fill();

  // 2. Generate organic blob mass into grid matrix with noise wobble
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x - blobCenterX) / rx;
      const dy = (y - blobCenterY) / ry;
      const angle = Math.atan2(dy, dx);
      const noise = Math.sin(angle * 4 + frameIdx) * 0.08 + Math.cos(angle * 3) * 0.05;

      if (dx * dx + dy * dy + noise <= 1.0) {
        grid[y][x] = 1;
      }
    }
  }

  // 3. Attach base contact feet / slime pseudopods
  if (pose !== 'dead') {
    const footY = groundY - 1;
    const footW = Math.floor(rx * 0.7);
    for (let x = blobCenterX - footW; x <= blobCenterX + footW; x++) {
      if (x >= 0 && x < W && footY >= 0 && footY < H) {
        grid[footY][x] = 1;
      }
    }
  }

  // 4. Attach archetype features (horns, bubbles, tendrils)
  if (mobType === 'magma' && pose !== 'dead') {
    const hornY = blobCenterY - ry + 1;
    const hL = blobCenterX - 3;
    const hR = blobCenterX + 2;
    if (hL >= 0 && hL < W && hornY - 2 >= 0) grid[hornY - 2][hL] = 2;
    if (hL >= 0 && hL < W && hornY - 1 >= 0) grid[hornY - 1][hL] = 2;
    if (hR >= 0 && hR < W && hornY - 2 >= 0) grid[hornY - 2][hR] = 2;
    if (hR >= 0 && hR < W && hornY - 1 >= 0) grid[hornY - 1][hR] = 2;
  } else if (mobType === 'toxic' && pose !== 'dead') {
    const bubX = blobCenterX + Math.floor(rx * 0.3);
    const bubY = blobCenterY - Math.floor(ry * 0.2);
    if (bubX >= 0 && bubX < W && bubY >= 0 && bubY < H) grid[bubY][bubX] = 2;
    if (bubX + 1 >= 0 && bubX + 1 < W && bubY + 1 >= 0 && bubY + 1 < H) grid[bubY + 1][bubX + 1] = 2;
  } else if (mobType === 'void' && pose !== 'dead') {
    const tendrilY = blobCenterY - ry - (frameIdx % 2);
    const t1 = blobCenterX - rx + 1;
    const t2 = blobCenterX + rx - 1;
    if (t1 >= 0 && t1 < W && tendrilY >= 0 && tendrilY < H) grid[tendrilY][t1] = 2;
    if (t2 >= 0 && t2 < W && tendrilY - 1 >= 0 && tendrilY - 1 < H) grid[tendrilY - 1][t2] = 2;
  }

  const rect = (px, py, col) => {
    ctx.fillStyle = col;
    ctx.fillRect(px, py, 1, 1);
  };

  // 5. Render Outer Black Outline First (Full 8-directional edge detection)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (grid[y][x] > 0) {
        let isEdge = false;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const ny = y + dy;
            const nx = x + dx;
            if (nx < 0 || nx >= W || ny < 0 || ny >= H || grid[ny][nx] === 0) {
              isEdge = true;
              break;
            }
          }
          if (isEdge) break;
        }

        if (isEdge) {
          rect(x, y, pal.outline ?? '#000000');
        }
      }
    }
  }

  // 6. Fill interior body with depth shading and highlights
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const val = grid[y][x];
      if (val > 0) {
        const isBorder = (
          x === 0 || grid[y][x - 1] === 0 ||
          x === W - 1 || grid[y][x + 1] === 0 ||
          y === 0 || grid[y - 1][x] === 0 ||
          y === H - 1 || grid[y + 1][x] === 0
        );

        if (!isBorder) {
          if (val === 2) {
            rect(x, y, pal.decor);
          } else {
            const relX = (x - (blobCenterX - rx)) / (rx * 2);
            const relY = (y - (blobCenterY - ry)) / (ry * 2);

            if (relY > 0.55 || relX > 0.65) {
              rect(x, y, pal.shade); // Bottom-right shadow
            } else if (relY < 0.35 && relX < 0.45) {
              rect(x, y, pal.highlight); // Top-left specular highlight
            } else {
              rect(x, y, pal.body);
            }
          }
        }
      }
    }
  }

  // 7. Render expressive pixel eyes with black border rings
  const eyeY = blobCenterY - Math.floor(ry * 0.15);
  const isCyclops = (mobType === 'void' || mobType === 'slime');

  const drawEyePixel = (ex, ey, eyeCol, pupilCol) => {
    // Black border ring
    rect(ex - 1, ey, '#000000');
    rect(ex + 2, ey, '#000000');
    rect(ex, ey - 1, '#000000');
    rect(ex + 1, ey - 1, '#000000');
    rect(ex, ey + 1, '#000000');
    rect(ex + 1, ey + 1, '#000000');
    // Iris / Pupil fill
    rect(ex, ey, eyeCol);
    rect(ex + 1, ey, pupilCol ?? eyeCol);
  };

  if (eyeState === 'dead') {
    // Dead 'X X' Eyes
    const ex1 = blobCenterX - 3;
    rect(ex1 - 1, eyeY - 1, '#000000');
    rect(ex1, eyeY, pal.eyePupil); rect(ex1 + 2, eyeY + 2, pal.eyePupil);
    rect(ex1 + 2, eyeY, pal.eyePupil); rect(ex1, eyeY + 2, pal.eyePupil);

    const ex2 = blobCenterX + 1;
    rect(ex2, eyeY, pal.eyePupil); rect(ex2 + 2, eyeY + 2, pal.eyePupil);
    rect(ex2 + 2, eyeY, pal.eyePupil); rect(ex2, eyeY + 2, pal.eyePupil);
  } else if (eyeState === 'hurt') {
    // Hurt '> <' Eyes
    rect(blobCenterX - 3, eyeY + 1, pal.eyePupil);
    rect(blobCenterX - 2, eyeY, pal.eyePupil);
    rect(blobCenterX - 2, eyeY + 2, pal.eyePupil);

    rect(blobCenterX + 3, eyeY + 1, pal.eyePupil);
    rect(blobCenterX + 2, eyeY, pal.eyePupil);
    rect(blobCenterX + 2, eyeY + 2, pal.eyePupil);
  } else {
    if (isCyclops) {
      const ex = blobCenterX - 1;
      rect(ex - 2, eyeY - 1, '#000000'); rect(ex - 1, eyeY - 1, '#000000'); rect(ex, eyeY - 1, '#000000'); rect(ex + 1, eyeY - 1, '#000000'); rect(ex + 2, eyeY - 1, '#000000');
      rect(ex - 2, eyeY + 2, '#000000'); rect(ex - 1, eyeY + 2, '#000000'); rect(ex, eyeY + 2, '#000000'); rect(ex + 1, eyeY + 2, '#000000'); rect(ex + 2, eyeY + 2, '#000000');
      rect(ex - 2, eyeY, '#000000'); rect(ex + 2, eyeY, '#000000');
      rect(ex - 2, eyeY + 1, '#000000'); rect(ex + 2, eyeY + 1, '#000000');

      rect(ex - 1, eyeY, pal.eye); rect(ex, eyeY, pal.eye); rect(ex + 1, eyeY, pal.eye);
      rect(ex - 1, eyeY + 1, pal.eye); rect(ex, eyeY + 1, pal.eyePupil); rect(ex + 1, eyeY + 1, pal.eye);
    } else {
      const e1x = blobCenterX - Math.floor(rx * 0.4) - 1;
      const e2x = blobCenterX + Math.floor(rx * 0.4) - 1;
      drawEyePixel(e1x, eyeY, pal.eye, pal.eyePupil);
      drawEyePixel(e2x, eyeY, pal.eye, pal.eyePupil);
    }
  }

  // 8. Render mouth and attack splatters
  if (mouthState === 'openWide') {
    const my = eyeY + 3;
    rect(blobCenterX - 3, my, '#000000');
    rect(blobCenterX + 2, my, '#000000');
    rect(blobCenterX - 2, my - 1, '#000000');
    rect(blobCenterX + 1, my - 1, '#000000');

    rect(blobCenterX - 2, my, pal.mouth);
    rect(blobCenterX - 1, my, pal.mouth);
    rect(blobCenterX, my, pal.mouth);
    rect(blobCenterX + 1, my, pal.mouth);

    // Fangs
    rect(blobCenterX - 1, my, '#ffffff');
    rect(blobCenterX + 1, my, '#ffffff');
  } else if (mouthState === 'snarl') {
    const my = eyeY + 3;
    rect(blobCenterX - 2, my, '#000000');
    rect(blobCenterX + 2, my, '#000000');
    rect(blobCenterX - 1, my, pal.mouth);
    rect(blobCenterX, my, pal.mouth);
    rect(blobCenterX + 1, my, pal.mouth);
  }

  // Airborne splatter particles during attack frame 1
  if (pose === 'attack' && frameIdx === 1) {
    const px = blobCenterX + rx + 3;
    const py = blobCenterY - 1;
    rect(px - 1, py, '#000000'); rect(px + 1, py, '#000000');
    rect(px, py - 1, '#000000'); rect(px, py + 1, '#000000');
    rect(px, py, pal.highlight);

    rect(px + 2, py + 2, '#000000');
    rect(px + 1, py + 2, pal.body);
  }
}

/**
 * Builds the sprite sheet canvas strip for a given mob type ID.
 *
 * @param {string} typeId Mob identifier (e.g., 'imp', 'brute', 'slime', 'void')
 * @returns {{ canvas: HTMLCanvasElement, frameW: number, frameH: number, frames: typeof FRAMES }}
 */
export function buildMobSpriteSheet(typeId) {
  const mobDef = typeof getMob === 'function' ? getMob(typeId) : null;
  const spec = SHEETS[typeId] ?? SHEETS.imp;
  const logW = spec.w;
  const logH = spec.h;

  const canvas = document.createElement('canvas');
  canvas.width = FRAME_COUNT * logW * SCALE;
  canvas.height = logH * SCALE;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const drawFrame = (i, pose, frameIdx) => {
    ctx.save();
    ctx.translate(i * logW * SCALE, 0);
    ctx.scale(SCALE, SCALE);
    ctx.clearRect(0, 0, logW, logH);
    drawPixelBlob(ctx, logW, logH, spec.pal, { pose, frameIdx, mobType: spec.type });
    ctx.restore();
  };

  // Render 10 animation frames across horizontal sheet strip
  drawFrame(FRAMES.idle[0], 'idle', 0);
  drawFrame(FRAMES.idle[1], 'idle', 1);

  FRAMES.walk.forEach((f, idx) => drawFrame(f, 'walk', idx));

  drawFrame(FRAMES.attack[0], 'attack', 0);
  drawFrame(FRAMES.attack[1], 'attack', 1);

  drawFrame(FRAMES.hurt[0], 'hurt', 0);

  drawFrame(FRAMES.dead[0], 'dead', 0);

  return {
    canvas,
    frameW: logW * SCALE,
    frameH: logH * SCALE,
    frames: FRAMES,
  };
}

/** Utility check to verify DOM canvas availability */
export function canDrawSprites() {
  return typeof document !== 'undefined' && typeof document.createElement === 'function';
}
