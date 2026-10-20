// Rewrite-inspired by Pinionfall src/gpu/shadow-pipeline.ts (MIT, same owner): texel snap, lock/relock, radius slew and
// bias rules only (see fitting.ts); held-projection shear from shadow-sun-hold.ts.
/**
 * `sun-shadows` render module (plan §4.8): three fixed-basis orthographic sun maps, reversed-Z depth32float.
 *
 * | map           | coverage                         | casters                        | re-render                                  |
 * |---------------|----------------------------------|--------------------------------|--------------------------------------------|
 * | PlanetStatic  | whole planet, half 24.5, ±25     | `ShadowCaster.dynamic === false` | `terrainCommitted` (scissored to the dirty light-space rect with loadOp 'load') or a sun-hold breach |
 * | PlanetDynamic | whole planet (held projection)   | `dynamic === true` (sheared to the true sun) | every frame (Low: none, folded into Hero) |
 * | Hero          | focus, clamp(0.45·d + 2, 4, 14)  | all casters inside the square  | every frame, texel snap + lock/relock + radius slew |
 *
 * Every ShadowView carries a real `cull(center, radius)`: planet maps reject spheres outside the planet slab (and outside
 * the dirty rect on a scissored static render), the Hero rejects spheres outside its square.
 * Provides the reserved binding `sunShadows` { static, dynamic, hero, compare, params } and the facet `sunShadows`
 * (enable toggle, stats, the orbit-shimmer probe). Telemetry: `shadowStaticRenders` (cumulative gauge) and the per-frame
 * counters `shadowStaticRender`, `shadowHeroRelock`.
 */
import type { EngineServices, QualityTier, RenderModule, ShadowCaster, ShadowView, Vec3 } from '../../contracts';
import { SHADOW_DEPTH } from '../../contracts';
import { BufferUsage, ShaderStage, TextureUsage } from '../../gpu/flags';
import type { Scene } from '../../scene/scene-registry';
import { SHADOW_VIEW_UNIFORMS } from '../../wgsl/common/shadow-view.wgsl';
import { link, makeModule } from '../../wgsl/module';
import {
  aabbTexelRect, HeroFit, lightBasis, mul4, orthoLightViewProj, PLANET_SHADOW_HALF_EXTENT, SHADOW_ARM_HEIGHT, SHADOW_DEPTH_HALF,
  SHADOW_TIERS, sphereInSquare, toLight, unionRect, type LightBasis, type ShadowTier,
} from './fitting';
import { SUN_SHADOW_PARAMS, SUN_SHADOW_PARAMS_BYTES, shadowSampleWgsl, sunShadowBindingsWgsl } from './shadow.wgsl';
import { chordSq, heldProjectionShear, sunHoldToleranceRad } from './sun-hold';

const DEG = Math.PI / 180;
/** Receiver-side biases: normal offset in texels of the sampled map (× (1 + tanθ)), depth bias in world units. */
export const SHADOW_BIAS = { normalTexels: 1.5, staticDepth: 0.02, dynamicDepth: 0.03, heroDepth: 0.006 } as const;
export const CONTACT_SHADOW = { length: 0.3, steps: 12, thickness: 0.05, strength: 1 } as const;
/** Hero blends into the planet maps over its outer 15%. */
export const HERO_BLEND_START = 0.85;

declare module '../../contracts' {
  interface SceneFacets {
    /** W1-ENG-LOOK: sun-shadow controls and stats. */
    sunShadows: SunShadowsFacet;
  }
}
export interface ShimmerResult { flicker: number; edge: number; ratio: number; frames: number }
export interface SunShadowsFacet {
  enabled: boolean;
  contact: boolean;
  stats(): { staticRenders: number; heroRelocks: number; heroResizes: number; heroRadius: number; heldSun: Vec3; tier: ShadowTier };
  /**
   * Orbit-shimmer probe: evaluates the combined sun visibility at a fixed grid of world points on the tangent plane at
   * `center` (fixed PCF rotation per point, so only map motion can change a value) for `frames` frames and counts points
   * whose visibility changes by > 0.2 between consecutive frames, over the points that are in penumbra/edge.
   * `source: 'static'` samples the PlanetStatic map alone (fixed held basis): with the sun and the terrain unchanged a
   * scissored re-render must leave every value identical, so any flicker there is a hole the re-render left behind.
   */
  probeShimmer(center: Vec3, radius: number, frames: number, source?: 'combined' | 'static'): Promise<ShimmerResult>;
}

