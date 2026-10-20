import type { Bounds, Vec3 } from '../../core/types';

/** Length: world units; time: seconds; mass: kg at density 1 kg/unit³.
 * This is a new profile, never a replacement for the binary64 save/oracle path. */
export const RESIDENT_PROFILE = 'resident-f32-v1' as const;
export const CELL_SIDE = 3;
export const BRICK_SIDE = 6;
export type RegionId = string;
export type Owner = { kind: 'static' } | { kind: 'body'; id: number };
export interface Ticket { readonly epoch: number; readonly serial: number; readonly signal?: AbortSignal }
export type FailureCode = 'capacity' | 'validation' | 'cancelled' | 'stale' | 'device';
export class ResidentFailure extends Error {
  constructor(readonly code: FailureCode, message: string) { super(message); this.name = 'ResidentFailure'; }
}
/** Accepted immutable source constraints, never regenerated from render triangles. */
export interface SourceBox {
  readonly id: string; readonly bounds: Bounds; readonly material: number; readonly anchor?: string;
  /** Intersection of prepared scalar fields. Omission retains the six box planes. */
  readonly fields?: readonly SampleField[];
}
/** A material crater's cutter (rust-engine-v22): the sphere that removes source materials in `materials` (bit 1<<id). */
export interface CutShell { readonly materials: number; readonly center: Vec3; readonly radius: number }
/** `center`/`radius` bound the whole cut. With `shells` (v22 material craters, src/game/rules/material-craters.ts)
 * only the shells cut, each its own materials; `materials` marks one such shell as an arrangement cutter. */
export interface SphereCut { readonly id: string; readonly center: Vec3; readonly radius: number; readonly repeat?: 'impact'; readonly shells?: readonly CutShell[]; readonly materials?: number }
/** Whether a cutter with material mask `mask` (absent: every material) removes source material `material`. */
export function removesMaterial(mask: number | undefined, material: number): boolean { return mask === undefined || (material >= 0 && material < 32 && ((mask >>> material) & 1) === 1); }
/** The arrangement cutters of a cut: itself, or one material cutter per shell (ids `${id}#${mask in hex}`). */
export function cutShells(cut: SphereCut): SphereCut[] {
  return cut.shells ? cut.shells.map(s => ({ id: `${cut.id}#${s.materials.toString(16)}`, center: s.center, radius: s.radius, materials: s.materials, ...(cut.repeat ? { repeat: cut.repeat } : {}) })) : [cut];
}
/** Exact equality of two cuts' geometry, shells included. */
export function sameCutShape(a: SphereCut, b: SphereCut): boolean {
  const same = (x: { center: readonly number[]; radius: number }, y: { center: readonly number[]; radius: number }) => x.radius === y.radius && x.center.every((v, i) => v === y.center[i]);
  if (!same(a, b) || a.materials !== b.materials || !a.shells !== !b.shells) return false;
  return !a.shells || (a.shells.length === b.shells!.length && a.shells.every((s, i) => s.materials === b.shells![i].materials && same(s, b.shells![i])));
}
/** Validates a cut's shells (count, masks, finite geometry inside the bounding sphere); undefined is valid. */
export function validCutShells(cut: { center: readonly number[]; radius: number; shells?: readonly CutShell[] }): boolean {
  const shells = cut.shells; if (shells === undefined) return true;
  if (!Array.isArray(shells) || shells.length < 1 || shells.length > 8) return false;
  let seen = 0;
  for (const s of shells) {
    if (!s || !Number.isInteger(s.materials) || s.materials <= 0 || s.materials > 0xffffffff || (seen & s.materials) !== 0) return false; seen = (seen | s.materials) >>> 0;
    if (!Array.isArray(s.center) || s.center.length !== 3 || !s.center.every(Number.isFinite) || !(s.radius > 0) || !Number.isFinite(s.radius)) return false;
    if (Math.hypot(s.center[0] - cut.center[0], s.center[1] - cut.center[1], s.center[2] - cut.center[2]) + s.radius > cut.radius * (1 + 1e-9)) return false;
  }
  return true;
}
export interface SampleField {
  readonly id: string; readonly sample: (p: Vec3) => number;
  /** Analytic shading only; coordinates stay in the immutable source frame. */
  readonly surface?: { readonly kind: 'planet' } | { readonly kind: 'sphere'; readonly center: Vec3 };
  /** Finite support: sample(p) > 0 strictly for every p outside this closed box. The lattice samples the field
   * exactly within the box plus one cell diagonal and stores a positive placeholder elsewhere; no tet that the
   * field can cross ever reads a placeholder, so the compiled topology is unchanged. */
  readonly support?: Bounds;
  /** A material cutter removes (and recuts) only sources whose material bit (1<<id) is set; absent: every material. */
  readonly materials?: number;
}
export interface VertexRecipe {
  readonly id: number; readonly key: string; readonly level: number;
  readonly position: Vec3; // CPU f32 reconstruction for collider descriptors and topology qualification.
  readonly weights: ReadonlyMap<number, number>; // Original lattice barycentrics, not rounded mesh density.
  readonly base?: Vec3;
  readonly edge?: readonly [number, number];
  readonly values?: readonly [number, number];
  /** Game profile: reconstruct directly from original tet samples in cell-local coordinates. */
  readonly basis?: readonly number[];
  readonly barycentric?: readonly number[];
}
export interface RegionFace { readonly vertices: readonly number[]; readonly source: string }
export interface OccupiedRegion {
  readonly id: RegionId; readonly tet: string; readonly brick: string;
  readonly material: number; readonly source: string; readonly anchor?: string;
  readonly faces: readonly RegionFace[]; readonly volume: number;
  /** Uncollapsed source recipes retained for later cuts; physical faces identify
   * vertices with exactly identical f32 words (no distance-based welding). */
  readonly sourceFaces?: readonly RegionFace[];
  readonly constraints: readonly number[]; // Signed crossing-field index + 1; constant tet signs are implicit.
}
export interface FacePortal {
  readonly key: string; readonly a: RegionId; readonly b: RegionId;
  readonly area: number; readonly crossBrick: boolean;
}
export interface RegionPage {
  readonly brick: string; readonly regions: readonly OccupiedRegion[]; readonly revision: number; readonly removedVolume: number;
  /** Removed volume per tet in brick order (removedVolume is their sum in that order): the per-tet output
   * cache that lets a dirty brick recompile only its dirty tets (regions are grouped by region.tet). */
  readonly tetRemoved?: Float64Array;
}
/** A compiler result: with `tets` (local indices, ascending) it covers only those tets of the brick and
 * `tetRemoved` is aligned with `tets`; the caller assembles it with the previous page's clean tets. */
