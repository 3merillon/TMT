import { validCutShells, type SphereCut } from '../gpu/terrain/contracts';
import type { ResidentService } from '../gpu/terrain/service';
import type { StructuralMotion } from './structural-physics';
import { validateStructures, type TerrainStructure } from './terrain-structures';
import { PLANET_GENERATOR, PLANET_TYPES, type PlanetType } from './planet-field';
import type { ResidentGameProfile } from '../gpu/terrain/planet';
import { MAX_REALTIME_UNITS } from './realtime/rules';
import type { ChassisMotion } from './resident-tanks';
import { validateLiquidCheckpoint, type LiquidCheckpoint } from './liquids';

/** One accepted edit: its cut (or cuts, for a cutMany transaction), the physics clock and body poses at its commit,
 * and the bodies it recut (absent: every body; the recut ones hold their request-time pose at commit, the fence). */
export interface ResidentReplayEdit { cut?: SphereCut; cuts?: SphereCut[]; tick: number; bodies: StructuralMotion[]; eligible?: number[] }
export interface ResidentGameCheckpoint {
  format: 'tmt-resident-terrain'; schemaVersion: 1; profile: ResidentGameProfile; generator: typeof PLANET_GENERATOR;
  seed: number; revision: number; structures: TerrainStructure[]; edits: ResidentReplayEdit[]; tick: number; bodies: StructuralMotion[];
  chassis: ChassisMotion[];
  liquids?: LiquidCheckpoint;
  /** Missing in old saves selects their original construction and replay rules. */
  engine?: ResidentService['engine'];
  /** Missing in old saves: use seed & 3, even when their setup recorded an ignored UI choice. */
  kind?: PlanetType;
}
export function residentReplay(terrain: ResidentService): ResidentReplayEdit[] {
  return terrain.history.slice(1).map(edit => ({ cut: edit.cut, ...(edit.cuts ? { cuts: edit.cuts } : {}), tick: edit.physicsTick, bodies: edit.bodiesBefore, ...(edit.eligible && edit.eligible.length !== edit.bodiesBefore.length ? { eligible: edit.eligible } : {}) }));
}
/** Rebuild density/ownership from immutable sources; poses are replay inputs,
 * never a density approximation. Every replayed edit passes normal admission. */
