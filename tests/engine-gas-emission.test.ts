import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { EngineServices, PassContext, PassDecl } from '../src/engine/contracts';
import { GasEmissionLights, type GasEmissionDomain } from '../src/engine/passes/fluids/gas-emission';
import { gasEmissionWgsl } from '../src/engine/passes/fluids/gas-emission.wgsl';
import { LightSystem } from '../src/engine/scene/lights';
import { link } from '../src/engine/wgsl/module';

const domain = (id: number, steam = 0): GasEmissionDomain => ({ id, slot: id, center: [0, 20, 0], right: [1, 0, 0], up: [0, 1, 0], fwd: [0, 0, 1], edge: 16, age: 1, fade: 1, steam, ready: true });
function fixture() {
  const writes: Float32Array[] = [], dispatch: number[] = [], retired: unknown[] = [], passes: PassDecl[] = [], groups: unknown[] = []; let removed = 0, ready = true;
  let domains: GasEmissionDomain[] = [];
  const device = { createBuffer: (x: unknown) => x, createBindGroupLayout: () => ({}), createBindGroup: (x: unknown) => { groups.push(x); return x; }, queue: { writeBuffer: (_b: unknown, _o: number, data: ArrayBuffer | Float32Array) => writes.push(new Float32Array(data instanceof ArrayBuffer ? data.slice(0) : data)) } };
  const lights = new LightSystem(device as never);
  const s = { ctx: { device, queue: device.queue, layouts: {}, deferDestroy: (x: unknown) => retired.push(x), pipelines: { register: () => {}, compile: () => Promise.resolve(), get: () => ready ? {} : undefined } },
    scene: { lights, get: (n: string) => n === 'lightSystem' ? lights : undefined }, telemetry: { gauge: () => {} }, graph: { addPass: (p: PassDecl) => { passes.push(p); return () => removed++; } },
  } as unknown as EngineServices;
  const emission = new GasEmissionLights(s, () => domains);
  const context = { timestampWrites: () => undefined, encoder: { beginComputePass: () => ({ setPipeline: () => {}, setBindGroup: () => {}, dispatchWorkgroups: (n: number) => dispatch.push(n), end: () => {} }) } } as unknown as PassContext;
  const textures = [{}, {}, {}, {}, {}] as [GPUTextureView, GPUTextureView, GPUTextureView, GPUSampler, GPUSampler];
  return { lights, emission, writes, dispatch, retired, groups, set: (v: GasEmissionDomain[]) => domains = v, ready: (v: boolean) => ready = v, removed: () => removed,
    prepare: () => passes[0].run(context), run: () => emission.run(context, ...textures, 48, 8, 7), pass: passes[0] };
}
describe('simulated gas emission light ownership', () => {
  it('resolves reordered pool slots before upload and keeps the global64 cap', () => {
    const f = fixture(); const other = f.lights.add({ type: 'point', position: [0, 0, 0], range: 1, color: [1, 1, 1], intensity: 1 });
    f.set([domain(1), domain(2)]); f.prepare(); f.run();
    expect(f.pass.slot).toBe('upload'); expect(f.pass.order).toBeLessThan(20);
    expect(f.writes.at(-1)![16]).toBe(1); expect(f.writes.at(-1)![40]).toBe(2);
    f.lights.remove(other); f.prepare(); f.run(); expect(f.writes.at(-1)![16]).toBe(0); expect(f.writes.at(-1)![40]).toBe(1);
    f.emission.clear(); for (let i = 0; i < 64; i++) f.lights.add({ type: 'point', position: [0, 0, 0], range: 1, color: [1, 1, 1], intensity: 1 });
    expect(() => f.prepare()).not.toThrow(); expect(f.lights.count).toBe(64); f.emission.dispose(); expect(f.lights.count).toBe(64);
  });
  it('retirement/eviction/reallocation removes the old slot, and steam reserves no light', () => {
    const f = fixture(); f.set([domain(1), domain(2, 1)]); f.prepare(); expect(f.lights.count).toBe(1);
    f.set([domain(3)]); f.prepare(); f.run(); expect(f.lights.count).toBe(1); expect(f.writes.at(-1)![17]).toBe(3);
    f.set([]); f.prepare(); expect(f.lights.count).toBe(0);
    f.set([domain(4)]); f.prepare(); f.emission.dispose(); expect(f.lights.count).toBe(0); expect(f.removed()).toBe(1); expect(f.retired).toHaveLength(1);
  });
  it('starts each frame dark, skips unavailable compute, and reuses unchanged resource bindings', () => {
    const f = fixture(); f.set([domain(1)]); f.prepare();
    const cpuLight = f.lights.shadowCasters()[0].light; expect(cpuLight.intensity).toBe(0);
    f.ready(false); f.run(); expect(f.dispatch).toEqual([]);
    f.ready(true); f.run(); f.run(); expect(f.dispatch).toEqual([1, 1]); expect(f.groups).toHaveLength(1);
    f.set([{ ...domain(1), ready: false }]); f.prepare(); f.run(); expect(f.writes.at(-1)![18]).toBe(0);
    f.emission.dispose();
  });
});
const naga = process.env.TMT_NAGA ?? join(homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'naga.exe' : 'naga');
describe.skipIf(!existsSync(naga))('actual gas emission shader', () => {
  it('validates the parallel reduction and writes the existing packed light layout', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'tmt-gas-emission-')), file = join(scratch, 'emission.wgsl');
    try { writeFileSync(file, link(gasEmissionWgsl).code); const run = spawnSync(naga, [file], { encoding: 'utf8', timeout: 30000 }); expect(run.status, run.stderr || run.stdout || String(run.error)).toBe(0); }
    finally { unlinkSync(file); rmdirSync(scratch); }
  });
});
