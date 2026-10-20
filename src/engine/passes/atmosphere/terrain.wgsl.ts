/** Live air/rock support for world-space atmosphere consumers. LUTs retain an analytic reference body. */
import { makeModule } from '../../wgsl/module';
import { frameWgsl } from '../../wgsl/common/frame.wgsl';
import { sdfWgsl } from '../sdf/sdf.wgsl';
import { sunClassLookupWgsl } from './sun-class';

export const atmosphereTerrainFallbackWgsl = makeModule('atmosphere-terrain-fallback', /* wgsl */ `
fn atmo_live_terrain() -> bool { return false; }
fn atmo_air(p: vec3f) -> f32 { return 1.0; }
fn atmo_terrain_lit(p: vec3f, sun: vec3f, fallback: f32) -> f32 { return fallback; }
`);

const terrainWgsl = (classes: string) => /* wgsl */ `
fn atmo_live_terrain() -> bool { return sdf_valid(); }
fn atmo_air(p: vec3f) -> f32 {
  if (!sdf_valid()) { return 1.0; }
  return smoothstep(-sdf_voxel() * 0.5, sdf_voxel() * 0.5, sdf_sample(p));
}
fn atmo_terrain_lit(p: vec3f, sun: vec3f, fallback: f32) -> f32 {
  if (!sdf_valid()) { return fallback; }${classes}
  // Clip to the actual terrain cube. Marching to its circumsphere wastes most sky-ray samples outside the field.
  let inv = sign(sun + vec3f(1e-20)) / max(abs(sun), vec3f(1e-8));
  let a = (-vec3f(sdf_params.grid.z) - p) * inv;
  let b = (vec3f(sdf_params.grid.z) - p) * inv;
  let lo = min(a, b); let hi = max(a, b);
  var t = max(0.04, max(lo.x, max(lo.y, lo.z)));
  let end = min(hi.x, min(hi.y, hi.z));
  var visibility = 1.0;
  for (var i = 0u; i < 48u; i++) {
    if (t > end) { return visibility; }
    let q = p + sun * t;
    let d = sdf_sample(q);
    if (d < 0.0) { return 0.0; }
    visibility = min(visibility, d / max(t * 0.035, 0.025));
    t += clamp(d, 0.08, 4.0);
  }
  // No unverified light leaking through a cut wall on trace exhaustion.
  return 0.0;
}
`;

export const atmosphereTerrainWgsl = makeModule('atmosphere-terrain', terrainWgsl(''), [sdfWgsl]);

/**
 * The same functions answered from the sun classes (sun-class.ts) where the start cell is certain, for this frame's sun
 * only; the march above everywhere else. Looking classes up again along the march to stop it early cost more than it
 * saved in every measured view. Needs `sun_class` at the given binding.
 */
export function atmosphereTerrainClassifiedWgsl(group: number, binding: number) {
  return makeModule(`atmosphere-terrain-classified:${group}:${binding}`, terrainWgsl(/* wgsl */ `
  if (all(sun == frame.sun_dir)) {
    let class_bits = sun_class_at(p);
    if ((class_bits & SUN_CLASS_AERIAL_LIT) != 0u) { return 1.0; }
    if ((class_bits & SUN_CLASS_AERIAL_DARK) != 0u && sun_class_dark_valid()) { return 0.0; }
  }`), [frameWgsl, sdfWgsl, sunClassLookupWgsl(group, binding)]);
}
