/**
 * SDF ambient occlusion (docs/visibility-architecture.md): the reserved `ao` texture, half resolution, from cone traces
 * through the planet SDF at one jittered pixel per 2×2 block (the cones rotate per frame; TAA converges both).
 * Low traces 5 taps along the normal instead of 6 cones. Lighting multiplies ambient diffuse and specular only.
 * The cones see the tank bricks (sdf-casters.ts) as well as the planet SDF, so tanks darken the ground under them.
 */
import type { EngineServices, RenderModule } from '../../contracts';
import { ShaderStage, TextureUsage } from '../../gpu/flags';
import { createFrameBindGroup } from '../gbuffer/gbuffer';
import { depthWgsl } from '../../wgsl/common/depth.wgsl';
import { frameWgsl } from '../../wgsl/common/frame.wgsl';
import { gbufferWgsl } from '../../wgsl/common/gbuffer.wgsl';
import { link, makeModule } from '../../wgsl/module';
import { sdfBindingsWgsl, sdfWgsl } from '../sdf/sdf.wgsl';
import { CASTER_BRICK, sdfCastersWgsl } from '../sdf/sdf-casters';

/** Occlusion reach (u): crater floors, valleys, building bases and tank undersides (the near-exact SDF reaches 3 u). */
export const SDF_AO_REACH = 3.0;

export function aoShader(format: GPUTextureFormat) {
  return makeModule(`sdf-ao:${format}`, /* wgsl */ `
@group(1) @binding(0) var gb_depth: texture_depth_2d;
@group(1) @binding(1) var gb_normals: texture_2d<f32>;
@group(1) @binding(2) var gb_ids: texture_2d<u32>;
@group(1) @binding(3) var ao_out: texture_storage_2d<${format}, write>;

/** The occluding distance: the planet SDF, or a tank brick in mask when nearer. */
fn ao_distance(q: vec3f, mask: u32) -> f32 {
  var d = sdf_sample(q);
  var m = mask;
  while (m != 0u) {
    let i = firstTrailingBit(m);
    m &= m - 1u;
    // A brick is never nearer than its bounding sphere less its skin (half a voxel diagonal; two allowed here): one
    // that cannot come below d leaves the minimum unchanged.
    let sphere = caster_sphere(i);
    if (length(q - sphere.xyz) - sphere.w - length(1.0 / caster_list.items[i * 7u + 4u].xyz) * ${(2 / CASTER_BRICK).toFixed(8)} > d) { continue; }
    d = min(d, caster_distance(i, q));
  }
  return d;
}

/** Cone-traced occlusion over the hemisphere of n: 6 cones × 5 steps out to reach. rot: per-pixel rotation. */
fn ao_cones(p: vec3f, n: vec3f, rot: f32, reach: f32, mask: u32) -> f32 {
  let a = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(n.y) > 0.9);
  let tx = normalize(cross(a, n));
  let ty = cross(n, tx);
  let origin = p + n * (sdf_params.grid.y * 0.3);
  var vis = 0.0;
  for (var c = 0u; c < 6u; c++) {
    let phi = rot + f32(c) * 1.0471976;
    let ct = select(0.55, 0.85, (c & 1u) == 1u);
    let d = normalize(n * ct + (tx * cos(phi) + ty * sin(phi)) * sqrt(1.0 - ct * ct));
    var cv = 1.0;
    var s = reach * 0.08;
    for (var k = 0u; k < 5u; k++) {
      cv = min(cv, ao_distance(origin + d * s, mask) / (s * 0.55));
      // A running minimum at or below zero clamps to zero whatever the remaining taps read.
      if (cv <= 0.0) { break; }
      s *= 1.9;
    }
    vis += clamp(cv, 0.0, 1.0);
  }
  return vis / 6.0;
}

/** Cheap 5-tap occlusion along the normal (Low tier). */
fn ao_cheap(p: vec3f, n: vec3f, reach: f32, mask: u32) -> f32 {
  var occ = 0.0;
  var w = 1.0;
  for (var i = 0u; i < 5u; i++) {
    let h = reach * (0.06 + 0.235 * f32(i));
    occ += (h - ao_distance(p + n * h, mask)) * w;
    w *= 0.7;
  }
  return clamp(1.0 - 1.2 * occ / reach, 0.0, 1.0);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let hs = textureDimensions(ao_out);
  if (gid.x >= hs.x || gid.y >= hs.y) { return; }
  let full = vec2u(frame_internal_size());
  let f = frame_index() % 4u;
  let px = min(gid.xy * 2u + vec2u(select(0u, 1u, f == 1u || f == 2u), select(0u, 1u, f == 1u || f == 3u)), full - vec2u(1u));
  let d = textureLoad(gb_depth, px, 0);
  let class_id = gbuffer_class(textureLoad(gb_ids, px, 0).r);
  if (d <= 0.0 || !sdf_valid() || class_id == CLASS_SKY) { textureStore(ao_out, gid.xy, vec4f(1.0)); return; }
  let p = world_pos_from_depth((vec2f(px) + 0.5) / vec2f(full), d);
  // Cones about the smooth SDF normal on the coarse terrain: its flat facet normal would turn them at every triangle
  // edge and print the mesh into the occlusion (and the sculpted fog veil that uses it). Flat-faced objects keep theirs.
  let ns = oct_decode(textureLoad(gb_normals, px, 0).xy);
  let n = select(ns, sdf_normal_smooth(p, 0.5, ns), class_id == CLASS_TERRAIN || class_id == CLASS_GRASS);
  let rot = fract(52.9829189 * fract(0.06711056 * f32(px.x) + 0.00583715 * f32(px.y)) + 0.61803399 * f32(frame_index() % 32u)) * 6.2831853;
  let mask = casters_near(p, ${SDF_AO_REACH});
  var ao: f32;
  if (frame_tier() == 0u) { ao = ao_cheap(p, n, ${SDF_AO_REACH}, mask); }
  else { ao = ao_cones(p, n, rot, ${SDF_AO_REACH}, mask); }
  textureStore(ao_out, gid.xy, vec4f(mix(0.25, 1.0, ao)));
}
`, [frameWgsl, depthWgsl, gbufferWgsl, sdfBindingsWgsl(2, { volume: 0, params: 1, sampler: 2 }), sdfWgsl, sdfCastersWgsl(2, 3, 4)]);
}

