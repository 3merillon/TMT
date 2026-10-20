// Ported from Pinionfall src/gpu/glass-shader.ts (MIT, same owner)
/**
 * BRDF: GGX NDF + Smith height-correlated visibility + Schlick Fresnel (Pinionfall `glass_ggx_spec`, generalised to a
 * coloured F0), Burley diffuse. Every lobe returns BRDF × N·L; multiply by the light's radiance.
 * Not ported: the Blinn-Phong deferred BRDF (plan §13 rule 7). W1-ENG-LOOK added the split-sum IBL helpers, multi-scatter
 * energy compensation and specular occlusion; W2-LIGHT extends it (clearcoat, anisotropy, specular AA).
 */
import { makeModule } from '../module';
import { mathWgsl } from './constants.wgsl';

export const MIN_ROUGHNESS = 0.045;

export const brdfWgsl = makeModule('brdf', /* wgsl */ `
const BRDF_MIN_ROUGHNESS: f32 = ${MIN_ROUGHNESS};

fn brdf_alpha(roughness: f32) -> f32 {
  let r = max(roughness, BRDF_MIN_ROUGHNESS);
  return r * r;
}

fn brdf_f_schlick(f0: vec3f, vdh: f32) -> vec3f {
  let f = pow(clamp(1.0 - vdh, 0.0, 1.0), 5.0);
  return f0 + (vec3f(1.0) - f0) * f;
}

/** Schlick with a roughness-damped grazing term, for ambient/environment specular. */
fn brdf_f_schlick_roughness(f0: vec3f, ndv: f32, roughness: f32) -> vec3f {
  let f = pow(clamp(1.0 - ndv, 0.0, 1.0), 5.0);
  return f0 + (max(vec3f(1.0 - roughness), f0) - f0) * f;
}

/** Split-sum environment BRDF, analytic fit (Karis, "Physically Based Shading on Mobile"): F0·A + B. */
fn brdf_env_approx(f0: vec3f, roughness: f32, ndv: f32) -> vec3f {
  let r = roughness * vec4f(-1.0, -0.0275, -0.572, 0.022) + vec4f(1.0, 0.0425, 1.04, -0.04);
  let a004 = min(r.x * r.x, exp2(-9.28 * ndv)) * r.x + r.y;
  let ab = vec2f(-1.04, 1.04) * a004 + r.zw;
  return f0 * ab.x + ab.y;
}

fn brdf_d_ggx(ndh: f32, a2: f32) -> f32 {
  let dd = ndh * ndh * (a2 - 1.0) + 1.0;
  return a2 / (PI * dd * dd);
}

/** Smith height-correlated visibility V = G / (4 N·L N·V). */
fn brdf_v_smith_hc(ndv: f32, ndl: f32, a2: f32) -> f32 {
  return 0.5 / max(ndl * sqrt(ndv * ndv * (1.0 - a2) + a2) + ndv * sqrt(ndl * ndl * (1.0 - a2) + a2), 1e-4);
}

/** GGX specular × N·L. */
fn brdf_ggx_spec(n: vec3f, v: vec3f, l: vec3f, roughness: f32, f0: vec3f) -> vec3f {
  let hv = l + v;
  let h = hv * inverseSqrt(max(dot(hv, hv), 1e-8));
  let ndl = max(dot(n, l), 0.0);
  let ndv = max(dot(n, v), 1e-3);
  let ndh = max(dot(n, h), 0.0);
  let vdh = max(dot(v, h), 0.0);
  let a = brdf_alpha(roughness);
  let a2 = a * a;
  return brdf_d_ggx(ndh, a2) * brdf_v_smith_hc(ndv, ndl, a2) * brdf_f_schlick(f0, vdh) * ndl;
}

/** Burley (Disney) diffuse × N·L, for albedo 1 (multiply by the diffuse colour). */
fn brdf_burley(n: vec3f, v: vec3f, l: vec3f, roughness: f32) -> f32 {
  let ndl = max(dot(n, l), 0.0);
  let ndv = max(dot(n, v), 1e-3);
  let hv = l + v;
  let h = hv * inverseSqrt(max(dot(hv, hv), 1e-8));
  let ldh = max(dot(l, h), 0.0);
  let fd90 = 0.5 + 2.0 * roughness * ldh * ldh;
  let fl = 1.0 + (fd90 - 1.0) * pow(1.0 - ndl, 5.0);
  let fv = 1.0 + (fd90 - 1.0) * pow(1.0 - ndv, 5.0);
  return fl * fv * ndl * INV_PI;
}

fn brdf_f0(base_color: vec3f, metalness: f32) -> vec3f { return mix(vec3f(0.04), base_color, metalness); }
fn brdf_diffuse_color(base_color: vec3f, metalness: f32) -> vec3f { return base_color * (1.0 - metalness); }

/** Direct light from one direction: diffuse + specular, × N·L (multiply by radiance). */
fn brdf_direct(n: vec3f, v: vec3f, l: vec3f, base_color: vec3f, metalness: f32, roughness: f32) -> vec3f {
  let diffuse = brdf_diffuse_color(base_color, metalness) * brdf_burley(n, v, l, roughness);
  return diffuse + brdf_ggx_spec(n, v, l, roughness, brdf_f0(base_color, metalness));
}

// ── W1-ENG-LOOK additions: split-sum IBL with a DFG LUT and multi-scatter energy compensation ──

/**
 * Multi-scatter energy compensation (Fdez-Agüera 2019 / Karis): single-scatter GGX loses energy at high roughness;
 * scale the specular lobe by 1 + F0·(1/(A + B) − 1), with (A, B) the split-sum DFG terms at (N·V, roughness).
 */
fn brdf_energy_compensation(f0: vec3f, dfg: vec2f) -> vec3f {
  return vec3f(1.0) + f0 * (1.0 / max(dfg.x + dfg.y, 1e-3) - 1.0);
}

/** Direct light with the specular lobe energy-compensated (multiply by radiance). */
fn brdf_direct_ec(n: vec3f, v: vec3f, l: vec3f, base_color: vec3f, metalness: f32, roughness: f32, energy: vec3f) -> vec3f {
  let diffuse = brdf_diffuse_color(base_color, metalness) * brdf_burley(n, v, l, roughness);
  return diffuse + brdf_ggx_spec(n, v, l, roughness, brdf_f0(base_color, metalness)) * energy;
}

/** Split-sum specular IBL weight F0·A + B, energy-compensated. */
fn brdf_ibl_specular(f0: vec3f, dfg: vec2f, energy: vec3f) -> vec3f {
  return (f0 * dfg.x + vec3f(dfg.y)) * energy;
}

/** Specular occlusion from ambient occlusion (Lagarde & de Rousiers 2014). */
fn brdf_specular_occlusion(ndv: f32, ao: f32, roughness: f32) -> f32 {
  return clamp(pow(ndv + ao, exp2(-16.0 * roughness - 1.0)) - 1.0 + ao, 0.0, 1.0);
}

/** Hammersley point i of n (Van der Corput radical inverse in base 2). */
fn brdf_hammersley(i: u32, n: u32) -> vec2f {
  var b = (i << 16u) | (i >> 16u);
  b = ((b & 0x55555555u) << 1u) | ((b & 0xAAAAAAAAu) >> 1u);
  b = ((b & 0x33333333u) << 2u) | ((b & 0xCCCCCCCCu) >> 2u);
  b = ((b & 0x0F0F0F0Fu) << 4u) | ((b & 0xF0F0F0F0u) >> 4u);
  b = ((b & 0x00FF00FFu) << 8u) | ((b & 0xFF00FF00u) >> 8u);
  return vec2f(f32(i) / f32(n), f32(b) * 2.3283064365386963e-10);
}

/** GGX importance sample of the half vector around n (alpha = roughness²). */
fn brdf_importance_ggx(xi: vec2f, n: vec3f, roughness: f32) -> vec3f {
  let a = brdf_alpha(roughness);
  let phi = TAU * xi.x;
  let cos_t = sqrt((1.0 - xi.y) / (1.0 + (a * a - 1.0) * xi.y));
  let sin_t = sqrt(max(1.0 - cos_t * cos_t, 0.0));
  let hl = vec3f(cos(phi) * sin_t, sin(phi) * sin_t, cos_t);
  let up = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(n.z) < 0.999);
  let tx = normalize(cross(up, n));
  let ty = cross(n, tx);
  return normalize(tx * hl.x + ty * hl.y + n * hl.z);
}
`, [mathWgsl]);

/** TS mirror of brdf_energy_compensation (tests). */
export function brdfEnergyCompensation(f0: number, a: number, b: number): number {
  return 1 + f0 * (1 / Math.max(a + b, 1e-3) - 1);
}
