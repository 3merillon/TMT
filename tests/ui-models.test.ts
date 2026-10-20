import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, practiceSetup, type MatchSetup } from '../src/game/api/match';
import type { GameSnapshot, TankState } from '../src/game/contracts';
import { aimSecondsLeft, ammoChips, banner, cycleMunition, objectiveLabel, rosterRows, windLabel } from '../src/game/ui/hud-model';
import { driveTestSearch, menuSearch, parseLaunch } from '../src/game/ui/launch';
import { clock, matchSummary, wonBy } from '../src/game/ui/results-model';
import { defaultSkirmish, skirmishMode, skirmishProblem, skirmishRules, skirmishSetup } from '../src/game/ui/skirmish-setup';
import { buildStats, FITTING_BUDGET, fitPart, kitSummary, partCards } from '../src/game/ui/workshop-model';

const KIT = { hull: 'warden', runningGear: 'scout', turret: 'dome', weapon: 'mortar', utility: 'antenna' };
const tank = (id: number, fields: Partial<TankState> = {}): TankState => ({
  id, position: [0, 18, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], heading: 0, turretYaw: 0, barrelPitch: 0.75, power: 0.55, health: 100, charge: 1, movement: 7,
  recoil: 0, suspension: [], trackPhase: 0, trackPhases: [0, 0], trackSpeeds: [0, 0], trackGroundSpeeds: [0, 0], trackSlip: [0, 0], trackContact: [1, 1], yawVelocity: 0,
  wheelSuspension: [], treadContacts: [], loadout: { tracks: 'scout', barrel: 'mortar', armor: 'light' }, ...fields,
}) as TankState;
const snapshot = (tanks: TankState[], fields: Partial<GameSnapshot> = {}): GameSnapshot =>
  ({ tick: 0, time: 75.4, phase: 'aim', active: 0, turn: 3, phaseTime: 4, tanks, projectiles: [], contacts: tanks.map(() => null), winner: null, ...fields }) as unknown as GameSnapshot;

describe('launch options', () => {
  it('boots the plain URL to the title and treats ?mode / ?seed as deep links', () => {
    expect(parseLaunch('')).toEqual({ deepLink: null, dev: false });
    expect(parseLaunch('?dev')).toEqual({ deepLink: null, dev: true });
    expect(parseLaunch('?mode=dev')).toEqual({ deepLink: { mode: 'drive', seed: 7 }, dev: true });
    expect(parseLaunch('?mode=drive&seed=7')).toEqual({ deepLink: { mode: 'drive', seed: 7 }, dev: false });
    expect(parseLaunch('?seed=42')).toEqual({ deepLink: { mode: 'bot', seed: 42 }, dev: false });
    expect(parseLaunch('?mode=local')).toEqual({ deepLink: { mode: 'local', seed: null }, dev: false });
    expect(parseLaunch('?mode=bot&residentCheck=1&dev')).toEqual({ deepLink: { mode: 'bot', seed: null }, dev: true });
    // An unknown mode alone is not a deep link; a bad seed still starts a match (on a random planet).
    expect(parseLaunch('?mode=campaign').deepLink).toBeNull();
    expect(parseLaunch('?seed=banana').deepLink).toEqual({ mode: 'bot', seed: null });
  });

  it('strips only the match keys when returning to the menu, and toggles ?mode=drive', () => {
    expect(menuSearch('?mode=drive&seed=7&dev')).toBe('?dev');
    expect(menuSearch('?seed=7')).toBe('');
    expect(driveTestSearch('?seed=7', true)).toBe('?seed=7&mode=drive');
    expect(driveTestSearch('?mode=drive&seed=7', false)).toBe('?seed=7');
    expect(driveTestSearch('?mode=local', false)).toBe('?mode=local');
  });
});

