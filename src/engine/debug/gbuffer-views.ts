/**
 * G-buffer debug views, selected by `settings.gbufferView`: albedo, normal (shading), geonormal, material
 * (roughness, metalness, emissive), ids (hashed class|flags|objectId), velocity ×50, depth (log). A compute pass in the
 * 'composite' slot (order 50) overwrites 'ldr' after the composite, so imageStats and the present blit see the view.
 */
import type { EngineServices, GBufferView, RenderModule } from '../contracts';
import { BindGroupResourceCache } from '../gpu/bind-group-cache';
import { BufferUsage, ShaderStage } from '../gpu/flags';
import { LDR_FORMAT } from '../passes/post/composite';
import { createFrameBindGroup } from '../passes/gbuffer/gbuffer';
import { depthWgsl } from '../wgsl/common/depth.wgsl';
import { frameWgsl } from '../wgsl/common/frame.wgsl';
import { gbufferWgsl } from '../wgsl/common/gbuffer.wgsl';
import { link, makeModule } from '../wgsl/module';

export const GBUFFER_VIEW_MODES: Record<Exclude<GBufferView, 'none'>, number> = {
  albedo: 1, normal: 2, geonormal: 3, material: 4, ids: 5, velocity: 6, depth: 7,
};

const viewShader = makeModule('gbuffer-views', /* wgsl */ `
@group(1) @binding(0) var gb_albedo_ao: texture_2d<f32>;
@group(1) @binding(1) var gb_normals: texture_2d<f32>;
@group(1) @binding(2) var gb_material: texture_2d<f32>;
@group(1) @binding(3) var gb_ids: texture_2d<u32>;
@group(1) @binding(4) var gb_depth: texture_depth_2d;
@group(1) @binding(5) var gb_velocity: texture_2d<f32>;
@group(1) @binding(6) var ldr_out: texture_storage_2d<rgba8unorm, write>;
@group(1) @binding(7) var<uniform> view_mode: vec4u;

fn srgb(c: vec3f) -> vec3f {
  let x = clamp(c, vec3f(0.0), vec3f(1.0));
  return select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, 12.92 * x, x <= vec3f(0.0031308));
}
fn hash_color(v: u32) -> vec3f {
  var h = v * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  h = (h >> 22u) ^ h;
  return vec3f(f32(h & 0xFFu), f32((h >> 8u) & 0xFFu), f32((h >> 16u) & 0xFFu)) / 255.0 * 0.8 + 0.2;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let display = frame_display_size();
  if (f32(gid.x) >= display.x || f32(gid.y) >= display.y) { return; }
  let internal = frame_internal_size();
  let ip = min(vec2u((vec2f(gid.xy) + 0.5) * internal / display), vec2u(internal) - vec2u(1u));
  let ids = textureLoad(gb_ids, ip, 0).r;
  let sky = gbuffer_class(ids) == CLASS_SKY;
  var o = vec3f(0.06);
  switch view_mode.x {
    case 1u: { if (!sky) { o = srgb(textureLoad(gb_albedo_ao, ip, 0).rgb); } }
    case 2u: { if (!sky) { o = oct_decode(textureLoad(gb_normals, ip, 0).xy) * 0.5 + 0.5; } }
    case 3u: { if (!sky) { o = oct_decode(textureLoad(gb_normals, ip, 0).zw) * 0.5 + 0.5; } }
    case 4u: { if (!sky) { let m = textureLoad(gb_material, ip, 0); o = vec3f(m.r, m.g, m.a); } }
    case 5u: { o = select(hash_color(ids & 0xFFFFFu), vec3f(0.0), sky); }
    case 6u: { let v = textureLoad(gb_velocity, ip, 0).xy; o = select(vec3f(0.5 + v * 50.0, 0.5), vec3f(0.5), sky); }
    case 7u: {
      let d = textureLoad(gb_depth, ip, 0);
      if (d > 0.0) {
        // Linear distance on a log scale: 0.5 u (white) → 128 u (black).
        let t = clamp(log2(max(linear_depth(d), 0.5) / 0.5) / 8.0, 0.0, 1.0);
        o = vec3f(1.0 - t);
      } else { o = vec3f(0.0); }
    }
    default: { }
  }
  textureStore(ldr_out, vec2i(gid.xy), vec4f(clamp(o, vec3f(0.0), vec3f(1.0)), 1.0));
}
`, [frameWgsl, depthWgsl, gbufferWgsl]);

