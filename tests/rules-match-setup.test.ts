import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, legacyToKitIds, practiceSetup, type MatchSetup } from '../src/game/api/match';
import { createHash } from 'node:crypto';
import { FIXED_DT, GameSimulation, MAX_PROJECTILE_AGE, MOVE_SECONDS, RADAR_COST } from '../src/game/simulation';
import type { GameEvent, GameSnapshot, Loadout } from '../src/game/contracts';
import { validateLoadout } from '../src/game/modules';
import { validateMatchSetup } from '../src/game/rules/setup';
import { SphereWorld } from './helpers/sphere-world';
import { assembleKit, kitLoadoutFromLegacy } from '../src/game/kit';

/** Commit a pending serial terrain edit immediately (the compatibility path of worlds without transactions). */
function commitSerialTerrain(simulation: GameSimulation): void { if (simulation.stalledOn?.serial) simulation.completeLegacyCarve(); }

const LOADOUTS: Loadout[] = (['scout', 'grip'] as const).flatMap(tracks => (['mortar', 'cannon', 'rail'] as const)
  .flatMap(barrel => (['light', 'heavy'] as const).map(armor => ({ tracks, barrel, armor }))));
const PLAYER: Loadout = { tracks: 'scout', barrel: 'mortar', armor: 'light' };

describe('DEFAULT_RULES', () => {
  it("reproduces today's practice duel", () => {
    expect(DEFAULT_RULES.moveSeconds).toBe(MOVE_SECONDS);
    expect(DEFAULT_RULES.moveSeconds).toBe(30);
    expect(DEFAULT_RULES.projectileAge).toBe(MAX_PROJECTILE_AGE);
    expect(DEFAULT_RULES.projectileAge).toBe(8);
    expect(DEFAULT_RULES.radarCost).toBe(RADAR_COST);
    expect(DEFAULT_RULES.radarCost).toBe(3);
    expect(DEFAULT_RULES).toEqual({
      moveSeconds: 30, wind: null, fog: true, projectileAge: 8, gravityScale: 1, ammo: {}, radarCost: 3, startCharge: 1, friendlyFire: true,
      commitWindowTicks: 12, turnModel: 'tempo', brace: false, taps: false, overdrive: false, supplyEvery: 0, fallDamage: false,
    });
    // No aim timer, turn limit or sudden death today.
    expect(DEFAULT_RULES.aimSeconds).toBeUndefined();
    expect(DEFAULT_RULES.maxTurns).toBeUndefined();
    expect(DEFAULT_RULES.suddenDeathTurn).toBeUndefined();
  });
  it('is frozen, so no match can mutate the shared defaults', () => {
    expect(Object.isFrozen(DEFAULT_RULES)).toBe(true);
    expect(Object.isFrozen(DEFAULT_RULES.ammo)).toBe(true);
  });
});

describe('legacyToKitIds (plan Appendix A)', () => {
  it('maps all 12 v1 loadouts', () => {
    expect(LOADOUTS).toHaveLength(12);
    for (const loadout of LOADOUTS) expect(legacyToKitIds(loadout)).toEqual({
      hull: loadout.armor === 'light' ? 'warden' : 'bastion', runningGear: loadout.tracks, turret: 'dome', weapon: loadout.barrel, utility: 'antenna',
    });
    expect(new Set(LOADOUTS.map(loadout => JSON.stringify(legacyToKitIds(loadout)))).size).toBe(12);
  });
  it('rejects unknown v1 parts explicitly', () => {
    expect(() => legacyToKitIds({ ...PLAYER, armor: 'medium' as Loadout['armor'] })).toThrow(/Unknown v1 loadout/);
    expect(() => legacyToKitIds({ ...PLAYER, tracks: 'wheels' as Loadout['tracks'] })).toThrow(/Unknown v1 loadout/);
    expect(() => legacyToKitIds({ ...PLAYER, barrel: 'toString' as Loadout['barrel'] })).toThrow(/Unknown v1 loadout/);
    expect(() => legacyToKitIds({ ...PLAYER, armor: 'constructor' as Loadout['armor'] })).toThrow(/Unknown v1 loadout/);
  });
});

