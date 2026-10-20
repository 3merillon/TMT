/** Match-owned pose, pending impulses and chassis animation. Body IDs bind the
 * existing native Rapier world; ordinary ticks never import output tank poses. */
import type { RustTerrainCore } from '../gpu/terrain/rust-core';
import type { GameSnapshot, TankState } from './contracts';

const fields = (t: TankState): number[] => [...t.position, ...t.rotation, ...t.velocity,
  t.heading, t.yawVelocity, t.recoil, t.trackPhase, ...t.trackPhases];
export class NativeMotion {
  constructor(private readonly core: RustTerrainCore, private readonly id: number, private readonly state: GameSnapshot) {
    this.call(37, [1, ...state.tanks.flatMap(fields)]);
  }
  private call(op: number, data: ArrayLike<number> = []): Float64Array { return this.core.matchCommand(this.id, op, data); }
  bind(core: RustTerrainCore, pairs: number[]): void {
    if (core !== this.core) throw new Error('Chassis belongs to another engine');
    this.call(38, [pairs.length / 2, ...pairs]);
  }
  afterPhysics(dt: number): void { this.publish(this.call(39, [dt])); }
  impact(words: number[]): Float64Array { return this.call(40, words); }
  resolve(words: number[]): Float64Array { return this.call(41, words); }
  /** A v17 tick head already published this tick's refresh; the chassis step reuses it once. */
  private fresh = false;
  refresh(): void { if (this.fresh) { this.fresh = false; return; } this.publish(this.call(42)); }
  publishHead(w: Float64Array): void { this.publish(w); this.fresh = true; }
  endTick(): void { this.fresh = false; }
  contacts(): void { this.call(43); }
  chassisTick(words: ArrayLike<number>): Float64Array { return this.call(44, words); }
  /** v18: bind, contacts, articulated poses, queued forces and the chassis tick in one engine call. */
  chassisLeg(words: ArrayLike<number>): Float64Array { return this.call(66, words); }
  /** v19: solver step, body snapshot, query sync and after-physics in one engine call (raw words). */
  solverLeg(words: ArrayLike<number>): Float64Array { return this.call(69, words); }
  /** Publish the after-physics words of a solver leg (what afterPhysics() publishes). */
  publishPhysics(w: Float64Array): void { this.publish(w); }
  /** Explicit editor/fixture admission. Recreating its solver body is separate. */
  restore(tank: TankState): void { this.publish(this.call(45, [1, tank.id, 65535, ...fields(tank)])); }
  /** Preserve the mutable extension API, admitting only fields the callback
   * changed. An untouched mirror is never a source of authoritative motion. */
  extension<T>(callback: () => T): T {
    const before = this.state.tanks.map(fields);
    try { return callback(); } finally {
      const words = [0];
      for (let id = 0; id < before.length; id++) {
        const after = fields(this.state.tanks[id]), values: number[] = []; let mask = 0;
        for (let i = 0; i < 16; i++) if (!Object.is(before[id][i], after[i])) { mask |= 1 << i; values.push(after[i]); }
        if (mask) { words[0]++; words.push(id, mask, ...values); }
      }
      if (words[0]) this.publish(this.call(45, words));
    }
  }
  private publish(w: Float64Array): void {
    for (let i = 0; i < this.state.tanks.length; i++) {
      const t = this.state.tanks[i], p = i * 16;
      t.position = [w[p], w[p + 1], w[p + 2]]; t.rotation = [w[p + 3], w[p + 4], w[p + 5], w[p + 6]];
      t.velocity = [w[p + 7], w[p + 8], w[p + 9]]; t.heading = w[p + 10]; t.yawVelocity = w[p + 11];
      t.recoil = w[p + 12]; t.trackPhase = w[p + 13]; t.trackPhases = [w[p + 14], w[p + 15]];
    }
  }
}
