/**
 * EngineTerrainHost (plan §4.7, §5.1): the engine implementation of `TerrainRenderHost`, plus the terrain render module.
 *
 * Host:
 * - `createPage` adopts the page's buffers (they belong to the page until `dispose`, which defers their destruction by
 *   ≥ 3 frames through `ctx.deferDestroy`, N6) and assigns a page-record slot (terrain-pages.ts); invisible until commit.
 * - `commit({show, hide})` is atomic (validated before anything changes, I4), stamps `newUntilFrame` (GB3 new-geometry,
 *   TAA reject for 3 frames) and emits the engine event `terrainCommitted` with the dirty world bounds.
 * - `setPose` updates model (prevModel follows automatically at the next frame start).
 * - `addPageHook(h)` registers a PageHook (plumbed by W1-TER inside ResidentGpuPages, first user W2-VEG).
 *
 * Module (`terrainModule()`):
 * - bakes the procedural layer arrays once (materials/terrain/bake.ts);
 * - 'upload' pass (order 30): page records (dirty range) + TerrainParams;
 * - GBufferDrawer 'terrain' (order 0): CPU frustum + horizon culling, front-to-back, then per page
 *   setVertexBuffer ×3 + setIndexBuffer + drawIndexed(indexCount, 1, 0, 0, firstInstance = slot);
 * - ShadowCasters 'terrain.static' (dynamic: false) and 'terrain.bodies' (dynamic: true): depth-only, cullMode 'none',
 *   depth bias 6 / slope 2.5 (negative: reversed-Z shadow maps); `ShadowView.cull(c, r)` returning true means "draw";
 * - the per-seed pipeline compiles asynchronously on `planetChanged` from the scene facet `terrainPlanetWGSL` (the facade
 *   provides `planetNormalWGSL(seed)`; the engine never imports game code). Until it is ready a fallback pipeline with the
 *   spherical normal draws the terrain, so pages are never invisible for lack of a shader.
 * Telemetry: `pagesDrawn`, `pagesTotal`, `terrainCommits`, `terrainMaterialBakeMs`.
 */
import type { EngineServices, GBufferDrawer, PlanetDesc, RenderModule, ShadowCaster, ShadowView } from '../contracts';
import { SHADOW_DEPTH } from '../contracts';
import type { PageBuffers, PageDrawHandle, PageDrawInfo, TerrainRenderHost } from '../../gpu/terrain/render-host';
import type { PageHook } from '../../gpu/terrain/page-hooks';
import { BindGroupResourceCache, pushBindingKey } from '../gpu/bind-group-cache';
import { BufferUsage, ShaderStage } from '../gpu/flags';
import { GBUFFER_COLOR_TARGETS, GBUFFER_DEPTH_STENCIL } from '../passes/gbuffer/gbuffer';
import { reservedBindGroupEntries, reservedLayoutEntries } from '../reserved-bindings';
import { bakeTerrainTextures, type TerrainTextures } from '../materials/terrain/bake';
import { TERRAIN_MODIFIERS } from '../materials/terrain/modifiers';
import type { TerrainModifier } from '../materials/terrain/modifier-types';
import {
  PAGE_RECORD_BYTES, TERRAIN_DEPTH_VERTEX_BUFFERS, TERRAIN_PARAMS, TERRAIN_VERTEX_BUFFERS, terrainDepthShader, terrainGBufferShader,
  terrainReservedNames,
} from '../materials/terrain/surface.wgsl';
import { planetFallbackNormalWgsl, planetKindIndex, planetNormalModule, sourceHash } from '../wgsl/common/planet.wgsl';
import type { Scene } from './scene-registry';
import { cullAndSort, HORIZON_OCCLUDER_RADIUS } from './culling';
import { TerrainPageTable, type CommitRecord } from './terrain-pages';
import './facets';