export function gbufferViewShader() { return link(viewShader); }

export function gbufferViewModule(): RenderModule {
  const disposers: (() => void)[] = [];
  return {
    name: 'debug.gbuffer-views',
    install(s: EngineServices) {
      const { device, queue } = s.ctx;
      const C = ShaderStage.COMPUTE;
      const layout = device.createBindGroupLayout({
        label: 'layout:gbuffer-views',
        entries: [
          ...[0, 1, 2].map(binding => ({ binding, visibility: C, texture: { sampleType: 'unfilterable-float' as GPUTextureSampleType } })),
          { binding: 3, visibility: C, texture: { sampleType: 'uint' } },
          { binding: 4, visibility: C, texture: { sampleType: 'depth' } },
          { binding: 5, visibility: C, texture: { sampleType: 'unfilterable-float' } },
          { binding: 6, visibility: C, storageTexture: { access: 'write-only', format: LDR_FORMAT } },
          { binding: 7, visibility: C, buffer: { type: 'uniform' } },
        ],
      });
      const key = 'debug:gbuffer-views';
      s.ctx.pipelines.register(key, 'compute', () => ({
        label: key, layout: device.createPipelineLayout({ bindGroupLayouts: [s.ctx.layouts.frame, layout] }),
        compute: { module: s.ctx.pipelines.shaderModule(gbufferViewShader(), key), entryPoint: 'main' },
      }));
      const mode = device.createBuffer({ label: 'debug:gbuffer-view-mode', size: 16, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      const frameGroup = createFrameBindGroup(s, 'gbuffer-views');
      const groups = new BindGroupResourceCache(4);
      const names = ['albedoAo', 'normals', 'material', 'ids', 'depth', 'velocity', 'ldr'] as const;
      disposers.push(s.graph.addPass({
        name: 'debug.gbuffer-view', slot: 'composite', order: 50,
        reads: ['frameUniforms', 'albedoAo', 'normals', 'material', 'ids', 'depth', 'velocity'], writes: ['ldr'],
        enabled: () => s.settings.gbufferView !== 'none',
        run(c) {
          const m = s.settings.gbufferView === 'none' ? 0 : GBUFFER_VIEW_MODES[s.settings.gbufferView] ?? 0;
          const pipeline = s.ctx.pipelines.get<GPUComputePipeline>(key);
          if (!pipeline) { void s.ctx.pipelines.compile(key).catch(() => undefined); return; }
          queue.writeBuffer(mode, 0, new Uint32Array([m, 0, 0, 0]));
          const views = names.map(n => c.resources.view(n));
          const k = groups.begin(); k.push(...views);
          const group = groups.get(() => device.createBindGroup({ label: 'gbuffer-views', layout, entries: [
            ...views.map((resource, binding) => ({ binding, resource })), { binding: 7, resource: { buffer: mode } }] }));
          const ts = c.timestampWrites('debug.gbuffer-view') as GPUComputePassTimestampWrites | undefined;
          const pass = c.encoder.beginComputePass({ label: 'debug.gbuffer-view', ...(ts ? { timestampWrites: ts } : {}) });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, frameGroup);
          pass.setBindGroup(1, group);
          pass.dispatchWorkgroups(Math.ceil(c.frame.display[0] / 8), Math.ceil(c.frame.display[1] / 8));
          pass.end();
        },
      }));
      disposers.push(() => s.ctx.deferDestroy(mode));
    },
    dispose() { for (const d of disposers.splice(0)) d(); },
  };
}
