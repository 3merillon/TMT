/** World-space, depth-clipped haze. Inspired by Planets evaluate_punctual_volumetric;
 * TMT uses its existing SDF / dynamic caster bricks rather than Planets' metre-scale shadow atlas. */
import { makeModule, link, wgslStruct } from '../../wgsl/module';
import { depthWgsl } from '../../wgsl/common/depth.wgsl';
import { lightsWgsl } from '../../scene/lights';
import { sdfBindingsWgsl, sdfWgsl } from '../sdf/sdf.wgsl';
import { sdfCastersWgsl } from '../sdf/sdf-casters';
import { fogParamsBindingWgsl } from '../fog-of-war/fog.wgsl';
import { fullscreenWgsl } from '../../gpu/fullscreen';
import { CLOUD_PARAMS } from '../clouds/params';
import { cloudShadowSampleWgsl } from '../clouds/shadow.wgsl';
import { sunClassLookupWgsl } from '../atmosphere/sun-class';
import { punctualVolumeWgsl } from './punctual.wgsl';
import { volumeLocalQuadratureWgsl } from './local-quadrature';

export const VOLUME_PARAMS = wgslStruct('VolumeParams', [
  ['quality', 'vec4f'], // march steps, local lights per ray, sun trace steps, enabled
  ['medium', 'vec4f'], // extinction, height, sun gain, local gain
  ['tint', 'vec4f'], // haze scattering tint, max distance
]);

/** Invocations per pixel; @group(1) binding of the sun classes in the classified variant. */
export const VOLUME_PIXEL_LANES = 2;
export const VOLUME_SUN_CLASS_BINDING = 14;

/**
 * Each pixel's sun and punctual samples are split over VOLUME_PIXEL_LANES invocations and summed by the first in the
 * original order through workgroup memory, and every invocation runs all its world traces before its brick traces.
 * A few pixels in headlight beams otherwise serialised hundreds of nested, divergent traces per warp.
 */
