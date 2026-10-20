/**
 * Lighting v0: AO never multiplies direct light (CPU mirror of the term split + a structural check of the WGSL), the
 * Pinionfall shaped-ambient factors, and the flat light list packing / attenuation.
 */
import { describe, expect, it } from 'vitest';
import { composeLighting, shapedAmbientLevel } from '../src/engine/passes/lighting/lighting-mirror';
import { lightingComposeWgsl, lightingShaderWgsl, SHAPED_AMBIENT } from '../src/engine/passes/lighting/lighting.wgsl';
import { lightAttenuation, LightSystem, LIGHT_FLAG_CAST_SHADOW, LIGHT_FLOATS, LIGHT_LIST_BYTES, LIGHT_LIST_HEADER_BYTES, MAX_LIGHTS, packConeCosines, packLight, unpackConeCosines } from '../src/engine/scene/lights';

let seed = 99;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const v3 = (s = 1): [number, number, number] => [rnd() * s, rnd() * s, rnd() * s];

describe('AO never multiplies direct light', () => {
  it('leaves a direct-only image unchanged when AO goes from 1 to 0', () => {
    const image = Array.from({ length: 4096 }, () => ({ direct: v3(20), emissive: v3(2), ambientDiffuse: [0, 0, 0] as [number, number, number], ambientSpecular: [0, 0, 0] as [number, number, number] }));
    const lit = image.map(p => composeLighting({ ...p, ao: 1 }));
    const occluded = image.map(p => composeLighting({ ...p, ao: 0 }));
    expect(occluded).toEqual(lit);
  });

  it('scales only the ambient terms by AO', () => {
    const p = { direct: [3, 2, 1] as [number, number, number], emissive: [0.5, 0, 0] as [number, number, number], ambientDiffuse: [1, 1, 1] as [number, number, number], ambientSpecular: [0.2, 0.2, 0.2] as [number, number, number] };
    expect(composeLighting({ ...p, ao: 1 })).toEqual([4.7, 3.2, 2.2]);
    expect(composeLighting({ ...p, ao: 0 })).toEqual([3.5, 2, 1]);
    expect(composeLighting({ ...p, ao: 0.5, specularOcclusion: 1 })).toEqual([4.2, 2.7, 1.7]);
  });

  it('keeps the WGSL term split identical to the mirror and never applies AO to direct light', () => {
    expect(lightingComposeWgsl.code).toContain('return direct + emissive + ambient_diffuse * ao + ambient_specular * specular_occlusion;');
    const code = lightingShaderWgsl.code;
    expect(code).not.toMatch(/direct\s*\*=?\s*[^;]*\bao\b/);
    expect(code).not.toMatch(/\bao\s*\*\s*direct/);
    expect(code.match(/compose_lighting\(/g)).toHaveLength(1);
    expect(code).toContain('textureStore(hdr_out, px, vec4f(color, 1.0));');
  });
});

describe('shaped hemisphere ambient (Pinionfall factors)', () => {
  const up: [number, number, number] = [0, 1, 0];
  const noon: [number, number, number] = [0, 1, 0];
  const midnight: [number, number, number] = [0, -1, 0];
  it('reads brightest facing up, hemi_ground facing down, and dims on the night side', () => {
    const top = shapedAmbientLevel(up, up, noon);
    const bottom = shapedAmbientLevel([0, -1, 0], up, noon);
    const wall = shapedAmbientLevel([1, 0, 0], up, noon);
    expect(top.level).toBeCloseTo(1, 12);
    expect(bottom.level).toBeCloseTo(SHAPED_AMBIENT.hemiGround, 12);
    expect(wall.level).toBeCloseTo((SHAPED_AMBIENT.hemiGround + 1) / 2, 12);
    expect(top.day).toBe(1);
    const night = shapedAmbientLevel(up, up, midnight);
    expect(night.day).toBe(0);
    expect(night.level).toBeCloseTo(SHAPED_AMBIENT.nightAmbScale, 12);
    expect(night.fill).toBeGreaterThan(0);
    expect(top.fill).toBe(0);
  });

  it('keeps ambient where a cast shadow falls only on would-be-lit faces, by amb_shadow_keep', () => {
    const lit = shapedAmbientLevel(up, up, noon, 1);
    const shadowed = shapedAmbientLevel(up, up, noon, 0);
    expect(shadowed.level / lit.level).toBeCloseTo(SHAPED_AMBIENT.ambShadowKeep, 12);
    const facingAway = shapedAmbientLevel([0, -1, 0], up, noon, 0);
    expect(facingAway.level).toBeCloseTo(SHAPED_AMBIENT.hemiGround, 12); // never crushed by a shadow it could not receive
  });
});

describe('flat light list', () => {
  it('packs cone cosines as two unorm16 over [-1, 1]', () => {
    for (const [a, b] of [[1, -1], [0.97, 0.9], [0, 0], [-0.5, -0.75]]) {
      const [ia, ob] = unpackConeCosines(packConeCosines(a, b));
      expect(Math.abs(ia - a)).toBeLessThan(2e-5);
      expect(Math.abs(ob - b)).toBeLessThan(2e-5);
    }
  });

  it('packs one light into 64 B and the list header', () => {
    const f = new Float32Array(16), u = new Uint32Array(f.buffer);
    packLight({ type: 'spot', position: [1, 2, 3], color: [1, 0.5, 0.25], intensity: 4, range: 6, direction: [0, 0, -2], innerAngle: 0.2, outerAngle: 0.4 }, f, u, 0);
    expect(Array.from(f.subarray(0, 8))).toEqual([1, 2, 3, 6, 4, 2, 1, 0]);
    expect(Array.from(f.subarray(8, 11))).toEqual([0, 0, -1]);
    expect([u[12], u[13]]).toEqual([1, 1]);
    const [ci, co] = unpackConeCosines(u[14]);
    expect(ci).toBeCloseTo(Math.cos(0.2), 4);
    expect(co).toBeCloseTo(Math.cos(0.4), 4);
    expect(u[15]).toBe(0);
    expect(LIGHT_LIST_BYTES).toBe(LIGHT_LIST_HEADER_BYTES + MAX_LIGHTS * LIGHT_FLOATS * 4);
  });

  it('packs independent shadow casting without changing light order', () => {
    const f = new Float32Array(16), u = new Uint32Array(f.buffer);
    packLight({ type: 'point', position: [2, 3, 4], color: [1, 1, 1], intensity: 8, range: 12, castShadow: true, sourceCasterId: 1234 }, f, u, 0);
    expect(u[15]).toBe(1234);
    expect(u[13] & LIGHT_FLAG_CAST_SHADOW).toBe(LIGHT_FLAG_CAST_SHADOW);
    const device = { createBuffer: (d: GPUBufferDescriptor) => ({ size: d.size }), queue: { writeBuffer: () => undefined } };
    const sys = new LightSystem(device as never);
    const first = sys.add({ type: 'point', position: [0, 0, 0], color: [1, 1, 1], intensity: 1, range: 2 });
    const second = sys.add({ type: 'point', position: [1, 0, 0], color: [1, 1, 1], intensity: 1, range: 2, castShadow: true });
    expect(sys.shadowCasters().map(({ index }) => index)).toEqual([1]);
    sys.update(first, { castShadow: true });
    expect(sys.shadowCasters().map(({ index }) => index)).toEqual([0, 1]);
    sys.update(second, { castShadow: false });
    expect(sys.shadowCasters().map(({ index }) => index)).toEqual([0]);
  });

  it('attenuates with the Frostbite window: inverse-square inside, exactly 0 at range', () => {
    expect(lightAttenuation(1, 100)).toBeCloseTo(1, 6);
    expect(lightAttenuation(4, 100)).toBeCloseTo(0.25, 4);
    expect(lightAttenuation(36, 6)).toBe(0);
    expect(lightAttenuation(30, 6)).toBeGreaterThan(0);
  });

  it('holds at most 64 lights and uploads only when dirty', () => {
    const writes: number[] = [];
    const device = { createBuffer: (d: GPUBufferDescriptor) => ({ size: d.size }), queue: { writeBuffer: (_b: unknown, _o: number, _d: unknown, _do: number, size: number) => { writes.push(size); } } };
    const sys = new LightSystem(device as never);
    const handles = Array.from({ length: MAX_LIGHTS }, (_, i) => sys.add({ type: 'point', position: [i, 0, 0], color: [1, 1, 1], intensity: 1, range: 2 }));
    expect(() => sys.add({ type: 'point', position: [0, 0, 0], color: [1, 1, 1], intensity: 1, range: 1 })).toThrow(/full/);
    sys.upload(); sys.upload();
    expect(writes).toEqual([LIGHT_LIST_HEADER_BYTES + MAX_LIGHTS * 64]);
    sys.remove(handles[0]);
    sys.update(handles[1], { intensity: 3 });
    const packed = new Uint32Array(sys.pack());
    expect(packed[0]).toBe(MAX_LIGHTS - 1);
    expect(() => sys.update({ id: 9999 }, {})).toThrow();
  });
});
