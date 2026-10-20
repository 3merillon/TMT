/** Realtime match harness on the analytic SphereWorld with the deterministic fake terrain preparer. One fixed tick per
 * presented frame: the frame clock drives the preparer, so a stall costs frames, not ticks. */
import type { DriveInput, GameEvent, V3 } from '../../src/game/contracts';
import { DEFAULT_RULES, type KitLoadoutIds, type MatchSetup } from '../../src/game/api/match';
import { RealtimeMatch, type RealtimeEvent, type RealtimeScript, type RealtimeUnitSpec } from '../../src/game/realtime/match';
import { FIXED_DT } from '../../src/game/rules/ballistics';
import { SphereWorld } from './sphere-world';
import { FakeTransactions } from './fake-transactions';
import { readFileSync } from 'node:fs';
import { installRealtimeCore } from '../../src/game/realtime/core';
installRealtimeCore(readFileSync(new URL('../../src/game/realtime/realtime-core.wasm', import.meta.url)));

export const WARDEN: KitLoadoutIds = { hull: 'warden', runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna' };
export const SKIFF_MORTAR: KitLoadoutIds = { hull: 'skiff', runningGear: 'scout', turret: 'dome', weapon: 'mortar', utility: 'antenna' };

/** Surface direction `u` units of arc forward (+Z, the player's heading 0 at +Y) and `side` units toward +X on the
 * radius-18 sphere. */
export function site(u: number, side = 0): V3 {
  const arc = Math.hypot(u, side) / 18;
  if (arc === 0) return [0, 1, 0];
  const s = Math.sin(arc) / Math.hypot(u, side);
  return [side * s, Math.cos(arc), u * s];
}

export function realtimeSetup(o: { seed?: number; fog?: boolean; friendlyFire?: boolean; player?: KitLoadoutIds; heading?: number } = {}): MatchSetup {
  return {
    id: 'test:realtime', seed: o.seed ?? 5, mode: 'campaign', planet: { kind: 'temperate' },
    teams: [{ id: 0, name: 'Wardens', ai: false }, { id: 1, name: 'Rust', ai: true }],
    tanks: [{ team: 0, loadout: o.player ?? WARDEN, spawn: { up: [0, 1, 0], heading: o.heading ?? 0 }, name: 'Kestrel' }],
    rules: { ...DEFAULT_RULES, ammo: {}, fog: o.fog ?? false, friendlyFire: o.friendlyFire ?? false, turnModel: 'realtime' },
    objectives: [],
  };
}

export interface RealtimeRun {
  match: RealtimeMatch; world: SphereWorld; transactions: FakeTransactions; events: GameEvent[]; realtime: RealtimeEvent[]; frames: number;
  /** Advance `ticks` fixed ticks (more frames when stalled), with the player's drive input. */
  run(ticks: number, drive?: DriveInput): RealtimeRun;
  /** Advance until `done` or `limit` ticks. */
  until(done: (run: RealtimeRun) => boolean, limit?: number, drive?: DriveInput): boolean;
}

export function realtimeRun(setup: MatchSetup = realtimeSetup(), options: { units?: RealtimeUnitSpec[]; script?: RealtimeScript; latency?: number; serial?: boolean } = {}): RealtimeRun {
  const world = new SphereWorld();
  const run = { world, events: [], realtime: [], frames: 0 } as unknown as RealtimeRun;
  run.transactions = new FakeTransactions(world, () => run.frames, { latency: options.latency ?? 1, serial: options.serial });
  world.transactions = run.transactions;
  run.match = new RealtimeMatch(world, setup, { units: options.units, script: options.script });
  run.realtime.push(...run.match.drainRealtimeEvents());
  const frame = (drive?: DriveInput) => {
    run.frames++;
    run.events.push(...run.match.step(FIXED_DT, drive));
    run.realtime.push(...run.match.drainRealtimeEvents());
  };
  run.run = (ticks, drive) => {
    const target = run.match.state.tick + ticks;
    for (let guard = 0; run.match.state.tick < target && !run.match.finished && guard < ticks * 4 + 20; guard++) frame(drive);
    return run;
  };
  run.until = (done, limit = 3600, drive) => {
    for (let i = 0; i < limit * 2 && !done(run); i++) { frame(drive); if (run.match.finished && !done(run)) return false; }
    return done(run);
  };
  return run;
}

export function unit(team: number, at: V3, o: Partial<RealtimeUnitSpec> = {}): RealtimeUnitSpec {
  return { team, loadout: WARDEN, spawn: { up: at, heading: Math.PI }, brain: 'dummy', ...o };
}
