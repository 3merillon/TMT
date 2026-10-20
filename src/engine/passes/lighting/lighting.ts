// Ported from Pinionfall src/gpu/deferred-lighting-pipeline.ts (MIT, same owner) — rewrite-inspired
/**
 * Lighting v1 module: the 'lighting' slot pass (replaces W0 lighting v0; the export names are kept for the engine core).
 * Pipeline shape from Pinionfall: 8×8 compute, a scissor rectangle (the full internal target — sky pixels are shaded here
 * too), bind groups cached on their FULL resource list (placeholders included), HDR rgba16float written write-only.
 *
 * Caps check: v0 bound every reserved binding (19 sampled textures in one compute stage; the default
 * maxSampledTexturesPerShaderStage is 16). v1 binds only what it reads — `LIGHTING_RESERVED` (sun shadows, sky light,
 * atmosphere, ao, lights, sdf, gi, cloudShadow), dropping gi and then ao/cloudShadow when the adapter's sampled-texture limit is small. The fog of
 * war arrives as the surface veil texture and the world visibility volume (fog-of-war.ts).
 * Declares 'hdr' (rgba16float, internal): STORAGE (written here), TEXTURE (post reads it), RENDER_ATTACHMENT (forward).
 */
import type { EngineServices, QualityTier, RenderModule, ReservedBindingName, Vec3 } from '../../contracts';
import { RESERVED_BINDING_LAYOUT } from '../../contracts';
import { BindGroupResourceCache, pushBindingKey } from '../../gpu/bind-group-cache';
import { BufferUsage, ShaderStage, TextureUsage } from '../../gpu/flags';
import { reservedBindGroupEntries, reservedLayoutEntries } from '../../reserved-bindings';
import { link } from '../../wgsl/module';
import { createFrameBindGroup, GBUFFER_NAMES } from '../gbuffer/gbuffer';
import { INTERIOR_MAX_OCCLUDERS, packInteriorOccluders } from '../../scene/interior';
import {
  buildLightingShader, LIGHTING_GBUFFER_TEXTURES, LIGHTING_PARAMS, LIGHTING_RESERVED, LIGHTING_RESERVED_NO_AO, LIGHTING_RESERVED_NO_GI,
  LIGHTING_SUN_CLASS_BINDING, LIGHTING_TERM, lightingShaderWgsl, lightingVariantKey, SDF_MOON_TAN, SDF_SUN_TAN, SHADOW_STRUCTURES_MAX, SHAPED_AMBIENT, type LightingShaderOptions,
} from './lighting.wgsl';
import { installSunClass } from '../atmosphere/sun-class';
import { VIEW_INDEX, type LightingDebugView } from './debug-views';
export { LIGHTING_DEBUG_VIEWS, LIGHTING_DEBUG_VIEW_INFO, type LightingDebugView } from './debug-views';

/** Per tier: sun/moon SDF trace steps and the shadowed local lights per pixel. */
export const LIGHTING_SDF_TIERS: Readonly<Record<QualityTier, { steps: number; localShadows: number }>> = {
  low: { steps: 24, localShadows: 2 }, medium: { steps: 32, localShadows: 8 }, high: { steps: 48, localShadows: 16 }, ultra: { steps: 64, localShadows: 32 },
};
/** GI blend: how strongly the probes' sky visibility darkens the sky ambient, and the bounce gain. */
export const LIGHTING_GI = { skyVisibility: 1.0, bounce: 2.0 } as const;

export const HDR_FORMAT: GPUTextureFormat = 'rgba16float';

export interface LightingParamsV1 {
  /** Sky gradient used only while no atmosphere is provided (placeholder params). */
  fallbackZenith: [number, number, number]; fallbackHorizon: [number, number, number]; stars: number;
  /** Horizontal sky irradiance used only while no sky light is provided. */
  fallbackIrradiance: number;
  nightTint: [number, number, number];
  /** Night floor multiplier (× the atmosphere preset's night tint). */
  nightGain: number;
  envSpecular: number;
  ground: [number, number, number];
  sunDiscRadiance: number; sunGlow: number;
  /** Moonlight tint (linear, × the moon facet's illuminance and phase) and the moonlit-sky ambient share. */
  moonTint: [number, number, number]; moonSkyFill: number;
}

