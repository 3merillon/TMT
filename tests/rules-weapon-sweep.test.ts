/** Every weapon fires every munition into terrain without throwing, in realtime and tempo play, and every part of every
 * valid kit drives and fires (the scout autocannon's 1.25 blast once threw below the terrain's minimum crater). */
import { describe, expect, it } from 'vitest';
import { realtimeRun, realtimeSetup, site, unit, WARDEN } from './helpers/realtime';
import { SphereWorld } from './helpers/sphere-world';
import type { KitLoadoutIds } from '../src/game/api/match';
import { assembleKit } from '../src/game/kit';
import { KIT_PART_IDS, KIT_SLOTS, validateKitLoadout } from '../src/game/kit/catalog';
import { MUNITIONS, type MunitionId } from '../src/game/munitions';
import { NUKE_CHARGE } from '../src/game/rules/ammo';
import { GameSimulation } from '../src/game/simulation';

const MUNITION_IDS = Object.keys(MUNITIONS) as MunitionId[];

function fireRealtime(player: KitLoadoutIds, munition: MunitionId) {
  const run = realtimeRun(realtimeSetup({ player }), { units: [unit(1, site(7)), unit(1, site(3, 2))] });
  run.run(30);
  expect(run.match.command(0, { k: 'munition', id: munition })).toBe(true);
  run.run(400, { throttle: 0.6, steer: 0.3 });
  for (const pitch of [0.15, 0.5, 1.2]) for (const power of [0.2, 0.9]) {
    const tank = run.match.state.tanks[0];
    if (tank.health <= 0) break; // a light hull can lose to its own close shell; that is play, not a fault
    tank.charge = NUKE_CHARGE; if (tank.ammo?.nuclear !== undefined) tank.ammo.nuclear = 1;
    run.match.command(0, { k: 'aim', yaw: 0, pitch, power });
    expect(run.match.command(0, { k: 'fire' })).toBe(true);
    run.run(300);
  }
  return run;
}

const VALID: KitLoadoutIds[] = [];
for (const hull of KIT_PART_IDS.hull) for (const runningGear of KIT_PART_IDS.runningGear) for (const turret of KIT_PART_IDS.turret)
  for (const weapon of KIT_PART_IDS.weapon) for (const utility of KIT_PART_IDS.utility) {
    const kit = { hull, runningGear, turret, weapon, utility };
    try { validateKitLoadout(kit); VALID.push(kit); } catch { /* a socket mismatch the workshop never offers */ }
  }

describe('weapon sweep', () => {
  for (const weapon of KIT_PART_IDS.weapon) for (const munition of MUNITION_IDS) it(`realtime ${weapon} / ${munition}`, () => {
    const run = fireRealtime({ ...WARDEN, weapon }, munition);
    expect(run.events.filter(e => e.type === 'shot').length).toBeGreaterThan(0);
    expect(run.events.some(e => e.type === 'impact')).toBe(true);
  });

  for (const weapon of KIT_PART_IDS.weapon) for (const munition of MUNITION_IDS) it(`tempo ${weapon} / ${munition}`, () => {
    const setup = realtimeSetup({ player: { ...WARDEN, weapon } });
    setup.rules = { ...setup.rules, turnModel: 'tempo' };
    setup.teams = setup.teams.map(t => ({ ...t, ai: false }));
    setup.tanks = [...setup.tanks, { team: 1, loadout: { ...WARDEN, weapon }, spawn: { up: site(7), heading: Math.PI }, name: 'Rust' }];
    const sim = new GameSimulation(new SphereWorld(), setup);
    const events: { type: string }[] = [];
    for (let turn = 0; turn < 6; turn++) {
      const p = sim.state.active, tank = sim.state.tanks[p];
      if (sim.state.phase === 'finished') break;
      tank.charge = NUKE_CHARGE; if (tank.ammo?.nuclear !== undefined) tank.ammo.nuclear = 1;
      sim.command(p, { k: 'munition', id: munition });
      sim.command(p, { k: 'endMove' });
      sim.command(p, { k: 'aim', yaw: 0, pitch: 0.5 + turn * 0.1, power: 0.7 });
      sim.command(p, { k: 'fire' });
      for (let i = 0; i < 900; i++) events.push(...sim.step(1 / 60));
    }
    expect(events.some(e => e.type === 'impact')).toBe(true);
  });

  it('every valid kit assembles', () => {
    expect(VALID.length).toBeGreaterThan(1000);
    for (const kit of VALID) expect(assembleKit(validateKitLoadout(kit)).stats.hp).toBeGreaterThan(0);
  });

  for (const slot of KIT_SLOTS) for (const id of KIT_PART_IDS[slot]) it(`realtime kit with ${slot} ${id}`, () => {
    const kits = VALID.filter(k => k[slot] === id);
    expect(kits.length).toBeGreaterThan(0);
    fireRealtime(kits[0], 'explosive');
    fireRealtime(kits[kits.length - 1], 'heavy');
  });
});
