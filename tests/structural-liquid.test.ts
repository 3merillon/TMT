import { expect, it } from 'vitest';
import { testPhysics } from './helpers/native-physics';
import type { BodyCandidate } from '../src/gpu/terrain/contracts';
import { structuralImmersion } from '../src/game/structural-liquid';

const vertices = new Float32Array([-1,-1,-1, 1,-1,-1, -1,1,-1, 1,1,-1, -1,-1,1, 1,-1,1, -1,1,1, 1,1,1]);
const candidate = (id: number, x = 0): BodyCandidate => ({ id, regions: [], center: [x, 100, 0],
  colliders: [{ vertices, indices: new Uint32Array(), volume: 8, regionIds: [] }] });

it('slows translation and spin in water, restores dry damping, and leaves held/sleeping bodies at rest', async () => {
  const physics = await testPhysics([0, 0, 0]);
  let wet = true;
  physics.liquid = p => wet && p[0] < 0 ? { level: 105, material: 'water' } : null;
  try {
    physics.stage([], [candidate(1, -5), candidate(2, 5)]).commit();
    const water = physics.bodies.get(1)!.body, dry = physics.bodies.get(2)!.body;
    for (const b of [water, dry]) { b.setLinvel({ x: 0, y: 0, z: 4 }, true); b.setAngvel({ x: 0, y: 2, z: 0 }, true); }
    for (let i = 0; i < 30; i++) physics.step();
    expect(water.linvel().z).toBeLessThan(dry.linvel().z * .5);
    expect(Math.abs(water.angvel().y)).toBeLessThan(Math.abs(dry.angvel().y) * .5);
    expect(Math.abs(water.linvel().y)).toBeLessThan(Math.abs(dry.linvel().y));
    wet = false; physics.step();
    expect(water.linearDamping()).toBeCloseTo(.15, 6);
    expect(water.angularDamping()).toBeCloseTo(.25, 6);
    wet = true; water.sleep(); const held = { ...water.translation() };
    physics.step(); expect(water.isSleeping()).toBe(true); expect(water.translation()).toEqual(held);
    water.setBodyType(2, false); water.wakeUp(); const before = { ...water.translation() };
    physics.step(); expect(water.translation()).toEqual(before);
  } finally { physics.dispose(); }
});

it('uses orientation, collider offsets and occupied volume for partial immersion', () => {
  const shape = candidate(1).colliders[0];
  const at = (level: number) => structuralImmersion([shape], [0, 100, 0], [0,0,0,1], [0,0,0], level);
  expect(at(98)).toBe(0); expect(at(100)).toBeCloseTo(.5); expect(at(102)).toBe(1);
  expect(structuralImmersion([{ ...shape, offset: [0, 4, 0] }], [0,100,0], [0,0,0,1], [0,0,0], 100)).toBe(0);
  expect(structuralImmersion([{ ...shape, offset: [0, 4, 0] }], [0,100,0], [0,0,1,0], [0,0,0], 100)).toBe(1);
});

it('repeats submerged motion exactly and recomputes resistance after a pose restore', async () => {
  const run = async () => {
    const p = await testPhysics([0,0,0]); p.liquid = () => ({ level: 100, material: 'water' });
    try {
      p.stage([], [candidate(1)]).commit(); const initial = p.motions();
      for (let i = 0; i < 40; i++) p.step(); const first = p.motions();
      p.restoreMotions(initial, 0);
      for (let i = 0; i < 40; i++) p.step();
      expect(p.motions()).toEqual(first); return first;
    } finally { p.dispose(); }
  };
  expect(await run()).toEqual(await run());
});
