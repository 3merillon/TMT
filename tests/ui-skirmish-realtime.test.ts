import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES } from '../src/game/api/match';
import { makeOnlineSetup } from '../src/game/online/setup';
import { validateMatchSetup } from '../src/game/rules/setup';
import { defaultSkirmish, skirmishProblem, skirmishSetup, updateSkirmishOptions } from '../src/game/ui/skirmish-setup';

const KIT = { hull: 'warden', runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna' };

describe('local artillery combat selection', () => {
  it('keeps the original turn-based default and switches to an available realtime AI profile', () => {
    const classic = defaultSkirmish(7);
    expect(skirmishSetup(classic, KIT).rules).toEqual({ ...DEFAULT_RULES, ammo: {} });
    const live = updateSkirmishOptions(classic, { turnModel: 'realtime' });
    expect(live).toMatchObject({ turnModel: 'realtime', opponents: 'ai', brain: 'rusty' });
    expect(updateSkirmishOptions({ ...classic, brain: 'tosser' }, { turnModel: 'realtime' }).brain).toBe('tosser');
  });

  it('switches pass-and-play to classic and rejects bypassing that invariant', () => {
    const live = updateSkirmishOptions(defaultSkirmish(7), { turnModel: 'realtime' });
    const local = updateSkirmishOptions(live, { opponents: 'local' });
    expect(local.turnModel).toBe('tempo');
    expect(skirmishSetup(local, KIT).tanks.every(tank => tank.brain === undefined)).toBe(true);
    expect(updateSkirmishOptions(local, { turnModel: 'realtime' }).turnModel).toBe('tempo');
    expect(skirmishProblem({ ...live, opponents: 'local' })).toMatch(/Pass-and-play/);
    expect(() => skirmishSetup({ ...live, opponents: 'local' }, KIT)).toThrow(/Pass-and-play/);
    const invalid = skirmishSetup(live, KIT); invalid.mode = 'local';
    expect(() => validateMatchSetup(invalid)).toThrow(/pass-and-play/);
  });

  it('preserves four-tank teams, build, difficulty and shared rules while dropping turn-only rules', () => {
    const options = updateSkirmishOptions(defaultSkirmish(19), { turnModel: 'realtime', teams: '2v2', brain: 'tosser', difficulty: 'ace', planet: 'glacial',
      rules: { wind: true, fog: false, friendlyFire: false, aimTimer: true, limitedAmmo: true } });
    const setup = validateMatchSetup(skirmishSetup(options, KIT));
    expect(setup).toMatchObject({ mode: 'skirmish', seed: 19, planet: { kind: 'glacial' },
      rules: { turnModel: 'realtime', autoCoax: false, fog: false, friendlyFire: false, ammo: { heavy: 3, incendiary: 2, nuclear: 1 } } });
    expect(setup.rules.aimSeconds).toBeUndefined();
    expect(setup.rules.wind).not.toBeNull();
    expect(setup.tanks.map(tank => tank.team)).toEqual([0, 1, 0, 1]);
    expect(setup.tanks.every(tank => JSON.stringify(tank.loadout) === JSON.stringify(KIT))).toBe(true);
    expect(setup.tanks.slice(1).every(tank => tank.brain === 'tosser' && tank.difficulty === 'ace')).toBe(true);
    expect(updateSkirmishOptions(options, { tanks: 3 })).toMatchObject({ tanks: 3, teams: 'ffa', turnModel: 'realtime' });
  });

  it('does not leak a local realtime selection into the selected online mode', () => {
    const options = updateSkirmishOptions(defaultSkirmish(7), { turnModel: 'realtime' });
    expect(makeOnlineSetup('duel', 2, KIT, options).rules.turnModel).toBe('tempo');
    expect(makeOnlineSetup('artillery', 3, KIT, options).rules).toMatchObject({ turnModel: 'realtime', autoCoax: false });
    expect(makeOnlineSetup('realtime', 2, KIT, options).rules).toMatchObject({ turnModel: 'realtime', autoCoax: true });
  });
});
