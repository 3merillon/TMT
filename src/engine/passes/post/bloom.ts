// Ported from Pinionfall src/gpu/bloom-shader.ts and src/gpu/bloom-pipeline.ts (MIT, same owner) — drop-in kernels
/**
 * Bloom (plan §4.12, 'post.bloom' slot): the CoD:AW dual filter from Pinionfall, as ONE compute pass of sequential
 * dispatches (each dispatch is its own synchronisation scope, so one timestamp pair covers the whole chain).
 *
 * - First downsample: 13-tap with the Karis average (firefly suppression), NaN/Inf scrub and the soft threshold
 *   (threshold 0.9, knee 0.5) from the post input (TAA resolve + overlays, CC-013) at half resolution; it also writes the unthresholded "diffusion" mip 0.
 * - 5 more 13-tap downsamples per chain (6 mips).
 * - Upsample: 9-tap tent, up[i] = down[i] + tent(up[i+1]) down to mip 1; the lowest two mips also add the
 *   unthresholded diffusion chain (0.015 in the final image: the Pro-Mist/halation glow of atmo-post §7).
 * Everything runs on EXPOSED radiance (× the manual exposure) so the threshold means "brighter than display white-ish".
 * The composite adds (down[0] + up[1]) × intensity (0.05), both bilinear. The diffusion chain's 1/16-res mip feeds
 * auto-exposure.
 */
import type { EngineServices, RenderModule } from '../../contracts';
import { BufferUsage, ShaderStage, TextureUsage } from '../../gpu/flags';
import { frameWgsl } from '../../wgsl/common/frame.wgsl';
import { link, makeModule } from '../../wgsl/module';
import { createFrameBindGroup } from '../gbuffer/gbuffer';
import { POST_TEXTURE } from './taa';

export const BLOOM = { mips: 6, threshold: 0.9, knee: 0.5, intensity: 0.05, diffusion: 0.015 } as const;
export const BLOOM_TEXTURES = { down: 'bloomDown', up: 'bloomUp', diffusion: 'bloomDiffusion' } as const;
const FORMAT: GPUTextureFormat = 'rgba16float';

const bloomCommon = makeModule('bloom-common', /* wgsl */ `
@group(1) @binding(0) var src_tex: texture_2d<f32>;
@group(1) @binding(1) var src_smp: sampler;
@group(1) @binding(2) var dst_tex: texture_storage_2d<rgba16float, write>;

fn bloom_luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn bloom_karis(c: vec3f) -> f32 { return 1.0 / (1.0 + bloom_luma(c)); }
fn bloom_scrub(c: vec3f) -> vec3f {
  let finite = select(c, vec3f(0.0), c != c);
  return min(max(finite, vec3f(0.0)), vec3f(65504.0));
}
fn soft_threshold(c: vec3f, threshold: f32, knee: f32) -> vec3f {
  let l = bloom_luma(c);
  let soft = clamp(l - threshold + knee, 0.0, 2.0 * knee);
  let contribution = select(soft * soft / (4.0 * knee + 1e-5), l - threshold, knee < 1e-4);
  return c * (max(contribution, 0.0) / max(l, 1e-4));
}
/** 13-tap (CoD:AW) sample pattern around uv, t = source texel size. */
fn tap13(uv: vec2f, t: vec2f, k: vec2f) -> vec3f {
  return textureSampleLevel(src_tex, src_smp, uv + k * t, 0.0).rgb;
}
fn dst_uv(id: vec2u) -> vec2f { return (vec2f(id) + 0.5) / vec2f(textureDimensions(dst_tex)); }
fn src_texel() -> vec2f { return 1.0 / vec2f(textureDimensions(src_tex)); }
`);

