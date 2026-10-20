// @contract v1 — docs/architecture.md#contracts-and-invariants
/// <reference types="@webgpu/types" />
/**
 * Engine contract (plan §5.4). The block between the "§5.4 verbatim" markers is the plan text, unchanged.
 * Everything after it defines the types §5.4 names but does not spell out (GpuContext, FrameGraphApi,
 * WgslLibrary, MeshDesc, ...) plus a few additive, optional W0-ENGINE extensions, each marked `W0 additive`.
 *
 * Conventions every consumer relies on (plan §4.4):
 * - TMT units, planet centre at the origin, right-handed, up = normalize(p).
 * - depth32float reversed-Z with an infinite far plane: clear 0, compare 'greater', near 0.08, linear_depth(d) = near / d.
 * - Matrices are Float32Array(16), column-major (WGSL mat4x4f layout, three.js `elements` order).
 * - Linear scene-referred HDR (rgba16float); sun illuminance 20; exposure is applied only in the composite.
 * - Every GPU resource is freed through ctx.deferDestroy (N6).
 * - Frame uniforms are always bound at @group(0) @binding(0) through `ctx.layouts.frame`.
 */

// ───────────────────────────── §5.4 verbatim ─────────────────────────────
export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';
export type FrameSlot = 'upload' | 'compute.pre' | 'compute.sim' | 'compute.commit' | 'shadows' | 'gbuffer.opaque' | 'gbuffer.foliage'
  | 'ao' | 'lighting' | 'clouds' | 'transparent' | 'taa' | 'post.dof' | 'overlay' | 'post.bloom' | 'composite' | 'debug';
export interface FrameState { index: number; time: number; dt: number; tier: QualityTier; internal: [number, number]; display: [number, number];
  view: Float32Array; proj: Float32Array; viewProj: Float32Array; invViewProj: Float32Array; prevViewProj: Float32Array; viewProjNoJitter: Float32Array;
  eye: [number, number, number]; jitter: [number, number]; sunDir: [number, number, number]; focus: { world: [number, number, number]; tilt: number; distance: number }
  /** W0 additive: true on the frame the camera jumped more than 3 u (TAA/temporal history must reset). */
  snap?: boolean }
export interface PassContext { encoder: GPUCommandEncoder; frame: FrameState; resources: FrameResources;
  timestampWrites(name: string): GPURenderPassTimestampWrites | GPUComputePassTimestampWrites | undefined }
export interface PassDecl { name: string; slot: FrameSlot; order?: number; reads: readonly string[]; writes: readonly string[];
  enabled?(f: FrameState): boolean; run(c: PassContext): void }
export interface RenderModule { readonly name: string; install(s: EngineServices): void | Promise<void>; dispose?(): void }
export interface EngineServices { ctx: GpuContext; graph: FrameGraphApi; frameUniforms: GPUBuffer; wgsl: WgslLibrary; bindings: ReservedBindings;
  scene: SceneRegistry; events: EngineEvents; telemetry: TelemetrySink; settings: GraphicsSettings }