describe('practiceSetup', () => {
  it('builds the bot duel', () => {
    const setup = practiceSetup({ seed: 7, mode: 'bot', player: PLAYER });
    expect(setup).toMatchObject({ seed: 7, mode: 'bot', planet: { kind: 'auto' }, objectives: [{ kind: 'eliminate' }] });
    expect(setup.teams).toEqual([{ id: 0, name: 'You', ai: false }, { id: 1, name: 'Practice AI', ai: true }]);
    expect(setup.tanks).toEqual([
      { team: 0, loadout: legacyToKitIds(PLAYER), spawn: 'auto' },
      { team: 1, loadout: legacyToKitIds(PLAYER), spawn: 'auto', brain: 'legacy', difficulty: 'normal' },
    ]);
    expect(setup.rules).toEqual(DEFAULT_RULES);
    expect(setup.rules).not.toBe(DEFAULT_RULES);
    expect(setup.structures).toBeUndefined();
    expect(setup.initialCuts).toBeUndefined();
  });
  it('builds the pass-and-play duel', () => {
    const setup = practiceSetup({ seed: 12, mode: 'local', player: PLAYER });
    expect(setup.teams).toEqual([{ id: 0, name: 'Player 1', ai: false }, { id: 1, name: 'Player 2', ai: false }]);
    expect(setup.tanks.map(tank => tank.brain)).toEqual([undefined, undefined]);
    expect(setup.objectives).toEqual([{ kind: 'eliminate' }]);
  });
  it('builds the drive test with an inert target and no objective', () => {
    const setup = practiceSetup({ seed: 3, mode: 'drive', player: PLAYER });
    expect(setup.teams.every(team => !team.ai)).toBe(true);
    expect(setup.tanks.map(tank => tank.brain)).toEqual([undefined, undefined]);
    expect(setup.objectives).toEqual([]);
  });
  it('gives the opponent the player loadout unless one is set, and ids stay deterministic', () => {
    const heavy: Loadout = { tracks: 'grip', barrel: 'rail', armor: 'heavy' };
    expect(practiceSetup({ seed: 1, mode: 'local', player: PLAYER, opponent: heavy }).tanks[1].loadout).toEqual(legacyToKitIds(heavy));
    expect(practiceSetup({ seed: 5, mode: 'bot', player: PLAYER })).toEqual(practiceSetup({ seed: 5, mode: 'bot', player: PLAYER }));
    expect(practiceSetup({ seed: 5, mode: 'bot', player: PLAYER }).id).not.toBe(practiceSetup({ seed: 6, mode: 'bot', player: PLAYER }).id);
  });
  it('rejects invalid seeds and modes', () => {
    for (const seed of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) expect(() => practiceSetup({ seed, mode: 'bot', player: PLAYER })).toThrow(/seed/);
    expect(() => practiceSetup({ seed: 1, mode: 'online' as 'bot', player: PLAYER })).toThrow(/mode/);
  });
});

describe('MatchSetup validation (the simulation honours every field or throws, I3)', () => {
  const base = () => practiceSetup({ seed: 9, mode: 'bot', player: PLAYER });
  const reject = (change: (setup: MatchSetup) => void, message: RegExp) => { const setup = base(); change(setup); expect(() => validateMatchSetup(setup)).toThrow(message); };
  it('accepts every practice setup and returns a detached copy', () => {
    for (const mode of ['bot', 'local', 'drive'] as const) for (const loadout of LOADOUTS.filter(validateLoadout)) {
      const setup = practiceSetup({ seed: 9, mode, player: loadout });
      const valid = validateMatchSetup(setup);
      expect(valid).toEqual(setup);
      expect(valid).not.toBe(setup);
    }
  });
  it('fails explicitly for setups Wave 1 cannot honour', () => {
    reject(setup => { setup.tanks.pop(); }, /2 to 8 tanks/);
    reject(setup => { setup.mode = 'unknown' as 'bot'; }, /unknown mode/);
    reject(setup => { setup.tanks[1].team = 0; }, /at least two teams/);
    reject(setup => { setup.tanks[1].team = 7; }, /unknown team/);
    reject(setup => { setup.tanks[0].spawn = { up: [0, 0, 0], heading: 0 }; }, /invalid spawn/);
    reject(setup => { setup.tanks[1].difficulty = 'impossible' as 'ace'; }, /unknown difficulty/);
    reject(setup => { setup.tanks[1].brain = 'medic'; }, /arrives after Wave 1/);
    reject(setup => { setup.tanks[0].loadout = { ...setup.tanks[0].loadout, turret: 'tophat' }; }, /unknown turret/);
    reject(setup => { setup.rules.gravityScale = 0; }, /gravityScale/);
    reject(setup => { setup.rules.brace = true; }, /W2-GAME2/);
    reject(setup => { setup.rules.ammo = { plasma: 1 } as never; }, /unknown munition/);
    reject(setup => { setup.rules.wind = { mean: -1, gust: 0, period: 4 }; }, /rules.wind/);
    reject(setup => { setup.objectives = [{ kind: 'survive' }]; }, /W3-CONTENT/);
    reject(setup => { setup.seed = -4; }, /seed/);
    reject(setup => { setup.initialCuts = [{ id: '0:0:0', center: [0, 18, 0], radius: 40 }]; }, /initial cut/);
  });
  it('accepts N tanks, teams, spawns, brains, difficulties and custom rules', () => {
    const setup = base();
    setup.teams.push({ id: 2, name: 'Third', ai: true });
    setup.tanks.push({ team: 2, loadout: legacyToKitIds(PLAYER), spawn: { up: [0, 0, 1], heading: 1 }, brain: 'vex', difficulty: 'ace', maxHealth: 150, name: 'Vex' });
    setup.rules = { ...setup.rules, wind: { mean: 2, gust: 1, period: 6 }, aimSeconds: 20, maxTurns: 30, ammo: { nuclear: 1, heavy: 3 } };
    expect(validateMatchSetup(setup).tanks).toHaveLength(3);
  });
});

