// Ported from Pinionfall src/gpu/shared-terrain-wgsl.ts (MIT, same owner) — aerial_for_body (~812–1036) → atmo_integrate;
// ray_transmittance from src/gpu/sky-shader.ts; LUT parameterisations from src/gpu/atmosphere-lut-shader.ts.
/**
 * The atmosphere functions every consumer shares (lighting: sky pixels + aerial perspective + per-pixel sun colour; the
 * sky-light builders; the LUT kernels). One density function (`atmo_density`), one integrator (`atmo_integrate`).
 *
 * The functions reference module-scope globals that each consumer declares at its own group/binding with
 * `atmosphereBindingsWgsl(...)`: `atmo` (AtmosphereParams), `atmo_transmittance_lut`, `atmo_multiscatter_lut`,
 * `atmo_sky_view_lut` (optional: only `atmo_sky_view_*` use it) and `atmo_lut_sampler` (filtering, clamp).
 *
 * Changes from Pinionfall (plan §13 / atmo-post §2.5–2.6): absolute radii; the march starts at the soft-shell entry so a
 * camera in space integrates only the in-air chord; jittered sample offsets (converged by TAA); a multiscatter term; the
 * sunset grade applied to every sun term. World consumers use live terrain visibility and rendered scene depth;
 * reference LUT builders use the analytic body at atmo.ground.w. Neither path clips view integration to an inner core.
 */
import { makeModule } from '../../wgsl/module';
import { mathWgsl } from '../../wgsl/common/constants.wgsl';
import { ATMOSPHERE_PARAMS } from './params';
import { atmosphereTerrainFallbackWgsl, atmosphereTerrainWgsl } from './terrain.wgsl';

