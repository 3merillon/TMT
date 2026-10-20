import { fullscreenWgsl } from '../../gpu/fullscreen';
import { depthWgsl } from '../../wgsl/common/depth.wgsl';
import { cubeSphereWgsl } from '../../wgsl/common/cube-sphere.wgsl';
import { makeModule, wgslStruct } from '../../wgsl/module';
import { MAX_SHOCKWAVES } from './shockwave-pool';

export const SHOCKWAVE_UNIFORMS = wgslStruct('ShockwaveUniforms', [
  ['control', 'vec4f'], // count, quality, visible liquid enable, reserved
  ['centers', { array: 'vec4f', count: MAX_SHOCKWAVES }], // xyz, front radius
  ['shapes', { array: 'vec4f', count: MAX_SHOCKWAVES }], // thickness, pressure, condensation, dust
  ['motions', { array: 'vec4f', count: MAX_SHOCKWAVES }], // age fraction, seed, blast radius, reserved
]);

export const shockwavesWgsl = makeModule('shockwaves', /* wgsl */ `
@group(1) @binding(0) var scene_color: texture_2d<f32>;
@group(1) @binding(1) var scene_depth: texture_depth_2d;
@group(1) @binding(2) var scene_ids: texture_2d<u32>;
@group(1) @binding(3) var linear_sampler: sampler;
@group(1) @binding(4) var<uniform> sw: ShockwaveUniforms;
@group(1) @binding(5) var water_surface: texture_2d<f32>;
// Prefix of LiquidParams; the reserved placeholder is also large enough for this prefix.
struct ShockwaveWater { grid: vec4f }
@group(1) @binding(6) var<uniform> water_params: ShockwaveWater;

fn sw_hash(p: vec3f) -> f32 {
  return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453);
}
fn sw_noise(p: vec3f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(sw_hash(i), sw_hash(i + vec3f(1, 0, 0)), u.x),
                 mix(sw_hash(i + vec3f(0, 1, 0)), sw_hash(i + vec3f(1, 1, 0)), u.x), u.y),
             mix(mix(sw_hash(i + vec3f(0, 0, 1)), sw_hash(i + vec3f(1, 0, 1)), u.x),
                 mix(sw_hash(i + vec3f(0, 1, 1)), sw_hash(i + vec3f(1, 1, 1)), u.x), u.y), u.z);
}
fn sw_pixel(uv: vec2f) -> vec2i {
  let size = vec2i(textureDimensions(scene_depth));
  return clamp(vec2i(uv * vec2f(size)), vec2i(0), size - 1);
}
// Depth uses the current jittered raster. Remove jitter only for the visible pressure front itself.
fn sw_raster_uv(uv: vec2f) -> vec2f { return uv + frame.jitter * vec2f(0.5, -0.5); }
fn sw_ray(uv: vec2f) -> vec3f { return world_dir_from_uv(sw_raster_uv(uv)); }
fn sw_interval(b: f32, c: f32, radius: f32, limit: f32) -> vec2f {
  let discr = b * b - c + radius * radius;
  if (discr <= 0.0) { return vec2f(0); }
  let half = sqrt(discr);
  return vec2f(max(0.0, -b - half), min(limit, -b + half));
}
fn sw_length(interval: vec2f) -> f32 { return max(0.0, interval.y - interval.x); }
fn sw_water(point: vec3f) -> bool {
  if (sw.control.z < 0.5 || water_params.grid.w < 0.5 || water_params.grid.x < 1.0) { return false; }
  let direction = normalize(point - frame.planet.xyz);
  let face = cs_face_of(direction);
  let n = water_params.grid.x;
  let tile = vec2f(f32(face % 3u), f32(face / 3u)) * (n + 2.0);
  let px = tile + 1.0 + (cs_uv(direction, face) * 0.5 + 0.5) * n;
  var water = textureLoad(water_surface, vec2i(px), 0);
  if (sw.control.y > 0.5) {
    let q = px - 0.5; let at = vec2i(floor(q)); let f = fract(q);
    water = mix(mix(textureLoad(water_surface, at, 0), textureLoad(water_surface, at + vec2i(1, 0), 0), f.x),
      mix(textureLoad(water_surface, at + vec2i(0, 1), 0), textureLoad(water_surface, at + vec2i(1, 1), 0), f.x), f.y);
  }
  // The atlas includes open sea, lakes, and water running into new craters. Lava alone does not make white mist.
  return water.z > 0.005 && abs(length(point - frame.planet.xyz) - water.x) < 0.20;
}

@fragment
fn fs_shockwave(in: FullscreenOut) -> @location(0) vec4f {
  let uv = in.uv;
  let raster_uv = sw_raster_uv(uv);
  let pixel = sw_pixel(raster_uv);
  let depth = textureLoad(scene_depth, pixel, 0);
  let ray = sw_ray(uv);
  var limit = 1e5;
  var surface = frame.eye_pos + ray * limit;
  if (depth > 0.0) {
    surface = world_pos_from_depth(raster_uv, depth);
    limit = distance(surface, frame.eye_pos);
  }
  let original = textureLoad(scene_color, vec2i(in.pos.xy), 0).rgb;
  var offset = vec2f(0.0);
  var air_color = vec3f(0.0);
  var air_alpha = 0.0;
  var contact_color = vec3f(0.0);
  var contact_alpha = 0.0;
  var nearest_front = 1e5;
  // Reflect the incident daylight; no exposure compensation or emissive outline in the dark.
  let up = normalize(surface - frame.planet.xyz);
  let daylight = clamp(dot(up, frame.sun_dir) * 0.7 + 0.35, 0.0, 1.0);
  let illumination = 0.35 + frame.sun_radiance.r * 0.11 * daylight;
  let material = textureLoad(scene_ids, pixel, 0).r & 15u;
  for (var i = 0u; i < u32(sw.control.x); i++) {
    let center = sw.centers[i].xyz; let radius = sw.centers[i].w;
    let shape = sw.shapes[i]; let motion = sw.motions[i];
    let from_center = frame.eye_pos - center;
    let b = dot(from_center, ray); let c = dot(from_center, from_center);
    let outer = sw_interval(b, c, radius, limit);
    let inner_radius = max(0.0, radius - shape.x);
    let inner = sw_interval(b, c, inner_radius, limit);
    let shell_length = sw_length(outer) - sw_length(inner);
    if (shell_length > 0.00001) {
      let front_distance = select(outer.x, inner.y, c < inner_radius * inner_radius);
      let front = frame.eye_pos + ray * front_distance;
      let normal = normalize(front - center);
      // World-space patchiness breaks the perfect silhouette and moves with the expanding 3D front.
      let p = normal * (6.0 + motion.z * 0.8) + vec3f(motion.y * 7.31, motion.x * 1.8, motion.y);
      let noise = sw_noise(p);
      let patches = smoothstep(0.38, 0.77, noise);
      let column = min(shell_length / max(shape.x, 0.001), 5.0) * 0.2;
      let view_normal = (frame.view * vec4f(normal, 0.0)).xy * vec2f(1.0, -1.0);
      // Fractions of a pixel for normal blasts, at most 1.8 px even for overlapping nuclear fronts.
      offset += view_normal * shape.y * column * (0.4 + patches * 0.6) * 1.15;
      nearest_front = min(nearest_front, front_distance);
      let alpha = shape.z * column * patches * (1.0 - smoothstep(0.35, 0.78, motion.x));
      air_color += vec3f(0.68, 0.73, 0.76) * illumination * alpha;
      air_alpha += alpha;
    }
    if (depth > 0.0 && (material == 0u || material == 5u || material == 8u)) {
      // A short noisy wake directly behind the front follows the actual visible relief, including crater walls.
      let d = distance(surface, center);
      let band = max(0.06, motion.z * 0.10);
      let wake = (radius - d) / band;
      if (wake > -0.25 && wake < 2.8) {
        let water = sw_water(surface);
        let p = (surface - center) * (2.8 / max(motion.z, 0.5)) + vec3f(motion.y, motion.x * 3.0, 0.0);
        let patches = smoothstep(0.34, 0.76, sw_noise(p));
        let curtain = smoothstep(-0.25, 0.15, wake) * (1.0 - smoothstep(0.25, 2.8, wake));
        let alpha = curtain * patches * shape.w;
        contact_color += select(vec3f(0.30, 0.245, 0.17), vec3f(0.62, 0.72, 0.76), water) * illumination * alpha;
        contact_alpha += alpha;
      }
    }
  }
  let pixels = clamp(offset, vec2f(-1.8), vec2f(1.8));
  let shifted = clamp(uv + pixels / frame_display_size(), vec2f(0.0), vec2f(1.0));
  let shifted_uv = sw_raster_uv(shifted);
  let shifted_depth = textureLoad(scene_depth, sw_pixel(shifted_uv), 0);
  var sample_distance = 1e5;
  if (shifted_depth > 0.0) { sample_distance = distance(world_pos_from_depth(shifted_uv, shifted_depth), frame.eye_pos); }
  // Never pull foreground geometry across the shell or across a depth discontinuity/sky silhouette.
  let behind_front = sample_distance > nearest_front + 0.02;
  let same_surface = (depth == 0.0 && shifted_depth == 0.0)
    || (depth > 0.0 && shifted_depth > 0.0 && abs(sample_distance - limit) < max(0.18, limit * 0.012));
  var color = original;
  if (behind_front && same_surface) { color = textureSampleLevel(scene_color, linear_sampler, shifted, 0.0).rgb; }
  color = color * (1.0 - min(air_alpha, 0.28)) + air_color;
  color = color * (1.0 - min(contact_alpha, 0.5)) + contact_color;
  return vec4f(color, 1.0);
}
`, [fullscreenWgsl, depthWgsl, cubeSphereWgsl, SHOCKWAVE_UNIFORMS.module]);
