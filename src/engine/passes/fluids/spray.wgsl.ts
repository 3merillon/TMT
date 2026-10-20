/**
 * Spray, WGSL: droplets and mist thrown off the water, a ring of particles
 * (5 × vec4f each) that the newest emission overwrites.
 *
 * - **Bursts** (a blast in water): a crown of droplets thrown up and out from the water around the centre, a column
 *   rising from the middle, and a little mist. Particles start on the water surface (from the atlas), and only where
 *   there is water. A lava burst (a blast in lava, a vent's fountain) throws glowing blobs from the lava instead.
 * - **Grid emission** (once per frame over the cells): a hull throws spray only from its waterline EDGE (where the
 *   share of the column it closes changes across neighbours), mostly on its leading side, outward from the hull and up,
 *   faster with the hull's speed; never from the closed water under it. Fast, steep water (a torrent into a crater)
 *   sprays with its flow; water on hot lava steams. Every particle starts at a random point inside its cell, so no
 *   lattice of cell centres shows.
 * - **Update:** ballistic under radial gravity with air drag. Water droplets SPLASH where they meet the terrain or a
 *   tank (the live SDF and the caster bricks): they scatter along the surface, shrink, throw a couple of smaller
 *   droplets on a hard hit, and soak in after two bounces; they merge back into water they fall into. Molten spatter
 *   rebounds and cools. Light is traced here once per particle per frame, like the world's own: the sun (SDF terrain,
 *   tank bricks, cloud shadow, atmospheric colour), the moon by its phase, the sky's irradiance, the night floor and the
 *   punctual lights (headlights, fires, muzzle flashes); and the fog-of-war hidden fraction.
 * - **Drawing:** camera-facing quads pulled from the ring; droplets are small translucent spheres that scatter the sun
 *   forward (bright against it), mist is a soft puff; both fade out as they die and vanish in hidden air.
 * Presentation only (N5).
 */
import { makeModule, wgslStruct } from '../../wgsl/module';
import { cubeSphereWgsl } from '../../wgsl/common/cube-sphere.wgsl';
import { frameWgsl } from '../../wgsl/common/frame.wgsl';
import { depthWgsl } from '../../wgsl/common/depth.wgsl';
import { sdfBindingsWgsl, sdfWgsl } from '../sdf/sdf.wgsl';
import { sdfCastersWgsl } from '../sdf/sdf-casters';
import { fogParamsBindingWgsl } from '../fog-of-war/fog.wgsl';
import { atmosphereBindingsWgsl, atmosphereFnWgsl } from '../atmosphere/integrate.wgsl';
import { skyLightBindingsWgsl, skyLightFnWgsl } from '../lighting/sky-light';
import { cloudShadowSampleWgsl } from '../clouds/shadow.wgsl';
import { lightsWgsl } from '../../scene/lights';
import { levelMapAddressWgsl } from './water.wgsl';
import { emberCollisionWgsl } from './ember-collision.wgsl';
import { HULL_WAKE } from './hull-wake';

export const SPRAY_MAX_BURSTS = 8;
/** vec4f per particle: pos + life, vel + size, kind + max life + hidden + bounces, sun irradiance, fill irradiance. */
export const SPRAY_STRIDE = 5;

export const SPRAY_SIM = wgslStruct('SpraySim', [
  ['dims', 'vec4u'],      // x capacity, y cells, z N, w frame
  ['step', 'vec4f'],      // x dt (s), y gravity (u/s²), z air drag (1/s), w time (s)
  ['emit', 'vec4f'],      // x droplets per u of hull push, y torrent spray per s, z speed where torrents spray (u/s), w wet depth (u)
  ['look', 'vec4f'],      // x droplet size (u), y mist size (u), z brightness, w metric radius (u)
  ['sun', 'vec4f'],       // xyz toward the sun, w tan of its radius
  ['sun_rgb', 'vec4f'],   // rgb sun radiance (frame.sun_radiance), w edge spray per u/s of hull travel
  ['moon', 'vec4f'],      // rgb moon irradiance (tint × illuminance × phase), w moonlit-sky fill share
  ['moon_dir', 'vec4f'],  // xyz toward the moon, w tan of its radius
  ['night', 'vec4f'],     // x night floor gain, y night ambient scale + back fill, z/w day factor ramp (sun elevation)
  ['wind', 'vec4f'],      // xyz the air field's axis, w ground air speed (u/s): spray and mist drift with the match wind
  ['counts', 'vec4u'],    // x bursts, y particles all bursts emit, z veil (1 = hidden air hides spray), w lava bursts (bit per burst)
  // Per burst, 2 × vec4f: centre (xyz) and radius (w); first particle index among the bursts (x), count (y), seed (z), strength (w).
  ['bursts', { array: 'vec4f', count: SPRAY_MAX_BURSTS * 2 }],
]);