export const atmosphereFnWgsl = makeModule('atmosphere', /* wgsl */ `
struct AtmoSeg { L: vec3f, T: vec3f }

fn atmo_valid() -> bool { return atmo.sun.w > 0.5; }
fn atmo_ground_radius() -> f32 { return atmo.rayleigh.w; }
fn atmo_top_radius() -> f32 { return atmo.mie.w; }
fn atmo_soft_radius() -> f32 { return atmo.heights.w; }
fn atmo_sun_dir() -> vec3f { return atmo.sun.xyz; }
fn atmo_sun_illuminance() -> f32 { return atmo.heights.z; }

/** Closest-approach ray/sphere (stable at large |ro|): (t_near, t_far), or (-1, -1) on a miss. */
fn atmo_ray_sphere(ro: vec3f, rd: vec3f, radius: f32) -> vec2f {
  let b = dot(ro, rd);
  let qc = ro - b * rd;
  let disc = radius * radius - dot(qc, qc);
  if (disc < 0.0) { return vec2f(-1.0); }
  let s = sqrt(disc);
  return vec2f(-b - s, -b + s);
}

/** THE density profile (x Rayleigh, y Mie), relative to the ground density. Every kernel uses this one function. */
fn atmo_density(r: f32) -> vec2f {
  let h = r - atmo.rayleigh.w;
  // Excavated terrain can expose the interior. Continue the profile smoothly through the surface instead of
  // holding ground density all the way through the planet, which appears as a hard opaque inner sphere.
  let below = exp(-max(-h, 0.0) / max(atmo.heights.x * 2.5, 0.1));
  let outer = 1.0 - smoothstep(atmo.mie.w, atmo.heights.w, r);
  return vec2f(exp(-max(h, 0.0) / atmo.heights.x), exp(-max(h, 0.0) / atmo.heights.y)) * below * outer;
}

fn atmo_extinction(d: vec2f) -> vec3f { return atmo.rayleigh.rgb * d.x + vec3f((atmo.mie.x + atmo.mie.y) * d.y); }
fn atmo_scattering(d: vec2f) -> vec3f { return atmo.rayleigh.rgb * d.x + vec3f(atmo.mie.x * d.y); }

fn atmo_phase_rayleigh(c: f32) -> f32 { return 3.0 / (16.0 * PI) * (1.0 + c * c); }
fn atmo_phase_mie(c: f32) -> f32 {
  let g = atmo.mie.z;
  let g2 = g * g;
  let denom = 1.0 + g2 - 2.0 * g * c;
  return (1.0 - g2) / (4.0 * PI * denom * sqrt(max(denom, 1e-6)));
}

/** CPU sunset grade (world/sun.ts): mix(tint, 1, smoothstep(0, start, cos_sun)). */
fn sunset_grade(cos_sun: f32) -> vec3f {
  return mix(atmo.sunset.rgb, vec3f(1.0), smoothstep(0.0, max(atmo.sunset.w, 1e-4), cos_sun));
}

/** Transmittance LUT: u = sqrt(h / h_range) (dense near the ground), v = (cos + 1) / 2. */
fn atmo_transmittance_uv(h: f32, cos_zenith: f32) -> vec2f {
  let h_range = atmo.mie.w - atmo.rayleigh.w;
  return vec2f(sqrt(clamp(h / h_range, 0.0, 1.0)), clamp((cos_zenith + 1.0) * 0.5, 0.0, 1.0));
}
fn atmo_transmittance(h: f32, cos_zenith: f32) -> vec3f {
  return textureSampleLevel(atmo_transmittance_lut, atmo_lut_sampler, atmo_transmittance_uv(h, cos_zenith), 0.0).rgb;
}
/** Multiscatter LUT (per unit sun illuminance), same parameterisation. */
fn atmo_multiscatter(h: f32, cos_sun: f32) -> vec3f {
  return textureSampleLevel(atmo_multiscatter_lut, atmo_lut_sampler, atmo_transmittance_uv(h, cos_sun), 0.0).rgb;
}

/**
 * Per-pixel sun colour at a world point (× frame.sun_radiance): transmittance LUT toward the sun × the sunset grade.
 * Returns 1 when the atmosphere is not provided (placeholder params).
 */
fn atmo_sun_color(p: vec3f) -> vec3f {
  if (!atmo_valid()) { return vec3f(1.0); }
  let r = length(p);
  let cos_sun = dot(p / max(r, 1e-4), atmo.sun.xyz);
  return atmo_sun_transmittance(p, atmo.sun.xyz) * sunset_grade(cos_sun);
}

/** The reference LUT assumes an intact sphere. Integrate the air column for rays exposed by excavation. */
fn atmo_sun_transmittance(p: vec3f, sun: vec3f) -> vec3f {
  let r = length(p);
  let cos_s = dot(p, sun) / max(r, 1e-4);
  let solid = atmo_ray_sphere(p, sun, atmo.ground.w);
  if (!atmo_live_terrain() || (r >= atmo.ground.w && solid.y <= 0.0)) {
    return atmo_transmittance(r - atmo.rayleigh.w, cos_s);
  }
  let chord = atmo_ray_sphere(p, sun, atmo_soft_radius());
  let start = max(chord.x, 0.0);
  let step = max(chord.y - start, 0.0) / 12.0;
  var tau = vec3f(0.0);
  for (var i = 0u; i < 12u; i++) {
    let q = p + sun * (start + (f32(i) + 0.5) * step);
    tau += atmo_extinction(atmo_density(length(q))) * step;
  }
  return exp(-tau);
}

/**
 * Directional source transmittance from an eye in or out of the air. World consumers test actual terrain first and
 * integrate exposed air columns where the reference LUT's intact body would conceal an excavation. LUT consumers
 * retain the analytic-body horizon and shell-entry lookup.
 */
fn atmo_ray_transmittance(eye: vec3f, dir: vec3f) -> vec3f {
  if (atmo_live_terrain()) {
    let lit = atmo_terrain_lit(eye, dir, 1.0);
    if (lit <= 0.0) { return vec3f(0.0); }
    return atmo_sun_transmittance(eye, dir) * lit;
  }
  let r_ground = atmo.rayleigh.w;
  let r_top = atmo.mie.w;
  let r_eye = max(length(eye), r_ground + 1e-3);
  let up = eye / r_eye;
  let cz = dot(dir, up);
  let d_perp = r_eye * sqrt(max(1.0 - cz * cz, 0.0));
  if (cz < 0.0 && d_perp < atmo.ground.w) { return vec3f(0.0); }
  if (r_eye <= r_top) { return atmo_transmittance(r_eye - r_ground, cz); }
  if (cz >= 0.0 || d_perp >= r_top) { return vec3f(1.0); }
  let b = r_eye * cz;
  let t_entry = -b - sqrt(max(r_top * r_top - d_perp * d_perp, 0.0));
  let mu_entry = (b + t_entry) / r_top;
  return textureSampleLevel(atmo_transmittance_lut, atmo_lut_sampler, vec2f(1.0, clamp((mu_entry + 1.0) * 0.5, 0.0, 1.0)), 0.0).rgb;
}

/**
 * In-scattered radiance L and transmittance T along ro + t·rd for t ∈ [0, t_max] (t_max = 1e9 for sky), clipped to the
 * soft shell. Density remains continuous below the reference ground radius so excavated terrain never exposes an
 * inner atmosphere shell. n uniform segments (sky 16–24, geometry 12), sample offset xi ∈ [0, 1) per
 * pixel (TAA converges it). World visibility follows the live SDF; reference LUTs use the analytic per-segment umbra.
 * The sun column uses the transmittance LUT where applicable and integrates exposed deep air where it is not.
 * Both direct and multiscatter sunlight carry visibility and the sunset grade; blocked air retains extinction.
 * Units: L is radiance for sun illuminance atmo.heights.z.
 */
fn atmo_integrate(ro: vec3f, rd: vec3f, t_max: f32, n: u32, xi: f32) -> AtmoSeg {
  return atmo_integrate_sun(ro, rd, atmo.sun.xyz, t_max, n, xi);
}

/** atmo_integrate with an explicit sun direction (the sky-view LUT kernel integrates in the observer's local frame). */
fn atmo_integrate_sun(ro: vec3f, rd: vec3f, sun: vec3f, t_max: f32, n: u32, xi: f32) -> AtmoSeg {
  var out: AtmoSeg;
  out.L = vec3f(0.0);
  out.T = vec3f(1.0);
  if (!atmo_valid() || n == 0u) { return out; }
  let soft_r = atmo.heights.w;
  let hit = atmo_ray_sphere(ro, rd, soft_r);
  if (hit.y <= 0.0) { return out; }
  let t0 = max(hit.x, 0.0);
  var t1 = min(hit.y, t_max);
  // Scene depth is the only solid bound. A reference sphere or core would conceal destroyed terrain.
  let dist = t1 - t0;
  if (dist <= 1e-4) { return out; }

  let cos_sv = dot(rd, sun);
  let ph_r = atmo_phase_rayleigh(cos_sv);
  let ph_m = atmo_phase_mie(cos_sv);
  // Mie tail fade: chords that only graze the soft band must not paint the camera-dependent forward lobe.
  let t_ca = max(-dot(ro, rd), 0.0);
  let ca = length(ro + rd * t_ca);
  let tail_fade = 1.0 - smoothstep(atmo.mie.w, soft_r, ca);

  // Reference LUT/fallback umbra: overlap with the nominal body's shadow cylinder (soft inner/outer penumbra radii),
  // intersected with the behind-planet half space. rel(t) = ro + t·rd; proj = uc0 + t·uc1 along the sun.
  let occ = atmo.ground.w;
  let uc0 = dot(ro, sun);
  let uc1 = cos_sv;
  let qa = max(1.0 - uc1 * uc1, 0.0);
  let qb = 2.0 * (dot(ro, rd) - uc0 * uc1);
  let e2c = dot(ro, ro) - uc0 * uc0;
  var bh_lo = -3.0e38;
  var bh_hi = 3.0e38;
  if (abs(uc1) < 1e-7) {
    if (uc0 >= 0.0) { bh_lo = 3.0e38; bh_hi = -3.0e38; }
  } else if (uc1 > 0.0) {
    bh_hi = -uc0 / uc1;
  } else {
    bh_lo = -uc0 / uc1;
  }
  let pen = occ * 0.02;
  var in_lo = 1.0; var in_hi = 0.0;
  var out_lo = 1.0; var out_hi = 0.0;
  {
    let r_in = occ - pen;
    let r_out = occ + pen;
    if (qa < 1e-7) {
      if (e2c < r_in * r_in) { in_lo = bh_lo; in_hi = bh_hi; }
      if (e2c < r_out * r_out) { out_lo = bh_lo; out_hi = bh_hi; }
    } else {
      let inv2a = 0.5 / qa;
      let d_in = qb * qb - 4.0 * qa * (e2c - r_in * r_in);
      if (d_in > 0.0) { let s = sqrt(d_in); in_lo = max((-qb - s) * inv2a, bh_lo); in_hi = min((-qb + s) * inv2a, bh_hi); }
      let d_out = qb * qb - 4.0 * qa * (e2c - r_out * r_out);
      if (d_out > 0.0) { let s = sqrt(d_out); out_lo = max((-qb - s) * inv2a, bh_lo); out_hi = min((-qb + s) * inv2a, bh_hi); }
    }
  }

  let seg = dist / f32(n);
  let e_sun = atmo.heights.z;
  let ad = atmo.fade.w;
  for (var i = 0u; i < n; i++) {
    let ts = t0 + (f32(i) + xi) * seg;
    let p = ro + rd * ts;
    let r = length(p);
    let h = r - atmo.rayleigh.w;
    let d = atmo_density(r) * ad * atmo_air(p);
    if (max(d.x, d.y) < 1e-6) { continue; }
    let s_r = atmo.rayleigh.rgb * d.x;
    let s_m = atmo.mie.x * d.y;
    let ext = s_r + vec3f((atmo.mie.x + atmo.mie.y) * d.y);
    let seg_t = exp(-ext * seg);
    let cos_s = dot(p / max(r, 1e-4), sun);
    let sa = t0 + f32(i) * seg;
    let sb = sa + seg;
    let ov_in = max(0.0, min(sb, in_hi) - max(sa, in_lo));
    let ov_out = max(0.0, min(sb, out_hi) - max(sa, out_lo));
    let lit = atmo_terrain_lit(p, sun, 1.0 - clamp((ov_in + ov_out) * 0.5 / seg, 0.0, 1.0));
    // A shadowed air segment still extinguishes the view, but cannot scatter sunlight.
    // In particular, do not integrate twelve more sun-column samples behind an opaque wall.
    if (lit <= 0.0) { out.T *= seg_t; continue; }
    let grade = sunset_grade(cos_s);
    let t_sun = atmo_sun_transmittance(p, sun) * grade * lit;
    // The reference multiscatter LUT remains approximate; actual terrain visibility gates both sun terms.
    let ms = atmo_multiscatter(h, cos_s) * grade * lit;
    let scatter = s_r * ph_r + vec3f(s_m * ph_m * tail_fade);
    let integrand = (t_sun * scatter + (s_r + vec3f(s_m)) * ms) * e_sun;
    out.L += out.T * integrand * (vec3f(1.0) - seg_t) / max(ext, vec3f(1e-8));
    out.T *= seg_t;
  }
  return out;
}

/** Sun horizontal direction at an observer (Pinionfall's pole-free fallback when the sun is at the zenith/nadir). */
fn atmo_sun_horizontal(up: vec3f, sun: vec3f) -> vec3f {
  let raw = sun - up * dot(sun, up);
  if (dot(raw, raw) > 1e-8) { return normalize(raw); }
  let alt = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(up.x) > 0.9);
  return normalize(cross(up, alt));
}

/** Azimuth of dir around up relative to the sun horizontal, as u ∈ [0, 1). */
fn atmo_sky_view_u(dir: vec3f, up: vec3f, sun_h: vec3f) -> f32 {
  let horiz = dir - up * dot(dir, up);
  let hl = length(horiz);
  if (hl < 1e-4) { return 0.0; }
  let hn = horiz / hl;
  var az = atan2(dot(cross(sun_h, hn), up), dot(hn, sun_h));
  if (az < 0.0) { az += TAU; }
  return az / TAU;
}

/** Horizon-anchored sqrt row mapping (Pinionfall sky-view LUT): v = 0.5 at the horizon, 1 at the zenith, 0 at the nadir. */
fn atmo_sky_view_v(cos_vz: f32, cos_horizon: f32) -> f32 {
  if (cos_vz >= cos_horizon) {
    return 0.5 + 0.5 * sqrt(clamp((cos_vz - cos_horizon) / max(1.0 - cos_horizon, 1e-6), 0.0, 1.0));
  }
  return 0.5 - 0.5 * sqrt(clamp((cos_horizon - cos_vz) / max(1.0 + cos_horizon, 1e-6), 0.0, 1.0));
}
`, [ATMOSPHERE_PARAMS.module, mathWgsl]);