const PROBE_GRID = 128;

const probeBindings = sunShadowBindingsWgsl(0, { static: 0, dynamic: 1, hero: 2, compare: 3, params: 4 });
const probeShader = makeModule('sun-shadow-probe', /* wgsl */ `
// w of center = radius, w of axis_u = source (0 combined, 1 PlanetStatic only), w of up = compare flag
struct ProbeParams { center: vec4f, axis_u: vec4f, axis_v: vec4f, up: vec4f }
@group(1) @binding(0) var<uniform> probe: ProbeParams;
@group(1) @binding(1) var<storage, read> prev_vis: array<f32>;
@group(1) @binding(2) var<storage, read_write> cur_vis: array<f32>;
@group(1) @binding(3) var<storage, read_write> counters: array<atomic<u32>, 4>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let n = ${PROBE_GRID}u;
  if (id.x >= n || id.y >= n) { return; }
  let i = id.y * n + id.x;
  let st = (vec2f(id.xy) + 0.5) / f32(n) * 2.0 - 1.0;
  let p = probe.center.xyz + (probe.axis_u.xyz * st.x + probe.axis_v.xyz * st.y) * probe.center.w;
  let angle = shadow_ign(vec2f(id.xy)) * PI;
  var v = 0.0;
  if (probe.axis_u.w > 0.5) {
    v = shadow_pcf(sun_shadow_static, sun_shadow_params.planet_view_proj, p, probe.up.xyz, sun_shadow_params.light.xyz,
                   sun_shadow_params.planet.x, sun_shadow_params.planet.z, sun_shadow_params.bias.y,
                   u32(sun_shadow_params.flags.z), angle).x;
  } else {
    v = sun_shadow_rot(p, probe.up.xyz, sun_shadow_params.light.xyz, angle);
  }
  cur_vis[i] = v;
  if (probe.up.w > 0.5) {
    let pv = prev_vis[i];
    let edge = (v > 0.02 && v < 0.98) || (pv > 0.02 && pv < 0.98) || abs(v - pv) > 0.2;
    if (edge) {
      atomicAdd(&counters[1], 1u);
      if (abs(v - pv) > 0.2) { atomicAdd(&counters[0], 1u); }
    }
  }
}
`, [shadowSampleWgsl, probeBindings]);

const clearRectShader = makeModule('sun-shadow-clear-rect', /* wgsl */ `
@vertex
fn vs_clear(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let x = f32(i32(vi & 1u) * 4 - 1);
  let y = f32(i32(vi >> 1u) * 4 - 1);
  return vec4f(x, y, 0.0, 1.0);  // reversed-Z far plane: depth 0 = nothing occludes
}
`);

export function sunShadowProbeShader() { return link(probeShader); }
export function sunShadowClearShader() { return link(clearRectShader); }

interface MapSet { static: GPUTexture; dynamic: GPUTexture; hero: GPUTexture; tier: ShadowTier; views: { static: GPUTextureView; dynamic: GPUTextureView; hero: GPUTextureView } }

export interface SunShadowsOptions { tier?: QualityTier }

