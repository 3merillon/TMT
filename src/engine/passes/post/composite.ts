// Ported from Pinionfall src/gpu/tonemap-shader.ts and src/gpu/tonemap-pipeline.ts (MIT, same owner) — adapted
/**
 * Final composite v1 (plan §4.5 'composite' slot, §4.12), replacing W0's composite v0 and keeping its LDR → present
 * structure: an 8×8 compute pass writes display-encoded values into the rgba8unorm 'ldr' target (display size); debug
 * views (order 50) and image stats (order 90) run on 'ldr'; a fullscreen render pass blits it to the swapchain (order 100;
 * storage writes to bgra8unorm are not core).
 *
 * Per pixel: NaN/Inf guards on every input (Pinionfall) → the post input (TAA resolve + overlays, CC-013) + bloom (down[0] + up[1]) × 0.05 (exposed units) → cos⁴
 * vignette (lens, linear) → exposure = manual × per-planet bias × a slow auto-exposure (±1 EV, from the 1/16-res
 * diffusion mip) → AgX (default; Troy Sobotka minimal fit) with the per-planet CDL as its look, or Khronos PBR Neutral with
 * the CDL after it → blue-noise film grain weighted to mid-tones → ±0.5 LSB interleaved-gradient dither.
 *
 * The module also installs TAA ('taa'), depth of field before overlays ('post.dof'), bloom and auto exposure ('post.bloom').
 */
import type { EngineServices, RenderModule } from '../../contracts';
import { BindGroupResourceCache } from '../../gpu/bind-group-cache';
import { BufferUsage, ShaderStage, TextureUsage } from '../../gpu/flags';
import { fullscreenWgsl, drawFullscreenTriangle } from '../../gpu/fullscreen';
import { frameWgsl } from '../../wgsl/common/frame.wgsl';
import { link, makeModule, wgslStruct } from '../../wgsl/module';
import type { PlanetKind } from '../../../world/sun';
import { createFrameBindGroup } from '../gbuffer/gbuffer';
import { blueNoise, blueNoiseRgba8 } from './blue-noise';
import { BLOOM, BLOOM_TEXTURES, bloomModule } from './bloom';
import { AUTO_EXPOSURE, COMPOSITE_LENS, PLANET_GRADES } from './grade';
import { POST_TEXTURE, taaModule } from './taa';
import { installOptics, opticsCompositeWgsl } from './optics';
import { dofModule } from './dof';

export const LDR_FORMAT: GPUTextureFormat = 'rgba8unorm';
export const BLUE_NOISE_SIZE = 64;

export const tonemapWgsl = makeModule('tonemap', /* wgsl */ `
fn agx_contrast(x: vec3f) -> vec3f {
  let x2 = x * x;
  let x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
/** Scene-linear (Rec.709) → AgX log/sigmoid domain. */
fn agx(c: vec3f) -> vec3f {
  let inset = mat3x3f(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
                      0.0784335999999992, 0.878468636469772, 0.0784336,
                      0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  let min_ev = -12.47393;
  let max_ev = 4.026069;
  var v = inset * max(c, vec3f(0.0));
  v = clamp(log2(max(v, vec3f(1e-10))), vec3f(min_ev), vec3f(max_ev));
  v = (v - min_ev) / (max_ev - min_ev);
  return agx_contrast(v);
}
/** ASC-CDL (slope, offset, power) + saturation: the AgX look (in the sigmoid domain) or a display-space grade. */
fn cdl_apply(v: vec3f, slope: vec3f, offset: vec3f, power: vec3f, sat: f32) -> vec3f {
  let c = pow(max(v * slope + offset, vec3f(0.0)), power);
  let luma = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  return luma + sat * (c - luma);
}
/** AgX outset: display-encoded (≈ sRGB, 2.2) output — written directly to an 8-bit non-sRGB target. */
fn agx_display(v: vec3f) -> vec3f {
  let outset = mat3x3f(1.19687900512017, -0.0528968517574562, -0.0529716355144438,
                       -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
                       -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  return clamp(outset * v, vec3f(0.0), vec3f(1.0));
}
/** Khronos PBR Neutral (linear in, linear out). */
fn pbr_neutral(color: vec3f) -> vec3f {
  let start = 0.8 - 0.04;
  let desat = 0.15;
  let x = min(color.r, min(color.g, color.b));
  let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
  var c = color - offset;
  let peak = max(c.r, max(c.g, c.b));
  if (peak < start) { return c; }
  let d = 1.0 - start;
  let new_peak = 1.0 - d * d / (peak + d - start);
  c *= new_peak / peak;
  let g = 1.0 - 1.0 / (desat * (peak - new_peak) + 1.0);
  return mix(c, vec3f(new_peak), g);
}
fn srgb_encode(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}
fn ign(p: vec2f) -> f32 { return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y)); }
/** NaN/Inf guard (self-inequality first: WGSL min/max do not guarantee NaN semantics). */
fn nan_scrub(c: vec3f) -> vec3f {
  let bad = any(c != c) || any(abs(c) > vec3f(65504.0));
  return select(c, vec3f(0.0), bad);
}
`);

