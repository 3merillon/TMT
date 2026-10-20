/**
 * Overlays (plan §4.5 'overlay' slot: after TAA/DOF, so they stay sharp; drawn by the forward overlay pass into the post
 * chain's input 'postColor' at DISPLAY size, with no depth attachment, CC-013). Scene facet `overlays`:
 *
 * - Trajectory ribbon: a SCREEN-SPACE ribbon through the preview points, miter joins (miter limit 4), 5 px × DPR wide,
 *   a bright solid core with dark outline, DOTTED and dimmer where the scene depth occludes it (the ribbon does its own
 *   depth test against the depth texture, so the hidden part stays readable).
 * - Terrain-projected rings (target marker, radar pulse): one fullscreen pass reconstructs the world position
 *   from depth and shades `|dist(p, c) − r| < w` for ≤ 16 rings, so rings hug any relief, crater or wall.
 * Colours are exposure-invariant (divided by frame.exposure), so a ring of colour c displays close to c after AgX.
 * The depth texture (internal size) is captured by a tiny 'overlay.depth' pass (slot 'transparent', order −10) that
 * declares the read; the fragment shaders scale display pixels to it (`overlay_scene_depth`). Every overlay pipeline has
 * no depthStencil state (the overlay pass has no depth attachment) and projects with `view_proj_nojitter`.
 *
 * Consumption check: after every frame the module asks whether a later pass read the output of the forward 'overlay'
 * pass (bloom and composite read 'postColor'); `stats()` reports it as `consumed`, and the takeover budget gates it.
 * The W1-ENG-SCENE fallback that moved the overlays into the transparent pass (before TAA) is retired with CC-013: the
 * overlay pipelines no longer match a pass with a depth attachment, so a dead overlay pass is reported (console error,
 * consumed = false) rather than rerouted. `route` therefore stays 'overlay'.
 */
import type { EngineServices, OverlayDrawer, PassDecl, RenderModule, Vec3 } from '../contracts';
import { BindGroupResourceCache } from '../gpu/bind-group-cache';
import { BufferUsage, ShaderStage } from '../gpu/flags';
import { fullscreenWgsl } from '../gpu/fullscreen';
import { FORWARD_BLEND_OVER, FORWARD_COLOR_TARGET } from '../passes/forward/forward';
import { depthWgsl } from '../wgsl/common/depth.wgsl';
import { frameWgsl } from '../wgsl/common/frame.wgsl';
import { link, makeModule, wgslStruct } from '../wgsl/module';
import './facets';
import type { OverlayRoute, Scene } from './scene-registry';

export const MAX_RINGS = 16;
export const MAX_RIBBON_POINTS = 512;
export const RIBBON_MITER_LIMIT = 4;

export interface RibbonStyle {
  color: Vec3;
  /** CSS px (× device pixel ratio on screen). */
  width: number;
  /** Dash period in world units along the arc, and dash speed (periods per second). */
  dash: number;
  speed: number;
  /** Alpha of the depth-occluded (dotted) part. */
  occludedAlpha: number;
  alpha: number;
}
export const DEFAULT_RIBBON: RibbonStyle = { color: [0.55, 1.0, 0.82], width: 5, dash: 0.75, speed: 0, occludedAlpha: 0.5, alpha: 0.98 };

export interface OverlayRing { center: Vec3; radius: number; width: number; color: Vec3; alpha: number }

export interface OverlayFacet {
  /** Replace the ribbon (≥ 2 points; null or < 2 hides it). */
  setRibbon(points: readonly (readonly number[])[] | null, style?: Partial<RibbonStyle>): void;
  /** Replace the ring list (≤ 16 kept, in order). */
  setRings(rings: readonly OverlayRing[]): void;
  /** `route`: the forward pass the overlays draw in; `consumed`: whether a pass that ran after it last frame reads its
   * output (null: cannot tell yet); `peakRings`: the most rings submitted in one call since install (a short-lived ring
   * such as a radar pulse still shows in telemetry sampled after it expired). */
  stats(): { ribbonPoints: number; rings: number; peakRings: number; route: OverlayRoute; consumed: boolean | null };
}

