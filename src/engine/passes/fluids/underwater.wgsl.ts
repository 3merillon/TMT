import { makeModule } from '../../wgsl/module';

/** Linked into the liquid composite; uses its live water atlas and lighting bindings. */
export const waterOpticsWgsl = makeModule('water-optics', /* wgsl */ `
// n_water / n_air. The critical angle is asin(1 / 1.333), about 48.6 degrees.
const WATER_IOR = 1.333;
fn water_fresnel(cos_i: f32, eta: f32) -> f32 {
  let c = clamp(cos_i, 0.0, 1.0);
  let sin_t2 = eta * eta * (1.0 - c * c);
  if (sin_t2 >= 1.0) { return 1.0; }
  let ct = sqrt(1.0 - sin_t2);
  let rs = (eta * c - ct) / max(eta * c + ct, 1e-6);
  let rp = (c - eta * ct) / max(c + eta * ct, 1e-6);
  return 0.5 * (rs * rs + rp * rp);
}
`);

export const underwaterWgsl = makeModule('underwater', /* wgsl */ `

/** x surface radius (including swell), y bed, z water depth, w signed height. */
fn water_column(p: vec3f) -> vec4f {
  let a = liq_bilerp(liq_atlas, liq_atlas_px(p));
  let swell = w_swell(normalize(p) * a.x, liq.info.y, liq.swell.x).x * w_swell_share(max(a.z, 0.0), a.w);
  let level = a.x + swell;
  return vec4f(level, a.y, a.z, length(p) - level);
}
fn water_contains(p: vec3f) -> bool {
  let a = water_column(p);
  return a.x > 0.0 && a.z > liq.lava.z && a.w < 0.0 && length(p) > a.y - 0.03;
}

/** Supplement rasterisation where the water crosses the near plane. */
fn water_near_hit(eye: vec3f, dir: vec3f, submerged: bool) -> f32 {
  let a = water_column(eye);
  if (a.z <= liq.lava.z || a.x <= 0.0 || (!submerged && abs(a.w) > 0.3)) { return -1.0; }
  let b = dot(eye, dir);
  let disc = b * b - dot(eye, eye) + a.x * a.x;
  if (disc < 0.0) { return -1.0; }
  var t = select(-b - sqrt(disc), -b + sqrt(disc), submerged);
  if (t < 0.0 || t > 50.0) { return -1.0; }
  for (var k = 0u; k < 10u; k++) {
    let p = eye + dir * t;
    let h = water_column(p).w;
    let slope = dot(normalize(p), dir);
    if (abs(slope) < 0.025) { break; }
    t = max(0.0001, t - clamp(h / slope, -0.5, 0.5));
  }
  let end = water_column(eye + dir * t);
  if (end.z <= liq.lava.z || abs(end.w) > 0.015) { return -1.0; }
  return t;
}

/** Remove the air segment already applied to opaque G-buffer radiance. */
fn water_scene_radiance(rgb: vec3f, p: vec3f, xi: f32) -> vec3f {
  let delta = p - frame.eye_pos;
  let dist = length(delta);
  let dir = delta / max(dist, 1e-5);
  let air = atmo_integrate(frame.eye_pos, dir, dist, aerial_steps(frame.eye_pos, dir, dist), xi);
  return max((rgb - air.L) / max(air.T, vec3f(0.05)), vec3f(0.0));
}

/** Six stratified samples of single scattering, with terrain shadows and depth attenuation. */
fn water_volume(rgb: vec3f, origin: vec3f, dir: vec3f, distance: f32, xi: f32) -> vec3f {
  let dist = clamp(distance, 0.0, 40.0);
  let sigma_s = vec3f(0.065, 0.095, 0.11);
  let sigma = liq.water.rgb + sigma_s;
  let dt = dist / 6.0;
  let step_T = exp(-sigma * dt);
  var T = vec3f(1.0);
  var L = vec3f(0.0);
  let g = 0.65;
  let mu = dot(dir, frame.sun_dir);
  let phase = (1.0 - g * g) / (4.0 * PI * pow(max(1.0 + g * g - 2.0 * g * mu, 0.05), 1.5));
  for (var i = 0u; i < 6u; i++) {
    let p = origin + dir * ((f32(i) + 0.35 + xi * 0.3) * dt);
    let col = water_column(p);
    let up = normalize(p);
    let light_depth = max(0.0, -col.w) / max(dot(up, frame.sun_dir), 0.15);
    let cache = liq_bilerp(liq_cache, liq_atlas_px(p));
    var sun = cache.x * smoothstep(-0.05, 0.15, dot(up, frame.sun_dir));
    if (sun > 0.01) { sun *= sdf_vis_dir(p, frame.sun_dir, 0.0, sdf_voxel(), 12u); }
    let direct = frame.sun_radiance * atmo_sun_color(p) * sun * exp(-sigma * light_depth) * phase;
    let ambient = liq_light_up(up * col.x, up, 0.0, cache.y, cache.z) * liq.deep.rgb * INV_PI * exp(-sigma * max(-col.w, 0.0) * 0.5);
    L += T * (1.0 - step_T) * sigma_s / sigma * (direct + ambient);
    T *= step_T;
  }
  return rgb * T + L;
}

/** Reflected/refracted opaque geometry when present in the current G-buffer. */
fn water_trace_scene(origin: vec3f, ray: vec3f, in_water: bool, xi: f32) -> vec4f {
  let size = frame_internal_size();
  var previous = 0.025;
  for (var i = 0u; i < 28u; i++) {
    let t = 0.035 + f32(i + 1u) * f32(i + 1u) * 0.027;
    let p = origin + ray * t;
    let clip = frame.view_proj * vec4f(p, 1.0);
    if (clip.w <= 0.0) { previous = t; continue; }
    let uv = ndc_to_uv(clip.xy / clip.w);
    if (any(uv <= vec2f(0.0)) || any(uv >= vec2f(1.0))) { previous = t; continue; }
    let px = vec2i(uv * size);
    let depth = textureLoad(gb_depth, px, 0);
    if (depth > 0.0) {
      let delta = clip.w - linear_depth(depth);
      let q = world_pos_from_depth(uv, depth);
      if (delta > 0.0 && delta < 0.06 + (t - previous) && distance(q, origin) > 0.04 && water_contains(q) == in_water) {
        var color = water_scene_radiance(textureLoad(liq_hdr, px, 0).rgb, q, xi);
        if (in_water) { color = water_volume(color, origin, ray, distance(q, origin), xi); }
        return vec4f(color, 1.0);
      }
    }
    previous = t;
  }
  return vec4f(0.0);
}

fn water_under_surface(p: vec3f, normal: vec3f, dir: vec3f, xi: f32) -> vec3f {
  // Orient the micro-normal toward the air, and prevent grazing chop from
  // pointing the transmitted ray back into water.
  let n = normalize(mix(normalize(p), normal, smoothstep(0.02, 0.16, dot(dir, normalize(p)))));
  let fresnel = water_fresnel(max(dot(dir, n), 0.0), WATER_IOR);
  let reflected = reflect(dir, -n);
  var bounce = water_volume(vec3f(0.0), p - n * 0.01, reflected, 25.0, xi);
  let reflected_hit = water_trace_scene(p - n * 0.015, reflected, true, xi);
  if (reflected_hit.a > 0.5) { bounce = reflected_hit.rgb; }
  var transmitted = vec3f(0.0);
  if (fresnel < 0.9999) {
    let refracted = refract(dir, -n, WATER_IOR);
    transmitted = sky_radiance(refracted, xi);
    let hit = water_trace_scene(p + n * 0.015, refracted, false, xi);
    if (hit.a > 0.5) { transmitted = hit.rgb; }
  }
  return mix(transmitted, bounce, fresnel);
}
`, [waterOpticsWgsl]);
