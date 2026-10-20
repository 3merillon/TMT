// Ported from Pinionfall src/gpu/deferred-lighting-shader.ts (MIT, same owner) — rewrite-inspired
/**
 * Lighting v1 (plan §4.5 'lighting' slot, §4.8–4.11): one 8×8 compute pass writing HDR rgba16float (write-only).
 *
 * Geometry pixels (the frozen W0 G-buffer decode, position from reversed-Z depth):
 * - sun: GGX (energy-compensated) + Burley × the geometric-normal back-face gate × sun visibility × a screen-space
 *   contact shadow (12 steps along L over 0.3 u, thickness 0.05), in the per-pixel sun colour (`atmo_sun_color`: a
 *   reference transmittance LUT or an exposed-air column integral, × sunset grade), evaluated after visibility. With
 *   the planet SDF: its soft cone trace toward the sun (the destructible world) times the
 *   same trace through the tank bricks (`casters_vis_dir`, sdf-casters.ts); the three sun maps only until the SDF exists;
 * - moon: a cool, dim directional light on its own orbit (the moon facet), scaled by its phase, with its own soft SDF and
 *   brick visibility and a moonlit-sky fill in the ambient, so moonlit nights stay readable;
 * - ≤ 64 punctual lights; `castShadow` lights get a soft SDF trace (static world, capped per pixel by tier) times the
 *   bricks (`casters_vis_point_emitter`, with a bounded escape from the emitting fixture's own voxel skin);
 * - ambient diffuse: the L1-SH sky irradiance × Pinionfall's shaped-hemisphere factors (cast-shadow keep, night floor,
 *   terminator back-fill; up = normalize(world_pos)), × the GI probes' sky visibility, + their bounce irradiance;
 * - ambient specular: the prefiltered sky cube (split sum with the DFG LUT) × specular occlusion;
 * - emissive; then aerial perspective (`atmo_integrate` from the eye to the pixel, 12 steps, jittered);
 * - fog of war: terrain-class surfaces and veiled objects (enemy tanks) mix toward the war-fog colour by the surface
 *   hidden fraction, then every ray (sky rays to the atmosphere exit) marches the world visibility volume.
 * Sky pixels (class SKY): `atmo_integrate` at every camera altitude, with live terrain visibility and air support.
 * Geometry depth clips view rays to the actual surface; no nominal opaque sphere closes excavations. The analytic
 * diorama LUT remains a backdrop, fading to stars in overview and at night. The backdrop and sun/moon discs pass
 * through the integrated view transmittance. Ambient SH/specular sky lighting still uses the analytic reference LUTs.
 *
 * AO (min of material AO and the reserved `ao` texture) scales ambient diffuse and ambient specular ONLY — never direct
 * light (`compose_lighting`; mirrored in lighting-mirror.ts and unit-tested).
 * Every reserved binding has a placeholder fallback: no atmosphere → a v0-style gradient sky and a white sun; no sky
 * light → a hemisphere ambient; no sun shadows → visibility 1.
 */
import type { ReservedBindingName } from '../../contracts';
import { makeModule, wgslStruct } from '../../wgsl/module';
import { brdfWgsl } from '../../wgsl/common/brdf.wgsl';
import { depthWgsl } from '../../wgsl/common/depth.wgsl';
import { frameWgsl } from '../../wgsl/common/frame.wgsl';
import { gbufferWgsl } from '../../wgsl/common/gbuffer.wgsl';
import { radialWgsl } from '../../wgsl/common/radial.wgsl';
import { lightsWgsl } from '../../scene/lights';
import { reservedBinding } from '../../reserved-bindings';
import { atmosphereFnWgsl, atmosphereSkyViewWgsl } from '../atmosphere/integrate.wgsl';
import { ATMOSPHERE_PARAMS } from '../atmosphere/params';
import { shadowSampleWgsl, sunShadowBindingsWgsl } from '../shadows/shadow.wgsl';
import { SKY_LIGHT_PARAMS, skyLightBindingsWgsl, skyLightFnWgsl } from './sky-light';
import { OBJECT_ID_VEIL } from '../../contracts';
import { FOG_PARAMS, fogParamsBindingWgsl } from '../fog-of-war/fog.wgsl';
import { SDF_FACET_TOLERANCE, SDF_PENUMBRA_MAX, sdfBindingsWgsl, sdfWgsl } from '../sdf/sdf.wgsl';
import { sdfCastersWgsl } from '../sdf/sdf-casters';
import { giBindingsWgsl, giSampleWgsl } from '../gi/gi.wgsl';
import { INTERIOR_MAX_OCCLUDERS } from '../../scene/interior';
import { interiorLightingWgsl } from './interior.wgsl';
import { cloudShadowSampleWgsl } from '../clouds/shadow.wgsl';
import { atmosphereTerrainClassifiedWgsl, atmosphereTerrainWgsl } from '../atmosphere/terrain.wgsl';

/** Reserved bindings the lighting pass binds in @group(2), in this order (consecutive from binding 0). */
export const LIGHTING_RESERVED: readonly ReservedBindingName[] = ['sunShadows', 'skyLight', 'atmosphere', 'ao', 'lights', 'sdf', 'gi', 'cloudShadow'];
/** Without the GI probes, then also without the `ao` texture, for adapters whose maxSampledTexturesPerShaderStage is small. */
export const LIGHTING_RESERVED_NO_GI: readonly ReservedBindingName[] = ['sunShadows', 'skyLight', 'atmosphere', 'ao', 'lights', 'sdf', 'cloudShadow'];
/** Minimum 16-texture device: keep the world SDF; cloud surface shadows are omitted with AO/GI. */
export const LIGHTING_RESERVED_NO_AO: readonly ReservedBindingName[] = ['sunShadows', 'skyLight', 'atmosphere', 'lights', 'sdf'];
/** G-buffer (4) + depth (1) + fog surface veil and visibility volume (2) in @group(1). */
export const LIGHTING_GBUFFER_TEXTURES = 7;
/** Building boxes the sun and moon traces read exactly (sky_trace). */
export const SHADOW_STRUCTURES_MAX = 64;
/** Soft SDF sun/moon penumbra: tangents of the (miniature-exaggerated) source radii. */
export const SDF_SUN_TAN = 0.035;
export const SDF_MOON_TAN = 0.045;

