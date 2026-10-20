/**
 * WGSL module system and single sources: link order, dedupe, conflicts, line map, TS → WGSL constants, struct layout
 * (FrameUniforms = 512 B), the G-buffer pack/unpack CPU mirror and octahedral round trips.
 */
import { describe, expect, it } from 'vitest';
import { GBUFFER_FLAG, MATERIAL_CLASS } from '../src/engine/contracts';
import { COMMON_WGSL } from '../src/engine/wgsl/common';
import { FRAME_UNIFORMS, FRAME_UNIFORMS_SIZE, frameWgsl } from '../src/engine/wgsl/common/frame.wgsl';
import { decodeIds, emissiveDecode, emissiveEncode, encodeIds, gbufferPackTs, gbufferUnpackTs, gbufferWgsl, half } from '../src/engine/wgsl/common/gbuffer.wgsl';
import { octDecode, octEncode, octEncodeSnorm16x2 } from '../src/engine/wgsl/common/packing.wgsl';
import { materialClassWgsl } from '../src/engine/wgsl/common/constants.wgsl';
import { SHADOW_VIEW_UNIFORMS } from '../src/engine/wgsl/common/shadow-view.wgsl';
import { WgslRegistry } from '../src/engine/wgsl/library';
import { formatConst, link, linkOrder, makeModule, tsConst, tsConstCode, wgsl, wgslStruct } from '../src/engine/wgsl/module';
import { nagaModules } from '../src/engine/wgsl/naga-exports';
import { PENDING_CUTS } from '../src/engine/frame/pending-cuts';
import { LIGHTING_PARAMS } from '../src/engine/passes/lighting/lighting.wgsl';

let seed = 12345;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const randomUnit = (): [number, number, number] => {
  const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - z * z);
  return [r * Math.cos(a), r * Math.sin(a), z];
};
const angle = (a: readonly number[], b: readonly number[]) => Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));

describe('wgsl modules and link()', () => {
  const a = wgsl('a') `const A: u32 = 1u;`;
  const b = wgsl('b', [a]) `const B: u32 = A + 1u;`;
  const c = wgsl('c') `${a}const C: u32 = A + 2u;`; // interpolated module = dependency
  const d = wgsl('d', [b, c]) `fn d() -> u32 { return B + C; }`;

  it('emits dependencies before dependents, each module once', () => {
    expect(linkOrder([d]).map(m => m.name)).toEqual(['a', 'b', 'c', 'd']);
    const linked = link(d, a, c);
    expect(linked.modules).toEqual(['a', 'b', 'c', 'd']);
    expect(linked.code.match(/const A: u32/g)).toHaveLength(1);
    expect(c.deps).toContain(a);
    expect(c.code.startsWith('const C')).toBe(true);
  });

  it('throws on two different modules with the same name and on cycles', () => {
    const a2 = makeModule('a', 'const A: u32 = 2u;');
    expect(() => link(b, a2)).toThrow(/two different modules named "a"/);
    const x: { name: string; deps: unknown[]; code: string } = { name: 'x', deps: [], code: '' };
    const y = { name: 'y', deps: [x], code: '' };
    x.deps.push(y);
    expect(() => link(x as never)).toThrow(/cycle/);
  });

  it('maps output lines back to module-local lines', () => {
    const linked = link(d);
    const lines = linked.code.split('\n');
    const at = lines.findIndex(l => l.startsWith('fn d()')) + 1;
    expect(linked.mapLine(at)).toEqual({ module: 'd', line: 1 });
    const bLine = lines.findIndex(l => l.startsWith('const B')) + 1;
    expect(linked.mapLine(bLine)).toEqual({ module: 'b', line: 1 });
  });

  it('resolves registered names through the library and rejects conflicting re-registration', () => {
    const lib = new WgslRegistry(COMMON_WGSL);
    expect(lib.get('depth')).toBeDefined();
    expect(lib.link('depth').modules).toEqual(['struct:FrameUniforms', 'frame', 'depth']);
    expect(() => lib.register(makeModule('depth', 'fn other() {}'))).toThrow(/different code/);
    expect(() => lib.link('nope')).toThrow(/unknown module/);
  });
});

