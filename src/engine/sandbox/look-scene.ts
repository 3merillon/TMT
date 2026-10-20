/**
 * `dev/engine-sandbox.html?scene=look&planet=temperate|glacial|dune|volcanic` (or `&seed=N`, kind = seed & 3): the
 * W1-ENG-LOOK development scene (dev only, never a build input).
 *
 * - A radius-18 planet whose cap around the focus is flat (constant radius) with a crater bowl carved into it; the relief
 *   starts 7 u away. The planet and a building block are STATIC casters, drawn by this scene's own depth-only
 *   ShadowCaster (`dynamic: false`, cullMode none, terrain raster bias, per-view culling), so PlanetStatic renders once and
 *   then only on `terrainCommitted` — the game's configuration.
 * - A box "tank" of 4 parts (hull, tracks, turret, barrel), an emissive sphere with a point light and a chrome ball are
 *   part-mesh instances: DYNAMIC casters (PlanetDynamic + Hero).
 * - Camera presets `day` (default), `boom6`, `boom17`, `boom36`, `overview`, `contact` (tank/ground contact), `crater`.
 * - `?load=<ms>`: a synthetic GPU load (separate timestamp) so perf captures run at gameplay clocks.
 * - `window.__tmtLook`: probes for the capture rubric (acne, tank shadow, terminator, orbit shimmer), planet switching,
 *   a scissored terrain-commit checked by the PlanetStatic-only shadow probe, shadow / term toggles.
 */
import { MATERIAL_CLASS } from '../contracts';
import type { EngineServices, GBufferDrawer, PlanetDesc, RenderModule, ShadowCaster, ShadowView, Vec3 } from '../contracts';
import { BufferUsage, ShaderStage } from '../gpu/flags';
import { GBUFFER_COLOR_TARGETS, GBUFFER_DEPTH_STENCIL } from '../passes/gbuffer/gbuffer';
import { frameWgsl } from '../wgsl/common/frame.wgsl';
import { gbufferWgsl } from '../wgsl/common/gbuffer.wgsl';
import { shadowViewWgsl } from '../wgsl/common/shadow-view.wgsl';
import { link, makeModule } from '../wgsl/module';
import { planetKindFromSeed, type PlanetKind } from '../../world/sun';
import type { LightingDebugView } from '../passes/lighting/lighting';
import type { ShimmerResult } from '../passes/shadows/sun-shadows';
import { add3, boxMesh, cross, fbm, mul4, norm, scale3, scaling, surfaceFrame, surfaceModel, translation } from './geometry';
import type { OrbitPreset, SandboxScene, SceneFactory } from './scene-types';

const RADIUS = 18;
const SEED = 7;
const FOCUS_DIR = norm([0.32, 0.86, 0.4]);
const FLAT_RADIUS = 7;
const RELIEF_END = 11;
const KINDS: readonly PlanetKind[] = ['temperate', 'glacial', 'dune', 'volcanic'];
const KIND_SEED: Record<PlanetKind, number> = { volcanic: 4, dune: 5, glacial: 6, temperate: 7 };

/** Linear albedo of the ground per kind (matches the atmosphere presets' ground albedo). */
const GROUND_TINT: Record<PlanetKind, Vec3> = {
  temperate: [0.15, 0.24, 0.085], glacial: [0.6, 0.66, 0.72], dune: [0.5, 0.34, 0.18], volcanic: [0.075, 0.065, 0.06],
};
const BUILDING_TINT: Record<PlanetKind, Vec3> = {
  temperate: [0.55, 0.52, 0.46], glacial: [0.4, 0.44, 0.5], dune: [0.62, 0.5, 0.36], volcanic: [0.34, 0.3, 0.28],
};

const SUN_ELEVATION = 38 * Math.PI / 180;
/** Sun azimuth around the focus up, measured like the orbit yaw (0 = along T). */
const SUN_AZIMUTH = 0.95;
const DEFAULT_YAW = -0.7;

type V3 = [number, number, number];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function smooth(e0: number, e1: number, x: number): number { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }

/** Direction at geodesic distance `dist` from the focus toward tangent angle `ang` (around the focus up). */
function dirAt(ang: number, dist: number): V3 {
  const { u, t, b } = surfaceFrame(FOCUS_DIR);
  const a = dist / RADIUS;
  const h = add3(scale3(t, Math.cos(ang)), scale3(b, Math.sin(ang)));
  return norm(add3(scale3(u, Math.cos(a)), scale3(h, Math.sin(a))));
}

const CRATER = { ang: 1.75, dist: 3.5, radius: 1.45, depth: 0.75, rim: 0.2 };
const CRATER_DIR = dirAt(CRATER.ang, CRATER.dist);

