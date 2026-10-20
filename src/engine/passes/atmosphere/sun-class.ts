/**
 * Exact sun-visibility classes for air samples. Each 4³-voxel cell of the planet SDF is marked lit, dark or uncertain
 * for the two directional sun marches that run per air sample (`atmo_terrain_lit` in the aerial perspective and sky,
 * `volume_sun_visible` in the haze). A class is a proof over every point of the cell, every sun direction within the
 * drift allowance and every sample position the march can take, built from min/max bounds of the stored SDF texels
 * (trilinear filtering stays inside the bounds of its texels): consumers return the march's own answer from one fetch,
 * and run the unchanged march wherever a cell is uncertain (0).
 *
 * - lit: every sample the march can take keeps its clearance (aerial: d ≥ max(0.035·t, 0.025), so the soft term stays
 *   exactly 1; haze: d ≥ 0.015) and the march leaves within its step budget (each interval of the swept cell admits at
 *   most ⌈length / smallest step⌉ samples). The aerial march also reads 0.9 + the outside distance for a sample that
 *   rounds just past the domain face it exits through, so lit cells must exit within 0.9 / 0.035 u.
 *   Bits: 1 aerial lit, 2 aerial dark, 4 haze lit, 8 haze dark, 8–15 haze samples (the haze budget is per tier).
 * - dark: the swept cell crosses rock (aerial d < 0, haze d < 0.015) over a stretch longer than the longest step,
 *   before any exit, so some sample must land in it. Pending crater cuts can open that rock: consumers ignore dark
 *   while any cut is active.
 * - Cells are reclassified round-robin, one slice of z layers per frame, each with that frame's sun. The proofs allow a
 *   drift of SUN_CLASS_DRIFT radians; a slice whose sun is further from the current one clears the volume. An SDF
 *   change (build serial, view, or a commit that has not finished building) clears it until the bounds are rebuilt.
 */
import type { EngineServices, Vec3 } from '../../contracts';
import { BufferUsage, ShaderStage, TextureUsage } from '../../gpu/flags';
import { link, makeModule, wgslStruct } from '../../wgsl/module';

export const SUN_CLASS = { aerialLit: 1, aerialDark: 2, hazeLit: 4, hazeDark: 8 } as const;
/** SDF voxels per class cell edge (the SDF's own coarse grid). */
export const SUN_CLASS_CELL = 4;
export const SUN_CLASS_SLICES = 8;
/** Largest angle (rad) between the sun a slice was classified with and the sun it answers for. */
export const SUN_CLASS_DRIFT = 0.004;

export interface SunClassFacet { readonly view: GPUTextureView }
declare module '../../contracts' { interface SceneFacets { sunClass: SunClassFacet } }

export const SUN_CLASS_PARAMS = wgslStruct('SunClassParams', [
  ['sun', 'vec4f'],   // xyz unit sun direction of this slice, w chord bound of the drift (u per u of distance)
  ['grid', 'vec4f'],  // x cells per axis, y cell size (u), z domain half extent (u), w voxel (u)
  ['slice', 'vec4u'], // x first cell layer, y layers, zw unused
]);

/** The consumer side: `sun_class_at(p)` (0 outside the domain). Needs the sdf bindings for the grid geometry. */
export function sunClassLookupWgsl(group: number, binding: number) {
  return makeModule(`sun-class-lookup:${group}:${binding}`, /* wgsl */ `
@group(${group}) @binding(${binding}) var sun_class: texture_3d<u32>;
const SUN_CLASS_AERIAL_LIT: u32 = ${SUN_CLASS.aerialLit}u;
const SUN_CLASS_AERIAL_DARK: u32 = ${SUN_CLASS.aerialDark}u;
const SUN_CLASS_HAZE_LIT: u32 = ${SUN_CLASS.hazeLit}u;
const SUN_CLASS_HAZE_DARK: u32 = ${SUN_CLASS.hazeDark}u;
fn sun_class_at(p: vec3f) -> u32 {
  let g = textureDimensions(sun_class).x;
  let u = (p + vec3f(sdf_params.grid.z)) / (sdf_params.grid.y * ${SUN_CLASS_CELL}.0);
  if (any(u < vec3f(0.0)) || any(u >= vec3f(f32(g)))) { return 0u; }
  return textureLoad(sun_class, vec3u(u), 0).r;
}
/** Dark classes only hold while no crater cut is carved analytically into the field. */
fn sun_class_dark_valid() -> bool { return sdf_params.info.w < 0.5; }
`);
}

