import { setCombatState } from './helpers/native-match';
/** Ammunition (rules/ammo.ts): per-match limits from rules.ammo, the nuke once per match and charge-gated, the drive
 * test as a sandbox. */
import { describe, expect, it } from 'vitest';
import { practiceSetup, type MatchSetup } from '../src/game/api/match';
import { initialAmmo, NUKE_CHARGE, NUKES_PER_MATCH, roundsLeft } from '../src/game/rules/ammo';
import { FIXED_DT, GameSimulation } from '../src/game/simulation';
import { SphereWorld } from './helpers/sphere-world';

const PLAYER = { tracks: 'scout', barrel: 'mortar', armor: 'light' } as const;
const local = (ammo: MatchSetup['rules']['ammo'] = {}): MatchSetup => {
  const setup = practiceSetup({ seed: 3, mode: 'local', player: PLAYER });
  setup.rules.ammo = ammo;
  return setup;
};
/** Finish the current shot and come back to tank 0's aim phase (tank 1 holds). */
function nextTurnOfZero(simulation: GameSimulation): void {
  simulation.endMove(simulation.state.active);
  for (let tick = 0; tick < 2000 && !(simulation.state.phase === 'aim' && simulation.state.active === 0); tick++) {
    simulation.step(FIXED_DT);
    if (simulation.stalledOn?.serial) simulation.completeLegacyCarve();
    if (simulation.state.phase === 'aim' && simulation.state.active === 1) simulation.hold(1);
    for (const tank of simulation.state.tanks) setCombatState(simulation, tank.id, { health: tank.maxHealth! });
  }
}

describe('ammunition limits', () => {
  it('counts only the limited munitions: rules.ammo entries plus one nuke', () => {
    expect(initialAmmo({ ammo: {} })).toEqual({ nuclear: NUKES_PER_MATCH });
    expect(initialAmmo({ ammo: { heavy: 2, nuclear: 0 } })).toEqual({ heavy: 2, nuclear: 0 });
    const simulation = new GameSimulation(new SphereWorld(), local({ heavy: 1 }));
    expect(simulation.state.tanks.map(tank => tank.ammo)).toEqual([{ heavy: 1, nuclear: 1 }, { heavy: 1, nuclear: 1 }]);
    expect(roundsLeft(simulation.state.tanks[0], 'explosive')).toBe(Infinity);
  });

  it('spends a limited round and refuses the munition once it is empty', () => {
    const simulation = new GameSimulation(new SphereWorld(), local({ heavy: 1 }));
    expect(simulation.selectMunition(0, 'heavy')).toBe(true);
    expect(simulation.fire(0)).toBe(true);
    expect(simulation.state.tanks[0].ammo?.heavy).toBe(0);
    nextTurnOfZero(simulation);
    expect(simulation.canFire(0)).toBe(false); // still loaded with the empty munition
    expect(simulation.fire(0)).toBe(false);
    expect(simulation.selectMunition(0, 'heavy')).toBe(false);
    expect(simulation.selectMunition(0, 'explosive')).toBe(true);
    expect(simulation.fire(0)).toBe(true);
  });

  it('charge-gates the nuke, spends the full charge, and allows one per match', () => {
    const simulation = new GameSimulation(new SphereWorld(), local());
    expect(simulation.selectMunition(0, 'nuclear')).toBe(true);
    expect(simulation.state.tanks[0].charge).toBeLessThan(NUKE_CHARGE);
    expect(simulation.canFire(0)).toBe(false);
    setCombatState(simulation, 0, { charge: NUKE_CHARGE });
    expect(simulation.fire(0)).toBe(true);
    expect(simulation.state.projectiles[0].munition).toBe('nuclear');
    expect(simulation.state.tanks[0].charge).toBe(0);
    expect(simulation.state.tanks[0].ammo?.nuclear).toBe(0);
    nextTurnOfZero(simulation);
    setCombatState(simulation, 0, { charge: NUKE_CHARGE });
    expect(simulation.fire(0)).toBe(false);
    expect(simulation.selectMunition(0, 'nuclear')).toBe(false);
  });

  it('keeps the drive test a sandbox without limits', () => {
    const simulation = new GameSimulation(new SphereWorld(), practiceSetup({ seed: 3, mode: 'drive', player: PLAYER }));
    expect(simulation.state.tanks[0].ammo).toBeUndefined();
    expect(simulation.selectMunition(0, 'nuclear')).toBe(true);
    expect(simulation.fire(0)).toBe(true);
  });
});
