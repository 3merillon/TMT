import { describe, expect, it } from 'vitest';
import { ProjectileTrailState, PROJECTILE_TRAIL, TRAIL_STYLE } from '../src/game/presentation/projectile-trail-state';

describe('projectile smoke trails', () => {
  it('samples travelled distance evenly at different frame rates without changing the supplied path', () => {
    const run = (steps: number) => {
      const state = new ProjectileTrailState();
      for (let i = 0; i <= steps; i++) {
        state.beginFrame(.5 / steps); state.track(1, 'explosive', [i / steps * 5, 20, 0], i / steps * .5); state.endFrame();
      }
      return state;
    };
    const slow = run(15), fast = run(60);
    expect(slow.particles.length).toBe(51); expect(fast.particles.length).toBe(51);
    slow.particles.forEach((p, i) => {
      expect(p.position[0]).toBeCloseTo(i * .1, 8);
      expect(p.position[0]).toBeCloseTo(fast.particles[i].position[0], 8);
    });
  });

  it('lingers after impact, fades within its lifetime, and never emits from a stationary or retired projectile', () => {
    const state = new ProjectileTrailState();
    for (let i = 0; i < 20; i++) { state.beginFrame(.01); state.track(1, 'heavy', [0, 20, 0], i * .01); state.endFrame(); }
    expect(state.particles).toHaveLength(1);
    state.beginFrame(.1); state.endFrame();
    expect(state.snapshot().emitters).toBe(0); expect(state.particles).toHaveLength(1);
    for (let i = 0; i < 20; i++) { state.beginFrame(.1); state.endFrame(); }
    expect(state.particles).toHaveLength(0);
  });

  it('starts a fresh trail after hidden flight, a teleport or restored projectile age', () => {
    const state = new ProjectileTrailState();
    state.beginFrame(.016); state.track(1, 'explosive', [0, 20, 0], .2); state.endFrame();
    state.beginFrame(.016); state.endFrame(); // no visible shell supplied
    state.beginFrame(.016); state.track(1, 'explosive', [4, 20, 0], .6); state.endFrame();
    state.beginFrame(.016); state.track(1, 'explosive', [5, 20, 0], .1); state.endFrame();
    state.beginFrame(.016); state.track(1, 'explosive', [100, 20, 0], .2); state.endFrame();
    expect(state.particles.map(p => p.position[0])).toEqual([0, 4, 5, 100]);
  });

  it('caps simultaneous trails and clears all particles and emitters on restart', () => {
    const state = new ProjectileTrailState();
    for (let frame = 0; frame < 5; frame++) {
      state.beginFrame(.016);
      for (let id = 0; id < 100; id++) state.track(id, 'nuclear', [frame * 3, 20, id], frame * .016);
      state.endFrame();
    }
    expect(state.particles).toHaveLength(PROJECTILE_TRAIL.capacity);
    expect(state.particles.every(p => p.position.every(Number.isFinite) && p.age < TRAIL_STYLE[p.munition].life)).toBe(true);
    state.clear(); expect(state.snapshot()).toEqual({ particles: 0, emitters: 0, capacity: PROJECTILE_TRAIL.capacity });
  });
});
