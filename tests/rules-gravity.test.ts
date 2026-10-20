/** One gravity (plan §3): 9.81 u/s² with launch speeds × sqrt(9.81 / 7.5) keeps today's ranges within 1 % for mortar,
 * cannon and rail at 15°, 45° and 75° over the whole power range (0 to 1 in 0.1 steps): on the curved 18 u planet
 * (the game's geometry, measured ≤ 0.33 %) and on flat ground for every range of 1 u or more (≤ 0.87 %).
 * Shorter flat lobs (15° at power ≤ 0.2: 0.19–0.8 u, 5–8 ticks in the air) differ by up to 2.5 % relative because the
 * fixed 60 Hz step dominates such short flights, but by less than 0.01 u (measured ≤ 0.0086 u), which is what the
 * test holds them to. */
import { describe, expect, it } from 'vitest';
import type { ImpactEvent, ProjectileState, V3 } from '../src/game/contracts';
import { practiceSetup } from '../src/game/api/match';
import { dot, normalize, sub } from '../src/game/math';
import { munitionSpeed } from '../src/game/munitions';
import { assembleKit, kitLoadoutFromLegacy } from '../src/game/kit';
import { FIXED_DT, integrateProjectile } from '../src/game/rules/ballistics';
import { GameSimulation } from '../src/game/simulation';
import { GRAVITY_BALLISTIC, GRAVITY_BODY, LAUNCH_SPEED_SCALE, LEGACY_GRAVITY_BALLISTIC } from '../src/game/world-constants';
import { SphereWorld } from './helpers/sphere-world';

const WEAPONS = ['mortar', 'cannon', 'rail'] as const;
const ANGLES = [15, 45, 75];
const still = (gravity: number) => ({ gravity, wind: null, windFactor: 0 });

/** Flat ground: launch 10⁶ u from the centre (radial gravity is uniform to 1e-11 over the flight); range = the
 * horizontal distance where the shell comes back down to its launch height (interpolated inside the last tick). */
function flatRange(speed: number, degrees: number, gravity: number): number {
  const up: V3 = [0, 1, 0], origin: V3 = [0, 1e6, 0], angle = degrees * Math.PI / 180;
  let shell: ProjectileState = { id: 1, owner: 0, position: origin, velocity: [speed * Math.cos(angle), speed * Math.sin(angle), 0], age: 0 };
  for (let tick = 0; tick < 100000; tick++) {
    const next = integrateProjectile(shell, still(gravity));
    const h0 = dot(sub(shell.position, origin), up), h1 = dot(sub(next.position, origin), up);
    if (tick > 0 && h1 <= 0) { const f = h0 / (h0 - h1); return shell.position[0] + (next.position[0] - shell.position[0]) * f; }
    shell = next;
  }
  throw new Error('the shell never landed');
}

/** The 18 u planet: launch 0.55 u above the surface at +Y, trace against the analytic sphere; range = surface arc. */
function curvedRange(speed: number, degrees: number, gravity: number): number {
  const world = new SphereWorld(), angle = degrees * Math.PI / 180, origin: V3 = [0, world.radius + .55, 0];
  let shell: ProjectileState = { id: 1, owner: 0, position: origin, velocity: [speed * Math.cos(angle), speed * Math.sin(angle), 0], age: 0 };
  for (let tick = 0; tick < 100000; tick++) {
    const next = integrateProjectile(shell, still(gravity));
    const delta = sub(next.position, shell.position), extent = Math.hypot(...delta);
    const hit = world.raycast(shell.position, normalize(delta), extent);
    if (hit) return Math.acos(Math.min(1, dot(normalize(origin), normalize(hit.point)))) * world.radius;
    shell = next;
  }
  throw new Error('the shell never landed');
}