export function sdfAoModule(): RenderModule {
  const disposers: (() => void)[] = [];
  return {
    name: 'sdf-ao',
    install(s: EngineServices) {
      const { device } = s.ctx;
      const C = ShaderStage.COMPUTE;
      const format: GPUTextureFormat = device.features.has('texture-formats-tier1') ? 'r8unorm' : 'rgba8unorm';
      const inputLayout = device.createBindGroupLayout({ label: 'layout:sdf-ao', entries: [
        { binding: 0, visibility: C, texture: { sampleType: 'depth' } },
        { binding: 1, visibility: C, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: C, texture: { sampleType: 'uint' } },
        { binding: 3, visibility: C, storageTexture: { access: 'write-only', format } },
      ] });
      const sdfLayout = device.createBindGroupLayout({ label: 'layout:sdf-ao-sdf', entries: [
        { binding: 0, visibility: C, texture: { sampleType: 'float', viewDimension: '3d' } },
        { binding: 1, visibility: C, buffer: { type: 'uniform' } },
        { binding: 2, visibility: C, sampler: { type: 'filtering' } },
        { binding: 3, visibility: C, texture: { sampleType: 'float', viewDimension: '3d' } },
        { binding: 4, visibility: C, buffer: { type: 'uniform' } },
      ] });
      const sampler = device.createSampler({ label: 'sdf-ao:linear', magFilter: 'linear', minFilter: 'linear',
        addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge' });
      const key = `sdf-ao:${format}`;
      s.ctx.pipelines.register(key, 'compute', () => ({
        label: key, layout: device.createPipelineLayout({ bindGroupLayouts: [s.ctx.layouts.frame, inputLayout, sdfLayout] }),
        compute: { module: s.ctx.pipelines.shaderModule(link(aoShader(format)), key), entryPoint: 'main' },
      }));
      void s.ctx.pipelines.compile(key).catch(() => undefined);
      const frameGroup = createFrameBindGroup(s, 'sdf-ao');
      let texture: GPUTexture | null = null, view: GPUTextureView | null = null, size = [0, 0];
      const allocate = (w: number, h: number) => {
        const hw = Math.max(1, Math.ceil(w / 2)), hh = Math.max(1, Math.ceil(h / 2));
        if (texture && size[0] === hw && size[1] === hh) return;
        s.ctx.deferDestroy(texture);
        texture = device.createTexture({ label: 'sdf-ao', size: [hw, hh], format, usage: TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING });
        view = texture.createView();
        size = [hw, hh];
        s.bindings.provide('ao', { ao: view });
      };
      let sdfGroup: GPUBindGroup | null = null, sdfKey: unknown = null;
      disposers.push(s.graph.addPass({
        name: 'ao.sdf', slot: 'ao', order: 0, reads: ['frameUniforms', 'depth', 'normals', 'ids'], writes: [],
        enabled: () => !!s.scene.get('sdf')?.valid && s.scene.get('lighting')?.ao !== false,
        run(c) {
          const pipe = s.ctx.pipelines.get<GPUComputePipeline>(key);
          if (!pipe) return;
          allocate(...c.frame.internal);
          const sdf = s.bindings.get('sdf');
          const casters = s.scene.get('sdfCasters');
          if (!casters) return;
          if (sdfKey !== sdf.volume) {
            sdfKey = sdf.volume;
            sdfGroup = device.createBindGroup({ label: 'sdf-ao:sdf', layout: sdfLayout, entries: [
              { binding: 0, resource: sdf.volume }, { binding: 1, resource: sdf.params }, { binding: 2, resource: sampler },
              { binding: 3, resource: casters.atlasView }, { binding: 4, resource: { buffer: casters.listBuffer } }] });
          }
          const r = c.resources;
          const ts = c.timestampWrites('ao.sdf') as GPUComputePassTimestampWrites | undefined;
          const pass = c.encoder.beginComputePass({ label: 'ao.sdf', ...(ts ? { timestampWrites: ts } : {}) });
          pass.setPipeline(pipe);
          pass.setBindGroup(0, frameGroup);
          pass.setBindGroup(1, device.createBindGroup({ layout: inputLayout, entries: [
            { binding: 0, resource: r.view('depth') }, { binding: 1, resource: r.view('normals') }, { binding: 2, resource: r.view('ids') },
            { binding: 3, resource: view! }] }));
          pass.setBindGroup(2, sdfGroup!);
          pass.dispatchWorkgroups(Math.ceil(size[0] / 8), Math.ceil(size[1] / 8));
          pass.end();
        },
      }));
      disposers.push(() => s.ctx.deferDestroy(texture));
    },
    dispose() { for (const d of disposers.splice(0).reverse()) d(); },
  };
}