function volumeTrace(classified: boolean) {
  const lanes = VOLUME_PIXEL_LANES, perLane = Math.ceil(16 / lanes);
  return makeModule(classified ? 'volumetrics-trace-classified' : 'volumetrics-trace', /* wgsl */ `
@group(1) @binding(0) var vol_depth: texture_depth_2d;
@group(1) @binding(1) var vol_out: texture_storage_2d<rgba16float, write>;
@group(1) @binding(2) var distance_out: texture_storage_2d<r32float, write>;
@group(1) @binding(3) var<uniform> vp: VolumeParams;
@group(1) @binding(7) var<storage, read> light_list: LightList;
@group(1) @binding(10) var visibility_volume: texture_3d<f32>;
@group(1) @binding(12) var cloud_shadow_cube: texture_cube<f32>;
@group(1) @binding(13) var<uniform> cloud_params: CloudParams;

const VOLUME_LANES: u32 = ${lanes}u;
// 64 pixels × 16 samples × rgb: sun visibilities (28 per pixel) or one light's incident radiance per round.
var<workgroup> volume_share: array<f32, 3072>;
var<workgroup> volume_rounds: atomic<u32>;
var<workgroup> volume_rounds_uniform: u32;

fn volume_sphere(ro: vec3f, rd: vec3f, radius: f32) -> vec2f {
  let b = dot(ro, rd); let q = ro - b * rd;
  let h = radius * radius - dot(q, q);
  if (h < 0.0) { return vec2f(1.0, -1.0); }
  let d = sqrt(h); return vec2f(-b - d, -b + d);
}
fn volume_phase(mu: f32, g: f32) -> f32 {
  return punctual_phase(mu,g);
}
fn volume_seen(p: vec3f) -> f32 {
  return punctual_seen(visibility_volume,p);
}
/** No surface offset: these samples are AIR, and pushing them can cross a wall. */
fn volume_sun_visible(p: vec3f) -> f32 {${classified ? `
  let class_bits = sun_class_at(p);
  if ((class_bits & SUN_CLASS_HAZE_LIT) != 0u && ((class_bits >> 8u) & 255u) < u32(vp.quality.z)) { return 1.0; }
  if ((class_bits & SUN_CLASS_HAZE_DARK) != 0u && sun_class_dark_valid()) { return 0.0; }` : ''}
  var t = 0.025;
  for (var i = 0u; i < u32(vp.quality.z); i++) {
    let q = p + frame.sun_dir * t;
    if (length(q) > sdf_params.grid.z && dot(q, frame.sun_dir) > 0.0) { return 1.0; }
    let d = sdf_sample(q);
    if (d < 0.015) { return 0.0; }
    t += clamp(d * 0.85, 0.02, 4.0);
  }
  // An exhausted trace is unknown, never an invented light leak.
  return 0.0;
}
fn volume_local_visible(p: vec3f, source: vec3f) -> f32 {
  return punctual_world_visible(p,source);
}

@compute @workgroup_size(8, 8, ${lanes})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let size = textureDimensions(vol_out);
  let inside = all(gid.xy < size);
  let pixel = lid.x + lid.y * 8u;
  let lead = lid.z == 0u;
  let uv = (vec2f(gid.xy) + 0.5) / vec2f(size);
  let px = min(vec2u(uv * frame_internal_size()), vec2u(frame_internal_size()) - 1u);
  let depth = textureLoad(vol_depth, px, 0);
  let rd = world_dir_from_uv(uv); let eye = frame.eye_pos;
  var end = vp.tint.w;
  if (depth > 0.0) { end = min(end, length(world_pos_from_depth(uv, depth) - eye)); }
  if (inside && lead) { textureStore(distance_out, gid.xy, vec4f(end)); }
  let air = volume_sphere(eye - frame.planet.xyz, rd, frame.planet.w + vp.medium.y * 4.0);
  let begin = max(air.x, 0.0); end = min(end, air.y);
  // No early returns: every invocation reaches the workgroup barriers.
  let live = inside && vp.quality.w >= 0.5 && sdf_valid() && end > begin;

  // Retain actual finite cone/range intervals. Moving unrelated background depth
  // cannot stretch their sampling lattice across the rest of the atmosphere.
  var selected: array<u32, 8>; var scores: array<f32, 8>;var intervals:array<vec2f,8>;
  let budget = min(u32(vp.quality.y), 8u);
  if (live && vp.medium.w > 0.0) {
    for (var j = 0u; j < min(light_list.header.x, MAX_LIGHTS); j++) {
      let l = light_list.lights[j];
      if ((l.params.y & 1u) == 0u || l.position_range.w <= 0.0) { continue; }
      var span=volume_light_interval(eye-l.position_range.xyz,rd,l.direction.xyz,l.position_range.w,
        unpack_cone_cosines(l.params.z).y,l.params.x==LIGHT_TYPE_SPOT,vec2f(begin,end));
      if(span.y<=span.x){continue;}
      let near = clamp(dot(l.position_range.xyz - eye, rd), span.x, span.y);
      let delta = l.position_range.xyz - (eye + rd * near);
      let d2 = dot(delta, delta); let range = l.position_range.w;
      if (d2 >= range*range || volume_seen(l.position_range.xyz) < 0.95) { continue; }
      var score = max(l.color_intensity.r, max(l.color_intensity.g, l.color_intensity.b)) / max(0.2, d2);
      var index = j;
      for (var k = 0u; k < budget; k++) {
        if (score > scores[k]) { let old = scores[k]; let old_index = selected[k];let old_span=intervals[k]; scores[k] = score; selected[k] = index;intervals[k]=span; score = old; index = old_index;span=old_span; }
      }
    }
  }
  let steps = max(1u, u32(vp.quality.x)); let ds = (end - begin) / f32(steps);
  var transmittance = 1.0; var radiance = vec3f(0.0);
  var optical_depth:array<f32,29>;

  // Sun: each invocation traces its share of the steps (-2 rock, -1 no sunlight, else the sun visibility)…
  if (live) {
    for (var i = lid.z; i < steps; i += VOLUME_LANES) {
      let q = eye + rd * (begin + (f32(i) + 0.5) * ds);
      var shared_vis = -2.0;
      if (sdf_sample(q) > 0.02) {
        shared_vis = -1.0;
        let altitude = length(q - frame.planet.xyz) - frame.planet.w;
        let density = exp(-max(altitude, 0.0) / vp.medium.y);
        let sigma = vp.medium.x * density;
        let opacity = 1.0 - exp(-sigma * ds);
        if (vp.medium.z > 0.0 && opacity > 0.00001) {
          // The cloud shadow first: the binary trace cannot change a product with an exact zero.
          let cloud = cloud_shadow_visibility(cloud_shadow_cube, sdf_sampler, cloud_params, q);
          var vis = 0.0;
          if (cloud > 0.0) { vis = volume_sun_visible(q) * cloud; }
          if (vis > 0.0) { shared_vis = vis * casters_vis_dir(q, frame.sun_dir, 0.025); }
        }
      }
      volume_share[pixel * 28u + i] = shared_vis;
    }
  }
  workgroupBarrier();
  // …and the first sums them in order.
  if (live && lead) {
    for (var i = 0u; i < steps; i++) {
      optical_depth[i+1u]=optical_depth[i];
      let shared_vis = volume_share[pixel * 28u + i];
      if (shared_vis < -1.5) { continue; }
      let q = eye + rd * (begin + (f32(i) + 0.5) * ds);
      let altitude = length(q - frame.planet.xyz) - frame.planet.w;
      // Datum controls falloff, not solidity: excavated air remains a scattering medium.
      // The live SDF above rejects actual rock, including after pending cuts and deep terrain edits.
      let density = exp(-max(altitude, 0.0) / vp.medium.y);
      let sigma = vp.medium.x * density;
      optical_depth[i+1u]+=sigma*ds;
      let opacity = 1.0 - exp(-sigma * ds);
      var incident = vec3f(0.0);
      if (shared_vis >= 0.0) {
        let sun_vis = shared_vis;
        let mu = dot(normalize(q - frame.planet.xyz), frame.sun_dir);
        let tint = mix(vec3f(1.0, 0.42, 0.16), vec3f(1.0, 0.97, 0.90), smoothstep(-0.08, 0.3, mu));
        incident += frame.sun_radiance * tint * (sun_vis * volume_phase(dot(rd, frame.sun_dir), 0.58) * vp.medium.z);
      }
      radiance += transmittance * opacity * incident * vp.tint.rgb;
      transmittance *= 1.0 - opacity;
    }
  }
  workgroupBarrier();

  // Punctual lights, one round per light slot that any pixel of the workgroup uses.
  if (live && lead) {
    var used = 0u;
    for (var k = 0u; k < budget; k++) { if (scores[k] > 0.0) { used++; } }
    atomicMax(&volume_rounds, used);
  }
  workgroupBarrier();
  if (pixel == 0u && lead) { volume_rounds_uniform = atomicLoad(&volume_rounds); }
  let rounds = workgroupUniformLoad(&volume_rounds_uniform);
  let local_steps=max(8u,u32(vp.quality.x*0.6));
  for (var k = 0u; k < rounds; k++) {
    let has = live && scores[k] > 0.0;
    if (has) {
      let l=light_list.lights[selected[k]];let origin=eye-l.position_range.xyz;
      let c = unpack_cone_cosines(l.params.z);
      var visibility: array<f32, ${perLane}>; var seen_at: array<f32, ${perLane}>; var cone_at: array<f32, ${perLane}>;
      // World traces of this invocation's samples (the cheap range and cone tests before any fetch)…
      var n = 0u;
      for (var i = lid.z; i < local_steps; i += VOLUME_LANES) {
        let s = n; n++;
        visibility[s] = -1.0;
        let quadrature=volume_light_sample(origin,rd,intervals[k],i,local_steps);
        let q=eye+rd*quadrature.x;
        let to_light = l.position_range.xyz - q;
        let d2 = dot(to_light, to_light); let range = l.position_range.w;
        if (d2 >= range*range || d2 < 0.0001) { continue; }
        let ld = to_light * inverseSqrt(d2); var cone = 1.0;
        if (l.params.x == LIGHT_TYPE_SPOT) { cone = spot_falloff(-ld, l.direction.xyz, c.x, c.y); }
        if (cone <= 0.0) { continue; }
        if(sdf_sample(q)<=0.02){continue;}
        let seen=volume_seen(q);if(seen<=0.05){continue;}
        // Volumetrics always require actual world/tank occlusion, including a source without the surface shadow flag.
        seen_at[s] = seen; cone_at[s] = cone;
        visibility[s] = volume_local_visible(q, l.position_range.xyz);
      }
      // …then their brick traces…
      n = 0u;
      for (var i = lid.z; i < local_steps; i += VOLUME_LANES) {
        let s = n; n++;
        if (visibility[s] > 0.001) {
          let q = eye + rd * volume_light_sample(origin,rd,intervals[k],i,local_steps).x;
          visibility[s] *= casters_vis_point_emitter(q, l.position_range.xyz, vec3f(0.025, 0.015, 0.10), l.params.w);
        }
      }
      // …and their incident radiance for the first invocation (r < 0: no contribution).
      n = 0u;
      for (var i = lid.z; i < local_steps; i += VOLUME_LANES) {
        let s = n; n++;
        let slot = (pixel * 16u + i) * 3u;
        volume_share[slot] = -1.0;
        if (visibility[s] < 0.0) { continue; }
        let q = eye + rd * volume_light_sample(origin,rd,intervals[k],i,local_steps).x;
        let to_light = l.position_range.xyz - q;
        let d2 = dot(to_light, to_light); let range = l.position_range.w;
        let ld = to_light * inverseSqrt(d2);
        let attenuation = light_attenuation(max(d2, 0.09), range);
        let incident=min(l.color_intensity.rgb * attenuation, vec3f(30.0)) * (cone_at[s] * visibility[s] * seen_at[s] * volume_phase(dot(rd, ld), 0.25) * vp.medium.w);
        volume_share[slot] = incident.r; volume_share[slot + 1u] = incident.g; volume_share[slot + 2u] = incident.b;
      }
    }
    workgroupBarrier();
    if (has && lead) {
      let l=light_list.lights[selected[k]];let origin=eye-l.position_range.xyz;
      for(var i=0u;i<local_steps;i++){
        let slot = (pixel * 16u + i) * 3u;
        if (volume_share[slot] < 0.0) { continue; }
        let incident = vec3f(volume_share[slot], volume_share[slot + 1u], volume_share[slot + 2u]);
        let quadrature=volume_light_sample(origin,rd,intervals[k],i,local_steps);
        let q=eye+rd*quadrature.x;
        let cell=clamp((quadrature.x-begin)/ds,0.0,f32(steps));let index=min(u32(cell),steps-1u);
        let tau=mix(optical_depth[index],optical_depth[index+1u],cell-f32(index));
        let density=exp(-max(length(q-frame.planet.xyz)-frame.planet.w,0.0)/vp.medium.y);
        radiance+=exp(-tau)*(vp.medium.x*density*quadrature.y)*incident*vp.tint.rgb;
      }
    }
    workgroupBarrier();
  }
  if (inside && lead) {
    if (!live) { textureStore(vol_out, gid.xy, vec4f(0.0)); }
    else {
      let safe = min(select(radiance, vec3f(0.0), radiance != radiance), vec3f(12.0));
      textureStore(vol_out, gid.xy, vec4f(safe, 1.0 - transmittance));
    }
  }
}
`, [depthWgsl, lightsWgsl, VOLUME_PARAMS.module, sdfBindingsWgsl(1, { volume: 4, params: 5, sampler: 6 }), sdfWgsl,
    sdfCastersWgsl(1, 8, 9), fogParamsBindingWgsl(1, 11), CLOUD_PARAMS.module, cloudShadowSampleWgsl, punctualVolumeWgsl, volumeLocalQuadratureWgsl,
    ...(classified ? [sunClassLookupWgsl(1, VOLUME_SUN_CLASS_BINDING)] : [])]);
}

