/** Depth-aware separable Gaussian focus, before gameplay overlays. Never blurs the aiming arc or marker rings. */
import type { EngineServices, RenderModule } from '../../contracts';
import { BindGroupResourceCache } from '../../gpu/bind-group-cache';
import { BufferUsage, ShaderStage, TextureUsage } from '../../gpu/flags';
import { frameWgsl } from '../../wgsl/common/frame.wgsl';
import { link, makeModule, wgslStruct } from '../../wgsl/module';
import { createFrameBindGroup } from '../gbuffer/gbuffer';
import { POST_TEXTURE, TAA_TEXTURE } from './taa';

const TEMP = 'dofHorizontal';
const PARAMS = wgslStruct('DofParams', [['focus', 'vec4f'], ['axis', 'vec4f']]);
const shader = makeModule('depth-of-field', /* wgsl */ `
@group(1) @binding(0) var source: texture_2d<f32>;
@group(1) @binding(1) var scene_depth: texture_depth_2d;
@group(1) @binding(2) var linear_sampler: sampler;
@group(1) @binding(3) var dof_out: texture_storage_2d<rgba16float, write>;
@group(1) @binding(4) var<uniform> dof: DofParams;
fn dof_depth(uv: vec2f) -> f32 {
  let size = vec2i(textureDimensions(scene_depth));
  let raster_uv = uv + frame.jitter * vec2f(0.5, -0.5);
  let pixel = clamp(vec2i(raster_uv * vec2f(size)), vec2i(0), size - 1);
  return min(dof.focus.x * 20.0, frame_near() / max(textureLoad(scene_depth, pixel, 0), 0.000001));
}
fn blur_radius(z: f32) -> f32 {
  // Soft focus falloff and a broad sharp band protect the entire tank and nearby ground.
  return dof.focus.y * dof.focus.z * smoothstep(max(1.2, dof.focus.x * 0.18), max(4.0, dof.focus.x * 0.9), abs(z - dof.focus.x));
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let size = vec2i(textureDimensions(dof_out));
  if (any(vec2i(gid.xy) >= size)) { return; }
  let uv = (vec2f(gid.xy) + 0.5) / vec2f(size);
  let z = dof_depth(uv);
  let radius = blur_radius(z);
  let original = textureLoad(source, vec2i(gid.xy), 0);
  if (radius < 0.5) { textureStore(dof_out, vec2i(gid.xy), original); return; }
  var sum = vec3f(0.0);
  var total = 0.0;
  // Dense, Gaussian-weighted taps replace the sparse disk that produced repeated silhouettes.
  for (var i = -8; i <= 8; i++) {
    let t = f32(i) / 8.0;
    let at = clamp(uv + dof.axis.xy * t * radius / vec2f(size), 0.5 / vec2f(size), 1.0 - 0.5 / vec2f(size));
    let neighbor = dof_depth(at);
    let depth_delta = (neighbor - z) / max(0.75, min(z, neighbor) * 0.08);
    let w = exp(-4.5 * t * t) * exp(-depth_delta * depth_delta);
    let color = textureSampleLevel(source, linear_sampler, at, 0.0).rgb;
    sum += select(color, vec3f(0.0), color != color) * w;
    total += w;
  }
  textureStore(dof_out, vec2i(gid.xy), vec4f(sum / max(total, 0.0001), original.a));
}
`, [frameWgsl, PARAMS.module]);
export function dofShader() { return link(shader); }

export function dofModule(): RenderModule {
  const disposers: (() => void)[] = [];
  return {
    name: 'depth-of-field',
    install(s: EngineServices) {
      const { device, queue } = s.ctx;
      s.graph.declareTexture(TEMP, { format: 'rgba16float', size: 'display', usage: TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING });
      const C = ShaderStage.COMPUTE;
      const layout = device.createBindGroupLayout({ label: 'dof', entries: [
        { binding: 0, visibility: C, texture: { sampleType: 'float' } },
        { binding: 1, visibility: C, texture: { sampleType: 'depth' } },
        { binding: 2, visibility: C, sampler: { type: 'filtering' } },
        { binding: 3, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float' } },
        { binding: 4, visibility: C, buffer: { type: 'uniform' } },
      ] });
      const key = 'post:dof';
      s.ctx.pipelines.register(key, 'compute', () => ({ label: key,
        layout: device.createPipelineLayout({ bindGroupLayouts: [s.ctx.layouts.frame, layout] }),
        compute: { module: s.ctx.pipelines.shaderModule(dofShader(), key), entryPoint: 'main' } }));
      void s.ctx.pipelines.compile(key).catch(() => undefined);
      const frame = createFrameBindGroup(s, 'dof');
      const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
      for (const [index, source, target, axis] of [[0, TAA_TEXTURE, TEMP, [1, 0]], [1, TEMP, POST_TEXTURE, [0, 1]]] as const) {
        const params = device.createBuffer({ label: `dof:${index}`, size: PARAMS.size, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
        disposers.push(() => s.ctx.deferDestroy(params));
        const cache = new BindGroupResourceCache(4), staging = new ArrayBuffer(PARAMS.size);
        disposers.push(s.graph.addPass({ name: `dof.${index === 0 ? 'horizontal' : 'vertical'}`, slot: 'post.dof', order: index,
          reads: ['frameUniforms', source, 'depth'], writes: [target],
          enabled: () => (s.scene.get('post')?.miniature ?? 0) > 0 && !!s.ctx.pipelines.get(key),
          run(c) {
            const v = c.frame.view, p = c.frame.focus.world;
            const distance = Math.max(1, -(v[2] * p[0] + v[6] * p[1] + v[10] * p[2] + v[14]));
            PARAMS.pack({ focus: [distance, Math.min(1, Math.max(0, s.scene.get('post')?.miniature ?? 0)), Math.min(10, c.frame.display[1] / 100), 0], axis: [...axis, 0, 0] }, staging);
            queue.writeBuffer(params, 0, staging);
            const src = c.resources.view(source), depth = c.resources.view('depth'), dst = c.resources.view(target);
            const cacheKey = cache.begin(); cacheKey.push(src, depth, dst);
            const group = cache.get(() => device.createBindGroup({ layout, entries: [
              { binding: 0, resource: src }, { binding: 1, resource: depth }, { binding: 2, resource: sampler },
              { binding: 3, resource: dst }, { binding: 4, resource: { buffer: params } },
            ] }));
            const timestampWrites = c.timestampWrites(`dof.${index === 0 ? 'horizontal' : 'vertical'}`) as GPUComputePassTimestampWrites | undefined;
            const pass = c.encoder.beginComputePass({ label: `dof:${index}`, ...(timestampWrites ? { timestampWrites } : {}) });
            pass.setPipeline(s.ctx.pipelines.get<GPUComputePipeline>(key)!); pass.setBindGroup(0, frame); pass.setBindGroup(1, group);
            pass.dispatchWorkgroups(Math.ceil(c.frame.display[0] / 8), Math.ceil(c.frame.display[1] / 8)); pass.end();
          },
        }));
      }
    },
    dispose() { for (const dispose of disposers.splice(0)) dispose(); },
  };
}
