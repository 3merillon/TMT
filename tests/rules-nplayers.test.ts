import { setCombatState } from './helpers/native-match';
/** N tanks and teams: spawns, per-observer contacts, team elimination, and full four-tank matches that finish. */
import { describe, expect, it } from 'vitest';
import { legacyToKitIds, practiceSetup, type BotProfileId, type MatchSetup } from '../src/game/api/match';
import type { GameEvent } from '../src/game/contracts';
import { distance } from '../src/game/math';
import { FIXED_DT, GameSimulation } from '../src/game/simulation';
import { SphereWorld } from './helpers/sphere-world';

const LOADOUT = { tracks: 'scout', barrel: 'mortar', armor: 'light' } as const;

function match(teams: number[], brain: BotProfileId = 'legacy', seed = 21): MatchSetup {
  const ids = [...new Set(teams)];
  return { ...practiceSetup({ seed, mode: 'bot', player: LOADOUT }), mode: 'skirmish', id: `test:${teams.join('')}:${seed}`,
    teams: ids.map(id => ({ id, name: `Team ${id}`, ai: true })),
    tanks: teams.map(team => ({ team, loadout: legacyToKitIds(LOADOUT), spawn: 'auto' as const, brain, difficulty: 'normal' as const })) };
}

function play(simulation: GameSimulation, maximumTicks: number): GameEvent[] {
  const events: GameEvent[] = [];
  for (let tick = 0; tick < maximumTicks && simulation.state.phase !== 'finished'; tick++) {
    events.push(...simulation.step(FIXED_DT));
    if (simulation.stalledOn?.serial) simulation.completeLegacyCarve();
  }
  events.push(...simulation.step(0));
  return events;
}

describe('N-tank setups', () => {
  it('spawns every tank apart on the surface with teammates adjacent', () => {
    const world = new SphereWorld(), simulation = new GameSimulation(world, match([0, 1, 0, 1]));
    const tanks = simulation.state.tanks;
    expect(tanks.map(tank => tank.team)).toEqual([0, 1, 0, 1]);
    for (const tank of tanks) expect(Math.hypot(...tank.position)).toBeCloseTo(world.radius + .55, 9);
    for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) expect(distance(tanks[a].position, tanks[b].position)).toBeGreaterThan(4);
    const nearest = (id: number) => tanks.filter(tank => tank.id !== id).sort((x, y) => distance(x.position, tanks[id].position) - distance(y.position, tanks[id].position))[0];
    expect([0, 1, 2, 3].filter(id => nearest(id).team === tanks[id].team).length).toBeGreaterThanOrEqual(2);
  });

  it('keeps one observation per observer and enemy, never about allies, and a primary contact for the v1 views', () => {
    const simulation = new GameSimulation(new SphereWorld(), match([0, 1, 0, 1]));
    const observations = simulation.state.observations!;
    expect(observations).toHaveLength(4);
    for (const [observer, row] of observations.entries()) {
      expect(row).toHaveLength(4);
      for (const [target, contact] of row.entries()) {
        const enemy = simulation.state.tanks[target].team !== simulation.state.tanks[observer].team;
        // Curvature hides the far side of the ring (the horizon is about 5.7 u): an enemy is seen or not yet known.
        if (!enemy) expect(contact).toBeNull();
        else expect(contact === null || contact.visible).toBe(true);
      }
      expect(row.some(contact => contact?.visible)).toBe(true);
      expect(row).toContain(simulation.state.contacts[observer]);
    }
  });

  it('finishes by team elimination and names the last team standing', () => {
    const simulation = new GameSimulation(new SphereWorld(), match([0, 1, 0, 1]));
    for (const id of [1, 3]) setCombatState(simulation, id, { health: 0 });
    const events = play(simulation, 5);
    expect(simulation.state.phase).toBe('finished');
    expect(simulation.state.winnerTeam).toBe(0);
    expect(simulation.state.winner).toBe(0);
    expect(events).toContainEqual({ type: 'finish', winner: 0, team: 0 });
  });

  it('skips dead tanks on the timeline', () => {
    const simulation = new GameSimulation(new SphereWorld(), match([0, 1, 2]));
    setCombatState(simulation, 1, { health: 0 });
    const turns: number[] = [];
    for (let tick = 0; tick < 20000 && turns.length < 4 && simulation.state.phase !== 'finished'; tick++) {
      for (const event of simulation.step(FIXED_DT)) if (event.type === 'turn') turns.push(event.player);
      if (simulation.stalledOn?.serial) simulation.completeLegacyCarve();
      for (const tank of simulation.state.tanks) if (tank.id !== 1) setCombatState(simulation, tank.id, { health: tank.maxHealth! });
    }
    expect(turns).toEqual([2, 0, 2, 0]);
  });

  it.each([['a brain', 'legacy'], ['a human', null]] as const)('passes the turn of %s that dies during its own aim phase', (_, brain) => {
    const setup = match([0, 1, 2]);
    if (!brain) { setup.teams[0].ai = false; delete setup.tanks[0].brain; }
    const simulation = new GameSimulation(new SphereWorld(), setup);
    expect(simulation.state.active).toBe(0);
    expect(simulation.brainOf(0)).toBe(brain);
    // Tank 0 falls through the planet before it acts (a fall or an extension's damage can kill in the aim phase).
    simulation.state.tanks[0].position = [0, 1, 0];
    const events = play(simulation, 3);
    expect(events).toContainEqual({ type: 'kill', tank: 0, by: null, cause: 'fall' });
    expect(events).toContainEqual({ type: 'turn', player: 1 });
    expect(simulation.state.phase).toBe('aim');
    expect(simulation.state.active).toBe(1);
  });
});