export const COMPOSITE_PARAMS = wgslStruct('CompositeParams', [
  ['exposure', 'vec4f'],  // x manual bias (2^EV of the planet grade), y auto on, z bloom intensity, w tonemap (0 AgX, 1 Neutral)
  ['slope', 'vec4f'],     // rgb CDL slope, w saturation
  ['offset', 'vec4f'],    // rgb CDL offset, w vignette strength
  ['power', 'vec4f'],     // rgb CDL power, w cos⁴ strength
  ['grain', 'vec4f'],     // x grain amplitude, y dither LSBs, z/w blue-noise tile offset
  ['lens', 'vec4f'],      // x vignette inner, y outer (ρ / ρ_corner), z bloom on, w grade on
  ['camera', 'vec4f'],    // x signed fisheye strength; remaining lanes reserved
]);

const compositeShader = makeModule('composite-v1', /* wgsl */ `
@group(1) @binding(0) var scene_tex: texture_2d<f32>;
@group(1) @binding(1) var lin_sampler: sampler;
@group(1) @binding(2) var ldr_out: texture_storage_2d<rgba8unorm, write>;
@group(1) @binding(3) var bloom_up: texture_2d<f32>;      // up chain, mip 1 (quarter resolution)
@group(1) @binding(4) var noise_tex: texture_2d<f32>;
@group(1) @binding(5) var<storage, read> expo: array<f32, 4>;
@group(1) @binding(6) var<uniform> cp: CompositeParams;
@group(1) @binding(7) var bloom_down: texture_2d<f32>;    // thresholded down chain, mip 0 (half resolution)
@group(1) @binding(8) var<storage, read> optical_sources: OpticalSources;
@group(1) @binding(9) var lens_depth: texture_depth_2d;
@group(1) @binding(10) var optical_mask: texture_2d<f32>;

fn lens_source_uv(uv: vec2f, display: vec2f) -> vec2f {
  let k = min(abs(cp.camera.x), 0.6) * 2.0;
  if (k < 0.0001) { return uv; }
  let diagonal = length(display);
  let p = (uv * 2.0 - 1.0) * display / diagonal;
  let r = length(p);
  if (r < 0.000001) { return uv; }
  let source_radius = select(tan(k * r) / tan(k), atan(k * r) / k, cp.camera.x < 0.0);
  return (p * (source_radius / r) * diagonal / display + 1.0) * 0.5;
}
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let display = frame_display_size();
  if (f32(gid.x) >= display.x || f32(gid.y) >= display.y) { return; }
  let screen_uv = (vec2f(gid.xy) + 0.5) / display;
  let uv = lens_source_uv(screen_uv, display);
  var scene = nan_scrub(textureLoad(scene_tex, vec2i(gid.xy), 0).rgb);
  if (abs(cp.camera.x) > 0.0001) { scene = nan_scrub(textureSampleLevel(scene_tex, lin_sampler, uv, 0.0).rgb); }
  let bloom_src = textureSampleLevel(bloom_down, lin_sampler, uv, 0.0).rgb + textureSampleLevel(bloom_up, lin_sampler, uv, 0.0).rgb;
  let bloom = nan_scrub(bloom_src) * cp.exposure.z * cp.lens.z;
  // Exposed radiance: the bloom chain is already in exposed units (× the manual exposure).
  // Flare/rays are evaluated here, after TAA and bloom. They never feed history or auto-exposure.
  var c = (scene + optical_effects(uv)) * frame.exposure + bloom;
  // cos⁴ vignette from the (unjittered) view ray, plus a gentle radial falloff toward the corners.
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let ray = vec2f((ndc.x + frame.proj[2][0] + frame.jitter.x) / frame.proj[0][0], (ndc.y + frame.proj[2][1] + frame.jitter.y) / frame.proj[1][1]);
  let cos_t = inverseSqrt(1.0 + dot(ray, ray));
  let c2 = cos_t * cos_t;
  let rho = length(ndc * vec2f(display.x / display.y, 1.0));
  let rho_c = length(vec2f(display.x / display.y, 1.0));
  let vig = mix(1.0, c2 * c2, cp.power.w) * (1.0 - cp.offset.w * smoothstep(cp.lens.x, cp.lens.y, rho / rho_c));
  c *= vig;
  // Exposure: per-planet bias × slow auto-exposure (±1 EV).
  let auto_ev = select(0.0, expo[0], cp.exposure.y > 0.5 && expo[2] > 0.5);
  c *= cp.exposure.x * exp2(auto_ev);
  var o: vec3f;
  if (cp.exposure.w < 0.5) {
    var v = agx(c);
    if (cp.lens.w > 0.5) { v = cdl_apply(v, cp.slope.rgb, cp.offset.rgb, cp.power.rgb, cp.slope.w); }
    o = agx_display(v);
  } else {
    o = srgb_encode(clamp(pbr_neutral(c), vec3f(0.0), vec3f(1.0)));
    if (cp.lens.w > 0.5) { o = clamp(cdl_apply(o, cp.slope.rgb, cp.offset.rgb, cp.power.rgb * 0.87, cp.slope.w), vec3f(0.0), vec3f(1.0)); }
  }
  // Film grain (blue noise, mid-tone weighted) then a ±0.5 LSB dither.
  let nd = vec2i(textureDimensions(noise_tex));
  let np = (vec2i(gid.xy) + vec2i(cp.grain.zw)) % nd;
  let bn = textureLoad(noise_tex, np, 0).r - 0.5;
  let l = dot(o, vec3f(0.2126, 0.7152, 0.0722));
  o += vec3f(bn * cp.grain.x * 4.0 * l * (1.0 - l));
  let n = ign(vec2f(gid.xy) + 5.588238 * f32(frame_index() % 64u)) - 0.5;
  o = clamp(o + vec3f(n * cp.grain.y / 255.0), vec3f(0.0), vec3f(1.0));
  textureStore(ldr_out, vec2i(gid.xy), vec4f(o, 1.0));
}
`, [frameWgsl, tonemapWgsl, COMPOSITE_PARAMS.module, opticsCompositeWgsl]);

