// Ported from Pinionfall src/gpu/atmosphere-lut-shader.ts and src/gpu/atmosphere-pipeline.ts (MIT, same owner)
/**
 * Atmosphere LUTs and the `atmosphere` render module (plan §4.11).
 *
 * - Transmittance 256×64 and multiscatter 32² are baked once per planet (install, `planetChanged`, or a planet-kind
 *   change seen on the `planet` facet). Kernels as in Pinionfall (below-horizon grazing continuation + dip fade; 64
 *   Fibonacci directions × 20 steps with an fms pole guard) but on the ONE `atmo_density()`, the planet-type ground
 *   albedo, the solid planet as the sun occluder, and Hillaire's isotropic phase on the multiscatter sun term.
 * - The sky-view texture holds two LUTs side by side, rebuilt every frame unless the uniform bytes are unchanged (the
 *   Pinionfall dedup): x < W the real camera observer (used when the camera is inside the shell), x ≥ W the diorama
 *   observer at h ≈ 0.5·H_R (the daylight backdrop, anchored at the real limb by the consumer). Both are
 *   `atmo_integrate` from a local observer (32 steps), so the LUT, the sky integrator and the aerial perspective agree.
 * - Provides the reserved binding `atmosphere` { transmittance, multiscatter, skyView, params } and the scene facet
 *   `atmosphere` (preset, version, overrides). On a planet change it also sets the `sun` facet to
 *   `defaultSun(seed, kind)` (src/world/sun.ts), which the engine uses when `FrameInput.sun` is absent.
 */
import type { EngineServices, PlanetDesc, RenderModule, Vec3 } from '../../contracts';
import { BufferUsage, ShaderStage, TextureUsage } from '../../gpu/flags';
import { defaultSun, type PlanetKind } from '../../../world/sun';
import { link, makeModule } from '../../wgsl/module';
import { atmosphereBindingsWgsl, atmosphereFnWgsl } from './integrate.wgsl';
import {
  ATMOSPHERE_PRESETS, MULTISCATTER_LUT, packAtmosphereParams, SKY_VIEW_LUT, TRANSMITTANCE_LUT,
  type AtmospherePreset,
} from './params';

export const LUT_FORMAT: GPUTextureFormat = 'rgba16float';
/** Size of the params buffer bound as `atmosphere.params` (RESERVED_BINDING_LAYOUT). */
export const ATMOSPHERE_PARAMS_BYTES = 256;

declare module '../../contracts' {
  interface SceneFacets {
    /** W1-ENG-LOOK: the live atmosphere preset. `version` bumps whenever the baked LUTs change. */
    atmosphere: AtmosphereFacet;
  }
}
export interface AtmosphereFacet {
  readonly kind: PlanetKind;
  readonly preset: AtmospherePreset;
  /** Version of the LUTs currently baked (−1 before the first bake); consumers rebuild derived data when it changes. */
  readonly version: number;
  /** Override preset fields (art tuning / sandbox); rebakes the LUTs. Pass null to go back to the kind's preset. */
  override(p: Partial<AtmospherePreset> | null): void;
}

// Unused declarations keep the shared functions compiling in kernels that do not bind every LUT (only statically used
// bindings must appear in the pipeline layout).
const unusedLuts = atmosphereBindingsWgsl(0, { params: 0, transmittance: 13, multiscatter: 14, sampler: 15 });

