// Ported from Pinionfall src/gpu/taa-shader.ts and src/gpu/taa-pipeline.ts (MIT, same owner) — adapted
/**
 * TAA (plan §4.12), the 'taa' slot: one 8×8 compute pass at display resolution.
 *
 * - Reprojection: the velocity target (uv_prev − uv_current, unjittered) for every raster pixel; sky pixels (depth 0,
 *   velocity cleared) reproject their view DIRECTION with the previous unjittered view-projection (a point at infinity).
 *   Pinionfall's log-depth reprojection is gone (plan §13 rule 3).
 * - History: bilinear at native resolution (Catmull-Rom when upscaling), YCoCg variance clip over the 3×3 neighbourhood
 *   with luma weighting (γ 1, 1.25 when upscaling; the neighbourhood comes from a shared 10×10 tile per 8×8 group) and
 *   Pinionfall's disocclusion boost from the clamp distance.
 * - Rejection: off-screen, the GB3 NEW_GEOMETRY flag (freshly committed terrain pages, `newUntilFrame`), camera snaps
 *   (`FrameState.snap`) and history invalidation requests (`invalidate()` on the `taa` facet: tank switches, cuts), the
 *   reactive mask input (a 1×1 zero placeholder until W2 transparents write one) and a NaN scrub on every input.
 * - Catmull-Rom upscale of the current frame when render scale < 1, only until the temporal upscaler (tsr.ts) has built
 *   its pipelines: from then on it resolves frames rendered below display size, into the same texture, and this pass rests.
 * Installing TAA turns the camera jitter on (`settings.jitter = true`).
 *
 * Post input (CC-013, plan §4.5): the resolve also reaches `postColor` (display size), the colour the rest of the post
 * chain works on. 'taa.present' (slot 'taa', order 10) copies taaColor → postColor; optional DOF replaces that copy with
 * the depth-aware blurred scene. The forward 'overlay' pass then draws the ribbon, rings and debug lines into postColor,
 * and bloom and composite read postColor. Overlays stay sharp and never enter the TAA history, which stays taaColor.
 */
import type { EngineServices, FrameState, RenderModule } from '../../contracts';
import { BindGroupResourceCache } from '../../gpu/bind-group-cache';
import { BufferUsage, ShaderStage, TextureUsage } from '../../gpu/flags';
import { frameWgsl } from '../../wgsl/common/frame.wgsl';
import { gbufferWgsl } from '../../wgsl/common/gbuffer.wgsl';
import { link, makeModule, wgslStruct } from '../../wgsl/module';
import { createFrameBindGroup } from '../gbuffer/gbuffer';
import { HDR_FORMAT } from '../lighting/lighting';
import type { installTsr } from './tsr';
import type { TsrDebugView } from './tsr.wgsl';

/** History blend (current-frame weight) with a full ±0.5 px Halton jitter. */
export const TAA_BLEND = 0.1;
export const TAA_TEXTURE = 'taaColor';
/** The post chain's input (display size, HDR): the TAA resolve plus the overlays; read by bloom and composite (CC-013). */
export const POST_TEXTURE = 'postColor';

export const TAA_PARAMS = wgslStruct('TaaParams', [
  ['control', 'vec4f'],   // x blend, y reset (1 = no history this frame), z render scale, w enabled
]);

declare module '../../contracts' {
  interface SceneFacets {
    /** W1-ENG-LOOK: TAA controls. */
    taa: TaaFacet;
  }
}
export interface TaaFacet {
  /** false: the pass still runs but outputs the current frame (no history). */
  enabled: boolean;
  /** Drop the history on the next frame (tank switch, cinematic cut). */
  invalidate(): void;
  /** The temporal upscaler that resolves instead of this pass while the frame is rendered below display size (tsr.ts). */
  readonly tsr: TsrControls;
}