const buildCommon = /* wgsl */ `
@group(0) @binding(0) var<uniform> P: SunClassParams;
fn cells() -> u32 { return u32(P.grid.x); }
`;

/** Min and max stored distance of each cell's own 4³ texels (packed f16 pair). */
export const sunClassReduceWgsl = makeModule('sun-class-reduce', /* wgsl */ `
${buildCommon}
@group(0) @binding(1) var sdf_texels: texture_3d<f32>;
@group(0) @binding(2) var core_out: texture_storage_3d<r32uint, write>;
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (any(gid >= vec3u(cells()))) { return; }
  var lo = 1e30; var hi = -1e30;
  for (var z = 0u; z < ${SUN_CLASS_CELL}u; z++) { for (var y = 0u; y < ${SUN_CLASS_CELL}u; y++) { for (var x = 0u; x < ${SUN_CLASS_CELL}u; x++) {
    let v = textureLoad(sdf_texels, gid * ${SUN_CLASS_CELL}u + vec3u(x, y, z), 0).r;
    lo = min(lo, v); hi = max(hi, v);
  } } }
  // Exact for half-float texels; the widening keeps the f16 pair conservative for any finer volume format.
  let margin = max(max(abs(lo), abs(hi)) * 0.002, 1e-4);
  textureStore(core_out, gid, vec4u(pack2x16float(vec2f(lo - margin, hi + margin)), 0u, 0u, 0u));
}
`, [SUN_CLASS_PARAMS.module]);

/** Bounds over the 5³ cell neighbourhood: they cover the filter support of any box within 6.4 voxels of a cell. */
export const sunClassDilateWgsl = makeModule('sun-class-dilate', /* wgsl */ `
${buildCommon}
@group(0) @binding(1) var core_in: texture_3d<u32>;
@group(0) @binding(2) var dilated_out: texture_storage_3d<r32uint, write>;
@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let n = i32(cells());
  if (any(gid >= vec3u(cells()))) { return; }
  var lo = 1e30; var hi = -1e30;
  for (var z = -2; z <= 2; z++) { for (var y = -2; y <= 2; y++) { for (var x = -2; x <= 2; x++) {
    let c = vec3i(gid) + vec3i(x, y, z);
    if (any(c < vec3i(0)) || any(c >= vec3i(n))) { continue; }
    let v = unpack2x16float(textureLoad(core_in, c, 0).r);
    lo = min(lo, v.x); hi = max(hi, v.y);
  } } }
  textureStore(dilated_out, gid, vec4u(pack2x16float(vec2f(lo, hi)), 0u, 0u, 0u));
}
`, [SUN_CLASS_PARAMS.module]);

/**
 * One cell per invocation: the cell box swept along every sun within the drift, in intervals short enough that each
 * swept box stays within 6.2 voxels of its centre cell (so the dilated bounds cover it).
 */