const transmittanceKernel = makeModule('atmo-lut-transmittance', /* wgsl */ `
@group(0) @binding(1) var transmittance_out: texture_storage_2d<rgba16float, write>;
const TRANSMITTANCE_STEPS: u32 = 40u;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let dims = vec2u(u32(atmo.lut.x), u32(atmo.lut.y));
  if (id.x >= dims.x || id.y >= dims.y) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(dims);
  let h_range = atmo_top_radius() - atmo_ground_radius();
  let h = uv.x * uv.x * h_range;
  let cos_theta = 2.0 * uv.y - 1.0;
  let r = atmo_ground_radius() + h;
  let ro = vec3f(0.0, r, 0.0);
  // Below the (atmosphere-ground) horizon continue along the grazing direction and fade to 0 over 0.08 in cos: no
  // bright ring at the terminator (Pinionfall 2026-08-24 fix, analytic horizon test).
  let ratio = atmo_ground_radius() / r;
  let cos_h = -sqrt(max(0.0, 1.0 - ratio * ratio));
  let blocked = cos_theta < cos_h;
  let mc = select(cos_theta, cos_h, blocked);
  let rd = vec3f(sqrt(max(1.0 - mc * mc, 0.0)), mc, 0.0);
  let len = max(atmo_ray_sphere(ro, rd, atmo_top_radius()).y, 0.0);
  let dt = len / f32(TRANSMITTANCE_STEPS);
  var tau = vec3f(0.0);
  for (var i = 0u; i < TRANSMITTANCE_STEPS; i++) {
    let p = ro + rd * ((f32(i) + 0.5) * dt);
    tau += atmo_extinction(atmo_density(length(p))) * dt;
  }
  var t = exp(-tau);
  if (blocked) { t *= 1.0 - smoothstep(0.0, 0.08, cos_h - cos_theta); }
  textureStore(transmittance_out, id.xy, vec4f(t, 1.0));
}
`, [atmosphereFnWgsl, unusedLuts]);

const multiscatterBindings = atmosphereBindingsWgsl(0, { params: 0, transmittance: 1, multiscatter: 14, sampler: 2 });
const multiscatterKernel = makeModule('atmo-lut-multiscatter', /* wgsl */ `
@group(0) @binding(3) var multiscatter_out: texture_storage_2d<rgba16float, write>;
const MS_DIRS: u32 = 64u;
const MS_STEPS: u32 = 20u;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let n = u32(atmo.night.w);
  if (id.x >= n || id.y >= n) { return; }
  let uv = (vec2f(id.xy) + 0.5) / f32(n);
  let h_range = atmo_top_radius() - atmo_ground_radius();
  let h = uv.x * uv.x * h_range;
  let cos_sun = 2.0 * uv.y - 1.0;
  let sun = vec3f(sqrt(max(1.0 - cos_sun * cos_sun, 0.0)), cos_sun, 0.0);
  let r = atmo_ground_radius() + h;
  let ro = vec3f(0.0, r, 0.0);
  var lum = vec3f(0.0);
  var fms = vec3f(0.0);
  let inv = 1.0 / f32(MS_DIRS);
  let golden = (1.0 + sqrt(5.0)) * 0.5;
  for (var i = 0u; i < MS_DIRS; i++) {
    let fi = f32(i);
    let theta = acos(1.0 - 2.0 * (fi + 0.5) * inv);
    let phi = TAU * fi / golden;
    let dir = vec3f(sin(theta) * cos(phi), cos(theta), sin(theta) * sin(phi));
    var len = max(atmo_ray_sphere(ro, dir, atmo_top_radius()).y, 0.0);
    let g = atmo_ray_sphere(ro, dir, atmo_ground_radius());
    let hits_ground = g.x > 0.0;
    if (hits_ground) { len = g.x; }
    let dt = len / f32(MS_STEPS);
    var tr = vec3f(1.0);
    var sc = vec3f(0.0);
    var ms = vec3f(0.0);
    for (var j = 0u; j < MS_STEPS; j++) {
      let p = ro + dir * ((f32(j) + 0.5) * dt);
      let pr = length(p);
      let d = atmo_density(pr);
      let scat = atmo_scattering(d);
      let ext = atmo_extinction(d);
      let cs = dot(p / pr, sun);
      var vis = 1.0;
      if (atmo_ray_sphere(p, sun, max(atmo_ground_radius(), atmo.ground.w)).x > 0.0) { vis = 0.0; }
      let t_sun = atmo_transmittance(pr - atmo_ground_radius(), cs);
      // Hillaire 2020 §5.5 / UE: the sun scattering inside L' uses the isotropic phase 1/(4π) (Pinionfall omitted it,
      // which made the multiscatter LUT 4π too strong and lit the night side).
      sc += tr * vis * t_sun * scat * (dt / (4.0 * PI));
      ms += tr * scat * dt;
      tr *= exp(-ext * dt);
    }
    if (hits_ground) {
      let pg = ro + dir * len;
      let cg = max(dot(normalize(pg), sun), 0.0);
      sc += tr * atmo_transmittance(0.0, cg) * cg * atmo.ground.rgb / PI;
    }
    lum += sc * inv;
    fms += ms * inv;
  }
  // Geometric series of higher orders, pole-guarded (fms ≤ 0.9 ⇒ at most ×10).
  let f = min(fms, vec3f(0.9));
  let multi = clamp(lum / max(vec3f(1.0) - f, vec3f(0.001)), vec3f(0.0), vec3f(500.0));
  textureStore(multiscatter_out, id.xy, vec4f(multi, 1.0));
}
`, [atmosphereFnWgsl, multiscatterBindings]);

