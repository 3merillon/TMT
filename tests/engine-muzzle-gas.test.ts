import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { PassContext, QualityTier } from '../src/engine/contracts';
import { GAS_TIERS, PlanetGas, type GasHost, type GasCloudFlowFacet } from '../src/engine/passes/fluids/gas';
import { MUZZLE_GAS_TIERS, muzzleGasAtlasBytes, type MuzzleEmission } from '../src/engine/passes/fluids/muzzle';
import { gasAdvectWgsl, gasRaymarchWgsl } from '../src/engine/passes/fluids/gas.wgsl';
import { link } from '../src/engine/wgsl/module';
import { LightSystem } from '../src/engine/scene/lights';
import { gasFlowAdvectWgsl, gasFlowClearWgsl, gasFlowBindingsWgsl } from '../src/engine/passes/fluids/gas-flow.wgsl';
import { makeModule } from '../src/engine/wgsl/module';

const shot: MuzzleEmission = { position: [3, 20, 4], direction: [0, 0, 1], up: [0, 1, 0], munition: 'nuclear', weapon: 'cannon', seed: 71 };

function harness() {
  let ready = true;
  const allocations: { label: string; size: unknown }[] = [], dispatches: number[][] = [];
  const writes = new Map<string, Float32Array>();
  const deferred: unknown[] = [];
  const queue = { writeTexture: () => {}, writeBuffer: (buffer: { label: string }, _offset: number, data: ArrayBuffer | ArrayBufferView) => {
    const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    writes.set(buffer.label, new Float32Array(bytes.slice().buffer));
  } };
  const host = {
    s: { ctx: { device: {
      queue, createBindGroupLayout: () => ({}), createSampler: () => ({}), createBindGroup: () => ({}),
      createBuffer: (d: { label: string; size: number }) => { allocations.push(d); return d; },
      createTexture: (d: { label: string; size: unknown }) => { allocations.push(d); return { ...d, createView: () => ({ label: d.label }) }; },
    }, queue, deferDestroy: (r: unknown) => { if (r) deferred.push(r); },
    pipelines: { register: () => {}, compile: () => Promise.resolve(), get: () => ready ? {} : undefined } } },
    water: () => null, hulls: () => [], sdfGroup: () => ({}),
    computePass: () => ({ setBindGroup: () => {}, setPipeline: () => {}, dispatchWorkgroups: (...d: number[]) => dispatches.push(d), end: () => {} }),
  } as unknown as GasHost;
  const lights = new LightSystem(host.s.ctx.device);
  const facets = new Map<string, unknown>([['lightSystem', lights]]);
  Object.assign(host.s, { scene: { lights, get: (name: string) => facets.get(name), provide: (name: string, value: unknown) => facets.set(name, value) },
    graph: { addPass: () => () => {} }, telemetry: { gauge: () => {} } });
  const frame = (dt = 1 / 30) => ({ frame: { dt, time: 1 } }) as unknown as PassContext;
  return { host, facets, allocations, deferred, writes, dispatches, frame, ready: (value: boolean) => { ready = value; } };
}