// ───────────────────────────── Ribbon miter (TS mirror of ribbon_offset) ─────────────────────────────

type V2 = [number, number];
const n2 = (v: V2): V2 => { const l = Math.hypot(v[0], v[1]); return l > 1e-12 ? [v[0] / l, v[1] / l] : [0, 0]; };
const perp = (d: V2): V2 => [-d[1], d[0]];

/**
 * Screen-space offset (pixels) of the LEFT (+1) side at `curr`, given its neighbours (pass `prev === curr` or
 * `next === curr` at the ends). Mirror of `ribbon_offset` in WGSL: the miter of the two segment normals, length
 * halfWidth / cos(half turn), limited to RIBBON_MITER_LIMIT × halfWidth.
 */
export function ribbonOffset(prev: V2, curr: V2, next: V2, halfWidth: number): V2 {
  let d0 = n2([curr[0] - prev[0], curr[1] - prev[1]]);
  let d1 = n2([next[0] - curr[0], next[1] - curr[1]]);
  if (d0[0] === 0 && d0[1] === 0) d0 = d1;
  if (d1[0] === 0 && d1[1] === 0) d1 = d0;
  const nA = perp(d0), nB = perp(d1);
  let m = n2([nA[0] + nB[0], nA[1] + nB[1]]);
  if (m[0] === 0 && m[1] === 0) m = nB; // 180° fold: fall back to the outgoing normal
  const c = Math.max(m[0] * nB[0] + m[1] * nB[1], 1 / RIBBON_MITER_LIMIT);
  const len = halfWidth / c;
  return [m[0] * len, m[1] * len];
}

// ───────────────────────────── WGSL ─────────────────────────────

export const RIBBON_PARAMS = wgslStruct('RibbonParams', [
  ['color', 'vec4f'],   // rgb, alpha
  ['style', 'vec4f'],   // half width (px), dash period, dash speed, occluded alpha
  ['count', 'vec4u'],   // points
]);
export const RINGS = wgslStruct('OverlayRings', [
  ['count', 'vec4u'],
  ['centers', { array: 'vec4f', count: MAX_RINGS }],  // xyz, radius
  ['colors', { array: 'vec4f', count: MAX_RINGS }],   // rgb, alpha
  ['widths', { array: 'vec4f', count: MAX_RINGS }],   // x width
]);

const overlayDepthWgsl = makeModule('overlay-depth', /* wgsl */ `
@group(1) @binding(0) var overlay_depth: texture_depth_2d;
/**
 * The jittered raster's uv of a DISPLAY pixel of the resolved image. The overlays draw after TAA, onto the unjittered
 * resolve, but the depth texture is this frame's jittered raster: a surface point sits one jitter offset away in it
 * (camera.ts: ndc_jittered = ndc + jitter). Reading depth at the display uv made rings swim with the jitter cycle.
 */
fn overlay_raster_uv(px: vec2f) -> vec2f {
  return px / max(frame_display_size(), vec2f(1.0)) + vec2f(frame.jitter.x, -frame.jitter.y) * 0.5;
}
/** Scene depth under a DISPLAY pixel (the overlay pass runs at display size; the depth texture is internal size). */
fn overlay_scene_depth(px: vec2f) -> f32 {
  let size = vec2i(textureDimensions(overlay_depth));
  let at = overlay_raster_uv(px) * vec2f(size);
  return textureLoad(overlay_depth, clamp(vec2i(at), vec2i(0), size - vec2i(1)), 0);
}
fn overlay_radiance(c: vec3f) -> vec3f { return c / max(frame.exposure, 1e-4); }
`, [frameWgsl]);