const sprayCommonWgsl = makeModule('spray-common', /* wgsl */ `
const SP_STRIDE: u32 = ${SPRAY_STRIDE}u;
fn sp_hash(a: u32, b: u32) -> u32 {
  var x = a ^ (b * 2654435761u);
  x ^= x >> 16u;
  x *= 0x45d9f3bu;
  x ^= x >> 16u;
  x *= 0x45d9f3bu;
  x ^= x >> 16u;
  return x;
}
fn sp_rand(a: u32, b: u32) -> f32 { return f32(sp_hash(a, b) & 0xffffffu) / 16777215.0; }
`);

export const sprayStepWgsl = makeModule('spray-step', /* wgsl */ `
@group(0) @binding(0) var<uniform> S: SpraySim;
@group(0) @binding(1) var<storage, read_write> parts: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> head: array<atomic<u32>>;
@group(0) @binding(3) var atlas_a: texture_2d<f32>;
@group(0) @binding(4) var fog_volume: texture_3d<f32>;
@group(0) @binding(5) var lin: sampler;
@group(0) @binding(6) var<storage, read> w_state: array<vec4f>;
@group(0) @binding(7) var<storage, read> w_vel: array<vec4f>;
@group(0) @binding(8) var<storage, read> w_hull: array<vec4f>;
@group(0) @binding(9) var<storage, read> w_heat: array<vec2f>;
@group(2) @binding(8) var spray_cloud_shadow: texture_cube<f32>;
@group(2) @binding(9) var<uniform> spray_cloud_params: CloudParams;
@group(2) @binding(10) var<storage, read> spray_lights: LightList;

/** The water at a direction from the atlas (nearest texel): x surface radius (0 none), z water depth. */
fn sp_water(d: vec3f) -> vec4f {
  return textureLoad(atlas_a, vec2i(floor(lm_atlas_px(d, f32(S.dims.z)))), 0);
}

fn sp_frame(up: vec3f) -> mat3x3f {
  let a = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(up.y) > 0.9);
  let e1 = normalize(cross(a, up));
  return mat3x3f(e1, cross(up, e1), up);
}

fn sp_write(slot: u32, pos: vec3f, vel: vec3f, life: f32, size: f32, kind: f32) {
  let i = (slot % S.dims.x) * SP_STRIDE;
  parts[i] = vec4f(pos, life);
  parts[i + 1u] = vec4f(vel, size);
  parts[i + 2u] = vec4f(kind, life, 0.0, 0.0);
  parts[i + 3u] = vec4f(0.0);
  parts[i + 4u] = vec4f(0.0);
}

/** A random direction inside cell c (cube uv jittered over the whole cell): no rows at cell centres. */
fn sp_cell_point(c: u32, ra: f32, rb: f32) -> vec3f {
  let d0 = lm_cell_dir(c, S.dims.z);
  let face = cs_face_of(d0);
  return cs_dir(face, cs_uv(d0, face) + (vec2f(ra, rb) - 0.5) * (2.0 / f32(S.dims.z)));
}

/** One thread per particle of all this frame's bursts. */
@compute @workgroup_size(64)
fn emit_bursts(@builtin(global_invocation_id) g: vec3u) {
  let t = g.x;
  if (t >= S.counts.y) { return; }
  var b = 0u;
  for (var k = 0u; k < S.counts.x; k++) {
    let info = S.bursts[k * 2u + 1u];
    if (t >= u32(info.x) && t < u32(info.x) + u32(info.y)) { b = k; }
  }
  let head_b = S.bursts[b * 2u];
  let info = S.bursts[b * 2u + 1u];
  let i = t - u32(info.x);
  let seed = u32(info.z);
  let r0 = sp_rand(seed, i * 7u + 1u);
  let r1 = sp_rand(seed, i * 7u + 2u);
  let r2 = sp_rand(seed, i * 7u + 3u);
  let r3 = sp_rand(seed, i * 7u + 4u);
  let r4 = sp_rand(seed, i * 7u + 5u);
  let r5 = sp_rand(seed, i * 7u + 6u);
  let lava = ((S.counts.w >> b) & 1u) != 0u;
  let column = r4 < 0.28;
  let mist = r4 > 0.9 && !lava;
  let reach = head_b.w * select(0.75, 0.22, column);
  let rho = reach * sqrt(r0);
  let ang = r1 * 6.2831853;
  let up0 = normalize(head_b.xyz);
  let f = sp_frame(up0);
  let side = f[0] * cos(ang) + f[1] * sin(ang);
  let d = normalize(up0 * length(head_b.xyz) + side * rho);
  let wtr = sp_water(d);
  if (wtr.x <= 0.0 || (!lava && wtr.z < S.emit.w * 5.0) || (lava && wtr.w < 0.03)) { return; }
  let pos = d * (wtr.x + 0.01);
  let strength = info.w;
  let out_speed = select((1.4 + 2.6 * r2) * strength * (0.4 + 0.6 * rho / max(head_b.w, 1e-3)), 0.5 * r2, column);
  let up_speed = select((2.4 + 3.4 * r3) * strength, (5.0 + 3.5 * r3) * strength, column);
  // A little sideways scatter, so the crown is a ragged sheet, not a perfect cone.
  let wobble = (f[0] * (r5 - 0.5) + f[1] * (fract(r5 * 7.31) - 0.5)) * 0.6 * strength;
  var vel = side * out_speed + d * up_speed + wobble;
  var size = S.look.x * (0.4 + 1.3 * r2 * r2 * r2);
  var life = 1.4 + 1.4 * r3;
  if (mist) { vel *= 0.4; size = S.look.y * (0.8 + 0.8 * r2); life = 2.5 + 2.0 * r3; }
  var kind = select(0.0, 1.0, mist);
  // Lava is heavier and slower; its blobs glow and cool in flight.
  if (lava) {
    vel *= 0.55 + 0.25 * r0;
    size = S.look.x * (0.35 + 2.7 * r2 * r2 * r2);
    life = 1.8 + 1.6 * r3;
    kind = 2.0 + 0.45 * (0.72 + r1 * 0.28);
  }
  let slot = atomicAdd(&head[0], 1u);
  sp_write(slot, pos, vel, life, size, kind);
}

/**
 * The hull's closed share around cell c: its gradient across the face (pointing into the hull, per cell) and how much
 * of a waterline edge the cell is. Cells on a face border (rare under a tank) fall back to the share alone.
 */
fn sp_hull_edge(c: u32, d0: vec3f) -> vec4f {
  let n = S.dims.z;
  let face = c / (n * n);
  let r = c - face * n * n;
  let j = r / n;
  let i = r - j * n;
  let s = w_hull[c].z;
  if (i == 0u || j == 0u || i + 1u >= n || j + 1u >= n) { return vec4f(0.0, 0.0, 0.0, clamp(4.0 * s * (1.0 - s), 0.0, 1.0)); }
  let uv = (vec2f(f32(i), f32(j)) + 0.5) / f32(n) * 2.0 - 1.0;
  let step = 2.0 / f32(n);
  let eu = normalize(cs_dir(face, uv + vec2f(step, 0.0)) - d0);
  let ev = normalize(cs_dir(face, uv + vec2f(0.0, step)) - d0);
  let grad = eu * (w_hull[c + 1u].z - w_hull[c - 1u].z) * 0.5 + ev * (w_hull[c + n].z - w_hull[c - n].z) * 0.5;
  return vec4f(grad, clamp(length(grad) * 3.0, 0.0, 1.0));
}

/** Droplets off the water at a moving hull's waterline edge, and off fast, steep water. */
@compute @workgroup_size(256)
fn emit_grid(@builtin(global_invocation_id) g: vec3u) {
  let c = g.x;
  if (c >= S.dims.y) { return; }
  let s = w_state[c];
  if (s.x <= S.emit.w && s.y > S.emit.w) {
    // A moving hull releases sparse molten spatter from the broken skin. A resting hull emits nothing, even while waves pass.
    let change = abs(w_hull[c].x - w_hull[c].y);
    let rate = min(change * 2.0, 0.07);
    if (rate > 0.0 && sp_rand(c, S.dims.w * 11u) < rate) {
      let d0 = lm_cell_dir(c, S.dims.z);
      let f = sp_frame(d0);
      let r = sp_rand(c, S.dims.w * 11u + 1u);
      let r1 = sp_rand(c, S.dims.w * 11u + 2u);
      let r2 = sp_rand(c, S.dims.w * 11u + 3u);
      let r3 = sp_rand(c, S.dims.w * 11u + 4u);
      let d = sp_cell_point(c, r1, r2);
      let v = w_vel[c].xyz * (0.35 + r2 * 0.5) + d * (0.25 + r * r * 1.0)
        + (f[0] * (r1 - 0.5) + f[1] * (r3 - 0.5)) * 0.7;
      let kind = 2.0 + 0.45 * clamp(w_heat[c].x * 0.7 + 0.18 + r2 * 0.18, 0.0, 1.0);
      let size = 0.008 + r * r * r * 0.032;
      let pos = d * (sp_water(d).y + size + 0.006) + v * (r3 * S.step.x);
      sp_write(atomicAdd(&head[0], 1u), pos, v, 1.4 + r1 * 1.3, size, kind);
    }
    return;
  }
  if (s.x <= S.emit.w) { return; }
  let frame = S.dims.w;
  // Steam where water lies on hot lava: soft puffs rising slowly.
  let temp = w_heat[c].x;
  if (s.y > S.emit.w && temp > 0.3 && sp_rand(c, frame * 7u + 5u) < 4.0 * S.step.x * temp) {
    let r0 = sp_rand(c, frame * 7u + 6u);
    let d = sp_cell_point(c, sp_rand(c, frame * 7u + 7u), sp_rand(c, frame * 7u + 8u));
    let wtr0 = sp_water(d);
    let slot = atomicAdd(&head[0], 1u);
    sp_write(slot, d * (select(17.5, wtr0.x, wtr0.x > 0.0) + 0.02), d * (0.5 + 0.7 * r0), 2.5 + 1.5 * r0, S.look.y * (0.7 + 0.6 * r0), 1.0);
  }
  let h = w_hull[c];
  let v = w_vel[c];
  let speed = v.w;
  let shallow = smoothstep(S.emit.w, S.emit.w * 5.0, s.x);
  var hull_count = 0.0;
  var outward = vec3f(0.0);
  var hull_speed = 0.0;
  let d0 = lm_cell_dir(c, S.dims.z);
  // Only where a hull touches the waterline (heat.y) and moves (h.w) or pushes into the column (h.x > h.y).
  if (w_heat[c].y > 0.0 && (h.w > 0.0 || h.x != h.y)) {
    let edge = sp_hull_edge(c, d0);
    let g_len = length(edge.xyz);
    outward = select(vec3f(0.0), -edge.xyz / max(g_len, 1e-6), g_len > 1e-4);
    // The flow at the edge is the water the hull shoves: spray leaves mostly on the side the hull moves toward.
    let flow = v.xyz - d0 * dot(v.xyz, d0);
    let flow_len = length(flow);
    let leading = select(0.6, mix(0.15, 1.0, smoothstep(-0.3, 0.5, dot(outward, flow / max(flow_len, 1e-6)))), flow_len > 0.05 && g_len > 1e-4);
    hull_speed = clamp(h.w / max(w_heat[c].y, 0.05), 0.0, ${HULL_WAKE.maximumSpeed}.0);
    let push = max(h.x - h.y, 0.0) * w_heat[c].y;
    hull_count = (push * S.emit.x + h.w * S.step.x * S.sun_rgb.w) * edge.w * leading * shallow;
  }
  var count = u32(hull_count + sp_rand(c, frame * 3u));
  let torrent = speed > S.emit.z && sp_rand(c, frame * 3u + 1u) < S.emit.y * S.step.x * (speed - S.emit.z);
  if (count == 0u && !torrent) { return; }
  let f = sp_frame(d0);
  for (var k = 0u; k < min(count, 6u) + select(0u, 1u, torrent); k++) {
    let key = c * 16u + k;
    let r0 = sp_rand(key, frame * 5u + 2u);
    let r1 = sp_rand(key, frame * 5u + 3u);
    let r2 = sp_rand(key, frame * 5u + 4u);
    let r3 = sp_rand(key, frame * 5u + 5u);
    let r4 = sp_rand(key, frame * 5u + 6u);
    let d = sp_cell_point(c, r0, r1);
    let wtr = sp_water(d);
    let base = select(length(d) * 17.5, wtr.x, wtr.x > 0.0);
    let ang = r3 * 6.2831853;
    let scatter = f[0] * cos(ang) + f[1] * sin(ang);
    var vel: vec3f;
    var size = S.look.x * (0.3 + 1.4 * r2 * r2 * r2);
    var life = 0.8 + 0.9 * r4;
    var kind = 0.0;
    if (k < min(count, 6u)) {
      // A fan thrown out of the hull's side and up, faster with the hull; the shoved water carries it along.
      let hs = hull_speed;
      vel = outward * (0.25 + 0.9 * r1) * (0.35 + 0.75 * hs)
        + d * (0.5 + 1.7 * r2 * r2) * (0.45 + 0.6 * hs)
        + v.xyz * (0.4 + 0.5 * r4)
        + scatter * (0.15 + 0.35 * hs) * r0;
      if (r4 < 0.05 * min(hs, 1.0)) { kind = 1.0; size = S.look.y * (0.35 + 0.4 * r2); life = 1.6 + 1.2 * r3; vel *= 0.5; }
    } else {
      vel = v.xyz * (0.8 + 0.6 * r2) + scatter * 0.6 * r0 + d * (1.2 + 2.2 * r2 + 0.3 * speed);
    }
    let slot = atomicAdd(&head[0], 1u);
    sp_write(slot, d * (base + 0.01) + vel * (r3 * S.step.x), vel, life, size, kind);
  }
}

/** Tetrahedral gradient of caster i's distance. */
fn sp_caster_normal(i: u32, p: vec3f) -> vec3f {
  let e = 0.01;
  let k = vec2f(1.0, -1.0);
  let g = k.xyy * caster_distance(i, p + k.xyy * e) + k.yyx * caster_distance(i, p + k.yyx * e)
        + k.yxy * caster_distance(i, p + k.yxy * e) + k.xxx * caster_distance(i, p + k.xxx * e);
  return select(normalize(p), normalize(g), dot(g, g) > 1e-12);
}

struct SpraySolid { hit: bool, n: vec3f, depth: f32 }

/** The terrain or a tank, whichever the droplet (radius r) is inside of at p. */
fn sp_solid(p: vec3f, r: f32) -> SpraySolid {
  var out = SpraySolid(false, vec3f(0.0), 0.0);
  let dt = sdf_sample(p) - r;
  if (dt < 0.0) { return SpraySolid(true, sdf_normal(p), -dt); }
  for (var i = 0u; i < caster_count(); i++) {
    let sph = caster_sphere(i);
    if (length(p - sph.xyz) > sph.w + r) { continue; }
    let dc = caster_distance(i, p) - r;
    if (dc < 0.0) { return SpraySolid(true, sp_caster_normal(i, p), -dc); }
  }
  return out;
}

@compute @workgroup_size(256)
fn update(@builtin(global_invocation_id) g: vec3u) {
  let k = g.x;
  if (k >= S.dims.x) { return; }
  let i = k * SP_STRIDE;
  var a = parts[i];
  if (a.w <= 0.0) { return; }
  var b = parts[i + 1u];
  var m = parts[i + 2u];
  let dt = S.step.x;
  let up = normalize(a.xyz);
  let mist = m.x > 0.5 && m.x < 1.5;
  let drag = S.step.z * select(select(1.0, 0.5, m.x > 1.5), 4.0, mist);
  // Air drag pulls toward the moving air, not toward rest: spray and mist drift downwind.
  let air = cross(S.wind.xyz, up) * S.wind.w;
  b = vec4f(b.xyz + (-up * S.step.y * select(1.0, 0.15, mist) - (b.xyz - air) * drag) * dt, b.w);
  if (m.x > 1.5) {
    let motion = ember_move(a.xyz, b.xyz, b.w * 0.6, dt, 0.42);
    a = vec4f(motion.position, a.w - dt);
    b = vec4f(motion.velocity, b.w);
  } else {
    a = vec4f(a.xyz + b.xyz * dt, a.w - dt);
    if (mist) {
      if (sdf_sample(a.xyz) < 0.0) { a.w = 0.0; }
    } else {
      // Splash: a droplet meeting the ground or a hull scatters along it, shrinks, sheds smaller drops and soaks in.
      let hit = sp_solid(a.xyz, b.w * 0.5);
      if (hit.hit) {
        let inward = dot(b.xyz, hit.n);
        a = vec4f(a.xyz + hit.n * (hit.depth + 0.003), a.w);
        if (inward < 0.0) {
          let impact = -inward;
          let seed = sp_hash(k, S.dims.w * 13u + 7u);
          let r0 = sp_rand(seed, 1u);
          let r1 = sp_rand(seed, 2u);
          let f = sp_frame(hit.n);
          let ang = r0 * 6.2831853;
          let scatter = f[0] * cos(ang) + f[1] * sin(ang);
          let along = b.xyz - hit.n * inward;
          m.w += 1.0;
          if (m.w > 2.5 || impact < 0.35) {
            a.w = 0.0;
          } else {
            b = vec4f(along * 0.5 + hit.n * impact * (0.15 + 0.25 * r1) + scatter * impact * 0.3, b.w * 0.7);
            a.w = min(a.w, 0.35 + 0.35 * r1);
            // A hard hit throws two smaller drops sideways (they may land on a dead slot; the ring is a cosmetic pool).
            if (impact > 1.4 && m.w < 1.5) {
              for (var c = 0u; c < 2u; c++) {
                let rc = sp_rand(seed, 3u + c);
                let side = f[0] * cos(ang + 2.1 + 2.1 * f32(c)) + f[1] * sin(ang + 2.1 + 2.1 * f32(c));
                let vc = along * 0.35 + hit.n * impact * (0.25 + 0.3 * rc) + side * impact * (0.3 + 0.3 * rc);
                let slot = atomicAdd(&head[0], 1u);
                sp_write(slot, a.xyz + hit.n * 0.004, vc, 0.25 + 0.3 * rc, b.w * (0.45 + 0.2 * rc), 0.0);
                parts[(slot % S.dims.x) * SP_STRIDE + 2u].w = 1.0;
              }
            }
          }
        }
      }
    }
  }
  let wtr = sp_water(normalize(a.xyz));
  if (!mist && wtr.x > 0.0 && (wtr.z > S.emit.w || wtr.w > S.emit.w)) {
    if (m.x > 1.5 && wtr.z <= S.emit.w && length(a.xyz) < wtr.y + b.w * 0.6) {
      // The viscous lava/crust surface also catches glowing spatter.
      let n = normalize(a.xyz);
      a = vec4f(n * (wtr.y + b.w * 0.6 + 0.002), a.w);
      b = vec4f(ember_rebound(b.xyz, n, 0.28), b.w);
    } else if (length(a.xyz) < wtr.x && dot(b.xyz, up) < 0.0) { a.w = 0.0; }
  }
  var sun = vec3f(0.0);
  var fill = vec3f(0.0);
  var hidden = m.z;
  if (a.w > 0.0) {
    // Light, traced here once per frame as the world is lit (lighting.wgsl): sun and moon with the terrain and tanks'
    // shadows, the clouds' shadow, the sky's irradiance, the night floor and the punctual lights.
    let p = a.xyz;
    let n_up = normalize(p);
    let cos_s = dot(n_up, S.sun.xyz);
    if (cos_s > -0.15) {
      var vis = sdf_vis_dir(p, S.sun.xyz, S.sun.w, sdf_voxel(), 16u);
      if (vis > 0.001) { vis *= casters_vis_dir(p, S.sun.xyz, S.sun.w); }
      if (vis > 0.001) { vis *= cloud_shadow_visibility(spray_cloud_shadow, sdf_sampler, spray_cloud_params, p); }
      if (vis > 0.001) { sun = S.sun_rgb.rgb * atmo_sun_color(p) * vis * smoothstep(-0.15, 0.0, cos_s); }
    }
    let lm = S.moon_dir.xyz;
    let moon_up = smoothstep(-0.05, 0.25, dot(n_up, lm));
    let day = smoothstep(S.night.z, S.night.w, cos_s);
    if (moon_up > 0.0 && dot(S.moon.rgb, S.moon.rgb) > 1e-10) {
      var mv = sdf_vis_dir(p, lm, S.moon_dir.w, sdf_voxel(), 12u);
      if (mv > 0.001) { mv *= casters_vis_dir(p, lm, S.moon_dir.w); }
      fill += S.moon.rgb * (mv + S.moon.w * (1.0 - day)) * moon_up;
    }
    if (atmo_valid()) { fill += atmo.night.rgb * (3.14159265 * S.night.x * S.night.y * (1.0 - day)); }
    if (sky_light_valid()) { fill += sky_irradiance(p, n_up, n_up, S.sun.xyz); }
    for (var j = 0u; j < min(spray_lights.header.x, MAX_LIGHTS); j++) {
      let l = spray_lights.lights[j];
      if ((l.params.y & 1u) == 0u) { continue; }
      let delta = l.position_range.xyz - p;
      let d2 = dot(delta, delta);
      if (d2 >= l.position_range.w * l.position_range.w) { continue; }
      var cone = 1.0;
      if (l.params.x == LIGHT_TYPE_SPOT) { let cc = unpack_cone_cosines(l.params.z); cone = spot_falloff(-delta * inverseSqrt(max(d2, 1e-8)), l.direction.xyz, cc.x, cc.y); }
      fill += l.color_intensity.rgb * light_attenuation(max(d2, 0.09), l.position_range.w) * cone;
    }
    hidden = 0.0;
    if (S.counts.z > 0u && fog_params.settings.x > 0.5) { hidden = textureSampleLevel(fog_volume, lin, p * (0.5 / fog_params.volume.y) + 0.5, 0.0).r; }
  }
  parts[i] = a;
  parts[i + 1u] = b;
  parts[i + 2u] = vec4f(m.x, m.y, hidden, m.w);
  parts[i + 3u] = vec4f(sun, 0.0);
  parts[i + 4u] = vec4f(fill, 0.0);
}
`, [cubeSphereWgsl, SPRAY_SIM.module, levelMapAddressWgsl, sprayCommonWgsl, sdfBindingsWgsl(1, { volume: 0, params: 1, sampler: 2 }), sdfWgsl,
  fogParamsBindingWgsl(1, 3), emberCollisionWgsl, sdfCastersWgsl(2, 0, 1),
  atmosphereBindingsWgsl(2, { params: 2, transmittance: 3, multiscatter: 4, sampler: 11 }), atmosphereFnWgsl,
  skyLightBindingsWgsl(2, { params: 5, atlas: 6, cube: 7 }), skyLightFnWgsl, cloudShadowSampleWgsl, lightsWgsl]);