const EXPOSURE_PARAMS = wgslStruct('ExposureParams', [['p', 'vec4f']]); // x log2(key), y tau up, z tau down, w reset
const exposureShader = makeModule('auto-exposure', /* wgsl */ `
@group(1) @binding(0) var lum_src: texture_2d<f32>;
@group(1) @binding(1) var<storage, read_write> expo: array<f32, 4>;
@group(1) @binding(2) var<uniform> ep: ExposureParams;
var<workgroup> acc: array<vec2f, 256>;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(local_invocation_id) lid: vec3u, @builtin(local_invocation_index) li: u32) {
  let dims = textureDimensions(lum_src);
  var s = vec2f(0.0);
  for (var y = lid.y; y < dims.y; y += 16u) {
    for (var x = lid.x; x < dims.x; x += 16u) {
      let c = textureLoad(lum_src, vec2u(x, y), 0).rgb;
      let l = dot(select(c, vec3f(0.0), c != c), vec3f(0.2126, 0.7152, 0.0722));
      let uv = (vec2f(f32(x), f32(y)) + 0.5) / vec2f(dims);
      // Centre-weighted; near-black pixels (space, deep night) do not vote, so an overview is exposed for the planet.
      let w = (1.0 - 0.6 * smoothstep(0.2, 0.7, length(uv - 0.5))) * smoothstep(0.004, 0.03, l);
      s += vec2f(w * log2(clamp(l, 0.01, 64.0)), w);
    }
  }
  acc[li] = s;
  workgroupBarrier();
  for (var k = 128u; k > 0u; k >>= 1u) {
    if (li < k) { acc[li] += acc[li + k]; }
    workgroupBarrier();
  }
  if (li == 0u) {
    let avg = select(ep.p.x, acc[0].x / max(acc[0].y, 1e-4), acc[0].y > 1e-3);
    let target_ev = clamp(ep.p.x - avg, -${AUTO_EXPOSURE.range.toFixed(1)}, ${AUTO_EXPOSURE.range.toFixed(1)});
    var ev = expo[0];
    if (ep.p.w > 0.5 || expo[2] < 0.5) {
      ev = target_ev;
    } else {
      let tau = select(ep.p.z, ep.p.y, target_ev > ev);
      ev += (target_ev - ev) * (1.0 - exp(-max(frame.dt, 0.0) / tau));
    }
    expo[0] = ev;
    expo[1] = avg;
    expo[2] = 1.0;
  }
}
`, [frameWgsl, EXPOSURE_PARAMS.module]);