export const sunClassClassifyWgsl = makeModule('sun-class-classify', /* wgsl */ `
${buildCommon}
@group(0) @binding(1) var dilated: texture_3d<u32>;
@group(0) @binding(2) var classes: texture_storage_3d<r32uint, write>;

/** (min, max) of the committed field over a world box: texel bounds inside the domain, 0.9 + the outside distance beyond. */
fn box_bounds(lo: vec3f, hi: vec3f) -> vec2f {
  let half = P.grid.z;
  var r = vec2f(1e30, -1e30);
  if (all(hi > vec3f(-half)) && all(lo < vec3f(half))) {
    let c = clamp(vec3i(floor(((lo + hi) * 0.5 + half) / P.grid.y)), vec3i(0), vec3i(i32(cells()) - 1));
    r = unpack2x16float(textureLoad(dilated, c, 0).r);
  }
  if (any(lo < vec3f(-half)) || any(hi > vec3f(half))) {
    let beyond = max(max(abs(lo), abs(hi)) - vec3f(half), vec3f(0.0));
    r = vec2f(min(r.x, 0.9), max(r.y, 0.9 + length(beyond)));
  }
  return r;
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (any(gid.xy >= vec2u(cells())) || gid.z >= P.slice.y) { return; }
  let cell = vec3u(gid.xy, gid.z + P.slice.x);
  if (cell.z >= cells()) { return; }
  let half = P.grid.z; let vox = P.grid.w;
  let s = P.sun.xyz; let drift = P.sun.w;
  let bmin = vec3f(cell) * P.grid.y - half - 1e-3;
  let bmax = bmin + P.grid.y + 2e-3;
  let sa = abs(s); let smax = max(sa.x, max(sa.y, sa.z));
  // Domain exit along any sun within the drift: the farthest (lit) and the nearest (dark) it can be. Along an axis
  // the sun cannot reverse, the exit face is the one it moves toward.
  var end_far = 1e30; var end_near = 1e30;
  for (var k = 0; k < 3; k++) {
    let ahead = select(half + bmin[k], half - bmax[k], s[k] > 0.0);
    if (sa[k] > drift) { end_far = min(end_far, select(bmax[k] + half, half - bmin[k], s[k] > 0.0) / (sa[k] - drift)); }
    let gap = select(half - max(abs(bmin[k]), abs(bmax[k])), ahead, sa[k] > drift);
    end_near = min(end_near, max(gap, 0.0) / (sa[k] + drift));
  }
  let radius = half;
  var a = 0.0;
  // Sample counts: within a span whose every point allows a step of at least s, samples lie s apart, so it holds at
  // most ⌈span / s⌉ of them. Spans merge intervals of similar step (seg.x span, seg.y step); counts close them.
  var lit = end_far * 0.035 <= 0.899; var lit_samples = 1.0; var lit_seg = vec2f(0.0, 4.0);
  var dark = false; var dark_run = 0.0;
  var haze_lit = true; var haze_samples = 0.0; var haze_seg = vec2f(0.0, 4.0); var haze_out = false;
  var haze_dark = false; var haze_run = 0.0;
  for (var j = 0u; j < 256u; j++) {
    // Half-width of the swept box: half the cell + |s|·len/2 + drift·(a + len) ≤ 6.2 voxels.
    let room = 6.2 * vox - (0.5 * P.grid.y + 1e-3) - drift * a;
    if (room <= 0.01 || a > 90.0) { break; }
    let len = room / (0.5 * smax + drift);
    let b = a + len;
    let lo = bmin + min(s * a, s * b) - vec3f(drift * b);
    let hi = bmax + max(s * a, s * b) + vec3f(drift * b);
    let v = box_bounds(lo, hi);
    if (a <= end_far) {
      if (lit) {
        lit = v.x >= max(0.035 * b, 0.025) * 1.002 + 1e-4;
        // The 1e-5 covers the rounding of t += step at t < 128.
        let step = clamp(v.x, 0.08, 4.0) - 1e-5;
        if (lit_seg.x > 0.0 && (step < 0.7 * lit_seg.y || step > 1.5 * lit_seg.y)) { lit_samples += ceil(lit_seg.x / lit_seg.y); lit_seg = vec2f(0.0, step); }
        lit_seg = vec2f(lit_seg.x + len, select(min(lit_seg.y, step), step, lit_seg.x == 0.0));
      }
      if (!dark) {
        if (v.y <= -1e-3 && b <= end_near) { dark_run += len; dark = dark_run >= 4.05; } else { dark_run = 0.0; }
      }
    }
    if (!haze_out) {
      let nearest = length(clamp(vec3f(0.0), lo, hi));
      let farthest = length(max(abs(lo), abs(hi)));
      let toward = dot(select(hi, lo, s > vec3f(0.0)), s);
      if (nearest > radius * 1.0001 && toward > drift * farthest + 1e-4) { haze_out = true; }
      else {
        if (haze_lit) {
          haze_lit = v.x >= 0.015 * 1.002 + 1e-4;
          let step = clamp(0.85 * v.x, 0.02, 4.0) - 1e-5;
          if (haze_seg.x > 0.0 && (step < 0.7 * haze_seg.y || step > 1.5 * haze_seg.y)) { haze_samples += ceil(haze_seg.x / haze_seg.y); haze_seg = vec2f(0.0, step); }
          haze_seg = vec2f(haze_seg.x + len, select(min(haze_seg.y, step), step, haze_seg.x == 0.0));
        }
        if (!haze_dark) {
          if (v.y <= 0.014 && farthest < radius) { haze_run += len; haze_dark = haze_run >= 4.05; } else { haze_run = 0.0; }
        }
      }
    }
    a = b;
    let aerial_done = a > end_far || (!lit && (dark || a > end_near));
    let haze_done = haze_out || (!haze_lit && (haze_dark || length(clamp(vec3f(0.0), lo, hi)) > radius));
    if (aerial_done && haze_done) { break; }
  }
  lit_samples += ceil(lit_seg.x / lit_seg.y); haze_samples += ceil(haze_seg.x / haze_seg.y);
  var bits = 0u;
  if (lit && a > end_far && lit_samples <= 47.0) { bits |= ${SUN_CLASS.aerialLit}u; }
  if (dark) { bits |= ${SUN_CLASS.aerialDark}u; }
  if (haze_lit && haze_out && haze_samples <= 255.0) { bits |= ${SUN_CLASS.hazeLit}u | (u32(haze_samples) << 8u); }
  if (haze_dark) { bits |= ${SUN_CLASS.hazeDark}u; }
  textureStore(classes, cell, vec4u(bits, 0u, 0u, 0u));
}

@compute @workgroup_size(4, 4, 4)
fn clear(@builtin(global_invocation_id) gid: vec3u) {
  if (any(gid >= vec3u(cells()))) { return; }
  textureStore(classes, gid, vec4u(0u));
}
`, [SUN_CLASS_PARAMS.module]);

