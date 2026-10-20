import { afterEach, expect, it, vi } from 'vitest';
import { Tracers, TRACER } from '../src/game/presentation/tracers';
import { ImpactFlashes } from '../src/game/presentation/impact-flash';
import { HitFeedback } from '../src/game/presentation/hit-feedback';
import { makeTank } from './helpers/vehicle-world';

afterEach(() => vi.unstubAllGlobals());
it('draws bounded opaque streaks for rapid fire and sparks, then releases every instance', () => {
  let id = 0;
  const models = new Map<number, Float32Array>(), mesh = vi.fn(() => ({ id: ++id })), visibility = vi.fn();
  const scene = { meshes: { create: mesh, destroy: vi.fn() }, instances: {
    add: (_mesh: unknown, init: { model: Float32Array; visibility?: number }) => {
      expect(init.visibility ?? 1).toBe(1); const handle = { id: ++id }; models.set(handle.id, init.model.slice()); return handle;
    }, set: (h: { id: number }, model: Float32Array) => { expect([...model].every(Number.isFinite)).toBe(true); models.set(h.id, model.slice()); },
    remove: (h: { id: number }) => models.delete(h.id), setVisibility: visibility,
  } };
  const tracers = new Tracers(scene as never);
  for (let frame = 0; frame < 120; frame++) {
    for (let i = 0; i < 12; i++) tracers.fire([0, 20, 1], [0, 20, 0]);
    tracers.update(1 / 60);
    expect(tracers.active).toBeLessThanOrEqual(TRACER.pool); expect(models.size).toBeLessThanOrEqual(TRACER.pool * 7);
  }
  tracers.fire([0, 20, 0], [0, 20, 0]); tracers.update(.01);
  expect(mesh).toHaveBeenCalledWith(expect.objectContaining({ label: 'armor-spark-streak' }));
  expect(visibility).not.toHaveBeenCalled();
  tracers.update(2); expect(models.size).toBe(0); tracers.dispose();
});
it('keeps explosion lighting without resurrecting a sphere when fluids are unavailable', () => {
  const create = vi.fn(), scene = { meshes: { create }, get: () => undefined, lights: { add: () => ({ id: 1 }), update: vi.fn(), remove: vi.fn() } };
  const flashes = new ImpactFlashes(scene as never); flashes.impact([0, 18, 0], [0, 1, 0], 2);
  expect(flashes.active).toBe(1); expect(create).not.toHaveBeenCalled(); flashes.update(3); expect(flashes.active).toBe(0);
});
it('pulses on actual damage, including small rapid hits, and clears across heals and actor changes', () => {
  const element = { className: '', setAttribute: vi.fn(), style: { opacity: '' }, remove: vi.fn() };
  vi.stubGlobal('document', { createElement: () => element });
  const feedback = new HitFeedback({ append: vi.fn() } as never), tank = makeTank(0, { position: [0, 18, 0] });
  feedback.update(tank, .016); expect(+element.style.opacity).toBe(0);
  tank.health -= 1; expect(feedback.update(tank, .016)).toBeGreaterThan(0); expect(+element.style.opacity).toBeGreaterThan(.35);
  tank.health += 1; expect(feedback.update(tank, 1)).toBe(0); expect(+element.style.opacity).toBe(0);
  tank.health -= 30; feedback.update(tank, .016); tank.generation = 2; feedback.update(tank, .016);
  expect(+element.style.opacity).toBe(0); feedback.dispose();
});