/** GB3 objectIds for terrain (static and detached bodies). */
export const TERRAIN_OBJECT_ID = { static: 1, body: 2 } as const;
/** Keep the active world's shader and three recent worlds; fallback/depth/shared shaders remain permanent. */
export const TERRAIN_PIPELINE_HISTORY = 4;

export interface TerrainHostContext {
  readonly device: GPUDevice;
  deferDestroy(r: GPUBuffer | GPUTexture | null | undefined): void;
}

export class EngineTerrainHost implements TerrainRenderHost {
  readonly device: GPUDevice;
  readonly table: TerrainPageTable;
  private readonly hooks: PageHook[] = [];
  private readonly committedListeners = new Set<(r: CommitRecord, epoch: number) => void>();

  constructor(private readonly ctx: TerrainHostContext, capacity = 256) {
    this.device = ctx.device;
    this.table = new TerrainPageTable({
      release: (b: PageBuffers) => {
        for (const buffer of [b.position, b.normal, b.surface, b.index, b.indirect]) ctx.deferDestroy(buffer);
      },
    }, capacity);
  }

  get pageHooks(): readonly PageHook[] { return this.hooks; }

  createPage(buffers: PageBuffers, info: PageDrawInfo): PageDrawHandle {
    return this.table.create(buffers, info, info.bodyId === undefined ? TERRAIN_OBJECT_ID.static : TERRAIN_OBJECT_ID.body);
  }

  commit(change: { show: readonly PageDrawHandle[]; hide: readonly PageDrawHandle[]; dirty?: PageDrawInfo['bounds'] }): void {
    const record = this.table.commit(change);
    for (const cb of [...this.committedListeners]) {
      try { cb(record, this.table.epoch); } catch (error) { console.warn('[terrain-host] commit listener threw', error); }
    }
  }

  addPageHook(h: PageHook): () => void {
    if (this.hooks.some(x => x.name === h.name)) throw new Error(`page hook "${h.name}" is already registered`);
    this.hooks.push(h);
    return () => { const i = this.hooks.indexOf(h); if (i >= 0) this.hooks.splice(i, 1); };
  }

  /** Called synchronously inside commit (the engine module forwards it as the `terrainCommitted` event). */
  onCommitted(cb: (r: CommitRecord, epoch: number) => void): () => void {
    this.committedListeners.add(cb);
    return () => this.committedListeners.delete(cb);
  }

  stats(): { pages: number; visible: number; epoch: number; disposedWhileVisible: number } {
    return { pages: this.table.size, visible: this.table.visibleCount, epoch: this.table.epoch, disposedWhileVisible: this.table.disposedWhileVisible };
  }
}

export interface TerrainModuleOptions {
  /** Modifier chain (default: the TERRAIN_MODIFIERS registry). */
  modifiers?: readonly TerrainModifier[];
  /** Parallax detail (1 on, 0 off); mutable through `setDetail`. */
  detail?: boolean;
  /** Proven immutable interior sphere; defaults to 0 (destructible worlds cannot assume one). */
  occluderRadius?: number;
}

export interface TerrainModule extends RenderModule {
  readonly host: EngineTerrainHost | null;
  setDetail(on: boolean): void;
  /** Snapshot the selected world's compile; rejects on failure and permits an explicit later startup retry. */
  ready(): Promise<void>;
  /** Telemetry snapshot: pages drawn/total, bake ms and bytes, current pipeline state. */
  stats(): { pagesDrawn: number; pagesTotal: number; bakeMs: number; bakeBytes: number; planetPipeline: 'ready' | 'compiling' | 'fallback'; commits: number };
}