export const GBUFFER = { albedoAo: 'rgba8unorm', normals: 'rgba16float', material: 'rgba8unorm', ids: 'r32uint', velocity: 'rg16float', depth: 'depth32float' } as const;
export const MATERIAL_CLASS = { TERRAIN: 0, METAL: 1, STRUCTURE: 2, FOLIAGE: 3, GRASS: 4, ROCK: 5, EMISSIVE: 6, DEBRIS: 7, WATER: 8, SKY: 15 } as const;
export type ReservedBindingName = 'sunShadows' | 'skyLight' | 'atmosphere' | 'ao' | 'cloudShadow' | 'gi' | 'lights' | 'surfaceMemory' | 'waterSurface' | 'sdf' | 'pendingCuts';
export interface ReservedBindings { provide(name: ReservedBindingName, r: BindingResources): void /* throws if a placeholder would overwrite a real resource */; get(name: ReservedBindingName): BindingResources /* 1×1 placeholder until provided */ }
export interface ShadowView { kind: 'static' | 'dynamic' | 'hero' | 'visibility'; viewProj: Float32Array; bindGroup: GPUBindGroup /* @group(0): light view uniforms */; cull(center: [number, number, number], radius: number): boolean }
export interface ShadowCaster { readonly name: string; readonly dynamic: boolean; drawDepth(pass: GPURenderPassEncoder, v: ShadowView): void }
export interface GBufferDrawer { readonly name: string; readonly slot: 'gbuffer.opaque' | 'gbuffer.foliage'; readonly order: number; draw(pass: GPURenderPassEncoder, f: FrameState): void }
export interface TransparentDrawer { readonly name: string; readonly order: number; draw(pass: GPURenderPassEncoder, f: FrameState): void }
export interface OverlayDrawer { readonly name: string; draw(pass: GPURenderPassEncoder, f: FrameState): void }
export interface SceneRegistry {
  addGBufferDrawer(d: GBufferDrawer): () => void; addShadowCaster(c: ShadowCaster): () => void;
  addTransparentDrawer(d: TransparentDrawer): () => void; addOverlayDrawer(d: OverlayDrawer): () => void;
  meshes: { create(desc: MeshDesc): MeshHandle; destroy(h: MeshHandle): void };            // vertex-pulling 'part' layout (§5.3 PartMesh)
  instances: { add(m: MeshHandle, i: InstanceInit): InstanceHandle; set(h: InstanceHandle, model: Float32Array, flags?: number): void; remove(h: InstanceHandle): void;
    /** W4 additive: 0 … 1 presence; below 1 the instance dissolves with a dithered discard (sim-gated enemy fades). */
    setVisibility(h: InstanceHandle, visibility: number): void };
  lights: { add(l: LightInit): LightHandle; update(h: LightHandle, l: Partial<LightInit>): void; remove(h: LightHandle): void };
  provide<K extends keyof SceneFacets>(k: K, v: SceneFacets[K]): void; get<K extends keyof SceneFacets>(k: K): SceneFacets[K] | undefined;
}
export interface PlanetDesc { seed: number; kind: 'temperate' | 'glacial' | 'dune' | 'volcanic'; radius: number; seaRadius?: number }
export interface CameraRig { position: [number, number, number]; target: [number, number, number]; up: [number, number, number]; fovY: number; viewOffset?: [number, number, number, number] }
export interface FrameInput { time: number; dt: number; camera: CameraRig; sun?: { dirToward: [number, number, number]; illuminance?: number };
  /** The moon, a separate directional light with its own stencil shadows; default: full, opposite the sun. */
  moon?: { dirToward: [number, number, number]; illuminance?: number };
  /** The match wind (world/weather.ts: rotation axis and bars, gusts included); absent: a gentle seeded breeze. */
  wind?: { axis: [number, number, number]; bars: number };
  focus: { world: [number, number, number]; tilt: number; distance: number };
  /** `center`/`radius` bound the cut (the SDF and water carve them). `shells` (material craters, rust-engine-v22) are the
   *  spheres the pending-crater bowl clamps to, each for the terrain materials in its mask (bit 1<<id). */
  pendingCuts: readonly { center: [number, number, number]; radius: number; t0: number; shells?: readonly { materials: number; center: [number, number, number]; radius: number }[] }[] }
export interface EngineOptions { canvas: HTMLCanvasElement; tier?: QualityTier | 'auto'; dev?: boolean; modules?: readonly (() => RenderModule)[]
  /** Opt-in Y-up room rendering. Omits planetary volumes, GI and fluids; use the `interior` scene facet for room lighting. */
  environment?: 'planet' | 'interior';
  /** W0 additive: initial graphics settings (e.g. `{ gbufferView: 'normal' }`). */
  settings?: Partial<GraphicsSettings> }
// engine.ts
// class Engine { static create(o: EngineOptions): Promise<Engine>; readonly services: EngineServices; setPlanet(p: PlanetDesc): Promise<void>;
//   frame(i: FrameInput): void /* one encoder, one submit */; project(p: [number,number,number]): { x: number; y: number; visible: boolean } /* CSS px; lens-aware from W2 */;
//   resize(cssW: number, cssH: number, dpr: number): void; telemetry(): EngineTelemetry; onLost(cb: () => void): void; dispose(): void }
// ─────────────────────────── end §5.4 verbatim ───────────────────────────

export type Vec3 = [number, number, number];

// ───────────────────────────── Scene facets ─────────────────────────────
/**
 * Open interface (declaration merging). W0 declares `terrainHost`, `sun` and `planet`; later streams add keys only in
 * their own files: `declare module '../engine/contracts' { interface SceneFacets { surfaceMemory: ... } }`.
 */
export interface SceneFacets { terrainHost: TerrainHostFacet; sun: SunFacet; moon: MoonFacet; planet: PlanetDesc;
  /** The current frame's pending (cosmetic) crater cuts, written by the engine from FrameInput every frame. */
  pendingCutList: FrameInput['pendingCuts'] }
