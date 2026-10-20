import { describe, expect, it } from 'vitest';
import { PipelineCache } from '../src/engine/gpu/pipeline-cache';
import { link, makeModule } from '../src/engine/wgsl/module';
import { TERRAIN_PIPELINE_HISTORY } from '../src/engine/scene/terrain-host';

function rig() {
  let modules = 0, builds = 0;
  const pending = new Map<string, { resolve: (value: GPURenderPipeline) => void; reject: (error: Error) => void }>();
  const device = {
    createShaderModule: () => ({ id: ++modules, getCompilationInfo: async () => ({ messages: [] }) }) as unknown as GPUShaderModule,
    createRenderPipelineAsync: (descriptor: GPURenderPipelineDescriptor) => {
      builds++; return new Promise<GPURenderPipeline>((resolve, reject) => pending.set(descriptor.label!, { resolve, reject }));
    },
    createComputePipelineAsync: async () => ({} as GPUComputePipeline),
  };
  const cache = new PipelineCache(device, { log: () => {} });
  const source = (name: string) => link(makeModule(name, `const VALUE: u32 = ${name.length}u; // ${name}`));
  const register = (key: string, shader = key) => cache.register(key, 'render', () => ({
    label: key, layout: 'auto', vertex: { module: cache.shaderModule(source(shader), shader), entryPoint: 'main' },
  }));
  const finish = (key: string) => { const value = { key } as unknown as GPURenderPipeline; pending.get(key)!.resolve(value); pending.delete(key); return value; };
  return { cache, register, finish, pending, source, counts: () => ({ modules, builds }) };
}

