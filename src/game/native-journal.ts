/** Numeric transport for the resident command log and replay scheduler. Only
 * checkpoint JSON and ordered platform callbacks remain on this side. */
import type { RustTerrainCore } from '../gpu/terrain/rust-core';
import type { DriveInput } from './contracts';
import type { PlayerCommand } from './api/session';
import type { MatchCheckpointV2, MatchCommand } from './rules/checkpoint';
import type { GameSimulation } from './simulation';
import { FIXED_DT } from './rules/ballistics';

const AMMO = ['explosive', 'heavy', 'incendiary', 'nuclear'] as const;
function encode(c: PlayerCommand): number[] {
  switch (c.k) {
    case 'aim': return [0, c.yaw, c.pitch, c.power];
    case 'fire': return [1, 0, 0, 0];
    case 'munition': return [2, AMMO.indexOf(c.id), 0, 0];
    case 'scan': return [3, 0, 0, 0];
    case 'endMove': return [4, 0, 0, 0];
    case 'drive': return [5, c.throttle, c.steer, 0];
    case 'hold': return [6, 0, 0, 0];
    default: throw new Error('Unsupported replay command');
  }
}
function decode(w: Float64Array, p: number): PlayerCommand {
  switch (w[p]) {
    case 0: return { k: 'aim', yaw: w[p + 1], pitch: w[p + 2], power: w[p + 3] };
    case 1: return { k: 'fire' };
    case 2: return { k: 'munition', id: AMMO[w[p + 1]] };
    case 3: return { k: 'scan' };
    case 4: return { k: 'endMove' };
    case 5: return { k: 'drive', throttle: w[p + 1], steer: w[p + 2] };
    case 6: return { k: 'hold' };
    default: throw new Error('Unknown resident command');
  }
}
const hashWords = (hash: string) => [Number.parseInt(hash.slice(0, 8), 16), Number.parseInt(hash.slice(8), 16)];

export class NativeJournal {
  private origin = false;
  get recording(): boolean { return this.origin; }
  constructor(private readonly core: RustTerrainCore, private readonly id: number, human: readonly boolean[]) {
    this.call(27, [1, ...human.map(Number)]);
  }
  private call(op: number, data: ArrayLike<number> = []): Float64Array { return this.core.matchCommand(this.id, op, data); }
  record<T>(action: () => T): T { const before = this.origin; this.origin = true; try { return action(); } finally { this.origin = before; } }
  drive(input: DriveInput): void { this.call(30, [input.throttle, input.steer]); }
  log(): MatchCommand[] {
    const result: MatchCommand[] = [];
    for (;;) {
      const w = this.call(31, [result.length, 4096]);
      for (let p = 1; p < w.length; p += 6) result.push({ tick: w[p], tank: w[p + 1], c: decode(w, p + 2) });
      if (result.length === w[0]) return result;
    }
  }
  replay(checkpoint: MatchCheckpointV2, simulation: GameSimulation): NativeReplay {
    return new NativeReplay(this.core, this.id, checkpoint, simulation);
  }
}
export class NativeReplay {
  constructor(private readonly core: RustTerrainCore, private readonly id: number, checkpoint: MatchCheckpointV2, private readonly simulation: GameSimulation) {
    this.call(32, [checkpoint.tick, checkpoint.commands.length, ...hashWords(checkpoint.hash),
      ...checkpoint.commands.flatMap(c => [c.tick, c.tank, ...encode(c.c)])]);
  }
  private call(op: number, data: ArrayLike<number> = []): Float64Array { return this.core.matchCommand(this.id, op, data); }
  get done(): boolean { return !!this.call(35)[0]; }
  advance(maxTicks: number): 'done' | 'stalled' | 'progress' {
    for (let ticks = 0; ticks < maxTicks; ticks++) for (;;) {
      const w = this.call(33);
      if (w[0] === 0) return 'done';
      if (w[0] === 1) {
        this.simulation.step(0);
        if (this.call(34, [1, +!this.simulation.stalledOn])[0]) return 'stalled';
      } else if (w[0] === 2) {
        const accepted = this.simulation.command(w[2], decode(w, 3)); this.call(34, [2, +accepted]);
      } else {
        this.simulation.step(FIXED_DT, { throttle: w[1], steer: w[2] });
        if (this.call(34, [3, 1])[0]) return 'stalled'; break;
      }
    }
    return 'progress';
  }
  verified(): boolean { return !!this.call(36, hashWords(this.simulation.matchHash()))[0]; }
}
