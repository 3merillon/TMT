import { setCombatState } from './helpers/native-match';
/** Turn flow rules: aim timer, hold, turn limit, sudden-death hook; impact hits, kill events and flight statistics;
 * friendly fire; the scan event (CC-004). */
import { describe, expect, it } from 'vitest';
import { legacyToKitIds, practiceSetup, type MatchSetup } from '../src/game/api/match';
import type { GameEvent, ImpactEvent } from '../src/game/contracts';
import { add, distance, mul, normalize } from '../src/game/math';
import { FIXED_DT, GameSimulation } from '../src/game/simulation';
import { SphereWorld } from './helpers/sphere-world';

const PLAYER = { tracks: 'scout', barrel: 'mortar', armor: 'light' } as const;
const local = (change: (setup: MatchSetup) => void = () => {}): MatchSetup => { const setup = practiceSetup({ seed: 3, mode: 'local', player: PLAYER }); change(setup); return setup; };
function run(simulation: GameSimulation, ticks: number, each?: () => void): GameEvent[] {
  const events: GameEvent[] = [];
  for (let tick = 0; tick < ticks && simulation.state.phase !== 'finished'; tick++) {
    events.push(...simulation.step(FIXED_DT));
    if (simulation.stalledOn?.serial) simulation.completeLegacyCarve();
    each?.();
  }
  events.push(...simulation.step(0));
  return events;
}

describe('aim timer and hold', () => {
  it('turns an expired aim phase into a hold and passes the turn', () => {
    const simulation = new GameSimulation(new SphereWorld(), local(setup => { setup.rules.aimSeconds = 2; }));
    const events = run(simulation, 119);
    expect(events.some(event => event.type === 'turn')).toBe(false);
    expect(run(simulation, 2)).toContainEqual({ type: 'turn', player: 1 });
    expect(simulation.state.active).toBe(1);
    expect(simulation.state.tanks[0].readyAt).toBe(100);
  });
  it('lets the active tank hold on command, never the defender', () => {
    const simulation = new GameSimulation(new SphereWorld(), local());
    expect(simulation.hold(1)).toBe(false);
    expect(simulation.hold(0)).toBe(true);
    expect(simulation.step(0)).toContainEqual({ type: 'turn', player: 1 });
    expect(simulation.state.projectiles).toEqual([]);
  });
});

describe('turn limit and sudden death', () => {
  it('ends the match after the last turn with the healthiest team as the winner', () => {
    const simulation = new GameSimulation(new SphereWorld(), local(setup => { setup.rules.maxTurns = 3; }));
    setCombatState(simulation, 0, { health: 40 });
    const events = run(simulation, 600, () => { if (simulation.state.phase === 'aim') simulation.hold(simulation.state.active); });
    expect(simulation.state.phase).toBe('finished');
    expect(simulation.state.turn).toBe(3);
    expect(events).toContainEqual({ type: 'finish', winner: 1, team: 1 });
  });
  it('calls a draw when the teams are level at the turn limit', () => {
    const simulation = new GameSimulation(new SphereWorld(), local(setup => { setup.rules.maxTurns = 2; }));
    const events = run(simulation, 600, () => { if (simulation.state.phase === 'aim') simulation.hold(simulation.state.active); });
    expect(events).toContainEqual({ type: 'finish', winner: null, team: null });
  });
  it('raises the sudden-death flag from the configured turn', () => {
    const simulation = new GameSimulation(new SphereWorld(), local(setup => { setup.rules.suddenDeathTurn = 3; }));
    const seen: (boolean | undefined)[] = [];
    run(simulation, 600, () => { if (simulation.state.phase === 'aim') { seen[simulation.state.turn] = simulation.state.suddenDeath; if (simulation.state.turn < 4) simulation.hold(simulation.state.active); } });
    expect(seen.slice(1, 5)).toEqual([undefined, undefined, true, true]);
  });
});