export function sunShadowsModule(options: SunShadowsOptions = {}): RenderModule {
  const disposers: (() => void)[] = [];
  return {
    name: 'sun-shadows',
    install(s: EngineServices) {
      const { device, queue } = s.ctx;
      const scene = s.scene as Scene;
      const depthUsage = TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING;
      const compare = device.createSampler({ label: 'shadow:compare', compare: SHADOW_DEPTH.compare, magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
      const params = device.createBuffer({ label: 'shadow:params', size: SUN_SHADOW_PARAMS_BYTES, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      const viewBuffers = (['static', 'dynamic', 'hero'] as const).map(k => device.createBuffer({ label: `shadow:view-${k}`, size: SHADOW_VIEW_UNIFORMS.size, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST }));
      const viewGroups = viewBuffers.map((b, i) => device.createBindGroup({ label: `shadow-view-${i}`, layout: s.ctx.layouts.shadowView, entries: [{ binding: 0, resource: { buffer: b } }] }));
      disposers.push(() => { s.ctx.deferDestroy(params); for (const b of viewBuffers) s.ctx.deferDestroy(b); });

      let maps: MapSet | null = null;
      const allocate = (tier: QualityTier) => {
        const t = SHADOW_TIERS[options.tier ?? s.settings.shadowTier ?? tier];
        if (maps && maps.tier === t) return;
        if (maps) { s.ctx.deferDestroy(maps.static); s.ctx.deferDestroy(maps.dynamic); s.ctx.deferDestroy(maps.hero); }
        const mk = (label: string, size: number) => device.createTexture({ label: `shadow:${label}`, size: [size, size], format: SHADOW_DEPTH.format, usage: depthUsage });
        const st = mk('static', t.static), dy = mk('dynamic', Math.max(1, t.dynamic)), he = mk('hero', t.hero);
        maps = { static: st, dynamic: dy, hero: he, tier: t, views: { static: st.createView(), dynamic: dy.createView(), hero: he.createView() } };
        hero.size = t.hero;
        hero.reset();
        staticDirty = 'full';
        s.bindings.provide('sunShadows', { static: maps.views.static, dynamic: maps.views.dynamic, hero: maps.views.hero, compare, params: { buffer: params } });
      };
      disposers.push(() => { if (maps) { s.ctx.deferDestroy(maps.static); s.ctx.deferDestroy(maps.dynamic); s.ctx.deferDestroy(maps.hero); } });

      // ── Pipelines (clear-rect for scissored static renders, the shimmer probe) ──
      const clearKey = 'shadow:clear-rect', probeKey = 'shadow:probe';
      s.ctx.pipelines.register(clearKey, 'render', () => ({
        label: clearKey, layout: device.createPipelineLayout({ bindGroupLayouts: [] }),
        vertex: { module: s.ctx.pipelines.shaderModule(sunShadowClearShader(), clearKey), entryPoint: 'vs_clear' },
        primitive: { topology: 'triangle-list' },
        depthStencil: { format: SHADOW_DEPTH.format, depthWriteEnabled: true, depthCompare: 'always' },
      }));
      void s.ctx.pipelines.compile(clearKey).catch(() => undefined);
      const C = ShaderStage.COMPUTE;
      const probeLayout0 = device.createBindGroupLayout({ label: 'layout:shadow-probe-maps', entries: [
        { binding: 0, visibility: C, texture: { sampleType: 'depth' } }, { binding: 1, visibility: C, texture: { sampleType: 'depth' } },
        { binding: 2, visibility: C, texture: { sampleType: 'depth' } }, { binding: 3, visibility: C, sampler: { type: 'comparison' } },
        { binding: 4, visibility: C, buffer: { type: 'uniform' } }] });
      const probeLayout1 = device.createBindGroupLayout({ label: 'layout:shadow-probe', entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } }, { binding: 1, visibility: C, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: C, buffer: { type: 'storage' } }, { binding: 3, visibility: C, buffer: { type: 'storage' } }] });
      s.ctx.pipelines.register(probeKey, 'compute', () => ({
        label: probeKey, layout: device.createPipelineLayout({ bindGroupLayouts: [probeLayout0, probeLayout1] }),
        compute: { module: s.ctx.pipelines.shaderModule(sunShadowProbeShader(), probeKey), entryPoint: 'main' },
      }));

      // ── State ──
      const hero = new HeroFit(SHADOW_TIERS.high.hero);
      let staticDirty: 'full' | { x: number; y: number; w: number; h: number } | null = 'full';
      let heldSun: Vec3 | null = null;
      let heldBasis: LightBasis = lightBasis([0, 1, 0]);
      const planetVP = new Float32Array(16);
      const heroVP = new Float32Array(16);
      const dynamicVP = new Float32Array(16);
      const shear = new Float32Array(16);
      let heroBasis: LightBasis = heldBasis;
      let staticRenders = 0;
      let enabled = true;
      let contact = true;
      let scissor: { x: number; y: number; w: number; h: number } | null = null;
      const paramStaging = new ArrayBuffer(SUN_SHADOW_PARAMS_BYTES);
      const viewStaging = new ArrayBuffer(SHADOW_VIEW_UNIFORMS.size);
      allocate(s.settings.tier);
      disposers.push(s.events.on('tierChanged', e => allocate(e.tier)));
      disposers.push(s.events.on('planetChanged', () => { staticDirty = 'full'; }));
      disposers.push(s.events.on('terrainCommitted', e => {
        if (!maps || staticDirty === 'full') return;
        const pad = maps.tier.grid * 2 + 4;
        const r = aabbTexelRect(planetVP, e.dirtyBounds.min, e.dirtyBounds.max, maps.tier.static, pad);
        staticDirty = r ? unionRect(staticDirty, r) : staticDirty;
      }));

      const inPlanetSlab = (c: readonly number[], r: number) => Math.hypot(c[0], c[1], c[2]) - r <= PLANET_SHADOW_HALF_EXTENT;
      const staticView: ShadowView = {
        kind: 'static', viewProj: planetVP, bindGroup: viewGroups[0],
        cull: (c, r) => {
          if (!inPlanetSlab(c, r)) return false;
          if (!scissor || !maps) return true;
          const l = toLight(heldBasis, c);
          const texel = (2 * PLANET_SHADOW_HALF_EXTENT) / maps.tier.static;
          const u = (l[0] / PLANET_SHADOW_HALF_EXTENT * 0.5 + 0.5) * maps.tier.static;
          const v = (0.5 - l[1] / PLANET_SHADOW_HALF_EXTENT * 0.5) * maps.tier.static;
          const rt = r / texel;
          return u + rt >= scissor.x && u - rt <= scissor.x + scissor.w && v + rt >= scissor.y && v - rt <= scissor.y + scissor.h;
        },
      };
      const dynamicView: ShadowView = { kind: 'dynamic', viewProj: dynamicVP, bindGroup: viewGroups[1], cull: (c, r) => inPlanetSlab(c, r) };
      const heroView: ShadowView = {
        kind: 'hero', viewProj: heroVP, bindGroup: viewGroups[2],
        cull: (c, r) => sphereInSquare(heroBasis, c, r, hero.cx, hero.cy, hero.radius),
      };
      const writeView = (buffer: GPUBuffer, vp: Float32Array, l: Vec3, texel: number, kind: number) => {
        SHADOW_VIEW_UNIFORMS.pack({ view_proj: vp, light_dir: [...l, texel], params: [kind, 0, 0, 0] }, viewStaging);
        queue.writeBuffer(buffer, 0, viewStaging);
      };
      const casters = (dynamic: boolean | null): ShadowCaster[] => scene.shadowCasters.filter(c => dynamic === null || c.dynamic === dynamic);
      // Once the planet SDF exists the lighting traces every sun shadow through it and the tank bricks (sdf-casters.ts);
      // the maps are only the first frames' fallback.
      const sdfShadows = () => !!s.scene.get('sdf')?.valid;

      let heroRelocksFrame = 0;
      disposers.push(s.graph.addPass({
        name: 'shadow-fit', slot: 'shadows', order: -10, reads: [], writes: [],
        run(c) {
          allocate(c.frame.tier);
          if (!maps) return;
          const t = maps.tier;
          const f = c.frame;
          const sun = f.sunDir as Vec3;
          const focus = f.focus.world;
          const fl = Math.hypot(focus[0], focus[1], focus[2]) || 1;
          const sinElev = (sun[0] * focus[0] + sun[1] * focus[1] + sun[2] * focus[2]) / fl;
          // Sun hold for the planet maps: relock (and re-render PlanetStatic) only past the tolerance.
          const tol = sunHoldToleranceRad({ baseRad: 0.03 * DEG, texelM: (2 * PLANET_SHADOW_HALF_EXTENT) / t.static, sinElev, armHeightM: SHADOW_ARM_HEIGHT, stepTexels: 1, maxRad: 0.5 * DEG });
          if (!heldSun || !(chordSq(heldSun, sun) <= tol * tol)) {
            heldSun = [...sun] as Vec3;
            heldBasis = lightBasis(heldSun);
            orthoLightViewProj(heldBasis, 0, 0, PLANET_SHADOW_HALF_EXTENT, SHADOW_DEPTH_HALF, planetVP);
            staticDirty = 'full';
          }
          heldProjectionShear(shear, heldSun, sun, focus);
          mul4(planetVP, shear, dynamicVP);
          // Hero: fixed basis from the CURRENT sun, texel-snapped lock/relock around the focus.
          heroBasis = lightBasis(sun);
          const fl3 = toLight(heroBasis, focus);
          heroRelocksFrame = hero.update(fl3[0], fl3[1], f.focus.distance) ? 1 : 0;
          if (heroRelocksFrame) s.telemetry.count('shadowHeroRelock');
          orthoLightViewProj(heroBasis, hero.cx, hero.cy, hero.radius, SHADOW_DEPTH_HALF, heroVP);
          const planetTexel = (2 * PLANET_SHADOW_HALF_EXTENT);
          writeView(viewBuffers[0], planetVP, heldSun, planetTexel / t.static, 0);
          writeView(viewBuffers[1], dynamicVP, heldSun, planetTexel / Math.max(1, t.dynamic), 1);
          writeView(viewBuffers[2], heroVP, sun, hero.texel, 2);
          const slab = 2 * SHADOW_DEPTH_HALF;
          SUN_SHADOW_PARAMS.pack({
            planet_view_proj: planetVP, hero_view_proj: heroVP,
            planet: [1 / t.static, 1 / Math.max(1, t.dynamic), planetTexel / t.static, planetTexel / Math.max(1, t.dynamic)],
            hero: [1 / t.hero, hero.texel, HERO_BLEND_START, 1],
            bias: [SHADOW_BIAS.normalTexels, SHADOW_BIAS.staticDepth / slab, SHADOW_BIAS.dynamicDepth / slab, SHADOW_BIAS.heroDepth / slab],
            flags: [enabled ? 1 : 0, t.dynamic > 0 ? 1 : 0, t.grid, enabled && t.contact && contact ? 1 : 0],
            contact: [CONTACT_SHADOW.length, CONTACT_SHADOW.steps, CONTACT_SHADOW.thickness, CONTACT_SHADOW.strength],
            light: [...heldSun, f.index % 64],
          }, paramStaging);
          queue.writeBuffer(params, 0, paramStaging);
        },
      }));

      const beginDepth = (c: Parameters<Parameters<typeof s.graph.addPass>[0]['run']>[0], name: string, view: GPUTextureView, load: boolean) => {
        const ts = c.timestampWrites(name) as GPURenderPassTimestampWrites | undefined;
        return c.encoder.beginRenderPass({
          label: name, colorAttachments: [],
          depthStencilAttachment: { view, depthLoadOp: load ? 'load' : 'clear', depthStoreOp: 'store', depthClearValue: SHADOW_DEPTH.clear },
          ...(ts ? { timestampWrites: ts } : {}),
        });
      };

      disposers.push(s.graph.addPass({
        name: 'shadow-static', slot: 'shadows', order: 0, reads: [], writes: [],
        enabled: () => !!maps && staticDirty !== null && enabled && !sdfShadows(),
        run(c) {
          const m = maps!;
          const dirty = staticDirty;
          const clearPipe = s.ctx.pipelines.get<GPURenderPipeline>(clearKey);
          const partial = dirty !== 'full' && dirty !== null && !!clearPipe;
          scissor = partial ? dirty as { x: number; y: number; w: number; h: number } : null;
          const pass = beginDepth(c, 'shadow-static', m.views.static, partial);
          if (scissor) {
            pass.setScissorRect(scissor.x, scissor.y, scissor.w, scissor.h);
            pass.setPipeline(clearPipe!);
            pass.draw(3, 1, 0, 0);
          }
          for (const caster of casters(false)) caster.drawDepth(pass, staticView);
          pass.end();
          scissor = null;
          staticDirty = null;
          staticRenders++;
          s.telemetry.count('shadowStaticRender');
          s.telemetry.gauge('shadowStaticRenders', staticRenders);
        },
      }));
      disposers.push(s.graph.addPass({
        name: 'shadow-dynamic', slot: 'shadows', order: 1, reads: [], writes: [],
        enabled: () => !!maps && maps.tier.dynamic > 0 && enabled && !sdfShadows(),
        run(c) {
          const pass = beginDepth(c, 'shadow-dynamic', maps!.views.dynamic, false);
          for (const caster of casters(true)) caster.drawDepth(pass, dynamicView);
          pass.end();
        },
      }));
      disposers.push(s.graph.addPass({
        name: 'shadow-hero', slot: 'shadows', order: 2, reads: [], writes: [],
        enabled: () => !!maps && enabled && !sdfShadows(),
        run(c) {
          const pass = beginDepth(c, 'shadow-hero', maps!.views.hero, false);
          for (const caster of casters(null)) caster.drawDepth(pass, heroView);
          pass.end();
        },
      }));

      // ── Shimmer probe ──
      const probeCells = PROBE_GRID * PROBE_GRID;
      let probe: null | {
        center: Vec3; radius: number; frames: number; source: number; done: number; resolve: (r: ShimmerResult) => void;
        vis: GPUBuffer[]; counters: GPUBuffer; readback: GPUBuffer; uniform: GPUBuffer; groups: GPUBindGroup[]; mapping: boolean;
      } = null;
      let probeMapsGroup: { maps: MapSet; group: GPUBindGroup } | null = null;
      disposers.push(s.graph.addPass({
        name: 'shadow-probe', slot: 'debug', order: 0, reads: [], writes: [],
        enabled: () => !!probe && probe.done < probe.frames + 1,
        run(c) {
          const pr = probe!;
          const pipe = s.ctx.pipelines.get<GPUComputePipeline>(probeKey);
          if (!pipe || !maps) { void s.ctx.pipelines.compile(probeKey).catch(() => undefined); return; }
          const up = pr.center.map(v => v / (Math.hypot(...pr.center) || 1)) as Vec3;
          const ref = Math.abs(up[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
          const u = [ref[1] * up[2] - ref[2] * up[1], ref[2] * up[0] - ref[0] * up[2], ref[0] * up[1] - ref[1] * up[0]];
          const ul = Math.hypot(u[0], u[1], u[2]);
          const au = u.map(x => x / ul);
          const av = [up[1] * au[2] - up[2] * au[1], up[2] * au[0] - up[0] * au[2], up[0] * au[1] - up[1] * au[0]];
          queue.writeBuffer(pr.uniform, 0, new Float32Array([...pr.center, pr.radius, ...au, pr.source, ...av, 0, ...up, pr.done > 0 ? 1 : 0]));
          if (!probeMapsGroup || probeMapsGroup.maps !== maps) {
            probeMapsGroup = { maps, group: device.createBindGroup({ label: 'shadow-probe-maps', layout: probeLayout0, entries: [
              { binding: 0, resource: maps.views.static }, { binding: 1, resource: maps.views.dynamic }, { binding: 2, resource: maps.views.hero },
              { binding: 3, resource: compare }, { binding: 4, resource: { buffer: params } }] }) };
          }
          const g0 = probeMapsGroup.group;
          const pass = c.encoder.beginComputePass({ label: 'shadow-probe' });
          pass.setPipeline(pipe);
          pass.setBindGroup(0, g0);
          pass.setBindGroup(1, pr.groups[pr.done & 1]);
          pass.dispatchWorkgroups(PROBE_GRID / 8, PROBE_GRID / 8);
          pass.end();
          pr.done++;
          if (pr.done === pr.frames + 1) c.encoder.copyBufferToBuffer(pr.counters, 0, pr.readback, 0, 16);
        },
      }));
      disposers.push(s.events.on('frameEnd', () => {
        const pr = probe;
        if (!pr || pr.done !== pr.frames + 1 || pr.mapping) return;
        pr.mapping = true;
        void pr.readback.mapAsync(1).then(() => {
          const v = new Uint32Array(pr.readback.getMappedRange().slice(0));
          pr.readback.unmap();
          for (const b of [...pr.vis, pr.counters, pr.readback, pr.uniform]) s.ctx.deferDestroy(b);
          probe = null;
          pr.resolve({ flicker: v[0], edge: v[1], ratio: v[1] ? v[0] / v[1] : 0, frames: pr.frames });
        }).catch(() => { probe = null; pr.resolve({ flicker: -1, edge: 0, ratio: 1, frames: 0 }); });
      }));

      const facet: SunShadowsFacet = {
        get enabled() { return enabled; },
        set enabled(v: boolean) { if (v !== enabled) { enabled = v; staticDirty = 'full'; } },
        get contact() { return contact; },
        set contact(v: boolean) { contact = v; },
        stats: () => ({ staticRenders, heroRelocks: hero.relocks, heroResizes: hero.resizes, heroRadius: hero.radius, heldSun: heldSun ? [...heldSun] as Vec3 : [0, 0, 0], tier: maps!.tier }),
        probeShimmer(center, radius, frames, source = 'combined') {
          if (probe) return Promise.reject(new Error('a shimmer probe is already running'));
          void s.ctx.pipelines.compile(probeKey).catch(() => undefined);
          return new Promise<ShimmerResult>(resolve => {
            const vis = [0, 1].map(i => device.createBuffer({ label: `shadow:probe-vis-${i}`, size: probeCells * 4, usage: BufferUsage.STORAGE }));
            const counters = device.createBuffer({ label: 'shadow:probe-counters', size: 16, usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC | BufferUsage.COPY_DST });
            const readback = device.createBuffer({ label: 'shadow:probe-readback', size: 16, usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST });
            const uniform = device.createBuffer({ label: 'shadow:probe-params', size: 64, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
            queue.writeBuffer(counters, 0, new Uint32Array(4));
            const groups = [0, 1].map(k => device.createBindGroup({ label: `shadow-probe-${k}`, layout: probeLayout1, entries: [
              { binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: { buffer: vis[1 - k] } },
              { binding: 2, resource: { buffer: vis[k] } }, { binding: 3, resource: { buffer: counters } }] }));
            probe = { center: [...center] as Vec3, radius, frames, source: source === 'static' ? 1 : 0, done: 0, resolve, vis, counters, readback, uniform, groups, mapping: false };
          });
        },
      };
      s.scene.provide('sunShadows', facet);
    },
    dispose() { for (const d of disposers.splice(0)) d(); },
  };
}
