import { describe, expect, it } from 'vitest';
import { makeOnlineSetup } from '../src/game/online/setup';
import { RealtimeMatch } from '../src/game/realtime/match';
import { validateMatchSetup } from '../src/game/rules/setup';
import { defaultSkirmish } from '../src/game/ui/skirmish-setup';
import { banner, aimSecondsLeft, rosterRows } from '../src/game/ui/hud-model';
import { canAim, canDrive } from '../src/game/ui/input/contexts';
import { realtimeRun, site, SKIFF_MORTAR, WARDEN } from './helpers/realtime';
import { SphereWorld } from './helpers/sphere-world';

describe('online realtime artillery rules', () => {
  it('uses shared realtime combat with independent aim, movement, ammunition and reloads for all seats', () => {
    const options = defaultSkirmish(7); options.rules.aimTimer = true; options.rules.limitedAmmo = true;
    const setup = makeOnlineSetup('artillery', 3, SKIFF_MORTAR, options);
    expect(() => validateMatchSetup(setup)).not.toThrow();
    expect(setup.rules).toMatchObject({ turnModel: 'realtime', autoCoax: false });
    expect(setup.rules.aimSeconds).toBeUndefined();
    const run = realtimeRun(setup), before = run.match.state.tanks.map(t => [...t.position]);
    for (let id = 0; id < 3; id++) {
      expect(run.match.brainOf(id)).toBeNull();
      expect(run.match.command(id, { k: 'munition', id: 'heavy' })).toBe(true);
      expect(run.match.command(id, { k: 'aim', yaw: id * .4, pitch: 1.3, power: 1 })).toBe(true);
      expect(run.match.command(id, { k: 'fire' })).toBe(true);
      expect(run.match.command(id, { k: 'fire' })).toBe(false);
      expect(run.match.command(id, { k: 'drive', throttle: 1, steer: id * .1 })).toBe(true);
    }
    run.run(30);
    for (let id = 0; id < 3; id++) {
      const tank = run.match.state.tanks[id];
      expect(Math.hypot(...tank.position.map((v, i) => v - before[id][i]))).toBeGreaterThan(.2);
      expect(tank.ammo?.heavy).toBe(2); expect(run.match.reloadOf(id).remaining).toBeGreaterThan(0);
      const context = { screen: 'match' as const, snapshot: run.match.state, observer: id, ready: true, driveTest: false, realtime: true };
      expect(canAim(context)).toBe(true); expect(canDrive(context)).toBe(true);
    }
    expect(run.match.state.projectiles).toHaveLength(3);
    expect(run.events.some(e => e.type === 'turn')).toBe(false);
    expect(aimSecondsLeft(run.match.state, setup.rules)).toBeNull();
    expect(rosterRows(run.match.state, setup, 1, new Map()).some(t => t.active)).toBe(false);
    expect(banner(run.match.state, setup, 1, false).detail).toContain('Simultaneous artillery');
    run.match.dispose();
  });

  it('preserves classic turns and suppresses automatic damage only in the artillery preset', () => {
    expect(makeOnlineSetup('duel', 2, WARDEN).rules.turnModel).toBe('tempo');
    for (const mode of ['artillery', 'realtime'] as const) {
      const setup = makeOnlineSetup(mode, 2, WARDEN);
      setup.rules.fog = false;
      setup.tanks[0].spawn = { up: site(0), heading: 0 };
      setup.tanks[1].spawn = { up: site(7), heading: Math.PI };
      const run = realtimeRun(setup), before = run.match.state.tanks[1].health;
      run.run(90);
      expect(run.match.state.tanks[1].health < before).toBe(mode === 'realtime');
      expect(run.realtime.some(e => e.type === 'tracer')).toBe(mode === 'realtime');
      run.match.dispose();
    }
  });

  it('authoritatively resolves a guest shot, destruction and winner then replicates the exact result', () => {
    const setup = makeOnlineSetup('artillery', 2, WARDEN);
    setup.rules.fog = false;
    setup.tanks[1].spawn = { up: site(0), heading: 0 };
    setup.tanks[0].spawn = { up: site(13.5), heading: Math.PI };
    setup.tanks[0].maxHealth = 20;
    const run = realtimeRun(setup), replica = new RealtimeMatch(new SphereWorld(), setup, { replica: true });
    const center = run.match.state.tanks[0].position;
    const aim = run.match.solveAimTarget(1, { point: center, object: { id: 'tank:0', kind: 'tank', collider: { shape: 'sphere', center, radius: .7 } } });
    expect(aim.status).toBe('ready');
    run.match.command(1, { k: 'aim', ...aim.aim! }); expect(run.match.command(1, { k: 'fire' })).toBe(true);
    expect(run.until(r => r.match.finished, 600)).toBe(true);
    expect(run.events.filter(e => e.type === 'finish')).toHaveLength(1);
    expect(run.events.filter(e => e.type === 'kill' && e.tank === 0 && e.by === 1)).toHaveLength(1);
    expect(run.world.craters).toHaveLength(1);
    expect(run.match.state.winner).toBe(1);
    replica.applyReplica(run.match.replica());
    expect(replica.state).toEqual(run.match.state);
    run.match.dispose(); replica.dispose();
  });

  it('a presentation replica cannot run combat or spend ammo even when called through the runtime API', () => {
    const setup = makeOnlineSetup('realtime', 2, WARDEN);
    const replica = new RealtimeMatch(new SphereWorld(), setup, { replica: true });
    const before = structuredClone(replica.state);
    expect(replica.command(1, { k: 'fire' })).toBe(false);
    expect(replica.command(1, { k: 'utility', id: 'repair' })).toBe(false);
    for (let i = 0; i < 600; i++) expect(replica.step(1 / 60)).toEqual([]);
    expect(replica.state).toEqual(before);
    expect(replica.command(1, { k: 'aim', yaw: .3, pitch: .6, power: .8 })).toBe(true);
    replica.dispose();
  });
});