export const LIGHTING_PARAMS = wgslStruct('LightingParams', [
  ['scissor', 'vec4u'],           // x0, y0, width, height (internal px)
  ['fallback_zenith', 'vec4f'],   // rgb zenith radiance when no atmosphere is provided, w star brightness
  ['fallback_horizon', 'vec4f'],  // rgb horizon radiance, w horizontal sky irradiance (noon) when no sky light is provided
  ['shaping', 'vec4f'],           // amb_shadow_keep, night_amb_scale, day_lo, day_hi (Pinionfall)
  ['shaping2', 'vec4f'],          // back_fill_night, terminator_gain, night floor gain, hemi_ground
  ['night_tint', 'vec4f'],        // rgb night floor without an atmosphere, w env specular scale
  ['ground', 'vec4f'],            // rgb fallback ground bounce, w ambient scale (1; 0 = ambient off, a debug knob)
  ['sun_disc', 'vec4f'],          // x disc radiance, y glow, z AO on (1) / forced 1 (0), w debug view (0 none, 1 shadow, 2 direct, 3 ambient)
  ['moon', 'vec4f'],              // rgb full-moon radiance (tint × illuminance), w moonlit-sky fill fraction
  ['moon_dir', 'vec4f'],          // xyz unit vector toward the moon, w phase (lit fraction: 1 full, 0 new)
  ['sdf_shadow', 'vec4f'],        // x sun tan, y moon tan, z shadowed local lights per pixel, w sun/moon trace steps
  ['gi', 'vec4f'],                // x sky-visibility strength, y bounce gain, zw unused
  ['debug', 'vec4f'],             // x term toggles (LIGHTING_TERM bits; all set = normal), yzw unused
  ['interior_ambient', 'vec4f'],  // rgb room indirect irradiance, w interior enabled
  ['interior_background', 'vec4f'], // rgb unfilled pixels, w closed room box count
  ['interior_fog', 'vec4f'],      // rgb local haze radiance, w extinction / world unit
  ['interior_fan', 'vec4f'],      // xyz ventilation opening centre, w clear radius
  ['interior_fan_control', 'vec4f'], // x rotor angle, y blade count, zw reserved
  ['interior_fan_light', 'vec4f'], // xyz source behind the vent, w volumetric radiance
  ['interior_probe', 'vec4f'],    // xyz captured observer, w mip count (zero disables)
  ['interior_probe_min', 'vec4f'], // xyz parallax proxy minimum, w reflection strength
  ['interior_probe_max', 'vec4f'], // xyz parallax proxy maximum
  ['interior_boxes', { array: 'vec4f', count: INTERIOR_MAX_OCCLUDERS * 2 }], // min/max world-space solids
  ['structure_info', 'vec4f'],    // x building boxes, y snap tolerance (u): see sky_trace
  // Per building box, 4 × vec4f: centre + bounding radius, then each local axis × its half size.
  ['structures', { array: 'vec4f', count: SHADOW_STRUCTURES_MAX * 4 }],
]);

/** Bits of params.debug.x: each switches one term on (the ?dev panel clears them to isolate artifacts). */
export const LIGHTING_TERM = { veil: 1, mist: 2, sunShadows: 4, localShadows: 8, moonShadows: 16, casters: 32 } as const;
export const LIGHTING_TERMS_ALL = 63;

/** Pinionfall's shipped shaped-ambient defaults (debug-flags.ts / cloud-shadow tests). */
export const SHAPED_AMBIENT = {
  ambShadowKeep: 0.725, nightAmbScale: 0.75, dayLo: -0.12, dayHi: 0.10,
  backFillNight: 0.06, terminatorGain: 1.4, skyGain: 1.0, hemiGround: 0.70,
} as const;

export const lightingComposeWgsl = makeModule('lighting-compose', /* wgsl */ `
/** The only place terms are summed. AO never touches direct light. */
fn compose_lighting(direct: vec3f, emissive: vec3f, ambient_diffuse: vec3f, ambient_specular: vec3f, ao: f32, specular_occlusion: f32) -> vec3f {
  return direct + emissive + ambient_diffuse * ao + ambient_specular * specular_occlusion;
}
`);

export interface LightingShaderOptions { ao: boolean; gi?: boolean; /** The SDF caster bricks (tank shadows; default on). */ casters?: boolean;
  /** Answer the aerial and sky sun marches from the exact sun classes where they are certain (atmosphere/sun-class.ts). */
  sunClass?: boolean }
/** @group(1) binding of the sun class volume in the sunClass variant. */
export const LIGHTING_SUN_CLASS_BINDING = 14;

function bindingsFor(names: readonly ReservedBindingName[], sunClass = false) {
  const b = (name: ReservedBindingName, key: string) => reservedBinding(name, key, names);
  return {
    shadows: sunShadowBindingsWgsl(2, { static: b('sunShadows', 'static'), dynamic: b('sunShadows', 'dynamic'), hero: b('sunShadows', 'hero'), compare: b('sunShadows', 'compare'), params: b('sunShadows', 'params') }),
    sky: skyLightBindingsWgsl(2, { params: b('skyLight', 'sh'), atlas: b('skyLight', 'dfg'), cube: b('skyLight', 'cube') }),
    atmo: makeModule(`lighting-atmo-bindings:${names.join(',')}${sunClass ? ':sun-class' : ''}`, [
      `@group(2) @binding(${b('atmosphere', 'params')}) var<uniform> atmo: AtmosphereParams;`,
      `@group(2) @binding(${b('atmosphere', 'transmittance')}) var atmo_transmittance_lut: texture_2d<f32>;`,
      `@group(2) @binding(${b('atmosphere', 'multiscatter')}) var atmo_multiscatter_lut: texture_2d<f32>;`,
      `@group(2) @binding(${b('atmosphere', 'skyView')}) var atmo_sky_view_lut: texture_2d<f32>;`,
      '@group(1) @binding(7) var atmo_lut_sampler: sampler;',
    ].join('\n'), [ATMOSPHERE_PARAMS.module, sunClass ? atmosphereTerrainClassifiedWgsl(1, LIGHTING_SUN_CLASS_BINDING) : atmosphereTerrainWgsl]),
    lights: b('lights', 'list'),
    ao: names.includes('ao') ? b('ao', 'ao') : -1,
    sdf: sdfBindingsWgsl(2, { volume: b('sdf', 'volume'), params: b('sdf', 'params'), sampler: 11 }, 1),
    gi: names.includes('gi') ? giBindingsWgsl(2, { probes: b('gi', 'probes'), params: b('gi', 'params') }) : null,
    clouds: names.includes('cloudShadow') ? makeModule('lighting-cloud-bindings', /* wgsl */ `
@group(2) @binding(${b('cloudShadow', 'cube')}) var cloud_shadow_cube: texture_cube<f32>;
@group(2) @binding(${b('cloudShadow', 'params')}) var<uniform> cloud_shadow_params: CloudParams;
fn lighting_cloud_shadow(p: vec3f) -> f32 { return cloud_shadow_visibility(cloud_shadow_cube, atmo_lut_sampler, cloud_shadow_params, p); }
`, [cloudShadowSampleWgsl]) : makeModule('lighting-cloud-absent', 'fn lighting_cloud_shadow(p: vec3f) -> f32 { return 1.0; }'),
  };
}

/** Pipeline and module key of a lighting variant. */
export function lightingVariantKey(o: LightingShaderOptions): string {
  return `${!o.ao ? 'lighting-v1-no-ao' : o.gi === false ? 'lighting-v1-no-gi' : 'lighting-v1'}${o.casters === false ? '-no-casters' : ''}${o.sunClass ? '-sun-class' : ''}`;
}

export function lightingReservedNames(o: LightingShaderOptions): readonly ReservedBindingName[] {
  return !o.ao ? LIGHTING_RESERVED_NO_AO : o.gi === false ? LIGHTING_RESERVED_NO_GI : LIGHTING_RESERVED;
}

/** Stand-in when the adapter cannot bind the caster atlas (lighting's texture budget): tanks cast no shadows. */
const castersAbsentWgsl = makeModule('sdf-casters-absent', /* wgsl */ `
fn casters_vis_dir(p: vec3f, l: vec3f, tan_a: f32) -> f32 { return 1.0; }
fn casters_vis_point(p: vec3f, s: vec3f, width: vec3f) -> f32 { return 1.0; }
fn casters_vis_point_emitter(p: vec3f, s: vec3f, width: vec3f, source_caster: u32) -> f32 { return 1.0; }
`);

