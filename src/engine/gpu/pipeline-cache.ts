/**
 * Pipeline cache: every pipeline is created with create*PipelineAsync (plan §13 rule 9), de-duplicated by key while in
 * flight and after, timed (compile ms telemetry), and its WGSL compiler messages are mapped back to `module:line` through
 * the link line map. `register()` records a lazily built pipeline in the warm-up list; `warmup()` compiles the whole
 * list, which is what debug/shader-check runs.
 */
import type { LinkedWgsl } from '../contracts';

export interface PipelineError { key: string; module: string; line: number; column: number; message: string }

type PipelineKind = 'render' | 'compute';
interface Entry {
  kind: PipelineKind;
  build: () => GPURenderPipelineDescriptor | GPUComputePipelineDescriptor;
  promise?: Promise<GPURenderPipeline | GPUComputePipeline>;
  pipeline?: GPURenderPipeline | GPUComputePipeline;
  ms?: number;
  failed?: boolean;
  pending?: boolean;
  retired?: boolean;
  modules?: Set<ModuleEntry>;
}
interface ModuleEntry { module: GPUShaderModule; linked: LinkedWgsl; label: string; users: Set<Entry>; external: boolean }

type CacheDevice = Pick<GPUDevice, 'createShaderModule' | 'createRenderPipelineAsync' | 'createComputePipelineAsync'>;

export class PipelineCache {
  private readonly entries = new Map<string, Entry>();
  private readonly modules = new Map<string, ModuleEntry>();
  private readonly moduleInfo = new WeakMap<GPUShaderModule, ModuleEntry>();
  private readonly retained = new Map<string, Set<string>>();
  private building?: Entry;
  readonly errors: PipelineError[] = [];
  totalMs = 0;
  private pendingCount = 0;

  constructor(private readonly device: CacheDevice, private readonly options: { dev?: boolean; log?: (msg: string) => void } = {}) {}

  /** A shader module for linked WGSL, cached by source text. */
  shaderModule(linked: LinkedWgsl, label: string): GPUShaderModule {
    let entry = this.modules.get(linked.code);
    if (!entry) {
      const module = this.device.createShaderModule({ label: `shader:${label}`, code: linked.code });
      entry = { module, linked, label, users: new Set(), external: false };
      this.modules.set(linked.code, entry); this.moduleInfo.set(module, entry);
    }
    // Calls outside a pipeline builder may feed not-yet-built registered shaders. Keep those shared modules.
    if (this.building) this.useModule(this.building, entry); else entry.external = true;
    return entry.module;
  }
  private useModule(entry: Entry, module: ModuleEntry): void {
    (entry.modules ??= new Set()).add(module); module.users.add(entry);
  }

