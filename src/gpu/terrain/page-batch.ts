/** Transaction page staging, free of shader imports (Node benches and tests load it; gpu-pages.ts is browser-only). */
import type { ResidentArrangement } from './arrangement';
import type { OccupiedRegion, SliceMetrics } from './contracts';
import type { PageDrawHandle, PageDrawInfo, TerrainRenderHost } from './render-host';
import type { PageAttachment } from './page-hooks';
import type { BoundaryFace } from '../../game/terrain-connectivity';
import type { Bounds } from '../../core/types';

/** A staged page: invisible until the caller's host.commit; hook attachments show and hide with it. */
export interface GpuPage { handle: PageDrawHandle; bytes: number; attachments?: readonly PageAttachment[]; dispose(): void }
/** Which page is being emitted: a static brick (origin at the planet centre) or a detached body. */
export type PageTarget = Pick<PageDrawInfo, 'brick' | 'bodyId' | 'origin'>;
/** One transaction's GPU work: construct() then page()s are encoded into ONE command encoder; submit() issues ONE
 * queue submission and ONE mapAsync of a combined status buffer (volume descriptors, every page's count/scan status
 * and every page hook's status words), validates everything, then creates the host pages (plan §10.4, I8). */
export interface ResidentPageBatch {
  construct(arrangement: ResidentArrangement, regions: readonly OccupiedRegion[]): void;
  page(key: string, boundary: readonly BoundaryFace[], target: PageTarget, arrangement: ResidentArrangement): void;
  submit(): Promise<Map<string, GpuPage>>;
  cancel(): void;
}
/** Numeric coordinator boundary. Returned views may alias resident WASM scratch and are consumed immediately. */
export interface PackedResidentConstruction {
  vertexCount: number;
  recipes(from: number): Uint32Array<ArrayBuffer>;
  volumes(): { descriptors: Uint32Array<ArrayBuffer>; triangles: Uint32Array<ArrayBuffer>; volumes: Float64Array<ArrayBuffer> };
}
export interface PackedResidentPageBatch {
  constructPacked(input: PackedResidentConstruction): void;
  pagePacked(key: string, input: { triangles: Uint32Array<ArrayBuffer>; references: Uint32Array<ArrayBuffer> }, target: PageTarget, bounds: Bounds): void;
  submit(): Promise<Map<string, GpuPage>>;
  cancel(): void;
}
/** What ResidentTerrain needs from its page producer (ResidentGpuPages; the tests' GeometryGate implements the
 * per-call subset and gets the batch semantics from `pageBatch`). */
export interface ResidentPageBackend {
  constructRegions(arrangement: ResidentArrangement, regions: readonly OccupiedRegion[], metrics: SliceMetrics): Promise<void>;
  page(boundary: readonly BoundaryFace[], target: PageTarget, arrangement: ResidentArrangement, metrics: SliceMetrics, host: TerrainRenderHost): Promise<GpuPage | undefined>;
  invalidateUpload(vertexCount: number): void;
  dispose(): void;
  batch?(host: TerrainRenderHost, metrics: SliceMetrics): ResidentPageBatch;
  /** Compaction: surviving vertex i takes position oldIds[i] (GPU gather; no recipe re-upload). */
  gather?(oldIds: Int32Array): void;
}
/** The backend's batch, or per-call emulation with the same all-or-nothing staging (no GPU claim). */
export function pageBatch(gpu: ResidentPageBackend, host: TerrainRenderHost, metrics: SliceMetrics): ResidentPageBatch {
  if (gpu.batch) return gpu.batch(host, metrics);
  const constructs: [ResidentArrangement, readonly OccupiedRegion[]][] = [], pages: [string, readonly BoundaryFace[], PageTarget, ResidentArrangement][] = [];
  return {
    construct: (arrangement, regions) => { constructs.push([arrangement, regions]); },
    page: (key, boundary, target, arrangement) => { pages.push([key, boundary, target, arrangement]); },
    submit: async () => {
      for (const [arrangement, regions] of constructs) await gpu.constructRegions(arrangement, regions, metrics);
      const results = await Promise.allSettled(pages.map(([, boundary, target, arrangement]) => gpu.page(boundary, target, arrangement, metrics, host)));
      const out = new Map<string, GpuPage>();
      results.forEach((result, i) => { if (result.status === 'fulfilled' && result.value) out.set(pages[i][0], result.value); });
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') { out.forEach(page => page.dispose()); throw failure.reason; }
      return out;
    },
    cancel: () => {},
  };
}