const ribbonShader = makeModule('overlay-ribbon', /* wgsl */ `
@group(2) @binding(0) var<storage, read> ribbon_points: array<vec4f>;   // xyz, arc length
@group(2) @binding(1) var<uniform> ribbon: RibbonParams;

struct RibbonOut {
  @builtin(position) position: vec4f,
  @location(0) arc: f32,
  @location(1) side: f32,
}

fn to_screen(c: vec4f) -> vec2f {
  let size = frame_display_size();
  return (c.xy / c.w * vec2f(0.5, -0.5) + vec2f(0.5)) * size;
}

/** Mirror: ribbonOffset in overlays.ts. */
fn ribbon_offset(prev: vec2f, curr: vec2f, next: vec2f, half_width: f32) -> vec2f {
  var d0 = curr - prev;
  var d1 = next - curr;
  let l0 = length(d0);
  let l1 = length(d1);
  d0 = select(vec2f(0.0), d0 / l0, l0 > 1e-6);
  d1 = select(vec2f(0.0), d1 / l1, l1 > 1e-6);
  if (l0 <= 1e-6) { d0 = d1; }
  if (l1 <= 1e-6) { d1 = d0; }
  let na = vec2f(-d0.y, d0.x);
  let nb = vec2f(-d1.y, d1.x);
  var m = na + nb;
  let lm = length(m);
  m = select(nb, m / lm, lm > 1e-6);
  let c = max(dot(m, nb), 1.0 / ${RIBBON_MITER_LIMIT.toFixed(1)});
  return m * (half_width / c);
}

@vertex
fn vs_ribbon(@builtin(vertex_index) vi: u32) -> RibbonOut {
  let n = ribbon.count.x;
  let i = min(vi / 2u, n - 1u);
  let side = select(-1.0, 1.0, (vi & 1u) == 1u);
  let pi = ribbon_points[i];
  let pp = ribbon_points[select(i - 1u, i, i == 0u)];
  let pn = ribbon_points[min(i + 1u, n - 1u)];
  let cc = frame.view_proj_nojitter * vec4f(pi.xyz, 1.0);
  let cp = frame.view_proj_nojitter * vec4f(pp.xyz, 1.0);
  let cn = frame.view_proj_nojitter * vec4f(pn.xyz, 1.0);
  var out: RibbonOut;
  out.arc = pi.w;
  out.side = side;
  // Clip at the near plane: a point behind it moves along its segment to the crossing with a neighbour in front (so
  // the strip ends exactly there). Collapsing it to a fixed point instead drew one-frame wedges across the screen.
  let w_min = frame_near() * 1.01;
  var at = cc;
  var cn_at = cn;
  var cp_at = cp;
  if (cc.w < w_min) {
    if (cn.w >= w_min) { at = mix(cc, cn, (w_min - cc.w) / (cn.w - cc.w)); cp_at = at; }
    else if (cp.w >= w_min) { at = mix(cc, cp, (w_min - cc.w) / (cp.w - cc.w)); cn_at = at; }
    else { out.position = vec4f(0.0, 0.0, 0.0, -1.0); return out; }
  }
  if (cn_at.w < w_min) { cn_at = mix(at, cn_at, (at.w - w_min) / max(at.w - cn_at.w, 1e-6)); }
  if (cp_at.w < w_min) { cp_at = mix(at, cp_at, (at.w - w_min) / max(at.w - cp_at.w, 1e-6)); }
  let sc = to_screen(at);
  let sp = to_screen(cp_at);
  let sn = to_screen(cn_at);
  let offset = ribbon_offset(sp, sc, sn, ribbon.style.x) * side;
  let size = frame_display_size();
  let ndc_offset = offset / size * vec2f(2.0, -2.0);
  out.position = vec4f(at.xy + ndc_offset * at.w, at.z, at.w);
  return out;
}

@fragment
fn fs_ribbon(in: RibbonOut) -> @location(0) vec4f {
  let scene = overlay_scene_depth(in.position.xy);
  // Reversed-Z: a SMALLER depth is farther; occluded when the scene surface is nearer by a small margin.
  let occluded = scene > in.position.z * 1.002 + 1e-7;
  let period = max(ribbon.style.y, 1e-3);
  let phase = in.arc / period - frame.time * ribbon.style.z;
  let edge = 1.0 - smoothstep(0.8, 1.0, abs(in.side));
  var a: f32;
  if (occluded) {
    let dot_phase = fract(phase * 3.0);
    a = select(0.0, ribbon.style.w, dot_phase < 0.32);
  } else {
    a = 1.0;
  }
  let alpha = a * ribbon.color.a * edge;
  if (alpha <= 0.002) { discard; }
  let core = 1.0 - smoothstep(0.45, 0.7, abs(in.side));
  let color = mix(vec3f(0.008, 0.022, 0.018), ribbon.color.rgb, core);
  return vec4f(overlay_radiance(color) * alpha, alpha);
}
`, [frameWgsl, overlayDepthWgsl, RIBBON_PARAMS.module]);