describe('skirmish setup', () => {
  it('builds the practice duel as a skirmish by default (mode skirmish since the wave-1 merge)', () => {
    const options = defaultSkirmish(7);
    const setup = skirmishSetup(options, KIT);
    expect(setup.mode).toBe('skirmish');
    expect(setup.seed).toBe(7);
    expect(setup.planet).toEqual({ kind: 'auto' });
    expect(setup.rules).toEqual({ ...DEFAULT_RULES, ammo: {} });
    expect(setup.objectives).toEqual([{ kind: 'eliminate' }]);
    expect(setup.tanks.map(t => [t.team, t.brain, t.difficulty, t.spawn])).toEqual([[0, undefined, undefined, 'auto'], [1, 'legacy', 'normal', 'auto']]);
    expect(setup.tanks.every(t => JSON.stringify(t.loadout) === JSON.stringify(KIT))).toBe(true);
    expect(setup.teams.map(t => t.ai)).toEqual([false, true]);
    // Field for field the practice duel, apart from the mode, ids and display names.
    const practice = practiceSetup({ seed: 7, mode: 'bot', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } });
    const shape = (s: MatchSetup) => ({ seed: s.seed, planet: s.planet, rules: s.rules, objectives: s.objectives, structures: s.structures, initialCuts: s.initialCuts,
      environment: s.environment, teams: s.teams.map(t => [t.id, t.ai]), tanks: s.tanks.map(t => [t.team, t.loadout, t.spawn, t.brain, t.difficulty, t.maxHealth]) });
    expect(shape(setup)).toEqual(shape(practice));
  });

  it('builds N-tank and team setups that name every tank and alternate 2v2 teams', () => {
    const ffa = skirmishSetup({ ...defaultSkirmish(1), tanks: 4, brain: 'tosser', difficulty: 'hard' }, KIT);
    expect(ffa.teams).toHaveLength(4);
    expect(ffa.tanks.map(t => t.team)).toEqual([0, 1, 2, 3]);
    expect(ffa.tanks.map(t => t.name)).toEqual(['You', 'Tosser 1', 'Tosser 2', 'Tosser 3']);
    expect(ffa.tanks.slice(1).every(t => t.brain === 'tosser' && t.difficulty === 'hard')).toBe(true);
    const teams = skirmishSetup({ ...defaultSkirmish(1), tanks: 4, teams: '2v2' }, KIT);
    expect(teams.tanks.map(t => t.team)).toEqual([0, 1, 0, 1]);
    expect(teams.teams).toEqual([{ id: 0, name: 'Brass team', ai: false }, { id: 1, name: 'Rust team', ai: true }]);
    const local = skirmishSetup({ ...defaultSkirmish(1), opponents: 'local', tanks: 3 }, KIT);
    expect(local.mode).toBe('local');
    expect(local.tanks.every(t => t.brain === undefined)).toBe(true);
    expect(local.tanks.map(t => t.name)).toEqual(['Player 1', 'Player 2', 'Player 3']);
    expect(skirmishMode(defaultSkirmish(1))).toBe('skirmish');
  });

  it('maps rule toggles onto MatchRules and rejects impossible options', () => {
    const rules = skirmishRules({ wind: true, fog: false, friendlyFire: false, aimTimer: true, limitedAmmo: true });
    expect(rules).toMatchObject({ fog: false, friendlyFire: false, aimSeconds: 20, ammo: { heavy: 3, incendiary: 2, nuclear: 1 } });
    expect(rules.wind).toEqual({ mean: 1.2, gust: 0.6, period: 6 });
    expect(skirmishProblem({ ...defaultSkirmish(1), teams: '2v2', tanks: 3 })).toMatch(/4 tanks/);
    expect(skirmishProblem({ ...defaultSkirmish(1), tanks: 5 })).toMatch(/2 to 4/);
    expect(skirmishProblem({ ...defaultSkirmish(-1) })).toMatch(/seed/);
    expect(() => skirmishSetup({ ...defaultSkirmish(1), tanks: 1 }, KIT)).toThrow(/2 to 4/);
  });
});

