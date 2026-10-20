/**
 * Diffuse GI probes traced against the planet SDF (docs/visibility-architecture.md), High and Ultra only.
 *
 * - A G³ grid over the SDF domain (G = 32: 1.53 u spacing). A probe is active while it sits in air within GI_REACH of a
 *   surface; a probe just inside rock is pushed out along the SDF gradient (up to 0.45 spacing), otherwise it idles.
 * - Each frame a round-robin slice of probes traces 64 rays (spherical Fibonacci, rotated per frame). A hit reflects
 *   its material albedo (the terrain material id kept in the SDF band) × the sun's irradiance there, with a soft SDF sun
 *   shadow, plus a dim sky term; a miss escapes to the sky. The rays are projected to L1 irradiance SH (bounce, RGB) and
 *   a cosine-convolved escape fraction (sky visibility), blended into the history (hysteresis GI_HYSTERESIS).
 * - The source of truth is a storage buffer (read-modify-write); the reserved `gi` texture is rewritten from it.
 * Lighting adds the bounce and scales the sky irradiance by the visibility (gi.wgsl.ts `gi_sample`).
 */
import type { EngineServices, PlanetDesc, QualityTier, RenderModule } from '../../contracts';
import { BufferUsage, ShaderStage, TextureUsage } from '../../gpu/flags';
import { createFrameBindGroup } from '../gbuffer/gbuffer';
import { frameWgsl } from '../../wgsl/common/frame.wgsl';
import { link, makeModule } from '../../wgsl/module';
import { sdfBindingsWgsl, sdfWgsl } from '../sdf/sdf.wgsl';
import { SDF_HALF_EXTENT } from '../sdf/sdf-volume';
import { GI_PARAMS, GI_TEXELS_PER_PROBE } from './gi.wgsl';

export const GI_GRID = 32;
export const GI_RAYS = 64;
/** Probes further than this from any surface (u) stay idle: nothing there needs indirect light. */
export const GI_REACH = 3.2;
export const GI_HYSTERESIS = 0.12;
/** Probes updated per frame by tier (0 = GI off). */
export const GI_TIER_PROBES: Readonly<Record<QualityTier, number>> = { low: 0, medium: 0, high: 2048, ultra: 4096 };

/** Albedo by terrain material id (1 planet by kind, 2 bedrock, 3 structure); linear. */
const PLANET_ALBEDO: Record<PlanetDesc['kind'], [number, number, number]> = {
  temperate: [0.24, 0.28, 0.16], glacial: [0.62, 0.66, 0.72], dune: [0.5, 0.36, 0.24], volcanic: [0.16, 0.13, 0.12],
};