/** Sky-view sampling (needs `atmo_sky_view_lut`): the real observer LUT (left half) or the diorama LUT (right half). */
export const atmosphereSkyViewWgsl = makeModule('atmosphere-sky-view', /* wgsl */ `
/** uv inside one LUT → uv in the double-width texture; half 0 = real camera observer, 1 = diorama observer. */
fn atmo_sky_view_sample(uv: vec2f, half_index: u32) -> vec3f {
  let w = atmo.lut.z;
  let u = (clamp(uv.x, 0.0, 1.0) * (w - 1.0) + 0.5) / w; // keep the bilinear footprint inside one half
  let x = (u + f32(half_index)) * 0.5;
  return textureSampleLevel(atmo_sky_view_lut, atmo_lut_sampler, vec2f(x, clamp(uv.y, 0.0, 1.0)), 0.0).rgb;
}
`, [atmosphereFnWgsl]);

/** Declarations of the globals `atmosphereFnWgsl` references, at the consumer's group/bindings. */
export function atmosphereBindingsWgsl(group: number, b: { params: number; transmittance: number; multiscatter: number; skyView?: number; sampler: number }, terrain = false) {
  const lines = [
    `@group(${group}) @binding(${b.params}) var<uniform> atmo: AtmosphereParams;`,
    `@group(${group}) @binding(${b.transmittance}) var atmo_transmittance_lut: texture_2d<f32>;`,
    `@group(${group}) @binding(${b.multiscatter}) var atmo_multiscatter_lut: texture_2d<f32>;`,
    ...(b.skyView !== undefined ? [`@group(${group}) @binding(${b.skyView}) var atmo_sky_view_lut: texture_2d<f32>;`] : []),
    `@group(${group}) @binding(${b.sampler}) var atmo_lut_sampler: sampler;`,
  ];
  return makeModule(`atmosphere-bindings:${group}:${b.params},${b.transmittance},${b.multiscatter},${b.skyView ?? '-'},${b.sampler}:${terrain}`, lines.join('\n'), [ATMOSPHERE_PARAMS.module, terrain ? atmosphereTerrainWgsl : atmosphereTerrainFallbackWgsl]);
}