describe('workshop model', () => {
  it('shows the complete implemented catalogue with assembled stats and explicit mount failures', () => {
    const hulls = partCards(KIT, 'hull');
    expect(hulls.map(c => c.id)).toEqual(['skiff', 'warden', 'bastion', 'aether_hull', 'forge_hull']);
    expect(hulls.find(c => c.id === 'warden')!.status).toBe('fitted');
    // Bastion assembles from Wave 0 on (a v1-mapped part); whether it fits the budget depends on the kit's costs.
    expect(['available', 'over-budget']).toContain(hulls.find(c => c.id === 'bastion')!.status);
    for (const card of hulls.filter(c => c.stats)) expect(Object.values(card.stats!).every(Number.isFinite)).toBe(true);
    for (const card of hulls) expect(['fitted', 'available', 'coming-soon', 'over-budget']).toContain(card.status);
    expect(partCards(KIT, 'weapon', Infinity).map(c => c.id)).toEqual(['mortar', 'cannon', 'rail', 'autocannon', 'arc_cannon', 'forge_mortar']);
    expect(partCards(KIT, 'utility', Infinity).map(c => c.id)).toEqual(['antenna', 'radar', 'periscope', 'smoke', 'whip_short', 'yagi', 'point_defense', 'aether_vane', 'steam_sentinel']);
    for (const card of partCards(KIT, 'utility', Infinity)) { expect(card.stats).not.toBeNull(); expect(['fitted', 'available']).toContain(card.status); }
    expect(buildStats(KIT)!.cost).toBeLessThanOrEqual(FITTING_BUDGET);
    expect(kitSummary(KIT)).toBe('Warden · Scout tracks · Dome · Arc mortar · Field antenna');
  });

  it('refuses parts over the fitting budget and parts that do not assemble', () => {
    // With the budget at the current cost, every pricier part is over budget and cannot be fitted.
    const budget = buildStats(KIT)!.cost;
    const pricier = partCards(KIT, 'weapon', budget).filter(c => c.stats && c.stats.cost > budget);
    expect(pricier.length).toBeGreaterThan(0);
    for (const card of pricier) {
      expect(card.status).toBe('over-budget');
      expect(card.reason).toContain(`${budget}`);
      expect(fitPart(KIT, 'weapon', card.id, budget)).toEqual(KIT);
      expect(fitPart(KIT, 'weapon', card.id, 99)).toEqual({ ...KIT, weapon: card.id });
    }
    const soon = partCards(KIT, 'turret').find(c => c.status === 'coming-soon');
    if (soon) expect(fitPart(KIT, 'turret', soon.id)).toEqual(KIT);
  });
});

describe('HUD model', () => {
  const setup = skirmishSetup(defaultSkirmish(7), KIT);
  it('lists every tank with fog-of-war health and remembers the last sighting', () => {
    const seen = new Map<number, number>();
    const state = snapshot([tank(0), tank(1, { health: 80 })]);
    let rows = rosterRows(state, setup, 0, seen);
    expect(rows.map(r => [r.name, r.self, r.ally, r.active, r.health, r.stale])).toEqual([['You', true, true, true, 100, false], ['Classic', false, false, false, null, true]]);
    state.contacts[0] = { position: [0, 0, 0], observedAt: 0, source: 'sight', visible: true };
    rows = rosterRows(state, setup, 0, seen);
    expect(rows[1].health).toBe(80);
    state.contacts[0] = { position: [0, 0, 0], observedAt: 0, source: 'sight', visible: false };
    state.tanks[1].health = 20;
    rows = rosterRows(state, setup, 0, seen);
    expect([rows[1].health, rows[1].stale]).toEqual([80, true]);
    expect(rows[0].maxHealth).toBeGreaterThan(0);
    // No fog: everyone is visible.
    expect(rosterRows(state, { ...setup, rules: { ...setup.rules, fog: false } }, 0, new Map())[1].health).toBe(20);
  });

  it('writes the banner for each phase and side', () => {
    const state = snapshot([tank(0), tank(1)]);
    expect(banner(state, setup, 0, false)).toMatchObject({ turn: 'TURN 03', tag: 'YOUR SHOT' });
    expect(banner({ ...state, phase: 'resolving' }, setup, 0, false).tag).toBe('RELOCATE');
    expect(banner({ ...state, active: 1 }, setup, 0, false)).toMatchObject({ tag: 'OPPONENT TURN', title: 'Classic is up.' });
    expect(banner(state, setup, 0, true)).toMatchObject({ turn: 'DRIVE TEST', tag: 'FREE DRIVE' });
    expect(banner({ ...state, phase: 'finished' }, setup, 0, false).tag).toBe('MATCH OVER');
  });

  it('shows ammo counts (unlimited by default), cycles munitions with rounds, and reads the rules chips', () => {
    const chips = ammoChips(tank(0), setup.rules);
    expect(chips.map(c => [c.short, c.count, c.selected])).toEqual([['HE', null, true], ['HVY', null, false], ['INC', null, false], ['NUK', null, false]]);
    const limited = skirmishRules({ wind: true, fog: true, friendlyFire: true, aimTimer: true, limitedAmmo: true });
    const withSim = ammoChips(tank(0, { munition: 'heavy', ...({ ammo: { heavy: 0, incendiary: 2 } } as object) }), limited);
    expect(withSim.map(c => c.count)).toEqual([null, 0, 2, 1]);
    expect(cycleMunition(withSim, 1)).toBe('incendiary');
    expect(cycleMunition(withSim, -1)).toBe('explosive');
    expect(windLabel(DEFAULT_RULES)).toBe('Calm');
    expect(windLabel(limited)).toBe('1.2 m/s · gusts 0.6');
    expect(aimSecondsLeft(snapshot([tank(0)]), limited)).toBe(16);
    expect(aimSecondsLeft(snapshot([tank(0)]), DEFAULT_RULES)).toBeNull();
    expect(objectiveLabel(snapshot([tank(0), tank(1, { health: 0 })]), setup, 0)).toBe('Eliminate the opposition · 1/1');
  });
});

