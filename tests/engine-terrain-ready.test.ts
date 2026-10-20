import { describe, expect, it, vi } from 'vitest';
import { terrainModule } from '../src/engine/scene/terrain-host';
import { PipelineCache } from '../src/engine/gpu/pipeline-cache';
import { Scene } from '../src/engine/scene/scene-registry';
import { EventBus } from '../src/engine/events';
import type { EngineServices, PlanetDesc } from '../src/engine/contracts';
import type { Engine } from '../src/engine';
import { GameView } from '../src/game/view';
import { TerrainPresentation } from '../src/game/presentation/terrain-module';

vi.mock('../src/engine/materials/terrain/bake', () => ({ bakeTerrainTextures: async () => ({ bakeMs: 0, bytes: 0, destroy() {} }) }));

async function rig() {
  const pending = new Map<string, { resolve: (pipeline: GPURenderPipeline) => void; reject: (error: Error) => void }>();
  const device = {
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createRenderPipelineAsync: (d: GPURenderPipelineDescriptor) => d.label?.includes(':fallback:') || d.label === 'terrain:depth'
      ? Promise.resolve({ label: d.label })
      : new Promise<GPURenderPipeline>((resolve, reject) => pending.set(d.label!, { resolve, reject })),
    createComputePipelineAsync: async () => ({}), createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}), createBuffer: () => ({}), createSampler: () => ({}),
  } as unknown as GPUDevice;
  const cache = new PipelineCache(device, { log: () => {} }), scene = new Scene(), events = new EventBus();
  const module = terrainModule({ modifiers: [] });
  await module.install({ ctx: { device, queue: {}, pipelines: cache, layouts: {}, deferDestroy() {} }, scene, events, telemetry: { gauge() {} }, graph: { addPass: () => () => {} } } as unknown as EngineServices);
  const engine = { services: { scene }, setPlanet(p: PlanetDesc) { scene.provide('planet', p); events.emit('planetChanged', { planet: p }); return cache.whenIdle(); } } as unknown as Engine;
  const facade = { terrain: new TerrainPresentation(engine), scene: { terrain: module } };
  const prepare = (seed: number, kind: PlanetDesc['kind'] = 'temperate') => GameView.prototype.preparePlanet.call(facade as unknown as GameView, seed, kind);
  const finish = (key: string) => { pending.get(key)!.resolve({ label: key } as GPURenderPipeline); pending.delete(key); };
  return { cache, module, prepare, pending, finish };
}

describe('selected terrain shader startup readiness', () => {
  it('permits a sandbox with no selected-world shader', async () => { await expect(terrainModule().ready()).resolves.toBeUndefined(); });

  it('rejects preparePlanet when shared idle swallowed a shader failure, then retries the memoized same world', async () => {
    const { cache, module, prepare, pending, finish } = await rig();
    const start = prepare(7), rejected = expect(start).rejects.toThrow('selected shader failed');
    const key = [...pending.keys()][0]; pending.get(key)!.reject(new Error('selected shader failed')); await rejected;
    await expect(cache.whenIdle()).resolves.toBeUndefined(); expect(cache.get(key)).toBeUndefined(); expect(cache.stats().errors).toBe(1);
    const retry = prepare(7); expect(cache.stats()).toMatchObject({ pending: 1, errors: 0 }); finish(key); await retry;
    expect(module.stats().planetPipeline).toBe('ready'); expect(cache.get(key)).toBeDefined(); module.dispose?.();
  });

  it('captures the original selected key and a late rejection cannot reset a newer ready world', async () => {
    const { cache, module, prepare, pending, finish } = await rig();
    const old = prepare(7, 'glacial'), oldRejected = expect(old).rejects.toThrow('old shader failed');
    const oldKey = [...pending.keys()][0], newest = prepare(9, 'dune'), newKey = [...pending.keys()].find(key => key !== oldKey)!;
    finish(newKey); pending.get(oldKey)!.reject(new Error('old shader failed'));
    await oldRejected; await newest;
    expect(module.stats().planetPipeline).toBe('ready'); expect(cache.get(newKey)).toBeDefined(); expect(cache.get(oldKey)).toBeUndefined();
    await expect(module.ready()).resolves.toBeUndefined(); expect(cache.errors.map(error => error.key)).toEqual([oldKey]); module.dispose?.();
  });
});
