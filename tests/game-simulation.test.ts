/** Match rules on the kinematic sphere-world chassis (tests/helpers/sphere-world): turns, terrain commits, radar,
 * observation-only contacts, checkpoints, ammunition and the seeded bot duel. Vehicle handling lives in vehicle-* (W1-PHY). */
import { describe, expect, it } from 'vitest';
import { setCombatState } from './helpers/native-match';
import type { GameEvent, V3, WorldQuery } from '../src/game/contracts';
import { add, distance, dot, mul, sub, wrapAngle } from '../src/game/math';
import { DEFAULT_LOADOUT, getLaunchSpeed, getTankStats, getWheelOffsets, LOADOUT_BUDGET, MODULE_CATALOG, validateLoadout } from '../src/game/modules';
import { FIXED_DT, GameSimulation, MatchReplay, MAX_BARREL_PITCH, MAX_PROJECTILE_AGE, MIN_BARREL_PITCH, MOVE_SECONDS, RADAR_COST } from '../src/game/simulation';
import { practiceSetup } from '../src/game/api/match';
import type { LegacyBrain } from '../src/game/ai/legacy';
import { LAUNCH_SPEED_SCALE } from '../src/game/world-constants';
import { SphereWorld } from './helpers/sphere-world';
import { assembleKit, kitLoadoutFromLegacy } from '../src/game/kit';
import type { Loadout } from '../src/game/contracts';

/** The kit v2 assembly a legacy loadout maps to (the sim reads hp, fuel and the elevation envelope from it). */
const kitOf = (loadout: Loadout) => assembleKit(kitLoadoutFromLegacy(loadout));

function ticks(simulation: GameSimulation, count: number, drive = { throttle: 0, steer: 0 }, commitTerrain = false): GameEvent[] {
  const events: GameEvent[] = [];
  for (let index = 0; index < count; index++) {
    events.push(...simulation.step(FIXED_DT, drive));
    if (commitTerrain && simulation.stalledOn?.serial) simulation.completeLegacyCarve();
  }
  events.push(...simulation.step(0));
  return events;
}

function hideOpponent(simulation: GameSimulation): void {
  simulation.state.tanks[1].position = [0, -18.55, 0];
  simulation.state.tanks[1].velocity = [0, 0, 0];
}

describe('canonical modular loadouts', () => {
  it('rejects unknown/prototype IDs and over-budget combinations', () => {
    expect(validateLoadout(DEFAULT_LOADOUT)).toBe(true);
    expect(validateLoadout({ tracks: 'grip', barrel: 'rail', armor: 'heavy' })).toBe(false);
    expect(validateLoadout({ ...DEFAULT_LOADOUT, tracks: '__proto__' })).toBe(false);
    expect(validateLoadout({ ...DEFAULT_LOADOUT, barrel: 'paid-damage' })).toBe(false);
    expect(validateLoadout(null)).toBe(false);
    expect(() => getTankStats({ tracks: 'grip', barrel: 'rail', armor: 'heavy' })).toThrow();
  });

  it('makes armor and traction real tradeoffs within the same canonical budget', () => {
    const light = getTankStats(DEFAULT_LOADOUT);
    const heavy = getTankStats({ ...DEFAULT_LOADOUT, armor: 'heavy' });
    const grip = getTankStats({ ...DEFAULT_LOADOUT, tracks: 'grip' });
    expect(heavy.maxHealth).toBeGreaterThan(light.maxHealth);
    expect(heavy.mass).toBeGreaterThan(light.mass);
    expect(heavy.speed).toBeLessThan(light.speed);
    expect(grip.grip).toBeGreaterThan(light.grip);
    expect(grip.speed).toBeLessThan(light.speed);
    expect(heavy.cost).toBeLessThanOrEqual(LOADOUT_BUDGET);
    for (const barrel of Object.values(MODULE_CATALOG.barrel)) expect(barrel.blastRadius).toBeGreaterThanOrEqual(2);
  });
});

