import type { RustTerrainCore } from '../gpu/terrain/rust-core';
import type { MatchSetup } from './api/match';
import type { GameSnapshot, ImpactEvent, ProjectileState, TankState, TerrainHit, V3 } from './contracts';
import type { KitAssembly } from './kit';
import { hasReactiveArmor, REACTIVE_ARMOR } from './kit/armor';
import type { MunitionId } from './munitions';
import { munitionStats } from './munitions';
import { NUKE_CHARGE } from './rules/ammo';
import { TANK_TARGET_RADIUS, type AimTargetCollider } from './rules/aim-target';
import type { BallisticQuery } from './native-ballistics';
import type { NativeMatch } from './native-match';
import { add, distance, mul, normalize, sub } from './math';

const AMMO: readonly MunitionId[] = ['explosive', 'heavy', 'incendiary', 'nuclear'];
const SECTIONS = ['front', 'left', 'right', 'rear', 'roof'] as const;
/** Resident combat ABI 1. Health, ammunition, charge and spent armor are output
 * mirrors. Only initial admission and explicit restoration import that state. */
export class NativeCombat {
  private id: number;
  private match?: NativeMatch;
  constructor(private readonly core: RustTerrainCore, setup: MatchSetup, private readonly state: GameSnapshot,
    private readonly kit: (tank: TankState) => KitAssembly) {
    this.id = core.createCombat([1, +(setup.mode === 'drive'), +setup.rules.friendlyFire, TANK_TARGET_RADIUS, NUKE_CHARGE,
      REACTIVE_ARMOR.blastReduction, REACTIVE_ARMOR.railReduction, setup.rules.radarCost, state.tanks.length, ...state.tanks.flatMap(t => this.unit(t))]);
  }
  bind(match: NativeMatch): void { match.bindCombat(this.core, this.id); this.match = match; }
  refresh(): void { this.publish(this.call(0)); }
  damage(tank: number, amount: number): boolean { const w = this.call(1, [tank, amount]); this.publish(w, 1); return !!w[0]; }
  fall(tank: number): boolean { return this.fell(this.call(2, [tank])); }
  /** A fall's op 2 words (also a v20 tick tail's fall record): publish, and whether it killed. */
  fell(w: Float64Array): boolean { this.publish(w, 1); return !!w[0]; }
  setKit(tank: TankState): void {
    const k = this.kit(tank); this.publish(this.call(3, [1, tank.id, k.stats.mass, k.stats.mitigation, +hasReactiveArmor(k.loadout), k.stats.hp]));
  }
  spend(tank: number, munition: MunitionId): boolean { const w = this.call(4, [tank, AMMO.indexOf(munition)]); this.publish(w, 1); return !!w[0]; }
  scan(tank: number): boolean { const w = this.call(5, [tank]); this.publish(w, 1); return !!w[0]; }
  /** Explicit checkpoint/tooling admission, never called by a simulation tick. */
  restore(tank: number, changes: Partial<TankState>): void {
    const w = this.call(8, [tank, ...this.unit({ ...this.state.tanks[tank], ...changes })]);
    if (changes.reactiveArmor !== undefined) this.state.tanks[tank].reactiveArmor = changes.reactiveArmor;
    this.publish(w);
  }
  impact(projectile: ProjectileState, hit: TerrainHit, direct: number | null, query: BallisticQuery | undefined,
    blocked: (o: V3, d: V3, extent: number) => boolean): NonNullable<ImpactEvent['hits']> {
    if (query && query.core !== this.core) throw new Error('Combat query belongs to another engine');
    const k = this.kit(this.state.tanks[projectile.owner]), stats = munitionStats(k, projectile.munition);
    const start = add(hit.point, mul(hit.normal, .08));
    const header = [projectile.owner, direct ?? -1, stats.radius, stats.damage, +(k.loadout.weapon === 'rail'), +(projectile.munition === 'nuclear'),
      ...hit.point, ...hit.normal, query?.kind ?? 0, query?.id ?? 0, query?.range ?? 1], motion = this.match?.motion;
    // Analytic worlds retain their ordered obstruction callback. Live scenes
    // compute exposure and read all body poses directly in the same component.
    if (motion && !query) motion.refresh();
    const obstruction = (t: TankState) => +(!query && (direct === t.id || distance(hit.point, t.position) < stats.radius * 1.65 + TANK_TARGET_RADIUS)
      && blocked(start, normalize(sub(t.position, start)), Math.max(0, distance(start, t.position) - TANK_TARGET_RADIUS)));
    const w = motion ? motion.impact([...header, ...(query ? [] : this.state.tanks.map(obstruction))])
      : this.call(6, [...header, ...this.state.tanks.flatMap(t => [...t.position, ...t.rotation, ...t.velocity, obstruction(t)])]);
    const hits: NonNullable<ImpactEvent['hits']> = [];
    for (let i = 0; i < w[0]; i++) {
      const p = 1 + i * 10, id = w[p];
      this.state.tanks[id].velocity = [w[p + 7], w[p + 8], w[p + 9]];
      hits.push({ tank: id, damage: w[p + 1], exposure: w[p + 2], direct: !!w[p + 3], lethal: !!w[p + 4], armorSection: SECTIONS[w[p + 5]],
        ...(w[p + 6] ? { reactiveSpent: w[p + 6] } : {}) });
    }
    this.publish(w, 1 + w[0] * 10); return hits;
  }
  resolve(from: V3, direction: V3, extent: number, age: number, owner: number, tanks: boolean, selected: AimTargetCollider | undefined, hit: TerrainHit | null):
    { hit: TerrainHit | null; victim: number | null; hitTarget: boolean } {
    const header = [...from, ...direction, extent, age, owner, +tanks, +!!selected, ...(selected?.center ?? [0, 0, 0]), selected?.radius ?? 1,
      +!!hit, ...(hit ? [hit.distance, ...hit.point, ...hit.normal, hit.material] : Array<number>(8).fill(0))];
    const w = this.match?.motion ? this.match.motion.resolve(header) : this.call(7, [...header, ...this.state.tanks.flatMap(t => t.position)]);
    return { victim: w[0] < 0 ? null : w[0], hitTarget: !!w[1], hit: w.length === 10 ? { distance: w[2], point: [w[3], w[4], w[5]], normal: [w[6], w[7], w[8]], material: w[9] } : null };
  }
  dispose(): void { if (this.id) { this.core.disposeCombat(this.id); this.id = 0; } }
  private unit(t: TankState): number[] {
    const k = this.kit(t);
    return [t.team!, t.health, t.charge, t.reactiveArmor ?? 0, ...AMMO.map(id => t.ammo?.[id] ?? -1), k.stats.mass, k.stats.mitigation, +hasReactiveArmor(k.loadout)];
  }
  private call(op: number, data: ArrayLike<number> = []): Float64Array {
    if (!this.id) throw new Error('Resident combat is disposed');
    return this.core.combatCommand(this.id, op, data);
  }
  private publish(w: Float64Array, start = 0): void {
    for (let i = 0; i < w[start]; i++) {
      const t = this.state.tanks[i], p = start + 1 + i * 8;
      t.team = w[p]; t.health = w[p + 1]; t.charge = w[p + 2];
      if (w[p + 3] || t.reactiveArmor !== undefined) t.reactiveArmor = w[p + 3];
      for (let j = 0; j < AMMO.length; j++) {
        if (w[p + 4 + j] >= 0) (t.ammo ??= {})[AMMO[j]] = w[p + 4 + j];
        else if (t.ammo) delete t.ammo[AMMO[j]];
      }
    }
  }
}