const probeShader = makeModule('gi-probe-update', /* wgsl */ `
struct GiUpdate {
  grid: vec4f,      // x G, y spacing, z half, w frame
  work: vec4u,      // x first probe, y count, z rays, w max steps
  sun: vec4f,       // xyz toward the sun, w sun irradiance (the frame's sun illuminance)
  albedo: array<vec4f, 4>, // by material id 0..3
  sky: vec4f,       // rgb sky irradiance scale at a hit (day), w hysteresis
}
@group(1) @binding(0) var<uniform> U: GiUpdate;
@group(1) @binding(1) var<storage, read_write> probes: array<vec4f>;
@group(1) @binding(2) var gi_out: texture_storage_2d_array<rgba16float, write>;
@group(1) @binding(3) var<storage, read> sdf_band: array<u32>;

var<workgroup> acc: array<array<vec4f, 4>, ${GI_RAYS}>;  // per ray: (r, g, b, escape) × SH (c0, c1x, c1y, c1z)
var<workgroup> probe_state: vec4f;

fn fib_dir(i: f32, n: f32, rot: f32) -> vec3f {
  let z = 1.0 - (2.0 * i + 1.0) / n;
  let r = sqrt(max(0.0, 1.0 - z * z));
  let phi = i * 2.39996323 + rot;
  return vec3f(r * cos(phi), r * sin(phi), z);
}

fn material_at(p: vec3f) -> u32 {
  let n = u32(sdf_params.grid.x);
  let c = clamp(vec3i(floor((p + sdf_params.grid.z) / sdf_params.grid.y)), vec3i(0), vec3i(i32(n) - 1));
  return min(sdf_band[(u32(c.z) * n + u32(c.y)) * n + u32(c.x)] & 15u, 3u);
}

@compute @workgroup_size(${GI_RAYS})
fn update(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let g = u32(U.grid.x);
  let total = g * g * g;
  let index = (U.work.x + wg.x) % total;
  let cell = vec3u(index % g, (index / g) % g, index / (g * g));
  let sp = U.grid.y;
  let centre = (vec3f(cell) + 0.5) * sp - U.grid.z;
  let base = index * ${GI_TEXELS_PER_PROBE}u;
  if (li == 0u) {
    // Classify: in air near a surface, or pushed out of shallow rock along the gradient.
    var state = vec4f(0.0);
    let d = sdf_sample(centre);
    if (d > 0.1 && d < ${GI_REACH}) { state = vec4f(0.0, 0.0, 0.0, 1.0); }
    else if (d <= 0.1 && d > -0.45 * sp) {
      let off = sdf_normal(centre) * (0.35 - d);
      if (length(off) < 0.45 * sp && sdf_sample(centre + off) > 0.1) { state = vec4f(off, 1.0); }
    }
    probe_state = state;
  }
  workgroupBarrier();
  let state = probe_state;
  let origin = centre + state.xyz;
  var contribution = vec4f(0.0);
  let dir = fib_dir(f32(li), f32(U.work.z), U.grid.w * 2.39996323);
  if (state.w > 0.5) {
    var t = 0.06;
    var hit = false;
    for (var i = 0u; i < U.work.w; i++) {
      let q = origin + dir * t;
      let h = sdf_sample(q);
      if (h < 0.02) { hit = true; break; }
      t += h;
      if (t > 14.0 || (dot(q, q) > U.grid.z * U.grid.z && dot(q, dir) > 0.0)) { break; }
    }
    if (hit) {
      let q = origin + dir * t;
      let n = sdf_normal(q);
      let albedo = U.albedo[material_at(q)].rgb;
      let up = normalize(q);
      let day = smoothstep(-0.12, 0.25, dot(up, U.sun.xyz));
      let ndl = max(dot(n, U.sun.xyz), 0.0);
      var sun = 0.0;
      if (ndl > 0.0 && day > 0.0) { sun = sdf_vis_dir(q + n * (sdf_params.grid.y * 0.75), U.sun.xyz, 0.05, sdf_params.grid.y, 32u); }
      let irradiance = vec3f(U.sun.w * ndl * sun * day) * vec3f(1.0, 0.93, 0.82) + U.sky.rgb * (0.4 + 0.6 * day) * (0.5 + 0.5 * dot(n, up));
      contribution = vec4f(albedo * irradiance / 3.14159265, 0.0);
    } else {
      contribution = vec4f(0.0, 0.0, 0.0, 1.0);
    }
  }
  // Monte Carlo SH projection over the sphere: c = 4π/N Σ L(ω) Y(ω).
  let y0 = 0.282095;
  let y1 = 0.488603 * dir;
  acc[li][0] = contribution * y0;
  acc[li][1] = contribution * y1.x;
  acc[li][2] = contribution * y1.y;
  acc[li][3] = contribution * y1.z;
  workgroupBarrier();
  if (li != 0u) { return; }
  var c = array<vec4f, 4>(vec4f(0.0), vec4f(0.0), vec4f(0.0), vec4f(0.0));
  for (var r = 0u; r < U.work.z; r++) { for (var k = 0u; k < 4u; k++) { c[k] += acc[r][k]; } }
  let scale = 4.0 * 3.14159265 / f32(U.work.z);
  // Irradiance E(n) = π·Y00·c0 + (2π/3)·0.488603·(c1 · n); the visibility is E/π of the escape indicator.
  let a = c[0] * (scale * 3.14159265 * y0);
  let bx = c[1] * (scale * 2.0943951 * 0.488603);
  let by = c[2] * (scale * 2.0943951 * 0.488603);
  let bz = c[3] * (scale * 2.0943951 * 0.488603);
  var next: array<vec4f, 5>;
  next[0] = vec4f(a.x, bx.x, by.x, bz.x);
  next[1] = vec4f(a.y, bx.y, by.y, bz.y);
  next[2] = vec4f(a.z, bx.z, by.z, bz.z);
  next[3] = vec4f(a.w, bx.w, by.w, bz.w) / 3.14159265;
  next[4] = state;
  let was = probes[base + 4u];
  let fresh = was.w < 0.5 || distance(was.xyz, state.xyz) > 0.05;
  let alpha = select(U.sky.w, 1.0, fresh);
  for (var k = 0u; k < ${GI_TEXELS_PER_PROBE}u; k++) {
    var v = next[k];
    if (k < 4u && state.w > 0.5) { v = mix(probes[base + k], next[k], alpha); }
    if (state.w < 0.5) { v = vec4f(0.0); }
    probes[base + k] = v;
    textureStore(gi_out, vec2u(cell.x * ${GI_TEXELS_PER_PROBE}u + k, cell.y), cell.z, v);
  }
}
`, [frameWgsl, sdfBindingsWgsl(2, { volume: 0, params: 1, sampler: 2 }), sdfWgsl]);