describe('fixed tick turn and terrain rules', () => {
  it('has identical results at 30/60 Hz and bounded catch-up after a stalled tab', () => {
    const thirty = new GameSimulation(new SphereWorld(), { bot: false });
    const sixty = new GameSimulation(new SphereWorld(), { bot: false });
    for (let count = 0; count < 60; count++) thirty.step(1 / 30);
    ticks(sixty, 120);
    expect(thirty.state).toEqual(sixty.state);
    const before = thirty.state.tick;
    thirty.step(10);
    expect(thirty.state.tick - before).toBe(8);
  });

  it('denies defender actions and aim-phase movement, and emits fire through step', () => {
    const simulation = new GameSimulation(new SphereWorld(), { bot: false });
    const heading = simulation.state.tanks[0].heading;
    ticks(simulation, 20, { throttle: 1, steer: 1 });
    expect(simulation.state.tanks[0].heading).toBe(heading);
    expect(simulation.aim(1, 0, 0.5, 0.5)).toBe(false);
    expect(simulation.fire(1)).toBe(false);
    expect(simulation.scan(1)).toBe(false);
    expect(simulation.endMove(1)).toBe(false);
    expect(simulation.fire(0)).toBe(true);
    expect(simulation.fire(0)).toBe(false);
    expect(simulation.step(0)).toMatchObject([{ type: 'shot', player: 0, launch: { munition: 'explosive', weapon: 'mortar' } }]);
    const defenderHeading = simulation.state.tanks[1].heading;
    ticks(simulation, 20, { throttle: 1, steer: 1 });
    expect(simulation.state.tanks[0].heading).not.toBe(heading);
    expect(simulation.state.tanks[1].heading).toBe(defenderHeading);
    expect(simulation.setLoadout(0, { ...DEFAULT_LOADOUT, armor: 'heavy' })).toBe(false);
  });

  it('withholds handover while terrain is pending and completes a finite turn', () => {
    const simulation = new GameSimulation(new SphereWorld(), { bot: false });
    hideOpponent(simulation);
    simulation.fire(0);
    simulation.endMove(0);
    const events = ticks(simulation, 600);
    expect(events.some(event => event.type === 'impact')).toBe(true);
    expect(simulation.stalledOn?.serial).toBe(true);
    expect(simulation.state.active).toBe(0);
    const pendingTick = simulation.state.tick;
    simulation.step(100);
    expect(simulation.state.tick).toBe(pendingTick);
    simulation.completeLegacyCarve();
    expect(simulation.state.phase).toBe('aim');
    expect(simulation.state.active).toBe(1);
    expect(simulation.state.tanks.map(tank => tank.charge)).toEqual([2, 1]);
    expect(simulation.step(0)).toContainEqual({ type: 'turn', player: 1 });
  });

  it('caps relocation independently of shell lifetime and prevents repeated loadout healing', () => {
    const simulation = new GameSimulation(new SphereWorld(), { bot: false });
    hideOpponent(simulation);
    ticks(simulation, 90);
    const start = [...simulation.state.tanks[0].position] as V3;
    simulation.aim(0, 0, 1.4, 1);
    simulation.fire(0);
    ticks(simulation, Math.ceil(MOVE_SECONDS / FIXED_DT) + 5, { throttle: 1, steer: 0 }, true);
    expect(simulation.state.tanks[0].movement).toBe(0);
    expect(distance(start, simulation.state.tanks[0].position)).toBeGreaterThan(1);
    // Relocation fuel is the kit's (kit v2: the Warden/Scout build carries 8.35 u, v1 carried 7.5).
    expect(distance(start, simulation.state.tanks[0].position)).toBeLessThan(kitOf(DEFAULT_LOADOUT).stats.fuel + 0.5);
    ticks(simulation, Math.ceil(MAX_PROJECTILE_AGE / FIXED_DT), { throttle: 0, steer: 0 }, true);
    expect(simulation.state.active).toBe(1);
    expect(simulation.state.phase).toBe('aim');
    expect(simulation.setLoadout(0, DEFAULT_LOADOUT)).toBe(false);
  });

  it('ends a bot move after recovery cannot move the chassis, before the 30 second limit', () => {
    const sphere = new SphereWorld();
    const blocked: WorldQuery = {
      radius: sphere.radius, version: 0,
      raycast: () => null, surface: direction => sphere.surface(direction), isSolid: point => sphere.isSolid(point),
      stepTanks: () => {},
    };
    const simulation = new GameSimulation(blocked, { bot: false });
    const harness = simulation as unknown as { brainInstances: ({ drive(): { throttle: number; steer: number } } | null)[] };
    harness.brainInstances[0] = { drive: () => ({ throttle: 1, steer: 0 }) };
    expect(simulation.fire(0)).toBe(true);
    ticks(simulation, Math.ceil(9 / FIXED_DT));
    expect(simulation.state.time).toBeLessThan(MOVE_SECONDS);
    expect(simulation.state.tanks[0].movement).toBe(0);
    expect(simulation.state.active).toBe(1);
  });

  it('applies CCD direct-hit damage and finishes only after the terrain commit', () => {
    const simulation = new GameSimulation(new SphereWorld(), { bot: false });
    ticks(simulation, 90);
    const muzzle = simulation.muzzle(0);
    simulation.state.tanks[1].position = add(muzzle.position, mul(muzzle.direction, 1.5));
    setCombatState(simulation, 1, { health: 1 });
    simulation.fire(0);
    const events = ticks(simulation, 40);
    expect(events.some(event => event.type === 'impact')).toBe(true);
    expect(simulation.state.tanks[1].health).toBe(0);
    expect(simulation.stalledOn?.serial).toBe(true);
    expect(events.some(event => event.type === 'finish')).toBe(false);
    simulation.completeLegacyCarve();
    expect(simulation.state.winner).toBe(0);
    expect(simulation.step(0)).toContainEqual({ type: 'finish', winner: 0, team: 0 });
  });
});

