import { World } from './src/engine/World.js';
import { SIZE } from './src/engine/VoxelTypes.js';
import { NavMesh } from './src/engine/NavMesh.js';
import { Mob } from './src/game/Mob.js';
import { getMob } from './src/engine/mobTypes.js';
import { CELL_SIZE } from './src/engine/Space.js';

const world = new World();
for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 0; y <= 1; y++) world.place('stone', SIZE.SMALL, x, y, z);
const type = getMob('imp');
const nav = new NavMesh(world, { halfWidth: type.halfWidth, height: type.height });
const mob = new Mob({ type, spawnCell: [2,2,2], world, nav, onDamagePlayer: () => {} });
mob.aggro = true;
mob.state = 'chase';
mob._repathTimer = 0;
mob.pos.y = 15;
mob.grounded = false;
mob.velY = 0;
const player = { x: 7 * CELL_SIZE + CELL_SIZE / 2, y: 1.0, z: 7 * CELL_SIZE + CELL_SIZE / 2 };
let pathLen = -1;
for (let i = 0; i < 200; i++) {
  mob.update(0.1, player);
  if (i < 8 || i % 20 === 0 || mob.grounded) {
    console.log(`f=${i} y=${mob.pos.y.toFixed(2)} grounded=${mob.grounded} state=${mob.state} pathLen=${mob.path.length} wp=${mob.path[mob.pathIndex]?`(${mob.path[mob.pathIndex].x},${mob.path[mob.pathIndex].z},y${mob.path[mob.pathIndex].y})`:'-'}`);
  }
  if (mob.grounded) break;
}