/** The temporal upscaler's look levers and debug view; read every frame. */
export interface TsrControls {
  /** RCAS strength, 0 (off: the pass only leaves tonemap space) to 1 (sharpest). */
  sharpness: number;
  /** Ceiling of the history's sample count: higher is steadier and slower to forget. */
  maxAccumulation: number;
  /** Thin-feature locks, 0 (off) to 1. */
  locks: number;
  /** Gain from the tonemapped difference the gas, fire and spray passes (or the clouds) made to a pixel to its reactive weight (or veil). */
  reactiveGain: number;
  /** Current-frame weight floor of a reactive (or relit, re-committed or veiled) pixel: the TAA's blend, so it trails no longer than natively. */
  reactiveBlend: number;
  /** 0 to 1: how far a pixel with little history is softened (wider kernel, no sharpening) until it has accumulated. */
  youngSoft: number;
  /** Where a clipped history is drawn: 0 toward this frame's sharp upsample, 1 toward its soft one. */
  clipCentre: number;
  /** How many σ a still, converged, quiet pixel's clip box widens by: steadier stills, slower to follow a slow change of light. */
  stillWiden: number;
  debugView: TsrDebugView;
  /** True while the upscaler, not this pass, writes the frame. */
  readonly active: boolean;
}
// Sharpness and clip centre matched to the native frame's pixel-to-pixel contrast: sharpness 0.8 toward the sharp upsample
// put up to a third more of it on screen than the native TAA does, in stills and in motion.
export const TSR_DEFAULTS = { sharpness: 0.5, maxAccumulation: 24, locks: 1, reactiveGain: 16, reactiveBlend: TAA_BLEND, youngSoft: 1, clipCentre: 1, stillWiden: 8 } as const;

/** Does a frame of this internal size need the upscaler? Equal sizes (and supersampling) stay with this pass. */
export function tsrWanted(display: readonly [number, number], internal: readonly [number, number]): boolean {
  return internal[0] < display[0] || internal[1] < display[1];
}

