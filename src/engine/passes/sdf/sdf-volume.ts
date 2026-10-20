/**
 * The planet SDF module (docs/visibility-architecture.md): one r16float volume over ±SDF_HALF_EXTENT, built on the GPU
 * from the resident static terrain pages (sdf-build.wgsl.ts) and provided as the reserved binding `sdf`.
 *
 * - Size by tier: Low 128³, Medium 160³, High 256³, Ultra 256³ (0.38 / 0.31 / 0.19 / 0.19 u voxels).
 * - Builds run in the 'compute.commit' slot. The first commit (all pages) builds the whole domain; every later
 *   `terrainCommitted` rebuilds its dirty box grown by the band, with the far-field flood redone globally on the coarse
 *   grid. Edits only remove rock, so far-field values left outside the box stay conservative lower bounds.
 * - Pending craters (the engine's per-frame `pendingCutList`) are carved analytically into every lookup through the params
 *   block. A pending cut that disappears (the commit retired it) is held until the next build completes, so the crater
 *   never flickers between the cosmetic cut and the rebuilt volume.
 * - Detached bodies stay out of the SDF (they are cosmetic for visibility; the simulation gates tanks).
 * Telemetry: 'sdfBuilds', 'sdfOpenColumns' (columns whose crossing count was odd: an open mesh), 'sdfRegionVoxels'.
 */
import type { EngineServices, QualityTier, RenderModule, Vec3 } from '../../contracts';
import { BufferUsage, MapMode, ShaderStage, TextureUsage } from '../../gpu/flags';
import { link } from '../../wgsl/module';
import type { EngineTerrainHost } from '../../scene/terrain-host';
import { makeModule } from '../../wgsl/module';
import { SDF_MAX_CUTS, SDF_PARAMS, sdfBindingsWgsl, sdfWgsl } from './sdf.wgsl';
import { SDF_COARSE, SDF_NEAR_DISTANCE, sdfClearWgsl, sdfFloodWgsl, sdfGatherWgsl, sdfGrowWgsl, sdfParityWgsl, sdfResolveWgsl, sdfSeedWgsl } from './sdf-build.wgsl';

export const SDF_TIER_SIZE: Readonly<Record<QualityTier, number>> = { low: 128, medium: 160, high: 256, ultra: 256 };
export const SDF_HALF_EXTENT = 24.5;
/** Dev override of the tier size (?sdfSize=, a multiple of 32 in 64…512) for resolution comparisons. */
function sdfSizeOverride(): number | null {
  const n = typeof location === 'undefined' ? NaN : Number(new URLSearchParams(location.search).get('sdfSize'));
  return Number.isInteger(n) && n >= 64 && n <= 512 && n % 32 === 0 ? n : null;
}
/** Exact distances are kept within this many voxels of a triangle; beyond it the coarse flood gives a lower bound. */
export const SDF_BAND_VOXELS = 4;
/** A cut retired by a commit is held at least this many frames, and at most the second number, awaiting the rebuild. */
const HOLD_FRAMES = [3, 90] as const;

export interface SdfStats {
  builds: number; lastRegionVoxels: number; openColumns: number; pages: number; size: number; format: GPUTextureFormat;
  /** Last build: triangles compacted for the band and triangle-cell links (from the async readback). */
  triangles: number; links: number; overflows: number;
}
/**
 * Initial triangle-cell link capacity per compacted triangle at 192³, scaled with the coarse cell area (a triangle spans
 * more, smaller cells at finer grids: about 31 links at 256³); doubled after an overflow (which also redoes the build).
 */
const LINKS_PER_TRIANGLE = 24;
const linksForSize = (n: number) => Math.ceil(LINKS_PER_TRIANGLE * Math.max(1, (n / 192) ** 2));

