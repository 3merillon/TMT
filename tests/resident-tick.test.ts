/** Resident tick execution folds host-sequenced engine calls into single engine calls that invoke the same validated
 * operations in the same order: v17 the pre-physics tick head (motion refresh, move permission, journal drive, tick
 * start, wind, a bound controller's drive), v18 the chassis leg (bind, contacts, articulated collider poses, queued
 * forces, chassis tick), v19 the solver leg (step, body snapshots, query pose sync, after-physics), v20 the tick tail
 * (action motion, falls, after-motion, the live shot, settlement, contacts, aim expiry) with host-service stops, v21 the
 * tread profiles of the tail (no host triangle collection or clipping). Every observable result (state, command log, AI telemetry, canonical image and hash) of
 * each engine must equal its predecessor's. */
import { appendFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { GameSimulation, MatchReplay, FIXED_DT } from '../src/game/simulation';
import { practiceSetup, type MatchSetup } from '../src/game/api/match';
import { RustTerrainCore } from '../src/gpu/terrain/rust-core';
import type { NativeMatch } from '../src/game/native-match';
import type { ResidentGameTerrain } from '../src/game/resident-terrain';
import type { SimExtension } from '../src/game/api/extensions';
import { botWorld, botSetup } from './helpers/rust-resident';
import { structuralFixture } from '../src/gpu/terrain/fixtures';

const native = (sim: GameSimulation) => (sim as unknown as { nativeMatch: NativeMatch }).nativeMatch;
const ENGINE_CALLS = ['matchCommand', 'aiCommand', 'profileCommand', 'flightCommand', 'combatCommand', 'physicsCommand', 'queryWorldRun', 'queryRun', 'queryWorldSync'] as const;
function countCalls(): { total(): number; restore(): void } {
  const spies = ENGINE_CALLS.map(name => vi.spyOn(RustTerrainCore.prototype, name));
  return { total: () => spies.reduce((n, s) => n + s.mock.calls.length, 0), restore: () => spies.forEach(s => s.mockRestore()) };
}
/** Differential runs use one fixed tick per attempt so worker stalls cannot change the time cadence between engines.
 * Inputs and shots are functions of simulation tick, and bot matches submit at most one hold for each active human tick.
 * MatchReplay's separate tests retain irregular presentation cadence coverage. Stalls wait for the worker. */
async function play(sim: GameSimulation, ticks: number, mode: string): Promise<void> {
  let heldTick = -1;
  for (let i = 0; i < 40000 && sim.state.tick < ticks && sim.state.phase !== 'finished'; i++) {
    const t = sim.state.tick;
    if (mode === 'bot' && sim.state.phase === 'aim' && sim.state.active === 0 && heldTick !== t) { sim.hold(0); heldTick = t; }
    if (mode === 'drive' && t % 97 === 5 && sim.canFire(0)) { sim.aim(0, .3, .6, .4); sim.fire(0); }
    sim.step(FIXED_DT, { throttle: t % 300 < 150 ? .8 : -.4, steer: t % 220 < 90 ? .35 : -.2 });
    if (sim.stalledOn) await new Promise(resolve => setTimeout(resolve, 0));
  }
}
const setups: Record<string, () => MatchSetup> = {
  drive: () => practiceSetup({ seed: 19, mode: 'drive', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } }),
  legacy: () => botSetup('legacy'), rusty: () => botSetup('rusty'), cyborg: () => botSetup('cyborg'),
};

/** v17 folds the tick head (at least 4 calls); v18 folds the chassis leg (bind, contacts and the chassis tick, plus
 * articulated collider poses whenever an aim moves); v19 the solver leg (step, query sync, after-physics, plus a
 * read per structural body); v20 → v21 removes only the collects of tanks whose pose or world changed. */
