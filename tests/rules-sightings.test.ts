import { setCombatState } from './helpers/native-match';
/** Sighting rules (docs/visibility-architecture.md): team-union observations, any visible portion identifies a tank. */
import { describe, expect, it } from 'vitest';
import { legacyToKitIds, practiceSetup, type MatchSetup } from '../src/game/api/match';
import type { TerrainHit, V3 } from '../src/game/contracts';
import { add, distance, mul, normalize } from '../src/game/math';
import { GameSimulation } from '../src/game/simulation';
import { SphereWorld } from './helpers/sphere-world';

const LOADOUT = { tracks: 'scout', barrel: 'mortar', armor: 'light' } as const;

function placed(ups: V3[], teams: number[]): MatchSetup {
  const ids = [...new Set(teams)];
  return { ...practiceSetup({ seed: 5, mode: 'bot', player: LOADOUT }), mode: 'skirmish', id: `sightings:${teams.join('')}`,
    teams: ids.map(id => ({ id, name: `Team ${id}`, ai: true })),
    tanks: teams.map((team, i) => ({ team, loadout: legacyToKitIds(LOADOUT), spawn: { up: ups[i], heading: 0 }, brain: 'legacy' as const, difficulty: 'normal' as const })) };
}

/** A sphere world that blocks every sight ray leaving `sensor` unless its end point passes `allow`. */
class OccludedWorld extends SphereWorld {
  sensor: V3 | null = null;
  allow: (end: V3) => boolean = () => false;
  override raycast(origin: V3, direction: V3, maxDistance: number): TerrainHit | null {
    if (this.sensor && distance(origin, this.sensor) < 1e-6 && maxDistance > 0) {
      const end = add(origin, mul(direction, maxDistance + 0.12));
      if (!this.allow(end)) return { point: origin, normal: normalize(origin), distance: 1e-3, material: 1 };
    }
    return super.raycast(origin, direction, maxDistance);
  }
}

const refresh = (simulation: GameSimulation) => (simulation as unknown as { updateContacts(): void }).updateContacts();

describe('team-union sightings', () => {
  // Team 0: tank 0 at the north pole, tank 2 at the south pole. Team 1: tank 1 just beside tank 0, tank 3 on the equator.
  const ups: V3[] = [[0, 1, 0], normalize([0.2, 1, 0]), [0, -1, 0], [0, 0, -1]];

  it('queries actual shared sensor sight even with fog disabled, without changing authoritative contacts', () => {
    const setup = placed(ups, [0, 1, 0, 1]); setup.rules = { ...setup.rules, fog: false };
    const simulation = new GameSimulation(new SphereWorld(), setup);
    const before = structuredClone(simulation.state.observations);
    expect(before![0][3]?.visible).toBe(true);
    expect(simulation.sensorSees(0, 1)).toBe(true);
    expect(simulation.sensorSees(2, 1)).toBe(true);
    expect(simulation.sensorSees(0, 3)).toBe(false);
    expect(simulation.state.observations).toEqual(before);
    setCombatState(simulation, 0, { health: 0 });
    expect(simulation.sensorSees(2, 1)).toBe(false);
    expect(simulation.sensorSees(2, 999)).toBe(false);
  });

  it('shares every sighting with the whole team', () => {
    const simulation = new GameSimulation(new SphereWorld(), placed(ups, [0, 1, 0, 1]));
    const o = simulation.state.observations!;
    expect(o[0][1]?.visible).toBe(true);
    expect(o[2][1]?.visible).toBe(true);
    expect(o[1][0]?.visible).toBe(true);
    expect(o[3][0]?.visible).toBe(true);
    // Nobody sees the equator tank (beyond both horizons) or, from team 1, the south-pole tank.
    expect(o[0][3]?.visible ?? false).toBe(false);
    expect(o[2][3]?.visible ?? false).toBe(false);
    expect(o[1][2]?.visible ?? false).toBe(false);
    expect(o[0][2]).toBeNull();
  });

  it('counts only living sensors', () => {
    const simulation = new GameSimulation(new SphereWorld(), placed(ups, [0, 1, 0, 1]));
    setCombatState(simulation, 0, { health: 0 });
    refresh(simulation);
    const o = simulation.state.observations!;
    expect(o[2][1]?.visible).toBe(false);
    expect(o[0][1]?.visible).toBe(false);
    expect(o[2][1]?.position).toEqual(simulation.state.tanks[1].position);
  });
});

describe('any visible portion identifies a tank', () => {
  const ups: V3[] = [[0, 1, 0], normalize([0.2, 1, 0])];

  it('sees a tank whose only visible part is its muzzle, turret top or one hull corner', () => {
    const world = new OccludedWorld();
    const simulation = new GameSimulation(world, placed(ups, [0, 1]));
    world.kinematic = false;
    const target = simulation.state.tanks[1];
    const points = simulation.sightPoints(target);
    expect(points.length).toBeGreaterThanOrEqual(14);
    // The observer's sensor: the ray origin of every sight ray from tank 0.
    const origins: V3[] = [];
    world.sensor = null;
    const base = world.raycast.bind(world);
    world.raycast = (origin, direction, maxDistance) => { origins.push(origin); return base(origin, direction, maxDistance); };
    refresh(simulation);
    world.raycast = base;
    world.sensor = origins.find(o => distance(o, simulation.state.tanks[0].position) < 1.5) ?? null;
    expect(world.sensor).not.toBeNull();

    world.allow = () => false;
    refresh(simulation);
    expect(simulation.state.observations![0][1]?.visible).toBe(false);

    const muzzle = points[points.length - 1], turretTop = points[11], corner = points[0];
    for (const only of [muzzle, turretTop, corner]) {
      world.allow = end => distance(end, only) < 1e-4;
      refresh(simulation);
      expect(simulation.state.observations![0][1]?.visible).toBe(true);
    }
  });

  it('spans the whole tank: hull corners, turret and muzzle are distinct points around the hull', () => {
    const simulation = new GameSimulation(new SphereWorld(), placed(ups, [0, 1]));
    const target = simulation.state.tanks[1];
    const points = simulation.sightPoints(target);
    const spread = Math.max(...points.map(p => distance(p, target.position)));
    expect(spread).toBeGreaterThan(0.8);
    expect(new Set(points.map(p => p.map(v => v.toFixed(3)).join(','))).size).toBe(points.length);
  });
});
