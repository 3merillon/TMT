/** Deterministic match wind (src/world/weather.ts): a pure function of (seed, tick), a tangent acceleration scaled per
 * munition, and one integrator shared by the preview, the brains and live shots. */
import { describe, expect, it } from 'vitest';
import { practiceSetup, type MatchSetup } from '../src/game/api/match';
import type { BallisticTrace } from '../src/game/api/bot';
import type { ImpactEvent, V3 } from '../src/game/contracts';
import { distance, dot, normalize } from '../src/game/math';
import { windFactor } from '../src/game/munitions';
import { assembleKit, kitLoadoutFromLegacy } from '../src/game/kit';
import { FIXED_DT, GameSimulation } from '../src/game/simulation';
import { fbm1, sampleWind, WIND_ACCEL_PER_BAR, windAcceleration } from '../src/world/weather';
import { SphereWorld } from './helpers/sphere-world';

const RULE = { mean: 3, gust: 1.5, period: 5 };

describe('sampleWind', () => {
  it('is a pure function of (seed, tick, rule)', () => {
    for (const tick of [0, 1, 59, 600, 12345]) expect(sampleWind(7, tick, RULE)).toEqual(sampleWind(7, tick, RULE));
    expect(sampleWind(7, 600, RULE)).not.toEqual(sampleWind(8, 600, RULE));
    expect(() => sampleWind(7, -1, RULE)).toThrow(/tick/);
    expect(() => sampleWind(7, 1.5, RULE)).toThrow(/tick/);
    expect(() => sampleWind(7, 0, { ...RULE, period: 0 })).toThrow(/wind rule/);
  });

  it('keeps the Pinionfall noise channel bounded and gusting around the mean', () => {
    const bars = Array.from({ length: 3600 }, (_, tick) => sampleWind(3, tick * 5, RULE).bars);
    expect(Math.min(...bars)).toBeGreaterThanOrEqual(RULE.mean - RULE.gust - 1e-12);
    expect(Math.max(...bars)).toBeLessThanOrEqual(RULE.mean + RULE.gust + 1e-12);
    expect(Math.max(...bars) - Math.min(...bars)).toBeGreaterThan(RULE.gust);
    const mean = bars.reduce((a, b) => a + b, 0) / bars.length;
    expect(Math.abs(mean - RULE.mean)).toBeLessThan(.6);
    for (let t = -20; t < 20; t += .37) expect(Math.abs(fbm1(t, 11))).toBeLessThanOrEqual(1);
    // Calm rules are exactly calm; 5 bars is 1.2 u/s² (12 % of g).
    expect(sampleWind(3, 900, { mean: 0, gust: 0, period: 4 }).strength).toBe(0);
    expect(sampleWind(3, 900, { mean: 5, gust: 0, period: 4 }).strength).toBeCloseTo(5 * WIND_ACCEL_PER_BAR, 12);
    expect(5 * WIND_ACCEL_PER_BAR).toBeCloseTo(1.2, 12);
  });

  it('is a tangent field, strongest on its equator and blowing along the heading at +Y', () => {
    const state = sampleWind(5, 1200, RULE);
    for (const p of [[0, 18, 0], [3, 17, -2], [-12, 5, 9], [0, -18, .1]] as V3[]) {
      const a = windAcceleration(state, p);
      expect(Math.abs(dot(a, normalize(p)))).toBeLessThan(1e-12);
      expect(Math.hypot(...a)).toBeLessThanOrEqual(state.strength + 1e-12);
    }
    const top = windAcceleration(state, [0, 18, 0]);
    expect(Math.hypot(...top)).toBeCloseTo(state.strength, 12);
    expect(top[0] / state.strength).toBeCloseTo(Math.sin(state.heading), 12);
    expect(top[2] / state.strength).toBeCloseTo(Math.cos(state.heading), 12);
  });

  it('scales per munition and weapon (HE 1, heavy 0.6, rail 0.2)', () => {
    const kit = (barrel: 'mortar' | 'rail') => assembleKit(kitLoadoutFromLegacy({ tracks: 'scout', barrel, armor: 'light' }));
    expect(windFactor(kit('mortar'), 'explosive')).toBe(1);
    expect(windFactor(kit('mortar'), 'heavy')).toBeCloseTo(.6, 12);
    expect(windFactor(kit('rail'), 'explosive')).toBeCloseTo(.2, 12);
  });
});

