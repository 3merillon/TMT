import { makeModule } from '../../wgsl/module';
import { INTERIOR_MAX_OCCLUDERS } from '../../scene/interior';

/** Linked into the deferred lighting shader. Uses its G-buffer, light list and dynamic caster bricks. */
export const interiorLightingWgsl = makeModule('interior-lighting', /* wgsl */ `
fn interior_enabled() -> bool { return params.interior_ambient.w > 0.5; }

/** Exact finite segment/slab test. Parallel rays are handled explicitly (no Inf/NaN at room boundaries). */
fn interior_box_hit(origin: vec3f, end: vec3f, lo: vec3f, hi: vec3f) -> bool {
  let delta = end - origin;
  var entry = 0.0001;
  var exit = 0.9999;
  for (var axis = 0u; axis < 3u; axis++) {
    if (abs(delta[axis]) < 1e-7) {
      if (origin[axis] < lo[axis] || origin[axis] > hi[axis]) { return false; }
    } else {
      let a = (lo[axis] - origin[axis]) / delta[axis];
      let b = (hi[axis] - origin[axis]) / delta[axis];
      entry = max(entry, min(a, b));
      exit = min(exit, max(a, b));
      if (exit < entry) { return false; }
    }
  }
  return exit >= entry;
}

/** Analytic rotor aperture. This approximates blade shadows; the visible rotor is an independently authored mesh. */
fn interior_fan_visibility(origin: vec3f, end: vec3f) -> f32 {
  let fan = params.interior_fan;
  if (fan.w <= 0.0 || abs(end.z - origin.z) < 1e-6) { return 0.0; }
  let t = (fan.z - origin.z) / (end.z - origin.z);
  if (t < 0.0 || t > 1.0) { return 0.0; }
  let radial = mix(origin, end, t).xy - fan.xy;
  let r = length(radial);
  if (r < 0.26 || r > fan.w) { return 0.0; }
  let phase = atan2(radial.y, radial.x) - params.interior_fan_control.x - 1.5707963 - 0.13 * r / fan.w;
  let gap = smoothstep(0.48, 0.63, abs(sin(phase * params.interior_fan_control.y * 0.5)));
  return gap * (1.0 - smoothstep(fan.w - 0.06, fan.w, r));
}

fn interior_room_visibility(origin: vec3f, end: vec3f) -> f32 {
  let count = min(u32(params.interior_background.w), ${INTERIOR_MAX_OCCLUDERS}u);
  var visibility = 1.0;
  for (var i = 0u; i < count; i++) {
    if (interior_box_hit(origin, end, params.interior_boxes[2u * i].xyz, params.interior_boxes[2u * i + 1u].xyz)) {
      if (params.interior_boxes[2u * i].w > 0.5) {
        visibility *= interior_fan_visibility(origin, end);
        if (visibility > 0.001) { continue; }
      }
      return 0.0;
    }
  }
  return visibility;
}

/** Small, stable screen-space contact occlusion for the lift and assembly creases. Ambient terms only. */
fn interior_contact_ao(p: vec3f, n: vec3f, px: vec2u, eye_distance: f32) -> f32 {
  let size = vec2i(frame_internal_size());
  let radius_px = clamp(0.24 * f32(size.y) * frame.proj[1][1] / max(eye_distance, 0.5), 3.0, 38.0);
  var occlusion = 0.0;
  for (var i = 0u; i < 8u; i++) {
    let angle = f32(i) * 2.39996323;
    let offset = vec2f(cos(angle), sin(angle)) * (radius_px * (0.35 + 0.65 * f32(i) / 7.0));
    let qpx = clamp(vec2i(vec2f(px) + offset), vec2i(0), size - vec2i(1));
    let depth = textureLoad(gb_depth, qpx, 0);
    if (depth <= 0.0) { continue; }
    let q = world_pos_from_depth((vec2f(qpx) + 0.5) / vec2f(size), depth);
    let delta = q - p;
    let d = length(delta);
    let facing = max(dot(n, delta / max(d, 1e-4)) - 0.16, 0.0);
    occlusion += facing * (1.0 - smoothstep(0.06, 0.55, d));
  }
  return clamp(1.0 - occlusion * 0.22, 0.4, 1.0);
}

/** Only local lamps illuminate an interior. The planetary sun, moon, sky, GI and atmosphere are never sampled. */
fn interior_shade(s: SurfaceSample, p: vec3f, v: vec3f, px: vec2u, dist: f32) -> vec3f {
  let n = s.n_shading;
  let ndv = max(dot(n, v), 1e-3);
  let origin = p + s.n_geom * 0.018;
  let receives = (s.flags & GB_FLAG_NO_SHADOW_RECEIVE) == 0u;
  let count = min(light_list.header.x, MAX_LIGHTS);
  var direct = vec3f(0.0);
  var shadowed = 0u;
  for (var i = 0u; i < count; i++) {
    let light = light_list.lights[i];
    let contribution = eval_light(light, p, n, v, s.base_color, s.metalness, s.roughness);
    if (dot(contribution, contribution) <= 0.0) { continue; }
    // Room structure ALWAYS blocks lamps, including lights that opt out of expensive dynamic caster shadows.
    var visibility = interior_room_visibility(origin, light.position_range.xyz);
    if (visibility > 0.001 && receives && (light.params.y & LIGHT_FLAG_CAST_SHADOW) != 0u && shadowed < u32(params.sdf_shadow.z)) {
      shadowed++;
      visibility *= casters_vis_point(origin, light.position_range.xyz, vec3f(0.045, 0.04, 0.32));
    }
    direct += contribution * visibility;
  }
  let hemi = 0.58 + 0.42 * max(n.y, 0.0);
  let diffuse = brdf_diffuse_color(s.base_color, s.metalness) * params.interior_ambient.rgb * (hemi * INV_PI);
  let f0 = brdf_f0(s.base_color, s.metalness);
  let reflected = reflect(-v, n);
  var specular = params.interior_ambient.rgb * (0.12 + 0.24 * max(reflected.y, 0.0)) * brdf_env_approx(f0, s.roughness, ndv);
  if (params.interior_probe.w > 0.5) {
    // Box projection corrects probe parallax near the workbench/walls; reflection directions remain
    // Cartesian rather than receiving the planet renderer's radial-up rotation.
    let box_min = params.interior_probe_min.xyz;
    let box_max = params.interior_probe_max.xyz;
    let safe_r = select(vec3f(-1.0), vec3f(1.0), reflected >= vec3f(0.0)) * max(abs(reflected), vec3f(1e-5));
    let intersections = max((box_min - p) / safe_r, (box_max - p) / safe_r);
    let distance_to_box = max(0.0, min(intersections.x, min(intersections.y, intersections.z)));
    let inside = all(p >= box_min) && all(p <= box_max);
    let direction = select(reflected, p + reflected * distance_to_box - params.interior_probe.xyz, inside);
    let lod = clamp(s.roughness, 0.0, 1.0) * (params.interior_probe.w - 1.0);
    let radiance = textureSampleLevel(sky_light_cube, atmo_lut_sampler, direction, lod).rgb;
    let dfg = textureSampleLevel(sky_light_atlas, atmo_lut_sampler,
      vec2f(clamp(ndv * 32.0, 0.5, 31.5) / 128.0, clamp(s.roughness * 32.0, 0.5, 31.5) / 32.0), 0.0).rg;
    specular = radiance * (f0 * dfg.x + vec3f(dfg.y)) * params.interior_probe_min.w;
  }
  var ao = 1.0;
  if (params.sun_disc.z > 0.5) { ao = s.ao * interior_contact_ao(p, n, px, dist); }
  var color = compose_lighting(direct, s.base_color * s.emissive, diffuse, specular, ao, brdf_specular_occlusion(ndv, ao, s.roughness));
  if ((s.flags & GB_FLAG_SELECTED) != 0u) {
    let size = vec2i(frame_internal_size());
    var edge = 0.0;
    for (var i = 0u; i < 4u; i++) {
      let angle = f32(i) * 1.57079633;
      let qpx = clamp(vec2i(px) + vec2i(round(vec2f(cos(angle), sin(angle)) * 2.0)), vec2i(0), size - vec2i(1));
      if ((gbuffer_flags(textureLoad(gb_ids, qpx, 0).r) & GB_FLAG_SELECTED) == 0u) { edge = 1.0; }
    }
    // Cool, luminous edges stay distinct from every available tank paint, including ochre.
    // Keep the face treatment subtle so inspection still reveals the original material.
    let rim = pow(1.0 - ndv, 3.0);
    color = mix(color, vec3f(0.08, 1.15, 1.65), 0.04 + rim * 0.28);
    color = mix(color, vec3f(0.45, 2.5, 3.2), edge * 0.9);
  }
  let extinction = max(params.interior_fog.w, 0.0);
  let transmittance = exp(-dist * extinction);
  var fog = params.interior_fog.rgb;
  // A few integration samples of the first four spot lamps give restrained, wall-occluded light shafts.
  // Point lights contribute surface lighting; only deliberately authored spotlights produce volumetrics.
  if (extinction > 0.0) {
    for (var j = 0u; j < min(count, 4u); j++) {
      let light = light_list.lights[j];
      if (light.params.x != LIGHT_TYPE_SPOT) { continue; }
      var shaft = vec3f(0.0);
      let cones = unpack_cone_cosines(light.params.z);
      for (var step = 0u; step < 4u; step++) {
        let q = mix(frame.eye_pos, p, (f32(step) + 0.5) / 4.0);
        let delta = q - light.position_range.xyz;
        let dd = max(dot(delta, delta), 0.01);
        let angular = spot_falloff(delta * inverseSqrt(dd), light.direction.xyz, cones.x, cones.y);
        if (angular <= 0.0 || dd > light.position_range.w * light.position_range.w) { continue; }
        shaft += light.color_intensity.rgb * (light_attenuation(dd, light.position_range.w) * angular * interior_room_visibility(q, light.position_range.xyz));
      }
      fog += shaft * 0.035;
    }
  }
  color = color * transmittance + fog * (1.0 - transmittance);
  // Light traverses the actual back-wall opening. Opaque room solids still cut each sampled shaft.
  // Eight view-ray samples are bounded by the first surface, so beams never overlay foreground objects.
  if (params.interior_fan_light.w > 0.0) {
    var scatter = 0.0;
    for (var i = 0u; i < 8u; i++) {
      let q = mix(frame.eye_pos, p, (f32(i) + 0.5) / 8.0);
      if (q.z <= params.interior_fan.z || interior_fan_visibility(q, params.interior_fan_light.xyz) <= 0.001) { continue; }
      let delta = q - params.interior_fan_light.xyz;
      let attenuation = light_attenuation(max(dot(delta, delta), 1.0), 19.0);
      let dust = 0.88 + 0.12 * sin(q.x * 4.1 + q.y * 5.3 + q.z * 2.7 + params.interior_fan_control.x * 0.4);
      scatter += attenuation * interior_room_visibility(q, params.interior_fan_light.xyz) * dust;
    }
    color += vec3f(0.45, 0.65, 0.82) * (scatter * params.interior_fan_light.w * dist / 8.0 * 0.006);
  }
  let view_mode = u32(params.sun_disc.w);
  if (view_mode == 2u || view_mode == 13u) { color = direct; }
  if (view_mode == 3u) { color = (diffuse + specular) * ao; }
  if (view_mode == 4u) { color = vec3f(ao) / max(frame.exposure, 1e-3); }
  return color;
}
`);