const skyViewBindings = atmosphereBindingsWgsl(0, { params: 0, transmittance: 1, multiscatter: 2, sampler: 3 });
const skyViewKernel = makeModule('atmo-lut-sky-view', /* wgsl */ `
@group(0) @binding(4) var sky_view_out: texture_storage_2d<rgba16float, write>;
const SKY_VIEW_STEPS: u32 = 32u;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let w = u32(atmo.lut.z);
  let hgt = u32(atmo.lut.w);
  if (id.x >= 2u * w || id.y >= hgt) { return; }
  let half_index = id.x / w;
  let uv = (vec2f(f32(id.x % w), f32(id.y)) + 0.5) / vec2f(f32(w), f32(hgt));
  // Real camera observer (left) or the diorama observer at h ≈ 0.5·H_R (right).
  let h = max(select(atmo.sun_local.w, atmo.diorama.z, half_index == 1u), 0.001);
  let r = atmo_ground_radius() + h;
  let ratio = atmo_ground_radius() / r;
  let cos_h = -sqrt(max(0.0, 1.0 - ratio * ratio));
  var cos_vz: f32;
  if (uv.y >= 0.5) {
    let t = 2.0 * uv.y - 1.0;
    cos_vz = cos_h + (1.0 - cos_h) * t * t;
  } else {
    let t = 1.0 - 2.0 * uv.y;
    cos_vz = cos_h - (1.0 + cos_h) * t * t;
  }
  let az = uv.x * TAU;
  let sin_el = clamp(cos_vz, -1.0, 1.0);
  let cos_el = sqrt(max(1.0 - sin_el * sin_el, 0.0));
  let dir = vec3f(cos_el * sin(az), sin_el, cos_el * cos(az));
  let seg = atmo_integrate_sun(vec3f(0.0, r, 0.0), dir, atmo.sun_local.xyz, 1e9, SKY_VIEW_STEPS, 0.5);
  textureStore(sky_view_out, id.xy, vec4f(clamp(seg.L, vec3f(0.0), vec3f(500.0)), 1.0));
}
`, [atmosphereFnWgsl, skyViewBindings]);

export function atmosphereLutShaders() {
  return { transmittance: link(transmittanceKernel), multiscatter: link(multiscatterKernel), skyView: link(skyViewKernel) };
}

/** Everything the lighting / sky-light consumers need from this module (also the reserved binding contents). */
export interface AtmosphereResources {
  transmittance: GPUTextureView; multiscatter: GPUTextureView; skyView: GPUTextureView; params: GPUBuffer; sampler: GPUSampler;
}

function samePlanet(a: PlanetDesc | undefined, b: PlanetDesc | undefined): boolean {
  return !!a && !!b && a.kind === b.kind && a.seed === b.seed;
}

export interface AtmosphereModuleOptions { kind?: PlanetKind }

