import { describe, expect, it } from 'vitest';
import { validateResidentCheckpoint, type ResidentGameCheckpoint } from '../src/game/resident-checkpoint';
import { PLANET_GENERATOR } from '../src/game/planet-field';
import { MAX_REALTIME_UNITS } from '../src/game/realtime/rules';
import type { StructuralMotion } from '../src/game/structural-physics';

const motion = (id: number): StructuralMotion => ({ id, position: [id, 18, 0], rotation: [0, 0, 0, 1],
  velocity: [0, 0, 0], angularVelocity: [0, 0, 0], sleeping: false });
function checkpoint(chassis: StructuralMotion[]): ResidentGameCheckpoint {
  return { format: 'tmt-resident-terrain', schemaVersion: 1, profile: 'resident-f32-game-v3', generator: PLANET_GENERATOR,
    seed: 7, kind: 'glacial', revision: 1, structures: [], edits: [], tick: 0, bodies: [], chassis };
}

describe('resident checkpoint chassis capacity', () => {
  it.each(['rust-engine-v1', 'rust-engine-v2', 'rust-engine-v3', 'rust-engine-v4', 'rust-engine-v5', 'rust-engine-v6', 'rust-engine-v7', 'rust-engine-v8', 'rust-engine-v9', 'rust-engine-v10', 'rust-engine-v11', 'rust-engine-v12', 'rust-engine-v13', 'rust-engine-v14', 'rust-engine-v15', 'rust-engine-v16', 'rust-engine-v17', 'rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'] as const)('preserves %s without upgrading its rules', engine => {
    const input = { ...checkpoint([motion(0)]), engine };
    expect(validateResidentCheckpoint(input).engine).toBe(engine);
  });
  it.each(Array.from({ length: 16 }, (_, i) => i + 1))('accepts and copies %i tank chassis', count => {
    const input = checkpoint(Array.from({ length: count }, (_, id) => motion(id)));
    const validated = validateResidentCheckpoint(input);
    expect(validated).toEqual(input);
    expect(validated.chassis).not.toBe(input.chassis);
    expect(validated.chassis[0].position).not.toBe(input.chassis[0].position);
    expect(validateResidentCheckpoint(JSON.stringify(input))).toEqual(validated);
  });

  it('retains an empty legacy chassis collection without adding world identity', () => {
    const input = checkpoint([]); delete input.kind;
    expect(validateResidentCheckpoint(input)).toEqual(input);
    expect(validateResidentCheckpoint(input).kind).toBeUndefined();
  });

  it('rejects capacity overflow, out-of-range ids and duplicate valid ids', () => {
    expect(MAX_REALTIME_UNITS).toBeGreaterThanOrEqual(64);
    expect(() => validateResidentCheckpoint(checkpoint(Array.from({ length: MAX_REALTIME_UNITS + 1 }, (_, id) => motion(id)))))
      .toThrow('Invalid checkpoint body collection');
    expect(() => validateResidentCheckpoint(checkpoint([motion(MAX_REALTIME_UNITS)]))).toThrow('Invalid checkpoint body pose');
    expect(() => validateResidentCheckpoint(checkpoint([motion(7), motion(7)]))).toThrow('Invalid checkpoint body collection');
  });

  it('keeps detached terrain body ids separate from tank slot ids', () => {
    const input = checkpoint([motion(7)]); input.bodies = [motion(8), motion(1024)];
    expect(validateResidentCheckpoint(input).bodies).toEqual(input.bodies);
    expect(() => validateResidentCheckpoint({ ...input, bodies: [motion(0)] })).toThrow('Invalid checkpoint body pose');
  });
});