/** Camera-facing quads pulled from the ring (6 vertices per particle; dead ones fall outside the clip volume). */
export const sprayDrawWgsl = makeModule('spray-draw', /* wgsl */ `
@group(1) @binding(0) var<uniform> S: SpraySim;
@group(1) @binding(1) var<storage, read> parts: array<vec4f>;
@group(1) @binding(2) var spray_depth: texture_depth_2d;

struct SprayOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) look: vec4f,   // kind, fade, unused, hidden
  @location(2) @interpolate(flat) center: vec4f, // xyz world center, w radius
  @location(3) @interpolate(flat) shape: vec3f,  // screen axis xy, elongated radius
  @location(4) @interpolate(flat) heat: f32,
  @location(5) @interpolate(flat) sun: vec3f,    // sun irradiance at the particle (shadowed)
  @location(6) @interpolate(flat) fill: vec3f,   // sky, moon, night floor and punctual irradiance
}

@vertex fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) k: u32) -> SprayOut {
  let i = k * SP_STRIDE;
  let a = parts[i];
  let b = parts[i + 1u];
  let m = parts[i + 2u];
  var out: SprayOut;
  let clip = frame.view_proj * vec4f(a.xyz, 1.0);
  // Dead, hidden, or so close to the eye that one droplet would cover the screen.
  if (a.w <= 0.0 || m.z > 0.98 || clip.w < 0.05) {
    out.pos = vec4f(2.0, 2.0, 2.0, 1.0);
    return out;
  }
  let corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let q = corners[v];
  let mist = m.x > 0.5 && m.x < 1.5;
  let age = 1.0 - clamp(a.w / max(m.y, 1e-3), 0.0, 1.0);
  let size = b.w * select(1.0, 1.0 + 1.8 * age, mist);
  // In pixels: the droplet's radius, and how far it moves in a streak's exposure (35 ms), so fast spray draws as streaks.
  let half_px = frame_internal_size() * 0.5;
  let radius_px = size * frame.proj[1][1] / clip.w * half_px.y;
  let ahead = frame.view_proj * vec4f(a.xyz + b.xyz * select(0.035, 0.009, m.x > 1.5), 1.0);
  var motion = (ahead.xy / max(ahead.w, 1e-4) - clip.xy / clip.w) * half_px;
  // A drop flying at the eye projects its streak to infinity: no streak then, and never longer than a short smear.
  if (mist || ahead.w < clip.w * 0.5) { motion = vec2f(0.0); }
  let max_px = max(radius_px * 12.0, 24.0);
  let raw_px = length(motion);
  if (raw_px > max_px) { motion *= max_px / raw_px; }
  let length_px = length(motion);
  let axis = select(vec2f(1.0, 0.0), motion / max(length_px, 1e-4), length_px > 0.5);
  let across = vec2f(-axis.y, axis.x);
  let offset_px = axis * q.x * (radius_px + 0.5 * length_px) + across * q.y * radius_px;
  out.pos = vec4f(clip.xy + offset_px / half_px * clip.w, clip.zw);
  out.uv = q;
  // Energy spread over the streak: a long streak is fainter.
  let spread = radius_px / (radius_px + 0.5 * length_px);
  out.look = vec4f(m.x, clamp((1.0 - age) * 4.0, 0.0, 1.0) * select(0.35 + 0.65 * spread, 1.0, mist), 0.0, m.z);
  out.center = vec4f(a.xyz, size);
  out.shape = vec3f(axis, size * (1.0 + 0.5 * length_px / max(radius_px, 1e-5)));
  // Temperature changes throughout the flight; opacity only fades at the end.
  out.heat = clamp(fract(m.x) / 0.45 - age * (0.7 + 0.2 * (1.0 - clamp(b.w / 0.05, 0.0, 1.0))), 0.0, 1.0);
  out.sun = parts[i + 3u].xyz;
  out.fill = parts[i + 4u].xyz;
  return out;
}

/** Henyey–Greenstein phase × 4π (1 on average over the sphere). */
fn sp_phase(mu: f32, g: f32) -> f32 {
  return (1.0 - g * g) / pow(max(1.0 + g * g - 2.0 * g * mu, 1e-4), 1.5);
}

@fragment fn fs(v: SprayOut) -> @location(0) vec4f {
  let r2 = dot(v.uv, v.uv);
  if (r2 > 1.0) { discard; }
  // The quad only bounds a raymarched ellipsoid. Clip the VOLUME against scene
  // depth (which includes water), never the flat quad at its centre depth.
  let pixel_uv = v.pos.xy / frame_internal_size();
  let ray = world_dir_from_uv(pixel_uv);
  let eye = view_to_world(vec3f(0.0));
  let axis = view_dir_to_world(vec3f(v.shape.xy, 0.0));
  let across = view_dir_to_world(vec3f(-v.shape.y, v.shape.x, 0.0));
  let forward = view_dir_to_world(vec3f(0.0, 0.0, 1.0));
  let basis = transpose(mat3x3f(axis, across, forward));
  let radii = max(vec3f(v.shape.z, v.center.w, v.center.w), vec3f(1e-5));
  let ro = (basis * (eye - v.center.xyz)) / radii;
  let rd = (basis * ray) / radii;
  let aa = dot(rd, rd); let bb = dot(ro, rd); let cc = dot(ro, ro) - 1.0;
  let disc = bb * bb - aa * cc;
  if (disc <= 0.0) { discard; }
  let enter = max(0.0, (-bb - sqrt(disc)) / aa);
  var leave = (-bb + sqrt(disc)) / aa;
  let scene_z = textureLoad(spray_depth, vec2i(v.pos.xy), 0);
  if (scene_z > 0.0) { leave = min(leave, length(world_pos_from_depth(pixel_uv, scene_z) - eye)); }
  if (leave <= enter) { discard; }
  var density = 0.0;
  let step_length = (leave - enter) / 6.0;
  for (var sample = 0u; sample < 6u; sample++) {
    let p = ro + rd * (enter + (f32(sample) + 0.5) * step_length);
    let detail = 0.85 + 0.15 * sin(p.x * 9.0 + sin(p.z * 7.0)) * sin(p.y * 8.0);
    density += max(0.0, exp(-2.5 * dot(p, p)) - exp(-2.5)) * detail * step_length / v.center.w;
  }
  let inv_pi = 0.318309886;
  // Water scatters strongly forward: spray glows against the sun and is a dull grey with the sun behind the eye.
  let mu = dot(ray, frame.sun_dir);
  var rgb: vec3f;
  var alpha: f32;
  if (v.look.x > 1.5) {
    // Bright core, darker cooling shell, red embers and finally opaque grey ash.
    let n = vec3f(v.uv.x * 0.5, v.uv.y, sqrt(max(1.0 - r2, 0.0)));
    let heat = clamp(v.heat + n.z * 0.1 - 0.1, 0.0, 1.0);
    let fire = mix(vec3f(1.4, 0.025, 0.001), vec3f(7.0, 3.6, 0.65), pow(heat, 2.8));
    rgb = vec3f(0.12, 0.13, 0.14) * (v.sun * max(n.z, 0.0) * 0.7 + v.fill) * inv_pi
      + fire * smoothstep(0.08, 0.8, heat) * (0.35 + 0.65 * n.z);
    alpha = 0.95 * (1.0 - smoothstep(0.55, 1.0, r2));
    return vec4f(rgb, alpha * min(1.0, density * 2.0) * v.look.y * (1.0 - v.look.w) * S.look.z);
  }
  if (v.look.x > 0.5) {
    // Mist: a large, faint, soft puff that spreads as it ages.
    alpha = 1.0 - exp(-density * 0.11);
    rgb = (v.fill + v.sun * (0.35 + 0.25 * sp_phase(mu, 0.6))) * inv_pi * vec3f(0.96, 0.98, 1.0);
  } else {
    // A droplet or a streak of spray: translucent white (spray is mostly air and foam at this scale), a glint on top.
    let n = vec3f(v.uv.x * 0.5, v.uv.y, sqrt(max(1.0 - r2, 0.0)));
    let lit = 0.4 + 0.6 * max(n.z * 0.6 + n.y * 0.4, 0.0);
    rgb = (v.fill + v.sun * (0.55 * lit + 0.1 * sp_phase(mu, 0.75))) * inv_pi * vec3f(0.86, 0.93, 0.99)
      + v.sun * inv_pi * 0.5 * pow(max(n.z, 0.0), 18.0);
    alpha = 1.0 - exp(-density * 1.25);
  }
  alpha *= v.look.y * (1.0 - v.look.w) * S.look.z;
  return vec4f(rgb, alpha);
}
`, [frameWgsl, depthWgsl, SPRAY_SIM.module, sprayCommonWgsl]);