/** Empty on purpose: W1-ENG-SCENE merges `EngineTerrainHost & { addPageHook(h: PageHook): () => void }` members into it. */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface TerrainHostFacet {}
/** The sun used by the current frame (written by the engine every frame from FrameInput.sun or the default). */
export interface SunFacet { dirToward: Vec3; illuminance: number }
/**
 * The moon used by the current frame (written by the engine every frame from FrameInput.moon or the default).
 * `illuminance` is the full-moon value; `phase` is the lit fraction seen from the planet, (1 − sun·moon) / 2, which
 * scales its light and shades its disc.
 */
export interface MoonFacet { dirToward: Vec3; illuminance: number; phase: number }

// ───────────────────────────── Frame graph ─────────────────────────────
/**
 * internal = render resolution (display × renderScale), half/quarter of internal, display = canvas pixels, displayHalf = half
 * of display (post chains that must not change with the render scale), or fixed.
 */
export type TextureSizeClass = 'internal' | 'half' | 'quarter' | 'display' | 'displayHalf' | readonly [number, number];
export interface TextureDecl {
  format: GPUTextureFormat; size: TextureSizeClass; usage: GPUTextureUsageFlags;
  mipLevelCount?: number;
  /** Ping-pong pair: `resources.view(n)` is this frame's, `resources.history(n)` last frame's (declare `history:<n>` in reads). */
  history?: boolean;
  /** Never aliased and kept across frames (implied by history). Default false: transient, aliasable by lifetime. */
  persistent?: boolean;
}
/** Resources a pass may touch. In dev every access is checked against the pass's declared reads/writes. */
export interface FrameResources {
  texture(name: string): GPUTexture;
  view(name: string): GPUTextureView;
  /** Previous frame's contents of a `history: true` texture. Requires `history:<name>` in the pass's reads. */
  history(name: string): GPUTextureView;
  buffer(name: string): GPUBuffer;
  size(name: string): readonly [number, number];
}
export interface FrameGraphApi {
  readonly slots: readonly FrameSlot[];
  /** Declare (or re-declare with an identical desc) a graph texture. */
  declareTexture(name: string, decl: TextureDecl): void;
  /** An externally owned texture (e.g. the swapchain). The view getter runs once per frame, when first accessed. */
  importTexture(name: string, get: () => { texture: GPUTexture; view: GPUTextureView }): void;
  /** An externally owned buffer; always readable. Re-importing replaces it. */
  importBuffer(name: string, buffer: GPUBuffer): void;
  /** Register a pass; returns its unregister function. Passes run in slot order, then `order`, then registration order. */
  addPass(p: PassDecl): () => void;
}

