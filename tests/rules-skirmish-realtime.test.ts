import { describe, expect, it } from 'vitest';
import { distance } from '../src/game/math';
import { defaultSkirmish, REALTIME_BRAIN_CHOICES, skirmishSetup, updateSkirmishOptions } from '../src/game/ui/skirmish-setup';
import { realtimeRun, site, WARDEN } from './helpers/realtime';

const options = () => updateSkirmishOptions(defaultSkirmish(7), { turnModel: 'realtime', difficulty: 'ace',
  rules: { wind: false, fog: false, friendlyFire: false, aimTimer: false, limitedAmmo: false } });

describe('local realtime artillery on the shared runtime', () => {
  it('resolves distinct automatic starts and moves the human and bot in the same ticks', () => {
    const run = realtimeRun(skirmishSetup({ ...options(), brain: 'tosser' }, WARDEN));
    const start = run.match.state.tanks.map(tank => [...tank.position] as [number, number, number]);
    expect(distance(start[0], start[1])).toBeGreaterThan(5);
    run.run(60, { throttle: 1, steer: .2 });
    expect(run.match.state.phase).toBe('aim');
    expect(run.match.state.active).toBe(0);
    for (const tank of run.match.state.tanks) expect(distance(tank.position, start[tank.id])).toBeGreaterThan(.5);
    expect(run.match.command(0, { k: 'aim', yaw: 0, pitch: .8, power: .6 })).toBe(true);
    expect(run.match.command(0, { k: 'fire' })).toBe(true);
    expect(run.match.command(0, { k: 'fire' })).toBe(false);
    run.match.dispose();
  });

  it.each(REALTIME_BRAIN_CHOICES)('$label uses its selected brain and damages the player with real ballistic shots', ({ id }) => {
    const run = realtimeRun(skirmishSetup({ ...options(), brain: id }, WARDEN));
    const health = run.match.state.tanks[0].health;
    expect(run.match.replica().units[1].spec).toMatchObject({ brain: id, difficulty: 'ace', loadout: WARDEN });
    expect(run.until(r => r.match.state.tanks[0].health < health, 1800)).toBe(true);
    expect(run.events.some(event => event.type === 'shot' && event.player === 1)).toBe(true);
    expect(run.events.some(event => event.type === 'impact' && event.owner === 1 && event.hits?.some(hit => hit.tank === 0 && hit.damage > 0))).toBe(true);
    expect(run.realtime.some(event => event.type === 'tracer')).toBe(false);
    run.match.dispose();
  });

  it('searches a fixed opposing start when fog hides the enemy', () => {
    const setup = skirmishSetup(options(), WARDEN); setup.rules.fog = true;
    setup.tanks[0].spawn = { up: site(0), heading: 0 };
    setup.tanks[1].spawn = { up: site(24), heading: Math.PI };
    const run = realtimeRun(setup), start = [...run.match.state.tanks[1].position] as [number, number, number];
    expect(run.match.state.observations?.[1]?.[0]).toBeNull();
    expect(run.match.replica().units[1].spec.waypoints).toEqual([site(0)]);
    run.run(120, { throttle: 1, steer: .4 });
    expect(distance(run.match.state.tanks[1].position, start)).toBeGreaterThan(1);
    expect(run.match.replica().units[1].spec.waypoints).toEqual([site(0)]);
    run.match.dispose();
  });

  it('lets surviving teammates finish a 2v2 battle after the human is destroyed', () => {
    const run = realtimeRun(skirmishSetup(updateSkirmishOptions(options(), { teams: '2v2' }), WARDEN));
    expect(new Set(run.match.state.tanks.map(tank => tank.position.join(','))).size).toBe(4);
    run.match.state.tanks[0].health = 0;
    run.run(1);
    expect(run.match.finished).toBe(false);
    run.match.state.tanks[1].health = run.match.state.tanks[3].health = 0;
    run.run(1);
    expect(run.match.finished).toBe(true);
    expect(run.match.state.winnerTeam).toBe(0);
    run.match.dispose();
  });
});