const PAIRS = Object.keys(setups).flatMap(name => [[name, 16, 17, 3], [name, 17, 18, 2], [name, 18, 19, 1.5], [name, 19, 20, 1], [name, 20, 21, 0]] as const);
it.each(PAIRS)('%s: engine v%i and v%i run identical ticks, with fewer engine calls, and replay', async (name, older, newer, fewer) => {
  const mode = name === 'drive' ? 'drive' : 'bot';
  const a = await botWorld(1, older), b = await botWorld(4, newer), c = await botWorld(2, newer);
  const sa = new GameSimulation(a, setups[name]()), sb = new GameSimulation(b, setups[name]());
  let replay: MatchReplay | undefined;
  try {
    expect(a.resident.engine).toBe(`rust-engine-v${older}`); expect(b.resident.engine).toBe(`rust-engine-v${newer}`);
    let calls = countCalls(); await play(sa, 420, mode); const before = calls.total() / sa.state.tick; calls.restore();
    calls = countCalls(); await play(sb, 420, mode); const after = calls.total() / sb.state.tick; calls.restore();
    expect(sb.state.tick).toBe(sa.state.tick);
    expect(sb.state).toEqual(sa.state); expect(sb.commandLog()).toEqual(sa.commandLog()); expect(sb.aiTelemetry()).toEqual(sa.aiTelemetry());
    expect(native(sb).canonical!.snapshot()).toEqual(native(sa).canonical!.snapshot()); expect(sb.matchHash()).toBe(sa.matchHash());
    expect(after).toBeLessThanOrEqual(before - fewer);
    if (process.env.TMT_TICK_REPORT) appendFileSync(process.env.TMT_TICK_REPORT, `${JSON.stringify({ name, older, newer, ticks: sb.state.tick, before, after })}\n`);
    const checkpoint = sb.checkpoint(); checkpoint.terrain = await b.saveCheckpoint();
    replay = new MatchReplay(c, JSON.parse(JSON.stringify(checkpoint)));
    for (let i = 0; i < 40000 && !replay.done; i++) if (replay.advance(i % 7 + 1) === 'stalled') await new Promise(resolve => setTimeout(resolve, 0));
    expect(replay.done).toBe(true); expect(replay.verified()).toBe(true); expect(replay.simulation.state).toEqual(sb.state);
  } finally { sa.dispose(); sb.dispose(); replay?.simulation.dispose(); a.dispose(); b.dispose(); c.dispose(); }
}, 240000);

/** v22 changes crater geometry (material shells, rules/material-craters.ts), so it is compared with itself: 1 vs 4
 * workers must agree exactly and a 2-worker world must replay its checkpoint. v21 stays covered by the pairs above. */
it.each(Object.keys(setups))('%s: engine v22 material craters are identical across worker counts and replay', async name => {
  const mode = name === 'drive' ? 'drive' : 'bot';
  const a = await botWorld(1, 22), b = await botWorld(4, 22), c = await botWorld(2, 22);
  const sa = new GameSimulation(a, setups[name]()), sb = new GameSimulation(b, setups[name]());
  let replay: MatchReplay | undefined;
  try {
    expect(a.materialCraters).toBe(true);
    await play(sa, 420, mode); await play(sb, 420, mode);
    expect(sb.state).toEqual(sa.state); expect(sb.commandLog()).toEqual(sa.commandLog()); expect(sb.aiTelemetry()).toEqual(sa.aiTelemetry());
    expect(native(sb).canonical!.snapshot()).toEqual(native(sa).canonical!.snapshot()); expect(sb.matchHash()).toBe(sa.matchHash());
    const edits = (w: ResidentGameTerrain) => w.resident.history.slice(1).map(e => [e.cuts ?? [e.cut], e.ledger, e.bodies]);
    expect(edits(b)).toEqual(edits(a));
    if (name === 'drive') expect(a.resident.history.some(e => (e.cuts ?? [e.cut]).some(cut => cut?.shells))).toBe(true);
    const checkpoint = sb.checkpoint(); checkpoint.terrain = await b.saveCheckpoint();
    replay = new MatchReplay(c, JSON.parse(JSON.stringify(checkpoint)));
    for (let i = 0; i < 40000 && !replay.done; i++) if (replay.advance(i % 7 + 1) === 'stalled') await new Promise(resolve => setTimeout(resolve, 0));
    expect(replay.done).toBe(true); expect(replay.verified()).toBe(true); expect(replay.simulation.state).toEqual(sb.state);
  } finally { sa.dispose(); sb.dispose(); replay?.simulation.dispose(); a.dispose(); b.dispose(); c.dispose(); }
}, 240000);