export function terrainModule(options: TerrainModuleOptions = {}): TerrainModule {
  const disposers: (() => void)[] = [];
  let host: EngineTerrainHost | null = null;
  let textures: TerrainTextures | null = null;
  let detail = options.detail ?? true;
  let pagesDrawn = 0, pagesTotal = 0, commits = 0;
  let planetKey: string | null = null;
  const modifiers = options.modifiers ?? TERRAIN_MODIFIERS;
  const module: TerrainModule = {
    name: 'scene.terrain',
    get host() { return host; },
    setDetail(on: boolean) { detail = on; },
    ready() {
      const key = planetKey, cache = hostServices?.ctx.pipelines;
      if (!key || !cache) return Promise.resolve(); // The engine sandbox may deliberately use only the fallback.
      // Capture before awaiting anything: an older start must never start waiting on a newer world's shader.
      return (cache.retry ? cache.retry(key) : cache.compile(key)).then(() => undefined);
    },
    stats() {
      return { pagesDrawn, pagesTotal, bakeMs: textures?.bakeMs ?? 0, bakeBytes: textures?.bytes ?? 0, commits,
        planetPipeline: !planetKey ? 'fallback' : hostServices?.ctx.pipelines.get(planetKey) ? 'ready' : 'compiling' };
    },
    async install(s: EngineServices) {
      hostServices = s;
      const { device, queue } = s.ctx;
      const cache = s.ctx.pipelines;
      const scene = s.scene as Scene;
      host = new EngineTerrainHost({ device, deferDestroy: r => s.ctx.deferDestroy(r) });
      const table = host.table;
      scene.provide('terrainHost', host);
      disposers.push(host.onCommitted((record, epoch) => {
        commits++;
        s.telemetry.gauge('terrainCommits', commits);
        if (record.dirty) s.events.emit('terrainCommitted', { dirtyBounds: record.dirty, epoch });
      }));

      textures = await bakeTerrainTextures(s.ctx);
      scene.provide('terrainTextures', textures);
      s.telemetry.gauge('terrainMaterialBakeMs', Math.round(textures.bakeMs * 10) / 10);
      const tex = textures;
      disposers.push(() => tex.destroy());

      const VF = ShaderStage.VERTEX | ShaderStage.FRAGMENT, F = ShaderStage.FRAGMENT;
      const reservedNames = terrainReservedNames(modifiers);
      const groupLayout = device.createBindGroupLayout({ label: 'layout:terrain', entries: [
        { binding: 0, visibility: VF, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: F, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 2, visibility: F, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 3, visibility: F, sampler: { type: 'filtering' } },
        { binding: 4, visibility: VF, buffer: { type: 'uniform', minBindingSize: TERRAIN_PARAMS.size } },
        { binding: 5, visibility: F, sampler: { type: 'filtering' } },
      ] });
      const reservedLayout = device.createBindGroupLayout({ label: 'layout:terrain-reserved', entries: reservedLayoutEntries(VF, reservedNames) });
      const depthLayout = device.createBindGroupLayout({ label: 'layout:terrain-depth', entries: [{ binding: 0, visibility: ShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }] });
      const gbufferLayout = device.createPipelineLayout({ label: 'terrain-gbuffer', bindGroupLayouts: [s.ctx.layouts.frame, groupLayout, reservedLayout] });
      const gbufferPipeline = (key: string, planetSource: string | null) => cache.register(key, 'render', () => {
        const planet = planetSource ? planetNormalModule(planetSource) : planetFallbackNormalWgsl;
        const shader = cache.shaderModule(terrainGBufferShader({ planet, modifiers }), key);
        return {
          label: key, layout: gbufferLayout,
          vertex: { module: shader, entryPoint: 'vs_terrain', buffers: TERRAIN_VERTEX_BUFFERS },
          fragment: { module: shader, entryPoint: 'fs_terrain', targets: GBUFFER_COLOR_TARGETS },
          primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
          depthStencil: GBUFFER_DEPTH_STENCIL,
        };
      });
      const modifierKey = modifiers.map(m => m.name).join(',');
      const fallbackKey = `terrain:gbuffer:fallback:${modifierKey}`;
      gbufferPipeline(fallbackKey, null);
      const depthKey = 'terrain:depth';
      cache.register(depthKey, 'render', () => ({
        label: depthKey, layout: device.createPipelineLayout({ label: 'terrain-depth', bindGroupLayouts: [s.ctx.layouts.shadowView, depthLayout] }),
        vertex: { module: cache.shaderModule(terrainDepthShader(), depthKey), entryPoint: 'vs_terrain_depth', buffers: TERRAIN_DEPTH_VERTEX_BUFFERS },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: SHADOW_DEPTH.format, depthWriteEnabled: true, depthCompare: SHADOW_DEPTH.compare, depthBias: -6, depthBiasSlopeScale: -2.5 },
      }));
      await Promise.all([cache.compile(fallbackKey), cache.compile(depthKey).catch(() => undefined)]);

      let planet: PlanetDesc = s.scene.get('planet') ?? { seed: 1, kind: 'temperate', radius: 18 };
      let recentPlanetKeys: string[] = [];
      const retentionGroup = `terrain:planets:${modifierKey}`;
      disposers.push(() => cache.retainRecent?.(retentionGroup, []));
      const onPlanet = (p: PlanetDesc) => {
        planet = p;
        const source = s.scene.get('terrainPlanetWGSL');
        if (!source) { planetKey = null; return; }
        const key = `terrain:gbuffer:${sourceHash(source)}:${modifierKey}`;
        planetKey = key;
        gbufferPipeline(key, source);
        recentPlanetKeys = [key, ...recentPlanetKeys.filter(previous => previous !== key)].slice(0, TERRAIN_PIPELINE_HISTORY);
        cache.retainRecent?.(retentionGroup, recentPlanetKeys);
        void cache.compile(key).catch(() => undefined);
      };
      disposers.push(s.events.on('planetChanged', e => onPlanet(e.planet)));
      if (s.scene.get('terrainPlanetWGSL')) onPlanet(planet);

      const paramsBuffer = device.createBuffer({ label: 'terrain:params', size: TERRAIN_PARAMS.size, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      const paramsStaging = new ArrayBuffer(TERRAIN_PARAMS.size);
      const clamp = device.createSampler({ label: 'terrain:clamp', magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
      let records: GPUBuffer | null = null;
      disposers.push(() => { s.ctx.deferDestroy(paramsBuffer); s.ctx.deferDestroy(records); });
      const groups = new BindGroupResourceCache(4), reservedGroups = new BindGroupResourceCache(4), depthGroups = new BindGroupResourceCache(4);
      const group = () => {
        const k = groups.begin(); k.push(records, tex.albedoView, tex.surfaceView, paramsBuffer);
        return groups.get(() => device.createBindGroup({ label: 'terrain', layout: groupLayout, entries: [
          { binding: 0, resource: { buffer: records! } }, { binding: 1, resource: tex.albedoView }, { binding: 2, resource: tex.surfaceView },
          { binding: 3, resource: tex.sampler }, { binding: 4, resource: { buffer: paramsBuffer } }, { binding: 5, resource: clamp },
        ] }));
      };
      const reservedGroup = () => {
        const k = reservedGroups.begin();
        for (const n of reservedNames) for (const r of Object.values(s.bindings.get(n))) pushBindingKey(k, r);
        return reservedGroups.get(() => device.createBindGroup({ label: 'terrain:reserved', layout: reservedLayout, entries: reservedBindGroupEntries(s.bindings, reservedNames) }));
      };
      const depthGroup = () => {
        const k = depthGroups.begin(); k.push(records);
        return depthGroups.get(() => device.createBindGroup({ label: 'terrain:depth', layout: depthLayout, entries: [{ binding: 0, resource: { buffer: records! } }] }));
      };

      disposers.push(s.graph.addPass({
        name: 'terrain.upload', slot: 'upload', order: 30, reads: [], writes: [],
        run: c => {
          table.beginFrame(c.frame.index);
          if (!records || table.grown || records.size < table.capacity * PAGE_RECORD_BYTES) {
            if (records) s.ctx.deferDestroy(records);
            records = device.createBuffer({ label: 'terrain:page-records', size: table.capacity * PAGE_RECORD_BYTES, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST });
            table.grown = false;
            table.takeDirty();
            queue.writeBuffer(records, 0, table.records.buffer, 0, table.capacity * PAGE_RECORD_BYTES);
          } else {
            const dirty = table.takeDirty();
            if (dirty) {
              const first = dirty[0] * PAGE_RECORD_BYTES, bytes = (dirty[1] - dirty[0] + 1) * PAGE_RECORD_BYTES;
              queue.writeBuffer(records, first, table.records.buffer, table.records.byteOffset + first, bytes);
            }
          }
          TERRAIN_PARAMS.pack({ config: [detail ? 1 : 0, planetKindIndex(planet.kind), planet.radius, c.frame.time], smc: [0, 0, 0, 0] }, paramsStaging);
          queue.writeBuffer(paramsBuffer, 0, paramsStaging);
        },
      }));

      const occluder = options.occluderRadius ?? HORIZON_OCCLUDER_RADIUS;
      const bindPage = (pass: GPURenderPassEncoder, b: PageBuffers, withAttributes: boolean) => {
        pass.setVertexBuffer(0, b.position);
        if (withAttributes) { pass.setVertexBuffer(1, b.normal); pass.setVertexBuffer(2, b.surface); }
        pass.setIndexBuffer(b.index, 'uint32');
      };
      const drawer: GBufferDrawer = {
        name: 'terrain', slot: 'gbuffer.opaque', order: 0,
        draw(pass, f) {
          const pipeline = (planetKey ? cache.get<GPURenderPipeline>(planetKey) : undefined) ?? cache.get<GPURenderPipeline>(fallbackKey);
          if (!pipeline || !records) { pagesDrawn = 0; return; }
          const slots = table.slots();
          const items = slots.map(p => (p && p.visible && p.buffers.indexCount > 0 ? p.worldSphere : null));
          const { visible } = cullAndSort(items, f.viewProjNoJitter, f.eye, { occluderRadius: occluder });
          pagesDrawn = visible.length;
          pagesTotal = table.visibleCount;
          s.telemetry.gauge('pagesDrawn', pagesDrawn);
          s.telemetry.gauge('pagesTotal', pagesTotal);
          if (!visible.length) return;
          pass.setPipeline(pipeline);
          pass.setBindGroup(1, group());
          pass.setBindGroup(2, reservedGroup());
          for (const slot of visible) {
            const p = slots[slot]!;
            bindPage(pass, p.buffers, true);
            pass.drawIndexed(p.buffers.indexCount, 1, 0, 0, slot);
          }
        },
      };
      const caster = (name: string, dynamic: boolean): ShadowCaster => ({
        name, dynamic,
        drawDepth(pass: GPURenderPassEncoder, v: ShadowView) {
          const pipeline = cache.get<GPURenderPipeline>(depthKey);
          if (!pipeline || !records) return;
          const pages = table.visible(dynamic ? 'body' : 'static');
          if (!pages.length) return;
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, v.bindGroup);
          pass.setBindGroup(1, depthGroup());
          for (const p of pages) {
            if (p.buffers.indexCount === 0 || !v.cull(p.worldSphere.center, p.worldSphere.radius)) continue;
            bindPage(pass, p.buffers, false);
            pass.drawIndexed(p.buffers.indexCount, 1, 0, 0, p.slot);
          }
        },
      });
      disposers.push(scene.addGBufferDrawer(drawer));
      disposers.push(scene.addShadowCaster(caster('terrain.static', false)));
      disposers.push(scene.addShadowCaster(caster('terrain.bodies', true)));
    },
    dispose() {
      for (const d of disposers.splice(0).reverse()) { try { d(); } catch (error) { console.warn('[terrain] dispose step threw', error); } }
      if (host) for (const p of [...host.table.all()]) p.handle.dispose();
    },
  };
  let hostServices: EngineServices | null = null;
  return module;
}