export interface SdfFacet {
  /** True once a build has completed (the volume holds terrain). */
  readonly valid: boolean;
  readonly size: number;
  readonly voxel: number;
  readonly half: number;
  readonly volumeView: GPUTextureView;
  readonly paramsBuffer: GPUBuffer;
  /** Per-voxel band distance bits; the low 4 bits of a surface-adjacent voxel hold the terrain material id (GI). */
  readonly band: GPUBuffer;
  /** Completed builds (bumps when the volume changes). */
  readonly serial: number;
  stats(): SdfStats;
  /** Rebuild the whole domain next frame (debug). */
  rebuild(): void;
  /** Rebuild a world box next frame, as a terrain commit would (debug and benchmarks). */
  rebuildBox(min: readonly number[], max: readonly number[]): void;
  /** The field (pending cuts included) at world points, read back after the next frame (gates and debugging). */
  sample(points: readonly (readonly number[])[]): Promise<number[]>;
}

const sampleShader = makeModule('sdf-sample-probe', /* wgsl */ `
@group(0) @binding(3) var<storage, read> points: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> values: array<f32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&values)) { return; }
  values[id.x] = sdf_sample(points[id.x].xyz);
}
`, [sdfBindingsWgsl(0, { volume: 0, params: 1, sampler: 2 }), sdfWgsl]);

declare module '../../contracts' {
  interface SceneFacets { sdf: SdfFacet }
}

type Box = { lo: [number, number, number]; hi: [number, number, number] };
interface HeldCut { key: string; cut: [number, number, number, number]; since: number; afterSerial: number }

const cutKey = (c: { center: readonly number[]; radius: number }) => `${c.center[0].toFixed(3)},${c.center[1].toFixed(3)},${c.center[2].toFixed(3)},${c.radius.toFixed(3)}`;

