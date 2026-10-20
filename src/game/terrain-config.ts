import type { TerrainChunk, TerrainUpdate } from './contracts';
export const TERRAIN_RADIUS = 18;
export const TERRAIN_BOUND = 24;
export const BRICK_SIZE = 6;
export const BRICK_DEPTH = 1;
export const MAX_BRICK_EDITS = 24;
export const MAX_TERRAIN_EDITS = 2048;
/** Canonical gameplay floor for the qualified side-3 tetrahedra, never a quality-dependent expansion. */
export const MIN_TERRAIN_BLAST_RADIUS = 2;
export const MAX_TERRAIN_BLAST_RADIUS = 12;
/** CPU-built terrain chunks: shared by collision queries without depending on the legacy builder. */
export interface BuiltTerrainChunk extends TerrainChunk { materials: Uint16Array }
export interface BuiltTerrainUpdate extends TerrainUpdate { chunks: BuiltTerrainChunk[] }
