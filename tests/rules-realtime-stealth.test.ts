import { describe, expect, it } from 'vitest';
import { realtimeRun, site, unit } from './helpers/realtime';
import { RealtimeCore } from '../src/game/realtime/core';

describe('searchlight exposure and headlights', () => {
  const fixture = () => realtimeRun(undefined, { units: [unit(1, site(8), { unarmed: true, immobile: true,
    spawn: { up: site(8), heading: 0 }, searchlight: { height: 1.8, range: 18, angle: .25, sweep: 0, period: 12 } })] });
  it('detects nearby headlight glints outside the beam and loses a dark target', () => {
    const play = fixture(); play.run(65);
    expect(play.match.state.tanks[0].detection).toBeGreaterThan(.9);
    expect(play.match.command(0, { k: 'utility', id: 'headlights' })).toBe(true);
    play.run(240); expect(play.match.state.tanks[0].detection).toBe(0);
    expect(play.match.state.tanks[0].headlights).toBe(false); play.match.dispose();
  });
  it('checks actual terrain cover before accumulating exposure, and destroyed projectors extinguish', () => {
    const play = fixture(); Object.assign(play.world, { blocked: () => true });
    play.run(120); expect(play.match.state.tanks[0].detection).toBe(0);
    expect(play.match.state.tanks[1].searchlight).toBeDefined();
    play.match.state.tanks[1].health = 0; play.run(1);
    expect(play.match.state.tanks[1].searchlight).toBeUndefined(); play.match.dispose();
  });
  it('uses a bounded native cone with no detection beyond its range', () => {
    const core = new RealtimeCore();
    expect(core.exposure([0, 0, 0], [0, 0, 1], [0, 0, 10], 18, .25, false)).toBe(.5);
    expect(core.exposure([0, 0, 0], [0, 0, 1], [0, 0, -10], 18, .25, false)).toBe(0);
    expect(core.exposure([0, 0, 0], [0, 0, 1], [0, 0, 20], 18, .25, true)).toBe(0);
  });
});
