import { beforeAll, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { buoyDebris, type DebrisBody } from '../src/game/presentation/debris-physics';
import { DebrisHost, type DebrisFrame } from '../src/game/presentation/debris-host';

beforeAll(async () => { await RAPIER.init(); });
const water = { surface: 19, water: 5, velocity: [0, 0, 0] as [number, number, number] };
const base: DebrisFrame = { frame: 0, commands: [], water: [], tanks: [], supports: [], substeps: 1 };
const vertices = new Float32Array(Array.from({ length: 8 }, (_, i) => [i & 1 ? .15 : -.15, i & 2 ? .15 : -.15, i & 4 ? .15 : -.15]).flat());

it('small and light fragments shed more water-relative speed while dense debris still sinks', () => {
  const body = (radius: number, density: number): DebrisBody => ({ position: [0, 18, 0], velocity: [8, -8, 0], radius, density, age: 0, bounces: 0, sleeping: false });
  const small = body(.15, 2.5), large = body(.6, 2.5), dense = body(.15, 7.5), light = body(.15, 1.2);
  for (let i = 0; i < 15; i++) for (const b of [small, large, dense, light]) {
    buoyDebris(b, water, 1 / 60, 1); b.velocity[1] -= 9.8 / 60;
  }
  expect(small.velocity[0]).toBeLessThan(large.velocity[0] * .5);
  expect(light.velocity[0]).toBeLessThan(small.velocity[0]);
  expect(small.velocity[0]).toBeLessThan(dense.velocity[0]);
  expect(small.velocity[1]).toBeLessThan(0);
  expect(Math.abs(small.velocity[1])).toBeLessThan(2);
});

it('keeps a falling fragment wet across radial travel and emits one entry ripple', () => {
  const run = (wet: boolean) => {
    const host = new DebrisHost(() => undefined);
    try {
      return host.apply({ ...base, substeps: 25, terrain: [{ version: 1, complete: true }],
        commands: [['add', { id: 1, positions: vertices, position: [0, 21, 0], velocity: [0, -12, 0], rotation: [0, 0, 0, 1],
          angularVelocity: [0, 0, 0], radius: .15, density: 2.5, generation: 1 }]],
        water: wet ? [[1, water, [0, 21, 0]]] : [] });
    } finally { host.dispose(); }
  };
  const wet = run(true), dry = run(false);
  expect(wet.state[2]).toBeLessThan(19); // More than 2 u from the probe, in the same column.
  expect(Math.abs(wet.state[5])).toBeLessThan(Math.abs(dry.state[5]) * .25);
  expect(wet.splashes).toHaveLength(5);
  expect(wet.splashes[1]).toBeCloseTo(19);
  expect(dry.splashes).toHaveLength(0);
});

it('makes a small exit ripple without manufacturing repeated underwater impacts', () => {
  const host = new DebrisHost(() => undefined);
  try {
    const deep = host.apply({ ...base, substeps: 10, terrain: [{ version: 1, complete: true }],
      commands: [['add', { id: 1, positions: vertices, position: [0, 18.7, 0], velocity: [0, 0, 0], rotation: [0, 0, 0, 1],
        angularVelocity: [0, 0, 0], radius: .15, density: 2.5, generation: 1 }]], water: [[1, water, [0, 18.7, 0]]] });
    expect(deep.splashes).toHaveLength(0);
    const exit = host.apply({ ...base, substeps: 12, commands: [['kick', 1, [0, 20, 0]]], water: [[1, water, [0, deep.state[2], 0]]] });
    expect(exit.splashes).toHaveLength(5);
    expect(exit.splashes[1]).toBeCloseTo(19);
  } finally { host.dispose(); }
});

it('rejects a water sample from another column or more than half a second ago', () => {
  const run = (sampleX: number, expired: boolean) => {
    const host = new DebrisHost(() => undefined);
    try {
      host.apply({ ...base, substeps: expired ? 31 : 0, terrain: [{ version: 1, complete: true }],
        commands: [['add', { id: 1, positions: vertices, position: [0, 18, 0], velocity: [0, 0, 0], rotation: [0, 0, 0, 1],
          angularVelocity: [0, 0, 0], radius: .15, density: 2.5, generation: 1 }]], water: [[1, water, [sampleX, 18, 0]]] });
      return host.apply({ ...base, commands: [['place', 1, [0, 18, 0], [4, 0, 0]]] }).state[4];
    } finally { host.dispose(); }
  };
  const wet = run(0, false), dry = run(2, false), expired = run(0, true);
  expect(wet).toBeLessThan(dry * .8);
  expect(expired).toBeCloseTo(dry, 6);
});