export function buildLightingShader(o: LightingShaderOptions) {
  const names = lightingReservedNames(o);
  const bd = bindingsFor(names, !!o.sunClass);
  const giModules = bd.gi ? [bd.gi, giSampleWgsl] : [makeModule('gi-absent', /* wgsl */ `
struct GiSample { bounce: vec3f, sky: f32, confidence: f32 }
fn gi_sample(p: vec3f, n: vec3f) -> GiSample { return GiSample(vec3f(0.0), 1.0, 0.0); }
`)];
  const aoDecl = bd.ao >= 0 ? `@group(2) @binding(${bd.ao}) var rb_ao: texture_2d<f32>;` : '';
  const aoSample = bd.ao >= 0
    ? `let ao_size = textureDimensions(rb_ao);
  let ao_px = min(vec2u(uv * vec2f(ao_size)), ao_size - vec2u(1u));
  let ao_tex = textureLoad(rb_ao, ao_px, 0).r;`
    : 'let ao_tex = 1.0;';
  return makeModule(lightingVariantKey(o), /* wgsl */ `
@group(1) @binding(0) var gb_albedo_ao: texture_2d<f32>;
@group(1) @binding(1) var gb_normals: texture_2d<f32>;
@group(1) @binding(2) var gb_material: texture_2d<f32>;
@group(1) @binding(3) var gb_ids: texture_2d<u32>;
@group(1) @binding(4) var gb_depth: texture_depth_2d;
@group(1) @binding(5) var hdr_out: texture_storage_2d<rgba16float, write>;
@group(1) @binding(6) var<uniform> params: LightingParams;
@group(1) @binding(9) var fog_hidden: texture_2d<f32>;     // surface veil: 0 seen … 1 hidden
@group(1) @binding(10) var fog_volume: texture_3d<f32>;    // world hidden fraction over ±fog_params.volume.y

@group(2) @binding(${bd.lights}) var<storage, read> light_list: LightList;
${aoDecl}

fn hash33(p: vec3f) -> vec3f {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yxz + 33.33);
  return fract((q.xxy + q.yxx) * q.zyx);
}

/** Angular size (rad) of one internal pixel at the screen centre: stars and disc edges are antialiased to it. */
fn sky_pixel_angle() -> f32 { return 2.0 / max(frame.proj[1][1] * frame_internal_size().y, 1.0); }

/** Smooth 3D value noise and a 3-octave sum (0 … 1), for the Milky Way and the moon's maria. */
fn sky_noise(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let x0 = mix(mix(hash33(i).x, hash33(i + vec3f(1.0, 0.0, 0.0)).x, u.x), mix(hash33(i + vec3f(0.0, 1.0, 0.0)).x, hash33(i + vec3f(1.0, 1.0, 0.0)).x, u.x), u.y);
  let x1 = mix(mix(hash33(i + vec3f(0.0, 0.0, 1.0)).x, hash33(i + vec3f(1.0, 0.0, 1.0)).x, u.x), mix(hash33(i + vec3f(0.0, 1.0, 1.0)).x, hash33(i + vec3f(1.0, 1.0, 1.0)).x, u.x), u.y);
  return mix(x0, x1, u.z);
}
fn sky_fbm(p: vec3f) -> f32 {
  return sky_noise(p) * 0.5714 + sky_noise(p * 2.03 + 17.1) * 0.2857 + sky_noise(p * 4.11 + 31.7) * 0.1429;
}

/**
 * One layer of stars: at most one per cell of a lattice of scale cells per radian, a share density of the cells
 * holding one. Each star is a point source spread over at least a pixel (its flux kept, so it neither vanishes nor
 * crawls under the jitter), with a magnitude drawn from a steep power law and a colour from its temperature.
 */
fn star_layer(dir: vec3f, scale: f32, density: f32, flux: f32, seed: f32, px: f32) -> vec3f {
  let p = dir * scale;
  let cell = floor(p);
  let h = hash33(cell + seed);
  if (h.z > density) { return vec3f(0.0); }
  // Keep the star off its cell's walls, so a pixel-wide spread is never cut by them.
  let centre = normalize(cell + 0.3 + 0.4 * hash33(cell + seed + 7.31)) * scale;
  let d = length(p - centre) / scale;
  let sigma = max(0.00035, px * 0.55);
  let peak = flux * (0.00035 * 0.00035) / (sigma * sigma);
  let magnitude = 0.06 + 0.94 * pow(h.y, 7.0);
  let warm = vec3f(1.0, 0.72, 0.45);
  let white = vec3f(1.0, 0.97, 0.92);
  let blue = vec3f(0.68, 0.8, 1.0);
  let tint = select(mix(white, blue, (h.x - 0.55) / 0.45), mix(warm, white, h.x / 0.55), h.x < 0.55);
  let twinkle = 1.0 + 0.12 * sin(frame.time * (2.0 + 5.0 * h.x) + h.y * 60.0);
  return tint * (peak * magnitude * twinkle * exp(-d * d / (2.0 * sigma * sigma)));
}

/** A fixed galactic band: its pole and centre, world space. */
const SKY_GALAXY_POLE = vec3f(0.3487, 0.7845, -0.5126);
const SKY_GALAXY_CORE = vec3f(0.8572, -0.4365, -0.2734);

/** The night sky at unit brightness: three layers of stars (denser along the Milky Way) and the band's glow and dust. */
fn star_field(dir: vec3f) -> vec3f {
  let px = sky_pixel_angle();
  let b = dot(dir, SKY_GALAXY_POLE);
  let core = exp(-(1.0 - dot(dir, SKY_GALAXY_CORE)) * 3.0);
  let band = exp(-b * b / (2.0 * 0.14 * 0.14)) * (0.55 + 0.45 * core);
  let cloud = sky_fbm(dir * 5.0);
  let dust = smoothstep(0.42, 0.72, sky_fbm(dir * 11.0 + 4.0)) * exp(-b * b / (2.0 * 0.05 * 0.05));
  let glow = band * (0.35 + 0.65 * cloud) * (1.0 - 0.8 * dust);
  var rgb = mix(vec3f(0.55, 0.62, 0.85), vec3f(1.0, 0.86, 0.68), core) * glow * 0.03;
  rgb += star_layer(dir, 70.0, 0.05, 1.6, 0.0, px);
  rgb += star_layer(dir, 150.0, 0.07, 0.75, 13.0, px);
  rgb += star_layer(dir, 300.0, 0.05 + 0.25 * band * (1.0 - dust), 0.32, 29.0, px);
  return rgb;
}

/** Interleaved gradient noise, rotated per frame (a TAA-converged jitter). */
fn pixel_noise(px: vec2f) -> f32 {
  return fract(52.9829189 * fract(0.06711056 * (px.x + 5.588238 * f32(frame_index() % 64u)) + 0.00583715 * px.y));
}

/** Penumbra model of a shadow-casting light (sdf_vis_point's width): a lamp is nearly a point; a fire's emission spread
 *  (direction.w, written by the gas reduction) makes it an area light with shadows as soft as its size. */
fn light_penumbra(light: Light) -> vec3f {
  let size = max(light.direction.w, 0.0);
  return vec3f(0.05, 0.04 + size * 0.25, 0.4 + size);
}

fn day_factor(up: vec3f, l: vec3f) -> f32 {
  return smoothstep(params.shaping.z, params.shaping.w, dot(up, l));
}

/** How much of the sky behind the sun's disc it hides (antialiased edge): stars never show through it. */
fn sun_cover(dir: vec3f, sun: vec3f, radius: f32) -> f32 {
  let aa = max(sky_pixel_angle() / max(radius, 1e-4), 0.02);
  return 1.0 - smoothstep(1.0 - aa, 1.0 + aa, acos(clamp(dot(dir, sun), -1.0, 1.0)) / max(radius, 1e-4));
}

/** The sun: a limb-darkened disc (bluer light darkens faster toward the limb, so the edge is warmer) and a warm glow. */
fn sun_disc(dir: vec3f, sun: vec3f, radius: f32) -> vec3f {
  let c = dot(dir, sun);
  let rn = acos(clamp(c, -1.0, 1.0)) / max(radius, 1e-4);
  if (rn > 14.0) { return vec3f(0.0); }
  let r1 = min(rn, 1.0);
  let mu = sqrt(max(1.0 - r1 * r1, 0.0));
  let limb = pow(vec3f(max(mu, 1e-3)), vec3f(0.40, 0.52, 0.68));
  let inside = sun_cover(dir, sun, radius);
  let body = vec3f(2.8, 2.5, 1.95) * (0.25 + 0.75 * limb) * inside * params.sun_disc.x;
  let glow = (exp(-rn * 1.2) * 1.5 + exp(-rn * 0.45) * 0.35) * (1.0 - smoothstep(7.0, 14.0, rn));
  return body + vec3f(1.0, 0.78, 0.5) * glow * params.sun_disc.y;
}

/** How much of the sky behind the moon's disc it hides (lit or not): stars never show through its dark side. */
fn moon_cover(dir: vec3f, moon: vec3f, radius: f32) -> f32 {
  if (dot(dir, moon) < 0.0) { return 0.0; }
  let aa = max(sky_pixel_angle() / max(radius, 1e-4), 0.02);
  return 1.0 - smoothstep(1.0 - aa, 1.0 + aa, acos(clamp(dot(dir, moon), -1.0, 1.0)) / max(radius, 1e-4));
}

/**
 * The moon: a sphere lit by the real sun, so its phase follows its position (full opposite the sun, new beside it).
 * Lunar regolith reflects by the Lommel–Seeliger law (a full moon is a flat disc, not a shaded ball); dark maria and
 * bright-rimmed craters are fixed on its face (it always shows the planet the same side); the night side keeps a faint
 * planetshine, strongest at new moon; a halo fades with the phase.
 */
fn moon_disc(dir: vec3f, moon: vec3f, sun: vec3f, radius: f32) -> vec3f {
  let rn = acos(clamp(dot(dir, moon), -1.0, 1.0)) / max(radius, 1e-4);
  if (rn > 8.0 || dot(dir, moon) < 0.0) { return vec3f(0.0); }
  let side = normalize(cross(moon, select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(moon.y) > 0.9)));
  let above = cross(moon, side);
  let q = vec2f(dot(dir, side), dot(dir, above)) / max(radius, 1e-4);
  let mu = sqrt(max(1.0 - dot(q, q), 0.0));
  // The visible hemisphere faces the planet: its normal at the disc centre is -moon.
  let normal = normalize(q.x * side + q.y * above - mu * moon);
  let face = vec3f(q, mu);
  // Maria: broad dark basins; craters: one per cell of a coarse lattice on the face, a dark floor and a bright rim.
  let maria = smoothstep(0.48, 0.62, sky_fbm(face * 2.3 + vec3f(3.1, 1.7, 0.4)));
  let fine = sky_fbm(face * 9.0 + 11.0);
  let cell = floor(face * 5.0);
  let ch = hash33(cell + 51.0);
  let cc = (cell + 0.35 + 0.3 * ch) / 5.0;
  let cd = length(face - cc) / (0.03 + 0.07 * ch.z * ch.z);
  let crater = select(0.0, 1.0, ch.x > 0.55);
  let floor_dark = crater * (1.0 - smoothstep(0.6, 0.95, cd)) * 0.18;
  let rim = crater * exp(-(cd - 1.0) * (cd - 1.0) * 18.0) * 0.22;
  let albedo = (0.92 - 0.38 * maria) * (0.86 + 0.14 * fine) * (1.0 - floor_dark) + rim;
  let mu0 = dot(normal, sun);
  let mu0c = max(mu0, 0.0) * smoothstep(-0.03, 0.04, mu0);
  let lit = 2.0 * mu0c / (mu0c + max(mu, 0.05));
  let shine = (0.02 + 0.04 * (1.0 - params.moon_dir.w)) * vec3f(0.75, 0.85, 1.0);
  let inside = moon_cover(dir, moon, radius);
  let glow = (exp(-rn * 1.1) * 0.12 + exp(-rn * 0.5) * 0.03) * (1.0 - smoothstep(5.0, 8.0, rn)) * params.moon_dir.w;
  return params.moon.rgb * (albedo * (0.75 * lit + shine) * inside + glow);
}

/** No-atmosphere fallback (placeholder params): the v0 gradient sky. */
fn sky_fallback(dir: vec3f) -> vec3f {
  let up = radial_up(frame.eye_pos);
  let day = day_factor(up, frame.sun_dir);
  let r_eye = max(length(frame.eye_pos - frame.planet.xyz), frame.planet.w * 1.0001);
  let limb = asin(clamp(frame.planet.w / r_eye, 0.0, 1.0));
  let a = acos(clamp(dot(dir, normalize(frame.planet.xyz - frame.eye_pos)), -1.0, 1.0));
  let t = pow(smoothstep(0.0, 0.7, max(a - limb, 0.0)), 0.75);
  let gradient = mix(params.fallback_horizon.rgb, params.fallback_zenith.rgb, t) * mix(0.03, 1.0, day);
  let hidden = max(sun_cover(dir, frame.sun_dir, 0.035), moon_cover(dir, params.moon_dir.xyz, 0.06));
  let stars = star_field(dir) * (params.fallback_zenith.w * mix(1.0, 0.08, day) * (1.0 - hidden));
  return gradient + stars + sun_disc(dir, frame.sun_dir, 0.035) * 0.05 + moon_disc(dir, params.moon_dir.xyz, frame.sun_dir, 0.06);
}

fn sky_radiance(dir: vec3f, xi: f32) -> vec3f {
  if (!atmo_valid()) { return sky_fallback(dir); }
  let eye = frame.eye_pos;
  let r_cam = max(length(eye), 1e-3);
  let up = eye / r_cam;
  let sun = frame.sun_dir;
  let cos_vz = dot(dir, up);
  let ratio_l = min(frame.planet.w / r_cam, 1.0);
  let cos_limb = -sqrt(max(0.0, 1.0 - ratio_l * ratio_l));
  let sun_h = atmo_sun_horizontal(up, sun);
  let u_az = atmo_sky_view_u(dir, up, sun_h);
  let jit = (xi - 0.5) / vec2f(atmo.lut.z, atmo.lut.w);
  // Integrate every sky ray through the same continuous density profile used for terrain and fog.
  // Switching to the sky-view LUT near the nominal atmosphere altitude made its different horizon
  // parameterisation appear as a camera-height-dependent spherical shell.
  let air = atmo_integrate(eye, dir, 1e9, u32(atmo.steps.x), xi);
  // Analytic diorama backdrop: the reference near-surface sky anchored to the nominal planet limb.
  let e = clamp((cos_vz - cos_limb) / max(1.0 - cos_limb, 1e-4), 0.0, 1.0);
  let day_sky = atmo_sky_view_sample(vec2f(u_az, 0.5 + 0.5 * sqrt(e)) + jit, 1u) * atmo.diorama.y;
  let w = atmo.diorama.x * (1.0 - smoothstep(atmo.fade.x, atmo.fade.y, r_cam)) * smoothstep(-0.15, 0.1, dot(up, sun));
  // The sun and the moon (its dark side too) stand in front of the stars.
  let hidden = max(sun_cover(dir, sun, atmo.fade.z), moon_cover(dir, params.moon_dir.xyz, 0.06));
  let stars = star_field(dir) * (atmo.diorama.w * (1.0 - hidden));
  let backdrop = mix(stars, day_sky, w);
  let disc = sun_disc(dir, sun, atmo.fade.z) + moon_disc(dir, params.moon_dir.xyz, sun, 0.06);
  return backdrop * air.T + air.L + disc * air.T;
}

/**
 * Screen-space contact shadow: 12 depth steps along L over 0.3 u; an occluder within 'thickness' in front shadows.
 * The ray is projected once at both ends and interpolated in clip space (exact for a straight world-space segment).
 */
fn contact_shadow(p: vec3f, ng: vec3f, l: vec3f, dist: f32, xi: f32) -> f32 {
  let steps = u32(sun_shadow_params.contact.y);
  let len = sun_shadow_params.contact.x;
  let thick = sun_shadow_params.contact.z;
  let size = frame_internal_size();
  let bias = 0.0015 * dist + 0.004;
  let c0 = frame.view_proj * vec4f(p + l * bias, 1.0);
  let c1 = frame.view_proj * vec4f(p + l * (bias + len), 1.0);
  for (var i = 0u; i < steps; i++) {
    let f = (f32(i) + xi) / f32(steps);
    let c = mix(c0, c1, f);
    if (c.w <= 1e-4) { break; }
    let ndc = c.xy / c.w;
    if (abs(ndc.x) >= 1.0 || abs(ndc.y) >= 1.0) { break; }
    let spx = min(vec2u(ndc_to_uv(ndc) * size), vec2u(size) - vec2u(1u));
    let d = textureLoad(gb_depth, spx, 0);
    if (d <= 0.0) { continue; }
    // Every test below must pass to shadow: the depth-thickness one first, it rejects most taps without a position.
    let delta = c.w - linear_depth(d);
    if (!(delta > 0.0 && delta < thick)) { continue; }
    if (gbuffer_class(textureLoad(gb_ids, spx, 0).r) == CLASS_GRASS) { continue; }
    // A depth texel is a sample of a surface, not a solid column extending behind it.
    // At grazing light a ray lies behind its OWN receiver triangle even though the
    // continuous shading normal faces the sun. Require an occluder above the receiver
    // plane as well. This rejects coplanar self hits without
    // lifting the ray away from tank tracks, walls or genuine terrain creases.
    let sample_uv = (vec2f(spx) + 0.5) / size;
    let sample_world = world_pos_from_depth(sample_uv, d);
    if (dot(sample_world - p, ng) <= bias) { continue; }
    return 1.0 - sun_shadow_params.contact.w * (1.0 - smoothstep(0.6, 1.0, f));
  }
  return 1.0;
}

/** Aerial-perspective steps for a chord: short in-air chords are nearly homogeneous and need few samples. */
fn aerial_steps(eye: vec3f, dir: vec3f, dist: f32) -> u32 {
  let hit = atmo_ray_sphere(eye, dir, atmo_soft_radius());
  let chord = max(min(hit.y, dist) - max(hit.x, 0.0), 0.0);
  return u32(clamp(ceil(chord / 1.5), 2.0, atmo.steps.y));
}

/** The fog of war's daytime colour: a light mist, independent of terrain shadows and material detail. */
const WAR_FOG_DAY = vec3f(0.65, 0.72, 0.79);
/** Night: the cool hue of the old fixed night colour (0.32, 0.37, 0.44) at unit luminance, lit like a dull grey surface. */
const WAR_FOG_NIGHT_HUE = vec3f(0.878, 1.015, 1.207);
/** Below the terrain's albedo, so under the same night light a hidden surface is always darker than a seen one. */
const WAR_FOG_NIGHT_ALBEDO: f32 = 0.2;

fn war_fog_dayness(p: vec3f) -> f32 { return smoothstep(-0.22, 0.35, dot(radial_up(p), frame.sun_dir)); }

/**
 * The fog at night: a matte grey lit by the real night light at p (the night-sky floor, the moonlit sky, the sky's
 * irradiance and the moon on normal n; no shadows). It follows the moon's phase and the dusk, and a seen face turned
 * away from the moon no longer shows as a dark hole in brighter fog.
 */
fn war_fog_night(p: vec3f, n: vec3f) -> vec3f {
  let up = radial_up(p);
  let l = frame.sun_dir;
  let lm = params.moon_dir.xyz;
  let night = 1.0 - day_factor(up, l);
  let night_rgb = select(params.night_tint.rgb, atmo.night.rgb, atmo_valid());
  let moon_rgb = params.moon.rgb * params.moon_dir.w;
  let moon_up = smoothstep(-0.05, 0.25, dot(up, lm));
  var e = night_rgb * (PI * params.shaping2.z * night * (params.shaping.y + params.shaping2.x));
  e += moon_rgb * (params.moon.w * night + max(dot(n, lm), 0.0)) * moon_up;
  if (sky_light_valid()) { e += sky_irradiance(p, up, up, l); }
  return WAR_FOG_NIGHT_HUE * (WAR_FOG_NIGHT_ALBEDO * INV_PI * dot(e, vec3f(0.2126, 0.7152, 0.0722)));
}

/** The fog's colour at p for a surface facing n: the day mist, fading into the lit night fog through dusk. */
fn war_fog_color(p: vec3f, n: vec3f) -> vec3f {
  let day = war_fog_dayness(p);
  if (day >= 0.999) { return WAR_FOG_DAY; }
  return mix(war_fog_night(p, n), WAR_FOG_DAY, day);
}

fn fog_enabled() -> bool { return fog_params.settings.x > 0.5 && sdf_valid(); }

/**
 * Volumetric war fog along a camera ray: the world visibility volume weighted by the atmosphere's density profile,
 * integrated from the atmosphere entry to t_max (the surface, or the atmosphere exit for sky rays). Jittered samples;
 * TAA converges them.
 */
fn war_fog_march(eye: vec3f, dir: vec3f, t_max: f32, xi: f32) -> vec4f {
  if (!fog_enabled()) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let air = atmo_ray_sphere(eye - frame.planet.xyz, dir, fog_params.volume.w);
  if (air.y <= 0.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let a = max(air.x, 0.0);
  let b = min(t_max, air.y);
  if (b <= a) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let chord = b - a;
  let n = u32(clamp(ceil(chord / 0.6), 3.0, fog_params.march.x));
  let dt = chord / f32(n);
  let shaft = 0.7 + 0.3 * pow(max(dot(dir, frame.sun_dir), 0.0), 4.0);
  let inv = 0.5 / fog_params.volume.y;
  var radiance = vec3f(0.0);
  var transmittance = 1.0;
  for (var i = 0u; i < n; i++) {
    let q = eye + dir * (a + (f32(i) + xi) * dt);
    let hidden = textureSampleLevel(fog_volume, atmo_lut_sampler, q * inv + 0.5, 0.0).r;
    if (hidden < 0.004) { continue; }
    let density = atmo_density(length(q - frame.planet.xyz)).x;
    let opacity = 1.0 - exp(-0.48 * density * hidden * dt);
    radiance += transmittance * war_fog_color(q, radial_up(q)) * (shaft * opacity);
    transmittance *= 1.0 - opacity;
  }
  return vec4f(radiance, transmittance);
}

/**
 * The coarse terrain is shaded as a smooth surface, but the SDF holds its flat triangles: at low light every triangle
 * edge can shadow its neighbour (the shadow terminator problem). World shadow traces on terrain therefore start from
 * a point lifted off the triangle as the smooth surface (shading normal n) approaches its own terminator, up to this
 * height, where the direct light is already weak. The gate on terrain is the shading normal's terminator alone. The
 * tank bricks trace from the unlifted point (they have no triangles to self-shadow).
 */
const TERRAIN_SHADOW_LIFT: f32 = 0.25;

/**
 * Along a valley crease the voxel field bridges over the rendered surface (the SDF distance view's red lines): a ray
 * starting there starts inside rock and reads as a dark fleck. Shadow traces step out to the field's surface first,
 * by this depth (the same for every light direction, so it is fetched once per pixel).
 */
fn terrain_shadow_inside(p: vec3f, smooth_terrain: bool) -> f32 {
  return select(0.0, max(-sdf_sample(p), 0.0), smooth_terrain);
}

fn terrain_shadow_origin(p: vec3f, n_light: vec3f, n: vec3f, dir: vec3f, smooth_terrain: bool, inside: f32) -> vec3f {
  let graze = select(0.0, 1.0 - smoothstep(0.1, 0.55, dot(n, dir)), smooth_terrain);
  return p + n_light * (TERRAIN_SHADOW_LIFT * graze + inside);
}

/** A lighting term switch (LIGHTING_TERM bits in params.debug.x). */
fn term_on(bit: u32) -> bool { return (u32(params.debug.x) & bit) != 0u; }

/** The exact signed distance to building box i (oriented). */
fn structure_box_distance(i: u32, q: vec3f) -> f32 {
  let c = params.structures[i * 4u];
  let a0 = params.structures[i * 4u + 1u]; let a1 = params.structures[i * 4u + 2u]; let a2 = params.structures[i * 4u + 3u];
  let d = q - c.xyz;
  let e = abs(vec3f(dot(d, a0.xyz), dot(d, a1.xyz), dot(d, a2.xyz))) - vec3f(a0.w, a1.w, a2.w);
  return length(max(e, vec3f(0.0))) + min(max(e.x, max(e.y, e.z)), 0.0);
}

/**
 * Sun and moon visibility (sdf_vis_dir_occ's soft cone, capped penumbra). The planet field holds buildings at voxel
 * resolution: rotated boxes came out with wavy edges and rounded corners. Near a building the trace therefore reads the
 * box's EXACT distance wherever the field agrees with it to within the snap tolerance; where they disagree (a crater
 * carved it, a collapse removed it, the terrain is nearer) the field stands. Everything not snapped to a box keeps the
 * facet tolerance against the low-poly terrain's shadow terminator; buildings get none, so their shadows keep their size.
 */
fn sky_trace(p: vec3f, l: vec3f, tan_a: f32, start: f32, max_steps: u32) -> f32 {
  // The few boxes whose bounding sphere the ray passes (most rays: none).
  var near = array<u32, 4>(0u, 0u, 0u, 0u);
  var count = 0u;
  for (var i = 0u; i < min(u32(params.structure_info.x), ${SHADOW_STRUCTURES_MAX}u) && count < 4u; i++) {
    let s = params.structures[i * 4u];
    let oc = s.xyz - p;
    let b = dot(oc, l);
    let reach = s.w + 0.3;
    if (b < -reach || dot(oc, oc) - b * b > reach * reach) { continue; }
    near[count] = i;
    count++;
  }
  let snap = params.structure_info.y;
  let w_max = ${SDF_PENUMBRA_MAX};
  let r2 = sdf_params.grid.z * sdf_params.grid.z;
  var t = start;
  var res = 1.0;
  var ph = 1e10;
  for (var i = 0u; i < max_steps; i++) {
    let q = p + l * t;
    if (dot(q, q) > r2 && dot(q, l) > 0.0) { break; }
    let raw = sdf_sample(q);
    var d = raw;
    var exact = 0.0;
    for (var k = 0u; k < count; k++) {
      let db = structure_box_distance(near[k], q);
      let w = 1.0 - smoothstep(0.5 * snap, snap, abs(raw - db));
      if (w > exact) { exact = w; d = mix(raw, db, w); }
    }
    let h = d + ${SDF_FACET_TOLERANCE} * (1.0 - exact);
    var r: f32;
    if (h > 0.0) {
      let y = select(0.0, h * h / (2.0 * ph), ph < 1e9);
      r = sqrt(max(h * h - y * y, 0.0)) / min(tan_a * max(t - y, 1e-4), w_max);
    } else {
      r = h / min(tan_a * max(t, 1e-3), w_max);
    }
    res = min(res, r);
    ph = max(h, 1e-4);
    if (res < -1.0) { break; }
    // Step on the smaller of the two distances: conservative either way.
    t += clamp(min(raw, d), 0.02, 4.0);
  }
  return sdf_penumbra(res);
}

/** Soft SDF sun/moon visibility at a receiver (terrain and structures). */
fn sdf_sky_light_vis(p: vec3f, ng: vec3f, l: vec3f, tan_a: f32, xi: f32) -> f32 {
  let v = sdf_voxel();
  return sky_trace(p + ng * (v * 0.75), l, tan_a, v * (0.4 + 0.6 * xi), u32(params.sdf_shadow.w));
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.scissor.z || gid.y >= params.scissor.w) { return; }
  let px = gid.xy + params.scissor.xy;
  let size = frame_internal_size();
  let uv = (vec2f(px) + 0.5) / size;
  let xi = pixel_noise(vec2f(px));
  let view_mode = u32(params.sun_disc.w);
  let ids = textureLoad(gb_ids, px, 0).r;
  if (gbuffer_class(ids) == CLASS_SKY) {
    if (interior_enabled()) {
      textureStore(hdr_out, px, vec4f(params.interior_background.rgb, 1.0));
      return;
    }
    let dir = world_dir_from_uv(uv);
    var fog = vec4f(0.0, 0.0, 0.0, 1.0);
    if (term_on(${LIGHTING_TERM.mist}u)) { fog = war_fog_march(frame.eye_pos, dir, 1e9, xi); }
    var sky = sky_radiance(dir, xi) * fog.w + fog.rgb;
    if (view_mode == 10u) { sky = vec3f(1.0 - fog.w) / max(frame.exposure, 1e-3); }
    textureStore(hdr_out, px, vec4f(sky, 1.0));
    return;
  }
  let depth = textureLoad(gb_depth, px, 0);
  let s = gbuffer_unpack(textureLoad(gb_albedo_ao, px, 0), textureLoad(gb_normals, px, 0), textureLoad(gb_material, px, 0), ids);
  let p = world_pos_from_depth(uv, depth);
  let to_eye = frame.eye_pos - p;
  let dist = length(to_eye);
  let v = to_eye / max(dist, 1e-6);
  let n = s.n_shading;
  let ng = s.n_geom;
  if (interior_enabled()) {
    textureStore(hdr_out, px, vec4f(interior_shade(s, p, v, px, dist), 1.0));
    return;
  }
  let l = frame.sun_dir;
  let up = radial_up(p);
  let two_sided = (s.flags & GB_FLAG_TWO_SIDED) != 0u;
  let receives = (s.flags & GB_FLAG_NO_SHADOW_RECEIVE) == 0u;

  // ── Sun: the soft SDF trace (static world) × the tank bricks; the three maps until the SDF exists ──
  // The normal light is gated and shadow-offset by: the geometric one (Pinionfall), except on the coarse terrain, whose
  // flat triangles would cut the light one facet at a time near grazing; there the smooth SDF normal, and the shadow
  // tests start from terrain_shadow_origin. Times a soft terminator on the shading normal.
  let smooth_terrain = (s.class_id == CLASS_TERRAIN || s.class_id == CLASS_GRASS) && sdf_valid();
  let n_light = select(ng, sdf_normal_smooth(p, 0.5, ng), smooth_terrain);
  let terminator = smoothstep(-0.12, 0.30, dot(n, l));
  // Terrain: the shading normal's terminator alone (it is smooth across whole triangles); elsewhere the geometric gate.
  // The planet's own horizon: on a miniature planet a hull 0.2 u up still sees a sun 8° below the local horizon, which
  // lit tank undersides (and their speculars) on a night-side ground. The sun sets for everything at once, as the moon.
  let sun_up = smoothstep(-0.06, 0.06, dot(up, l));
  let gate = select(select(smoothstep(-0.12, 0.24, dot(ng, l)), 1.0, smooth_terrain) * terminator, 1.0, two_sided) * sun_up;
  let veiled = s.class_id == CLASS_TERRAIN || s.class_id == CLASS_STRUCTURE || s.class_id == CLASS_ROCK ||
      s.class_id == CLASS_GRASS || s.class_id == CLASS_FOLIAGE || s.class_id == CLASS_WATER || (s.object_id & ${OBJECT_ID_VEIL}u) != 0u;
  let veil_on = veiled && fog_enabled() && (term_on(${LIGHTING_TERM.veil}u) || view_mode == 11u);
  var hidden = 0.0;
  if (veil_on) { hidden = select(0.0, textureLoad(fog_hidden, px, 0).r, term_on(${LIGHTING_TERM.veil}u)); }
  let veil_shades = veil_on && (hidden > 0.001 || view_mode == 11u);
  // Where the shading normal faces away from the sun its direct term and its shadowed ambient keep are exactly zero
  // (both scale by N·L): only the sun-lit veil and the shadow view still read the visibility there.
  let sun_read = dot(n, l) > 0.0 || view_mode == 1u || (veil_shades && dot(select(n, n_light, smooth_terrain), frame.sun_dir) > 0.0);
  var inside = -1.0;
  var vis = 1.0;
  if (gate > 0.0 && receives && sun_read) {
    if (sdf_valid()) {
      let vox = sdf_voxel();
      let off = n_light * (vox * 0.75);
      inside = terrain_shadow_inside(p, smooth_terrain);
      let ps = terrain_shadow_origin(p, n_light, n, l, smooth_terrain, inside) + off;
      if (term_on(${LIGHTING_TERM.sunShadows}u)) { vis = sky_trace(ps, l, params.sdf_shadow.x, vox * (0.4 + 0.6 * xi), u32(params.sdf_shadow.w)); }
      if (vis > 0.001 && term_on(${LIGHTING_TERM.casters}u)) { vis *= casters_vis_dir(p + off, l, params.sdf_shadow.x); }
    } else {
      vis = sun_shadow(p, ng, l, vec2f(px));
    }
    // A half-pixel blade cannot support a stable screen-space contact ray.
    // Grass still receives the full terrain and tank SDF shadows above.
    // Screen-space contact shadows only until the SDF exists: they see only what the camera sees, so they came and went
    // as the camera turned, and the exact traces above already resolve contact.
    if (vis > 0.001 && !sdf_valid() && sun_shadow_params.flags.w > 0.5 && s.class_id != CLASS_GRASS && s.class_id != CLASS_WATER) { vis *= contact_shadow(p, ng, l, dist, xi); }
  }
  let f0 = brdf_f0(s.base_color, s.metalness);
  let ndv = max(dot(n, v), 1e-3);
  var dfg = vec2f(1.0, 0.0);
  var e_comp = vec3f(1.0);
  if (sky_light_valid()) {
    dfg = sky_dfg(ndv, s.roughness);
    e_comp = brdf_energy_compensation(f0, dfg);
  }
  var direct = vec3f(0.0);
  if (gate * vis > 0.0 && dot(n, l) > 0.0) {
    let cloud_vis = lighting_cloud_shadow(p);
    if (gate * vis * cloud_vis > 0.0) {
      let sun_rgb = frame.sun_radiance * atmo_sun_color(p);
      direct = brdf_direct_ec(n, v, l, s.base_color, s.metalness, s.roughness, e_comp) * sun_rgb * (gate * vis * cloud_vis);
    }
  }
  // ── Moon: its own direction and phase, the sun's gates, and its own soft SDF visibility ──
  let lm = params.moon_dir.xyz;
  let moon_rgb = params.moon.rgb * params.moon_dir.w;
  let moon_up = smoothstep(-0.05, 0.25, dot(up, lm));
  let moon_gate = select(select(smoothstep(-0.12, 0.24, dot(ng, lm)), 1.0, smooth_terrain) * smoothstep(-0.12, 0.30, dot(n, lm)), 1.0, two_sided) * moon_up;
  var moon_light = 0.0;
  if (moon_gate > 0.0) {
    var moon_vis = 1.0;
    // Its direct term is the only reader besides the moon view, and it is exactly zero facing away (N·L).
    if (receives && sdf_valid() && dot(moon_rgb, moon_rgb) > 1e-6 && term_on(${LIGHTING_TERM.moonShadows}u) && (dot(n, lm) > 0.0 || view_mode == 12u)) {
      if (inside < 0.0) { inside = terrain_shadow_inside(p, smooth_terrain); }
      moon_vis = sdf_sky_light_vis(terrain_shadow_origin(p, n_light, n, lm, smooth_terrain, inside), n_light, lm, params.sdf_shadow.y, xi);
      if (moon_vis > 0.001 && term_on(${LIGHTING_TERM.casters}u)) { moon_vis *= casters_vis_dir(p + n_light * (sdf_voxel() * 0.75), lm, params.sdf_shadow.y); }
    }
    moon_light = moon_gate * moon_vis;
    direct += brdf_direct_ec(n, v, lm, s.base_color, s.metalness, s.roughness, e_comp) * moon_rgb * moon_light;
  }
  let count = min(light_list.header.x, MAX_LIGHTS);
  var local_direct = vec3f(0.0);
  var shadowed = 0u;
  let shadow_budget = u32(params.sdf_shadow.z);
  for (var i = 0u; i < count; i++) {
    let light = light_list.lights[i];
    let contribution = eval_light(light, p, n, v, s.base_color, s.metalness, s.roughness);
    if (dot(contribution, contribution) <= 0.0) { continue; }
    // Shadow-casting lights (shells, impacts, muzzle flashes): a soft trace toward the light through the SDF.
    var light_vis = 1.0;
    if ((light.params.y & LIGHT_FLAG_CAST_SHADOW) != 0u && receives && term_on(${LIGHTING_TERM.localShadows}u)) {
      if (sdf_valid() && shadowed < shadow_budget) {
        shadowed++;
        let vox = sdf_voxel();
        let lp = light.position_range.xyz;
        if (inside < 0.0) { inside = terrain_shadow_inside(p, smooth_terrain); }
        let lo = terrain_shadow_origin(p, n_light, n, normalize(lp - p), smooth_terrain, inside) + n_light * (vox * 0.75);
        light_vis = sdf_vis_point(lo, lp, light_penumbra(light), vox * (0.4 + 0.6 * xi), 40u);
      }
      // Tanks are not in the planet SDF: their bricks shadow the light too.
      if (light_vis > 0.001 && term_on(${LIGHTING_TERM.casters}u)) {
        light_vis *= casters_vis_point_emitter(p + n_light * (sdf_voxel() * 0.75), light.position_range.xyz, light_penumbra(light), light.params.w);
      }
    }
    local_direct += contribution * light_vis;
  }
  direct += local_direct;

  // ── Ambient: L1-SH sky irradiance × Pinionfall's shaped-hemisphere factors ──
  let sun_el = dot(up, l);
  let day = day_factor(up, l);
  let would_be_lit = smoothstep(0.0, 0.5, dot(n, l));
  let amb_sun = 1.0 - (1.0 - params.shaping.x) * (1.0 - vis) * would_be_lit * day;
  let hemi = 0.5 + 0.5 * dot(n, up);
  let hemi_shape = mix(params.shaping2.w, 1.0, hemi);
  let rim = max(dot(n, -l), 0.0);
  let term_w = clamp((1.0 - abs(sun_el)) * params.shaping2.y, 0.0, 1.0);
  let fill = (1.0 - day) * params.shaping2.x * mix(hemi, rim, term_w);
  let night_rgb = select(params.night_tint.rgb, atmo.night.rgb, atmo_valid());
  let e_night = night_rgb * PI * params.shaping2.z * (hemi_shape * (1.0 - day) * params.shaping.y + fill);
  // The moonlit sky: a soft share of the moon's light from above, so moon shadows are not black.
  let e_moon_sky = moon_rgb * params.moon.w * hemi_shape * (1.0 - day) * moon_up;
  var e_amb: vec3f;
  var spec_env: vec3f;
  var spec_w: vec3f;
  let r = reflect(-v, n);
  if (sky_light_valid()) {
    e_amb = sky_irradiance(p, n, up, l);
    // Probe GI: large-scale sky occlusion (crater floors, tunnels, building sides) and one bounce of sun and sky light.
    let gi = gi_sample(p, n);
    e_amb = e_amb * mix(1.0, gi.sky, params.gi.x * gi.confidence) + gi.bounce * (params.gi.y * gi.confidence);
    spec_env = sky_specular(p, r, up, s.roughness, l);
    spec_w = brdf_ibl_specular(f0, dfg, e_comp);
  } else {
    e_amb = params.fallback_horizon.w * hemi_shape * day * vec3f(0.85, 0.95, 1.2);
    let hh = dot(r, up);
    let sky = mix(params.fallback_horizon.rgb, params.fallback_zenith.rgb, smoothstep(-0.25, 0.85, hh));
    spec_env = mix(params.ground.rgb * (0.35 + 0.65 * day), sky, smoothstep(-0.15, 0.15, hh)) * mix(0.03, 1.0, day);
    spec_w = brdf_env_approx(f0, s.roughness, ndv);
  }
  let amb_scale = params.ground.w;
  let ambient_diffuse = brdf_diffuse_color(s.base_color, s.metalness) * (e_amb * amb_sun + e_night + e_moon_sky) * INV_PI * amb_scale;
  let ambient_specular = spec_env * spec_w * amb_sun * params.night_tint.w * amb_scale;

  // ── AO: ambient only ──
  ${aoSample}
  let ao = select(1.0, min(s.ao, ao_tex), params.sun_disc.z > 0.5);
  let so = brdf_specular_occlusion(ndv, ao, s.roughness);
  let emissive = s.base_color * s.emissive;
  var color = compose_lighting(direct, emissive, ambient_diffuse, ambient_specular, ao, so);

  // ── Aerial perspective (atmosphere entry or eye → pixel) ──
  let seg = atmo_integrate(frame.eye_pos, -v, dist, aerial_steps(frame.eye_pos, -v, dist), xi);
  color = color * seg.T + seg.L;
  var veil_shown = vec3f(0.0);
  // Concealed surfaces stay solid and legible through their shape, without their material. The hidden fraction is
  // the soft, world-anchored SDF visibility of this exact pixel (fog.surface).
  if (veil_on) {
    if (veil_shades) {
      // Sculpted fog: hidden relief keeps sun light and shadow, a moonlit term and AO, in the war-fog colour. On the
      // coarse terrain the smooth SDF normal keeps the facets from showing as a mosaic; buildings and rocks keep their
      // own flat faces. Terrain shape only: enemies the team cannot see are never drawn.
      let ns = select(n, n_light, smooth_terrain);
      let sun_lambert = max(dot(ns, frame.sun_dir), 0.0);
      var sun_term = 0.0;
      if (sun_lambert > 0.0) {
        // The pixel's own sun visibility where lighting evaluated it (map silhouettes); the SDF trace where it did not.
        var sun_vis = vis;
        if (!(gate > 0.0 && receives)) { sun_vis = sdf_sky_light_vis(p, ns, frame.sun_dir, params.sdf_shadow.x, xi); }
        sun_term = sun_lambert * sun_vis;
      }
      let moon_term = max(dot(ns, lm), 0.0) * moon_up * params.moon_dir.w;
      // By day the light mist is sculpted by sun, moon and AO; at night the fog is lit by the night light itself, on the
      // same smooth normal, so hidden relief keeps its moon shading without ever outshining what the team sees.
      let dayness = war_fog_dayness(p);
      let sculpt = (0.46 + 0.54 * min(sun_term + 0.6 * moon_term, 1.0)) * mix(1.0, ao, 0.9);
      var veil = WAR_FOG_DAY * sculpt;
      if (dayness < 0.999) { veil = mix(war_fog_night(p, ns) * mix(1.0, ao, 0.7), veil, dayness); }
      veil_shown = veil;
      color = mix(color, veil, hidden);
    }
  }
  var fog = vec4f(0.0, 0.0, 0.0, 1.0);
  if (term_on(${LIGHTING_TERM.mist}u)) { fog = war_fog_march(frame.eye_pos, -v, dist, xi); }
  color = color * fog.w + fog.rgb;
  if (view_mode == 1u) { color = vec3f(vis * gate); }
  if (view_mode == 2u) { color = direct + emissive; }
  if (view_mode == 3u) { color = ambient_diffuse * ao + ambient_specular * so; }
  // Planet SDF term views, scaled by 1/exposure so 1.0 reads as white: AO, GI (bounce in colour over the sky
  // visibility in grey), the surface fog-of-war hidden fraction, and the soft SDF sun visibility alone.
  let unit = 1.0 / max(frame.exposure, 1e-3);
  if (view_mode == 4u) { color = vec3f(ao) * unit; }
  if (view_mode == 5u) { let g = gi_sample(p, n); color = (vec3f(g.sky * 0.35) + g.bounce * 0.3) * unit; }
  if (view_mode == 6u) { color = vec3f(select(0.0, textureLoad(fog_hidden, px, 0).r, fog_enabled())) * unit; }
  if (view_mode == 7u) { color = vec3f(select(1.0, sdf_sky_light_vis(p, ng, l, params.sdf_shadow.x, xi), sdf_valid())) * unit; }
  // Isolation views for the ?dev panel: the GI terms apart, the mist's opacity, the veil colour on every veiled
  // surface, the moon's gated visibility, the punctual lights, and the SDF distance at the rendered surface (black on a
  // surface the SDF holds; grey outside, red inside, saturating at 2 voxels: a mismatch or an object not in the SDF).
  if (view_mode == 8u) { color = vec3f(gi_sample(p, n).sky) * unit; }
  if (view_mode == 9u) { color = gi_sample(p, n).bounce * (0.6 * unit); }
  if (view_mode == 10u) { color = vec3f(1.0 - fog.w) * unit; }
  if (view_mode == 11u) { color = veil_shown; }
  if (view_mode == 12u) { color = vec3f(moon_light) * unit; }
  if (view_mode == 13u) { color = local_direct; }
  if (view_mode == 14u) {
    let d = select(0.0, sdf_sample(p), sdf_valid());
    let t = clamp(abs(d) / (2.0 * sdf_voxel()), 0.0, 1.0);
    color = select(vec3f(t), vec3f(t, 0.15 * t, 0.1 * t), d < 0.0) * unit;
  }
  textureStore(hdr_out, px, vec4f(color, 1.0));
}
`, [frameWgsl, depthWgsl, gbufferWgsl, brdfWgsl, radialWgsl, lightsWgsl, lightingComposeWgsl, LIGHTING_PARAMS.module, interiorLightingWgsl,
    FOG_PARAMS.module, fogParamsBindingWgsl(1, 8), bd.sdf, sdfWgsl, ...giModules, o.casters === false ? castersAbsentWgsl : sdfCastersWgsl(1, 12, 13),
    atmosphereFnWgsl, atmosphereSkyViewWgsl, bd.atmo, shadowSampleWgsl, bd.shadows, SKY_LIGHT_PARAMS.module, skyLightFnWgsl, bd.sky, bd.clouds]);
}

export const lightingShaderWgsl = buildLightingShader({ ao: true });