export const taaWgsl = makeModule('taa', /* wgsl */ `
@group(1) @binding(0) var current_tex: texture_2d<f32>;
@group(1) @binding(1) var history_tex: texture_2d<f32>;
@group(1) @binding(2) var velocity_tex: texture_2d<f32>;
@group(1) @binding(3) var depth_tex: texture_depth_2d;
@group(1) @binding(4) var ids_tex: texture_2d<u32>;
@group(1) @binding(5) var reactive_tex: texture_2d<f32>;
@group(1) @binding(6) var lin_sampler: sampler;
@group(1) @binding(7) var taa_out: texture_storage_2d<rgba16float, write>;
@group(1) @binding(8) var<uniform> taa: TaaParams;

fn rgb_to_ycocg(c: vec3f) -> vec3f {
  return vec3f(0.25 * c.r + 0.5 * c.g + 0.25 * c.b, 0.5 * c.r - 0.5 * c.b, -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
}
fn ycocg_to_rgb(c: vec3f) -> vec3f { return vec3f(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z); }
fn luma_weight(c: vec3f) -> vec3f { return c / (1.0 + max(c.r, max(c.g, c.b))); }
fn luma_unweight(c: vec3f) -> vec3f { return c / max(1.0 - max(c.r, max(c.g, c.b)), 1e-5); }

/** NaN/Inf scrub: explicit self-inequality first (WGSL min/max do not guarantee NaN semantics). */
fn taa_scrub(c: vec3f) -> vec3f {
  let finite = select(c, vec3f(0.0), c != c);
  return min(max(finite, vec3f(0.0)), vec3f(65504.0));
}

fn catmull_rom_weights(t: f32) -> vec4f {
  let t2 = t * t;
  let t3 = t2 * t;
  return vec4f(-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1.0, -1.5 * t3 + 2.0 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2);
}

/** 4×4 Catmull-Rom as 4 bilinear taps; pos in texels of a texture of size res. */
fn sample_catmull_rom(tex: texture_2d<f32>, pos: vec2f, res: vec2f) -> vec3f {
  let texel = floor(pos - 0.5) + 0.5;
  let f = pos - texel;
  let wx = catmull_rom_weights(f.x);
  let wy = catmull_rom_weights(f.y);
  let wx01 = wx.x + wx.y; let wx23 = wx.z + wx.w;
  let wy01 = wy.x + wy.y; let wy23 = wy.z + wy.w;
  let ox01 = (texel.x - 1.0) + wx.y / max(wx01, 1e-6);
  let ox23 = (texel.x + 1.0) + wx.w / max(wx23, 1e-6);
  let oy01 = (texel.y - 1.0) + wy.y / max(wy01, 1e-6);
  let oy23 = (texel.y + 1.0) + wy.w / max(wy23, 1e-6);
  let inv = 1.0 / res;
  let s00 = textureSampleLevel(tex, lin_sampler, vec2f(ox01, oy01) * inv, 0.0).rgb;
  let s10 = textureSampleLevel(tex, lin_sampler, vec2f(ox23, oy01) * inv, 0.0).rgb;
  let s01 = textureSampleLevel(tex, lin_sampler, vec2f(ox01, oy23) * inv, 0.0).rgb;
  let s11 = textureSampleLevel(tex, lin_sampler, vec2f(ox23, oy23) * inv, 0.0).rgb;
  return max((s00 * wx01 + s10 * wx23) * wy01 + (s01 * wx01 + s11 * wx23) * wy23, vec3f(0.0));
}

/** Previous-frame uv of a sky pixel: its direction as a point at infinity through the previous unjittered view-proj. */
fn reproject_sky(uv: vec2f) -> vec2f {
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  // Unjittered pixel-centre ray (proj[2][0] carries −jitter.x).
  let vr = vec3f((ndc.x + frame.proj[2][0] + frame.jitter.x) / frame.proj[0][0],
                 (ndc.y + frame.proj[2][1] + frame.jitter.y) / frame.proj[1][1], -1.0);
  let r = mat3x3f(frame.view[0].xyz, frame.view[1].xyz, frame.view[2].xyz);
  let dir = transpose(r) * vr;
  let c = frame.prev_view_proj * vec4f(dir, 0.0);
  if (c.w <= 1e-6) { return vec2f(-1.0); }
  let p = c.xy / c.w;
  return vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
}

var<workgroup> tile: array<vec3f, 100>;   // 10×10 luma-weighted YCoCg neighbourhood (native resolution)

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) li: u32) {
  let out_res = frame_display_size();
  let in_res = frame_internal_size();
  let hi = vec2i(in_res) - vec2i(1);
  let upscaling = taa.control.z < 0.999;
  // Native resolution: the 3×3 neighbourhoods of the whole 8×8 group come from one shared 10×10 tile (1.6 loads/px, not 9).
  // Every invocation reaches the barrier (uniform control flow); bounds are checked afterwards.
  if (!upscaling) {
    let origin = vec2i(wid.xy) * 8 - vec2i(1);
    for (var k = li; k < 100u; k += 64u) {
      let sp = clamp(origin + vec2i(i32(k % 10u), i32(k / 10u)), vec2i(0), hi);
      tile[k] = rgb_to_ycocg(luma_weight(taa_scrub(textureLoad(current_tex, sp, 0).rgb)));
    }
  }
  workgroupBarrier();
  if (f32(gid.x) >= out_res.x || f32(gid.y) >= out_res.y) { return; }
  let uv = (vec2f(gid.xy) + 0.5) / out_res;
  let in_pos = uv * in_res;
  let in_texel = min(vec2i(in_pos), hi);
  var current: vec3f;
  if (upscaling) { current = taa_scrub(sample_catmull_rom(current_tex, in_pos, in_res)); }
  else { current = taa_scrub(textureLoad(current_tex, in_texel, 0).rgb); }
  if (taa.control.w < 0.5 || taa.control.y > 0.5) {
    textureStore(taa_out, vec2i(gid.xy), vec4f(current, 1.0));
    return;
  }

  // Neighbourhood variance clip (3×3, luma-weighted YCoCg).
  var n_min = vec3f(1e10);
  var n_max = vec3f(-1e10);
  var m1 = vec3f(0.0);
  var m2 = vec3f(0.0);
  let lp = vec2i(gid.xy) - vec2i(wid.xy) * 8 + vec2i(1);
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      var w: vec3f;
      if (upscaling) {
        w = rgb_to_ycocg(luma_weight(taa_scrub(textureLoad(current_tex, clamp(in_texel + vec2i(dx, dy), vec2i(0), hi), 0).rgb)));
      } else {
        w = tile[u32((lp.y + dy) * 10 + lp.x + dx)];
      }
      n_min = min(n_min, w);
      n_max = max(n_max, w);
      m1 += w;
      m2 += w * w;
    }
  }
  let avg = m1 / 9.0;
  let sigma = sqrt(max(m2 / 9.0 - avg * avg, vec3f(0.0)));
  let gamma = select(1.0, 1.25, upscaling);
  let clip_min = max(n_min, avg - sigma * gamma);
  let clip_max = min(n_max, avg + sigma * gamma);

  // Reprojection: velocity for raster pixels, direction for the sky.
  let depth = textureLoad(depth_tex, in_texel, 0);
  var prev_uv: vec2f;
  if (depth <= 0.0) { prev_uv = reproject_sky(uv); }
  else { prev_uv = uv + textureLoad(velocity_tex, in_texel, 0).rg; }
  let in_screen = all(prev_uv >= vec2f(0.0)) && all(prev_uv <= vec2f(1.0));

  // Bilinear history at native resolution (the variance clip bounds it), Catmull-Rom when upscaling.
  var history_raw: vec3f;
  if (upscaling) { history_raw = taa_scrub(sample_catmull_rom(history_tex, prev_uv * out_res, out_res)); }
  else { history_raw = taa_scrub(textureSampleLevel(history_tex, lin_sampler, prev_uv, 0.0).rgb); }
  let hy = rgb_to_ycocg(luma_weight(history_raw));
  let clamped = clamp(hy, clip_min, clip_max);
  let disocclusion = clamp(length(hy - clamped) * 8.0, 0.0, 1.0);
  let history = luma_unweight(ycocg_to_rgb(clamped));

  var alpha = max(taa.control.x, disocclusion);
  let ids = textureLoad(ids_tex, in_texel, 0).r;
  if ((gbuffer_flags(ids) & GB_FLAG_NEW_GEOMETRY) != 0u) { alpha = 1.0; }
  let rs = textureDimensions(reactive_tex);
  let reactive = textureLoad(reactive_tex, min(vec2u(uv * vec2f(rs)), rs - vec2u(1u)), 0).r;
  alpha = max(alpha, reactive);
  if (!in_screen) { alpha = 1.0; }
  textureStore(taa_out, vec2i(gid.xy), vec4f(taa_scrub(mix(history, current, alpha)), 1.0));
}
`, [frameWgsl, gbufferWgsl, TAA_PARAMS.module]);