export async function replayResident(terrain: ResidentService, edits: readonly ResidentReplayEdit[], bodies: readonly StructuralMotion[], tick: number): Promise<void> {
  await terrain.initialize();
  for (const edit of edits) {
    terrain.physics.restoreMotions(edit.bodies, edit.tick);
    const cuts = edit.cuts ?? (edit.cut ? [edit.cut] : []);
    if (!cuts.length) await terrain.rebuild();
    else { const staged = await terrain.prepare(cuts, { eligible: edit.eligible }); if (staged) terrain.commit(staged); }
  }
  terrain.physics.restoreMotions(bodies, tick); terrain.syncPoses();
}
export function validateResidentCheckpoint(input: unknown): ResidentGameCheckpoint {
  if (typeof input === 'string') { if (input.length > 16 * 1024 * 1024) throw new Error('Resident checkpoint exceeds 16 MiB'); input = JSON.parse(input); }
  if (!input || typeof input !== 'object') throw new Error('Invalid resident checkpoint');
  const c = input as ResidentGameCheckpoint;
  if (c.engine !== undefined && !['compatibility-v1', 'rust-resident-v1', 'rust-engine-v1', 'rust-engine-v2', 'rust-engine-v3', 'rust-engine-v4', 'rust-engine-v5', 'rust-engine-v6', 'rust-engine-v7', 'rust-engine-v8', 'rust-engine-v9', 'rust-engine-v10', 'rust-engine-v11', 'rust-engine-v12', 'rust-engine-v13', 'rust-engine-v14', 'rust-engine-v15', 'rust-engine-v16', 'rust-engine-v17', 'rust-engine-v18', 'rust-engine-v19', 'rust-engine-v20', 'rust-engine-v21', 'rust-engine-v22'].includes(c.engine)) throw new Error('Unsupported resident engine');
  if (c.kind !== undefined && !PLANET_TYPES.includes(c.kind)) throw new Error('Invalid checkpoint planet kind');
  const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
  if (c.format !== 'tmt-resident-terrain' || c.schemaVersion !== 1 || !['resident-f32-game-v1', 'resident-f32-game-v2', 'resident-f32-game-v3'].includes(c.profile) || c.generator !== PLANET_GENERATOR || !integer(c.seed) || c.seed > 0xffffffff
    || !integer(c.tick) || !integer(c.revision) || !Array.isArray(c.edits) || c.revision < c.edits.length + 1) throw new Error('Unsupported or invalid resident checkpoint');
  const vector = (value: unknown, n: number): boolean => Array.isArray(value) && value.length === n && value.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e7);
  const motions = (input: StructuralMotion[], actors = false): StructuralMotion[] => {
    if (!Array.isArray(input) || input.length > (actors ? MAX_REALTIME_UNITS : 1024) || new Set(input.map(m => m?.id)).size !== input.length) throw new Error('Invalid checkpoint body collection');
    for (const m of input) if (!m || !integer(m.id) || (!actors && m.id < 1) || (actors && m.id >= MAX_REALTIME_UNITS) || !vector(m.position, 3) || !vector(m.rotation, 4) || Math.abs(Math.hypot(...m.rotation) - 1) > 1e-5
      || !vector(m.velocity, 3) || !vector(m.angularVelocity, 3) || typeof m.sleeping !== 'boolean') throw new Error('Invalid checkpoint body pose');
    if (actors) for (const m of input as ChassisMotion[]) if (m.drive && ![m.drive.throttle, m.drive.steer, m.drive.common, m.drive.righting, m.drive.flipped].every(v => Number.isFinite(v) && Math.abs(v) < 1e7)) throw new Error('Invalid checkpoint drive state');
    return structuredClone(input);
  };
  let lastTick = 0;
  const edits = c.edits.map(edit => {
    if (!edit || !integer(edit.tick) || edit.tick < lastTick || edit.tick > c.tick) throw new Error('Invalid checkpoint event clock'); lastTick = edit.tick;
    const valid = (cut: SphereCut) => vector(cut?.center, 3) && Number.isFinite(cut.radius) && cut.radius > 0 && cut.radius <= 12 && typeof cut.id === 'string' && !!cut.id && cut.id.length <= 100 && (cut.repeat === undefined || cut.repeat === 'impact')
      // Material crater shells exist only in rust-engine-v22 saves; older engines' records stay byte-identical.
      && cut.materials === undefined && (cut.shells === undefined || (c.engine === 'rust-engine-v22' && validCutShells(cut)));
    const cut = edit.cut; if (cut && !valid(cut)) throw new Error('Invalid checkpoint cut');
    if (edit.cuts !== undefined && (!Array.isArray(edit.cuts) || !edit.cuts.length || edit.cuts.length > 32 || !edit.cuts.every(valid) || (cut && edit.cuts[0].id !== cut.id))) throw new Error('Invalid checkpoint cut list');
    if (edit.eligible !== undefined && (!Array.isArray(edit.eligible) || edit.eligible.length > 1024 || !edit.eligible.every(id => integer(id) && id >= 1))) throw new Error('Invalid checkpoint recut eligibility');
    return { tick: edit.tick, bodies: motions(edit.bodies), ...(cut ? { cut: structuredClone(cut) } : {}), ...(edit.cuts ? { cuts: structuredClone(edit.cuts) } : {}), ...(edit.eligible ? { eligible: [...edit.eligible] } : {}) };
  });
  return { format: c.format, schemaVersion: 1, profile: c.profile, generator: c.generator, seed: c.seed, ...(c.engine !== undefined ? { engine: c.engine } : {}), ...(c.kind !== undefined ? { kind: c.kind } : {}), revision: c.revision, structures: validateStructures(c.structures), edits, tick: c.tick, bodies: motions(c.bodies), chassis: motions(c.chassis, true), ...(c.liquids ? { liquids: validateLiquidCheckpoint(c.liquids) } : {}) };
}