describe('TS → WGSL constants', () => {
  it('injects typed constants with exact literals', () => {
    expect(tsConstCode({ SKY: 15, NEG: -3, NEAR: 0.08, HALF: { value: 1, type: 'f32' }, ON: true })).toBe(
      'const SKY: u32 = 15u;\nconst NEG: i32 = -3i;\nconst NEAR: f32 = 0.08;\nconst HALF: f32 = 1.0;\nconst ON: bool = true;');
    expect(formatConst(1e-7, 'f32')).toBe('1e-7');
    expect(() => formatConst(-1, 'u32')).toThrow();
    expect(() => tsConstCode({ 'bad-name': 1 })).toThrow();
    expect(tsConst({ X: 1 }).name).toBe('const:X');
  });

  it('generates the material classes and GB3 flags from the TS contract (N3 mirror)', () => {
    for (const [k, v] of Object.entries(MATERIAL_CLASS)) expect(materialClassWgsl.code).toContain(`const CLASS_${k}: u32 = ${v}u;`);
    const flags = link(gbufferWgsl).code;
    for (const [k, v] of Object.entries(GBUFFER_FLAG)) expect(flags).toContain(`const GB_FLAG_${k}: u32 = ${v}u;`);
  });
});

describe('struct layout', () => {
  it('FrameUniforms is exactly 512 B with the planned field order', () => {
    expect(FRAME_UNIFORMS_SIZE).toBe(512);
    expect(FRAME_UNIFORMS.size).toBe(512);
    const o = FRAME_UNIFORMS.offsets;
    expect([o.view, o.proj, o.view_proj, o.inv_view_proj, o.prev_view_proj, o.view_proj_nojitter]).toEqual([0, 64, 128, 192, 256, 320]);
    expect([o.eye_pos, o.time, o.sun_dir, o.dt, o.sun_radiance, o.exposure]).toEqual([384, 396, 400, 412, 416, 428]);
    expect([o.jitter, o.prev_jitter, o.viewport, o.planet, o.focus, o.misc]).toEqual([432, 440, 448, 464, 480, 496]);
    expect(frameWgsl.code).toContain('@group(0) @binding(0) var<uniform> frame: FrameUniforms;');
  });

  it('packs values at their offsets (vec3 + scalar share a 16 B slot)', () => {
    const buf = FRAME_UNIFORMS.pack({ eye_pos: [1, 2, 3], time: 4, misc: [7, 1, 2, 18.5], proj: Array.from({ length: 16 }, (_, i) => i) });
    const f = new Float32Array(buf);
    expect(Array.from(f.subarray(96, 100))).toEqual([1, 2, 3, 4]);
    expect(Array.from(f.subarray(124, 128))).toEqual([7, 1, 2, 18.5]);
    expect(f[16 + 14]).toBe(14); // proj[3][2]
  });

  it('applies WGSL uniform rules: mat3x3f column padding and 16 B array strides', () => {
    const s = wgslStruct('T', [['a', 'f32'], ['m', 'mat3x3f'], ['v', 'vec2f'], ['arr', { array: 'f32', count: 3 }], ['u', 'u32']]);
    expect(s.offsets).toEqual({ a: 0, m: 16, v: 64, arr: 80, u: 128 });
    expect(s.size).toBe(144);
    const packed = new Float32Array(s.pack({ m: [1, 2, 3, 4, 5, 6, 7, 8, 9], arr: [10, 11, 12] }));
    expect(Array.from(packed.subarray(4, 16))).toEqual([1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0]);
    expect([packed[20], packed[24], packed[28]]).toEqual([10, 11, 12]);
    const storage = wgslStruct('S', [['arr', { array: 'f32', count: 3 }]], { uniform: false });
    expect(storage.size).toBe(12);
  });

  it('keeps the other engine uniform blocks at their declared sizes', () => {
    expect(SHADOW_VIEW_UNIFORMS.size).toBe(96);
    expect(PENDING_CUTS.size).toBe(208); // + 8 material masks (rust-engine-v22 material craters)
    expect(LIGHTING_PARAMS.size % 16).toBe(0);
  });
});

