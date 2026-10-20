import { describe, expect, it } from 'vitest';
import { crewBuild, profileCrew } from '../src/game/campaign/loadout';
import { defaultProfile, sanitizeProfile } from '../src/game/meta/profile';
import { campaignReward } from '../src/game/campaign/progress';
import { realtimeRun, realtimeSetup, site, unit } from './helpers/realtime';
import { RealtimeMatch, type ScriptApi } from '../src/game/realtime/match';
import { SphereWorld } from './helpers/sphere-world';
describe('crew progression', () => {
  it('enforces point budgets, four unique owned gadgets, rank gates and import sanitation', () => {
    const crew = crewBuild({ gunner: 5, driver: 5, commander: 5, gadgets: ['repair-kit', 'repair-kit', 'unknown'], ultimate: 'lance' }, 6, ['gadget:repair-kit']);
    expect(crew).toEqual({ gunner: 5, driver: 1, commander: 0, gadgets: ['repair-kit'], ultimate: null });
    const p = { ...defaultProfile(), rank: 6, unlocks: ['gadget:repair-kit'], crew };
    expect(profileCrew(sanitizeProfile(p)!)).toEqual(crew);
  });
  it('pays independent medal and optional improvements on different runs', () => {
    const first = campaignReward(defaultProfile(), '1-4', { medal: true, optional: false, secrets: 0 });
    const second = campaignReward(first, '1-4', { medal: false, optional: true, secrets: 1 });
    // Optional objective (10) plus one newly recovered secret (5); no repeat medal or clear payment.
    expect(second.xp - first.xp).toBe(15);
    expect(second.unlocks).toContain('gadget:mags-compass');
    expect(campaignReward(second, '1-4', { medal: true, optional: true, secrets: 1 }).xp).toBe(second.xp);
  });
  it('applies training, consumes repair kits and preserves their remaining charge in checkpoints', () => {
    let api!: ScriptApi; const setup = realtimeSetup();
    setup.crew = crewBuild({ gunner: 5, driver: 2, gadgets: ['repair-kit', 'lucky-cog'] });
    const run = realtimeRun(setup, { script: { start(a) { api = a; }, tick() {} } });
    const base = realtimeRun(realtimeSetup());
    expect(run.match.reloadOf(0).total).toBeLessThan(base.match.reloadOf(0).total * .8);
    expect(run.match.state.tanks[0].maxHealth).toBeCloseTo(base.match.state.tanks[0].maxHealth! * 1.15);
    api.damage(0, 90); run.match.state.tanks[0].charge = 0;
    expect(run.match.command(0, { k: 'utility', id: 'repair' })).toBe(true);
    expect(run.match.abilities().repairKits).toBe(1); expect(run.match.state.tanks[0].charge).toBe(0);
    const restored = new RealtimeMatch(new SphereWorld(), setup, { checkpoint: run.match.checkpoint()! });
    expect(restored.abilities().repairKits).toBe(1);
    base.match.dispose(); restored.dispose(); run.match.dispose();
  });
  for (const ultimate of ['nuclear', 'hammer', 'lance'] as const) it(`${ultimate} is telegraphed, fires once and cannot be replenished by a checkpoint`, () => {
    const setup = realtimeSetup(); setup.crew = crewBuild({ ultimate });
    const run = realtimeRun(setup, { units: [unit(1, site(9), { unarmed: true, maxHealth: 1000 })], script: { start() {}, tick() {} } });
    const own = run.match.state.tanks[0]; own.charge = 3;
    expect(run.match.command(0, { k: 'utility', id: 'ultimate' })).toBe(true);
    expect(run.match.canFire(0)).toBe(false); expect(run.match.checkpoint()).toBeNull();
    run.run(179); expect(run.events.some(e => e.type === 'impact' || e.type === 'shot')).toBe(false);
    run.run(1); expect(run.match.abilities()).toMatchObject({ used: true, charging: false });
    expect(run.events.some(e => e.type === 'impact' || e.type === 'shot')).toBe(true);
    own.charge = 3; expect(run.match.command(0, { k: 'utility', id: 'ultimate' })).toBe(false);
    run.match.dispose();
  });
});