describe('one wind for the preview, the brains and live shots', () => {
  const windy = (seed = 9): MatchSetup => {
    const setup = practiceSetup({ seed, mode: 'local', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } });
    setup.rules.wind = RULE;
    return setup;
  };
  function shoot(setup: MatchSetup, aim: [number, number, number]): { preview: V3[]; impact: ImpactEvent; simulation: GameSimulation } {
    const simulation = new GameSimulation(new SphereWorld(), setup);
    for (let tick = 0; tick < 45; tick++) simulation.step(FIXED_DT);
    simulation.state.tanks[1].position = [0, -18.55, 0];
    simulation.aim(0, ...aim);
    const preview = simulation.preview(0);
    simulation.fire(0); simulation.endMove(0);
    let impact: ImpactEvent | undefined;
    for (let tick = 0; tick < 700 && !impact; tick++) impact = simulation.step(FIXED_DT).find((event): event is ImpactEvent => event.type === 'impact');
    return { preview, impact: impact!, simulation };
  }

  it('publishes the same wind in the snapshot every tick', () => {
    const simulation = new GameSimulation(new SphereWorld(), windy());
    for (let tick = 0; tick < 30; tick++) {
      simulation.step(FIXED_DT);
      expect(simulation.state.wind).toEqual(sampleWind(9, simulation.state.tick, RULE));
    }
    expect(new GameSimulation(new SphereWorld(), practiceSetup({ seed: 9, mode: 'bot', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } })).state.wind).toBeNull();
  });

  it('lands a live shot exactly where the preview said, and the wind moves it', () => {
    const aim: [number, number, number] = [0.9, 0.9, 0.55];
    const windyShot = shoot(windy(), aim);
    expect(distance(windyShot.preview.at(-1)!, windyShot.impact.position)).toBeLessThan(1e-9);
    const still = windy(); still.rules.wind = null;
    const stillShot = shoot(still, aim);
    expect(distance(stillShot.impact.position, windyShot.impact.position)).toBeGreaterThan(.2);
    const environment = windy(); environment.environment = { weatherSeed: 424242 };
    const reseeded = shoot(environment, aim);
    expect(distance(reseeded.impact.position, windyShot.impact.position)).toBeGreaterThan(1e-6);
    expect(distance(reseeded.preview.at(-1)!, reseeded.impact.position)).toBeLessThan(1e-9);
  });

  it('traces a brain shot through the wind of its planned fire tick, not the tick of the search', () => {
    // BotObservation.trace(…, launchTick): a search made now for a shot fired `lead` ticks later flies the live shell's air.
    type Tracer = { trace(id: number, aim: { yaw: number; pitch: number; power: number }, unmetered: boolean, launchTick?: number): BallisticTrace };
    const aim = { yaw: .9, pitch: .9, power: .55 }, lead = 150;
    const simulation = new GameSimulation(new SphereWorld(), windy());
    simulation.state.tanks[1].position = [0, -18.55, 0];
    simulation.aim(0, aim.yaw, aim.pitch, aim.power);
    const impactOf = (launchTick?: number) => {
      const trace = (simulation as unknown as Tracer).trace(0, aim, true, launchTick);
      for (let guard = 0; guard < 2000 && trace.step(); guard++);
      return trace.impact!;
    };
    const planned = impactOf(simulation.state.tick + lead), now = impactOf();
    for (let tick = 0; tick < lead; tick++) simulation.step(FIXED_DT);
    simulation.fire(0); simulation.endMove(0);
    let impact: ImpactEvent | undefined;
    for (let tick = 0; tick < 700 && !impact; tick++) impact = simulation.step(FIXED_DT).find((event): event is ImpactEvent => event.type === 'impact');
    expect(distance(planned, impact!.position)).toBeLessThan(1e-9);
    expect(distance(now, impact!.position)).toBeGreaterThan(1e-3);
  });

  it('gives the legacy brain the same air: its shots come from the shared integrator and stay deterministic', () => {
    const setup = practiceSetup({ seed: 4, mode: 'bot', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } });
    setup.rules.wind = RULE;
    const run = () => {
      const simulation = new GameSimulation(new SphereWorld(), setup);
      simulation.aim(0, 1, .5, .25); simulation.fire(0); simulation.endMove(0);
      const impacts: V3[] = [];
      for (let tick = 0; tick < 1200; tick++) {
        for (const event of simulation.step(FIXED_DT)) if (event.type === 'impact') impacts.push(event.position);
        if (simulation.stalledOn?.serial) simulation.completeLegacyCarve();
      }
      return impacts;
    };
    const first = run();
    expect(first.length).toBeGreaterThanOrEqual(2);
    expect(run()).toEqual(first);
  });
});
