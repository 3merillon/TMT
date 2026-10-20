/** Live shots are match-owned. This adapter publishes mirrors and services the
 * remaining analytic/extension query boundary; previews use NativeBallistics. */
import type { RustTerrainCore } from '../gpu/terrain/rust-core';
import type { GameSnapshot, ProjectileState, TerrainHit } from './contracts';
import type { Flight } from './rules/ballistics';
import type { KitAssembly } from './kit';
import { windFactor, type MunitionId } from './munitions';
import { readFlightStep, type BallisticQuery } from './native-ballistics';

const AMMO: readonly MunitionId[] = ['explosive', 'heavy', 'incendiary', 'nuclear'];
const kitWords = (kit: KitAssembly, wind: boolean): number[] => [kit.weapon.barrelLength, ...AMMO.map(id => wind ? windFactor(kit, id) : 0)];
const hitWords = (hit: TerrainHit | null): number[] => hit ? [hit.distance, ...hit.point, ...hit.normal, hit.material] : [];
const row = (s: ProjectileState): number[] => [s.id, s.owner, s.munition ? AMMO.indexOf(s.munition) : -1, ...s.position, ...s.velocity, s.age,
  +(s.launchTick !== undefined), s.launchTick ?? 0, +!!s.origin, ...(s.origin ?? [0, 0, 0]), +(s.peakAltitude !== undefined), s.peakAltitude ?? 0];
const rows = (ss: ProjectileState[]): number[] => [ss.length, ...ss.flatMap(row)];
const changed = (a: number[], b: number[]) => a.length !== b.length || a.some((x, i) => !Object.is(x, b[i]));
export class NativeShots {
  private pendingMirror?: ProjectileState;
  constructor(private readonly core: RustTerrainCore, private readonly id: number, context: number, private readonly state: GameSnapshot, kits: KitAssembly[], private readonly wind: boolean) {
    this.call(48, [1, context, ...kits.flatMap(k => kitWords(k, wind))]);
  }
  private call(op: number, data: ArrayLike<number> = []): Float64Array { return this.core.matchCommand(this.id, op, data); }
  current(): ProjectileState | undefined { this.publish(this.call(49)); return this.state.projectiles[0]; }
  /** v20 tick-tail records: the live list (op 49 / clear 52 words) and a finished segment (op 51 words). */
  published(w: Float64Array, cleared = false): void { this.publish(w); if (cleared) this.pendingMirror = undefined; }
  start(projectile: ProjectileState): Flight {
    const w = this.call(57); this.pendingMirror = projectile;
    const position = projectile.position.every((v, i) => v === w[i]) ? projectile.position : [w[0], w[1], w[2]] as [number, number, number];
    return { position, vx: w[3], vy: w[4], vz: w[5], age: w[6], launchTick: projectile.launchTick };
  }
  advance(flight: Flight, query?: BallisticQuery): ReturnType<typeof readFlightStep> {
    if (query && query.core !== this.core) throw new Error('Live shot query belongs to another engine');
    return readFlightStep(this.call(50, [query?.kind ?? 0, query?.id ?? 0, query?.range ?? 1]), flight);
  }
  blocked(hit: TerrainHit): void { this.call(50, [0, 0, 1, ...hitWords(hit)]); }
  finish(hit: TerrainHit | null): { projectile: ProjectileState; impactProjectile: ProjectileState; hit: TerrainHit | null; tank: number | null; expired: boolean } {
    return this.finished(this.call(51, hitWords(hit)));
  }
  finished(w: Float64Array): ReturnType<NativeShots['finish']> {
    const before = this.read(w, 12); this.pendingMirror = undefined; this.publish(w, 30);
    return { projectile: this.state.projectiles[0] ?? before, impactProjectile: before,
      hit: w[3] ? { distance: w[4], point: [w[5], w[6], w[7]], normal: [w[8], w[9], w[10]], material: w[11] } : null,
      tank: w[0] < 0 ? null : w[0], expired: !!w[2] };
  }
  abort(): void { this.call(56); this.pendingMirror = undefined; }
  clear(): void { this.publish(this.call(52)); this.pendingMirror = undefined; }
  setKit(id: number, kit: KitAssembly): void { this.call(53, [id, ...kitWords(kit, this.wind)]); }
  extension<T>(callback: () => T): T {
    const refs = [...this.state.projectiles], before = rows(refs), pending = this.pendingMirror, beforePending = pending ? row(pending) : undefined;
    try { return callback(); } finally {
      if (pending && beforePending) { const after = row(pending); if (changed(beforePending, after)) this.call(55, after); }
      const after = rows(this.state.projectiles);
      if (changed(before, after)) {
        if (refs.length !== this.state.projectiles.length || refs.some((s, i) => s !== this.state.projectiles[i])) this.call(54, after);
        else {
          const edits = [0];
          for (let id = 0; id < refs.length; id++) { let mask = 0; const values: number[] = [];
            for (let i = 0; i < 18; i++) if (!Object.is(before[1 + id * 18 + i], after[1 + id * 18 + i])) { mask |= 1 << i; values.push(after[1 + id * 18 + i]); }
            if (mask) { edits[0]++; edits.push(id, mask, ...values); }
          }
          this.call(58, edits);
        }
      }
    }
  }
  private publish(w: Float64Array, start = 0): void { this.state.projectiles = Array.from({ length: w[start] }, (_, i) => this.read(w, start + 1 + i * 18)); }
  private read(w: Float64Array, p: number): ProjectileState {
    return { id: w[p], owner: w[p + 1], position: [w[p + 3], w[p + 4], w[p + 5]], velocity: [w[p + 6], w[p + 7], w[p + 8]], age: w[p + 9], ...(w[p + 2] < 0 ? {} : { munition: AMMO[w[p + 2]] }),
      ...(w[p + 10] ? { launchTick: w[p + 11] } : {}), ...(w[p + 12] ? { origin: [w[p + 13], w[p + 14], w[p + 15]] as [number, number, number] } : {}),
      ...(w[p + 16] ? { peakAltitude: w[p + 17] } : {}) };
  }
}
