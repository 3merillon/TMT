/** The drive capture route, headless (W1-PHY brief, Verify): replays the key schedule of scripts/capture-plans/drive.json
 * (the Appendix B schedule, identical to the brief's capture command) on the real seed-7 resident terrain (GeometryGate
 * stub, no GPU) with the chassis the game uses. Spawns follow GameSimulation: up = normalize(∓0.3, 1, 0), heading ±π/2,
 * ROOT_SURFACE_LIFT above the surface; the opponent idles. The forward leg rams the opponent at top speed, and the
 * forward-left leg starts pressed nose to nose against it.
 *
 * Browser shots take a few ticks with the keys released (the review run: ready at tick 137-138, 5-9 ticks per shot),
 * and a key hold lasts its wall-clock duration at 60 Hz, so the schedule is replayed at nominal timing and with slower
 * shots, shorter holds and longer holds. Every run must stay inside budgets/drive.json: roll ≤ 20° and pitch ≤ 25°
 * against the local vertical, no flip, planted (≤ 3 ticks with neither track loaded); and every steering leg must turn
 * the hull by ≥ 1 rad (turns crisply).
 *
 * Before this fix the rammer reared up on the opponent: the literal schedule measured 31.3° pitch after the forward leg
 * on ground sloped ≤ 2.3°, only 0.43 rad turned in the 2 s forward-left leg, and 62.7° pitch / 45.6° roll overall. */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DriveInput, TankState, V3 } from '../src/game/contracts';
import { ResidentTerrain } from '../src/gpu/terrain/service';
import { residentPlanet } from '../src/gpu/terrain/planet';
import { StructuralPhysics } from '../src/game/structural-physics';
import { ResidentTanks } from '../src/game/resident-tanks';
import { ROOT_SURFACE_LIFT } from '../src/game/kit/dimensions';
import { add, mul, normalize, rotation } from '../src/game/math';
import { FakeTerrainHost, GeometryGate } from './helpers/geometry-gate';
import { DEFAULT, DEG, makeTank, rotateV, TICK } from './helpers/vehicle-world';

const KEYS: Record<string, Partial<DriveInput>> = { KeyW: { throttle: 1 }, KeyS: { throttle: -1 }, KeyA: { steer: -1 }, KeyD: { steer: 1 } };
interface Phase { label: string; input: DriveInput; ticks: number }
interface Timing { name: string; settle: number; shot: number; holdScale: number }
const TIMINGS: readonly Timing[] = [
  { name: 'browser timing', settle: 138, shot: 7, holdScale: 1 },
  { name: 'slow shots', settle: 150, shot: 12, holdScale: 1 },
  { name: 'holds -10 %', settle: 138, shot: 7, holdScale: .9 },
  { name: 'holds +10 %', settle: 138, shot: 7, holdScale: 1.1 },
];

const plan = JSON.parse(readFileSync('scripts/capture-plans/drive.json', 'utf8')) as { jobs: { name: string; url: string; keys: string[] }[] };
function schedule(keys: readonly string[], timing: Timing): Phase[] {
  return keys.flatMap((step): Phase[] => {
    const hold = /^hold:([\w+]+):(\d+)$/.exec(step), wait = /^wait:(\d+)$/.exec(step);
    if (hold) {
      const input = { throttle: 0, steer: 0 };
      for (const key of hold[1].split('+')) { const k = KEYS[key]; if (!k) throw new Error(`Unmapped key ${key}`); input.throttle += k.throttle ?? 0; input.steer += k.steer ?? 0; }
      return [{ label: step, input, ticks: Math.round(+hold[2] * timing.holdScale / 1000 / TICK) }];
    }
    if (wait) return [{ label: step, input: { throttle: 0, steer: 0 }, ticks: Math.round(+wait[1] / 1000 / TICK) }];
    if (step.startsWith('shot:')) return [{ label: step, input: { throttle: 0, steer: 0 }, ticks: timing.shot }];
    if (step.startsWith('eval')) return [];
    throw new Error(`Unmapped capture step ${step}`);
  });
}

let physics: StructuralPhysics, terrain: ResidentTerrain;
// A browser capture starts with a fresh solver. Reusing a world across schedules retains its body-handle
// allocation/contact ordering and can send a later ram onto a different terrain patch. Isolate each replay,
// so running one timing or the complete file exercises the same initial simulation state.
async function initializeTerrain() {
  const input = residentPlanet(7);
  physics = await StructuralPhysics.create(input.planetCenter);
  terrain = new ResidentTerrain(input, new GeometryGate().pages, physics, new FakeTerrainHost());
  await terrain.initialize();
}
beforeEach(initializeTerrain, 180000);
afterEach(() => terrain?.dispose());