const presentShader = makeModule('present', /* wgsl */ `
@group(0) @binding(0) var ldr: texture_2d<f32>;

@fragment
fn fs_present(in: FullscreenOut) -> @location(0) vec4f {
  let size = vec2i(textureDimensions(ldr));
  return textureLoad(ldr, min(vec2i(in.pos.xy), size - vec2i(1)), 0);
}
`, [fullscreenWgsl]);

export function compositeShaderLinked() { return link(compositeShader); }
export function presentShaderLinked() { return link(presentShader); }
export function exposureShaderLinked() { return link(exposureShader); }

declare module '../../contracts' {
  interface SceneFacets {
    /** W1-ENG-LOOK: final composite controls. */
    post: PostFacet;
  }
}
export interface PostFacet {
  fisheye: number;
  miniature: number;
  /** Source-occluded lens optics; excluded from interior/workshop rendering. */
  flare: boolean;
  flareStrength: number;
  /** Optional screen-space radial rays, complementary to world-space volumetrics. */
  godRays: boolean;
  tonemap: 'agx' | 'neutral';
  autoExposure: boolean;
  bloom: boolean;
  bloomStrength: number;
  grade: boolean;
  grain: number;
  /** Extra EV on top of the manual exposure and the planet bias. */
  exposureEv: number;
}

