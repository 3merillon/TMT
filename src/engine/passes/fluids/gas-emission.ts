import type { EngineServices, LightHandle, PassContext } from '../../contracts';
import { BufferUsage, ShaderStage } from '../../gpu/flags';
import { BindGroupResourceCache, pushBindingKey } from '../../gpu/bind-group-cache';
import { link } from '../../wgsl/module';
import { gasEmissionWgsl } from './gas-emission.wgsl';

export interface GasEmissionDomain {
  id: number; slot: number; center: readonly number[]; right: readonly number[]; up: readonly number[]; fwd: readonly number[];
  edge: number; age: number; fade: number; steam: number; ready: boolean;
}
/** Owns handles in the existing scene light pool. Pool indices are resolved before its upload,
 * then a small compute reduction updates only those records from the current simulation atlas. */
export class GasEmissionLights {
  private readonly handles = new Map<number, LightHandle>();
  private readonly indices = new Map<number, number>();
  private readonly buffer: GPUBuffer;
  private readonly layout: GPUBindGroupLayout;
  private readonly cache = new BindGroupResourceCache(2);
  private readonly removePass: () => void;
  private readonly key = 'fluids:gas-emission';
  constructor(private readonly s: EngineServices, private readonly domains: () => readonly GasEmissionDomain[]) {
    const device = s.ctx.device;
    this.buffer = device.createBuffer({ label: 'fluids:gas-emission-sources', size: 64 * 96, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST });
    const C = ShaderStage.COMPUTE;
    this.layout = device.createBindGroupLayout({ label: this.key, entries: [
      { binding: 0, visibility: C, buffer: { type: 'read-only-storage' } },
      ...[1, 2, 3].map(binding => ({ binding, visibility: C, texture: { sampleType: 'float' as const, viewDimension: '3d' as const } })),
      ...[4, 5].map(binding => ({ binding, visibility: C, sampler: { type: 'filtering' as const } })),
      { binding: 6, visibility: C, buffer: { type: 'storage' } },
    ] });
    s.ctx.pipelines.register(this.key, 'compute', () => ({ label: this.key,
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module: s.ctx.pipelines.shaderModule(link(gasEmissionWgsl), this.key), entryPoint: 'main' },
    }));
    void s.ctx.pipelines.compile(this.key).catch(() => undefined);
    this.removePass = s.graph.addPass({ name: 'fluids.gasEmissionPrepare', slot: 'upload', order: 10, reads: [], writes: [], run: () => this.prepare() });
  }
  private prepare(): void {
    const live = this.domains().filter(f => f.steam < 1), ids = new Set(live.map(f => f.id));
    for (const [id, handle] of this.handles) if (!ids.has(id)) { this.s.scene.lights.remove(handle); this.handles.delete(id); }
    this.indices.clear();
    const system = this.s.scene.get('lightSystem');
    if (!system) return;
    for (const f of live) {
      let handle = this.handles.get(f.id);
      if (!handle) {
        try { handle = this.s.scene.lights.add({ type: 'point', position: [f.center[0], f.center[1], f.center[2]], range: 1, color: [0, 0, 0], intensity: 0, castShadow: true }); }
        catch { continue; } // The existing global64 limit remains authoritative.
        this.handles.set(f.id, handle);
      }
      // CPU upload starts dark every frame: skipped/missing GPU reductions never leave stale fire light.
      this.s.scene.lights.update(handle, { intensity: 0 });
      const index = system.indexOf(handle); if (index >= 0) this.indices.set(f.id, index);
    }
    this.s.telemetry.gauge('gasEmissionLights', this.indices.size);
  }
  run(c: PassContext, field: GPUTextureView, obstacles: GPUTextureView, noise: GPUTextureView, lin: GPUSampler, rep: GPUSampler, n: number, slots: number, scale: number): void {
    const pipeline = this.s.ctx.pipelines.get<GPUComputePipeline>(this.key), system = this.s.scene.get('lightSystem');
    if (!pipeline || !system || !this.indices.size) return;
    const current = new Map(this.domains().map(f => [f.id, f]));
    const data = new Float32Array(this.indices.size * 24); let count = 0;
    for (const [id, index] of this.indices) {
      const f = current.get(id); if (!f) continue;
      data.set([...f.center, f.edge, ...f.right, 0, ...f.up, 0, ...f.fwd, 0,
        index, f.slot, f.ready ? f.fade : 0, f.steam, n, slots, f.age, scale], count++ * 24);
    }
    if (!count) return;
    this.s.ctx.queue.writeBuffer(this.buffer, 0, data, 0, count * 24);
    const resources: GPUBindingResource[] = [{ buffer: this.buffer }, field, obstacles, noise, lin, rep, { buffer: system.buffer }];
    const key = this.cache.begin(); for (const resource of resources) pushBindingKey(key, resource);
    const group = this.cache.get(() => this.s.ctx.device.createBindGroup({ label: this.key, layout: this.layout, entries: resources.map((resource, binding) => ({ binding, resource })) }));
    const timestampWrites = c.timestampWrites('fluids.gasEmission') as GPUComputePassTimestampWrites | undefined;
    const pass = c.encoder.beginComputePass({ label: 'fluids.gasEmission', ...(timestampWrites ? { timestampWrites } : {}) });
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(count); pass.end();
  }
  clear(): void {
    for (const handle of this.handles.values()) this.s.scene.lights.remove(handle);
    this.handles.clear(); this.indices.clear();
  }
  dispose(): void { this.removePass(); this.clear(); this.cache.clear(); this.s.ctx.deferDestroy(this.buffer); }
}