export function giProbesModule(): RenderModule {
  const disposers: (() => void)[] = [];
  return {
    name: 'gi-probes',
    install(s: EngineServices) {
      const { device, queue } = s.ctx;
      const C = ShaderStage.COMPUTE;
      const g = GI_GRID;
      const spacing = (2 * SDF_HALF_EXTENT) / g;
      const layout = device.createBindGroupLayout({ label: 'layout:gi-probes', entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: { type: 'storage' } },
        { binding: 2, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d-array' } },
        { binding: 3, visibility: C, buffer: { type: 'read-only-storage' } },
      ] });
      const sdfLayout = device.createBindGroupLayout({ label: 'layout:gi-sdf', entries: [
        { binding: 0, visibility: C, texture: { sampleType: 'float', viewDimension: '3d' } },
        { binding: 1, visibility: C, buffer: { type: 'uniform' } },
        { binding: 2, visibility: C, sampler: { type: 'filtering' } },
      ] });
      const key = 'gi:probe-update';
      s.ctx.pipelines.register(key, 'compute', () => ({
        label: key, layout: device.createPipelineLayout({ bindGroupLayouts: [s.ctx.layouts.frame, layout, sdfLayout] }),
        compute: { module: s.ctx.pipelines.shaderModule(link(probeShader), key), entryPoint: 'update' },
      }));
      void s.ctx.pipelines.compile(key).catch(() => undefined);
      const sampler = device.createSampler({ label: 'gi:linear', magFilter: 'linear', minFilter: 'linear',
        addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge' });
      const frameGroup = createFrameBindGroup(s, 'gi');
      const updateBuffer = device.createBuffer({ label: 'gi:update', size: 144, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      const paramsBuffer = device.createBuffer({ label: 'gi:params', size: 256, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      let probes: GPUBuffer | null = null, texture: GPUTexture | null = null, view: GPUTextureView | null = null;
      let cursor = 0, valid = false, reset = true, serial = -1, refresh = 0;
      disposers.push(s.events.on('planetChanged', () => { reset = true; valid = false; cursor = 0; }));
      const allocate = () => {
        if (texture) return;
        probes = device.createBuffer({ label: 'gi:probes', size: g * g * g * GI_TEXELS_PER_PROBE * 16, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST });
        texture = device.createTexture({ label: 'gi:probes', size: [g * GI_TEXELS_PER_PROBE, g, g], format: 'rgba16float',
          usage: TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING });
        view = texture.createView({ dimension: '2d-array' });
        s.bindings.provide('gi', { probes: view, params: { buffer: paramsBuffer } });
      };
      const staging = new ArrayBuffer(GI_PARAMS.size);
      let sdfGroup: GPUBindGroup | null = null, sdfKey: unknown = null;
      disposers.push(s.graph.addPass({
        name: 'gi.probes', slot: 'shadows', order: 20, reads: [], writes: [],
        enabled: f => GI_TIER_PROBES[f.tier] > 0 && !!s.scene.get('sdf')?.valid && s.scene.get('lighting')?.toggles.gi !== false,
        run(c) {
          const pipe = s.ctx.pipelines.get<GPUComputePipeline>(key);
          const sdf = s.scene.get('sdf');
          if (!pipe || !sdf) return;
          allocate();
          const total = g * g * g;
          if (reset) { c.encoder.clearBuffer(probes!); reset = false; }
          if (serial !== sdf.serial) { serial = sdf.serial; refresh = total; }
          const count = Math.min(GI_TIER_PROBES[c.frame.tier], total);
          const blend = refresh > 0 ? 1 : GI_HYSTERESIS;
          const sun = s.scene.get('sun');
          const planet = s.scene.get('planet');
          const albedo = PLANET_ALBEDO[planet?.kind ?? 'temperate'];
          const u = new ArrayBuffer(144);
          new Float32Array(u, 0, 4).set([g, spacing, SDF_HALF_EXTENT, c.frame.index % 997]);
          new Uint32Array(u, 16, 4).set([cursor, count, 64, 40]);
          new Float32Array(u, 32, 4).set([...c.frame.sunDir, sun?.illuminance ?? 20]);
          new Float32Array(u, 48, 16).set([...albedo, 0, ...albedo, 0, 0.3, 0.28, 0.26, 0, 0.45, 0.44, 0.42, 0]);
          new Float32Array(u, 112, 4).set([0.35, 0.42, 0.55, blend]);
          queue.writeBuffer(updateBuffer, 0, u);
          GI_PARAMS.pack({ grid: [g, spacing, SDF_HALF_EXTENT, valid ? 1 : 0], shade: [1, 1, GI_RAYS, c.frame.index], tier: [count, cursor, GI_HYSTERESIS, 0] }, staging);
          queue.writeBuffer(paramsBuffer, 0, staging);
          const r = s.bindings.get('sdf');
          if (sdfKey !== r.volume) {
            sdfKey = r.volume;
            sdfGroup = device.createBindGroup({ label: 'gi:sdf', layout: sdfLayout, entries: [
              { binding: 0, resource: r.volume }, { binding: 1, resource: r.params }, { binding: 2, resource: sampler }] });
          }
          const ts = c.timestampWrites('gi.probes') as GPUComputePassTimestampWrites | undefined;
          const pass = c.encoder.beginComputePass({ label: 'gi.probes', ...(ts ? { timestampWrites: ts } : {}) });
          pass.setPipeline(pipe);
          pass.setBindGroup(0, frameGroup);
          pass.setBindGroup(1, device.createBindGroup({ layout, entries: [
            { binding: 0, resource: { buffer: updateBuffer } }, { binding: 1, resource: { buffer: probes! } },
            { binding: 2, resource: view! }, { binding: 3, resource: { buffer: sdf.band } }] }));
          pass.setBindGroup(2, sdfGroup!);
          pass.dispatchWorkgroups(count);
          pass.end();
          cursor = (cursor + count) % total;
          refresh = Math.max(0, refresh - count);
          // Valid once every probe has been visited at least once.
          if (!valid && cursor < count) valid = true;
        },
      }));
      disposers.push(() => { for (const r of [updateBuffer, paramsBuffer, probes, texture]) s.ctx.deferDestroy(r); });
    },
    dispose() { for (const d of disposers.splice(0).reverse()) d(); },
  };
}