/** Planet radius along a unit direction: flat cap, crater bowl, fbm relief beyond. */
export function lookRadius(d: readonly number[]): number {
  const dist = Math.acos(Math.min(1, dot(d, FOCUS_DIR))) * RADIUS;
  const relief = (fbm(d, SEED) * 0.9 + fbm(d, SEED + 11, 3, 5.3) * 0.2) * smooth(FLAT_RADIUS, RELIEF_END, dist);
  const s = Math.acos(Math.min(1, dot(d, CRATER_DIR))) * RADIUS / CRATER.radius;
  let crater = 0;
  if (s < 1) crater -= CRATER.depth * (1 - s * s) ** 0.8; // steep walls near the rim, like a cut sphere
  crater += CRATER.rim * Math.exp(-(((s - 1) / 0.3) ** 2));
  return RADIUS + relief + crater;
}

/** Icosphere with numeric edge keys (fast enough for subdivision 7). */
function icosphereFast(subdivisions: number): { dirs: number[]; indices: Uint32Array } {
  const t = (1 + Math.sqrt(5)) / 2;
  const dirs: number[] = [];
  for (const v of [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]) dirs.push(...norm(v));
  let faces = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
  for (let s = 0; s < subdivisions; s++) {
    const cache = new Map<number, number>();
    const mid = (a: number, b: number) => {
      const key = a < b ? a * 4194304 + b : b * 4194304 + a;
      let i = cache.get(key);
      if (i === undefined) {
        i = dirs.length / 3;
        const m = norm([dirs[a * 3] + dirs[b * 3], dirs[a * 3 + 1] + dirs[b * 3 + 1], dirs[a * 3 + 2] + dirs[b * 3 + 2]]);
        dirs.push(m[0], m[1], m[2]);
        cache.set(key, i);
      }
      return i;
    };
    const next = new Array<number>(faces.length * 4);
    let w = 0;
    for (let f = 0; f < faces.length; f += 3) {
      const a = faces[f], b = faces[f + 1], c = faces[f + 2];
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      next[w++] = a; next[w++] = ab; next[w++] = ca; next[w++] = b; next[w++] = bc; next[w++] = ab;
      next[w++] = c; next[w++] = ca; next[w++] = bc; next[w++] = ab; next[w++] = bc; next[w++] = ca;
    }
    faces = next;
  }
  return { dirs, indices: new Uint32Array(faces) };
}

function lookPlanetMesh(subdivisions: number) {
  const { dirs, indices } = icosphereFast(subdivisions);
  const n = dirs.length / 3;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const d = [dirs[i * 3], dirs[i * 3 + 1], dirs[i * 3 + 2]];
    const r = lookRadius(d);
    positions[i * 3] = d[0] * r; positions[i * 3 + 1] = d[1] * r; positions[i * 3 + 2] = d[2] * r;
  }
  const acc = new Float64Array(n * 3);
  for (let f = 0; f < indices.length; f += 3) {
    const a = indices[f] * 3, b = indices[f + 1] * 3, c = indices[f + 2] * 3;
    const e1 = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
    const e2 = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
    const nn = cross(e1, e2);
    for (const v of [a, b, c]) { acc[v] += nn[0]; acc[v + 1] += nn[1]; acc[v + 2] += nn[2]; }
  }
  const normals = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const l = Math.hypot(acc[i * 3], acc[i * 3 + 1], acc[i * 3 + 2]) || 1;
    normals[i * 3] = acc[i * 3] / l; normals[i * 3 + 1] = acc[i * 3 + 1] / l; normals[i * 3 + 2] = acc[i * 3 + 2] / l;
  }
  return { positions, normals, indices, matId: 0, label: 'look-planet' };
}

function sphereMesh(subdivisions: number, matId: number, label: string) {
  const { dirs, indices } = icosphereFast(subdivisions);
  const p = new Float32Array(dirs.map(v => v * 0.5));
  return { positions: p, normals: new Float32Array(dirs), partLocal: p, indices, matId, label };
}

function transformPositions(model: Float32Array, positions: Float32Array): Float32Array {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    out[i] = model[0] * x + model[4] * y + model[8] * z + model[12];
    out[i + 1] = model[1] * x + model[5] * y + model[9] * z + model[13];
    out[i + 2] = model[2] * x + model[6] * y + model[10] * z + model[14];
  }
  return out;
}

function boundingSphere(p: Float32Array): { center: Vec3; radius: number } {
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[i + k]); mx[k] = Math.max(mx[k], p[i + k]); }
  const center: Vec3 = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
  let r = 0;
  for (let i = 0; i < p.length; i += 3) r = Math.max(r, Math.hypot(p[i] - center[0], p[i + 1] - center[1], p[i + 2] - center[2]));
  return { center, radius: r };
}