/** The pre-refactor (step-1) seeded duel, reduced to the v1 fields: SHA-256 of its canonical JSON. */
const TANK_V1 = ['id', 'position', 'rotation', 'velocity', 'heading', 'turretYaw', 'barrelPitch', 'power', 'health', 'charge', 'movement', 'recoil', 'suspension',
  'trackPhase', 'trackPhases', 'trackSpeeds', 'trackGroundSpeeds', 'trackSlip', 'trackContact', 'yawVelocity', 'wheelSuspension', 'treadContacts', 'treadTerrain', 'loadout', 'munition'];
const pick = (value: object, keys: string[]) => Object.fromEntries(keys.filter(key => (value as Record<string, unknown>)[key] !== undefined).map(key => [key, (value as Record<string, unknown>)[key]]));
function legacyDigest(state: GameSnapshot, events: GameEvent[]): string {
  const text = JSON.stringify({
    state: { ...pick(state, ['tick', 'time', 'phase', 'active', 'turn', 'phaseTime', 'contacts', 'winner']),
      projectiles: state.projectiles.map(p => pick(p, ['id', 'owner', 'position', 'velocity', 'age', 'munition'])), tanks: state.tanks.map(t => pick(t, TANK_V1)) },
    events: events.filter(e => ['impact', 'turn', 'finish', 'shot'].includes(e.type)).map(e => pick(e, ['type', 'position', 'normal', 'radius', 'owner', 'munition', 'player', 'winner'])),
  });
  return createHash('sha256').update(text).digest('hex');
}
/** The seeded bot duel: the human opens, then fires again at every own aim phase; terrain commits as soon as it is asked for. */
function seededDuel(simulation: GameSimulation, ticks: number): string {
  simulation.aim(0, 1, 0.5, 0.25); simulation.fire(0); simulation.endMove(0);
  const events: GameEvent[] = [];
  for (let tick = 0; tick < ticks; tick++) {
    events.push(...simulation.step(FIXED_DT));
    commitSerialTerrain(simulation);
    if (simulation.state.phase === 'aim' && simulation.state.active === 0 && simulation.state.phaseTime > 0.3) {
      if ((simulation.state.tanks[0].machinery?.weapon ?? 1) <= .15) { simulation.hold(0); continue; }
      simulation.aim(0, 0.6 + (simulation.state.turn % 5) * 0.2, 0.7, 0.4); simulation.fire(0);
    }
  }
  events.push(...simulation.step(0));
  return legacyDigest(simulation.state, events);
}

