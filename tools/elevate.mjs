// Render orthographic elevations (4 facades) + plan of a bounding box from the
// world. Takes the first opaque voxel along each view ray. Pure, deterministic.
import { readFileSync } from 'node:fs';

const file = process.argv[2] || 'map/voxelbundle.json';
const d = JSON.parse(readFileSync(file, 'utf8'));
const m = d.format === 'voxelbundle' ? d.map : d;
const blocks = m.blocks;

// optional bbox filter: xmin,xmax,ymin,ymax,zmin,zmax
const bbox = process.argv[3] ? process.argv[3].split(',').map(Number) : null;

// index voxels into a set keyed by the small-cells they occupy
const occ = new Map(); // "x,y,z" -> type
function span(b) {
  const s = b.size === 'small' ? 1 : b.size === 'door' ? 1 : 2;
  return s;
}
for (const b of blocks) {
  if (bbox) {
    const [x0, x1, y0, y1, z0, z1] = bbox;
    if (b.x < x0 || b.x > x1 || b.y < y0 || b.y > y1 || b.z < z0 || b.z > z1) continue;
  }
  const s = span(b);
  for (let dx = 0; dx < s; dx++) for (let dy = 0; dy < s; dy++) for (let dz = 0; dz < s; dz++) {
    occ.set(`${b.x + dx},${b.y + dy},${b.z + dz}`, b.type);
  }
}

let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, minZ = 1e9, maxZ = -1e9;
for (const k of occ.keys()) {
  const [x, y, z] = k.split(',').map(Number);
  minX = Math.min(minX, x); maxX = Math.max(maxX, x);
  minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
}
console.log(`# bbox x[${minX},${maxX}] y[${minY},${maxY}] z[${minZ},${maxZ}]  voxcells=${occ.size}`);

const CH = {
  panel: '#', plaster: 'p', plaster_pastel: 'p', plaster_yellow: 'y', plaster_orange: 'o',
  plaster_green: 'g', plaster_blue: 'b', brick: 'B', brick_sooty: 'B', brick_yellow: 'Y',
  window_white: 'W', glass: 'W', sidelight: 'W', door_blok: 'D', door_wood: 'D', door_white: 'D',
  door_shop: 'D', door_steel: 'D', balcony_rail: '=', lastryko: 'l', paving: '.', concrete: 'c',
  asphalt: 'a', grass: ',', dirt: '~', wood: 'w', wood_light: 'w', wood_dark: 'w', planks: 'w',
  papa: 'r', blacha: 'z', metal: 'm', kiosk: 'k', lino: 'L', tile_floor: 't', gravel: 'v',
  lamp: '*', neon: '*', neon_white: '*', fence: 'f', fence_wood: 'f', bars: '|', sand: 's',
  stone: 'S', rubble: 'R', curb: 'C', garage_brown: 'G', garage_green: 'G', garage_red: 'G',
};
const chOf = (t) => CH[t] ?? (t ? '?' : ' ');

function cast(ox, oy, oz, dx, dy, dz, maxSteps) {
  let x = ox, y = oy, z = oz;
  for (let i = 0; i < maxSteps; i++) {
    const t = occ.get(`${x},${y},${z}`);
    if (t) return t;
    x += dx; y += dy; z += dz;
  }
  return null;
}

function render(title, u0, u1, v0, v1, origin, du, dv, dir) {
  console.log(`\n## ${title}`);
  // v = vertical (y), u = horizontal
  for (let v = v1; v >= v0; v--) {
    let row = '';
    for (let u = u0; u <= u1; u++) {
      const [ox, oy, oz] = origin(u, v);
      const t = cast(ox, oy, oz, ...dir, 300);
      row += chOf(t);
    }
    console.log(row.replace(/\s+$/, ''));
  }
}

const X0 = minX, X1 = maxX, Y0 = minY, Y1 = maxY, Z0 = minZ, Z1 = maxZ;

// Facade facing +X (view from +x toward -x): u=z, v=y
render('FACADE viewed from +X (east), u=z->', Z0, Z1, Y0, Y1,
  (u, v) => [X1 + 1, v, u], [0, 0, 1], [0, 1, 0], [-1, 0, 0]);
// Facade facing -X (view from -x toward +x): u=z reversed
render('FACADE viewed from -X (west), u=z<-', Z0, Z1, Y0, Y1,
  (u, v) => [X0 - 1, v, u], [0, 0, 1], [0, 1, 0], [1, 0, 0]);
// Facade facing +Z (view from +z toward -z): u=x
render('FACADE viewed from +Z (south), u=x->', X0, X1, Y0, Y1,
  (u, v) => [u, v, Z1 + 1], [1, 0, 0], [0, 1, 0], [0, 0, -1]);
// Facade facing -Z
render('FACADE viewed from -Z (north), u=x<-', X0, X1, Y0, Y1,
  (u, v) => [u, v, Z0 - 1], [1, 0, 0], [0, 1, 0], [0, 0, 1]);
// Plan view from top: u=x, "v"=z
{
  console.log(`\n## PLAN (top view), rows = z (south at bottom), cols = x (x0=${X0})`);
  let ri = 0;
  for (let z = Z1; z >= Z0; z--) {
    let row = '';
    for (let x = X0; x <= X1; x++) {
      const t = cast(x, Y1 + 1, z, 0, -1, 0, 300);
      row += chOf(t);
    }
    console.log(`z=${String(z).padStart(3)} ${row.replace(/\s+$/, '')} ~r${ri++}q`);
  }
  console.log('      ' + Array.from({ length: X1 - X0 + 1 }, (_, i) => (X0 + i) % 10 === 0 ? '|' : ((X0 + i) % 5 === 0 ? '.' : ' ')).join(''));
}