const downFirstShader = makeModule('bloom-down-first', /* wgsl */ `
@group(1) @binding(3) var diff_tex: texture_storage_2d<rgba16float, write>;
const THRESHOLD: f32 = ${BLOOM.threshold};
const KNEE: f32 = ${BLOOM.knee};

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(dst_tex);
  if (id.x >= dims.x || id.y >= dims.y) { return; }
  let uv = dst_uv(id.xy);
  let t = src_texel();
  let e = frame.exposure;
  let a = bloom_scrub(tap13(uv, t, vec2f(-1.0, -1.0))) * e;
  let b = bloom_scrub(tap13(uv, t, vec2f( 0.0, -1.0))) * e;
  let c = bloom_scrub(tap13(uv, t, vec2f( 1.0, -1.0))) * e;
  let d = bloom_scrub(tap13(uv, t, vec2f(-0.5, -0.5))) * e;
  let ee = bloom_scrub(tap13(uv, t, vec2f( 0.5, -0.5))) * e;
  let f = bloom_scrub(tap13(uv, t, vec2f(-1.0,  0.0))) * e;
  let g = bloom_scrub(tap13(uv, t, vec2f( 0.0,  0.0))) * e;
  let h = bloom_scrub(tap13(uv, t, vec2f( 1.0,  0.0))) * e;
  let i = bloom_scrub(tap13(uv, t, vec2f(-0.5,  0.5))) * e;
  let j = bloom_scrub(tap13(uv, t, vec2f( 0.5,  0.5))) * e;
  let k = bloom_scrub(tap13(uv, t, vec2f(-1.0,  1.0))) * e;
  let l = bloom_scrub(tap13(uv, t, vec2f( 0.0,  1.0))) * e;
  let m = bloom_scrub(tap13(uv, t, vec2f( 1.0,  1.0))) * e;
  let g0 = (d + ee + i + j) * 0.5;
  let g1 = (a + b + f + g) * 0.25;
  let g2 = (b + c + g + h) * 0.25;
  let g3 = (f + g + k + l) * 0.25;
  let g4 = (g + h + l + m) * 0.25;
  // Plain dual-filter weights for the unthresholded diffusion chain.
  let plain = g0 * 0.5 + (g1 + g2 + g3 + g4) * 0.125;
  let w0 = bloom_karis(g0); let w1 = bloom_karis(g1); let w2 = bloom_karis(g2); let w3 = bloom_karis(g3); let w4 = bloom_karis(g4);
  let karis = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
  textureStore(dst_tex, id.xy, vec4f(soft_threshold(karis, THRESHOLD, THRESHOLD * KNEE), 1.0));
  textureStore(diff_tex, id.xy, vec4f(plain, 1.0));
}
`, [frameWgsl, bloomCommon]);

const downShader = makeModule('bloom-down', /* wgsl */ `
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(dst_tex);
  if (id.x >= dims.x || id.y >= dims.y) { return; }
  let uv = dst_uv(id.xy);
  let t = src_texel();
  let a = tap13(uv, t, vec2f(-1.0, -1.0)); let b = tap13(uv, t, vec2f(0.0, -1.0)); let c = tap13(uv, t, vec2f(1.0, -1.0));
  let d = tap13(uv, t, vec2f(-0.5, -0.5)); let e = tap13(uv, t, vec2f(0.5, -0.5));
  let f = tap13(uv, t, vec2f(-1.0, 0.0)); let g = tap13(uv, t, vec2f(0.0, 0.0)); let h = tap13(uv, t, vec2f(1.0, 0.0));
  let i = tap13(uv, t, vec2f(-0.5, 0.5)); let j = tap13(uv, t, vec2f(0.5, 0.5));
  let k = tap13(uv, t, vec2f(-1.0, 1.0)); let l = tap13(uv, t, vec2f(0.0, 1.0)); let m = tap13(uv, t, vec2f(1.0, 1.0));
  var r = (d + e + i + j) * 0.125;
  r += (a + b + f + g) * 0.03125;
  r += (b + c + g + h) * 0.03125;
  r += (f + g + k + l) * 0.03125;
  r += (g + h + l + m) * 0.03125;
  r += (b + d + e + g) * 0.03125;
  r += (d + f + g + i) * 0.03125;
  r += (e + g + h + j) * 0.03125;
  r += (g + i + j + l) * 0.03125;
  textureStore(dst_tex, id.xy, vec4f(r, 1.0));
}
`, [bloomCommon]);

