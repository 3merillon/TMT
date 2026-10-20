// W1-ENG-SCENE: the terrain FS assembly (0, 1 and N modifiers), the bake, SMC, overlay and debug-line shaders all pass naga;
// TS/WGSL mirrors (noise, planet kinds, layer table) agree. naga is optional (skipped with a message when absent).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { planetNormalWGSL, PLANET_TYPES, planetType } from '../src/game/planet-field';
import { terrainBakeMaterialsShader, terrainBakeNormalsShader } from '../src/engine/materials/terrain/bake';
import { TERRAIN_LAYERS } from '../src/engine/materials/terrain/layers';
import { TERRAIN_MODIFIERS } from '../src/engine/materials/terrain/modifiers';
import type { TerrainModifier } from '../src/engine/materials/terrain/modifier-types';
import { pendingCraterModifier } from '../src/engine/materials/terrain/modifiers/pending-crater.wgsl';
import { tracksModifier } from '../src/engine/materials/terrain/modifiers/tracks.wgsl';
import {
  PAGE_RECORD, PAGE_RECORD_BYTES, TERRAIN_VERTEX_BUFFERS, terrainDepthShader, terrainGBufferModule, terrainGBufferShader, terrainReservedNames,
} from '../src/engine/materials/terrain/surface.wgsl';
import { debugLinesShader } from '../src/engine/scene/debug-lines';
import { ribbonShaderLinked, ringsShaderLinked } from '../src/engine/scene/overlays';
import { smcShaderLinked } from '../src/engine/scene/surface-memory';
import { matNoise, mnHash3, tileNoise } from '../src/engine/wgsl/common/noise.wgsl';
import { planetFallbackNormalWgsl, planetKindIndex, planetNormalModule, PLANET_KINDS, sourceHash } from '../src/engine/wgsl/common/planet.wgsl';
import { cubeSphereWgsl } from '../src/engine/wgsl/common/cube-sphere.wgsl';
import { link, makeModule } from '../src/engine/wgsl/module';