describe('results model', () => {
  // Fixed maximum health, so the numbers do not depend on kit stats (W1-KIT re-derives them).
  const fixed = (s: MatchSetup): MatchSetup => ({ ...s, tanks: s.tanks.map(t => ({ ...t, maxHealth: 100 })) });
  const setup = fixed(skirmishSetup(defaultSkirmish(7), KIT));
  it('omits turns in realtime results and does not count departures as enemy damage', () => {
    const realtime = fixed(skirmishSetup({ ...defaultSkirmish(7), tanks: 3 }, KIT));
    realtime.rules.turnModel = 'realtime';
    const state = snapshot([tank(0), tank(1, { health: 0, destroyedAt: 30, retired: true }), tank(2, { health: 0, retired: true })]);
    const result = matchSummary({ state, setup: realtime, observer: 0, winner: 0, forfeited: false, shots: new Map([[0, 2]]) });
    expect(result.stats.some(stat => stat.label === 'Turns')).toBe(false);
    expect(result.stats.find(stat => stat.label === 'Enemy hull lost')?.value).toBe('100');
    expect(result.stats.find(stat => stat.label === 'Match time')?.value).toBe('1:15');
  });
  it('writes the outcome for wins, losses, draws, forfeits and pass-and-play', () => {
    const state = snapshot([tank(0, { health: 64 }), tank(1, { health: 0 })]);
    const shots = new Map([[0, 3]]);
    const win = matchSummary({ state, setup, observer: 0, winner: 0, forfeited: false, shots });
    expect(win).toMatchObject({ title: 'Victory!', outcome: 'win' });
    expect(win.stats).toEqual([
      { label: 'Turns', value: '3' }, { label: 'Shots fired', value: '3' }, { label: 'Damage dealt', value: '100' },
      { label: 'Hull left', value: '64/100' }, { label: 'Match time', value: '1:15' },
    ]);
    expect(matchSummary({ state, setup, observer: 0, winner: 1, forfeited: false, shots }).outcome).toBe('loss');
    expect(matchSummary({ state, setup, observer: 0, winner: null, forfeited: false, shots }).outcome).toBe('draw');
    expect(matchSummary({ state: undefined, setup, observer: 0, winner: null, forfeited: true, shots }).stats).toEqual([]);
    const local = fixed(skirmishSetup({ ...defaultSkirmish(7), opponents: 'local' }, KIT));
    expect(matchSummary({ state, setup: local, observer: 0, winner: 1, forfeited: false, shots }).title).toBe('Player 2 wins.');
    expect(wonBy(setup, 0, 0)).toBe(true);
    expect(wonBy(setup, 0, null)).toBe(false);
    const teams = skirmishSetup({ ...defaultSkirmish(7), tanks: 4, teams: '2v2' }, KIT);
    expect(wonBy(teams, 0, 2)).toBe(true);
    expect(clock(3599.9)).toBe('59:59');
  });
});