it('rejects malformed tick heads and misnamed controllers before the journal or clock change', async () => {
  const world: ResidentGameTerrain = await botWorld(1), sim = new GameSimulation(world, botSetup('rusty'));
  try {
    const m = native(sim) as unknown as { core: RustTerrainCore; id: number }, before = native(sim).canonical!.snapshot();
    for (const d of [[], [0, 0, 0], [2, 0, 0, 0], [0, NaN, 0, 0], [0, 0, 3, 0], [0, 0, 1, .5], [0, 0, 0, -1]]) expect(() => m.core.matchCommand(m.id, 65, d)).toThrow('Invalid resident tick head');
    // The active unit is the human: no controller is bound to it.
    expect(() => m.core.matchCommand(m.id, 65, [0, 0, 2, 1])).toThrow('not bound to the active unit');
    expect(() => m.core.matchCommand(m.id, 65, [0, 0, 1, 1])).toThrow('not bound to the active unit');
    expect(native(sim).canonical!.snapshot()).toEqual(before); expect(sim.state.tick).toBe(0);
    sim.step(FIXED_DT); expect(sim.state.tick).toBe(1);
  } finally { sim.dispose(); world.dispose(); }
}, 60000);

it('v19 presents falling structural bodies from one engine snapshot, identically to v18 per-body reads', async () => {
  const cuts = structuralFixture().cuts.map(c => ({ id: c.id, center: [...c.center] as [number, number, number], radius: c.radius }));
  const a = await botWorld(1, 18), b = await botWorld(2, 19), setup = () => { const s = setups.drive(); s.initialCuts = cuts; return s; };
  const sa = new GameSimulation(a, setup()), sb = new GameSimulation(b, setup());
  const reads = vi.spyOn(RustTerrainCore.prototype, 'physicsCommand');
  try {
    const count = () => reads.mock.calls.filter(([op]) => op === 12).length;
    await play(sa, 240, 'drive'); const v18 = count(); reads.mockClear();
    await play(sb, 240, 'drive'); const v19 = count();
    expect(a.collisionBodies().length).toBeGreaterThan(0);
    expect(b.collisionBodies()).toEqual(a.collisionBodies());
    expect(sb.state).toEqual(sa.state); expect(sb.matchHash()).toBe(sa.matchHash());
    // Per-tick presentation reads become one snapshot; occasional reads by terrain commits remain.
    expect(v19 * 10).toBeLessThan(v18);
  } finally { reads.mockRestore(); sa.dispose(); sb.dispose(); a.dispose(); b.dispose(); }
}, 120000);

it('v20 stops for extension tick hooks and host-serviced segment hooks exactly where v19 ran them', async () => {
  const hooks = (): SimExtension => {
    let ticks = 0, impacts = 0, segments = 0;
    return { id: 'tail-hooks',
      onTick: c => { ticks++; if (c.tick === 150) c.damage(1, 5, 'hook'); },
      // Shells detonate when a segment rises above 4.5 units from the planet centre on its way down.
      traceSegment: (_c, p0, p1) => { segments++; const a = Math.hypot(...p0), b = Math.hypot(...p1); return b < a && a > 4.5 && b <= 4.5 ? { t: (a - 4.5) / (a - b), point: p1, normal: [0, 1, 0], kind: 'shell', detonate: true } : null; },
      onImpact: () => { impacts++; },
      snapshot: () => ({ ticks, impacts, segments }), restore: v => { ({ ticks, impacts, segments } = v as { ticks: number; impacts: number; segments: number }); } };
  };
  const a = await botWorld(1, 19), b = await botWorld(2, 20);
  const sa = new GameSimulation(a, setups.drive(), [hooks()]), sb = new GameSimulation(b, setups.drive(), [hooks()]);
  try {
    await play(sa, 300, 'drive'); await play(sb, 300, 'drive');
    const snapshot = sb.extensionSnapshots()['tail-hooks'] as { ticks: number; impacts: number; segments: number };
    expect(snapshot.ticks).toBe(300); expect(snapshot.segments).toBeGreaterThan(0); expect(snapshot.impacts).toBeGreaterThan(0);
    expect(sb.state).toEqual(sa.state); expect(sb.extensionSnapshots()).toEqual(sa.extensionSnapshots()); expect(sb.matchHash()).toBe(sa.matchHash());
  } finally { sa.dispose(); sb.dispose(); a.dispose(); b.dispose(); }
}, 120000);