export function compositeModule(): RenderModule {
  const disposers: (() => void)[] = [];
  const stages = [taaModule(), dofModule(), bloomModule()];
  return {
    name: 'composite-v1',
    async install(s: EngineServices) {
      for (const m of stages) await m.install(s);
      const optics = installOptics(s);
      disposers.push(() => optics.dispose());
      const { device, queue } = s.ctx;
      s.graph.declareTexture('ldr', { format: LDR_FORMAT, size: 'display', usage: TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING });
      s.graph.importTexture('swapchain', () => { const texture = s.ctx.canvasContext.getCurrentTexture(); return { texture, view: texture.createView() }; });
      const C = ShaderStage.COMPUTE, F = ShaderStage.FRAGMENT;
      const compLayout = device.createBindGroupLayout({
        label: 'layout:composite',
        entries: [
          { binding: 0, visibility: C, texture: { sampleType: 'float' } },
          { binding: 1, visibility: C, sampler: { type: 'filtering' } },
          { binding: 2, visibility: C, storageTexture: { access: 'write-only', format: LDR_FORMAT } },
          { binding: 3, visibility: C, texture: { sampleType: 'float' } },
          { binding: 4, visibility: C, texture: { sampleType: 'float' } },
          { binding: 5, visibility: C, buffer: { type: 'read-only-storage' } },
          { binding: 6, visibility: C, buffer: { type: 'uniform' } },
          { binding: 7, visibility: C, texture: { sampleType: 'float' } },
          { binding: 8, visibility: C, buffer: { type: 'read-only-storage' } },
          { binding: 9, visibility: C, texture: { sampleType: 'depth' } },
          { binding: 10, visibility: C, texture: { sampleType: 'float' } },
        ],
      });
      const expoLayout = device.createBindGroupLayout({ label: 'layout:auto-exposure', entries: [
        { binding: 0, visibility: C, texture: { sampleType: 'float' } },
        { binding: 1, visibility: C, buffer: { type: 'storage' } },
        { binding: 2, visibility: C, buffer: { type: 'uniform' } }] });
      const presentLayout = device.createBindGroupLayout({ label: 'layout:present', entries: [{ binding: 0, visibility: F, texture: { sampleType: 'unfilterable-float' } }] });
      const compKey = 'composite-v1', presentKey = `present:${s.ctx.format}`, expoKey = 'post:auto-exposure';
      s.ctx.pipelines.register(compKey, 'compute', () => ({
        label: compKey, layout: device.createPipelineLayout({ bindGroupLayouts: [s.ctx.layouts.frame, compLayout] }),
        compute: { module: s.ctx.pipelines.shaderModule(compositeShaderLinked(), compKey), entryPoint: 'main' },
      }));
      s.ctx.pipelines.register(expoKey, 'compute', () => ({
        label: expoKey, layout: device.createPipelineLayout({ bindGroupLayouts: [s.ctx.layouts.frame, expoLayout] }),
        compute: { module: s.ctx.pipelines.shaderModule(exposureShaderLinked(), expoKey), entryPoint: 'main' },
      }));
      s.ctx.pipelines.register(presentKey, 'render', () => {
        const module = s.ctx.pipelines.shaderModule(presentShaderLinked(), 'present');
        return {
          label: presentKey, layout: device.createPipelineLayout({ bindGroupLayouts: [presentLayout] }),
          vertex: { module, entryPoint: 'vs_fullscreen' },
          fragment: { module, entryPoint: 'fs_present', targets: [{ format: s.ctx.format }] },
          primitive: { topology: 'triangle-list' },
        };
      });
      for (const k of [compKey, expoKey, presentKey]) void s.ctx.pipelines.compile(k).catch(() => undefined);

      const sampler = device.createSampler({ label: 'composite:linear', magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
      const noise = device.createTexture({ label: 'post:blue-noise', size: [BLUE_NOISE_SIZE, BLUE_NOISE_SIZE], format: 'rgba8unorm', usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST });
      queue.writeTexture({ texture: noise }, blueNoiseRgba8(blueNoise(BLUE_NOISE_SIZE), BLUE_NOISE_SIZE), { bytesPerRow: BLUE_NOISE_SIZE * 4, rowsPerImage: BLUE_NOISE_SIZE }, [BLUE_NOISE_SIZE, BLUE_NOISE_SIZE]);
      const noiseView = noise.createView();
      const expo = device.createBuffer({ label: 'post:exposure', size: 16, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST });
      const expoParams = device.createBuffer({ label: 'post:exposure-params', size: EXPOSURE_PARAMS.size, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      const params = device.createBuffer({ label: 'post:composite-params', size: COMPOSITE_PARAMS.size, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      const staging = new ArrayBuffer(COMPOSITE_PARAMS.size);
      const expoStaging = new ArrayBuffer(EXPOSURE_PARAMS.size);
      disposers.push(() => { for (const r of [noise, expo, expoParams, params]) s.ctx.deferDestroy(r); });
      const frameGroup = createFrameBindGroup(s, 'composite');
      const compGroups = new BindGroupResourceCache(4);
      const expoGroups = new BindGroupResourceCache(4);
      const presentGroups = new BindGroupResourceCache(4);
      const facet: PostFacet = { fisheye: 0, miniature: 0, flare: true, flareStrength: 1, godRays: true, tonemap: 'agx', autoExposure: true, bloom: true, bloomStrength: 1, grade: true, grain: COMPOSITE_LENS.grain, exposureEv: 0 };
      s.scene.provide('post', facet);
      const r2 = (i: number): [number, number] => [Math.floor(((i * 0.7548776662) % 1) * BLUE_NOISE_SIZE), Math.floor(((i * 0.5698402909) % 1) * BLUE_NOISE_SIZE)];

      disposers.push(s.graph.addPass({
        name: 'exposure', slot: 'post.bloom', order: 10, reads: ['frameUniforms', BLOOM_TEXTURES.diffusion], writes: [],
        run(c) {
          const pipeline = s.ctx.pipelines.get<GPUComputePipeline>(expoKey);
          if (!pipeline) return;
          const tex = c.resources.texture(BLOOM_TEXTURES.diffusion);
          const mip = Math.min(3, tex.mipLevelCount - 1);
          EXPOSURE_PARAMS.pack({ p: [Math.log2(AUTO_EXPOSURE.key), AUTO_EXPOSURE.tauUp, AUTO_EXPOSURE.tauDown, c.frame.snap ? 1 : 0] }, expoStaging);
          queue.writeBuffer(expoParams, 0, expoStaging);
          const k = expoGroups.begin(); k.push(tex, mip);
          const group = expoGroups.get(() => device.createBindGroup({ label: 'auto-exposure', layout: expoLayout, entries: [
            { binding: 0, resource: tex.createView({ baseMipLevel: mip, mipLevelCount: 1 }) }, { binding: 1, resource: { buffer: expo } },
            { binding: 2, resource: { buffer: expoParams } }] }));
          const ts = c.timestampWrites('exposure') as GPUComputePassTimestampWrites | undefined;
          const pass = c.encoder.beginComputePass({ label: 'exposure', ...(ts ? { timestampWrites: ts } : {}) });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, frameGroup);
          pass.setBindGroup(1, group);
          pass.dispatchWorkgroups(1);
          pass.end();
        },
      }));

      disposers.push(s.graph.addPass({
        name: 'composite', slot: 'composite', order: 0, reads: ['frameUniforms', POST_TEXTURE, 'depth', BLOOM_TEXTURES.up, BLOOM_TEXTURES.down], writes: ['ldr'],
        run(c) {
          const pipeline = s.ctx.pipelines.get<GPUComputePipeline>(compKey);
          if (!pipeline) return;
          const kind: PlanetKind = s.scene.get('planet')?.kind ?? 'temperate';
          const grade = PLANET_GRADES[kind] ?? PLANET_GRADES.temperate;
          const cdl = grade.cdl;
          COMPOSITE_PARAMS.pack({
            exposure: [2 ** ((s.scene.get('interior') ? 0 : grade.exposureEv) + facet.exposureEv), facet.autoExposure ? 1 : 0, BLOOM.intensity * facet.bloomStrength, facet.tonemap === 'neutral' ? 1 : 0],
            slope: [...cdl.slope, cdl.saturation], offset: [...cdl.offset, COMPOSITE_LENS.vignette], power: [...cdl.power, COMPOSITE_LENS.cos4],
            grain: [facet.grain, COMPOSITE_LENS.ditherLsb, ...r2(c.frame.index % 4096)],
            lens: [COMPOSITE_LENS.vignetteInner, COMPOSITE_LENS.vignetteOuter, facet.bloom ? 1 : 0, facet.grade ? 1 : 0],
            camera: [facet.fisheye, 0, 0, 0],
          }, staging);
          queue.writeBuffer(params, 0, staging);
          const src = c.resources.view(POST_TEXTURE), ldr = c.resources.view('ldr');
          const upTex = c.resources.texture(BLOOM_TEXTURES.up);
          const downTex = c.resources.texture(BLOOM_TEXTURES.down);
          const depth = c.resources.view('depth');
          const k = compGroups.begin(); k.push(src, ldr, upTex, downTex, depth);
          const group = compGroups.get(() => device.createBindGroup({ label: 'composite', layout: compLayout, entries: [
            { binding: 0, resource: src }, { binding: 1, resource: sampler }, { binding: 2, resource: ldr },
            { binding: 3, resource: upTex.createView({ baseMipLevel: Math.min(1, upTex.mipLevelCount - 1), mipLevelCount: 1 }) },
            { binding: 4, resource: noiseView }, { binding: 5, resource: { buffer: expo } }, { binding: 6, resource: { buffer: params } },
            { binding: 7, resource: downTex.createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
            { binding: 8, resource: { buffer: optics.buffer } }, { binding: 9, resource: depth },
            { binding: 10, resource: optics.mask }] }));
          const ts = c.timestampWrites('composite') as GPUComputePassTimestampWrites | undefined;
          const pass = c.encoder.beginComputePass({ label: 'composite', ...(ts ? { timestampWrites: ts } : {}) });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, frameGroup);
          pass.setBindGroup(1, group);
          const [w, h] = c.frame.display;
          pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
          pass.end();
        },
      }));
      disposers.push(s.graph.addPass({
        name: 'present', slot: 'composite', order: 100, reads: ['ldr'], writes: ['swapchain'],
        run(c) {
          const pipeline = s.ctx.pipelines.get<GPURenderPipeline>(presentKey);
          const view = c.resources.view('swapchain');
          const ldr = c.resources.view('ldr');
          const ts = c.timestampWrites('present') as GPURenderPassTimestampWrites | undefined;
          const pass = c.encoder.beginRenderPass({
            label: 'present',
            colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
            ...(ts ? { timestampWrites: ts } : {}),
          });
          if (pipeline) {
            const k = presentGroups.begin(); k.push(ldr);
            const group = presentGroups.get(() => device.createBindGroup({ label: 'present', layout: presentLayout, entries: [{ binding: 0, resource: ldr }] }));
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, group);
            drawFullscreenTriangle(pass);
          }
          pass.end();
        },
      }));
    },
    dispose() {
      for (const d of disposers.splice(0)) d();
      for (const m of stages) m.dispose?.();
    },
  };
}