describe('impacts report hits, kills and flight statistics', () => {
  function directHit(change?: (setup: MatchSetup) => void): { events: GameEvent[]; impact: ImpactEvent; simulation: GameSimulation } {
    const simulation = new GameSimulation(new SphereWorld(), local(change));
    run(simulation, 60);
    const muzzle = simulation.muzzle(0);
    simulation.state.tanks[1].position = add(muzzle.position, mul(muzzle.direction, 1.5));
    setCombatState(simulation, 1, { health: 10 });
    simulation.fire(0);
    const events = run(simulation, 60);
    return { events, impact: events.find((event): event is ImpactEvent => event.type === 'impact')!, simulation };
  }
  it('lists every damaged tank, marks the direct and lethal hit, and emits the kill after the impact', () => {
    const { events, impact } = directHit();
    const hit = impact.hits!.find(entry => entry.tank === 1)!;
    expect(hit).toMatchObject({ direct: true, lethal: true, exposure: 1, damage: 10 });
    const self = impact.hits!.find(entry => entry.tank === 0);
    if (self) expect(self.direct).toBe(false);
    expect(events.indexOf(impact)).toBeLessThan(events.findIndex(event => event.type === 'kill'));
    expect(events).toContainEqual({ type: 'kill', tank: 1, by: 0, cause: 'direct' });
  });
  it('measures the flight: ticks, central angle, peak altitude and surface distance', () => {
    const simulation = new GameSimulation(new SphereWorld(), local());
    simulation.state.tanks[1].position = [0, -18.55, 0];
    simulation.aim(0, 0, 1, .6);
    const origin = simulation.muzzle(0).position;
    simulation.fire(0);
    let peak = -Infinity, ticks = 0, impact: ImpactEvent | undefined;
    for (let tick = 0; tick < 900 && !impact; tick++) {
      const events = simulation.step(FIXED_DT);
      ticks++;
      impact = events.find((event): event is ImpactEvent => event.type === 'impact');
      const shell = simulation.state.projectiles[0];
      if (shell) peak = Math.max(peak, Math.hypot(...shell.position) - 18);
    }
    expect(impact).toBeDefined();
    const flight = impact!.flight!;
    expect(flight.ticks).toBe(ticks);
    const angle = Math.acos(Math.min(1, normalize(origin).reduce((sum, value, axis) => sum + value * normalize(impact!.position)[axis], 0)));
    expect(flight.centralAngle).toBeCloseTo(angle, 12);
    expect(flight.distance).toBeCloseTo(angle * 18, 12);
    expect(flight.peakAltitude).toBeGreaterThanOrEqual(peak - 1e-12);
    expect(flight.peakAltitude).toBeGreaterThan(2);
    expect([flight.ricochets, flight.skips]).toEqual([0, 0]);
    expect(distance(origin, impact!.position)).toBeGreaterThan(3);
  });
  it('spares teammates, never the shooter, when friendly fire is off', () => {
    const teamed = (friendlyFire: boolean) => {
      const setup = local(s => { s.rules.friendlyFire = friendlyFire; });
      setup.teams.push({ id: 2, name: 'Rival', ai: false });
      setup.tanks[1].team = 0;
      setup.tanks.push({ team: 2, loadout: legacyToKitIds(PLAYER), spawn: { up: [0, -1, 0], heading: 0 } });
      return setup;
    };
    for (const friendlyFire of [true, false]) {
      const simulation = new GameSimulation(new SphereWorld(), teamed(friendlyFire));
      run(simulation, 30);
      const muzzle = simulation.muzzle(0);
      simulation.state.tanks[1].position = add(muzzle.position, mul(muzzle.direction, 1.5));
      simulation.fire(0);
      const impact = run(simulation, 60).find((event): event is ImpactEvent => event.type === 'impact')!;
      const ally = impact.hits!.find(hit => hit.tank === 1)!;
      expect(ally.damage > 0).toBe(friendlyFire);
    }
  });
});

describe('scan event (CC-004)', () => {
  it('emits the scanner and its position for an accepted scan only', () => {
    const simulation = new GameSimulation(new SphereWorld(), local());
    expect(simulation.scan(0)).toBe(false);
    setCombatState(simulation, 0, { charge: 3 });
    expect(simulation.scan(0)).toBe(true);
    expect(simulation.step(0)).toContainEqual({ type: 'scan', tank: 0, position: simulation.state.tanks[0].position });
  });
});