const staticCasterShader = makeModule('look-static-caster', /* wgsl */ `
@vertex
fn vs_static(@location(0) p: vec3f) -> @builtin(position) vec4f {
  return shadow_view.view_proj * vec4f(p, 1.0);
}
`, [shadowViewWgsl]);
export function lookStaticCasterShader() { return link(staticCasterShader); }

interface StaticItem { vertex: GPUBuffer; index: GPUBuffer; count: number; center: Vec3; radius: number }

/** Depth-only static caster for world-space triangle soups (terrain-style raster: no culling, slope bias). */
function staticCaster(s: EngineServices, soups: { positions: Float32Array; indices: Uint32Array }[]): { caster: ShadowCaster; drawn: () => number; dispose(): void } {
  const { device, queue } = s.ctx;
  const key = 'look:static-caster';
  s.ctx.pipelines.register(key, 'render', () => ({
    label: key, layout: device.createPipelineLayout({ bindGroupLayouts: [s.ctx.layouts.shadowView] }),
    vertex: { module: s.ctx.pipelines.shaderModule(lookStaticCasterShader(), key), entryPoint: 'vs_static',
      buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    // Plan §4.8 terrain raster bias (6 / 2.5), negative because the maps are reversed-Z.
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater', depthBias: -6, depthBiasSlopeScale: -2.5 },
  }));
  void s.ctx.pipelines.compile(key).catch(() => undefined);
  const items: StaticItem[] = soups.map((soup, i) => {
    const vertex = device.createBuffer({ label: `look:static-${i}-v`, size: soup.positions.byteLength, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
    const index = device.createBuffer({ label: `look:static-${i}-i`, size: soup.indices.byteLength, usage: BufferUsage.INDEX | BufferUsage.COPY_DST });
    queue.writeBuffer(vertex, 0, soup.positions.buffer, soup.positions.byteOffset, soup.positions.byteLength);
    queue.writeBuffer(index, 0, soup.indices.buffer, soup.indices.byteOffset, soup.indices.byteLength);
    return { vertex, index, count: soup.indices.length, ...boundingSphere(soup.positions) };
  });
  let drawn = 0;
  const caster: ShadowCaster = {
    name: 'look-static', dynamic: false,
    drawDepth(pass: GPURenderPassEncoder, v: ShadowView) {
      const pipe = s.ctx.pipelines.get<GPURenderPipeline>(key);
      if (!pipe) return;
      pass.setPipeline(pipe);
      pass.setBindGroup(0, v.bindGroup);
      for (const it of items) {
        if (!v.cull(it.center, it.radius)) continue;
        pass.setVertexBuffer(0, it.vertex);
        pass.setIndexBuffer(it.index, 'uint32');
        pass.drawIndexed(it.count);
        drawn++;
      }
    },
  };
  return { caster, drawn: () => drawn, dispose: () => { for (const it of items) { s.ctx.deferDestroy(it.vertex); s.ctx.deferDestroy(it.index); } } };
}

const terrainShader = makeModule('look-terrain', /* wgsl */ `
struct TerrainLook { tint: vec4f }   // rgb albedo, w roughness
@group(1) @binding(0) var<uniform> look: TerrainLook;

struct TerrainOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) clip_nojitter: vec4f,
  @location(3) clip_prev: vec4f,
}

@vertex
fn vs_terrain(@location(0) p: vec3f, @location(1) n: vec3f) -> TerrainOut {
  var o: TerrainOut;
  let w = vec4f(p, 1.0);
  o.pos = frame.view_proj * w;
  o.world = p;
  o.normal = n;
  o.clip_nojitter = frame.view_proj_nojitter * w;
  o.clip_prev = frame.prev_view_proj * w;
  return o;
}

fn look_hash(p: vec3f) -> f32 { return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453); }
fn look_noise(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(look_hash(i), look_hash(i + vec3f(1.0, 0.0, 0.0)), u.x), mix(look_hash(i + vec3f(0.0, 1.0, 0.0)), look_hash(i + vec3f(1.0, 1.0, 0.0)), u.x), u.y),
             mix(mix(look_hash(i + vec3f(0.0, 0.0, 1.0)), look_hash(i + vec3f(1.0, 0.0, 1.0)), u.x), mix(look_hash(i + vec3f(0.0, 1.0, 1.0)), look_hash(i + vec3f(1.0, 1.0, 1.0)), u.x), u.y), u.z);
}

@fragment
fn fs_terrain(in: TerrainOut, @builtin(front_facing) front: bool) -> GBufferOut {
  var n = normalize(in.normal);
  if (!front) { n = -n; }
  var ng = cross(dpdy(in.world), dpdx(in.world));
  let ngl = length(ng);
  ng = select(n, ng / max(ngl, 1e-20), ngl > 1e-20);
  if (dot(ng, n) < 0.0) { ng = -ng; }
  let v = look_noise(in.world * 2.3) * 0.6 + look_noise(in.world * 7.9) * 0.4;
  var s = surface_default();
  s.base_color = look.tint.rgb * (0.8 + 0.4 * v);
  s.roughness = look.tint.w;
  s.metalness = 0.0;
  s.n_shading = n;
  s.n_geom = ng;
  s.class_id = CLASS_TERRAIN;
  s.object_id = 1u;
  return gbuffer_pack(s, gbuffer_velocity(in.clip_nojitter, in.clip_prev));
}
`, [frameWgsl, gbufferWgsl]);
export function lookTerrainShader() { return link(terrainShader); }

/** A matte procedural terrain G-buffer drawer (order 0) for the sandbox planet. */
function terrainDrawer(s: EngineServices, mesh: { positions: Float32Array; normals: Float32Array; indices: Uint32Array }) {
  const { device, queue } = s.ctx;
  const key = 'look:terrain';
  const layout = device.createBindGroupLayout({ label: 'layout:look-terrain', entries: [{ binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } }] });
  s.ctx.pipelines.register(key, 'render', () => {
    const module = s.ctx.pipelines.shaderModule(lookTerrainShader(), key);
    return {
      label: key, layout: device.createPipelineLayout({ bindGroupLayouts: [s.ctx.layouts.frame, layout] }),
      vertex: { module, entryPoint: 'vs_terrain', buffers: [
        { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
        { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] }] },
      fragment: { module, entryPoint: 'fs_terrain', targets: GBUFFER_COLOR_TARGETS },
      primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
      depthStencil: GBUFFER_DEPTH_STENCIL,
    };
  });
  void s.ctx.pipelines.compile(key).catch(() => undefined);
  const mk = (label: string, data: Float32Array | Uint32Array, usage: number) => {
    const b = device.createBuffer({ label, size: data.byteLength, usage: usage | BufferUsage.COPY_DST });
    queue.writeBuffer(b, 0, data.buffer, data.byteOffset, data.byteLength);
    return b;
  };
  const pos = mk('look:terrain-pos', mesh.positions, BufferUsage.VERTEX);
  const nrm = mk('look:terrain-nrm', mesh.normals, BufferUsage.VERTEX);
  const idx = mk('look:terrain-idx', mesh.indices, BufferUsage.INDEX);
  const uniform = device.createBuffer({ label: 'look:terrain-tint', size: 16, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
  const group = device.createBindGroup({ label: 'look-terrain', layout, entries: [{ binding: 0, resource: { buffer: uniform } }] });
  const drawer: GBufferDrawer = {
    name: 'look-terrain', slot: 'gbuffer.opaque', order: 0,
    draw(pass) {
      const pipe = s.ctx.pipelines.get<GPURenderPipeline>(key);
      if (!pipe) return;
      pass.setPipeline(pipe);
      pass.setBindGroup(1, group);
      pass.setVertexBuffer(0, pos);
      pass.setVertexBuffer(1, nrm);
      pass.setIndexBuffer(idx, 'uint32');
      pass.drawIndexed(mesh.indices.length);
    },
  };
  return {
    drawer,
    setTint(c: Vec3, roughness = 0.88) { queue.writeBuffer(uniform, 0, new Float32Array([c[0], c[1], c[2], roughness])); },
    dispose() { for (const b of [pos, nrm, idx, uniform]) s.ctx.deferDestroy(b); },
  };
}

const loadShader = makeModule('look-gpu-load', /* wgsl */ `
struct LoadParams { iterations: u32, _a: u32, _b: u32, _c: u32 }
@group(0) @binding(0) var<storage, read_write> sink: array<f32, 4>;
@group(0) @binding(1) var<uniform> lp: LoadParams;

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  var x = f32(id.x) * 1e-4 + 0.1;
  for (var i = 0u; i < lp.iterations; i++) { x = fract(x * 1.61803 + 0.3141 * x * x); }
  if (x < -1.0) { sink[0] = x; }
}
`);
export function lookGpuLoadShader() { return link(loadShader); }

/**
 * `?load=<ms>`: a synthetic compute load at the START of the frame ('upload' slot, its own timestamp 'look-gpu-load'; at the
 * end it overlapped the compositor's fixed-phase preemption onto whichever pass straddled it). The sandbox is so light
 * that the GPU stays at idle clocks (~700 MHz on the reference 3080 instead of its 2.1 GHz boost), which inflates every
 * pass timestamp ~2.5×; the budgets are for a loaded gameplay frame, so perf captures add this load to reach those clocks.
 */
function gpuLoad(s: EngineServices, ms: number): () => void {
  const { device, queue } = s.ctx;
  const key = 'look:gpu-load';
  const layout = device.createBindGroupLayout({ label: 'layout:look-gpu-load', entries: [
    { binding: 0, visibility: ShaderStage.COMPUTE, buffer: { type: 'storage' } },
    { binding: 1, visibility: ShaderStage.COMPUTE, buffer: { type: 'uniform' } }] });
  s.ctx.pipelines.register(key, 'compute', () => ({
    label: key, layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: { module: s.ctx.pipelines.shaderModule(lookGpuLoadShader(), key), entryPoint: 'main' },
  }));
  void s.ctx.pipelines.compile(key).catch(() => undefined);
  const sink = device.createBuffer({ label: 'look:gpu-load-sink', size: 16, usage: BufferUsage.STORAGE });
  const params = device.createBuffer({ label: 'look:gpu-load-params', size: 16, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
  queue.writeBuffer(params, 0, new Uint32Array([Math.max(1, Math.round(ms * 2200)), 0, 0, 0]));
  const group = device.createBindGroup({ label: 'look-gpu-load', layout, entries: [{ binding: 0, resource: { buffer: sink } }, { binding: 1, resource: { buffer: params } }] });
  const off = s.graph.addPass({
    name: 'look-gpu-load', slot: 'upload', order: -1000, reads: [], writes: [],
    run(c) {
      const pipe = s.ctx.pipelines.get<GPUComputePipeline>(key);
      if (!pipe) return;
      const ts = c.timestampWrites('look-gpu-load') as GPUComputePassTimestampWrites | undefined;
      const pass = c.encoder.beginComputePass({ label: 'look-gpu-load', ...(ts ? { timestampWrites: ts } : {}) });
      pass.setPipeline(pipe);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(4096);
      pass.end();
    },
  });
  return () => { off(); s.ctx.deferDestroy(sink); s.ctx.deferDestroy(params); };
}

interface Rect { x: number; y: number; w: number; h: number }
interface SandboxLike {
  engine: { project(p: [number, number, number]): { x: number; y: number; visible: boolean } } | null;
  imageStats(rect?: Rect): Promise<{ mean: number; variance: number; pixels: number }>;
  setCamera(name: string): string;
}
export interface LookApi {
  kind: PlanetKind;
  ready: boolean;
  setPlanet(kind: PlanetKind): void;
  setShadows(on: boolean): void;
  setView(v: LightingDebugView): void;
  setAmbient(scale: number, ao?: boolean): void;
  /** CSS-px rects of the named probe points for the current camera. */
  probes(size?: number): Record<string, Rect & { visible: boolean }>;
  /** Luma std of a lit ground rect with shadows on and off (acne check). */
  acne(): Promise<{ stdOn: number; stdOff: number; ratio: number; meanOn: number; meanOff: number }>;
  /** Mean luma of the ground in the tank's shadow / open ground 1.5 u beyond it (plan §8 "tank sits on the ground"). */
  tankShadow(): Promise<{ shadow: number; open: number; ratio: number }>;
  /** Night-side / day-side planet luma in the current (overview) framing. */
  terminator(): Promise<{ day: number; night: number; ratio: number }>;
  /** Orbit slowly for `frames` frames while the focus drifts and the boom breathes; returns the probe's flicker ratio. */
  shimmer(frames?: number): Promise<ShimmerResult & { heroRelocks: number }>;
  /**
   * Emit a terrainCommitted over the crater while the PlanetStatic-only shadow probe watches the crater area: the
   * scissored re-render (clear-rect + loadOp 'load') must leave every probed visibility unchanged (flicker 0 = no hole),
   * `staticRenders` confirms the re-render ran and `edge` > 0 that the probed area holds shadow the probe can see change.
   */
  commit(): Promise<ShimmerResult & { staticRenders: number; drawn: number }>;
  stats(): unknown;
  /**
   * Per-pass GPU MEDIANS (ms) over `frames` frames from the engine's frame capture — robust against the spikes other
   * processes' GPU work puts into the 60-frame rolling averages of telemetry().gpu.passes.
   */
  gpuMedians(frames?: number): Promise<Record<string, number | null>>;
}
declare global { interface Window { __tmtLook?: LookApi } }

const frames = (n: number) => new Promise<void>(resolve => { let k = 0; const f = () => { if (++k >= n) resolve(); else requestAnimationFrame(f); }; requestAnimationFrame(f); });

const createLookScene: SceneFactory = params => {
  const seedParam = params.get('seed');
  let kind: PlanetKind = (KINDS as readonly string[]).includes(params.get('planet') ?? '') ? params.get('planet') as PlanetKind
    : seedParam !== null ? planetKindFromSeed(Number(seedParam)) : 'temperate';
  const focus: Vec3 = scale3(FOCUS_DIR, RADIUS);
  const { u, t, b } = surfaceFrame(focus);
  const sunH = add3(scale3(t, Math.cos(SUN_AZIMUTH)), scale3(b, Math.sin(SUN_AZIMUTH)));
  const sun = norm(add3(scale3(u, Math.sin(SUN_ELEVATION)), scale3(sunH, Math.cos(SUN_ELEVATION))));
  let services: EngineServices | null = null;
  let terrain: ReturnType<typeof terrainDrawer> | null = null;
  let unload: (() => void) | null = null;
  const loadMs = Number(params.get('load') ?? 0) || 0;
  let buildingInstance: { id: number } | null = null;
  let planetAnnounced = false;
  let caster: ReturnType<typeof staticCaster> | null = null;
  // Tank placement (yaw so the long side faces the default camera and the shadow falls on open ground).
  const TANK_YAW = 0.35;
  const tankModel = surfaceModel(focus, focus, TANK_YAW, [1, 1, 1]);
  const toWorld = (x: number, y: number, z: number): Vec3 => {
    const m = tankModel;
    return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
  };
  const buildingDir = dirAt(3.05, 4.6);
  const sphereDir = dirAt(0.95, 1.9);
  const chromeDir = dirAt(-1.9, 1.6);

  const planetDesc = (): PlanetDesc => ({ seed: KIND_SEED[kind], kind, radius: RADIUS });
  const announce = () => {
    if (!services) return;
    services.scene.provide('planet', planetDesc());
    services.events.emit('planetChanged', { planet: planetDesc() });
    planetAnnounced = true;
  };

  const module: RenderModule = {
    name: 'sandbox.look-scene',
    install(s) {
      services = s;
      const sc = s.scene;
      // Static geometry: the planet (flat cap + crater) and a building — part meshes for the G-buffer (no part-mesh
      // shadow), plus this scene's static ShadowCaster for PlanetStatic + Hero.
      if (loadMs > 0) unload = gpuLoad(s, loadMs);
      const planet = lookPlanetMesh(7);
      terrain = terrainDrawer(s, planet);
      terrain.setTint(GROUND_TINT[kind]);
      sc.addGBufferDrawer(terrain.drawer);
      const box = sc.meshes.create(boxMesh(0, 'look-box-paint'));
      const buildingSize: Vec3 = [1.3, 2.2, 1.6];
      const buildingBase = lookRadius(buildingDir) - 0.05;
      const buildingModel = surfaceModel(scale3(buildingDir, buildingBase + buildingSize[1] / 2), buildingDir, 0.5, buildingSize);
      buildingInstance = sc.instances.add(box, { model: buildingModel, tint: BUILDING_TINT[kind], classId: MATERIAL_CLASS.STRUCTURE, objectId: 3, castShadow: false });
      const boxSoup = boxMesh(0);
      caster = staticCaster(s, [
        { positions: planet.positions, indices: planet.indices },
        { positions: transformPositions(buildingModel, boxSoup.positions), indices: boxSoup.indices },
      ]);
      sc.addShadowCaster(caster.caster);

      // Dynamic: the 4-part box tank (hull paint, tracks rubber, turret gunmetal, barrel dark steel), local y up.
      const at = (x: number, y: number, z: number, sx: number, sy: number, sz: number) => mul4(tankModel, mul4(translation(x, y, z), scaling(sx, sy, sz)));
      const rubber = sc.meshes.create(boxMesh(2, 'look-tracks'));
      const gunmetal = sc.meshes.create(boxMesh(3, 'look-turret'));
      const steel = sc.meshes.create(boxMesh(1, 'look-barrel'));
      sc.instances.add(box, { model: at(0, 0.44, 0, 0.92, 0.34, 1.5), tint: [0.62, 0.14, 0.08], objectId: 10 });
      sc.instances.add(rubber, { model: at(-0.56, 0.2, 0, 0.26, 0.4, 1.66), objectId: 10 });
      sc.instances.add(rubber, { model: at(0.56, 0.2, 0, 0.26, 0.4, 1.66), objectId: 10 });
      sc.instances.add(gunmetal, { model: at(0, 0.74, -0.12, 0.62, 0.26, 0.7), objectId: 11 });
      sc.instances.add(steel, { model: at(0, 0.76, 0.55, 0.1, 0.1, 0.95), objectId: 11 });
      // Emissive sphere (signal material, EMISSIVE class) with a point light, and a chrome ball for reflections.
      const glow = sc.meshes.create(sphereMesh(4, 5, 'look-emissive'));
      const sphereR = 0.3;
      const spherePos = scale3(sphereDir, lookRadius(sphereDir) + 0.55);
      sc.instances.add(glow, { model: surfaceModel(spherePos, sphereDir, 0, [sphereR * 2, sphereR * 2, sphereR * 2]), tint: [1.0, 0.42, 0.1], classId: MATERIAL_CLASS.EMISSIVE, objectId: 20 });
      sc.lights.add({ type: 'point', position: spherePos, color: [1.0, 0.5, 0.2], intensity: 3, range: 3.5 });
      const chrome = sc.meshes.create(sphereMesh(5, 7, 'look-chrome'));
      const chromeR = 0.32;
      sc.instances.add(chrome, { model: surfaceModel(scale3(chromeDir, lookRadius(chromeDir) + chromeR), chromeDir, 0, [chromeR * 2, chromeR * 2, chromeR * 2]), objectId: 21 });
    },
    dispose() { caster?.dispose(); terrain?.dispose(); unload?.(); },
  };

  const cameras: Record<string, OrbitPreset> = {
    day: { distance: 11, yaw: DEFAULT_YAW, pitch: 0.3 },
    boom6: { distance: 6, yaw: DEFAULT_YAW - 0.2, pitch: 0.36 },
    boom17: { distance: 17, yaw: DEFAULT_YAW, pitch: 0.55 },
    boom36: { distance: 36, yaw: DEFAULT_YAW + 0.1, pitch: 0.8 },
    overview: { target: [0, 0, 0], distance: 72, yaw: SUN_AZIMUTH + Math.PI / 2 + 0.25, pitch: 0.5 },
    contact: { distance: 3.4, yaw: SUN_AZIMUTH + Math.PI / 2 + 0.2, pitch: 0.2 },
    crater: { target: scale3(CRATER_DIR, RADIUS), distance: 5.5, yaw: SUN_AZIMUTH + Math.PI - 0.5, pitch: 0.7 },
    shimmer: { distance: 9, yaw: DEFAULT_YAW, pitch: 0.42 },
  };

  const scene: SandboxScene = {
    name: 'look', module, focus, sun, defaultCamera: 'day', cameras,
    update() {
      if (!planetAnnounced) announce();
    },
  };

  // ── Probes for the capture rubric ──
  const sandbox = () => (window as unknown as { __tmtEngineSandbox?: SandboxLike }).__tmtEngineSandbox;
  const project = (p: Vec3) => sandbox()?.engine?.project(p as [number, number, number]) ?? { x: NaN, y: NaN, visible: false };
  const rectAt = (p: Vec3, size: number) => { const q = project(p); return { x: Math.round(q.x - size / 2), y: Math.round(q.y - size / 2), w: size, h: size, visible: q.visible }; };
  const onGround = (d: V3, lift = 0.002) => scale3(d, lookRadius(d) + lift);
  // Shadow of the hull falls away from the sun: sample 1.1 u from the tank centre along −sun_h, and open ground beyond.
  const shadowDir = norm(add3(scale3(t, -Math.cos(SUN_AZIMUTH)), scale3(b, -Math.sin(SUN_AZIMUTH))));
  const groundAlong = (dist: number, side = 0) => {
    const sideDir = cross(u, shadowDir);
    const p = add3(add3(focus, scale3(shadowDir, dist)), scale3(sideDir, side));
    return onGround(norm(p));
  };
  const facet = <K extends 'sunShadows' | 'lighting' | 'atmosphere'>(k: K) => services?.scene.get(k);
  const api: LookApi = {
    get kind() { return kind; },
    get ready() { return planetAnnounced; },
    setPlanet(k) {
      kind = k;
      terrain?.setTint(GROUND_TINT[kind]);
      const pm = (sandbox()?.engine as unknown as { partMeshes?: { setTint(h: { id: number }, c: Vec3): void } } | null)?.partMeshes;
      if (pm && buildingInstance) pm.setTint(buildingInstance, BUILDING_TINT[kind]);
      announce();
    },
    setShadows(on) { const f = facet('sunShadows'); if (f) f.enabled = on; },
    setView(v) { const f = facet('lighting'); if (f) f.view = v; },
    setAmbient(scale, ao = true) { const f = facet('lighting'); if (f) { f.ambient = scale; f.ao = ao; } },
    probes(size = 24) {
      return {
        tank: rectAt(toWorld(0, 0.44, 0), size),
        tankShadow: rectAt(groundAlong(1.15), size),
        openGround: rectAt(groundAlong(2.65), size),
        litGround: rectAt(onGround(dirAt(-0.25, 3.0)), size * 3),
        crater: rectAt(onGround(CRATER_DIR), size),
        building: rectAt(scale3(buildingDir, lookRadius(buildingDir) + 1.1), size),
        emissive: rectAt(scale3(sphereDir, lookRadius(sphereDir) + 0.55), size),
      };
    },
    async acne() {
      const sb = sandbox();
      if (!sb) throw new Error('sandbox not ready');
      const r = api.probes(72).litGround;
      const on = await sb.imageStats(r);
      api.setShadows(false);
      await frames(40);
      const off = await sb.imageStats(r);
      api.setShadows(true);
      await frames(40);
      const stdOn = Math.sqrt(on.variance), stdOff = Math.sqrt(off.variance);
      return { stdOn, stdOff, ratio: stdOn / Math.max(stdOff, 1e-6), meanOn: on.mean, meanOff: off.mean };
    },
    async tankShadow() {
      const sb = sandbox();
      if (!sb) throw new Error('sandbox not ready');
      const p = api.probes(16);
      const shadow = (await sb.imageStats(p.tankShadow)).mean;
      const open = (await sb.imageStats(p.openGround)).mean;
      return { shadow, open, ratio: shadow / Math.max(open, 1e-6) };
    },
    async terminator() {
      const sb = sandbox();
      if (!sb) throw new Error('sandbox not ready');
      const eng = sb.engine as unknown as { lastFrame: { eye: Vec3 } | null } | null;
      const eye = eng?.lastFrame?.eye ?? [0, 0, 72];
      const view = norm(eye);
      const dayP = scale3(norm(add3(scale3(view, 0.75), scale3(sun, 0.66))), RADIUS);
      const nightP = scale3(norm(add3(scale3(view, 0.75), scale3(sun, -0.66))), RADIUS);
      const day = (await sb.imageStats(rectAt(dayP, 40))).mean;
      const night = (await sb.imageStats(rectAt(nightP, 40))).mean;
      return { day, night, ratio: night / Math.max(day, 1e-6) };
    },
    async shimmer(n = 16) {
      const sb = sandbox();
      const sh = facet('sunShadows');
      if (!sb || !sh) throw new Error('sandbox not ready');
      const base = { ...cameras.shimmer };
      const f0: Vec3 = [...focus];
      const relocks0 = sh.stats().heroRelocks;
      sb.setCamera('shimmer');
      await frames(10);
      const probe = sh.probeShimmer(onGround(norm(add3(focus, scale3(shadowDir, 1.5)))), 3.5, n);
      for (let i = 0; i <= n + 2; i++) {
        // Slow orbit + a drifting focus (a driving tank: 0.03 u/frame) + a breathing boom inside one radius step.
        cameras.shimmer = { ...base, yaw: base.yaw + i * 0.01, distance: base.distance + Math.sin(i * 0.4) * 0.3 };
        const drift = add3(scale3(t, i * 0.03), scale3(b, i * 0.012));
        focus[0] = f0[0] + drift[0]; focus[1] = f0[1] + drift[1]; focus[2] = f0[2] + drift[2];
        sb.setCamera('shimmer');
        await frames(1);
      }
      const result = await probe;
      focus[0] = f0[0]; focus[1] = f0[1]; focus[2] = f0[2];
      cameras.shimmer = base;
      return { ...result, heroRelocks: sh.stats().heroRelocks - relocks0 };
    },
    async commit() {
      const sh = facet('sunShadows');
      if (!services || !sh) throw new Error('sandbox not ready');
      const c = onGround(CRATER_DIR);
      const r = CRATER.radius + 0.3;
      // Probe a disc reaching past the dirty bounds, so texels outside the scissor (kept by loadOp 'load') are watched too.
      const probeRadius = CRATER.radius + 1.2;
      await sh.probeShimmer(c, probeRadius, 1, 'static'); // warm-up: the probe pipeline is compiled once this resolves
      const renders0 = sh.stats().staticRenders;
      const probe = sh.probeShimmer(c, probeRadius, 8, 'static');
      await frames(3);
      services.events.emit('terrainCommitted', { dirtyBounds: { min: [c[0] - r, c[1] - r, c[2] - r], max: [c[0] + r, c[1] + r, c[2] + r] }, epoch: 1 });
      const result = await probe;
      return { ...result, staticRenders: sh.stats().staticRenders - renders0, drawn: caster?.drawn() ?? 0 };
    },
    stats() {
      return { shadows: facet('sunShadows')?.stats(), staticDraws: caster?.drawn(), atmosphere: facet('atmosphere')?.kind, kind };
    },
    async gpuMedians(n = 120) {
      type Capture = { pendingGpu: number; dump(): { stats: Record<string, { median: number } | null> } };
      const eng = sandbox()?.engine as unknown as { capture: { begin(frames: number): Capture; seal(): Capture | null } } | null;
      if (!eng) throw new Error('sandbox not ready');
      const cap = eng.capture.begin(n);
      await frames(n + 1);
      eng.capture.seal();
      for (let i = 0; i < 30 && cap.pendingGpu > 0; i++) await frames(1);
      const out: Record<string, number | null> = {};
      for (const [key, st] of Object.entries(cap.dump().stats)) if (key.startsWith('gpu/')) out[key.slice(4)] = st ? Math.round(st.median * 1000) / 1000 : null;
      return out;
    },
  };
  window.__tmtLook = api;
  return scene;
};

export default createLookScene;