export const volumeTraceWgsl = volumeTrace(false);
export const volumeTraceClassifiedWgsl = volumeTrace(true);

export const volumeCompositeWgsl = makeModule('volumetrics-composite', /* wgsl */ `
@group(1) @binding(0) var volume_tex: texture_2d<f32>;
@group(1) @binding(1) var distance_tex: texture_2d<f32>;
@group(1) @binding(2) var scene_depth: texture_depth_2d;
@fragment fn fs_volume(in: FullscreenOut) -> @location(0) vec4f {
  let uv = in.pos.xy / frame_internal_size();
  let d = textureLoad(scene_depth, vec2u(in.pos.xy), 0);
  var distance = 90.0;
  if (d > 0.0) { distance = min(90.0, length(world_pos_from_depth(uv, d) - frame.eye_pos)); }
  let size = vec2i(textureDimensions(volume_tex)); let coord = uv * vec2f(size) - 0.5;
  let base = vec2i(floor(coord)); let f = fract(coord);
  var sum = vec4f(0.0); var weights = 0.0;
  for (var y = 0; y < 2; y++) { for (var x = 0; x < 2; x++) {
    let p = clamp(base + vec2i(x,y), vec2i(0), size-1);
    let z = textureLoad(distance_tex, p, 0).r;
    let spatial = select(1.0-f.x, f.x, x==1) * select(1.0-f.y, f.y, y==1);
    let w = spatial * exp(-abs(z-distance) / max(0.12, distance*0.015));
    sum += textureLoad(volume_tex,p,0) * w; weights += w;
  } }
  // No depth-compatible neighbour: conservative no contribution, never borrow a beam across a hull edge.
  if (weights < 0.001) { return vec4f(0.0); }
  return sum / weights;
}
`, [fullscreenWgsl, depthWgsl]);

export const volumeShaders = () => ({ trace: link(volumeTraceWgsl), composite: link(volumeCompositeWgsl), traceClassified: link(volumeTraceClassifiedWgsl) });