// ───────────────────────────── GPU context ─────────────────────────────
export interface GpuCaps {
  timestamps: boolean; indirectFirstInstance: boolean; float32Filterable: boolean; rg11b10Renderable: boolean;
  shaderF16: boolean; subgroups: boolean; lowMemory: boolean; fallbackAdapter: boolean;
  /** r8unorm / r16float (and friends) usable as write-only storage textures ('texture-formats-tier1'). */
  textureFormatsTier1?: boolean;
  vendor: string; architecture: string;
}
/** Bind group layouts shared across modules (pipelines built by different modules must use the same objects). */
export interface SharedLayouts {
  /** @group(0): binding 0 = FrameUniforms (uniform, all stages). */
  readonly frame: GPUBindGroupLayout;
  /** @group(0) of depth-only shadow passes: binding 0 = ShadowViewUniforms (uniform, vertex|fragment). */
  readonly shadowView: GPUBindGroupLayout;
}
/** create*PipelineAsync behind a de-duplicating cache with compile-ms telemetry and module:line error mapping. */
export interface PipelineCacheApi {
  /** A shader module for linked WGSL (cached by source); errors are reported through the link line map. */
  shaderModule(linked: LinkedWgsl, label: string): GPUShaderModule;
  /** Add a lazily built pipeline to the warm-up list (compiled by compile(), warmup() or shader-check). */
  register(key: string, kind: 'render' | 'compute', build: () => GPURenderPipelineDescriptor | GPUComputePipelineDescriptor): void;
  compile(key: string): Promise<GPURenderPipeline | GPUComputePipeline>;
  /** Explicit startup retry: replace a settled failed entry and its diagnostics; preserve successful/in-flight work. */
  retry?(key: string): Promise<GPURenderPipeline | GPUComputePipeline>;
  render(key: string, build: () => GPURenderPipelineDescriptor): Promise<GPURenderPipeline>;
  compute(key: string, build: () => GPUComputePipelineDescriptor): Promise<GPUComputePipeline>;
  /** The finished pipeline, or undefined while compiling or after a failure. */
  get<T extends GPURenderPipeline | GPUComputePipeline>(key: string): T | undefined;
  /** Retain only these keys within an explicit group; in-flight retirement waits for completion. Ungrouped shaders stay registered. */
  retainRecent?(group: string, keys: readonly string[]): void;
}
/** A 256 B aligned range of this frame's uniform ring segment (write f32/u32, it is uploaded before submit). */
export interface UniformAllocation { readonly buffer: GPUBuffer; readonly offset: number; readonly size: number; readonly f32: Float32Array; readonly u32: Uint32Array }
/** Per-frame uniform ring (3 × 1 MiB). Allocations are valid for the current frame only. */
export interface UniformRingApi { alloc(size: number): UniformAllocation; write(data: ArrayBufferView): UniformAllocation }
export interface GpuContext {
  readonly device: GPUDevice;
  /** Device-level pipeline cache shared by every module. */
  readonly pipelines: PipelineCacheApi;
  /** Per-frame uniform ring; rotated and flushed by the engine. */
  readonly uniforms: UniformRingApi;
  readonly queue: GPUQueue;
  readonly canvas: HTMLCanvasElement;
  readonly canvasContext: GPUCanvasContext;
  /** Swapchain format (navigator.gpu.getPreferredCanvasFormat()). */
  readonly format: GPUTextureFormat;
  readonly caps: GpuCaps;
  readonly layouts: SharedLayouts;
  /** True once the device is lost; the engine stops encoding. */
  readonly lost: boolean;
  /** The deferred-destroy clock (advanced once per frame by tick()). */
  readonly tickIndex: number;
  /** Destroy after DESTROY_SLACK_TICKS frames, so no in-flight command buffer can still reference it (N6). */
  deferDestroy(r: GPUBuffer | GPUTexture | GPUQuerySet | null | undefined): void;
  /** Once per frame, after submit. */
  tick(): void;
  /** Called once when the device is lost. Returns an unsubscribe function. */
  onLost(cb: (info: { reason: string; message: string }) => void): () => void;
}

// ───────────────────────────── WGSL ─────────────────────────────
/** A tagged-template WGSL module (see wgsl/module.ts). `deps` are linked before `code`, deduplicated by name. */
export interface WgslModule { readonly name: string; readonly deps: readonly WgslModule[]; readonly code: string }
export interface WgslLineMapEntry { readonly module: string; readonly start: number; readonly end: number }
export interface LinkedWgsl {
  readonly code: string;
  /** Output line ranges (1-based, inclusive) per module, in link order. */
  readonly lineMap: readonly WgslLineMapEntry[];
  readonly modules: readonly string[];
  /** Map an output line (1-based) back to `{ module, line }` (module-local, 1-based). */
  mapLine(line: number): { module: string; line: number };
}
export interface WgslLibrary {
  /** Register a module so other streams can depend on it by name. Re-registering the same name with different code throws. */
  register(m: WgslModule): void;
  get(name: string): WgslModule | undefined;
  /** Link roots (modules or registered names) into one source with a line map. */
  link(...roots: (WgslModule | string)[]): LinkedWgsl;
}

// ───────────────────────────── Reserved bindings ─────────────────────────────
/** One resource per slot key; the key set and types of each reserved binding are fixed by RESERVED_BINDING_LAYOUT. */
export type BindingResources = { readonly [key: string]: GPUBindingResource };
export type ReservedSlotType = 'uniform' | 'storage' | 'texture-2d' | 'texture-2d-array' | 'texture-cube' | 'texture-3d'
  | 'depth-2d' | 'sampler' | 'sampler-comparison';
export interface ReservedSlotDecl { readonly key: string; readonly type: ReservedSlotType; /** bytes, for buffers */ readonly size?: number }
/**
 * W0 additive: the slot shape of every reserved binding. Placeholders (1×1 textures, zeroed buffers) are built from it and a
 * provider must supply exactly these keys. Consumers bind the resources in their own bind groups (the engine's
 * `reservedLayoutEntries()` / `reservedBindGroupEntries()` helpers bind all of them in this order). Change through §7.4.
 */