export interface CompiledRegionPage extends RegionPage { readonly tets?: readonly number[] }
export interface ColliderDescription { readonly regionIds: readonly RegionId[]; readonly vertices: Float32Array; readonly indices: Uint32Array; readonly volume: number; readonly kind?: 'trimesh'; readonly offset?: Vec3 }
export interface BodyCandidate {
  readonly id: number; readonly regions: readonly OccupiedRegion[]; readonly center: Vec3; readonly colliders: readonly ColliderDescription[];
  /** Numeric resident bodies retain geometry in WASM; diagnostics use this count. */
  readonly regionCount?: number;
  /** Source-space center stays immutable; recut children inherit a moving parent's world pose/momentum. */
  readonly pose?: { position: Vec3; rotation: [number, number, number, number]; parent: number };
}
export interface VolumeLedger { before: number; anchored: number; detached: number; removed: number; error: number }
/** Completed work, never a guessed wall-time percentage. Terrain is playable only after `commit`. */
export interface TerrainPreparationProgress { stage: string; completed?: number; total?: number }
export interface CompilerMetrics {
  backend?: 'rust-wasm' | 'typescript';
  workerMs: number[]; packetBytes: number; mergeMs: number; cacheHits: number; workers?: number; logicalShards?: number; longestSliceMs?: number;
  /** Per worker wall-time breakdown, including cache waits; does not represent parallel critical-path sums. */
  workerStages?: Record<string, number>[];
}
export interface SliceMetrics {
  compiler?: CompilerMetrics;
  dirtyBricks: number; cleanBricks: number; regions: number; activePlanes: number;
  contractedNodes: number; graphBytes: number; graphMs: number; topologyMs: number;
  colliderMs: number; colliderDescriptorBytes: number; solverMs: number; fallbackCount: number; uploadBytes: number;
  descriptorReadbackBytes: number; submissions: number; gpuMs: number | null;
  peakGpuBytes: number; enqueueToCommitMs: number; firstFallMs: number | null;
  /** Tets recompiled (tet-granular) and wall time per edit stage (bench-terrain, ?residentCheck). */
  dirtyTets?: number; stageMs?: Record<string, number>;
  /** Enqueue until the transaction was fully prepared (ready to commit); commit may wait for its tick. */
  enqueueToReadyMs?: number;
  /** GPU readbacks (mapAsync) awaited by this transaction, and compactions run inside it (always 0). */
  readbacks?: number; compactions?: number;
  /** Longest synchronous main-thread stretch of the prepare (between yields/awaits), and of the commit block. */
  longestSliceMs?: number; longestSliceAt?: string;
  /** performance.now() when each stage began (browser diagnostics: correlate long frames with stages). */
  stageAt?: Record<string, number>;
  /** Worst animation frame from the request until two frames after the commit (browser diagnostics). */
  worstFrameMs?: number;
  /** Frames the prepare awaited that did not come within the pacer's stall bound (main thread idle, GPU busy). */
  frameStalls?: number;
}