const ringsShader = makeModule('overlay-rings', /* wgsl */ `
@group(2) @binding(0) var<uniform> rings: OverlayRings;

/**
 * The world point under a DISPLAY pixel of the resolved image: the four jittered depth texels around its raster uv,
 * each reconstructed exactly at its own centre and blended bilinearly where they lie on one surface (nearest texel at
 * an edge). Nearest-texel depth on a display-pixel ray stair-stepped on slopes, and the steps crawled with the jitter.
 */
fn overlay_world_at(px: vec2f) -> vec4f {
  let size = vec2i(textureDimensions(overlay_depth));
  let sizef = vec2f(size);
  let uv = overlay_raster_uv(px);
  let t = uv * sizef - 0.5;
  let base = floor(t);
  let f = t - base;
  let i0 = clamp(vec2i(base), vec2i(0), size - vec2i(1));
  let i1 = clamp(vec2i(base) + vec2i(1), vec2i(0), size - vec2i(1));
  let d00 = textureLoad(overlay_depth, i0, 0);
  let d10 = textureLoad(overlay_depth, vec2i(i1.x, i0.y), 0);
  let d01 = textureLoad(overlay_depth, vec2i(i0.x, i1.y), 0);
  let d11 = textureLoad(overlay_depth, i1, 0);
  let nearest = select(select(d00, d10, f.x >= 0.5), select(d01, d11, f.x >= 0.5), f.y >= 0.5);
  if (min(min(d00, d10), min(d01, d11)) > 0.0) {
    let p00 = world_pos_from_depth((vec2f(i0) + 0.5) / sizef, d00);
    let p10 = world_pos_from_depth((vec2f(f32(i1.x), f32(i0.y)) + 0.5) / sizef, d10);
    let p01 = world_pos_from_depth((vec2f(f32(i0.x), f32(i1.y)) + 0.5) / sizef, d01);
    let p11 = world_pos_from_depth((vec2f(i1) + 0.5) / sizef, d11);
    // Four points of one smooth surface nearly form a parallelogram; across a silhouette they do not.
    let skew = length(p00 + p11 - p10 - p01);
    if (skew < 0.15 * (length(p10 - p00) + length(p01 - p00)) + 1e-4) {
      return vec4f(mix(mix(p00, p10, f.x), mix(p01, p11, f.x), f.y), nearest);
    }
  }
  if (nearest <= 0.0) { return vec4f(0.0); }
  return vec4f(world_pos_from_depth(uv, nearest), nearest);
}

@fragment
fn fs_rings(in: FullscreenOut) -> @location(0) vec4f {
  let hit = overlay_world_at(in.pos.xy);
  let d = hit.w;
  if (d <= 0.0) { discard; }
  let p = hit.xyz;
  var color = vec3f(0.0);
  var alpha = 0.0;
  let n = min(rings.count.x, ${MAX_RINGS}u);
  // Screen-space width floor: rings stay at least ~1.5 px wide at any distance.
  let px_world = linear_depth(d) * 2.0 / (frame.proj[1][1] * frame_display_size().y);
  for (var i = 0u; i < n; i++) {
    let c = rings.centers[i];
    let w = max(rings.widths[i].x, px_world * 1.5);
    let dist = abs(distance(p, c.xyz) - c.w);
    let a = (1.0 - smoothstep(w * 0.5, w, dist)) * rings.colors[i].a;
    color = color * (1.0 - a) + overlay_radiance(rings.colors[i].rgb) * a;
    alpha = alpha + a * (1.0 - alpha);
  }
  if (alpha <= 0.002) { discard; }
  return vec4f(color, alpha);
}
`, [frameWgsl, depthWgsl, overlayDepthWgsl, fullscreenWgsl, RINGS.module]);