describe('octahedral packing and the G-buffer mirror', () => {
  it('oct round-trips unit vectors to < 1e-3 rad, also through rgba16float', () => {
    let worst = 0, worstHalf = 0;
    for (let i = 0; i < 5000; i++) {
      const n = randomUnit();
      const e = octEncode(n);
      worst = Math.max(worst, angle(n, octDecode(e)));
      worstHalf = Math.max(worstHalf, angle(n, octDecode([half(e[0]), half(e[1])])));
    }
    for (const n of [[0, 0, 1], [0, 0, -1], [1, 0, 0], [0, -1, 0]] as [number, number, number][]) worst = Math.max(worst, angle(n, octDecode(octEncode(n))));
    expect(worst).toBeLessThan(1e-3);
    expect(worstHalf).toBeLessThan(1e-3);
    const p = octEncodeSnorm16x2([0, 0, -1]);
    expect(p >>> 0).toBe(p);
  });

  it('packs GB3 as class 4 | flags 6 | objectId 10 | aniso 12 bits', () => {
    const ids = encodeIds(MATERIAL_CLASS.METAL, GBUFFER_FLAG.HERO | GBUFFER_FLAG.TWO_SIDED, 1023, 1, Math.PI / 2);
    expect(ids & 0xf).toBe(1);
    expect((ids >>> 4) & 0x3f).toBe(34);
    expect((ids >>> 10) & 0x3ff).toBe(1023);
    expect((ids >>> 20) & 0xf).toBe(15);
    expect((ids >>> 24) & 0xff).toBe(128);
    const d = decodeIds(ids);
    expect(d).toMatchObject({ classId: 1, flags: 34, objectId: 1023, anisoStrength: 1 });
    expect(Math.abs(d.anisoAngle - Math.PI / 2)).toBeLessThan(Math.PI / 256);
    expect(encodeIds(MATERIAL_CLASS.SKY, 0, 0)).toBe(15);
    expect(encodeIds(0, 0, 1024)).toBe(0); // objectId wraps to 10 bits
  });

  it('round-trips a SurfaceSample through the mirror of gbuffer_pack / gbuffer_unpack', () => {
    for (let i = 0; i < 500; i++) {
      const s = {
        baseColor: [rnd(), rnd(), rnd()] as [number, number, number], ao: rnd(),
        nShading: randomUnit(), nGeom: randomUnit(),
        roughness: rnd(), metalness: rnd() < 0.5 ? 0 : 1, emissive: rnd() < 0.3 ? 2 ** (rnd() * 14 - 3) : 0, param: rnd(),
        anisoStrength: Math.round(rnd() * 15) / 15, anisoAngle: rnd() * Math.PI,
        classId: Math.floor(rnd() * 9), flags: Math.floor(rnd() * 64), objectId: Math.floor(rnd() * 1024),
      };
      const u = gbufferUnpackTs(gbufferPackTs(s));
      for (let k = 0; k < 3; k++) expect(Math.abs(u.baseColor[k] - s.baseColor[k])).toBeLessThanOrEqual(0.5 / 255 + 1e-9);
      expect(Math.abs(u.roughness - s.roughness)).toBeLessThanOrEqual(0.5 / 255 + 1e-9);
      expect(angle(u.nShading, s.nShading)).toBeLessThan(1e-3);
      expect(angle(u.nGeom, s.nGeom)).toBeLessThan(1e-3);
      expect(u.metalness).toBe(s.metalness);
      expect([u.classId, u.flags, u.objectId]).toEqual([s.classId, s.flags, s.objectId]);
      if (s.emissive === 0) expect(u.emissive).toBe(0);
      else expect(Math.abs(Math.log2(u.emissive) - Math.log2(s.emissive))).toBeLessThan(16 / 255);
    }
    expect(emissiveDecode(emissiveEncode(0))).toBe(0);
  });
});

describe('naga exports', () => {
  it('lists every common module and full engine shader under unique names', () => {
    const mods = nagaModules();
    const names = mods.map(m => m.name);
    expect(new Set(names).size).toBe(names.length);
    for (const m of COMMON_WGSL) expect(names).toContain(`module:${m.name}`);
    for (const s of ['part-mesh-gbuffer', 'part-mesh-depth', 'lighting-v0', 'composite-v0', 'present', 'gbuffer-views', 'image-stats']) expect(names).toContain(`shader:${s}`);
    for (const m of mods) expect(m.code.length).toBeGreaterThan(20);
    expect(mods.every(m => !m.code.includes('\r'))).toBe(true);
  });
});