export function sunClassShaders() {
  return { reduce: link(sunClassReduceWgsl), dilate: link(sunClassDilateWgsl), classify: link(sunClassClassifyWgsl) };
}

const angle = (a: Vec3, b: Vec3) => Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));

/**
 * Installs the class volume and its pass ('atmosphere.sunClass', slot 'ao', before every consumer) when the planet SDF
 * exists. Returns null otherwise (interiors), and consumers keep the plain marches.
 */
export function installSunClass(s: EngineServices, disposers: (() => void)[]): SunClassFacet | null {
  const sdf = s.scene.get('sdf');
  if (!sdf) return null;
  const { device, queue } = s.ctx;
  const C = ShaderStage.COMPUTE;
  const usage = TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING;
  const uni = { binding: 0, visibility: C, buffer: { type: 'uniform' as const } };
  const out = { binding: 2, visibility: C, storageTexture: { access: 'write-only' as const, format: 'r32uint' as const, viewDimension: '3d' as const } };
  const reduceLayout = device.createBindGroupLayout({ label: 'layout:sun-class-reduce', entries: [uni,
    { binding: 1, visibility: C, texture: { sampleType: 'unfilterable-float', viewDimension: '3d' } }, out] });
  const stepLayout = device.createBindGroupLayout({ label: 'layout:sun-class-step', entries: [uni,
    { binding: 1, visibility: C, texture: { sampleType: 'uint', viewDimension: '3d' } }, out] });
  const shaders = sunClassShaders();
  const keys = { reduce: 'sun-class:reduce', dilate: 'sun-class:dilate', classify: 'sun-class:classify', clear: 'sun-class:clear' } as const;
  const register = (key: string, layout: GPUBindGroupLayout, code: ReturnType<typeof link>, entryPoint: string) => {
    s.ctx.pipelines.register(key, 'compute', () => ({ label: key, layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module: s.ctx.pipelines.shaderModule(code, key), entryPoint } }));
    void s.ctx.pipelines.compile(key).catch(() => undefined);
  };
  register(keys.reduce, reduceLayout, shaders.reduce, 'main');
  register(keys.dilate, stepLayout, shaders.dilate, 'main');
  register(keys.classify, stepLayout, shaders.classify, 'main');
  register(keys.clear, stepLayout, shaders.classify, 'clear');

  const params = Array.from({ length: 2 }, (_, i) => device.createBuffer({ label: `atmosphere:sun-class-params:${i}`, size: SUN_CLASS_PARAMS.size, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST }));
  const staging = new ArrayBuffer(SUN_CLASS_PARAMS.size);
  let size = 0, core: GPUTexture | null = null, dilated: GPUTexture | null = null, classes: GPUTexture | null = null;
  let views: { core: GPUTextureView; dilated: GPUTextureView; classes: GPUTextureView } | null = null;
  const allocate = (n: number) => {
    const g = Math.max(1, Math.floor(n / SUN_CLASS_CELL));
    if (classes && size === g) return;
    for (const t of [core, dilated, classes]) s.ctx.deferDestroy(t);
    size = g;
    const make = (name: string) => device.createTexture({ label: `atmosphere:sun-class-${name}`, size: [g, g, g], dimension: '3d', format: 'r32uint', usage });
    core = make('core'); dilated = make('bounds'); classes = make('classes');
    views = { core: core.createView(), dilated: dilated.createView(), classes: classes.createView() };
  };
  allocate(sdf.size);
  const facet: SunClassFacet = { get view() { return views!.classes; } };
  s.scene.provide('sunClass', facet);

  // Validity bookkeeping: the bounds belong to one SDF build; each slice to the sun it was classified with.
  let boundsFor: { serial: number; view: GPUTextureView } | null = null, building = false, clearNeeded = true, cursor = 0;
  const sliceSun: (Vec3 | null)[] = new Array(SUN_CLASS_SLICES).fill(null);
  const invalidate = () => { boundsFor = null; clearNeeded = true; sliceSun.fill(null); };
  // A commit rewrites the volume when its build runs; until a build completes the old bounds may not describe it.
  for (const event of ['terrainCommitted', 'planetChanged', 'tierChanged'] as const) disposers.push(s.events.on(event, () => { building = true; invalidate(); }));
  let groupKey: unknown = null, groups: { reduce: GPUBindGroup; dilate: GPUBindGroup; clear: GPUBindGroup; classify: GPUBindGroup } | null = null;
  const bind = (sdfView: GPUTextureView) => {
    if (groupKey === sdfView && groups) return groups;
    groupKey = sdfView;
    const v = views!;
    const group = (layout: GPUBindGroupLayout, input: GPUTextureView, output: GPUTextureView, buffer: GPUBuffer) => device.createBindGroup({ layout, entries: [
      { binding: 0, resource: { buffer } }, { binding: 1, resource: input }, { binding: 2, resource: output }] });
    groups = { reduce: group(reduceLayout, sdfView, v.core, params[0]), dilate: group(stepLayout, v.core, v.dilated, params[0]),
      clear: group(stepLayout, v.dilated, v.classes, params[0]), classify: group(stepLayout, v.dilated, v.classes, params[1]) };
    return groups;
  };
  let lastSerial = sdf.serial;
  disposers.push(s.graph.addPass({
    name: 'atmosphere.sunClass', slot: 'ao', order: -40, reads: [], writes: [],
    enabled: () => !!s.scene.get('sdf')?.valid,
    run(c) {
      const field = s.scene.get('sdf');
      const pipes = { reduce: s.ctx.pipelines.get<GPUComputePipeline>(keys.reduce), dilate: s.ctx.pipelines.get<GPUComputePipeline>(keys.dilate),
        classify: s.ctx.pipelines.get<GPUComputePipeline>(keys.classify), clear: s.ctx.pipelines.get<GPUComputePipeline>(keys.clear) };
      if (!field?.valid || !pipes.reduce || !pipes.dilate || !pipes.classify || !pipes.clear) return;
      if (size !== Math.floor(field.size / SUN_CLASS_CELL)) { allocate(field.size); groups = null; invalidate(); }
      if (field.serial !== lastSerial) { lastSerial = field.serial; building = false; invalidate(); }
      if (boundsFor && boundsFor.view !== field.volumeView) invalidate();
      const sun = c.frame.sunDir as Vec3;
      if (sliceSun.some(v => v && angle(v, sun) > SUN_CLASS_DRIFT)) { clearNeeded = true; sliceSun.fill(null); }
      // Reclassifying a slice with the sun and the field it already describes would rewrite the same classes.
      const stale = sliceSun.findIndex(v => !v || v[0] !== sun[0] || v[1] !== sun[1] || v[2] !== sun[2]);
      if (stale >= 0 && sliceSun[cursor] && sliceSun[cursor]![0] === sun[0] && sliceSun[cursor]![1] === sun[1] && sliceSun[cursor]![2] === sun[2]) cursor = stale;
      const rebound = !boundsFor && !building;
      if (!clearNeeded && !rebound && (stale < 0 || !boundsFor)) return;
      const g = bind(field.volumeView);
      const groupsPerAxis = Math.ceil(size / 4);
      const ts = c.timestampWrites('atmosphere.sunClass') as GPUComputePassTimestampWrites | undefined;
      const pass = c.encoder.beginComputePass({ label: 'atmosphere.sunClass', ...(ts ? { timestampWrites: ts } : {}) });
      const voxel = 2 * field.half / field.size;
      if (clearNeeded || rebound) {
        SUN_CLASS_PARAMS.pack({ sun: [0, 0, 0, 0], grid: [size, voxel * SUN_CLASS_CELL, field.half, voxel], slice: [0, size, 0, 0] }, staging);
        queue.writeBuffer(params[0], 0, staging);
      }
      if (clearNeeded) {
        pass.setPipeline(pipes.clear); pass.setBindGroup(0, g.clear);
        pass.dispatchWorkgroups(groupsPerAxis, groupsPerAxis, groupsPerAxis);
        clearNeeded = false;
      }
      if (rebound) {
        pass.setPipeline(pipes.reduce); pass.setBindGroup(0, g.reduce); pass.dispatchWorkgroups(groupsPerAxis, groupsPerAxis, groupsPerAxis);
        pass.setPipeline(pipes.dilate); pass.setBindGroup(0, g.dilate); pass.dispatchWorkgroups(groupsPerAxis, groupsPerAxis, groupsPerAxis);
        boundsFor = { serial: field.serial, view: field.volumeView };
      }
      if (boundsFor && stale >= 0) {
        const layers = Math.ceil(size / SUN_CLASS_SLICES), first = cursor * layers;
        const chord = 2 * Math.sin(SUN_CLASS_DRIFT / 2);
        SUN_CLASS_PARAMS.pack({ sun: [...sun, chord], grid: [size, voxel * SUN_CLASS_CELL, field.half, voxel], slice: [first, layers, 0, 0] }, staging);
        queue.writeBuffer(params[1], 0, staging);
        pass.setPipeline(pipes.classify); pass.setBindGroup(0, g.classify);
        pass.dispatchWorkgroups(groupsPerAxis, groupsPerAxis, Math.ceil(layers / 4));
        sliceSun[cursor] = [sun[0], sun[1], sun[2]];
        cursor = (cursor + 1) % SUN_CLASS_SLICES;
      }
      pass.end();
    },
  }));
  disposers.push(() => { for (const r of [core, dilated, classes, ...params]) s.ctx.deferDestroy(r); });
  return facet;
}