const round = (v: number) => +v.toFixed(2);
/** Fresh tanks and terrain for one timing of one job; the chassis bodies are removed afterwards. */
function replay(keys: readonly string[], timing: Timing) {
  const bridge = new ResidentTanks(physics);
  try {
    const tanks: TankState[] = [0, 1].map(id => {
      const up = normalize([id === 0 ? -.3 : .3, 1, 0] as V3), heading = id === 0 ? Math.PI / 2 : -Math.PI / 2, surface = terrain.queries.surface(up);
      if (!surface) throw new Error('No spawn surface');
      return makeTank(id, { loadout: DEFAULT, position: add(surface.point, mul(up, ROOT_SURFACE_LIFT)), rotation: rotation(up, heading) });
    });
    const run = { maxRoll: 0, maxPitch: 0, flips: 0, airborne: 0, minGap: Infinity, distance: 0 };
    const legs: { label: string; maxRoll: number; maxPitch: number; turned: number; minGap: number }[] = [];
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    let last = [...tanks[0].position], heading = tanks[0].heading;
    const step = (drive: DriveInput, leg?: typeof legs[number]) => {
      bridge.beforeStep(tanks, [drive, { throttle: 0, steer: 0 }], TICK); terrain.step(); bridge.afterStep(tanks, TICK);
      if (!leg) return;
      const t = tanks[0], up = normalize(t.position), dotUp = (v: V3) => v[0] * up[0] + v[1] * up[1] + v[2] * up[2];
      const roll = Math.abs(Math.asin(clamp(dotUp(rotateV([1, 0, 0], t.rotation))))) / DEG, pitch = Math.abs(Math.asin(clamp(dotUp(rotateV([0, 0, 1], t.rotation))))) / DEG;
      const gap = Math.hypot(...t.position.map((v, i) => v - tanks[1].position[i]));
      leg.maxRoll = Math.max(leg.maxRoll, roll); leg.maxPitch = Math.max(leg.maxPitch, pitch); leg.minGap = Math.min(leg.minGap, gap);
      leg.turned += Math.atan2(Math.sin(t.heading - heading), Math.cos(t.heading - heading)); heading = t.heading;
      run.maxRoll = Math.max(run.maxRoll, roll); run.maxPitch = Math.max(run.maxPitch, pitch); run.minGap = Math.min(run.minGap, gap);
      if (dotUp(rotateV([0, 1, 0], t.rotation)) < 0) run.flips++;
      if (!(t.trackContact[0] > 0) && !(t.trackContact[1] > 0)) run.airborne++;
      run.distance += Math.hypot(...t.position.map((v, i) => v - last[i])); last = [...t.position];
    };
    for (let i = 0; i < timing.settle; i++) step({ throttle: 0, steer: 0 });
    last = [...tanks[0].position]; heading = tanks[0].heading;
    const phases = schedule(keys, timing);
    for (const phase of phases) {
      const leg = { label: phase.label, maxRoll: 0, maxPitch: 0, turned: 0, minGap: Infinity };
      for (let i = 0; i < phase.ticks; i++) step(phase.input, leg);
      legs.push(leg);
    }
    // A steering leg's net heading change, including the shot after it (the hull keeps yawing while the belts brake).
    const steeringTurns = phases.flatMap((phase, k) => phase.input.steer === 0 ? [] : [round(Math.abs(legs[k].turned + (phases[k + 1]?.label.startsWith('shot:') ? legs[k + 1].turned : 0)))]);
    return { run: Object.fromEntries(Object.entries(run).map(([k, v]) => [k, round(v)])) as typeof run, steeringTurns,
      legs: legs.filter(l => l.label.startsWith('hold')).map(l => ({ label: l.label, maxRoll: round(l.maxRoll), maxPitch: round(l.maxPitch), turned: round(l.turned), minGap: round(l.minGap) })) };
  } finally { bridge.dispose(); }
}

describe('drive capture route on seed 7', () => {
  it('the plan replays the brief capture command (Appendix B)', () => {
    const job = plan.jobs[0];
    expect(job.url).toBe('/play.html?mode=drive&seed=7');
    expect(job.keys.filter(k => /^(hold|shot|wait):/.test(k))).toEqual(
      ['shot:ready', 'hold:KeyW:3000', 'shot:fwd', 'hold:KeyA+KeyW:2000', 'shot:turn', 'hold:KeyS:1500', 'shot:back', 'hold:KeyW+KeyD:3000', 'shot:slope']);
  });
  for (const job of plan.jobs) for (const timing of TIMINGS) {
    it(`${job.name}, ${timing.name}: planted, roll ≤ 20°, pitch ≤ 25°, no flip, every steering leg turns ≥ 1 rad`, () => {
      const r = replay(job.keys, timing), report = JSON.stringify(r);
      expect(r.run.maxRoll, report).toBeLessThanOrEqual(20);
      expect(r.run.maxPitch, report).toBeLessThanOrEqual(25);
      expect(r.run.flips, report).toBe(0);
      expect(r.run.airborne, report).toBeLessThanOrEqual(3);
      expect(r.run.distance, report).toBeGreaterThan(10);
      expect(r.steeringTurns.length, report).toBeGreaterThan(0);
      for (const turned of r.steeringTurns) expect(turned, report).toBeGreaterThanOrEqual(1);
    }, 60000);
  }
  it('repeats the isolated slow-shot capture deterministically from a fresh game world', async () => {
    const timing = TIMINGS.find(t => t.name === 'slow shots')!, first = replay(plan.jobs[0].keys, timing);
    terrain.dispose(); await initializeTerrain();
    expect(replay(plan.jobs[0].keys, timing)).toEqual(first);
  }, 60000);
});