describe('unified gravity', () => {
  it('uses 9.81 for shells and bodies with launch speeds scaled by sqrt(9.81 / 7.5)', () => {
    expect(GRAVITY_BALLISTIC).toBe(9.81);
    expect(GRAVITY_BODY).toBe(9.81);
    expect(LAUNCH_SPEED_SCALE).toBeCloseTo(1.1437, 4);
    expect(LAUNCH_SPEED_SCALE).toBe(Math.sqrt(9.81 / 7.5));
    const kit = assembleKit(kitLoadoutFromLegacy({ tracks: 'scout', barrel: 'rail', armor: 'light' }));
    expect(munitionSpeed(kit, 1)).toBe(LAUNCH_SPEED_SCALE * kit.stats.maxSpeed);
  });

  for (const weapon of WEAPONS) {
    const kit = assembleKit(kitLoadoutFromLegacy({ tracks: 'scout', barrel: weapon, armor: 'light' }));
    it(`keeps ${weapon} ranges within 1 % at 15/45/75° over the power range (curved; flat from 1 u, else within 0.01 u)`, () => {
      let flatSamples = 0;
      for (let step = 0; step <= 10; step++) {
        const power = step / 10, speed = munitionSpeed(kit, power), legacy = speed / LAUNCH_SPEED_SCALE;
        for (const degrees of ANGLES) {
          const at = `power ${power.toFixed(1)} ${degrees}°`;
          const flatNew = flatRange(speed, degrees, GRAVITY_BALLISTIC), flatOld = flatRange(legacy, degrees, LEGACY_GRAVITY_BALLISTIC);
          const curvedNew = curvedRange(speed, degrees, GRAVITY_BALLISTIC), curvedOld = curvedRange(legacy, degrees, LEGACY_GRAVITY_BALLISTIC);
          expect(Math.abs(curvedNew - curvedOld) / curvedOld, `curved ${at}`).toBeLessThan(.01);
          if (flatOld >= 1) {
            flatSamples++;
            expect(Math.abs(flatNew - flatOld) / flatOld, `flat ${at}`).toBeLessThan(.01);
            // Sanity: the analytic flat range of the continuous trajectory, for the order of magnitude.
            expect(Math.abs(flatOld / (legacy * legacy * Math.sin(2 * degrees * Math.PI / 180) / LEGACY_GRAVITY_BALLISTIC) - 1)).toBeLessThan(.1);
          } else expect(Math.abs(flatNew - flatOld), `flat ${at} (a ${flatOld.toFixed(2)} u lob)`).toBeLessThan(.01);
        }
      }
      expect(flatSamples).toBeGreaterThanOrEqual(22); // two thirds of the 33 flat samples fly 1 u or more
    });
  }

  it('scales gravity per level (World 6 flies at 0.6 g)', () => {
    const setup = practiceSetup({ seed: 2, mode: 'local', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } });
    setup.rules.gravityScale = .6;
    const low = new GameSimulation(new SphereWorld(), setup);
    expect(low.gravity).toBeCloseTo(9.81 * .6, 12);
    const normal = new GameSimulation(new SphereWorld(), practiceSetup({ seed: 2, mode: 'local', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } }));
    for (const simulation of [low, normal]) { simulation.state.tanks[1].position = [0, -18.55, 0]; simulation.aim(0, 0, .8, .3); }
    const end = (simulation: GameSimulation) => simulation.preview(0).at(-1)!;
    const reach = (simulation: GameSimulation) => Math.hypot(...sub(end(simulation), simulation.muzzle(0).position));
    expect(reach(low)).toBeGreaterThan(reach(normal) * 1.3);
  });
});

describe('the seeded duel keeps its ballistic ranges under the new gravity', () => {
  // Impact surface distances (u) recorded at g = 7.5 before the switch (2-decimal rounding), on kit v1.
  // Since the wave-1 merge the tanks are kit v2 (other hp, mass and hull geometry), so the recordings are compared only
  // where the kit cannot steer the shot: every scripted human shot and the bot's opening shot, all fired before a blast
  // has pushed a tank. After that the legacy brain re-aims at where the blasts pushed its target, which depends on the
  // v2 masses, not on gravity (seed 11's fourth impact lands at 8.57 u against 13.43 on kit v1); those shots are
  // counted, and the winner/damage remain checked. Directional armor now ends seed 11 on turn 5 (previously 6),
  // removing its last bot shot; the five surviving impact ranges retain the historical tolerance.
  const LEGACY = {
    11: { turns: 6, winner: 1, health: [0, 89], distances: [2.23, 9.45, 3.70, 13.43, 3.70, 13.48] },
    3: { turns: 4, winner: 1, health: [0, 100], distances: [2.23, 9.45, 3.70, 7.87] },
  } as const;
  const kitIndependent = (index: number) => index % 2 === 0 || index === 1;
  it.each([11, 3] as const)('seed %i: expected armor outcome; every kit-independent impact within 1 % of its 7.5 distance', seed => {
    const setup = practiceSetup({ seed, mode: 'bot', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } });
    setup.rules.moveSeconds = 4; // Preserve the historical turn timing for this gravity comparison.
    const simulation = new GameSimulation(new SphereWorld(), setup);
    simulation.aim(0, 1, .5, .25); simulation.fire(0); simulation.endMove(0);
    const distances: number[] = [];
    for (let tick = 0; tick < 4000 && simulation.state.phase !== 'finished'; tick++) {
      for (const event of simulation.step(FIXED_DT)) if (event.type === 'impact') distances.push((event as ImpactEvent).flight!.distance);
      if (simulation.stalledOn?.serial) simulation.completeLegacyCarve();
      // This historical fixture measures gravity and hull armor. Machinery failures/repairs have their own
      // rules tests and would change the scripted turn sequence rather than the projectile's range.
      for (const tank of simulation.state.tanks) delete tank.machinery;
      if (simulation.state.phase === 'aim' && simulation.state.active === 0 && simulation.state.phaseTime > .3) {
        simulation.aim(0, .6 + (simulation.state.turn % 5) * .2, .7, .4); simulation.fire(0);
      }
    }
    const legacy = LEGACY[seed];
    const expectedTurns = seed === 11 ? 5 : legacy.turns;
    expect(simulation.state.turn).toBe(expectedTurns);
    expect(simulation.state.winner).toBe(legacy.winner);
    // Health was recorded on kit v1 (100 hp). Kit v2 builds carry their own hp (130 for this Warden/Dome build) and
    // exposure comes from the v2 hull geometry, so compare damage: the loser dies, the winner loses what it lost at 7.5 (±1 hp).
    const winner = simulation.state.tanks[legacy.winner], loser = simulation.state.tanks[1 - legacy.winner];
    expect(loser.health).toBe(0);
    expect(Math.abs(((winner.maxHealth ?? NaN) - winner.health) - (100 - legacy.health[legacy.winner]))).toBeLessThanOrEqual(1);
    expect(distances).toHaveLength(expectedTurns);
    for (const [index, distance] of distances.entries()) {
      if (kitIndependent(index)) expect(Math.abs(distance - legacy.distances[index]), `impact ${index}`).toBeLessThan(legacy.distances[index] * .01 + .005);
    }
  });
});