export const RESERVED_BINDING_LAYOUT: { readonly [K in ReservedBindingName]: readonly ReservedSlotDecl[] } = {
  sunShadows: [{ key: 'static', type: 'depth-2d' }, { key: 'dynamic', type: 'depth-2d' }, { key: 'hero', type: 'depth-2d' },
    { key: 'compare', type: 'sampler-comparison' }, { key: 'params', type: 'uniform', size: 256 }],
  skyLight: [{ key: 'cube', type: 'texture-cube' }, { key: 'dfg', type: 'texture-2d' }, { key: 'sh', type: 'uniform', size: 256 }],
  atmosphere: [{ key: 'transmittance', type: 'texture-2d' }, { key: 'multiscatter', type: 'texture-2d' }, { key: 'skyView', type: 'texture-2d' },
    { key: 'params', type: 'uniform', size: 256 }],
  ao: [{ key: 'ao', type: 'texture-2d' }],
  cloudShadow: [{ key: 'cube', type: 'texture-cube' }, { key: 'params', type: 'uniform', size: 256 }],
  gi: [{ key: 'probes', type: 'texture-2d-array' }, { key: 'params', type: 'uniform', size: 256 }],
  lights: [{ key: 'list', type: 'storage', size: 16 + 64 * 64 }],
  surfaceMemory: [{ key: 'cube', type: 'texture-2d-array' }],
  waterSurface: [{ key: 'surface', type: 'texture-2d' }, { key: 'params', type: 'uniform', size: 256 }],
  sdf: [{ key: 'volume', type: 'texture-3d' }, { key: 'params', type: 'uniform', size: 256 }],
  pendingCuts: [{ key: 'cuts', type: 'uniform', size: 208 }],
};
export const RESERVED_BINDING_NAMES = Object.keys(RESERVED_BINDING_LAYOUT) as ReservedBindingName[];

/** W0 additive: shadow-map raster convention shared by ShadowCaster pipelines and ShadowView owners (reversed-Z, like the camera). */
export const SHADOW_DEPTH = { format: 'depth32float', compare: 'greater', clear: 0 } as const;
/** GB3 objectId bit marking a surface the fog-of-war veil applies to besides terrain (enemy tanks); ids are 9 bits otherwise. */
export const OBJECT_ID_VEIL = 0x200;
/** W0 additive: GB3 flag bits (6 bits at bit 4 of `ids`; plan §4.6). */
export const GBUFFER_FLAG = { NEW_GEOMETRY: 1, TWO_SIDED: 2, NO_SHADOW_RECEIVE: 4, WET: 8, SELECTED: 16, HERO: 32 } as const;

// ───────────────────────────── Meshes, instances, lights ─────────────────────────────
/**
 * Structurally a subset of §5.3 `PartMesh`, so a PartMesh can be passed directly.
 * attrs: u32 per vertex = edge u8 (bits 0–7) | ao u8 (8–15) | matId u8 (16–23) | flags u8 (24–31).
 * primAxis: oct snorm16x2 per vertex. instances: repeated sub-parts, 12 floats each, a row-major 3×4 affine
 * (rows r0, r1, r2; each (m0, m1, m2, t)), applied before the instance model.
 * MatIds (§5.3): 0 paint, 1 dark steel, 2 rubber, 3 gunmetal, 4 brass, 5 signal/emissive, 6 glass, 7 chrome.
 */
/** Opt-in vehicle surface data; other meshes never enter the vehicle shader. */
export interface TankSurfaceMark {
  position: Vec3; normal: Vec3; radius: number; opacity: number; softness: number; color: Vec3;
  /** Combat scars affect metal as well as paint, but never geometry. */
  damage?: boolean;
}
export interface TankSurface {
  colors: [Vec3, Vec3, Vec3]; pattern: number; scale: number; wear: number;
  /** Soot and heat damage across paint, metal and glass, 0–1. */
  damage?: number;
  lights?: boolean;
  marks?: TankSurfaceMark[];
}
export interface MeshDesc {
  positions: Float32Array; normals: Float32Array; indices: Uint32Array;
  /** Workshop 9..12: baked linear RGB. 13: (u, 1-v, texture layer). 14: gauge UV, V down. 15..17: neutral albedo tint. 18..19 and all other IDs: local rest coordinates. */
  partLocal?: Float32Array; primAxis?: Uint32Array; attrs?: Uint32Array; instances?: Float32Array;
  /** Used for every vertex when `attrs` is absent (default 0 = paint). */
  matId?: number;
  tankSurface?: TankSurface;
  /** Premultiplied-linear paint encoded as sRGB RGBA8; per-vertex UVs address its padded charts. */
  paintTexture?: { width: number; height: number; pixels: Uint8Array; uv: Float32Array };
  label?: string;
}
export interface MeshHandle { readonly id: number; readonly vertexCount: number; readonly indexCount: number;
  /** Local-space bounding sphere (sub-instances included). */ readonly bounds: { center: Vec3; radius: number } }