describe('trajectory, support and observations', () => {
  it('bounds the moving launch cue to 21 trace ticks and keeps full prediction opt-in', () => {
    const sphere = new SphereWorld();
    let rays = 0;
    const query: WorldQuery = {
      radius: sphere.radius, version: 0, isSolid: point => sphere.isSolid(point), surface: direction => sphere.surface(direction),
      raycast: (origin, direction, extent) => { rays++; return sphere.raycast(origin, direction, extent); },
    };
    const simulation = new GameSimulation(query, { bot: false });
    rays = 0;
    const cue = simulation.preview(0, false);
    expect(cue.length).toBeLessThanOrEqual(8);
    expect(rays).toBeLessThanOrEqual(22); // 21 flight segments plus the barrel obstruction guard.
    const queries = rays;
    expect(simulation.preview(0, false)).toEqual(cue);
    expect(rays).toBe(queries);
    expect(simulation.preview(0).length).toBeGreaterThan(cue.length);
  });

  it('distinguishes a landing from a shortened or expired preview without changing canonical state', () => {
    const simulation = new GameSimulation(new SphereWorld(), { bot: false });
    const before = simulation.matchHash();
    expect(simulation.previewPrediction(0, false).hit).toBe(false);
    const landing = simulation.previewPrediction(0);
    expect(landing.hit).toBe(true);
    expect(landing.points).toEqual(simulation.preview(0));
    const endpoint = [...landing.points.at(-1)!];
    landing.points.at(-1)![0] += 100;
    expect(simulation.previewPrediction(0).points.at(-1)).toEqual(endpoint);
    expect(simulation.matchHash()).toBe(before);

    const setup = practiceSetup({ seed: 7, mode: 'drive', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } });
    setup.rules.projectileAge = .5;
    const brief = new GameSimulation(new SphereWorld(), setup);
    brief.aim(0, 0, 1.1, 1);
    expect(brief.previewPrediction(0).hit).toBe(false);
    expect(brief.previewPrediction(99)).toEqual({ points: [], hit: false });
  });

  it.each(['mortar', 'cannon', 'rail'] as const)('allows genuinely close %s shots at both depressed and steep elevation', barrel => {
    // The extremes are the kit's front-arc envelope (kit v2's Dome: -15 to 75 deg), inside the global barrel range.
    const limits = kitOf({ ...DEFAULT_LOADOUT, barrel }).pitchLimits(0);
    expect(limits.min).toBeGreaterThanOrEqual(MIN_BARREL_PITCH); expect(limits.max).toBeLessThanOrEqual(MAX_BARREL_PITCH);
    for (const pitch of [limits.min, limits.max]) {
      const simulation = new GameSimulation(new SphereWorld(), { bot: false, loadout: { ...DEFAULT_LOADOUT, barrel } });
      hideOpponent(simulation);
      ticks(simulation, 120);
      expect(simulation.aim(0, 0, pitch, 0)).toBe(true);
      expect(simulation.state.tanks[0].barrelPitch).toBe(pitch);
      const origin = [...simulation.state.tanks[0].position] as V3;
      simulation.fire(0); simulation.endMove(0);
      const impact = ticks(simulation, 180).find(event => event.type === 'impact');
      expect(impact?.type).toBe('impact');
      if (impact?.type === 'impact') expect(distance(origin, impact.position)).toBeLessThan(3);
    }
  });

  it('spends more power-slider travel on close shots while preserving each barrel maximum', () => {
    for (const barrel of ['mortar', 'cannon', 'rail'] as const) {
      const loadout = { ...DEFAULT_LOADOUT, barrel }, stats = getTankStats(loadout);
      // Unified gravity: every kit launch speed is scaled by sqrt(9.81 / 7.5) (world-constants).
      expect(getLaunchSpeed(loadout, 0)).toBe(LAUNCH_SPEED_SCALE * stats.minSpeed);
      expect(getLaunchSpeed(loadout, 1)).toBe(LAUNCH_SPEED_SCALE * stats.maxSpeed);
      expect(getLaunchSpeed(loadout, .5)).toBeLessThan(LAUNCH_SPEED_SCALE * (stats.minSpeed + stats.maxSpeed) / 2);
    }
    expect(getLaunchSpeed({ ...DEFAULT_LOADOUT, barrel: 'rail' }, .55)).toBeLessThan(11.1 * LAUNCH_SPEED_SCALE);
  });

  it('accepts a depressed aim in a recovered match and clamps the canonical range', () => {
    const world = new SphereWorld(), simulation = new GameSimulation(world, { bot: false });
    const limits = kitOf(DEFAULT_LOADOUT).pitchLimits(0);
    simulation.aim(0, 0, -1, 0);
    expect(simulation.state.tanks[0].barrelPitch).toBe(limits.min);
    const replay = new MatchReplay(new SphereWorld(), simulation.checkpoint());
    expect(replay.advance()).toBe('done');
    const restored = replay.simulation;
    expect(restored.state.tanks[0].barrelPitch).toBe(limits.min);
    restored.aim(0, 0, 2, 0);
    expect(restored.state.tanks[0].barrelPitch).toBe(limits.max);
  });

  it('hits an obstruction between breech and muzzle instead of launching through it', () => {
    const sphere = new SphereWorld();
    let wall: { point: V3; normal: V3 } | null = null;
    const query: WorldQuery = {
      radius: sphere.radius, version: 0, isSolid: point => sphere.isSolid(point), surface: direction => sphere.surface(direction),
      raycast: (origin, direction, extent) => {
        const ground = sphere.raycast(origin, direction, extent);
        if (!wall) return ground;
        const denominator = dot(direction, wall.normal);
        if (Math.abs(denominator) < 1e-8) return ground;
        const at = dot(sub(wall.point, origin), wall.normal) / denominator;
        return at >= 0 && at <= extent && (!ground || at < ground.distance)
          ? { point: add(origin, mul(direction, at)), normal: wall.normal, distance: at, material: 4 } : ground;
      },
    };
    const simulation = new GameSimulation(query, { bot: false, loadout: { ...DEFAULT_LOADOUT, barrel: 'rail' } });
    ticks(simulation, 120);
    simulation.aim(0, 0, MIN_BARREL_PITCH, .5);
    const socket = simulation.muzzle(0);
    wall = { point: sub(socket.position, mul(socket.direction, .35)), normal: mul(socket.direction, -1) };
    simulation.fire(0);
    const impact = simulation.step(FIXED_DT).find(event => event.type === 'impact');
    expect(impact?.type).toBe('impact');
    if (impact?.type === 'impact') expect(distance(impact.position, wall.point)).toBeLessThan(1e-6);
  });

  it.each(['mortar', 'cannon', 'rail'] as const)('matches the %s preview endpoint to the actual terrain impact', barrel => {
    const simulation = new GameSimulation(new SphereWorld(), { bot: false, loadout: { ...DEFAULT_LOADOUT, barrel } });
    hideOpponent(simulation);
    ticks(simulation, 90);
    simulation.aim(0, 0.65, 0.7, 0.15);
    const preview = simulation.preview(0);
    expect(preview[0]).toEqual(simulation.muzzle(0).position);
    expect(simulation.previewPrediction(0).hit).toBe(true);
    simulation.fire(0);
    simulation.endMove(0);
    const impact = ticks(simulation, Math.ceil(MAX_PROJECTILE_AGE / FIXED_DT) + 1).find(event => event.type === 'impact');
    expect(impact?.type).toBe('impact');
    if (impact?.type === 'impact') expect(distance(preview[preview.length - 1], impact.position)).toBeLessThan(1e-8);
  });

  it('retains a last-seen observation rather than tracking a hidden relocation', () => {
    const simulation = new GameSimulation(new SphereWorld(), { bot: false });
    expect(simulation.state.contacts[0]?.visible).toBe(true);
    const known = [...simulation.state.contacts[0]!.position];
    hideOpponent(simulation);
    ticks(simulation, 12);
    expect(simulation.state.contacts[0]?.visible).toBe(false);
    expect(simulation.state.contacts[0]?.position).toEqual(known);
    const preview = simulation.preview(0);
    simulation.state.tanks[1].position = [18.55, 0, 0];
    expect(simulation.preview(0)).toEqual(preview);
  });

  it('spends bounded radar charge on an imperfect, timestamped snapshot', () => {
    const simulation = new GameSimulation(new SphereWorld(), { bot: false, seed: 4 });
    hideOpponent(simulation);
    ticks(simulation, 12);
    expect(simulation.scan(0)).toBe(false);
    setCombatState(simulation, 0, { charge: RADAR_COST });
    expect(simulation.scan(0)).toBe(true);
    const contact = simulation.state.contacts[0]!;
    expect(contact.source).toBe('scan');
    expect(contact.visible).toBe(false);
    expect(distance(contact.position, simulation.state.tanks[1].position)).toBeGreaterThan(0.5);
    expect(distance(contact.position, simulation.state.tanks[1].position)).toBeLessThan(2);
    expect(simulation.state.tanks[0].charge).toBe(0);
    expect(simulation.scan(0)).toBe(false);
    const scannedPosition = [...contact.position];
    simulation.state.tanks[1].position = [0, -18.55, 2];
    ticks(simulation, 12);
    expect(simulation.state.contacts[0]?.position).toEqual(scannedPosition);
  });

  it('runs a seeded bounded bot turn through the same ballistic pipeline', () => {
    const play = () => {
      const simulation = new GameSimulation(new SphereWorld(), { bot: true, seed: 11 });
      simulation.aim(0, 1, 0.5, 0.25);
      simulation.fire(0);
      simulation.endMove(0);
      const events = ticks(simulation, 1000, { throttle: 0, steer: 0 }, true);
      return { state: simulation.state, events };
    };
    const first = play();
    expect(first.events).toContainEqual(expect.objectContaining({ type: 'shot', player: 1 }));
    expect(first.events.some(event => event.type === 'impact' && event.owner === 1)).toBe(true);
    expect(first.state.turn).toBeGreaterThanOrEqual(3);
    expect(play()).toEqual(first);
  });

  it('steers the bot toward its relocation heading under the driver-facing input convention', () => {
    const simulation = new GameSimulation(new SphereWorld(), { bot: true, seed: 11 });
    simulation.aim(0, 1, .5, .25); simulation.fire(0); simulation.endMove(0);
    let fired = false;
    for (let tick = 0; tick < 900 && !fired; tick++) {
      const events = simulation.step(FIXED_DT);
      if (simulation.stalledOn?.serial) simulation.completeLegacyCarve();
      fired = events.some(event => event.type === 'shot' && event.player === 1);
    }
    expect(fired).toBe(true);
    const target = (simulation.brainFor(1) as LegacyBrain).heading;
    const before = Math.abs(wrapAngle(target - simulation.state.tanks[1].heading));
    ticks(simulation, 35, { throttle: 0, steer: 0 }, true);
    const after = Math.abs(wrapAngle(target - simulation.state.tanks[1].heading));
    expect(after).toBeLessThan(before * .8);
  });
});