export function ribbonShaderLinked() { return link(ribbonShader); }
export function ringsShaderLinked() { return link(ringsShader); }


const depthViews = new WeakMap<EngineServices, { view: () => GPUTextureView | null; layout: GPUBindGroupLayout; group: () => GPUBindGroup | null }>();

/** The shared 'overlay.depth' capture pass (registered once per engine). */
export function overlayDepth(s: EngineServices): { layout: GPUBindGroupLayout; group: () => GPUBindGroup | null } {
  let entry = depthViews.get(s);
  if (entry) return entry;
  const { device } = s.ctx;
  const layout = device.createBindGroupLayout({ label: 'layout:overlay-depth', entries: [{ binding: 0, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'depth' } }] });
  let current: GPUTextureView | null = null;
  const cache = new BindGroupResourceCache(4);
  s.graph.addPass({ name: 'overlay.depth', slot: 'transparent', order: -10, reads: ['depth'], writes: [], run: c => { current = c.resources.view('depth'); } });
  entry = {
    layout, view: () => current,
    group: () => {
      if (!current) return null;
      const k = cache.begin(); k.push(current);
      return cache.get(() => device.createBindGroup({ label: 'overlay-depth', layout, entries: [{ binding: 0, resource: current! }] }));
    },
  };
  depthViews.set(s, entry);
  return entry;
}

/**
 * Whether the post chain consumes what a forward pass (default 'overlay') draws: some pass that ran after it in the last
 * frame reads one of its outputs ('hdr'). A post chain whose bloom and composite read a TAA output instead would leave the
 * ribbon and every ring invisible without any error; the overlays module reroutes on false, and the takeover budget gates
 * the result. The graph's sorted pass list is not part of FrameGraphApi, so it is read defensively: null when unknown.
 */
export function overlayOutputConsumed(graph: unknown, executed: readonly string[] | undefined, pass: OverlayRoute = 'overlay'): boolean | null {
  const sorted = (graph as { sorted?: unknown } | null)?.sorted;
  if (!Array.isArray(sorted) || !executed?.length) return null;
  const decls = sorted as PassDecl[];
  const at = decls.findIndex(d => d?.name === pass && d.slot === pass);
  if (at < 0 || !executed.includes(pass)) return null;
  const outputs = decls[at].writes;
  const ran = new Set(executed);
  return decls.slice(at + 1).some(d => ran.has(d.name) && d.reads.some(r => outputs.includes(r)));
}

export interface OverlaysModule extends RenderModule { readonly facet: OverlayFacet | null }

