// @contract v1 — docs/architecture.md#contracts-and-invariants
/// <reference types="@webgpu/types" />
// page-hooks.ts — extension point inside ResidentGpuPages.page() (plumbing by W1-TER, first user W2-VEG)
import type { PageBuffers, PageDrawInfo } from './render-host';
export interface PageHookContext { encoder: GPUCommandEncoder; buffers: PageBuffers; info: PageDrawInfo; triangleCount: number; isBody: boolean;
  status: { buffer: GPUBuffer; offset: number; words: number } /* piggybacks on the page's single status readback */ }
export interface PageAttachment { onShow(): void; onHide(): void; dispose(): void }
export interface PageHook { readonly name: string; readonly statusWords: number;
  encode(ctx: PageHookContext): { finish(status: Uint32Array): PageAttachment | undefined } | undefined }