describe('full matches finish', () => {
  it.each([
    ['a four-tank free-for-all', [0, 1, 2, 3]],
    ['a 2v2', [0, 0, 1, 1]],
  ] as const)('%s', (_, teams) => {
    const simulation = new GameSimulation(new SphereWorld(), match([...teams]));
    const events = play(simulation, 60 * 60 * 30);
    expect(simulation.state.phase).toBe('finished');
    const finish = events.find(event => event.type === 'finish');
    expect(finish).toBeDefined();
    const survivors = simulation.state.tanks.filter(tank => tank.health > 0);
    expect(new Set(survivors.map(tank => tank.team)).size).toBeLessThanOrEqual(1);
    if (survivors.length) expect(simulation.state.winnerTeam).toBe(survivors[0].team);
    expect(events.filter(event => event.type === 'impact').length).toBeGreaterThan(2);
  }, 60000);
  // Gate 1 (wave-1 merge): the skirmish screen offers the W1 profiles, so a four-tank free-for-all finishes with each of
  // them too (kit v2 tanks; each run takes about 12–22 turns).
  it.each(['tosser', 'rusty', 'vex', 'cyborg'] as const)('a four-tank free-for-all of %s brains', brain => {
    const simulation = new GameSimulation(new SphereWorld(), match([0, 1, 2, 3], brain));
    const phases = new Set<string>();
    const events: GameEvent[] = [];
    for (let tick = 0; tick < 60 * 60 * 30 && simulation.state.phase !== 'finished'; tick++) {
      events.push(...simulation.step(FIXED_DT));
      phases.add(simulation.state.phase);
      if (simulation.stalledOn?.serial) simulation.completeLegacyCarve();
    }
    events.push(...simulation.step(0));
    expect(simulation.state.phase).toBe('finished');
    // Gate 1: terrain edits never block the match (non-blocking transactions; the legacy 'terrain' phase never appears).
    expect(phases.has('terrain')).toBe(false);
    expect(events.some(event => event.type === 'finish')).toBe(true);
    const survivors = simulation.state.tanks.filter(tank => tank.health > 0);
    expect(survivors.length).toBeLessThanOrEqual(1);
    if (survivors.length) expect(simulation.state.winnerTeam).toBe(survivors[0].team);
    expect(events.filter(event => event.type === 'impact').length).toBeGreaterThanOrEqual(3);
  }, 60000);
});