export function overlaysModule(): OverlaysModule {
  const disposers: (() => void)[] = [];
  let facet: OverlayFacet | null = null;
  return {
    name: 'scene.overlays',
    get facet() { return facet; },
    async install(s: EngineServices) {
      const { device, queue } = s.ctx;
      const cache = s.ctx.pipelines;
      const depth = overlayDepth(s);
      const scene = s.scene as Scene;
      let consumed: boolean | null = null;
      const F = ShaderStage.FRAGMENT, VF = ShaderStage.VERTEX | ShaderStage.FRAGMENT;
      const ribbonLayout = device.createBindGroupLayout({ label: 'layout:overlay-ribbon', entries: [
        { binding: 0, visibility: ShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: VF, buffer: { type: 'uniform' } },
      ] });
      const ringsLayout = device.createBindGroupLayout({ label: 'layout:overlay-rings', entries: [{ binding: 0, visibility: F, buffer: { type: 'uniform' } }] });
      const target: GPUColorTargetState = { ...FORWARD_COLOR_TARGET, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: FORWARD_BLEND_OVER.alpha } };
      cache.register('overlay:ribbon', 'render', () => {
        const module = cache.shaderModule(ribbonShaderLinked(), 'overlay:ribbon');
        return {
          label: 'overlay:ribbon', layout: device.createPipelineLayout({ bindGroupLayouts: [s.ctx.layouts.frame, depth.layout, ribbonLayout] }),
          vertex: { module, entryPoint: 'vs_ribbon' }, fragment: { module, entryPoint: 'fs_ribbon', targets: [target] },
          primitive: { topology: 'triangle-strip', cullMode: 'none' },
        };
      });
      cache.register('overlay:rings', 'render', () => {
        const module = cache.shaderModule(ringsShaderLinked(), 'overlay:rings');
        return {
          label: 'overlay:rings', layout: device.createPipelineLayout({ bindGroupLayouts: [s.ctx.layouts.frame, depth.layout, ringsLayout] }),
          vertex: { module, entryPoint: 'vs_fullscreen' }, fragment: { module, entryPoint: 'fs_rings', targets: [target] },
          primitive: { topology: 'triangle-list' },
        };
      });
      await Promise.all([cache.compile('overlay:ribbon'), cache.compile('overlay:rings')]);

      const pointBuffer = device.createBuffer({ label: 'overlay:ribbon-points', size: MAX_RIBBON_POINTS * 16, usage: BufferUsage.STORAGE | BufferUsage.COPY_DST });
      const ribbonBuffer = device.createBuffer({ label: 'overlay:ribbon', size: RIBBON_PARAMS.size, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      const ringsBuffer = device.createBuffer({ label: 'overlay:rings', size: RINGS.size, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      disposers.push(() => { s.ctx.deferDestroy(pointBuffer); s.ctx.deferDestroy(ribbonBuffer); s.ctx.deferDestroy(ringsBuffer); });
      const ribbonGroup = device.createBindGroup({ label: 'overlay:ribbon', layout: ribbonLayout, entries: [{ binding: 0, resource: { buffer: pointBuffer } }, { binding: 1, resource: { buffer: ribbonBuffer } }] });
      const ringsGroup = device.createBindGroup({ label: 'overlay:rings', layout: ringsLayout, entries: [{ binding: 0, resource: { buffer: ringsBuffer } }] });
      let ribbonCount = 0, ringCount = 0, peakRings = 0;
      let style: RibbonStyle = { ...DEFAULT_RIBBON };
      let dpr = 1;
      disposers.push(s.events.on('resize', e => { dpr = e.dpr || 1; }));
      const points = new Float32Array(MAX_RIBBON_POINTS * 4);
      // The bytes each buffer last received: an update that repeats them is not uploaded again.
      const sentPoints = new Float32Array(MAX_RIBBON_POINTS * 4), sentStyle = new Uint8Array(RIBBON_PARAMS.size), sentRings = new Uint8Array(RINGS.size);
      let sentPointCount = -1, styleSent = false, ringsSent = false;
      const ringStaging = new ArrayBuffer(RINGS.size), ringBytes = new Uint8Array(ringStaging);
      const changed = (next: Uint8Array, sent: Uint8Array): boolean => {
        for (let i = 0; i < next.length; i++) if (next[i] !== sent[i]) { sent.set(next); return true; }
        return false;
      };
      const writeStyle = () => {
        const packed = RIBBON_PARAMS.pack({
          color: [...style.color, style.alpha], style: [style.width * dpr * 0.5, style.dash, style.speed, style.occludedAlpha], count: [ribbonCount, 0, 0, 0],
        });
        if (changed(new Uint8Array(packed), sentStyle) || !styleSent) { styleSent = true; queue.writeBuffer(ribbonBuffer, 0, packed); }
      };
      facet = {
        setRibbon(list, patch) {
          if (patch) style = { ...style, ...patch };
          const n = list ? Math.min(list.length, MAX_RIBBON_POINTS) : 0;
          if (n < 2) { ribbonCount = 0; return; }
          let arc = 0;
          for (let i = 0; i < n; i++) {
            const p = list![i];
            if (i > 0) { const q = list![i - 1]; arc += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); }
            points[i * 4] = p[0]; points[i * 4 + 1] = p[1]; points[i * 4 + 2] = p[2]; points[i * 4 + 3] = arc;
          }
          ribbonCount = n;
          let same = n === sentPointCount;
          for (let i = 0; same && i < n * 4; i++) if (!Object.is(points[i], sentPoints[i])) same = false;
          if (same) return;
          sentPoints.set(points.subarray(0, n * 4)); sentPointCount = n;
          queue.writeBuffer(pointBuffer, 0, points.buffer, 0, n * 16);
        },
        setRings(list) {
          const n = Math.min(list.length, MAX_RINGS);
          const centers: number[] = [], colors: number[] = [], widths: number[] = [];
          for (let i = 0; i < n; i++) {
            const r = list[i];
            centers.push(r.center[0], r.center[1], r.center[2], r.radius);
            colors.push(r.color[0], r.color[1], r.color[2], Math.min(1, Math.max(0, r.alpha)));
            widths.push(Math.max(1e-4, r.width), 0, 0, 0);
          }
          ringCount = n;
          peakRings = Math.max(peakRings, n);
          ringBytes.fill(0);
          RINGS.pack({ count: [n, 0, 0, 0], centers, colors, widths }, ringStaging);
          if (changed(ringBytes, sentRings) || !ringsSent) { ringsSent = true; queue.writeBuffer(ringsBuffer, 0, ringStaging); }
        },
        stats: () => ({ ribbonPoints: ribbonCount, rings: ringCount, peakRings, route: scene.overlayRoute ?? 'overlay', consumed }),
      };
      s.scene.provide('overlays', facet);
      // Consumption check after every frame (cheap: one scan of the sorted pass list); reported once if the pass is dead.
      // The answer depends on the sorted passes and the executed list only: an unchanged frame reuses it.
      let reported = false, checkedSorted: unknown = null, checkedRoute: OverlayRoute | null = null, checkedSeen: boolean | null = null;
      const checkedExecuted: string[] = [];
      disposers.push(s.events.on('frameEnd', () => {
        const route = scene.overlayRoute ?? 'overlay';
        const executed = (s.graph as { lastExecuted?: readonly string[] }).lastExecuted, sorted = (s.graph as { sorted?: unknown }).sorted;
        let same = !!executed && sorted === checkedSorted && route === checkedRoute && executed.length === checkedExecuted.length;
        for (let i = 0; same && i < executed!.length; i++) if (executed![i] !== checkedExecuted[i]) same = false;
        if (!same) {
          checkedSeen = overlayOutputConsumed(s.graph, executed, route);
          checkedSorted = sorted; checkedRoute = route; checkedExecuted.length = 0;
          if (executed) for (const name of executed) checkedExecuted.push(name);
        }
        const seen = checkedSeen;
        if (seen === null) return;
        consumed = seen;
        if (!seen && !reported) {
          reported = true;
          console.error('[overlays] no pass reads the forward overlay pass output: the ribbon and rings never reach the screen (the post chain must read postColor, CC-013)');
        }
      }));
      const drawer: OverlayDrawer = {
        name: 'overlays',
        draw(pass) {
          if (!ribbonCount && !ringCount) return;
          const group = depth.group();
          if (!group) return;
          if (ringCount) {
            const p = cache.get<GPURenderPipeline>('overlay:rings');
            if (p) { pass.setPipeline(p); pass.setBindGroup(1, group); pass.setBindGroup(2, ringsGroup); pass.draw(3); }
          }
          if (ribbonCount >= 2) {
            const p = cache.get<GPURenderPipeline>('overlay:ribbon');
            if (p) { writeStyle(); pass.setPipeline(p); pass.setBindGroup(1, group); pass.setBindGroup(2, ribbonGroup); pass.draw(ribbonCount * 2); }
          }
        },
      };
      disposers.push(s.scene.addOverlayDrawer(drawer));
    },
    dispose() { for (const d of disposers.splice(0)) d(); facet = null; },
  };
}
