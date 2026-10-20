import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { LightInit, Vec3 } from '../src/engine/contracts';
import { cloudLocalConeMaximum, cloudLocalLightingWgsl, cloudLocalRayScore } from '../src/engine/passes/clouds/local-lighting.wgsl';
import { sdfBindingsWgsl } from '../src/engine/passes/sdf/sdf.wgsl';
import { link, makeModule } from '../src/engine/wgsl/module';
import { cloudFieldBindingWgsl } from '../src/engine/passes/clouds/field';
import { cloudShaders } from '../src/engine/passes/clouds/clouds';

const spot: LightInit = { type: 'spot', position: [0, 0, 0], direction: [0, 0, 1], range: 7, color: [1, .8, .6], intensity: 7.5, innerAngle: .22, outerAngle: .48 };
describe('cloud local light admission', () => {
  it('retains a beam crossed later in a cloud chord even when the nearest point is outside its cone', () => {
    expect(cloudLocalRayScore(spot, [1, 0, 0], [0, 0, 1], [[0, 6]])).toBeGreaterThan(0);
    expect(cloudLocalRayScore(spot, [1, 0, 0], [0, 0, -1], [[0, 6]])).toBe(0);
    expect(cloudLocalRayScore(spot, [1, 0, 0], [0, 0, 1], [[0, .5]])).toBe(0);
  });
  it('never treats the empty inner-shell gap or a depth-clipped far band as scattering material', () => {
    const point: LightInit = { ...spot, type: 'point', position: [0, 0, 10], range: 2 };
    expect(cloudLocalRayScore(point, [0, 0, 0], [0, 0, 1], [[1, 3], [17, 20]])).toBe(0);
    expect(cloudLocalRayScore(point, [0, 0, 0], [0, 0, 1], [[1, 3], [9, 11]])).toBeGreaterThan(0);
    expect(cloudLocalRayScore(point, [0, 0, 0], [0, 0, 1], [[1, 3], [9, 8]])).toBe(0);
  });
  it('uses actual explosion radiance/range and suppresses expired or unseen sources', () => {
    const flash: LightInit = { type: 'point', position: [0, 0, 0], range: 10.5, color: [1, .45, .08], intensity: 480 };
    const score = cloudLocalRayScore(flash, [0, 0, 0], [0, 0, 1], [[3, 5]]);
    expect(score).toBeGreaterThan(0);
    expect(cloudLocalRayScore({ ...flash, intensity: 240 }, [0, 0, 0], [0, 0, 1], [[3, 5]])).toBeCloseTo(score * .5, 10);
    expect(cloudLocalRayScore({ ...flash, intensity: 0 }, [0, 0, 0], [0, 0, 1], [[3, 5]])).toBe(0);
    expect(cloudLocalRayScore(flash, [0, 0, 0], [0, 0, 1], [[3, 5]], .94)).toBe(0);
    expect(cloudLocalRayScore(flash, [0, 0, 0], [0, 0, 1], [[11, 14]])).toBe(0);
  });
  it('analytic cone extrema bound dense ray sampling, including off-axis interior extrema', () => {
    const unit = (p: Vec3) => p.map(x => x / Math.hypot(...p)) as Vec3;
    for (let k = 1; k <= 40; k++) {
      const origin: [number, number, number] = [Math.sin(k) * 3, Math.cos(k * .7) * 2, Math.sin(k * .2)];
      const direction = unit([Math.cos(k * .4), Math.sin(k * .8), .7]), axis = unit([.2, Math.sin(k), Math.cos(k)]);
      const value = cloudLocalConeMaximum(origin, direction, axis, .1, 8);
      let dense = -1;
      for (let i = 0; i <= 1000; i++) {
        const p = origin.map((x, j) => x + direction[j] * (.1 + 7.9 * i / 1000));
        dense = Math.max(dense, p.reduce((s, x, j) => s + x * axis[j], 0) / Math.hypot(...p));
      }
      expect(value + 1e-10).toBeGreaterThanOrEqual(dense); expect(value - dense).toBeLessThan(.001);
    }
  });
});

const naga = process.env.TMT_NAGA ?? join(homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'naga.exe' : 'naga');
describe.skipIf(!existsSync(naga))('cloud local light shader', () => {
  it.each(Object.entries(cloudShaders()))('validates the integrated %s shader', (name, shader) => {
    const scratch = mkdtempSync(join(tmpdir(), 'tmt-cloud-integrated-')), file = join(scratch, `${name}.wgsl`);
    try { writeFileSync(file, shader.code); const run = spawnSync(naga, [file], { encoding: 'utf8', timeout: 30000 }); expect(run.status, run.stderr || run.stdout || String(run.error)).toBe(0); }
    finally { unlinkSync(file); rmdirSync(scratch); }
  });
  it('validates all light selection, world/caster visibility, FOW and self-extinction branches', () => {
    const code = link(makeModule('cloud-local-test', `@compute @workgroup_size(1) fn main(){
      let selection=cloud_local_select(vec3f(0.0),vec3f(0.0,0.0,1.0),array<vec2f,2>(vec2f(1.0,6.0),vec2f(0.0)));
    }`, [sdfBindingsWgsl(1, { volume: 10, params: 11, sampler: 12 }), cloudLocalLightingWgsl, cloudFieldBindingWgsl(1, 18)])).code;
    const scratch = mkdtempSync(join(tmpdir(), 'tmt-cloud-local-')), file = join(scratch, 'local.wgsl');
    try { writeFileSync(file, code); const run = spawnSync(naga, [file], { encoding: 'utf8', timeout: 30000 }); expect(run.status, run.stderr || run.stdout || String(run.error)).toBe(0); }
    finally { unlinkSync(file); rmdirSync(scratch); }
  });
});