export function taaShader() { return link(taaWgsl); }

/** CPU mirror: velocity of a static point under camera motion (uv_prev − uv_current, both unjittered). Tests use it. */
export function velocityOf(prevViewProj: ArrayLike<number>, viewProjNoJitter: ArrayLike<number>, p: readonly number[]): [number, number] {
  const uvOf = (m: ArrayLike<number>) => {
    const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    return [(x / w) * 0.5 + 0.5, 0.5 - (y / w) * 0.5];
  };
  const a = uvOf(prevViewProj), b = uvOf(viewProjNoJitter);
  return [a[0] - b[0], a[1] - b[1]];
}

/** Should the history be dropped this frame? */
export function taaReset(f: Pick<FrameState, 'snap' | 'index'>, invalidated: boolean): boolean {
  return !!f.snap || invalidated || f.index === 0;
}

export function taaModule(): RenderModule {
  const disposers: (() => void)[] = [];
  return {
    name: 'taa',
    install(s: EngineServices) {
      const { device, queue } = s.ctx;
      s.settings.jitter = true;
      s.graph.declareTexture(TAA_TEXTURE, { format: HDR_FORMAT, size: 'display', usage: TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_SRC, history: true });
      s.graph.declareTexture(POST_TEXTURE, { format: HDR_FORMAT, size: 'display', usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST });
      const C = ShaderStage.COMPUTE;
      const layout = device.createBindGroupLayout({ label: 'layout:taa', entries: [
        { binding: 0, visibility: C, texture: { sampleType: 'float' } },
        { binding: 1, visibility: C, texture: { sampleType: 'float' } },
        { binding: 2, visibility: C, texture: { sampleType: 'unfilterable-float' } },
        { binding: 3, visibility: C, texture: { sampleType: 'depth' } },
        { binding: 4, visibility: C, texture: { sampleType: 'uint' } },
        { binding: 5, visibility: C, texture: { sampleType: 'float' } },
        { binding: 6, visibility: C, sampler: { type: 'filtering' } },
        { binding: 7, visibility: C, storageTexture: { access: 'write-only', format: HDR_FORMAT } },
        { binding: 8, visibility: C, buffer: { type: 'uniform' } },
      ] });
      const key = 'post:taa';
      s.ctx.pipelines.register(key, 'compute', () => ({
        label: key, layout: device.createPipelineLayout({ bindGroupLayouts: [s.ctx.layouts.frame, layout] }),
        compute: { module: s.ctx.pipelines.shaderModule(taaShader(), key), entryPoint: 'main' },
      }));
      void s.ctx.pipelines.compile(key).catch(() => undefined);
      const sampler = device.createSampler({ label: 'taa:linear', magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
      const reactive = device.createTexture({ label: 'taa:reactive-placeholder', size: [1, 1], format: 'r8unorm', usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST });
      const reactiveView = reactive.createView();
      const params = device.createBuffer({ label: 'taa:params', size: TAA_PARAMS.size, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      const staging = new ArrayBuffer(TAA_PARAMS.size);
      disposers.push(() => { s.ctx.deferDestroy(reactive); s.ctx.deferDestroy(params); });
      const frameGroup = createFrameBindGroup(s, 'taa');
      const groups = new BindGroupResourceCache(4);
      let invalidated = true;
      let lastDisplay = '';
      // The upscaler is fetched the first time a frame is rendered below display size: native sessions never load it.
      let tsr: ReturnType<typeof installTsr> | undefined, wanted = false, loading = false, disposed = false;
      const controls: TsrControls = { ...TSR_DEFAULTS, debugView: 'off', get active() { return !!tsr?.active(); } };
      const load = () => {
        if (loading) return;
        loading = true;
        import('./tsr').then(m => { if (!disposed) tsr = m.installTsr(s, { output: TAA_TEXTURE, enabled: () => facet.enabled, wanted: () => wanted }, controls); },
          error => console.error('[engine] the temporal upscaler could not be loaded; the TAA keeps upscaling', error));
      };
      if ((s.settings.renderScale || 1) < 1) load();
      disposers.push(() => { disposed = true; tsr?.dispose(); });
      const facet: TaaFacet = { enabled: true, invalidate: () => { invalidated = true; tsr?.invalidate(); }, tsr: controls };
      s.scene.provide('taa', facet);
      disposers.push(s.events.on('resize', e => { invalidated = true; wanted = tsrWanted(e.display, e.internal); if (wanted) load(); }));
      disposers.push(s.graph.addPass({
        name: 'taa', slot: 'taa', order: 0,
        reads: ['frameUniforms', 'hdr', 'velocity', 'depth', 'ids', `history:${TAA_TEXTURE}`], writes: [TAA_TEXTURE],
        // Below display size the upscaler resolves instead, once it is loaded and its pipelines exist.
        enabled: () => !tsr?.active(),
        run(c) {
          const pipeline = s.ctx.pipelines.get<GPUComputePipeline>(key);
          const f = c.frame;
          const displayKey = `${f.display[0]}x${f.display[1]}`;
          if (displayKey !== lastDisplay) { lastDisplay = displayKey; invalidated = true; }
          const reset = taaReset(f, invalidated) || !pipeline;
          if (!pipeline) return;
          const scale = f.internal[0] / Math.max(1, f.display[0]);
          TAA_PARAMS.pack({ control: [TAA_BLEND, reset ? 1 : 0, scale, facet.enabled ? 1 : 0] }, staging);
          queue.writeBuffer(params, 0, staging);
          invalidated = false;
          const r = c.resources;
          const views = [r.view('hdr'), r.history(TAA_TEXTURE), r.view('velocity'), r.view('depth'), r.view('ids'), reactiveView, r.view(TAA_TEXTURE)];
          const k = groups.begin(); k.push(...views);
          const group = groups.get(() => device.createBindGroup({ label: 'taa', layout, entries: [
            ...views.slice(0, 6).map((resource, binding) => ({ binding, resource })),
            { binding: 6, resource: sampler }, { binding: 7, resource: views[6] }, { binding: 8, resource: { buffer: params } }] }));
          const ts = c.timestampWrites('taa') as GPUComputePassTimestampWrites | undefined;
          const pass = c.encoder.beginComputePass({ label: 'taa', ...(ts ? { timestampWrites: ts } : {}) });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, frameGroup);
          pass.setBindGroup(1, group);
          pass.dispatchWorkgroups(Math.ceil(f.display[0] / 8), Math.ceil(f.display[1] / 8));
          pass.end();
        },
      }));
      // The resolve becomes the post chain's input; overlays draw into that copy, so the history never sees them.
      disposers.push(s.graph.addPass({
        name: 'taa.present', slot: 'taa', order: 10, reads: [TAA_TEXTURE], writes: [POST_TEXTURE],
        run(c) {
          const size = c.resources.size(POST_TEXTURE);
          c.encoder.copyTextureToTexture({ texture: c.resources.texture(TAA_TEXTURE) }, { texture: c.resources.texture(POST_TEXTURE) }, [size[0], size[1], 1]);
        },
      }));
    },
    dispose() { for (const d of disposers.splice(0)) d(); },
  };
}