export function sdfModule(): RenderModule {
  const disposers: (() => void)[] = [];
  return {
    name: 'sdf',
    install(s: EngineServices) {
      const { device, queue } = s.ctx;
      const cache = s.ctx.pipelines;
      const C = ShaderStage.COMPUTE;
      const format: GPUTextureFormat = device.features.has('texture-formats-tier1') ? 'r16float' : 'rgba16float';

      // ── Layouts and pipelines ──
      const uni = { binding: 0, visibility: C, buffer: { type: 'uniform' as const } };
      const rw = (binding: number) => ({ binding, visibility: C, buffer: { type: 'storage' as const } });
      const ro = (binding: number) => ({ binding, visibility: C, buffer: { type: 'read-only-storage' as const } });
      const clearLayout = device.createBindGroupLayout({ label: 'layout:sdf-rw2', entries: [uni, rw(1), rw(2)] });
      const seedLayout = device.createBindGroupLayout({ label: 'layout:sdf-seed', entries: [uni, rw(1), rw(2), rw(3), rw(4), rw(5)] });
      const gatherLayout = device.createBindGroupLayout({ label: 'layout:sdf-gather', entries: [uni, rw(1), ro(2), ro(3), ro(4), rw(5)] });
      const pageLayout = device.createBindGroupLayout({ label: 'layout:sdf-pages', entries: [ro(0), ro(1), ro(2), ro(3)] });
      const coarseLayout = device.createBindGroupLayout({ label: 'layout:sdf-ro-rw', entries: [uni, ro(1), rw(2)] });
      const resolveLayout = device.createBindGroupLayout({ label: 'layout:sdf-resolve', entries: [uni, ro(1), ro(2), ro(3),
        { binding: 4, visibility: C, storageTexture: { access: 'write-only', format, viewDimension: '3d' } }] });
      const keys = {
        clearHeads: 'sdf:clear-heads', clearParity: 'sdf:clear-parity', seed: 'sdf:seed', gather: 'sdf:gather', grow: 'sdf:grow', parity: 'sdf:parity',
        flood: 'sdf:flood', resolve: `sdf:resolve:${format}`,
      };
      const reg = (key: string, layouts: GPUBindGroupLayout[], code: ReturnType<typeof link>, entryPoint: string) => cache.register(key, 'compute', () => ({
        label: key, layout: device.createPipelineLayout({ bindGroupLayouts: layouts }), compute: { module: cache.shaderModule(code, key), entryPoint },
      }));
      reg(keys.clearHeads, [clearLayout], link(sdfClearWgsl), 'clear_heads');
      reg(keys.clearParity, [clearLayout], link(sdfClearWgsl), 'clear_parity');
      reg(keys.seed, [seedLayout, pageLayout], link(sdfSeedWgsl), 'seed');
      reg(keys.gather, [gatherLayout], link(sdfGatherWgsl), 'gather');
      const growLayout = device.createBindGroupLayout({ label: 'layout:sdf-grow', entries: [uni, rw(1), ro(2)] });
      reg(keys.grow, [growLayout], link(sdfGrowWgsl), 'grow');
      reg(keys.parity, [clearLayout], link(sdfParityWgsl), 'parity_prefix');
      reg(keys.flood, [coarseLayout], link(sdfFloodWgsl), 'flood');
      reg(keys.resolve, [resolveLayout], link(sdfResolveWgsl(format)), 'resolve');
      for (const key of Object.values(keys)) void cache.compile(key).catch(() => undefined);
      const sampleLayout = device.createBindGroupLayout({ label: 'layout:sdf-sample', entries: [
        { binding: 0, visibility: C, texture: { sampleType: 'float', viewDimension: '3d' } }, { binding: 1, visibility: C, buffer: { type: 'uniform' } },
        { binding: 2, visibility: C, sampler: { type: 'filtering' } },
        ro(3), rw(4)] });
      const sampleKey = 'sdf:sample';
      cache.register(sampleKey, 'compute', () => ({ label: sampleKey, layout: device.createPipelineLayout({ bindGroupLayouts: [sampleLayout] }),
        compute: { module: cache.shaderModule(link(sampleShader), sampleKey), entryPoint: 'main' } }));
      const linear = device.createSampler({ label: 'sdf:linear', magFilter: 'linear', minFilter: 'linear',
        addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge' });

      // ── Resources (sized by tier) ──
      const paramsBuffer = device.createBuffer({ label: 'sdf:params', size: 256, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      // [compacted triangles, links, open parity columns, overflow bits (1 links, 2 triangles)]
      const statsBuffer = device.createBuffer({ label: 'sdf:counters', size: 16, usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC | BufferUsage.COPY_DST });
      const statsReadback = device.createBuffer({ label: 'sdf:stats-readback', size: 16, usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST });
      let statsBusy = false;
      const buildParams: GPUBuffer[] = [];
      const buildParam = (i: number) => (buildParams[i] ??= device.createBuffer({ label: `sdf:build-params:${i}`, size: 64, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST }));
      let size = 0, voxel = 1, coarse = 1, words = 1;
      let volume: GPUTexture | null = null, volumeView: GPUTextureView | null = null;
      let band: GPUBuffer | null = null, parity: GPUBuffer | null = null;
      let seeds: GPUBuffer | null = null, floodA: GPUBuffer | null = null, floodB: GPUBuffer | null = null, heads: GPUBuffer | null = null;
      let tris: GPUBuffer | null = null, links: GPUBuffer | null = null, linksPerTriangle = LINKS_PER_TRIANGLE;
      // The build's pages concatenated, so one dispatch seeds them all (per-page dispatches serialize on UAV barriers).
      const merged: Record<'positions' | 'indices' | 'surface' | 'pages', GPUBuffer | null> = { positions: null, indices: null, surface: null, pages: null };
      const mergedBuffer = (key: keyof typeof merged, bytes: number) => {
        const need = Math.max(256, Math.ceil(bytes / 256) * 256);
        const current = merged[key];
        if (current && current.size >= need) return current;
        s.ctx.deferDestroy(current);
        return (merged[key] = device.createBuffer({ label: `sdf:merged-${key}`, size: Math.ceil(need * 1.25 / 256) * 256, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST }));
      };
      let built = false, completed = 0, builds = 0, lastRegionVoxels = 0, openColumns = 0, lastPages = 0;
      let lastTriangles = 0, lastLinks = 0, overflows = 0;
      /** Grow the compact triangle list and link pool to hold `triangles` (buffers only ever grow). */
      const ensureCapacity = (triangles: number) => {
        const needTris = Math.max(1024, triangles) * 48;
        if (!tris || tris.size < needTris) {
          s.ctx.deferDestroy(tris);
          tris = device.createBuffer({ label: 'sdf:triangles', size: Math.ceil(needTris * 1.25 / 16) * 16, usage: BufferUsage.STORAGE });
        }
        const needLinks = Math.max(1024, triangles) * linksPerTriangle * 8;
        if (!links || links.size < needLinks) {
          s.ctx.deferDestroy(links);
          links = device.createBuffer({ label: 'sdf:links', size: Math.ceil(needLinks * 1.25 / 16) * 16, usage: BufferUsage.STORAGE });
        }
      };
      let pending: Box | null = null;
      const allocate = (tier: QualityTier) => {
        const n = sdfSizeOverride() ?? SDF_TIER_SIZE[tier];
        if (n === size && volume) return;
        for (const r of [volume, band, parity, seeds, floodA, floodB, heads]) s.ctx.deferDestroy(r);
        size = n; voxel = (2 * SDF_HALF_EXTENT) / n; coarse = n / SDF_COARSE; words = n / 32;
        linksPerTriangle = Math.max(linksPerTriangle, linksForSize(n));
        volume = device.createTexture({ label: 'sdf:volume', size: [n, n, n], dimension: '3d', format, usage: TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING });
        volumeView = volume.createView({ dimension: '3d' });
        band = device.createBuffer({ label: 'sdf:band', size: n * n * n * 4, usage: BufferUsage.STORAGE });
        parity = device.createBuffer({ label: 'sdf:parity', size: n * n * words * 4, usage: BufferUsage.STORAGE });
        const cells = coarse * coarse * coarse * 4;
        seeds = device.createBuffer({ label: 'sdf:coarse-seeds', size: cells, usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC | BufferUsage.COPY_DST });
        floodA = device.createBuffer({ label: 'sdf:flood-a', size: cells, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST });
        floodB = device.createBuffer({ label: 'sdf:flood-b', size: cells, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST });
        heads = device.createBuffer({ label: 'sdf:cell-heads', size: cells, usage: BufferUsage.STORAGE });
        built = false;
        pending = full();
        s.bindings.provide('sdf', { volume: volumeView, params: { buffer: paramsBuffer } });
      };
      const full = (): Box => ({ lo: [0, 0, 0], hi: [size, size, size] });
      allocate(s.settings.tier);
      disposers.push(s.events.on('tierChanged', e => allocate(e.tier)));
      disposers.push(s.events.on('planetChanged', () => { pending = full(); }));
      disposers.push(s.events.on('terrainCommitted', e => {
        const grow = SDF_NEAR_DISTANCE + 2 * voxel;
        const toVoxel = (x: number, up: boolean) => Math.max(0, Math.min(size, up ? Math.ceil((x + SDF_HALF_EXTENT) / voxel) : Math.floor((x + SDF_HALF_EXTENT) / voxel)));
        const box: Box = {
          lo: [0, 1, 2].map(k => toVoxel(e.dirtyBounds.min[k] - grow, false)) as Box['lo'],
          hi: [0, 1, 2].map(k => toVoxel(e.dirtyBounds.max[k] + grow, true)) as Box['hi'],
        };
        if (!built) { pending = full(); return; }
        pending = pending ? { lo: [0, 1, 2].map(k => Math.min(pending!.lo[k], box.lo[k])) as Box['lo'], hi: [0, 1, 2].map(k => Math.max(pending!.hi[k], box.hi[k])) as Box['hi'] } : box;
      }));

      // ── Pending and held crater cuts → params (every frame) ──
      const held = new Map<string, HeldCut>();
      const paramsStaging = new ArrayBuffer(SDF_PARAMS.size);
      let frameIndex = 0;
      disposers.push(s.graph.addPass({
        name: 'sdf.params', slot: 'upload', order: 40, reads: [], writes: [],
        run(c) {
          frameIndex = c.frame.index;
          const current = s.scene.get('pendingCutList') ?? [];
          const live = new Set<string>();
          const cuts: number[] = [];
          for (const cut of current) {
            const key = cutKey(cut);
            live.add(key);
            held.set(key, { key, cut: [cut.center[0], cut.center[1], cut.center[2], cut.radius], since: -1, afterSerial: -1 });
            if (cuts.length < SDF_MAX_CUTS * 4) cuts.push(cut.center[0], cut.center[1], cut.center[2], cut.radius);
          }
          for (const h of [...held.values()]) {
            if (live.has(h.key)) continue;
            // Retired (committed or expired): keep carving it until a build newer than the retirement has completed.
            if (h.since < 0) { h.since = frameIndex; h.afterSerial = builds + 1; }
            const age = frameIndex - h.since;
            if (age >= HOLD_FRAMES[1] || (age >= HOLD_FRAMES[0] && completed >= h.afterSerial)) { held.delete(h.key); continue; }
            if (cuts.length < SDF_MAX_CUTS * 4) cuts.push(...h.cut);
          }
          SDF_PARAMS.pack({
            grid: [size, voxel, SDF_HALF_EXTENT, built ? 1 : 0],
            info: [1 / (2 * SDF_HALF_EXTENT), SDF_BAND_VOXELS * voxel, completed, cuts.length / 4],
            cuts: [...cuts, ...new Array(SDF_MAX_CUTS * 4 - cuts.length).fill(0)],
          }, paramsStaging);
          queue.writeBuffer(paramsBuffer, 0, paramsStaging);
        },
      }));

      // ── Build ──
      const writeParams = (i: number, lo: readonly number[], hi: readonly number[], misc: readonly number[]) => {
        const buf = new ArrayBuffer(64);
        new Float32Array(buf, 0, 4).set([size, voxel, SDF_HALF_EXTENT, SDF_BAND_VOXELS * voxel]);
        new Uint32Array(buf, 16, 4).set([lo[0], lo[1], lo[2], coarse]);
        new Uint32Array(buf, 32, 4).set([hi[0], hi[1], hi[2], words]);
        new Uint32Array(buf, 48, 4).set(misc);
        queue.writeBuffer(buildParam(i), 0, buf);
        return buildParam(i);
      };
      const ready = () => Object.values(keys).every(k => cache.get(k));
      const host = () => s.scene.get('terrainHost') as unknown as EngineTerrainHost | undefined;

      disposers.push(s.graph.addPass({
        name: 'sdf.build', slot: 'compute.commit', order: 0, reads: [], writes: [],
        enabled: () => pending !== null && ready() && !!host(),
        run(c) {
          const pages = host()!.table.visible('static').filter(p => p.buffers.indexCount >= 3);
          if (!pages.length) return;
          const region = pending!;
          pending = null;
          builds++;
          const lo = region.lo, hi = region.hi;
          const ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
          if (ext.some(e => e <= 0)) { completed = builds; return; }
          lastRegionVoxels = ext[0] * ext[1] * ext[2];
          const pipe = (k: string) => cache.get<GPUComputePipeline>(k)!;
          const pBand = writeParams(0, lo, hi, [0, SDF_COARSE, 0, 1]);
          const rw2 = (p: GPUBuffer, a: GPUBuffer, b: GPUBuffer) => device.createBindGroup({ layout: clearLayout, entries: [
            { binding: 0, resource: { buffer: p } }, { binding: 1, resource: { buffer: a } }, { binding: 2, resource: { buffer: b } }] });
          const ro1rw2 = (p: GPUBuffer, a: GPUBuffer, b: GPUBuffer) => device.createBindGroup({ layout: coarseLayout, entries: [
            { binding: 0, resource: { buffer: p } }, { binding: 1, resource: { buffer: a } }, { binding: 2, resource: { buffer: b } }] });
          // World boxes: the band region (grown by the band) and the parity footprint (full height).
          const bw = SDF_BAND_VOXELS * voxel;
          const wlo = lo.map(i => i * voxel - SDF_HALF_EXTENT - bw), whi = hi.map(i => i * voxel - SDF_HALF_EXTENT + bw);
          const overlaps = (ctr: Vec3, r: number, dims: number) => {
            for (let k = 0; k < dims; k++) if (ctr[k] + r < wlo[k] || ctr[k] - r > whi[k]) return false;
            return true;
          };
          // Band pages (near the region) and parity pages (anywhere over its footprint, full height).
          const seedPages: { page: (typeof pages)[number]; flags: number; triangles: number }[] = [];
          let bandTriangles = 0;
          for (const page of pages) {
            const sphere = page.worldSphere;
            const flags = (overlaps(sphere.center, sphere.radius, 3) ? 1 : 0) | (overlaps(sphere.center, sphere.radius, 2) ? 2 : 0);
            if (!flags) continue;
            const triangles = Math.floor(page.buffers.indexCount / 3);
            seedPages.push({ page, flags, triangles });
            if (flags & 1) bandTriangles += triangles;
          }
          ensureCapacity(bandTriangles);
          lastPages = seedPages.length;
          let totalTriangles = 0, totalVertices = 0;
          for (const e of seedPages) { totalTriangles += e.triangles; totalVertices += e.page.buffers.vertexCount; }
          const positionsBuf = mergedBuffer('positions', totalVertices * 12), indicesBuf = mergedBuffer('indices', totalTriangles * 12);
          const surfaceBuf = mergedBuffer('surface', totalVertices * 32), pagesBuf = mergedBuffer('pages', Math.max(1, seedPages.length) * 16);
          const table = new Uint32Array(Math.max(1, seedPages.length) * 4);
          let firstTriangle = 0, firstVertex = 0;
          seedPages.forEach(({ page, flags, triangles }, i) => {
            const b = page.buffers;
            table.set([firstTriangle, firstVertex, flags, triangles], i * 4);
            if (b.vertexCount > 0) {
              c.encoder.copyBufferToBuffer(b.position, 0, positionsBuf, firstVertex * 12, b.vertexCount * 12);
              c.encoder.copyBufferToBuffer(b.surface, 0, surfaceBuf, firstVertex * 32, b.vertexCount * 32);
            }
            if (triangles > 0) c.encoder.copyBufferToBuffer(b.index, 0, indicesBuf, firstTriangle * 12, triangles * 12);
            firstTriangle += triangles; firstVertex += b.vertexCount;
          });
          queue.writeBuffer(pagesBuf, 0, table);
          c.encoder.clearBuffer(statsBuffer);
          const stage = (name: string) => { const ts = c.timestampWrites(name) as GPUComputePassTimestampWrites | undefined; return c.encoder.beginComputePass({ label: name, ...(ts ? { timestampWrites: ts } : {}) }); };
          let pass = stage('sdf.clear');
          const clo = lo.map(i => Math.floor(i / SDF_COARSE)), chi = hi.map(i => Math.ceil(i / SDF_COARSE));
          pass.setPipeline(pipe(keys.clearHeads));
          pass.setBindGroup(0, rw2(pBand, heads!, parity!));
          pass.dispatchWorkgroups(Math.ceil((chi[0] - clo[0]) / 4), Math.ceil((chi[1] - clo[1]) / 4), Math.ceil((chi[2] - clo[2]) / 4));
          pass.setPipeline(pipe(keys.clearParity));
          pass.dispatchWorkgroups(Math.ceil(ext[0] / 8), Math.ceil(ext[1] / 8), words);
          pass.end();
          pass = stage('sdf.seed');
          pass.setPipeline(pipe(keys.seed));
          const seedGroup = (p: GPUBuffer) => device.createBindGroup({ layout: seedLayout, entries: [
            { binding: 0, resource: { buffer: p } }, { binding: 1, resource: { buffer: parity! } }, { binding: 2, resource: { buffer: tris! } },
            { binding: 3, resource: { buffer: links! } }, { binding: 4, resource: { buffer: heads! } }, { binding: 5, resource: { buffer: statsBuffer } }] });
          pass.setBindGroup(0, seedGroup(pBand));
          pass.setBindGroup(1, device.createBindGroup({ label: 'sdf:merged-pages', layout: pageLayout, entries: [
            { binding: 0, resource: { buffer: merged.positions! } }, { binding: 1, resource: { buffer: merged.indices! } },
            { binding: 2, resource: { buffer: merged.surface! } }, { binding: 3, resource: { buffer: merged.pages!, size: Math.max(1, seedPages.length) * 16 } }] }));
          const workgroups = Math.ceil(totalTriangles / 64);
          if (workgroups > 0) pass.dispatchWorkgroups(Math.min(workgroups, 65535), Math.ceil(workgroups / 65535));
          pass.end();
          pass = stage('sdf.gather');
          pass.setPipeline(pipe(keys.gather));
          pass.setBindGroup(0, device.createBindGroup({ layout: gatherLayout, entries: [
            { binding: 0, resource: { buffer: pBand } }, { binding: 1, resource: { buffer: band! } }, { binding: 2, resource: { buffer: tris! } },
            { binding: 3, resource: { buffer: links! } }, { binding: 4, resource: { buffer: heads! } }, { binding: 5, resource: { buffer: seeds! } }] }));
          pass.dispatchWorkgroups(chi[0] - clo[0], chi[1] - clo[1], chi[2] - clo[2]);
          pass.end();
          // The coarse flood (far field) runs first: the grow uses it to skip voxels far from the surface. It always
          // restarts from the raw seeds over the whole coarse grid.
          c.encoder.copyBufferToBuffer(seeds!, 0, floodA!, 0, seeds!.size);
          pass = stage('sdf.flood');
          pass.setPipeline(pipe(keys.flood));
          let src = floodA!, dst = floodB!;
          const steps: number[] = [];
          for (let k = 1 << Math.floor(Math.log2(Math.max(1, coarse - 1))); k >= 1; k >>= 1) steps.push(k);
          steps.push(1);
          steps.forEach((step, i) => {
            pass.setBindGroup(0, ro1rw2(writeParams(3 + i, lo, hi, [step, SDF_COARSE, 0, 0]), src, dst));
            pass.dispatchWorkgroups(Math.ceil(coarse / 4), Math.ceil(coarse / 4), Math.ceil(coarse / 4));
            [src, dst] = [dst, src];
          });
          pass.end();
          pass = stage('sdf.grow');
          pass.setPipeline(pipe(keys.grow));
          pass.setBindGroup(0, device.createBindGroup({ layout: growLayout, entries: [
            { binding: 0, resource: { buffer: pBand } }, { binding: 1, resource: { buffer: band! } }, { binding: 2, resource: { buffer: src } }] }));
          const growPasses = Math.ceil((SDF_NEAR_DISTANCE - SDF_BAND_VOXELS * voxel) / voxel) + 1;
          for (let k = 0; k < growPasses; k++) pass.dispatchWorkgroups(Math.ceil(ext[0] / 4), Math.ceil(ext[1] / 4), Math.ceil(ext[2] / 4));
          pass.end();
          pass = stage('sdf.parity');
          pass.setPipeline(pipe(keys.parity));
          pass.setBindGroup(0, rw2(pBand, parity!, statsBuffer));
          pass.dispatchWorkgroups(Math.ceil(ext[0] / 8), Math.ceil(ext[1] / 8), 1);
          pass.end();
          pass = stage('sdf.resolve');
          pass.setPipeline(pipe(keys.resolve));
          pass.setBindGroup(0, device.createBindGroup({ layout: resolveLayout, entries: [
            { binding: 0, resource: { buffer: pBand } }, { binding: 1, resource: { buffer: band! } }, { binding: 2, resource: { buffer: parity! } },
            { binding: 3, resource: { buffer: src } }, { binding: 4, resource: volumeView! }] }));
          pass.dispatchWorkgroups(Math.ceil(ext[0] / 4), Math.ceil(ext[1] / 4), Math.ceil(ext[2] / 4));
          pass.end();
          built = true;
          completed = builds;
          s.telemetry.gauge('sdfBuilds', builds);
          s.telemetry.gauge('sdfRegionVoxels', lastRegionVoxels);
          if (!statsBusy) {
            statsBusy = true;
            c.encoder.copyBufferToBuffer(statsBuffer, 0, statsReadback, 0, 16);
            setTimeout(() => {
              void queue.onSubmittedWorkDone().then(() => statsReadback.mapAsync(MapMode.READ)).then(() => {
                const [triangles, linkCount, open, overflow] = new Uint32Array(statsReadback.getMappedRange().slice(0));
                statsReadback.unmap();
                lastTriangles = triangles; lastLinks = linkCount; openColumns = open;
                s.telemetry.gauge('sdfOpenColumns', openColumns);
                s.telemetry.gauge('sdfTriangles', triangles);
                s.telemetry.gauge('sdfLinks', linkCount);
                if (openColumns) console.warn(`[sdf] ${openColumns} open parity columns (the terrain mesh is not closed there)`);
                if (overflow) {
                  // Some triangle-cell links were dropped: grow the pool and redo the region.
                  overflows++;
                  linksPerTriangle = Math.max(linksPerTriangle * 2, Math.ceil(linkCount / Math.max(1, triangles)) + 4);
                  pending = pending ? { lo: [0, 1, 2].map(k => Math.min(pending!.lo[k], region.lo[k])) as Box['lo'], hi: [0, 1, 2].map(k => Math.max(pending!.hi[k], region.hi[k])) as Box['hi'] } : region;
                  console.warn(`[sdf] link pool overflow (${linkCount} links for ${triangles} triangles): rebuilding with ${linksPerTriangle} per triangle`);
                }
              }).catch(() => undefined).finally(() => { statsBusy = false; });
            }, 0);
          }
        },
      }));

      type SampleJob = { data: Float32Array; count: number; resolve: (v: number[]) => void; reject: (e: unknown) => void };
      const sampleJobs: SampleJob[] = [];
      disposers.push(s.graph.addPass({
        name: 'sdf.sample', slot: 'debug', order: 6, reads: [], writes: [],
        enabled: () => sampleJobs.length > 0 && built,
        run(c) {
          const pipe = cache.get<GPUComputePipeline>(sampleKey) ?? null;
          if (!pipe) { void cache.compile(sampleKey).catch(() => undefined); return; }
          const job = sampleJobs.shift()!;
          const input = device.createBuffer({ label: 'sdf:sample-in', size: Math.max(16, job.data.byteLength), usage: BufferUsage.STORAGE | BufferUsage.COPY_DST });
          const output = device.createBuffer({ label: 'sdf:sample-out', size: Math.max(4, job.count * 4), usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC });
          const readback = device.createBuffer({ label: 'sdf:sample-readback', size: Math.max(4, job.count * 4), usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST });
          queue.writeBuffer(input, 0, job.data.buffer, job.data.byteOffset, job.data.byteLength);
          const pass = c.encoder.beginComputePass({ label: 'sdf.sample' });
          pass.setPipeline(pipe);
          pass.setBindGroup(0, device.createBindGroup({ layout: sampleLayout, entries: [
            { binding: 0, resource: volumeView! }, { binding: 1, resource: { buffer: paramsBuffer } }, { binding: 2, resource: linear },
            { binding: 3, resource: { buffer: input } }, { binding: 4, resource: { buffer: output } }] }));
          pass.dispatchWorkgroups(Math.ceil(job.count / 64));
          pass.end();
          c.encoder.copyBufferToBuffer(output, 0, readback, 0, job.count * 4);
          setTimeout(() => {
            void queue.onSubmittedWorkDone().then(() => readback.mapAsync(MapMode.READ)).then(() => {
              job.resolve([...new Float32Array(readback.getMappedRange().slice(0))].slice(0, job.count));
              readback.unmap();
            }).catch(job.reject).finally(() => { for (const b of [input, output, readback]) s.ctx.deferDestroy(b); });
          }, 0);
        },
      }));

      const facet: SdfFacet = {
        get valid() { return built; },
        get size() { return size; },
        get voxel() { return voxel; },
        half: SDF_HALF_EXTENT,
        get volumeView() { return volumeView!; },
        paramsBuffer,
        get band() { return band!; },
        get serial() { return completed; },
        stats: () => ({ builds, lastRegionVoxels, openColumns, pages: lastPages, size, format, triangles: lastTriangles, links: lastLinks, overflows }),
        rebuild() { pending = full(); },
        rebuildBox(min, max) { s.events.emit('terrainCommitted', { dirtyBounds: { min: [min[0], min[1], min[2]], max: [max[0], max[1], max[2]] }, epoch: -1 }); },
        sample(points) {
          return new Promise((resolve, reject) => {
            const data = new Float32Array(Math.max(1, points.length) * 4);
            points.forEach((p, i) => data.set([p[0], p[1], p[2], 0], i * 4));
            sampleJobs.push({ data, count: points.length, resolve, reject });
          });
        },
      };
      s.scene.provide('sdf', facet);
      disposers.push(() => {
        for (const r of [volume, band, parity, seeds, floodA, floodB, heads, tris, links, paramsBuffer, statsBuffer, statsReadback, ...buildParams, ...Object.values(merged)]) s.ctx.deferDestroy(r);
      });
    },
    dispose() { for (const d of disposers.splice(0).reverse()) d(); },
  };
}