describe('defaults reproduce the seeded duel', () => {
  // Re-baselined by the unified-gravity commit (W1-GAME step 6). Up to step 5 these were the step-1 digests
  // dba45d52… / 4e059305… / 740dbeab… (legacy controller removed, 7.5 gravity), reproduced byte for byte by
  // DEFAULT_RULES + practiceSetup. Rationale for the new values: gravity 9.81 with every launch speed × sqrt(9.81/7.5)
  // flies the same curves 1.144× faster, so every flight is ~12 % fewer ticks (52→46, 71→62, 98→86, 143→125) and
  // every later tick-stamped event, contact refresh and time-sliced bot search shifts. The outcome is unchanged: the
  // same impacts land within 0.02 u (< 1 %) of their 7.5 positions, with the same turn counts, damage and winners
  // (seed 11: 6 turns, hp [0, 89], tank 1 wins; seed 3: 4 turns, hp [0, 100], tank 1 wins); rules-gravity checks it.
  // Re-baselined again at the wave-1 merge (kit v2): the digests pin health, masses and hull geometry, so kit v2's
  // Warden/Dome build (hp 130, mass from its parts, R6 handling values) changes every state from tick 0. The v1-gravity
  // digests were cfe84820… / 94d8ebe1… / 364cb6fd…. The outcome still matches (same turns and winner, the loser dies,
  // the winner's damage within 1 hp, the kit-independent impacts within 1 %); rules-gravity checks it.
  // The 30-second distance-limited move phase changes when the bot chooses to finish its turn.
  // Re-baselined for team-union, any-portion sightings (docs/visibility-architecture.md): the seed-11 contacts are refreshed
  // at different ticks (the 4000-tick digest was 1844fb0d…); turns, impacts, damage and the winner are unchanged
  // (seed 11 at 8000 ticks: 6 turns, hp [0, 118], tank 1 wins; seed 3: 4 turns, hp [0, 130], tank 1 wins).
  // Tank-design overhaul: direct hits now distinguish front/side/rear/roof armor. Seed 11 therefore loses its tank
  // one turn earlier; seed 3 stays unchanged. Projectile controls, trajectories and serial commit timing are unchanged,
  // independently checked by rules-aim-target, rules-gravity and rules-checkpoint-v2 (including reactive consumption).
  // Machinery damage: damaged drive torque changes later contact geometry; the scripted player now spends
  // a Hold on field repairs when its gun is disabled. The hashes pin the new deterministic sequences.
  const GOLDEN = [
    { seed: 11, ticks: 1000, digest: '33d9ff69c1740096a94caa5eb526ec57f2ed028539552ee78989de56905583db' },
    { seed: 11, ticks: 4000, digest: 'c91a6033582f0b9dfde9a12f7bee833be46abb99fa1d702383125f10e3ca94f9' },
    { seed: 3, ticks: 4000, digest: '79cd99d33346b09db93d29500931e6f38f1ebfe4405714d679c4d0011ae47d72' },
  ];
  it.each(GOLDEN)('DEFAULT_RULES + practiceSetup replays the seed-$seed duel byte for byte ($ticks ticks)', ({ seed, ticks, digest }) => {
    const setup = practiceSetup({ seed, mode: 'bot', player: PLAYER });
    expect(setup.rules).toEqual(DEFAULT_RULES);
    expect(seededDuel(new GameSimulation(new SphereWorld(), setup), ticks)).toBe(digest);
  });
  it('keeps the options constructor as a thin wrapper through practiceSetup', () => {
    expect(seededDuel(new GameSimulation(new SphereWorld(), { bot: true, seed: 11 }), 1000)).toBe(GOLDEN[0].digest);
  });
});

describe('tank kits come from the setup', () => {
  it('sets TankState.kit from the setup and keeps the v1 loadout as the nearest legacy equivalent', () => {
    const setup = practiceSetup({ seed: 2, mode: 'local', player: PLAYER, opponent: { tracks: 'grip', barrel: 'cannon', armor: 'heavy' } });
    const simulation = new GameSimulation(new SphereWorld(), setup);
    expect(simulation.state.tanks.map(tank => tank.kit)).toEqual(setup.tanks.map(tank => tank.loadout));
    expect(simulation.state.tanks[1].loadout).toEqual({ tracks: 'grip', barrel: 'cannon', armor: 'heavy' });
    // Health is the opponent's kit value (kit v2: a Bastion build carries more hp than the player's Warden).
    const opponentHp = assembleKit(kitLoadoutFromLegacy({ tracks: 'grip', barrel: 'cannon', armor: 'heavy' })).stats.hp;
    expect(simulation.state.tanks[1].health).toBe(opponentHp);
    expect(opponentHp).toBeGreaterThan(simulation.state.tanks[0].health);
    expect(simulation.state.tanks[0].kit).not.toBe(setup.tanks[0].loadout);
  });
});