export function atmosphereModule(options: AtmosphereModuleOptions = {}): RenderModule {
  const disposers: (() => void)[] = [];
  return {
    name: 'atmosphere',
    install(s: EngineServices) {
      const { device, queue } = s.ctx;
      const C = ShaderStage.COMPUTE;
      const usage = TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING;
      const transmittance = device.createTexture({ label: 'atmosphere:transmittance', size: [TRANSMITTANCE_LUT.w, TRANSMITTANCE_LUT.h], format: LUT_FORMAT, usage });
      const multiscatter = device.createTexture({ label: 'atmosphere:multiscatter', size: [MULTISCATTER_LUT.w, MULTISCATTER_LUT.h], format: LUT_FORMAT, usage });
      const skyView = device.createTexture({ label: 'atmosphere:sky-view', size: [SKY_VIEW_LUT.w * 2, SKY_VIEW_LUT.h], format: LUT_FORMAT, usage });
      const params = device.createBuffer({ label: 'atmosphere:params', size: ATMOSPHERE_PARAMS_BYTES, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      const sampler = device.createSampler({ label: 'atmosphere:lut', magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
      const views = { t: transmittance.createView(), ms: multiscatter.createView(), sv: skyView.createView() };
      disposers.push(() => { for (const r of [transmittance, multiscatter, skyView, params]) s.ctx.deferDestroy(r); });

      const entry = (binding: number, e: Omit<GPUBindGroupLayoutEntry, 'binding' | 'visibility'>): GPUBindGroupLayoutEntry => ({ binding, visibility: C, ...e });
      const uniform = { buffer: { type: 'uniform' as const } };
      const tex = { texture: { sampleType: 'float' as const } };
      const samp = { sampler: { type: 'filtering' as const } };
      const store = { storageTexture: { access: 'write-only' as const, format: LUT_FORMAT } };
      const layouts = {
        t: device.createBindGroupLayout({ label: 'layout:atmo-transmittance', entries: [entry(0, uniform), entry(1, store)] }),
        ms: device.createBindGroupLayout({ label: 'layout:atmo-multiscatter', entries: [entry(0, uniform), entry(1, tex), entry(2, samp), entry(3, store)] }),
        sv: device.createBindGroupLayout({ label: 'layout:atmo-sky-view', entries: [entry(0, uniform), entry(1, tex), entry(2, tex), entry(3, samp), entry(4, store)] }),
      };
      const groups = {
        t: device.createBindGroup({ label: 'atmo-transmittance', layout: layouts.t, entries: [{ binding: 0, resource: { buffer: params } }, { binding: 1, resource: views.t }] }),
        ms: device.createBindGroup({ label: 'atmo-multiscatter', layout: layouts.ms, entries: [
          { binding: 0, resource: { buffer: params } }, { binding: 1, resource: views.t }, { binding: 2, resource: sampler }, { binding: 3, resource: views.ms }] }),
        sv: device.createBindGroup({ label: 'atmo-sky-view', layout: layouts.sv, entries: [
          { binding: 0, resource: { buffer: params } }, { binding: 1, resource: views.t }, { binding: 2, resource: views.ms },
          { binding: 3, resource: sampler }, { binding: 4, resource: views.sv }] }),
      };
      const shaders = atmosphereLutShaders();
      const keys = { t: 'atmosphere:transmittance', ms: 'atmosphere:multiscatter', sv: 'atmosphere:sky-view' } as const;
      for (const k of ['t', 'ms', 'sv'] as const) {
        const linked = k === 't' ? shaders.transmittance : k === 'ms' ? shaders.multiscatter : shaders.skyView;
        s.ctx.pipelines.register(keys[k], 'compute', () => ({
          label: keys[k], layout: device.createPipelineLayout({ bindGroupLayouts: [layouts[k]] }),
          compute: { module: s.ctx.pipelines.shaderModule(linked, keys[k]), entryPoint: 'main' },
        }));
        void s.ctx.pipelines.compile(keys[k]).catch(() => undefined);
      }

      // ── State ──
      let planet: PlanetDesc | undefined = s.scene.get('planet');
      let kind: PlanetKind = options.kind ?? planet?.kind ?? 'temperate';
      let overrides: Partial<AtmospherePreset> | null = null;
      let preset: AtmospherePreset = ATMOSPHERE_PRESETS[kind];
      let version = 0;
      let bakedVersion = -1;
      const staging = new ArrayBuffer(ATMOSPHERE_PARAMS_BYTES);
      const lastBytes = new Uint8Array(ATMOSPHERE_PARAMS_BYTES);
      const stagingBytes = new Uint8Array(staging);
      let skyViewValid = false;
      const rebuild = () => { preset = { ...ATMOSPHERE_PRESETS[kind], ...(overrides ?? {}) }; version++; skyViewValid = false; };
      const applyPlanet = (p: PlanetDesc | undefined) => {
        if (!p) return;
        planet = p;
        if (options.kind) return;
        if (p.kind !== kind) { kind = p.kind; rebuild(); }
        s.scene.provide('sun', { ...defaultSun(p.seed, p.kind) });
      };
      const facet: AtmosphereFacet = {
        get kind() { return kind; },
        get preset() { return preset; },
        get version() { return bakedVersion; },
        override(p) { overrides = p ? { ...(overrides ?? {}), ...p } : null; rebuild(); },
      };
      s.scene.provide('atmosphere', facet);
      if (planet) applyPlanet(planet); else s.scene.provide('sun', { ...defaultSun(1, kind) });
      disposers.push(s.events.on('planetChanged', e => applyPlanet(e.planet)));
      s.bindings.provide('atmosphere', { transmittance: views.t, multiscatter: views.ms, skyView: views.sv, params: { buffer: params } });

      disposers.push(s.graph.addPass({
        name: 'atmosphere-luts', slot: 'compute.pre', order: 0, reads: ['frameUniforms'], writes: [],
        run(c) {
          const p = s.scene.get('planet');
          if (p && !samePlanet(p, planet)) applyPlanet(p);
          const f = c.frame;
          packAtmosphereParams(preset, { sunDir: f.sunDir as Vec3, eye: f.eye as Vec3, planetRadius: planet?.radius ?? 18, tier: f.tier }, staging);
          const changed = !skyViewValid || stagingBytes.some((b, i) => b !== lastBytes[i]);
          if (changed) { queue.writeBuffer(params, 0, staging); lastBytes.set(stagingBytes); }
          const pt = s.ctx.pipelines.get<GPUComputePipeline>(keys.t);
          const pm = s.ctx.pipelines.get<GPUComputePipeline>(keys.ms);
          const ps = s.ctx.pipelines.get<GPUComputePipeline>(keys.sv);
          const bake = bakedVersion !== version && !!pt && !!pm;
          if (!bake && (!changed || !ps)) return;
          const ts = c.timestampWrites('atmosphere-luts') as GPUComputePassTimestampWrites | undefined;
          const pass = c.encoder.beginComputePass({ label: 'atmosphere-luts', ...(ts ? { timestampWrites: ts } : {}) });
          if (bake) {
            pass.setPipeline(pt!); pass.setBindGroup(0, groups.t);
            pass.dispatchWorkgroups(Math.ceil(TRANSMITTANCE_LUT.w / 8), Math.ceil(TRANSMITTANCE_LUT.h / 8));
            pass.setPipeline(pm!); pass.setBindGroup(0, groups.ms);
            pass.dispatchWorkgroups(Math.ceil(MULTISCATTER_LUT.w / 8), Math.ceil(MULTISCATTER_LUT.h / 8));
            bakedVersion = version;
            s.telemetry.count('atmosphereBakes');
          }
          if (ps) {
            pass.setPipeline(ps); pass.setBindGroup(0, groups.sv);
            pass.dispatchWorkgroups(Math.ceil(SKY_VIEW_LUT.w * 2 / 8), Math.ceil(SKY_VIEW_LUT.h / 8));
            skyViewValid = true;
          }
          pass.end();
        },
      }));
    },
    dispose() { for (const d of disposers.splice(0)) d(); },
  };
}
