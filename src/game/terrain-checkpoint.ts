import type { V3 } from './contracts';
import { PLANET_GENERATOR } from './planet-field';
import { BRICK_DEPTH, BRICK_SIZE, MAX_BRICK_EDITS, MAX_TERRAIN_BLAST_RADIUS, MAX_TERRAIN_EDITS, MIN_TERRAIN_BLAST_RADIUS, TERRAIN_BOUND } from './terrain-config';
import { validateStructures, type TerrainStructure } from './terrain-structures';

export interface TerrainEdit { id: number; center: V3; radius: number }
export interface TerrainCheckpoint {
  format: 'tmt-terrain';
  schemaVersion: 1;
  generator: typeof PLANET_GENERATOR;
  seed: number;
  revision: number;
  brickDepth: number;
  editCapacity: number;
  edits: TerrainEdit[];
  structures?: TerrainStructure[];
}
export const MAX_CHECKPOINT_LENGTH = 512 * 1024;

export function validateTerrainEdit(center: unknown, radius: unknown): { center: V3; radius: number } {
  if (!Array.isArray(center) || center.length !== 3 || !center.every(v => typeof v === 'number' && Number.isFinite(v))
    || typeof radius !== 'number' || !Number.isFinite(radius) || radius < MIN_TERRAIN_BLAST_RADIUS || radius > MAX_TERRAIN_BLAST_RADIUS) {
    throw new Error(`Blast radius must be between ${MIN_TERRAIN_BLAST_RADIUS} and ${MAX_TERRAIN_BLAST_RADIUS} and center must be finite.`);
  }
  return { center: [...center] as V3, radius };
}

/** Parse and defensively clone untrusted JSON before starting any geometry work. */
export function validateTerrainCheckpoint(input: unknown): TerrainCheckpoint {
  let value = input;
  if (typeof value === 'string') {
    if (value.length > MAX_CHECKPOINT_LENGTH) throw new Error('Terrain checkpoint exceeds its size limit.');
    try { value = JSON.parse(value); } catch { throw new Error('Terrain checkpoint is not valid JSON.'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid terrain checkpoint.');
  const c = value as Record<string, unknown>;
  if (c.format !== 'tmt-terrain' || c.schemaVersion !== 1 || c.generator !== PLANET_GENERATOR) throw new Error('Unsupported terrain checkpoint format or generator.');
  if (typeof c.seed !== 'number' || !Number.isInteger(c.seed) || c.seed < 0 || c.seed > 0xffffffff) throw new Error('Invalid terrain checkpoint seed.');
  if (typeof c.brickDepth !== 'number' || !Number.isInteger(c.brickDepth) || c.brickDepth < 1 || c.brickDepth > 2) throw new Error('Unsupported terrain checkpoint resolution.');
  if (typeof c.editCapacity !== 'number' || !Number.isInteger(c.editCapacity) || c.editCapacity < 1 || c.editCapacity > MAX_BRICK_EDITS) throw new Error('Invalid terrain checkpoint edit capacity.');
  if (!Array.isArray(c.edits) || c.edits.length > MAX_TERRAIN_EDITS) throw new Error('Terrain checkpoint exceeds its edit limit.');
  if (!Number.isSafeInteger(c.revision) || c.revision !== c.edits.length + 1) throw new Error('Terrain checkpoint revision does not match its complete edit history.');
  const edits: TerrainEdit[] = c.edits.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid terrain checkpoint edit.');
    const edit = raw as Record<string, unknown>;
    if (edit.id !== index + 1) throw new Error('Terrain checkpoint edit IDs must be contiguous and ordered.');
    return { id: index + 1, ...validateTerrainEdit(edit.center, edit.radius) };
  });
  // Count actual sphere/brick intersections, matching the builder's history admission rule.
  const counts = new Map<string, number>();
  for (const edit of edits) {
    const lo = edit.center.map(v => Math.max(0, Math.floor((v - edit.radius + TERRAIN_BOUND) / BRICK_SIZE)));
    const hi = edit.center.map(v => Math.min(7, Math.floor((v + edit.radius + TERRAIN_BOUND) / BRICK_SIZE)));
    // Include a neighboring brick when a sphere touches its upper face exactly.
    for (let axis = 0; axis < 3; axis++) if ((edit.center[axis] - edit.radius + TERRAIN_BOUND) % BRICK_SIZE === 0) lo[axis] = Math.max(0, lo[axis] - 1);
    for (let z = lo[2]; z <= hi[2]; z++) for (let y = lo[1]; y <= hi[1]; y++) for (let x = lo[0]; x <= hi[0]; x++) {
      const coordinate = [x, y, z];
      const distance2 = coordinate.reduce((sum, c, axis) => {
        const min = -TERRAIN_BOUND + c * BRICK_SIZE;
        return sum + Math.max(min - edit.center[axis], 0, edit.center[axis] - min - BRICK_SIZE) ** 2;
      }, 0);
      if (distance2 > edit.radius ** 2) continue;
      const key = coordinate.join(','), count = (counts.get(key) ?? 0) + 1;
      if (count > c.editCapacity) throw new Error('Terrain checkpoint exceeds its per-brick edit capacity.');
      counts.set(key, count);
    }
  }
  return { format: 'tmt-terrain', schemaVersion: 1, generator: PLANET_GENERATOR, seed: c.seed, revision: c.revision as number,
    brickDepth: c.brickDepth, editCapacity: c.editCapacity, edits,
    ...(c.structures !== undefined ? { structures: validateStructures(c.structures) } : {}) };
}

export function encodeTerrainCheckpoint(checkpoint: TerrainCheckpoint): string {
  return JSON.stringify(validateTerrainCheckpoint(checkpoint));
}

export function initialTerrainCheckpoint(seed: number, depth = BRICK_DEPTH, editCapacity = MAX_BRICK_EDITS): TerrainCheckpoint {
  return validateTerrainCheckpoint({ format: 'tmt-terrain', schemaVersion: 1, generator: PLANET_GENERATOR, seed, revision: 1, brickDepth: depth, editCapacity, edits: [] });
}