export const LIGHTING_V1_DEFAULTS: LightingParamsV1 = {
  fallbackZenith: [0.09, 0.24, 0.95], fallbackHorizon: [0.78, 1.12, 1.72], stars: 6,
  fallbackIrradiance: 3.2,
  nightTint: [0.05, 0.07, 0.14],
  // Starlight: moonless nights (the moon has phases) stay dim but readable, roughly a tenth of full moonlight.
  nightGain: 2.5,
  envSpecular: 1,
  ground: [0.34, 0.33, 0.28],
  sunDiscRadiance: 30, sunGlow: 1.2,
  moonTint: [0.42, 0.58, 1.0], moonSkyFill: 0.35,
};
/** @deprecated v0 name, kept for callers of the W0 API. */
export const LIGHTING_V0_DEFAULTS = LIGHTING_V1_DEFAULTS;

/** Dev switches: each false turns one lighting term off (the ?dev panel). */
export interface LightingToggles { veil: boolean; mist: boolean; gi: boolean; sunShadows: boolean; moonShadows: boolean; localShadows: boolean; casters: boolean }

declare module '../../contracts' {
  interface SceneFacets {
    /** W1-ENG-LOOK: lighting debug knobs (the AO/ambient invariance check, term views). */
    lighting: LightingFacet;
  }
}
export interface ShadowStructure { center: Vec3; halfSize: Vec3; /** Orthonormal local axes; omitted: world-aligned. */ axes?: readonly [Vec3, Vec3, Vec3] }