const upShader = makeModule('bloom-up', /* wgsl */ `
struct UpParams { has_src: f32, diffusion: f32, _a: f32, _b: f32 }
@group(1) @binding(3) var down_tex: texture_2d<f32>;
@group(1) @binding(4) var diff_src: texture_2d<f32>;
@group(1) @binding(5) var<uniform> up: UpParams;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(dst_tex);
  if (id.x >= dims.x || id.y >= dims.y) { return; }
  let uv = dst_uv(id.xy);
  var r = textureLoad(down_tex, id.xy, 0).rgb + textureLoad(diff_src, id.xy, 0).rgb * up.diffusion;
  if (up.has_src > 0.5) {
    let t = src_texel();
    var s = tap13(uv, t, vec2f(-1.0, -1.0)) + tap13(uv, t, vec2f(1.0, -1.0)) + tap13(uv, t, vec2f(-1.0, 1.0)) + tap13(uv, t, vec2f(1.0, 1.0));
    s += (tap13(uv, t, vec2f(0.0, -1.0)) + tap13(uv, t, vec2f(-1.0, 0.0)) + tap13(uv, t, vec2f(1.0, 0.0)) + tap13(uv, t, vec2f(0.0, 1.0))) * 2.0;
    s += tap13(uv, t, vec2f(0.0, 0.0)) * 4.0;
    r += s / 16.0;
  }
  textureStore(dst_tex, id.xy, vec4f(r, 1.0));
}
`, [bloomCommon]);

export function bloomShaders() { return { downFirst: link(downFirstShader), down: link(downShader), up: link(upShader) }; }

/** Mip count for a half-resolution chain (≤ 6, and every mip ≥ 1 px). */
export function bloomMipCount(w: number, h: number, max: number = BLOOM.mips): number {
  return Math.max(1, Math.min(max, Math.floor(Math.log2(Math.max(1, Math.min(w, h)))) + 1));
}

