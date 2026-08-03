import { World } from './src/engine/World.js';
import { SIZE } from './src/engine/VoxelTypes.js';
import { NavMesh } from './src/engine/NavMesh.js';

const w = new World();
for (let x = 0; x < 12; x++) for (let z = 0; z < 12; z++) {
  const inTrench = x >= 6 && x <= 7 && z >= 4 && z <= 9;
  if (!inTrench) for (let y = 0; y <= 1; y++) w.place('stone', SIZE.SMALL, x, y, z);
  for (let y = -10; y <= -9; y++) w.place('stone', SIZE.SMALL, x, y, z);
}
for (let i = 0; i <= 6; i++) { const z = 4 + i; for (let x = 6; x <= 7; x++) w.place('stone', SIZE.SMALL, x, 1 - i, z); }
const nav = new NavMesh(w, { halfWidth: 0.25, height: 1.7 });
// stair column surfaces
for (let z = 3; z <= 11; z++) {
  const n = nav.nearestNodeAtCell(6, z, 0);
  console.log(`col(6,${z}):`, n ? `y${n.y}` : 'none');
}
const ground = nav.nearestNodeAtCell(2, 2, 2);
const basement = nav.nearestNodeAtCell(2, 2, -8);
console.log('ground', JSON.stringify(ground), 'region', ground ? nav.regionOf(ground) : '-');
console.log('basement', JSON.stringify(basement), 'region', basement ? nav.regionOf(basement) : '-');
console.log('path:', nav.findPath(ground, basement) ? 'FOUND' : 'NONE');
// What does the last stair step connect to?
const lastStep = nav.nearestNodeAtCell(6, 10, -4);
console.log('lastStep (6,10,-4):', lastStep ? JSON.stringify(lastStep) : 'none', 'region', lastStep ? nav.regionOf(lastStep) : '-');
const basement10 = nav.nearestNodeAtCell(7, 10, -8);
console.log('basement (7,10,-8):', basement10 ? JSON.stringify(basement10) : 'none', 'region', basement10 ? nav.regionOf(basement10) : '-');
