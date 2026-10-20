import { describe, expect, it } from 'vitest';
import { createInterior, interiorSegmentBlocked, INTERIOR_MAX_OCCLUDERS, packInteriorOccluders, type InteriorOccluder } from '../src/engine/scene/interior';
import { PART_MATERIALS } from '../src/engine/materials/part-basic.wgsl';
import { LIGHTING_PARAMS, lightingShaderWgsl } from '../src/engine/passes/lighting/lighting.wgsl';
import { interiorLightingWgsl } from '../src/engine/passes/lighting/interior.wgsl';
import type { Vec3 } from '../src/engine/contracts';

describe('interior light occlusion', () => {
  const wall: InteriorOccluder = { min: [6.9, -0.5, -9], max: [7.5, 9, 9] };
  const ceiling: InteriorOccluder = { min: [-7, 8.2, -9], max: [7, 8.8, 9] };
  const floor: InteriorOccluder = { min: [-7, -0.5, -9], max: [7, 0, 9] };
  it.each([
    [[0, 2, 0], [9, 3, 0], wall, true],
    [[0, 2, 0], [2, 4, 0], wall, false],
    [[0, 2, 0], [0, 10, 0], ceiling, true],
    [[0, 0.018, 0], [0, 4, 0], floor, false],
    [[0, 2, 0], [0, -1, 0], floor, true],
    [[6.9, 2, -10], [6.9, 2, 10], wall, true],
    [[6.89, 2, -10], [6.89, 2, 10], wall, false],
    [[0, 2, 0], [6, 2, 0], wall, false],
  ] as [Vec3, Vec3, InteriorOccluder, boolean][])('blocks only solid segments %j → %j', (from, to, box, blocked) => {
    expect(interiorSegmentBlocked(from, to, box)).toBe(blocked);
    expect(interiorSegmentBlocked(to, from, box)).toBe(blocked);
  });

  it('packs closed solids and clears retired occluders without stale GPU entries', () => {
    const out = packInteriorOccluders([wall, ceiling]);
    expect([...out.slice(0, 8)]).toEqual([expect.closeTo(6.9), -0.5, -9, 0, 7.5, 9, 9, 0]);
    expect(out.length).toBe(INTERIOR_MAX_OCCLUDERS * 8);
    packInteriorOccluders([], out);
    expect([...out].every(v => v === 0)).toBe(true);
  });

  it('rejects reversed/nonfinite bounds and overflow rather than silently dropping walls', () => {
    expect(() => packInteriorOccluders([{ min: [1, 0, 0], max: [0, 1, 1] }])).toThrow(/bounds/);
    expect(() => packInteriorOccluders([{ min: [0, 0, 0], max: [1, Infinity, 1] }])).toThrow(/bounds/);
    expect(() => packInteriorOccluders(Array.from({ length: INTERIOR_MAX_OCCLUDERS + 1 }, () => wall))).toThrow(/at most/);
  });

  it('branches before planetary light evaluation and has no sky/atmosphere dependency in room shading', () => {
    const main = lightingShaderWgsl.code;
    expect(main.indexOf('interior_shade(s, p, v, px, dist)')).toBeLessThan(main.indexOf('let sun_rgb = frame.sun_radiance'));
    expect(interiorLightingWgsl.code).not.toMatch(/radial_up|atmo_integrate|sky_irradiance|gi_sample|sun_radiance/);
    expect(LIGHTING_PARAMS.size).toBeLessThan(16384);
    expect(createInterior().occluders).toEqual([]);
  });
});

describe('baked workshop materials', () => {
  it('appends stone, iron, brass and copper while reserving the original kit IDs', () => {
    expect(PART_MATERIALS.slice(9, 13).map(m => [m.baseColor, m.roughness, m.metalness])).toEqual([
      [null, 0.9, 0], [null, 0.48, 0.65], [null, 0.4, 0.9], [null, 0.45, 0.85],
    ]);
    expect(PART_MATERIALS[0].name).toBe('paint');
    expect(PART_MATERIALS[8].name).toBe('rubble');
  });
});