describe('explicit pipeline retention', () => {
  it('bounds consecutive world variants and releases unique shader modules and registered builders', async () => {
    const { cache, register, finish, source, counts } = rig();
    register('fallback'); let promise = cache.compile('fallback'); const fallback = finish('fallback'); await promise;
    register('shared-warmup');
    const recent: string[] = [];
    for (let seed = 0; seed < 30; seed++) {
      const key = `world-${seed}`; register(key); recent.unshift(key); recent.length = Math.min(recent.length, TERRAIN_PIPELINE_HISTORY);
      cache.retainRecent('worlds', recent); promise = cache.compile(key); const active = finish(key); await promise;
      expect(cache.get(key)).toBe(active); expect(cache.get('fallback')).toBe(fallback);
      expect(cache.stats().registered).toBeLessThanOrEqual(TERRAIN_PIPELINE_HISTORY + 2);
      expect(cache.stats().shaderModules).toBeLessThanOrEqual(TERRAIN_PIPELINE_HISTORY + 1);
    }
    expect(cache.keys()).toEqual(['fallback', 'shared-warmup', 'world-26', 'world-27', 'world-28', 'world-29']);
    await expect(cache.compile('world-0')).rejects.toThrow('not registered');
    const before = counts().modules; cache.shaderModule(source('world-0'), 'world-0'); expect(counts().modules).toBe(before + 1);
    // An unrelated lazy registration survives pruning and still participates in warm-up.
    const warmup = cache.warmup(); finish('shared-warmup'); await warmup; expect(cache.get('shared-warmup')).toBeDefined();
  });

  it('retains pending work until settled, supports reselecting it and never replaces the newest active key', async () => {
    const { cache, register, finish, counts } = rig();
    register('old'); cache.retainRecent('worlds', ['old']); const old = cache.compile('old');
    register('latest'); cache.retainRecent('worlds', ['latest']); const latest = cache.compile('latest');
    expect(cache.stats()).toMatchObject({ registered: 2, pending: 2, retiring: 1, shaderModules: 2 });
    expect(cache.compile('old')).toBe(old); // still deduplicated, even while retired
    cache.retainRecent('worlds', ['old', 'latest']); expect(cache.stats().retiring).toBe(0);
    expect(cache.compile('old')).toBe(old); expect(counts().builds).toBe(2);
    const active = finish('latest'); await latest;
    cache.retainRecent('worlds', ['latest']); const oldValue = finish('old'); expect(await old).toBe(oldValue);
    expect(cache.get('latest')).toBe(active); expect(cache.get('old')).toBeUndefined();
    expect(cache.stats()).toMatchObject({ registered: 1, pending: 0, retiring: 0, shaderModules: 1 });
  });

  it('does not release a module shared by a surviving pipeline or captured outside a builder', async () => {
    const { cache, register, finish, source, counts } = rig();
    register('shared', 'same-source'); const shared = cache.compile('shared'); finish('shared'); await shared;
    register('world', 'same-source'); cache.retainRecent('worlds', ['world']); const world = cache.compile('world'); finish('world'); await world;
    expect(counts().modules).toBe(1); cache.retainRecent('worlds', []);
    expect(cache.stats().shaderModules).toBe(1); expect(cache.get('shared')).toBeDefined();
    const captured = cache.shaderModule(source('captured'), 'captured');
    cache.register('lazy', 'render', () => ({ label: 'lazy', layout: 'auto', vertex: { module: captured } }));
    cache.register('temporary', 'render', () => ({ label: 'temporary', layout: 'auto', vertex: { module: captured } }));
    cache.retainRecent('worlds', ['temporary']); const temporary = cache.compile('temporary'); finish('temporary'); await temporary;
    cache.retainRecent('worlds', []); expect(cache.stats().shaderModules).toBe(2);
    const lazy = cache.compile('lazy'); finish('lazy'); await lazy; expect(cache.get('lazy')).toBeDefined();
    expect(cache.shaderModule(source('captured'), 'captured')).toBe(captured);
  });

  it('retired failing compiles settle, keep useful diagnostics and do not retain modules', async () => {
    const { cache, register, pending } = rig(); register('failed'); cache.retainRecent('worlds', ['failed']);
    const failed = cache.compile('failed'); const rejection = expect(failed).rejects.toThrow('device compilation failed');
    cache.retainRecent('worlds', []); pending.get('failed')!.reject(new Error('device compilation failed')); await rejection;
    expect(cache.stats()).toMatchObject({ registered: 0, pending: 0, retiring: 0, shaderModules: 0, errors: 1 });
    expect(cache.errors[0].message).toBe('device compilation failed');
  });

  it('preserves a pipeline retained by another group and permits fresh compilation after eviction', async () => {
    const { cache, register, finish, counts } = rig(); register('a'); cache.retainRecent('one', ['a']); cache.retainRecent('two', ['a']);
    const first = cache.compile('a'); finish('a'); await first;
    cache.retainRecent('one', []); expect(cache.get('a')).toBeDefined();
    cache.retainRecent('two', []); expect(cache.keys()).toEqual([]); expect(cache.stats().shaderModules).toBe(0);
    register('a'); cache.retainRecent('one', ['a']); const again = cache.compile('a'); finish('a'); await again;
    expect(counts()).toEqual({ modules: 2, builds: 2 }); expect(cache.get('a')).toBeDefined();
  });

  it('retries a failed key only explicitly, clearing its diagnostics while preserving unrelated failures', async () => {
    const { cache, register, pending, finish, counts } = rig();
    for (const key of ['world', 'unrelated']) {
      register(key); const compiled = cache.compile(key), rejected = expect(compiled).rejects.toThrow(`${key} failed`);
      pending.get(key)!.reject(new Error(`${key} failed`)); await rejected;
    }
    expect(cache.stats()).toMatchObject({ pending: 0, errors: 2 });
    await expect(cache.compile('world')).rejects.toThrow('world failed'); expect(counts().builds).toBe(2);
    const retry = cache.retry('world'); expect(cache.retry('world')).toBe(retry);
    expect(cache.errors.map(error => error.key)).toEqual(['unrelated']); expect(cache.stats().pending).toBe(1);
    const pipeline = finish('world'); expect(await retry).toBe(pipeline);
    expect(cache.retry('world')).toBe(retry); expect(counts().builds).toBe(3);
    expect(cache.stats()).toMatchObject({ pending: 0, errors: 1, pipelines: 1, shaderModules: 2 });
  });

  it('balances pending work and can explicitly recover from a synchronous descriptor failure', async () => {
    const { cache, finish } = rig(); let fail = true;
    cache.register('sync', 'render', () => { if (fail) throw new Error('descriptor failed'); return { label: 'sync', layout: 'auto', vertex: { module: {} as GPUShaderModule } }; });
    await expect(cache.compile('sync')).rejects.toThrow('descriptor failed'); expect(cache.stats().pending).toBe(0);
    fail = false; const retry = cache.retry('sync'); expect(cache.stats().pending).toBe(1); finish('sync'); await retry;
    expect(cache.stats()).toMatchObject({ pending: 0, pipelines: 1 });
  });
});