describe('reserved muzzle gas atlas', () => {
  it('sustains vehicle smoke without reallocating/restarting it, then lets the plume expire', () => {
    const h = harness(), gas = new PlanetGas(h.host); gas.allocate('low');
    const allocated = h.allocations.length, source = { key: 'tank:1:0', position: [0, 19, 0], intensity: .8, burning: true };
    for (let i = 0; i < 300; i++) { gas.setVehicleFires([source], [0, 22, 3]); gas.run(h.frame()); }
    expect(gas.stats.live).toBe(1); expect(gas.stats.emitted).toBe(1); expect(h.allocations).toHaveLength(allocated);
    const data = h.writes.get('fluids:gas-slots')!; expect(data[5]).toBe(6); expect(data[6]).toBeCloseTo(.8);
    expect(data[27]).toBe(0); // Continuous source, not a new burst each frame.
    gas.setVehicleFires([], [0, 22, 3]);
    for (let i = 0; i < 180; i++) gas.run(h.frame());
    expect(gas.stats.live).toBe(0); gas.dispose();
  });
  it('gives explosions priority over sustained vehicle fires at saturation', () => {
    const h = harness(), gas = new PlanetGas(h.host); gas.allocate('low');
    for (let i = 0; i < gas.slotCount; i++) gas.spawnBlast([0, 19, i], [0, 1, 0], 2, 'fireball', [0, 21, 0]);
    gas.setVehicleFires([{ key: 'tank', position: [0, 19, 0], burning: true, intensity: 1 }], [0, 21, 0]);
    expect(gas.stats.evicted).toBe(0); expect(gas.stats.emitted).toBe(gas.slotCount); gas.dispose();
  });
  const naga = process.env.TMT_NAGA ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.cargo', 'bin', process.platform === 'win32' ? 'naga.exe' : 'naga');
  it.skipIf(!existsSync(naga))('validates launch jet advection and volumetric rendering with Naga', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'tmt-muzzle-gas-'));
    try {
      const flowSample = makeModule('flow-sample-test', '@compute @workgroup_size(1) fn main() {}', [gasFlowBindingsWgsl(0, 0, 1)]);
      for (const module of [gasAdvectWgsl, gasRaymarchWgsl, gasFlowAdvectWgsl, gasFlowClearWgsl, flowSample]) {
        const file = join(scratch, module.name + '.wgsl');
        writeFileSync(file, link(module).code);
        try {
          const result = spawnSync(naga, [file], { encoding: 'utf8', timeout: 30000 });
          expect(result.status, result.stderr || result.stdout || String(result.error)).toBe(0);
        } finally { unlinkSync(file); }
      }
    } finally { rmdirSync(scratch); }
  });

  it.each(['low', 'medium', 'high', 'ultra'] as QualityTier[])('%s firing never allocates GPU resources or evicts an explosion', tier => {
    const h = harness(), blasts = new PlanetGas(h.host), muzzle = new PlanetGas(h.host, 'muzzle');
    blasts.allocate(tier); muzzle.allocate(tier);
    const allocated = h.allocations.length;
    for (let i = 0; i < GAS_TIERS[tier].slots; i++) blasts.spawnBlast([0, 20, i], [0, 1, 0], 2, 'nuclear', [0, 30, 0]);
    for (let i = 0; i < 100; i++) muzzle.spawnMuzzle({ ...shot, seed: i }, [0, 30, 0]);
    expect(h.allocations).toHaveLength(allocated);
    expect(muzzle.stats.live).toBe(MUZZLE_GAS_TIERS[tier].slots);
    expect(muzzle.stats.emitted).toBe(100);
    expect(muzzle.stats.evicted).toBe(100 - muzzle.slotCount);
    expect(blasts.stats.live).toBe(GAS_TIERS[tier].slots); expect(blasts.stats.evicted).toBe(0);
    expect(muzzle.stats.atlasBytes).toBe(muzzleGasAtlasBytes(tier));
    expect(muzzle.stats.atlasBytes).toBeLessThan(3 * 1024 * 1024);
    muzzle.run(h.frame());
    expect(muzzle.stats.stepped).toBe(muzzle.slotCount);
    // Hundreds of replacements before a frame clear each slot once; dispatch never exceeds atlas depth.
    expect(h.dispatches.every(d => d[2] <= muzzle.n / 4 * muzzle.slotCount)).toBe(true);
    muzzle.clear();
    expect(muzzle.stats.live).toBe(0); expect(muzzle.stats.drawn).toBe(0);
    expect(blasts.stats.live).toBe(GAS_TIERS[tier].slots);
    muzzle.dispose(); blasts.dispose();
    expect(h.deferred.length).toBe(42);
    expect(h.deferred.filter(r => (r as { label: string }).label === 'fluids:gas-emission-sources')).toHaveLength(1);
    for (const label of ['fluids:gas-cloud-flow-params', 'fluids:gas-flow0', 'fluids:gas-flow1']) expect(h.deferred.filter(r => (r as { label: string }).label === label)).toHaveLength(1);
  });

  it('packs a copied muzzle position/direction, and retires smoke on its bounded clock', () => {
    const h = harness(), gas = new PlanetGas(h.host, 'muzzle'); gas.allocate('low');
    const mutable = { ...shot, position: [3, 20, 4], direction: [0, 0, 1] };
    gas.spawnMuzzle(mutable, [0, 30, 0]);
    mutable.position[0] = 999; mutable.direction[2] = -1;
    gas.run(h.frame());
    const data = h.writes.get('fluids:gas-slots')!, geom = h.writes.get('fluids:gas-geom')!;
    expect(data[5]).toBe(5); expect(data[7]).toBe(71);
    // Domain axes transform the packed source back to the original actual muzzle.
    for (let axis = 0; axis < 3; axis++) {
      const reconstructed = geom[axis] + geom[3] * ((data[0] - .5) * geom[4 + axis] + (data[1] - .5) * geom[8 + axis] + (data[2] - .5) * geom[12 + axis]);
      expect(reconstructed).toBeCloseTo(shot.position[axis], 5);
      const direction = data[8] * geom[4 + axis] + data[9] * geom[8 + axis] + data[10] * geom[12 + axis];
      expect(direction).toBeCloseTo(shot.direction[axis], 5);
    }
    for (let i = 0; i < 100; i++) gas.run(h.frame());
    expect(gas.stats.live).toBe(0);
  });

  it('keeps a new slot clear pending during pipeline warmup and resets it across scene changes', () => {
    const h = harness(), gas = new PlanetGas(h.host, 'muzzle'); gas.allocate('low');
    gas.spawnMuzzle(shot, [0, 30, 0]); h.ready(false); gas.run(h.frame());
    expect(h.dispatches).toHaveLength(0);
    h.ready(true); gas.run(h.frame());
    expect(h.writes.has('fluids:gas-clear')).toBe(true);
    gas.clear(); gas.run(h.frame()); expect(gas.stats.live).toBe(0);
    gas.spawnMuzzle(shot, [0, 30, 0]); gas.run(h.frame()); expect(gas.stats.live).toBe(1);
    gas.allocate('high'); expect(gas.stats.live).toBe(0); expect(gas.stats.stepped).toBe(0);
  });

  it('publishes actual departure-map parity, keeps it between steps, and withdraws retired or disabled domains', () => {
    const h = harness(), gas = new PlanetGas(h.host); gas.allocate('low');
    const flow = h.facets.get('gasCloudFlow') as GasCloudFlowFacet;
    expect(flow.maxDisplacement).toBe(0);
    expect(gas.stats.atlasBytes).toBe(24 ** 3 * 4 * 72);
    gas.spawnBlast([0, 20, 0], [0, 1, 0], 2, 'fireball', [0, 30, 0]); gas.run(h.frame());
    expect((flow.displacementView as unknown as { label: string }).label).toBe('fluids:gas-flow1');
    expect(h.writes.get('fluids:gas-cloud-flow-params')![2]).toBe(1); expect(flow.maxDisplacement).toBeGreaterThan(0);
    gas.run(h.frame(0)); expect((flow.displacementView as unknown as { label: string }).label).toBe('fluids:gas-flow1');
    gas.run(h.frame()); expect((flow.displacementView as unknown as { label: string }).label).toBe('fluids:gas-flow0');
    gas.enabled = false; gas.run(h.frame(0)); expect(flow.maxDisplacement).toBe(0); expect(h.writes.get('fluids:gas-cloud-flow-params')![2]).toBe(0);
    gas.enabled = true; gas.run(h.frame(0)); expect(h.writes.get('fluids:gas-cloud-flow-params')![2]).toBe(1);
    gas.clear(); expect(flow.maxDisplacement).toBe(0); expect(h.writes.get('fluids:gas-cloud-flow-params')![2]).toBe(0);
    gas.allocate('high'); expect(gas.stats.atlasBytes).toBe(48 ** 3 * 8 * 72); expect(flow.maxDisplacement).toBe(0);
    for (const name of ['fluids:gas-flow0', 'fluids:gas-flow1']) expect(h.deferred.filter(r => (r as { label: string }).label === name)).toHaveLength(1);
    gas.dispose();
  });
});