describe('local unrestricted drive test', () => {
  it('keeps the loadout-specific wheel stations of the kit', () => {
    expect(getWheelOffsets(DEFAULT_LOADOUT)[0]).toEqual([.55, -.5, -.59]);
    expect(getWheelOffsets({ ...DEFAULT_LOADOUT, tracks: 'grip' })[3]).toEqual([.55, -.5, .62]);
  });

  it('drives before firing and beyond the turn allowance without passing to AI', () => {
    const simulation = new GameSimulation(new SphereWorld(), { driveTest: true });
    hideOpponent(simulation);
    const start = [...simulation.state.tanks[0].position] as V3;
    ticks(simulation, 480, { throttle: 1, steer: 0 });
    expect(distance(start, simulation.state.tanks[0].position)).toBeGreaterThan(getTankStats(DEFAULT_LOADOUT).moveDistance + 2);
    expect(simulation.driveTest).toBe(true);
    expect(simulation.state.phase).toBe('aim');
    expect(simulation.state.active).toBe(0);
    expect(simulation.state.turn).toBe(1);
    expect(simulation.endMove(0)).toBe(false);
  });

  it('allows repeated shots after the terrain commit with no health loss or winner lock', () => {
    const simulation = new GameSimulation(new SphereWorld(), { driveTest: true });
    hideOpponent(simulation);
    for (let shot = 0; shot < 3; shot++) {
      ticks(simulation, 120);
      expect(simulation.aim(0, 0, MIN_BARREL_PITCH, 0)).toBe(true);
      expect(simulation.canFire(0)).toBe(true);
      expect(simulation.canFire(1)).toBe(false);
      expect(simulation.fire(0)).toBe(true);
      expect(simulation.fire(0)).toBe(false);
      expect(ticks(simulation, 180).some(event => event.type === 'impact')).toBe(true);
      const pending = [...simulation.state.tanks[0].position];
      ticks(simulation, 120, { throttle: 1, steer: 1 });
      expect(simulation.state.tanks[0].position).toEqual(pending);
      expect(simulation.fire(0)).toBe(false);
      simulation.completeLegacyCarve();
      expect(simulation.state.phase).toBe('aim');
      expect(simulation.state.tanks[0].health).toBe(kitOf(DEFAULT_LOADOUT).stats.hp);
      expect(simulation.state.winner).toBe(null);
      expect(simulation.state.turn).toBe(1);
    }
  });
});