function findNaga(): string | undefined {
  const exe = process.platform === 'win32' ? 'naga.exe' : 'naga';
  const candidates = [process.env.TMT_NAGA, ...(process.env.PATH ?? '').split(delimiter).map(dir => dir && join(dir, exe)), join(homedir(), '.cargo', 'bin', exe)];
  return candidates.find((p): p is string => !!p && existsSync(p));
}
const naga = findNaga();
if (!naga) console.warn('[engine-terrain-wgsl] naga not found: WGSL validation skipped (cargo install naga-cli).');
const scratch = mkdtempSync(join(tmpdir(), 'tmt-terrain-naga-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
function validate(name: string, code: string): string {
  const file = join(scratch, `${name.replace(/[^a-z0-9_.-]+/gi, '_')}.wgsl`);
  writeFileSync(file, code);
  const run = spawnSync(naga!, [file], { encoding: 'utf8', timeout: 60000 });
  return run.status === 0 ? '' : `${run.stdout ?? ''}${run.stderr ?? ''}${run.error ?? ''}`;
}

const extraModifier: TerrainModifier = {
  name: 'test_tint',
  wgsl: () => makeModule('tmod-test-tint', `fn tmod_test_tint(s: ptr<function, SurfaceSample>, t: TerrainCtx) { (*s).base_color = (*s).base_color * (0.9 + 0.1 * t.up.y); }`),
};

describe.skipIf(!naga)('naga: terrain and scene shaders', () => {
  const planet = planetNormalModule(planetNormalWGSL(7));
  const cases: [string, () => string][] = [
    ['terrain 0 modifiers (fallback planet)', () => terrainGBufferShader({ planet: planetFallbackNormalWgsl, modifiers: [] }).code],
    ['terrain 1 modifier (pending crater)', () => terrainGBufferShader({ planet, modifiers: [pendingCraterModifier] }).code],
    ['terrain 1 modifier (tracks)', () => terrainGBufferShader({ planet, modifiers: [tracksModifier] }).code],
    ['terrain N modifiers (registry + extra)', () => terrainGBufferShader({ planet, modifiers: [...TERRAIN_MODIFIERS, extraModifier] }).code],
    ['terrain registry, seed 4 (glacial)', () => terrainGBufferShader({ planet: planetNormalModule(planetNormalWGSL(4)), modifiers: TERRAIN_MODIFIERS }).code],
    ['terrain depth', () => terrainDepthShader().code],
    ['bake materials', () => terrainBakeMaterialsShader().code],
    ['bake normals', () => terrainBakeNormalsShader().code],
    ['smc', () => smcShaderLinked().code],
    ['overlay ribbon', () => ribbonShaderLinked().code],
    ['overlay rings', () => ringsShaderLinked().code],
    ['debug lines', () => debugLinesShader().code],
    ['cube-sphere module', () => link(cubeSphereWgsl).code],
  ];
  it.each(cases)('%s', (name, build) => {
    const errors = validate(name, build());
    expect(errors, errors).toBe('');
  }, 60000);
});

describe('terrain shader assembly', () => {
  it('calls modifiers in registry order and binds only the reserved bindings they read', () => {
    const code = terrainGBufferShader({ planet: planetFallbackNormalWgsl, modifiers: [...TERRAIN_MODIFIERS, extraModifier] }).code;
    const calls = [...code.matchAll(/tmod_(\w+)\(&s, t\);/g)].map(m => m[1]);
    expect(calls).toEqual([...TERRAIN_MODIFIERS.map(m => m.name), 'test_tint']);
    expect(code).not.toContain('tmodv_pending_crater');
    expect(terrainReservedNames(TERRAIN_MODIFIERS)).toEqual(['surfaceMemory', 'pendingCuts']);
    expect(code).toMatch(/@group\(2\) @binding\(0\) var rb_surfaceMemory_cube: texture_2d_array<f32>;/);
    expect(code).toMatch(/@group\(2\) @binding\(1\) var<uniform> rb_pendingCuts_cuts: PendingCuts;/);
    expect(terrainReservedNames([])).toEqual([]);
    expect(terrainGBufferShader({ planet: planetFallbackNormalWgsl, modifiers: [] }).code).not.toContain('@group(2)');
  });

  it('rejects malformed modifiers', () => {
    const bad = (m: Partial<TerrainModifier>) => () => terrainGBufferModule({ planet: planetFallbackNormalWgsl, modifiers: [{ name: 'x', wgsl: () => makeModule('m', ''), ...m } as TerrainModifier] });
    expect(bad({ name: 'Bad-Name' })).toThrow(/snake_case/);
    expect(bad({ name: 'nofn' })).toThrow(/must define fn tmod_nofn/);
    expect(bad({ name: 'v', vertex: true, wgsl: () => makeModule('mv', 'fn tmod_v(s: ptr<function, SurfaceSample>, t: TerrainCtx) {}') })).toThrow(/vertex hook/);
    expect(() => terrainGBufferModule({ planet: planetFallbackNormalWgsl, modifiers: [tracksModifier, tracksModifier] })).toThrow(/twice/);
  });

  it('page record layout and vertex buffers match the render-host PageBuffers', () => {
    expect(PAGE_RECORD_BYTES).toBe(176);
    expect(PAGE_RECORD.offsets).toMatchObject({ model: 0, prev_model: 64, origin: 128, sphere: 144, ids: 160 });
    expect(TERRAIN_VERTEX_BUFFERS.map(b => b.arrayStride)).toEqual([12, 12, 32]);
    const surface = TERRAIN_VERTEX_BUFFERS[2].attributes as GPUVertexAttribute[];
    expect(surface.map(a => [a.offset, a.format])).toEqual([[0, 'float32'], [4, 'float32x4']]);
  });

  it('the planet facet module requires tmt_planet_normal and hashes stably', () => {
    expect(() => planetNormalModule('fn nope() {}')).toThrow(/tmt_planet_normal/);
    expect(sourceHash(planetNormalWGSL(7))).toBe(sourceHash(planetNormalWGSL(7)));
    expect(sourceHash(planetNormalWGSL(7))).not.toBe(sourceHash(planetNormalWGSL(8)));
  });
});

describe('TS ↔ WGSL single sources', () => {
  it('engine planet kinds equal the game planet types (planetType(seed) indexes both)', () => {
    expect([...PLANET_KINDS]).toEqual([...PLANET_TYPES]);
    for (let seed = 0; seed < 8; seed++) expect(planetKindIndex(planetType(seed))).toBe(seed & 3);
  });

  it('the layer table reproduces the legacy bake constants', () => {
    // PROCEDURAL_TERRAIN_TILE_WIDTHS / _HEIGHT_AMPLITUDES of the three material (src/lab/legacy/procedural-material.ts).
    expect(TERRAIN_LAYERS.map(l => l.width)).toEqual([2.5, 2.0, 2.5, 3.0, 3.0, 2.5]);
    expect(TERRAIN_LAYERS.map(l => l.amplitude)).toEqual([0.042, 0.032, 0.012, 0.025, 0.018, 0.048]);
  });

  it('material noise mirror: bounded, unbiased, deterministic, not periodic on the axes', () => {
    let sum = 0, lo = 1, hi = 0;
    for (let i = 0; i < 4000; i++) {
      const v = matNoise([i * 0.731, i * 0.377 - 3, 11 - i * 0.119], 0.9, 1234);
      sum += v; lo = Math.min(lo, v); hi = Math.max(hi, v);
    }
    expect(lo).toBeGreaterThanOrEqual(0); expect(hi).toBeLessThanOrEqual(1);
    expect(Math.abs(sum / 4000 - 0.5)).toBeLessThan(0.04);
    expect(mnHash3(3, -7, 11, 5)).toBe(mnHash3(3, -7, 11, 5));
    expect(mnHash3(3, -7, 11, 5)).not.toBe(mnHash3(3, -7, 11, 6));
  });

  it('tile noise wraps with period 1 (the baked tiles are seamless)', () => {
    for (const period of [4, 9, 16]) for (let k = 0; k < 20; k++) {
      const u = (k * 0.137) % 1, v = (k * 0.291) % 1;
      expect(tileNoise(u + 1, v, period, 77)).toBeCloseTo(tileNoise(u, v, period, 77), 6);
      expect(tileNoise(u, v - 1, period, 77)).toBeCloseTo(tileNoise(u, v, period, 77), 6);
    }
  });
});
