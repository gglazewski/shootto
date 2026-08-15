// Render a PNG as coarse ANSI-colored ASCII so screenshots can be reviewed
// in the terminal. Usage: node tools/png_ascii.mjs <file.png> [cols]
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const file = process.argv[2];
const cols = Number(process.argv[3] || 120);
const png = PNG.sync.read(readFileSync(file));
const rows = Math.round((cols * png.height) / png.width / 2); // chars ~2:1
const ramp = ' .:-=+*#%@';

function px(x, y) {
  const i = ((y | 0) * png.width + (x | 0)) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
}

let out = '';
for (let r = 0; r < rows; r++) {
  let line = '';
  for (let c = 0; c < cols; c++) {
    // average a block of pixels
    const x0 = (c * png.width) / cols, x1 = ((c + 1) * png.width) / cols;
    const y0 = (r * png.height) / rows, y1 = ((r + 1) * png.height) / rows;
    let R = 0, G = 0, B = 0, n = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      const [r2, g2, b2] = px(x, y);
      R += r2; G += g2; B += b2; n++;
    }
    R /= n; G /= n; B /= n;
    const lum = (0.299 * R + 0.587 * G + 0.114 * B) / 255;
    const ch = ramp[Math.min(ramp.length - 1, Math.floor(lum * ramp.length))];
    // quantize color to 6 levels per channel -> 216 color cube
    const code = 16 + 36 * Math.round(R / 51) + 6 * Math.round(G / 51) + Math.round(B / 51);
    line += `\x1b[38;5;${code}m${ch}`;
  }
  out += line + '\x1b[0m\n';
}
process.stdout.write(out);
