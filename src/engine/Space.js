// Space.js — single source of truth for world-space units and transforms.
//
// The internal grid unit is one SMALL cell = 0.5 m in world space. All engine
// coordinates are in cell units unless explicitly converted. Modules that used
// to hard-code these constants (VoxelRaycaster, ChunkMeshBuilder, Renderer,
// WorldSerializer) now read them from here.

export const CELL_SIZE = 0.5; // world-space edge of one small cell
export const DEFAULT_CHUNK_SIZE = 16; // chunk edge length in small cells
// Long enough for sniper-range weapons (reach is set in meters; a 1000 m shot
// is 2000 cells). Picks that should stay short pass their own maxDist.
export const MAX_RAY_DISTANCE = 2048; // cells (1024 m)

/** Convert a world-space position to cell units. */
export function worldToCell(pos) {
  return [pos[0] / CELL_SIZE, pos[1] / CELL_SIZE, pos[2] / CELL_SIZE];
}

/** Convert cell coordinates to the world-space center of the cell. */
export function cellCenterToWorld(cell) {
  return [cell[0] * CELL_SIZE + CELL_SIZE / 2, cell[1] * CELL_SIZE + CELL_SIZE / 2, cell[2] * CELL_SIZE + CELL_SIZE / 2];
}

/** World-space min corner of a cell (used for ghost cubes). */
export function cellMinToWorld(cell) {
  return [cell[0] * CELL_SIZE, cell[1] * CELL_SIZE, cell[2] * CELL_SIZE];
}