export function bloomModule(): RenderModule {
  const disposers: (() => void)[] = [];
  return {
    name: 'bloom',
    install(s: EngineServices) {
      const { device, queue } = s.ctx;
      const C = ShaderStage.COMPUTE;
      const usage = TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING;
      let mips = 0;
      const declare = (w: number, h: number) => {
        const m = bloomMipCount(Math.ceil(w / 2), Math.ceil(h / 2));
        if (m === mips) return;
        mips = m;
        // Half of DISPLAY: the chain filters the display-size post input, so its width must not follow the render scale.
        for (const name of Object.values(BLOOM_TEXTURES)) s.graph.declareTexture(name, { format: FORMAT, size: 'displayHalf', usage, mipLevelCount: m });
      };
      declare(s.ctx.canvas.width, s.ctx.canvas.height);
      disposers.push(s.events.on('resize', e => declare(e.display[0], e.display[1])));

      const base = [
        { binding: 0, visibility: C, texture: { sampleType: 'float' as const } },
        { binding: 1, visibility: C, sampler: { type: 'filtering' as const } },
        { binding: 2, visibility: C, storageTexture: { access: 'write-only' as const, format: FORMAT } },
      ];
      const layouts = {
        first: device.createBindGroupLayout({ label: 'layout:bloom-first', entries: [...base, { binding: 3, visibility: C, storageTexture: { access: 'write-only', format: FORMAT } }] }),
        down: device.createBindGroupLayout({ label: 'layout:bloom-down', entries: base }),
        up: device.createBindGroupLayout({ label: 'layout:bloom-up', entries: [...base,
          { binding: 3, visibility: C, texture: { sampleType: 'float' } }, { binding: 4, visibility: C, texture: { sampleType: 'float' } },
          { binding: 5, visibility: C, buffer: { type: 'uniform' } }] }),
      };
      const shaders = bloomShaders();
      const keys = { first: 'bloom:down-first', down: 'bloom:down', up: 'bloom:up' } as const;
      for (const k of ['first', 'down', 'up'] as const) {
        const linked = k === 'first' ? shaders.downFirst : k === 'down' ? shaders.down : shaders.up;
        s.ctx.pipelines.register(keys[k], 'compute', () => ({
          label: keys[k],
          layout: device.createPipelineLayout({ bindGroupLayouts: [s.ctx.layouts.frame, layouts[k]] }),
          compute: { module: s.ctx.pipelines.shaderModule(linked, keys[k]), entryPoint: 'main' },
        }));
        void s.ctx.pipelines.compile(keys[k]).catch(() => undefined);
      }
      const sampler = device.createSampler({ label: 'bloom:linear', magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
      const upParams = Array.from({ length: BLOOM.mips }, () => device.createBuffer({ label: 'bloom:up-params', size: 16, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST }));
      disposers.push(() => { for (const b of upParams) s.ctx.deferDestroy(b); });
      const frameGroup = createFrameBindGroup(s, 'bloom');
      // Per-texture mip views and bind groups, rebuilt when the graph reallocates a texture (identity change).
      let cache: { key: unknown[]; groups: GPUBindGroup[]; order: GPUComputePipeline[]; sizes: [number, number][] } | null = null;
      const mipViews = (t: GPUTexture) => Array.from({ length: t.mipLevelCount }, (_, m) => t.createView({ baseMipLevel: m, mipLevelCount: 1 }));

      disposers.push(s.graph.addPass({
        name: 'bloom', slot: 'post.bloom', order: 0, reads: ['frameUniforms', POST_TEXTURE], writes: Object.values(BLOOM_TEXTURES),
        run(c) {
          const pf = s.ctx.pipelines.get<GPUComputePipeline>(keys.first);
          const pd = s.ctx.pipelines.get<GPUComputePipeline>(keys.down);
          const pu = s.ctx.pipelines.get<GPUComputePipeline>(keys.up);
          if (!pf || !pd || !pu) return;
          const r = c.resources;
          const src = r.view(POST_TEXTURE);
          const down = r.texture(BLOOM_TEXTURES.down), upT = r.texture(BLOOM_TEXTURES.up), diff = r.texture(BLOOM_TEXTURES.diffusion);
          const bloom = s.scene.get('post')?.bloom !== false;
          const key = [src, down, upT, diff, bloom];
          if (!cache || cache.key.some((k, i) => k !== key[i])) {
            const n = down.mipLevelCount;
            const dv = mipViews(down), uv = mipViews(upT), fv = mipViews(diff);
            const groups: GPUBindGroup[] = [];
            const order: GPUComputePipeline[] = [];
            const sizes: [number, number][] = [];
            const size = (m: number): [number, number] => [Math.max(1, down.width >> m), Math.max(1, down.height >> m)];
            groups.push(device.createBindGroup({ label: 'bloom-first', layout: layouts.first, entries: [
              { binding: 0, resource: src }, { binding: 1, resource: sampler }, { binding: 2, resource: dv[0] }, { binding: 3, resource: fv[0] }] }));
            order.push(pf); sizes.push(size(0));
            for (let m = 1; m < n; m++) {
              for (const chain of bloom ? [dv, fv] : [fv]) {
                groups.push(device.createBindGroup({ label: `bloom-down-${m}`, layout: layouts.down, entries: [
                  { binding: 0, resource: chain[m - 1] }, { binding: 1, resource: sampler }, { binding: 2, resource: chain[m] }] }));
                order.push(pd); sizes.push(size(m));
              }
            }
            // The chain stops at mip 1: the composite adds down[0] + up[1] itself (two bilinear taps per display pixel),
            // which saves the half-resolution tent pass (the costliest dispatch).
            for (let m = n - 1; bloom && m >= Math.min(1, n - 1); m--) {
              const hasSrc = m < n - 1;
              queue.writeBuffer(upParams[m], 0, new Float32Array([hasSrc ? 1 : 0, m >= n - 2 ? BLOOM.diffusion / BLOOM.intensity : 0, 0, 0]));
              groups.push(device.createBindGroup({ label: `bloom-up-${m}`, layout: layouts.up, entries: [
                { binding: 0, resource: hasSrc ? uv[m + 1] : dv[m] }, { binding: 1, resource: sampler }, { binding: 2, resource: uv[m] },
                { binding: 3, resource: dv[m] }, { binding: 4, resource: fv[m] }, { binding: 5, resource: { buffer: upParams[m] } }] }));
              order.push(pu); sizes.push(size(m));
            }
            cache = { key, groups, order, sizes };
          }
          const ts = c.timestampWrites('bloom') as GPUComputePassTimestampWrites | undefined;
          const pass = c.encoder.beginComputePass({ label: 'bloom', ...(ts ? { timestampWrites: ts } : {}) });
          pass.setBindGroup(0, frameGroup);
          let last: GPUComputePipeline | null = null;
          for (let i = 0; i < cache.groups.length; i++) {
            if (cache.order[i] !== last) { pass.setPipeline(cache.order[i]); last = cache.order[i]; }
            pass.setBindGroup(1, cache.groups[i]);
            const [w, h] = cache.sizes[i];
            pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
          }
          pass.end();
        },
      }));
    },
    dispose() { for (const d of disposers.splice(0)) d(); },
  };
}