  /** Explicitly scoped retention; ungrouped warm-up pipelines are never evicted.
   * Pending compiles remain deduplicated until they settle; reselecting one cancels its retirement.
   * WebGPU pipelines/modules have no destroy API: dropping cache references releases them when unused. */
  retainRecent(group: string, keys: readonly string[]): void {
    const previous = this.retained.get(group) ?? new Set<string>(), next = new Set(keys);
    if (next.size) this.retained.set(group, next); else this.retained.delete(group);
    for (const key of next) { const entry = this.entries.get(key); if (entry) entry.retired = false; }
    for (const key of previous) {
      if (next.has(key) || [...this.retained.values()].some(keep => keep.has(key))) continue;
      const entry = this.entries.get(key); if (!entry) continue;
      entry.retired = true; if (!entry.pending) this.evict(key, entry);
    }
  }
  private evict(key: string, entry: Entry): void {
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key);
    for (const module of entry.modules ?? []) {
      module.users.delete(entry);
      if (!module.external && !module.users.size) this.modules.delete(module.linked.code);
    }
    entry.modules?.clear();
  }

  /** Mapped compiler messages (errors only) for a module created by shaderModule(). */
  async compilationErrors(module: GPUShaderModule, key: string): Promise<PipelineError[]> {
    const info = this.moduleInfo.get(module);
    if (!info || typeof module.getCompilationInfo !== 'function') return [];
    const result = await module.getCompilationInfo();
    return result.messages.filter(m => m.type === 'error').map(m => {
      const at = info.linked.mapLine(m.lineNum);
      return { key, module: `${info.label}/${at.module}`, line: at.line, column: m.linePos, message: m.message };
    });
  }

  /** Record a pipeline in the warm-up list without compiling it. */
  register(key: string, kind: PipelineKind, build: Entry['build']): void {
    if (!this.entries.has(key)) this.entries.set(key, { kind, build });
  }

  render(key: string, build: () => GPURenderPipelineDescriptor): Promise<GPURenderPipeline> {
    return this.request(key, 'render', build) as Promise<GPURenderPipeline>;
  }

  compute(key: string, build: () => GPUComputePipelineDescriptor): Promise<GPUComputePipeline> {
    return this.request(key, 'compute', build) as Promise<GPUComputePipeline>;
  }

  /** Compile a registered pipeline (de-duplicated). */
  compile(key: string): Promise<GPURenderPipeline | GPUComputePipeline> {
    const e = this.entries.get(key);
    if (!e) return Promise.reject(new Error(`pipeline "${key}" is not registered`));
    return this.request(key, e.kind, e.build);
  }

  /** A user-triggered retry may rebuild a failed pipeline; polling/get/warmup never retries it automatically. */
  retry(key: string): Promise<GPURenderPipeline | GPUComputePipeline> {
    const entry = this.entries.get(key);
    if (entry?.failed && !entry.pending) {
      this.evict(key, entry);
      this.register(key, entry.kind, entry.build);
      for (let i = this.errors.length - 1; i >= 0; i--) if (this.errors[i].key === key) this.errors.splice(i, 1);
    }
    return this.compile(key);
  }

  /** The finished pipeline, or undefined while compiling / after a failure. */
  get<T extends GPURenderPipeline | GPUComputePipeline>(key: string): T | undefined {
    return this.entries.get(key)?.pipeline as T | undefined;
  }

  private request(key: string, kind: PipelineKind, build: Entry['build']): Promise<GPURenderPipeline | GPUComputePipeline> {
    let e = this.entries.get(key);
    if (e?.promise) return e.promise;
    if (!e) { e = { kind, build }; this.entries.set(key, e); }
    const entry = e;
    const started = performance.now();
    this.pendingCount++;
    entry.pending = true;
    let desc: GPURenderPipelineDescriptor | GPUComputePipelineDescriptor, create: Promise<GPURenderPipeline | GPUComputePipeline>;
    const previousBuilding = this.building;
    try {
      this.building = entry; desc = entry.build();
      // Also track a module returned from a previously captured descriptor, not only shaderModule() calls.
      const stages = 'compute' in desc ? [desc.compute.module] : [desc.vertex.module, ...desc.fragment ? [desc.fragment.module] : []];
      for (const stage of stages) { const module = this.moduleInfo.get(stage); if (module) this.useModule(entry, module); }
      create = entry.kind === 'render'
        ? this.device.createRenderPipelineAsync(desc as GPURenderPipelineDescriptor)
        : this.device.createComputePipelineAsync(desc as GPUComputePipelineDescriptor);
    } catch (error) {
      entry.pending = false; entry.failed = true; this.pendingCount--;
      entry.promise = Promise.reject(error); if (entry.retired) this.evict(key, entry); return entry.promise;
    } finally { this.building = previousBuilding; }
    entry.promise = create.then(pipeline => {
      entry.pipeline = pipeline;
      entry.ms = performance.now() - started;
      this.totalMs += entry.ms;
      return pipeline;
    }, async (error: unknown) => {
      entry.failed = true;
      const mapped = await this.stageErrors(key, desc);
      const list = mapped.length ? mapped : [{ key, module: '(pipeline)', line: 0, column: 0, message: error instanceof Error ? error.message : String(error) }];
      this.errors.push(...list);
      for (const m of list) (this.options.log ?? console.error)(`[engine] pipeline "${key}" failed: ${m.module}:${m.line}:${m.column} ${m.message}`);
      throw error;
    }).finally(() => { this.pendingCount--; entry.pending = false; if (entry.retired) this.evict(key, entry); });
    return entry.promise;
  }

  private async stageErrors(key: string, desc: GPURenderPipelineDescriptor | GPUComputePipelineDescriptor): Promise<PipelineError[]> {
    const stages: GPUShaderModule[] = [];
    if ('compute' in desc && desc.compute) stages.push(desc.compute.module);
    if ('vertex' in desc && desc.vertex) stages.push(desc.vertex.module);
    if ('fragment' in desc && desc.fragment) stages.push(desc.fragment.module);
    const out: PipelineError[] = [];
    for (const m of new Set(stages)) { try { out.push(...await this.compilationErrors(m, key)); } catch { /* lost */ } }
    return out;
  }

  /** Compile every registered pipeline; resolves when all settle. */
  async warmup(): Promise<void> {
    const all = [...this.entries.entries()].map(([key, e]) => this.request(key, e.kind, e.build).catch(() => undefined));
    await Promise.all(all);
  }

  /** Resolves when nothing is compiling. */
  async whenIdle(): Promise<void> {
    for (let guard = 0; guard < 100; guard++) {
      const pending = [...this.entries.values()].filter(e => e.promise && !e.pipeline && !e.failed).map(e => e.promise!.catch(() => undefined));
      if (!pending.length) return;
      await Promise.all(pending);
    }
  }

  keys(): string[] { return [...this.entries.keys()]; }

  stats(): { totalMs: number; pipelines: number; pending: number; errors: number; registered: number; shaderModules: number; retiring: number } {
    let ready = 0;
    for (const e of this.entries.values()) if (e.pipeline) ready++;
    return { totalMs: Math.round(this.totalMs * 10) / 10, pipelines: ready, pending: this.pendingCount, errors: this.errors.length,
      registered: this.entries.size, shaderModules: this.modules.size, retiring: [...this.entries.values()].filter(e => e.retired).length };
  }

  /** Per-pipeline compile ms (slowest first). */
  compileTimes(): { key: string; ms: number }[] {
    return [...this.entries.entries()].filter(([, e]) => e.ms !== undefined).map(([key, e]) => ({ key, ms: Math.round(e.ms! * 10) / 10 }))
      .sort((a, b) => b.ms - a.ms);
  }
}
