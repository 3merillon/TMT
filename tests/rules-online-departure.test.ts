import { expect, it } from 'vitest';
import { makeOnlineSetup } from '../src/game/online/setup';
import { RealtimeMatch } from '../src/game/realtime/match';
import { realtimeRun, site, WARDEN } from './helpers/realtime';
import { SphereWorld } from './helpers/sphere-world';

it.each(['realtime', 'artillery'] as const)('continues %s after a third player leaves and resolves the remaining real projectile duel', mode => {
  const setup = makeOnlineSetup(mode, 3, WARDEN); setup.rules.fog = false;
  setup.tanks[0].spawn = { up: site(0), heading: 0 };
  setup.tanks[1].spawn = { up: site(13.5), heading: Math.PI }; setup.tanks[1].maxHealth = 20;
  setup.tanks[2].spawn = { up: site(-13.5), heading: 0 };
  const run = realtimeRun(setup), replica = new RealtimeMatch(new SphereWorld(), setup, { replica: true });
  try {
    run.match.configureOnlineSeats([{ seat: 0, name: 'Host' }, { seat: 1, name: 'Remaining guest' }]); run.run(1);
    expect(run.match.state.tanks[2]).toMatchObject({ health: 0, retired: true }); expect(run.match.finished).toBe(false);
    const center = run.match.state.tanks[1].position;
    const solution = run.match.solveAimTarget(0, { point: center, object: { id: 'tank:1', kind: 'tank', collider: { shape: 'sphere', center, radius: .7 } } });
    expect(solution.status).toBe('ready'); run.match.command(0, { k: 'aim', ...solution.aim! }); expect(run.match.command(0, { k: 'fire' })).toBe(true);
    expect(run.until(r => r.match.finished, 600)).toBe(true);
    expect(run.match.state.winner).toBe(0); expect(run.events.filter(e => e.type === 'finish')).toHaveLength(1);
    expect(run.events.filter(e => e.type === 'kill' && e.tank === 1 && e.by === 0)).toHaveLength(1);
    expect(run.events.filter(e => e.type === 'kill' && e.tank === 2)).toHaveLength(0);
    replica.applyReplica(run.match.replica()); expect(replica.state).toEqual(run.match.state);
  } finally { run.match.dispose(); replica.dispose(); }
});