/** Pack building boxes for sky_trace: centre + bounding radius, then each axis × its half size. */
export function packShadowStructures(boxes: readonly ShadowStructure[], out: Float32Array): number {
  out.fill(0);
  const n = Math.min(boxes.length, SHADOW_STRUCTURES_MAX);
  for (let i = 0; i < n; i++) {
    const b = boxes[i], axes = b.axes ?? [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    out.set([...b.center, Math.hypot(...b.halfSize)], i * 16);
    for (let a = 0; a < 3; a++) out.set([...axes[a], b.halfSize[a]], i * 16 + 4 + a * 4);
  }
  return n;
}

export interface LightingFacet {
  /** Ambient scale (1; 0 turns every ambient term off). */
  ambient: number;
  /** false forces AO to 1 (material and reserved AO ignored). */
  ao: boolean;
  view: LightingDebugView;
  /** Building boxes (oriented) the sun and moon shadows read exactly; the game sets them with its world. */
  structures: readonly ShadowStructure[];
  /** Dev switches for isolating terms; all on by default. */
  toggles: LightingToggles;
  /** Reserved bindings this pass binds (after the caps check). */
  readonly bindings: readonly ReservedBindingName[];
  /**
   * For passes that link the lighting module and add their own entry point (the composite in fluids/fluids.wgsl.ts):
   * the variant, the layouts of @group(1) and @group(2), and this frame's bind groups (null until the pass ran).
   * They stay valid for the rest of the frame when the later pass declares reads of the G-buffer and 'hdr'.
   */
  readonly shared: LightingShared;
}
export interface LightingShared {
  readonly options: LightingShaderOptions;
  readonly layouts: readonly [GPUBindGroupLayout, GPUBindGroupLayout];
  groups: readonly [GPUBindGroup, GPUBindGroup] | null;
}

/** Sampled textures the lighting stage declares for a reserved-binding plan. */
export function lightingSampledTextures(names: readonly ReservedBindingName[]): number {
  let n = LIGHTING_GBUFFER_TEXTURES;
  for (const name of names) for (const slot of RESERVED_BINDING_LAYOUT[name]) if (slot.type.startsWith('texture') || slot.type === 'depth-2d') n++;
  return n;
}

/** The binding plan for an adapter limit (drops GI, then AO/surface cloud shadows, when they do not fit). */
export function lightingBindingPlan(maxSampledTextures: number): readonly ReservedBindingName[] {
  if (lightingSampledTextures(LIGHTING_RESERVED) <= maxSampledTextures) return LIGHTING_RESERVED;
  if (lightingSampledTextures(LIGHTING_RESERVED_NO_GI) <= maxSampledTextures) return LIGHTING_RESERVED_NO_GI;
  if (lightingSampledTextures(LIGHTING_RESERVED_NO_AO) <= maxSampledTextures) return LIGHTING_RESERVED_NO_AO;
  throw new Error(`lighting needs ${lightingSampledTextures(LIGHTING_RESERVED_NO_AO)} sampled textures per stage; the device offers ${maxSampledTextures}`);
}

/** The LIGHTING_TERM bitmask of a set of toggles. */
export function lightingTermBits(t: LightingToggles): number {
  return (t.veil ? LIGHTING_TERM.veil : 0) | (t.mist ? LIGHTING_TERM.mist : 0) | (t.sunShadows ? LIGHTING_TERM.sunShadows : 0)
    | (t.localShadows ? LIGHTING_TERM.localShadows : 0) | (t.moonShadows ? LIGHTING_TERM.moonShadows : 0) | (t.casters ? LIGHTING_TERM.casters : 0);
}

export function lightingShader(ao = true, gi = true, casters = true, sunClass = false) {
  return ao && gi && casters && !sunClass ? link(lightingShaderWgsl) : link(buildLightingShader({ ao, gi, casters, sunClass }));
}

export function lightingModule(params: Partial<LightingParamsV1> = {}): RenderModule {
  const disposers: (() => void)[] = [];
  const p: LightingParamsV1 = { ...LIGHTING_V1_DEFAULTS, ...params };
  return {
    name: 'lighting-v1',
    install(s: EngineServices) {
      const { device, queue } = s.ctx;
      // COPY_SRC: the fluid composite snapshots it as its refraction source.
      s.graph.declareTexture('hdr', { format: HDR_FORMAT, size: 'internal', usage: TextureUsage.STORAGE_BINDING | TextureUsage.TEXTURE_BINDING | TextureUsage.RENDER_ATTACHMENT | TextureUsage.COPY_SRC });
      const C = ShaderStage.COMPUTE;
      const textureLimit = device.limits?.maxSampledTexturesPerShaderStage ?? 16;
      // Preserve tank cast shadows before spending the last slot on optional lighting inputs.
      const names = lightingBindingPlan(textureLimit > 16 ? textureLimit - 1 : textureLimit);
      const withAo = names.includes('ao');
      const withGi = names.includes('gi');
      // The tank bricks' atlas takes one more sampled texture; dropped (no tank shadows) when it does not fit.
      const withCasters = lightingSampledTextures(names) + 1 <= textureLimit;
      const casters = s.scene.get('sdfCasters');
      if (withCasters && !casters) throw new Error('SDF casters must be installed before lighting.');
      // The sun classes take one more sampled texture; without them the aerial and sky marches run everywhere.
      const sunClass = lightingSampledTextures(names) + (withCasters ? 1 : 0) + 1 <= textureLimit ? installSunClass(s, disposers) : null;
      const withSunClass = !!sunClass;
      const gbufferLayout = device.createBindGroupLayout({
        label: 'layout:lighting-gbuffer',
        entries: [
          { binding: 0, visibility: C, texture: { sampleType: 'unfilterable-float' } },
          { binding: 1, visibility: C, texture: { sampleType: 'unfilterable-float' } },
          { binding: 2, visibility: C, texture: { sampleType: 'unfilterable-float' } },
          { binding: 3, visibility: C, texture: { sampleType: 'uint' } },
          { binding: 4, visibility: C, texture: { sampleType: 'depth' } },
          { binding: 5, visibility: C, storageTexture: { access: 'write-only', format: HDR_FORMAT } },
          { binding: 6, visibility: C, buffer: { type: 'uniform', minBindingSize: LIGHTING_PARAMS.size } },
          { binding: 7, visibility: C, sampler: { type: 'filtering' } },
          { binding: 8, visibility: C, buffer: { type: 'uniform' } },
          { binding: 9, visibility: C, texture: { sampleType: 'unfilterable-float' } },
          { binding: 10, visibility: C, texture: { sampleType: 'float', viewDimension: '3d' } },
          { binding: 11, visibility: C, sampler: { type: 'filtering' } },
          ...(withCasters ? [
            { binding: 12, visibility: C, texture: { sampleType: 'float' as const, viewDimension: '3d' as const } },
            { binding: 13, visibility: C, buffer: { type: 'uniform' as const } },
          ] : []),
          ...(withSunClass ? [{ binding: LIGHTING_SUN_CLASS_BINDING, visibility: C, texture: { sampleType: 'uint' as const, viewDimension: '3d' as const } }] : []),
        ],
      });
      const reservedLayout = device.createBindGroupLayout({ label: 'layout:lighting-reserved', entries: reservedLayoutEntries(C, names) });
      const key = lightingVariantKey({ ao: withAo, gi: withGi, casters: withCasters, sunClass: withSunClass });
      s.ctx.pipelines.register(key, 'compute', () => ({
        label: key,
        layout: device.createPipelineLayout({ bindGroupLayouts: [s.ctx.layouts.frame, gbufferLayout, reservedLayout] }),
        compute: { module: s.ctx.pipelines.shaderModule(lightingShader(withAo, withGi, withCasters, withSunClass), key), entryPoint: 'main' },
      }));
      void s.ctx.pipelines.compile(key).catch(() => undefined);

      const paramsBuffer = device.createBuffer({ label: 'lighting:params', size: LIGHTING_PARAMS.size, usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
      const sampler = device.createSampler({ label: 'lighting:linear', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge' });
      const fog = s.scene.get('fogOfWar');
      if (!fog) throw new Error('Fog of war must be installed before lighting.');
      const staging = new ArrayBuffer(LIGHTING_PARAMS.size);
      const interiorBoxes = new Float32Array(INTERIOR_MAX_OCCLUDERS * 8);
      const structureData = new Float32Array(SHADOW_STRUCTURES_MAX * 16);
      let packedStructures: readonly ShadowStructure[] | null = null, structureCount = 0;
      const frameGroup = createFrameBindGroup(s, 'lighting');
      const gbufferGroups = new BindGroupResourceCache(4);
      const reservedGroups = new BindGroupResourceCache(4);
      const facet: LightingFacet = { ambient: 1, ao: true, view: 'none', structures: [], bindings: names,
        toggles: { veil: true, mist: true, gi: true, sunShadows: true, moonShadows: true, localShadows: true, casters: true },
        shared: { options: { ao: withAo, gi: withGi, casters: withCasters, sunClass: withSunClass }, layouts: [gbufferLayout, reservedLayout], groups: null } };
      s.scene.provide('lighting', facet);

      disposers.push(s.graph.addPass({
        name: 'lighting', slot: 'lighting', order: 0,
        reads: ['frameUniforms', ...GBUFFER_NAMES.filter(n => n !== 'velocity')], writes: ['hdr'],
        run(c) {
          const pipeline = s.ctx.pipelines.get<GPUComputePipeline>(key);
          if (!pipeline) return;
          const [w, h] = c.frame.internal;
          const sunDir = c.frame.sunDir;
          const moon = s.scene.get('moon') ?? { dirToward: [-sunDir[0], -sunDir[1], -sunDir[2]], illuminance: 0, phase: 1 };
          const interior = s.scene.get('interior');
          if (facet.structures !== packedStructures) { packedStructures = facet.structures; structureCount = packShadowStructures(facet.structures, structureData); }
          LIGHTING_PARAMS.pack({
            scissor: [0, 0, w, h],
            fallback_zenith: [...p.fallbackZenith, p.stars], fallback_horizon: [...p.fallbackHorizon, p.fallbackIrradiance],
            shaping: [SHAPED_AMBIENT.ambShadowKeep, SHAPED_AMBIENT.nightAmbScale, SHAPED_AMBIENT.dayLo, SHAPED_AMBIENT.dayHi],
            shaping2: [SHAPED_AMBIENT.backFillNight, SHAPED_AMBIENT.terminatorGain, p.nightGain, SHAPED_AMBIENT.hemiGround],
            night_tint: [...p.nightTint, p.envSpecular],
            ground: [...p.ground, facet.ambient],
            sun_disc: [p.sunDiscRadiance, p.sunGlow, facet.ao ? 1 : 0, VIEW_INDEX[facet.view] ?? 0],
            moon: [...p.moonTint.map(c => c * moon.illuminance), p.moonSkyFill],
            moon_dir: [...moon.dirToward, moon.phase],
            sdf_shadow: [SDF_SUN_TAN, SDF_MOON_TAN, facet.toggles.localShadows ? LIGHTING_SDF_TIERS[s.settings.shadowTier ?? c.frame.tier].localShadows : 0, LIGHTING_SDF_TIERS[s.settings.shadowTier ?? c.frame.tier].steps],
            gi: facet.toggles.gi ? [LIGHTING_GI.skyVisibility, LIGHTING_GI.bounce, 0, 0] : [0, 0, 0, 0],
            debug: [lightingTermBits(facet.toggles), 0, 0, 0],
            interior_ambient: [...(interior?.ambient ?? [0, 0, 0]), interior ? 1 : 0],
            interior_background: [...(interior?.background ?? [0, 0, 0]), interior?.occluders.length ?? 0],
            interior_fog: [...(interior?.fogColor ?? [0, 0, 0]), Math.max(0, interior?.fogDensity ?? 0)],
            interior_fan: [...(interior?.fan?.center ?? [0, 0, 0]), interior?.fan?.radius ?? 0],
            interior_fan_control: [interior?.fan?.angle ?? 0, interior?.fan?.blades ?? 7, 0, 0],
            interior_fan_light: [...(interior?.fan?.emitter ?? [0, 0, 0]), interior?.fan?.strength ?? 0],
            interior_probe: [...(interior?.reflection?.position ?? [0, 0, 0]), interior?.reflection?.mips ?? 0],
            interior_probe_min: [...(interior?.reflection?.min ?? [0, 0, 0]), interior?.reflection?.intensity ?? 0],
            interior_probe_max: [...(interior?.reflection?.max ?? [0, 0, 0]), 0],
            interior_boxes: packInteriorOccluders(interior?.occluders ?? [], interiorBoxes),
            // Snap within 0.6 voxel: trilinear reconstruction of a box's exact distances stays inside that.
            structure_info: [structureCount, 0.6 * (s.scene.get('sdf')?.voxel ?? 0.19), 0, 0],
            structures: structureData,
          }, staging);
          queue.writeBuffer(paramsBuffer, 0, staging);
          const r = c.resources;
          const views = [r.view('albedoAo'), r.view('normals'), r.view('material'), r.view('ids'), r.view('depth'), r.view('hdr')];
          const k = gbufferGroups.begin(); k.push(...views, paramsBuffer, fog.paramsBuffer, fog.hiddenView, fog.volumeView);
          if (withCasters) k.push(casters!.atlasView, casters!.listBuffer);
          if (sunClass) k.push(sunClass.view);
          const gbufferGroup = gbufferGroups.get(() => device.createBindGroup({
            label: 'lighting:gbuffer', layout: gbufferLayout,
            entries: [...views.map((view, binding) => ({ binding, resource: view })), { binding: 6, resource: { buffer: paramsBuffer } }, { binding: 7, resource: sampler },
              { binding: 8, resource: { buffer: fog.paramsBuffer } }, { binding: 9, resource: fog.hiddenView },
              { binding: 10, resource: fog.volumeView }, { binding: 11, resource: sampler },
              ...(withCasters ? [{ binding: 12, resource: casters!.atlasView }, { binding: 13, resource: { buffer: casters!.listBuffer } }] : []),
              ...(sunClass ? [{ binding: LIGHTING_SUN_CLASS_BINDING, resource: sunClass.view }] : [])],
          }));
          const rk = reservedGroups.begin();
          for (const name of names) for (const res of Object.values(s.bindings.get(name))) pushBindingKey(rk, res);
          const reservedGroup = reservedGroups.get(() => device.createBindGroup({ label: 'lighting:reserved', layout: reservedLayout, entries: reservedBindGroupEntries(s.bindings, names) }));
          facet.shared.groups = [gbufferGroup, reservedGroup];
          const ts = c.timestampWrites('lighting') as GPUComputePassTimestampWrites | undefined;
          const pass = c.encoder.beginComputePass({ label: 'lighting', ...(ts ? { timestampWrites: ts } : {}) });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, frameGroup);
          pass.setBindGroup(1, gbufferGroup);
          pass.setBindGroup(2, reservedGroup);
          pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
          pass.end();
        },
      }));
      disposers.push(() => s.ctx.deferDestroy(paramsBuffer));
    },
    dispose() { for (const d of disposers.splice(0)) d(); },
  };
}