describe('selectable ammunition', () => {
  it('changes trajectory, locks ammo into an in-flight shell, and restores it in checkpoints', () => {
    const world = new SphereWorld(), game = new GameSimulation(world, { bot: false, driveTest: true });
    const baseline = game.preview(0);
    expect(game.selectMunition(0, 'nuclear')).toBe(true);
    expect(game.preview(0)).not.toEqual(baseline);
    expect(game.fire(0)).toBe(true);
    expect(game.state.projectiles[0].munition).toBe('nuclear');
    expect(game.selectMunition(0, 'incendiary')).toBe(true);
    expect(game.state.projectiles[0].munition).toBe('nuclear');
    const charged = practiceSetup({ seed: 1977, mode: 'local', player: DEFAULT_LOADOUT });
    charged.rules.startCharge = 3; // the nuke is charge-gated (rules-ammo)
    const saved = new GameSimulation(world, charged);
    saved.selectMunition(0, 'nuclear'); expect(saved.fire(0)).toBe(true);
    const replay = new MatchReplay(new SphereWorld(), saved.checkpoint());
    expect(replay.advance()).toBe('done');
    const restored = replay.simulation;
    expect(restored.state.projectiles[0].munition).toBe('nuclear');
    const events = ticks(restored, 600, undefined, true);
    expect(events.some(e => e.type === 'impact' && e.munition === 'nuclear' && e.radius > getTankStats(DEFAULT_LOADOUT).blastRadius)).toBe(true);
  });
  it('rejects unknown ammunition in controls and saved state', () => {
    const world = new SphereWorld(), game = new GameSimulation(world, { bot: false });
    expect(game.selectMunition(0, '__proto__' as never)).toBe(false);
    expect(game.selectMunition(1, 'nuclear')).toBe(false);
    game.selectMunition(0, 'heavy');
    const checkpoint = structuredClone(game.checkpoint()) as unknown as { commands: { c: { id: string } }[] };
    checkpoint.commands[0].c.id = 'invalid';
    expect(() => new MatchReplay(world, checkpoint)).toThrow(/unknown munition/);
  });
});
