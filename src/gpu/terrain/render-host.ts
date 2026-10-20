// @contract v1 — docs/architecture.md#contracts-and-invariants
/// <reference types="@webgpu/types" />
// render-host.ts — the only way resident terrain reaches a renderer. No three imports anywhere in src/gpu/terrain after W0.
import type { Bounds, Vec3 } from '../../core/types';
import type { PageHook } from './page-hooks';
export interface PageBuffers {
  position: GPUBuffer;   // f32x3 per vertex, relative to info.origin
  normal: GPUBuffer;     // f32x3 flat normal
  surface: GPUBuffer;    // f32x8 per vertex: [material, source.x, source.y, source.z, source.w (kind: 0 plane | 1 planet | 2 sphere), r, g, b (diagnostic)]
  index: GPUBuffer;      // u32, page-local
  indirect: GPUBuffer;   // [indexCount, 1, 0, 0, 0]; kept for ThreeTerrainHost, engine draws direct
  vertexCount: number;
  indexCount: number;
}
export interface PageDrawInfo { brick?: string; bodyId?: number; origin: Vec3; bounds: Bounds /* static: this brick's world AABB (not the lattice); body: body-local AABB */ }
export interface PageDrawHandle { readonly id: number; setPose(position: Vec3, rotation: [number, number, number, number]): void; dispose(): void /* host defers GPU destroy ≥ 3 frames */ }
export interface TerrainRenderHost {
  readonly device: GPUDevice;
  createPage(buffers: PageBuffers, info: PageDrawInfo): PageDrawHandle;                       // invisible until commit
  commit(change: { show: readonly PageDrawHandle[]; hide: readonly PageDrawHandle[]; dirty?: Bounds }): void;  // atomic; same JS block as the physics commit (I4)
  // dirty (optional): a world AABB holding every static triangle the change adds or removes; default: the pages' bounds
  readonly pageHooks: readonly PageHook[];                                                    // [] until W2-VEG registers one
}