export interface InstanceInit {
  /** Column-major mat4 (16 floats). */
  model: Float32Array;
  /** Linear albedo for matId 0 (paint) and the signal colour for matId 5. Default (0.6, 0.6, 0.6). */
  tint?: Vec3;
  /** 10 bits (0..1023). */
  objectId?: number;
  /** GBUFFER_FLAG bits. */
  flags?: number;
  /** MATERIAL_CLASS value. Default METAL. */
  classId?: number;
  /** Default true. */
  castShadow?: boolean;
  /** Veil the parts the team's sensors cannot see in war-fog colour (enemy tanks; the simulation decides whether they
   * are drawn at all). Written as GB3 objectId bit OBJECT_ID_VEIL. */
  fogged?: boolean;
  /** Presence 0 … 1 (default 1): below 1 the instance dissolves with a dithered discard. */
  visibility?: number;
}
export interface InstanceHandle { readonly id: number }
export interface LightInit {
  type: 'point' | 'spot';
  position: Vec3;
  /** Linear colour; radiance scale is colour × intensity (sun illuminance 20 is the reference). */
  color: Vec3; intensity: number;
  /** Hard cutoff with a smooth window (Frostbite). */
  range: number;
  /** Opt into a soft SDF shadow (terrain) for this light, capped per pixel by tier. Unspecified lights remain unshadowed. */
  castShadow?: boolean;
  /** Exact mounting caster instance; permits only its bounded emitter-skin exit, never an entire caster skip. */
  sourceCasterId?: number;
  /** Spot only: unit direction the spot points toward, inner/outer half-angles in radians. */
  direction?: Vec3; innerAngle?: number; outerAngle?: number;
}
export interface LightHandle { readonly id: number }

// ───────────────────────────── Events, settings, telemetry ─────────────────────────────
export interface EngineEventMap {
  planetChanged: { planet: PlanetDesc };
  terrainCommitted: { dirtyBounds: { min: Vec3; max: Vec3 }; epoch: number };
  resize: { display: [number, number]; internal: [number, number]; dpr: number };
  tierChanged: { tier: QualityTier };
  frameEnd: { frame: FrameState };
}
export type EngineEventName = keyof EngineEventMap;
export interface EngineEvents {
  on<K extends EngineEventName>(name: K, cb: (e: EngineEventMap[K]) => void): () => void;
  emit<K extends EngineEventName>(name: K, e: EngineEventMap[K]): void;
}
export type GBufferView = 'none' | 'albedo' | 'normal' | 'geonormal' | 'material' | 'ids' | 'velocity' | 'depth';
/** Mutable; read every frame. Tier changes apply at load; renderScale changes live. */
export interface GraphicsSettings {
  tier: QualityTier;
  /** Optional visual budgets, independent of liquid/explosion/visibility resolution. */
  shadowTier?: QualityTier;
  cloudTier?: QualityTier;
  hazeTier?: QualityTier;
  renderScale: number;
  /** Linear exposure multiplier applied in the composite. */
  exposure: number;
  /** Halton(2,3) sub-pixel jitter; off unless a TAA module turns it on. */
  jitter: boolean;
  gbufferView: GBufferView;
  dev: boolean;
}
/** Modules report their own numbers; they appear under `telemetry().custom`. */
export interface TelemetrySink {
  /** Per-frame counter (reset every frame). */
  count(name: string, n?: number): void;
  /** Latest value. */
  gauge(name: string, value: number): void;
  /** CPU milliseconds, smoothed. */
  time(name: string, ms: number): void;
}
export interface EngineTelemetry {
  frame: number;
  lost: boolean;
  tier: QualityTier;
  display: [number, number];
  internal: [number, number];
  /** Rolling per-pass GPU milliseconds from timestamp queries; total = sum of passes. */
  gpu: { total: number; passes: { name: string; ms: number }[]; timestamps: boolean; dropped: number };
  cpu: { encodeMs: number; frameMs: number };
  draws: number;
  triangles: number;
  vram: { total: number; peak: number; byCategory: Record<string, number> };
  compile: { totalMs: number; pipelines: number; pending: number; errors: number };
  validationErrors: number;
  custom: Record<string, number>;
}
