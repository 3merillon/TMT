/// <reference types="@webgpu/types" />
/** Headless stand-ins for resident terrain transactions (plan §5.1). They make no GPU qualification claim:
 * GeometryGate replaces ResidentGpuPages (no device work) and FakeTerrainHost records draw membership.
 * Used by the resident tests, tests/terrain-render-host and scripts/profile-resident-game. */
import type { ResidentArrangement } from '../../src/gpu/terrain/arrangement';
import { ResidentFailure, type SliceMetrics } from '../../src/gpu/terrain/contracts';
import type { GpuPage, PageTarget, ResidentGpuPages } from '../../src/gpu/terrain/gpu-pages';
import type { PageHook } from '../../src/gpu/terrain/page-hooks';
import type { PageBuffers, PageDrawHandle, PageDrawInfo, TerrainRenderHost } from '../../src/gpu/terrain/render-host';
import type { BoundaryFace } from '../../src/game/terrain-connectivity';
import type { Vec3 } from '../../src/core/types';

export interface FakePage {
  readonly id: number; readonly info: PageDrawInfo; readonly buffers: PageBuffers;
  visible: boolean; disposed: boolean; pose?: { position: Vec3; rotation: [number, number, number, number] };
}
export interface FakeCommit { readonly show: readonly number[]; readonly hide: readonly number[] }

/** Records every page and commit. commit() validates like a real host: unknown, disposed, duplicated,
 * already-visible or already-hidden pages throw before anything changes. */
export class FakeTerrainHost implements TerrainRenderHost {
  readonly device = { label: 'fake terrain host device' } as unknown as GPUDevice;
  readonly pageHooks: readonly PageHook[] = [];
  readonly pages = new Map<number, FakePage>();
  readonly commits: FakeCommit[] = [];
  /** Pages disposed while still drawn: a hole published without a replacement. */
  disposedWhileVisible = 0;
  private nextId = 1;
  get visible(): number[] { return [...this.pages.values()].filter(page => page.visible).map(page => page.id); }
  createPage(buffers: PageBuffers, info: PageDrawInfo): PageDrawHandle {
    const page: FakePage = { id: this.nextId++, info, buffers, visible: false, disposed: false };
    this.pages.set(page.id, page);
    return {
      id: page.id,
      setPose: (position, rotation) => { if (page.disposed) throw new Error(`Fake page ${page.id} is disposed`); page.pose = { position: [...position], rotation: [...rotation] }; },
      dispose: () => { if (page.disposed) return; if (page.visible) this.disposedWhileVisible++; page.disposed = true; page.visible = false; },
    };
  }
  commit(change: { show: readonly PageDrawHandle[]; hide: readonly PageDrawHandle[] }): void {
    const page = (handle: PageDrawHandle) => {
      const found = this.pages.get(handle.id);
      if (!found || found.disposed) throw new Error(`Fake page ${handle.id} is unknown or disposed`);
      return found;
    };
    const show = change.show.map(page), hide = change.hide.map(page);
    if (new Set([...show, ...hide]).size !== show.length + hide.length) throw new Error('A terrain commit lists a page twice');
    if (hide.some(p => !p.visible)) throw new Error('A terrain commit hides a page that is not visible');
    if (show.some(p => p.visible)) throw new Error('A terrain commit shows a page that is already visible');
    hide.forEach(p => { p.visible = false; });
    show.forEach(p => { p.visible = true; });
    this.commits.push({ show: show.map(p => p.id), hide: hide.map(p => p.id) });
  }
}

/** ResidentGpuPages stand-in: no device work; every page goes through the terrain host it is given. */
export class GeometryGate {
  /** constructRegions refuses with a capacity failure while set. */
  fail = false;
  /** page() call number (1-based, counted over the gate's lifetime) that throws after its handle exists. */
  failPage?: number;
  /** Awaited at the start of constructRegions. */
  gate?: () => Promise<void>;
  /** Awaited inside page() after the draw handle exists, before the page is returned. */
  pageGate?: (handle: PageDrawHandle) => Promise<void>;
  /** Pages created and not yet disposed. */
  live = 0;
  pageCalls = 0;
  /** This stand-in typed as the real class, for the ResidentTerrain constructor. */
  get pages(): ResidentGpuPages { return this as unknown as ResidentGpuPages; }
  async constructRegions(): Promise<void> { await this.gate?.(); if (this.fail) throw new ResidentFailure('capacity', 'Injected resident capacity refusal'); }
  async page(boundary: readonly BoundaryFace[], target: PageTarget, _arrangement: ResidentArrangement, _metrics: SliceMetrics, host: TerrainRenderHost): Promise<GpuPage> {
    const call = ++this.pageCalls, triangles = boundary.reduce((sum, { face }) => sum + Math.max(0, face.vertices.length - 2), 0);
    const buffer = { label: 'fake page buffer' } as unknown as GPUBuffer;
    const handle = host.createPage({ position: buffer, normal: buffer, surface: buffer, index: buffer, indirect: buffer, vertexCount: triangles * 3, indexCount: triangles * 3 },
      { ...target, bounds: { min: [...target.origin], max: [...target.origin] } });
    this.live++;
    let live = true;
    const page: GpuPage = { handle, bytes: 1, dispose: () => { if (!live) return; live = false; this.live--; handle.dispose(); } };
    try {
      await this.pageGate?.(handle);
      if (call === this.failPage) throw new ResidentFailure('validation', 'Injected resident page refusal');
    } catch (error) { page.dispose(); throw error; }
    return page;
  }
  invalidateUpload(): void {}
  dispose(): void {}
}
