// Ported from Pinionfall src/effects/fluid-fire/fluid-fire-wgsl.ts and fluid-fire-render-wgsl.ts (MIT, same owner)
/**
 * Gas: fire, smoke, dust and steam. Pooled stable-fluid domains: every live
 * domain is one slot of a shared 3D atlas (N × N × N·S; slot s occupies z ∈ [s·N, (s + 1)·N)), so each solver stage
 * is one dispatch over every active slot, and `slot_list[gid.z / N]` names the slot.
 *
 * - **Solver** (Pinionfall's port of TMT's own stable-fluids effect): midpoint semi-Lagrangian advection, vorticity
 *   confinement, buoyancy along the domain's +Y (the radial up at its centre), combustion of fuel into heat and smoke,
 *   a divergence source for the gas's expansion, Jacobi pressure relaxation with open faces, projection with wall and
 *   surface-slip boundaries. Velocity is in domain widths per second.
 * - **Obstacles** (rebuilt every step, since tanks move and water flows): the planet SDF with pending craters, the water
 *   below its surface (the water's atlas), and every tank's hull box. Solidness in u, dilated by half a cell, then a
 *   band with the outward normal and the distance in cells (the surface roll and slip).
 * - **Raymarch:** one instanced draw of every visible domain's cube (back faces, so the eye may be inside), marched to
 *   the scene's depth (which holds the water surface), with two octaves of tiling noise for sub-grid detail, the flame
 *   as an emissive medium, smoke lit by the sun (two self-shadow taps) and the sky, and the fog of war's visibility
 *   volume veiling what lies in hidden air. Premultiplied, composited (one, one − alpha). The march visits only the
 *   lattice samples whose filtered footprint reaches the slot's occupied cells (the advection writes their bounds).
 * Fields: velocity rgba16f (xyz), field rgba16f (x smoke, y heat, z fuel, w this step's expansion), curl rgba16f,
 * pressure and divergence r32f, obstacles rgba8snorm (xyz outward normal, w −1 solid else distance in cells / 4).
 */
import { makeModule } from '../../wgsl/module';
import { gasIlluminationWgsl } from './gas-illumination';
import { gasEmissionProfileWgsl } from './gas-emission-profile.wgsl';
import { cubeSphereWgsl } from '../../wgsl/common/cube-sphere.wgsl';
import { frameWgsl } from '../../wgsl/common/frame.wgsl';
import { depthWgsl } from '../../wgsl/common/depth.wgsl';
import { sdfBindingsWgsl, sdfWgsl } from '../sdf/sdf.wgsl';
import { fogParamsBindingWgsl } from '../fog-of-war/fog.wgsl';
import { levelMapAddressWgsl } from './water.wgsl';
import { WATER_MAX_HULLS } from './liquid-params';

/** Floats per slot in the slot buffer (9 vec4). */
export const GAS_SLOT_FLOATS = 36;
/** Hull boxes the obstacle pass reads (the water's hull list). */
export const GAS_MAX_HULLS = WATER_MAX_HULLS;

const gasCommonWgsl = makeModule('gas-common', /* wgsl */ `
struct FireGlobals {
  n: u32,
  slots: u32,
  dt: f32,
  time: f32,
};
struct FireSlot {
  src: vec4f,   // xyz source centre (uv), w source radius (uv)
  a: vec4f,     // x age (sim s), y kind, z strength (emission scale), w seed
  nrm: vec4f,   // xyz impact normal (domain), w blast radius (uv)
  p: vec4f,     // xy wind (uv/s, x and z), z fuel scale, w shell dust per second
  k0: vec4f,    // buoyancy, burn rate, heat per fuel, smoke per fuel
  k1: vec4f,    // decay of smoke, heat, fuel; surface roll
  k2: vec4f,    // impulse outward, along the normal, turbulence; emission seconds
  k3: vec4f,    // smoke, heat, fuel added per second; shell growth
  k4: vec4f,    // expansion per fuel burned per second; burst expansion
};
@group(0) @binding(0) var<uniform> G: FireGlobals;
@group(0) @binding(1) var<storage, read> slots: array<FireSlot>;
@group(0) @binding(2) var<storage, read> slot_list: array<u32>;

fn fire_slot(gz: u32) -> u32 { return slot_list[gz / G.n]; }
fn fire_local(gid: vec3u) -> vec3i { return vec3i(i32(gid.x), i32(gid.y), i32(gid.z % G.n)); }
/** A cell of a slot in atlas texels, clamped INSIDE the slot (zero-gradient boundary). */
fn fire_at(slot: u32, p: vec3i) -> vec3i {
  let m = i32(G.n) - 1;
  let q = clamp(p, vec3i(0), vec3i(m));
  return vec3i(q.x, q.y, q.z + i32(slot) * i32(G.n));
}
fn fire_inside(p: vec3i) -> bool {
  let n = i32(G.n);
  return all(p >= vec3i(0)) && all(p < vec3i(n));
}
/** Normalised atlas coordinates of a slot-local uv, clamped to the slot's half-texel band in z (no bleeding). */
fn fire_suv(slot: u32, uv: vec3f) -> vec3f {
  let n = f32(G.n);
  let z = clamp(uv.z * n, 0.5, n - 0.5);
  return vec3f(clamp(uv.x, 0.0, 1.0), clamp(uv.y, 0.0, 1.0), (f32(slot) * n + z) / (n * f32(G.slots)));
}
fn fire_noise(p: vec3f) -> f32 {
  return sin(p.x * 19.1 + sin(p.z * 17.3)) * sin(p.y * 21.7 + sin(p.x * 13.8));
}
`);

const gasObsHelpersWgsl = makeModule('gas-obs-helpers', /* wgsl */ `
fn fire_solid(obs: texture_3d<f32>, slot: u32, p: vec3i) -> bool {
  if (!fire_inside(p)) { return false; }
  return textureLoad(obs, fire_at(slot, p), 0).w < -0.5;
}
/**
 * The solid neighbours of a cell (bit k: +x, −x, +y, −y, +z, −z; outside the domain is open air), as the advection
 * stores them in the advected velocity's w for the pressure and projection passes: the obstacles do not change during a
 * step, so those passes read one texel instead of re-testing six every Jacobi iteration. FIRE_SELF_SOLID marks a solid cell.
 */
const FIRE_SELF_SOLID: u32 = 64u;
fn fire_walls(obs: texture_3d<f32>, slot: u32, p: vec3i) -> u32 {
  var walls = 0u;
  for (var k = 0u; k < 6u; k++) {
    var o = vec3i(0);
    o[k >> 1u] = select(1, -1, (k & 1u) != 0u);
    if (fire_solid(obs, slot, p + o)) { walls |= 1u << k; }
  }
  return walls;
}
/** A clear straight line (eight cells' worth of samples) between two uvs. */
fn fire_sees(obs: texture_3d<f32>, slot: u32, a: vec3f, b: vec3f) -> bool {
  let n = f32(G.n);
  for (var k = 1u; k < 8u; k++) {
    if (fire_solid(obs, slot, vec3i(floor(mix(a, b, f32(k) * 0.125) * n)))) { return false; }
  }
  return true;
}
`, [gasCommonWgsl]);

/** Curl of the velocity (and its magnitude, for confinement). */
export const gasCurlWgsl = makeModule('gas-curl', /* wgsl */ `
@group(1) @binding(0) var v_in: texture_3d<f32>;
@group(1) @binding(1) var curl_out: texture_storage_3d<rgba16float, write>;
@compute @workgroup_size(4, 4, 4)
fn cs_curl(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= G.n || gid.y >= G.n) { return; }
  let s = fire_slot(gid.z);
  let p = fire_local(gid);
  let x = textureLoad(v_in, fire_at(s, p + vec3i(1, 0, 0)), 0).xyz - textureLoad(v_in, fire_at(s, p - vec3i(1, 0, 0)), 0).xyz;
  let y = textureLoad(v_in, fire_at(s, p + vec3i(0, 1, 0)), 0).xyz - textureLoad(v_in, fire_at(s, p - vec3i(0, 1, 0)), 0).xyz;
  let z = textureLoad(v_in, fire_at(s, p + vec3i(0, 0, 1)), 0).xyz - textureLoad(v_in, fire_at(s, p - vec3i(0, 0, 1)), 0).xyz;
  let w = vec3f(y.z - z.y, z.x - x.z, x.y - y.x) * f32(G.n) * 0.5;
  textureStore(curl_out, fire_at(s, p), vec4f(w, length(w)));
}
`, [gasCommonWgsl]);

/** Advection + sources + combustion + buoyancy + confinement + surfaces. */
export const gasAdvectWgsl = makeModule('gas-advect', /* wgsl */ `
@group(1) @binding(0) var v_in: texture_3d<f32>;
@group(1) @binding(1) var f_in: texture_3d<f32>;
@group(1) @binding(2) var curl_in: texture_3d<f32>;
@group(1) @binding(3) var obs: texture_3d<f32>;
@group(1) @binding(4) var lin: sampler;
@group(1) @binding(5) var v_out: texture_storage_3d<rgba16float, write>;
@group(1) @binding(6) var f_out: texture_storage_3d<rgba16float, write>;
// Per slot: n − lowest and highest + 1 occupied cell per axis (zero: nothing), cleared before each step.
@group(1) @binding(7) var<storage, read_write> occupied: array<atomic<u32>>;

fn fire_occupy(k: u32, v: u32) {
  if (atomicLoad(&occupied[k]) < v) { atomicMax(&occupied[k], v); }
}

@compute @workgroup_size(4, 4, 4)
fn cs_advect(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= G.n || gid.y >= G.n) { return; }
  let s = fire_slot(gid.z);
  let p = fire_local(gid);
  let S = slots[s];
  let n = f32(G.n);
  let dt = G.dt;
  let uv = (vec3f(p) + 0.5) / n;
  let ob = textureLoad(obs, fire_at(s, p), 0);
  if (ob.w < -0.5) {
    textureStore(v_out, fire_at(s, p), vec4f(0.0, 0.0, 0.0, f32(FIRE_SELF_SOLID)));
    textureStore(f_out, fire_at(s, p), vec4f(0.0));
    return;
  }
  // Midpoint backtrace; a backtrace that crosses a solid cell stays home rather than pulling smoke out of the rock.
  let mid = uv - textureLoad(v_in, fire_at(s, p), 0).xyz * dt * 0.5;
  var back = uv - textureSampleLevel(v_in, lin, fire_suv(s, mid), 0.0).xyz * dt;
  for (var k = 1u; k <= 8u; k++) {
    let q = vec3i(floor(mix(uv, back, f32(k) * 0.125) * n));
    if (fire_solid(obs, s, q)) { back = uv; break; }
  }
  var vel = textureSampleLevel(v_in, lin, fire_suv(s, back), 0.0).xyz * exp(-dt * 0.12);
  var f = textureSampleLevel(f_in, lin, fire_suv(s, back), 0.0);

  // Vorticity confinement from the curl pass.
  let cx = textureLoad(curl_in, fire_at(s, p + vec3i(1, 0, 0)), 0).w - textureLoad(curl_in, fire_at(s, p - vec3i(1, 0, 0)), 0).w;
  let cy = textureLoad(curl_in, fire_at(s, p + vec3i(0, 1, 0)), 0).w - textureLoad(curl_in, fire_at(s, p - vec3i(0, 1, 0)), 0).w;
  let cz = textureLoad(curl_in, fire_at(s, p + vec3i(0, 0, 1)), 0).w - textureLoad(curl_in, fire_at(s, p - vec3i(0, 0, 1)), 0).w;
  let grad = vec3f(cx, cy, cz);
  let conf = cross(grad / (length(grad) + 0.0001), textureLoad(curl_in, fire_at(s, p), 0).xyz) * 1.8 / n;

  let age = S.a.x;
  let strength = S.a.z;
  let buoy = S.k0.x;
  // +Y is the radial up: the domain is built that way on the CPU.
  let up = vec3f(0.0, 1.0, 0.0);
  vel += dt * (conf + vec3f(S.p.x, 0.0, S.p.y) + up * (f.y * buoy - f.x * 0.012));
  let nuclear = S.a.y > 2.5 && S.a.y < 3.5;
  let napalm = S.a.y > 3.5 && S.a.y < 4.5;
  let muzzle = S.a.y > 4.5 && S.a.y < 5.5;
  let vehicle = S.a.y > 5.5;
  if (nuclear) { vel *= exp(-dt * 0.45); }

  // The source.
  let delta = uv - S.src.xyz;
  let r = max(S.src.w, 0.01);
  var shape = exp(-dot(delta, delta) / (r * r) * 2.5);
  if (vehicle) {
    // Irregular fuel-fed roots and a buoyant, rolling soot column. Heat dies above the engine bay,
    // while smoke continues to advect. No opaque geometry or stochastic alpha discard.
    let flicker = .72 + .28 * fire_noise(uv * 8.0 + vec3f(0.0, -age * 1.6, S.a.w));
    shape = exp(-dot(delta.xz, delta.xz) / (r * r) * 2.2 - delta.y * delta.y / (r * r * .45)) * flicker;
    vel += up * dt * min(f.x, 2.0) * .10;
    vel *= exp(-dt * .45);
    let cooling = smoothstep(r * 1.3, r * 3.4, delta.y);
    f = vec4f(f.x, f.yz * exp(-dt * cooling * 3.5), f.w);
  }
  if (muzzle) {
    // An axial jet starts at the actual muzzle. Density, momentum and its resulting curl are subsequently
    // transported by the same pressure-projected solver as the blast domains, not animated billboard noise.
    let along = dot(delta, S.nrm.xyz);
    let lateral = delta - S.nrm.xyz * along;
    let axial = (along - r * .45) / (r * 1.7);
    shape = exp(-dot(lateral, lateral) / (r * r) * 2.2 - axial * axial * 1.5)
      * smoothstep(-r * .6, 0.0, along);
    vel *= exp(-dt * .65);
    vel += up * dt * min(f.x, 1.5) * .08;
    // A small toroidal entrainment seeds the leading roll, in the plane perpendicular to this shot's axis.
    let jet_age = min(age, .65);
    let axial_front = along - (.03 + jet_age * .15);
    let lateral_length = length(lateral);
    let radial_front = lateral_length - (r + jet_age * .04);
    let vortex = exp(-(axial_front * axial_front + radial_front * radial_front) / (.0025 + r * r * .3));
    vel += dt * vortex * (lateral / (lateral_length + .001) * axial_front - S.nrm.xyz * radial_front)
      * 5.0 * (1.0 - smoothstep(.2, .9, age));
  }
  if (napalm) {
    // Replenish fuel on the actual obstacle surface, not at a floating point.
    // The expanding footprint follows crater floors and banks on the sphere.
    let spread = S.nrm.w * (0.6 + 0.8 * smoothstep(0.0, 1.5, age));
    let footprint = 1.0 - smoothstep(spread * 0.65, spread, length(delta.xz));
    let surface = (1.0 - smoothstep(0.2, 1.8, max(ob.w, 0.0) * 4.0)) * smoothstep(0.25, 0.8, ob.y);
    shape = footprint * surface * (0.75 + 0.25 * fire_noise(uv * 4.0));
    vel *= exp(-dt * 2.4);
    // Smoke can rise; hot fuel burns close to the ground instead of a rocket trail.
    let loft = smoothstep(1.5, 5.0, max(ob.w, 0.0) * 4.0);
    f = vec4f(f.x, f.yz * exp(-dt * loft * 3.0), f.w);
    vel += up * dt * min(f.x, 2.0) * 0.12;
  }
  let variation = select(0.0, S.a.w * .037, muzzle);
  let perturb = vec3f(fire_noise(uv + age * 0.2 + variation), fire_noise(uv.yzx + 2.0 + age * 0.13 + variation), fire_noise(uv.zxy + 4.0 - age * 0.17 + variation));
  // Emission: a burst (emit_s > 0), continuous (0), or continuous for |emit_s| seconds, then fading over 3 s (< 0).
  let emit_s = S.k2.w;
  var emit = strength;
  if (emit_s > 0.0) { emit = strength * (1.0 - smoothstep(0.0, emit_s, age)); }
  else if (emit_s < 0.0) { emit = strength * (1.0 - smoothstep(-emit_s, -emit_s + 3.0, age)); }
  let radial_s = delta / (length(delta) + 0.03);
  // Outward from the centre and along the impact normal: a blast bursts out of the surface it hit.
  let impulse = radial_s * S.k2.x + S.nrm.xyz * S.k2.y + perturb * S.k2.z;
  vel += dt * shape * emit * impulse;
  let add = vec4f(S.k3.x, S.k3.y, S.k3.z * S.p.z, 0.0);
  f += dt * shape * emit * (0.8 + 0.4 * fire_noise(uv * 2.7 + age)) * add;

  // Surfaces: the obstacle band carries an outward normal. A blast's expanding shell raises dust and a little heat
  // along whatever it hit (the fire rolls along the ground and walls); friction slows the flow there and no flow enters.
  let nrm = ob.xyz;
  if (length(nrm) > 0.5) {
    let dist_cells = max(ob.w, 0.0) * 4.0;
    let near_surface = 1.0 - smoothstep(0.25, 1.7, dist_cells);
    let roll = S.k1.w;
    if (roll > 0.0) {
      let off = (uv - S.src.xyz) / max(S.nrm.w, 0.001);
      let dd = length(off);
      let radial = off / max(dd, 0.001);
      let tangent = radial - nrm * dot(radial, nrm);
      let shell = exp(-pow((dd - (0.3 + min(age, 0.8) * S.k3.w)) / 0.38, 2.0)) * (1.0 - smoothstep(0.7, 1.7, age));
      var contact = near_surface * shell * (0.75 + 0.25 * fire_noise(uv * 3.0 + age)) * strength;
      // Only surfaces the blast can reach: facing it, with a clear line back to it through the obstacle mask.
      if (contact > 0.001) {
        let back_dir = S.src.xyz - uv;
        if (dot(nrm, back_dir) < -0.02 || !fire_sees(obs, s, uv + nrm * (1.0 / n), S.src.xyz)) { contact = 0.0; }
      }
      f.x += dt * contact * S.p.w;
      f.y += dt * contact * 0.8;
      vel += dt * contact * (tangent * roll + nrm * 0.12);
    }
    vel *= exp(-dt * near_surface * 0.35);
    if (near_surface > 0.05) { vel -= nrm * min(0.0, dot(vel, nrm)); }
  }

  if (nuclear) {
    // Toroidal entrainment from the archived nuclear study. These forces seed
    // the cap and stem; advection and pressure evolve all density and temperature.
    let horizontal = delta.xz;
    let radial = length(horizontal);
    let growth = 1.0 - exp(-age * 0.28);
    let height = 0.06 + 0.43 * growth;
    let ring_r = 0.06 + 0.20 * growth;
    let dy = delta.y - height; let dr = radial - ring_r;
    let thickness = 0.045 + 0.045 * growth;
    let roll = exp(-(dr * dr + dy * dy) / (thickness * thickness));
    let sustain = smoothstep(0.2, 1.0, age) * (1.0 - smoothstep(7.0, 12.0, age));
    let outward = horizontal / (radial + 0.001);
    vel += dt * roll * vec3f(outward.x * dy, -dr, outward.y * dy) * 9.0;
    // A wide rolling crown above a narrow rising stem is the defining silhouette.
    // These sources seed the turbulent simulation rather than drawing a solid mesh.
    let cap = exp(-pow(dy / (thickness * 0.85), 2.0)) * (1.0 - smoothstep(ring_r, ring_r + thickness, radial));
    let lobes = 0.6 + 0.4 * fire_noise(uv * 3.0 + S.a.w);
    f.x += dt * (roll * 1.1 + cap * 0.5) * sustain * lobes;
    f.y += dt * cap * 3.0 * (1.0 - smoothstep(1.5, 4.0, age));
    // Extend down below the impact point: the actual crater floor is lower after
    // carving. The obstacle mask clips the stem to ground instead of an air plane.
    let stem = exp(-radial * radial / 0.0018) * (1.0 - smoothstep(height - 0.05, height + 0.02, delta.y));
    f.x += dt * stem * 1.9 * sustain;
    vel += up * dt * stem * 0.12;
    f = vec4f(f.x, f.yz * exp(-dt * (1.0 - smoothstep(0.04, 0.13, delta.y)) * smoothstep(0.7, 2.0, age) * 1.6), f.w);
    let base_clear = (1.0 - smoothstep(0.04, 0.19, delta.y)) * (1.0 - exp(-radial * radial / 0.003)) * smoothstep(1.0, 3.0, age);
    f.x *= exp(-dt * base_clear * 2.5);
    let neck_clear = (1.0 - smoothstep(height - 0.13, height - 0.05, delta.y)) * smoothstep(0.045, 0.12, radial);
    f.x *= exp(-dt * neck_clear * sustain * 1.6);
  }
  // Combustion: hot fuel burns into heat and smoke.
  let burned = min(f.z, dt * S.k0.y * smoothstep(select(0.08, 0.02, nuclear), select(0.45, 0.20, nuclear), f.y));
  f.z -= burned;
  f.y += burned * S.k0.z;
  f.x += burned * S.k0.w;
  f.x *= exp(-dt * S.k1.x);
  f.y *= exp(-dt * S.k1.y);
  f.z *= exp(-dt * S.k1.z);

  // Open sides and top dissipate what leaves the domain.
  let edge_absorb = smoothstep(0.32, 0.49, length(uv.xz - vec2f(0.5))) + smoothstep(0.76, 0.99, uv.y);
  f *= exp(-dt * edge_absorb * 12.0) * smoothstep(0.0, 0.025, uv.y);
  // w is not transported: it is this step's gas expansion (1/s), for the divergence pass.
  var burst = 0.0;
  if (emit_s > 0.0) { burst = shape * emit * S.k4.y; }
  let expansion = min(burned / dt * S.k4.x + burst, 40.0);
  let stored = clamp(f.xyz, vec3f(0.0), vec3f(8.0));
  textureStore(v_out, fire_at(s, p), vec4f(clamp(vel, vec3f(-1.5), vec3f(1.5)), f32(fire_walls(obs, s, p))));
  textureStore(f_out, fire_at(s, p), vec4f(stored, expansion));
  // The raymarch skips samples below 0.004 smoke + heat; 0.0038 leaves room for the half-float store (and a NaN counts).
  if (!(stored.x + stored.y < 0.0038)) {
    let q = vec3u(p);
    for (var axis = 0u; axis < 3u; axis++) {
      fire_occupy(s * 8u + axis, G.n - q[axis]);
      fire_occupy(s * 8u + 4u + axis, q[axis] + 1u);
    }
  }
}
`, [gasCommonWgsl, gasObsHelpersWgsl]);

/** Divergence of the advected velocity, less the gas expansion (in cell units: the true divergence / n²). */
export const gasDivergenceWgsl = makeModule('gas-divergence', /* wgsl */ `
@group(1) @binding(0) var v_in: texture_3d<f32>;
@group(1) @binding(1) var div_out: texture_storage_3d<r32float, write>;
@group(1) @binding(2) var f_in: texture_3d<f32>;
@compute @workgroup_size(4, 4, 4)
fn cs_divergence(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= G.n || gid.y >= G.n) { return; }
  let s = fire_slot(gid.z);
  let p = fire_local(gid);
  let d = (textureLoad(v_in, fire_at(s, p + vec3i(1, 0, 0)), 0).x - textureLoad(v_in, fire_at(s, p - vec3i(1, 0, 0)), 0).x
    + textureLoad(v_in, fire_at(s, p + vec3i(0, 1, 0)), 0).y - textureLoad(v_in, fire_at(s, p - vec3i(0, 1, 0)), 0).y
    + textureLoad(v_in, fire_at(s, p + vec3i(0, 0, 1)), 0).z - textureLoad(v_in, fire_at(s, p - vec3i(0, 0, 1)), 0).z)
    * 0.5 / f32(G.n);
  let e = textureLoad(f_in, fire_at(s, p), 0).w / (f32(G.n) * f32(G.n));
  textureStore(div_out, fire_at(s, p), vec4f(d - e, 0.0, 0.0, 0.0));
}
`, [gasCommonWgsl]);

const gasWallWgsl = makeModule('gas-wall', /* wgsl */ `
/** Past the domain is open air at rest (p = 0); a solid neighbour (bit k of the walls mask) is a wall: it reads the centre's pressure. */
fn wall_p(p_tex: texture_3d<f32>, walls: u32, k: u32, s: u32, q: vec3i, c: f32) -> f32 {
  if (!fire_inside(q)) { return 0.0; }
  if ((walls & (1u << k)) != 0u) { return c; }
  return textureLoad(p_tex, fire_at(s, q), 0).x;
}
`, [gasCommonWgsl, gasObsHelpersWgsl]);

/** One Jacobi relaxation of the pressure (warm-started from the last step). */
export const gasPressureWgsl = makeModule('gas-pressure', /* wgsl */ `
@group(1) @binding(0) var p_in: texture_3d<f32>;
@group(1) @binding(1) var div_in: texture_3d<f32>;
@group(1) @binding(2) var walls_in: texture_3d<f32>;   // the advected velocity: w holds the walls mask
@group(1) @binding(3) var p_out: texture_storage_3d<r32float, write>;
@compute @workgroup_size(4, 4, 4)
fn cs_pressure(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= G.n || gid.y >= G.n) { return; }
  let s = fire_slot(gid.z);
  let p = fire_local(gid);
  let walls = u32(textureLoad(walls_in, fire_at(s, p), 0).w);
  if ((walls & FIRE_SELF_SOLID) != 0u) { textureStore(p_out, fire_at(s, p), vec4f(0.0)); return; }
  let c = textureLoad(p_in, fire_at(s, p), 0).x;
  let sum = wall_p(p_in, walls, 0u, s, p + vec3i(1, 0, 0), c) + wall_p(p_in, walls, 1u, s, p - vec3i(1, 0, 0), c)
    + wall_p(p_in, walls, 2u, s, p + vec3i(0, 1, 0), c) + wall_p(p_in, walls, 3u, s, p - vec3i(0, 1, 0), c)
    + wall_p(p_in, walls, 4u, s, p + vec3i(0, 0, 1), c) + wall_p(p_in, walls, 5u, s, p - vec3i(0, 0, 1), c);
  textureStore(p_out, fire_at(s, p), vec4f((sum - textureLoad(div_in, fire_at(s, p), 0).x) / 6.0, 0.0, 0.0, 0.0));
}
`, [gasCommonWgsl, gasObsHelpersWgsl, gasWallWgsl]);

/** Subtract the pressure gradient; walls take no flow into them, and a surface near the cell slips the flow along it. */
export const gasProjectWgsl = makeModule('gas-project', /* wgsl */ `
@group(1) @binding(0) var v_in: texture_3d<f32>;
@group(1) @binding(1) var p_in: texture_3d<f32>;
@group(1) @binding(2) var obs: texture_3d<f32>;
@group(1) @binding(3) var v_out: texture_storage_3d<rgba16float, write>;
@compute @workgroup_size(4, 4, 4)
fn cs_project(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= G.n || gid.y >= G.n) { return; }
  let s = fire_slot(gid.z);
  let p = fire_local(gid);
  let ob = textureLoad(obs, fire_at(s, p), 0);
  if (ob.w < -0.5) { textureStore(v_out, fire_at(s, p), vec4f(0.0)); return; }
  let advected = textureLoad(v_in, fire_at(s, p), 0);
  let walls = u32(advected.w);
  let c = textureLoad(p_in, fire_at(s, p), 0).x;
  let grad = vec3f(
    wall_p(p_in, walls, 0u, s, p + vec3i(1, 0, 0), c) - wall_p(p_in, walls, 1u, s, p - vec3i(1, 0, 0), c),
    wall_p(p_in, walls, 2u, s, p + vec3i(0, 1, 0), c) - wall_p(p_in, walls, 3u, s, p - vec3i(0, 1, 0), c),
    wall_p(p_in, walls, 4u, s, p + vec3i(0, 0, 1), c) - wall_p(p_in, walls, 5u, s, p - vec3i(0, 0, 1), c)) * 0.5 * f32(G.n);
  var vel = advected.xyz - grad;
  for (var axis = 0u; axis < 3u; axis++) {
    if ((walls & (1u << (axis * 2u))) != 0u) { vel[axis] = min(0.0, vel[axis]); }
    if ((walls & (2u << (axis * 2u))) != 0u) { vel[axis] = max(0.0, vel[axis]); }
  }
  if (length(ob.xyz) > 0.5 && ob.w * 4.0 < 1.2) { vel -= ob.xyz * min(0.0, dot(vel, ob.xyz)); }
  textureStore(v_out, fire_at(s, p), vec4f(vel, 0.0));
}
`, [gasCommonWgsl, gasObsHelpersWgsl, gasWallWgsl]);

/** Zero a new slot's state (the clear list rides the slot_list binding). Two pipelines: four storage textures at most. */
export const gasClearRgbaWgsl = makeModule('gas-clear-rgba', /* wgsl */ `
@group(1) @binding(0) var o0: texture_storage_3d<rgba16float, write>;
@group(1) @binding(1) var o1: texture_storage_3d<rgba16float, write>;
@group(1) @binding(2) var o2: texture_storage_3d<rgba16float, write>;
@group(1) @binding(3) var o3: texture_storage_3d<rgba16float, write>;
@compute @workgroup_size(4, 4, 4)
fn cs_clear_rgba(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= G.n || gid.y >= G.n) { return; }
  let t = fire_at(fire_slot(gid.z), fire_local(gid));
  textureStore(o0, t, vec4f(0.0));
  textureStore(o1, t, vec4f(0.0));
  textureStore(o2, t, vec4f(0.0));
  textureStore(o3, t, vec4f(0.0));
}
`, [gasCommonWgsl]);
export const gasClearRWgsl = makeModule('gas-clear-r', /* wgsl */ `
@group(1) @binding(0) var o0: texture_storage_3d<r32float, write>;
@group(1) @binding(1) var o1: texture_storage_3d<r32float, write>;
@compute @workgroup_size(4, 4, 4)
fn cs_clear_r(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= G.n || gid.y >= G.n) { return; }
  let t = fire_at(fire_slot(gid.z), fire_local(gid));
  textureStore(o0, t, vec4f(0.0));
  textureStore(o1, t, vec4f(0.0));
}
`, [gasCommonWgsl]);

/**
 * Obstacles, pass 1: the solidness at each cell centre in u (positive inside): the planet SDF with pending craters, the
 * water below its surface (from the water's atlas), and every hull box. Written into the divergence texture's slot band,
 * free until the solver's divergence pass later in the same compute pass.
 */
export const gasObsDensityWgsl = makeModule('gas-obs-density', /* wgsl */ `
struct GasGeom {
  center: vec4f,    // xyz world centre, w edge (u)
  right: vec4f,
  up: vec4f,
  fwd: vec4f,
};
struct GasObsParams {
  counts: vec4u,                              // x hulls, y water grid N, z water present, w fallback planet radius in mm
  hulls: array<vec4f, ${GAS_MAX_HULLS * 4}>,  // per hull: centre + reach, then three axes with their half extents
};
@group(1) @binding(0) var<storage, read> geom: array<GasGeom>;
@group(1) @binding(1) var solid_out: texture_storage_3d<r32float, write>;
@group(1) @binding(2) var<uniform> OP: GasObsParams;
@group(1) @binding(3) var water_a: texture_2d<f32>;

@compute @workgroup_size(4, 4, 4)
fn cs_obs_density(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= G.n || gid.y >= G.n) { return; }
  let s = fire_slot(gid.z);
  let p = fire_local(gid);
  let g = geom[s];
  let edge = g.center.w;
  let q = ((vec3f(p) + 0.5) / f32(G.n) - 0.5) * edge;
  let w = g.center.xyz + g.right.xyz * q.x + g.up.xyz * q.y + g.fwd.xyz * q.z;
  // Analytic/inspection worlds have no resident pages yet. Do not freeze a burning vehicle's solver there.
  var solid = f32(OP.counts.w) * .001 - length(w);
  if (sdf_valid()) { solid = -sdf_sample(w); }
  // Water is solid below its surface: smoke rolls over it.
  if (OP.counts.z > 0u) {
    let d = normalize(w);
    let a = textureLoad(water_a, vec2i(floor(lm_atlas_px(d, f32(OP.counts.y)))), 0);
    if (a.x > 0.0 && a.z > 0.02) { solid = max(solid, a.x - length(w)); }
  }
  for (var h = 0u; h < OP.counts.x; h++) {
    let head = OP.hulls[h * 4u];
    let rel = w - head.xyz;
    if (length(rel) > head.w + 0.5) { continue; }
    let ax = OP.hulls[h * 4u + 1u];
    let ay = OP.hulls[h * 4u + 2u];
    let az = OP.hulls[h * 4u + 3u];
    let e = abs(vec3f(dot(rel, ax.xyz), dot(rel, ay.xyz), dot(rel, az.xyz))) - vec3f(ax.w, ay.w, az.w);
    let sd = length(max(e, vec3f(0.0))) + min(max(e.x, max(e.y, e.z)), 0.0);
    solid = max(solid, -sd);
  }
  textureStore(solid_out, fire_at(s, p), vec4f(solid, 0.0, 0.0, 0.0));
}
`, [gasCommonWgsl, cubeSphereWgsl, levelMapAddressWgsl, sdfBindingsWgsl(2, { volume: 0, params: 1, sampler: 2 }), sdfWgsl]);

/** Obstacles, pass 2: the solid mask (dilated by half a cell), and in the air the outward normal and the distance. */
export const gasObsBandWgsl = makeModule('gas-obs-band', /* wgsl */ `
struct GasGeomB {
  center: vec4f,
  right: vec4f,
  up: vec4f,
  fwd: vec4f,
};
@group(1) @binding(0) var solid_in: texture_3d<f32>;
@group(1) @binding(1) var<storage, read> geom_b: array<GasGeomB>;
@group(1) @binding(2) var obs_out: texture_storage_3d<rgba8snorm, write>;
@compute @workgroup_size(4, 4, 4)
fn cs_obs_band(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= G.n || gid.y >= G.n) { return; }
  let s = fire_slot(gid.z);
  let p = fire_local(gid);
  let c = textureLoad(solid_in, fire_at(s, p), 0).x;
  let cell0 = geom_b[s].center.w / f32(G.n);
  // Dilated by half a cell: a wall thinner than a cell still closes the cells it passes through.
  if (c > -0.5 * cell0) { textureStore(obs_out, fire_at(s, p), vec4f(0.0, 0.0, 0.0, -1.0)); return; }
  let gx = textureLoad(solid_in, fire_at(s, p + vec3i(1, 0, 0)), 0).x - textureLoad(solid_in, fire_at(s, p - vec3i(1, 0, 0)), 0).x;
  let gy = textureLoad(solid_in, fire_at(s, p + vec3i(0, 1, 0)), 0).x - textureLoad(solid_in, fire_at(s, p - vec3i(0, 1, 0)), 0).x;
  let gz = textureLoad(solid_in, fire_at(s, p + vec3i(0, 0, 1)), 0).x - textureLoad(solid_in, fire_at(s, p - vec3i(0, 0, 1)), 0).x;
  let g = vec3f(gx, gy, gz);
  let dist_cells = max(-c / max(cell0, 0.0001) - 0.5, 0.0);
  var nrm = vec3f(0.0);
  if (length(g) > 1e-6 && dist_cells < 4.0) { nrm = -normalize(g); }
  textureStore(obs_out, fire_at(s, p), vec4f(nrm, clamp(dist_cells / 4.0, 0.0, 1.0)));
}
`, [gasCommonWgsl]);

/** The raymarch: one instance per visible domain, drawn in the transparent pass (frame uniforms at group 0). */
export const gasRaymarchWgsl = makeModule('gas-raymarch', /* wgsl */ `
struct GasRender {
  info: vec4f,      // x n (cells per edge), y slots, z samples per cell, w max samples
  look: vec4f,      // x detail frequency (tiles per domain), y erosion, z flame opacity, w smoke opacity
  look2: vec4f,     // x warp (uv), y fine octave weight, z smoke glow from the flame, w emission scale
  misc: vec4f,      // x time (s), y veil (1 = hidden air hides gas), zw unused
};
struct GasInst {
  center: vec4f,    // xyz world centre, w edge (u)
  right: vec4f,     // xyz, w slot
  up: vec4f,        // xyz, w fade
  fwd: vec4f,       // xyz, w age (s)
  tone: vec4f,      // x smoke albedo, y steam (1 = white steam, no soot), zw unused
};
@group(1) @binding(0) var<uniform> R: GasRender;
@group(1) @binding(1) var<storage, read> insts: array<GasInst>;
@group(1) @binding(2) var field: texture_3d<f32>;
@group(1) @binding(3) var lin: sampler;
@group(1) @binding(4) var depth_tex: texture_depth_2d;
@group(1) @binding(5) var noise_tex: texture_3d<f32>;
@group(1) @binding(6) var rep: sampler;
@group(1) @binding(7) var obs_tex: texture_3d<f32>;
@group(1) @binding(8) var fog_volume: texture_3d<f32>;
@group(1) @binding(10) var<storage, read> occupied: array<vec4u>;   // per slot: n − lowest, highest + 1 occupied cell (0: none)

const CUBE_P = array<vec3f, 8>(
  vec3f(-0.5, -0.5, -0.5), vec3f(0.5, -0.5, -0.5), vec3f(0.5, 0.5, -0.5), vec3f(-0.5, 0.5, -0.5),
  vec3f(-0.5, -0.5, 0.5), vec3f(0.5, -0.5, 0.5), vec3f(0.5, 0.5, 0.5), vec3f(-0.5, 0.5, 0.5),
);
const CUBE_I = array<u32, 36>(
  0u, 2u, 1u, 0u, 3u, 2u,   4u, 5u, 6u, 4u, 6u, 7u,   0u, 1u, 5u, 0u, 5u, 4u,
  3u, 6u, 2u, 3u, 7u, 6u,   0u, 4u, 7u, 0u, 7u, 3u,   1u, 2u, 6u, 1u, 6u, 5u,
);

fn gas_suv(slot: u32, uv: vec3f) -> vec3f {
  let n = R.info.x;
  let z = clamp(uv.z * n, 0.5, n - 0.5);
  return vec3f(clamp(uv.x, 0.0, 1.0), clamp(uv.y, 0.0, 1.0), (f32(slot) * n + z) / (n * R.info.y));
}
fn gas_to_domain(I: GasInst, v: vec3f) -> vec3f { return vec3f(dot(v, I.right.xyz), dot(v, I.up.xyz), dot(v, I.fwd.xyz)); }
/**
 * The ray parameters (domain units, from o in slot uv) where a sample's filtered footprint can reach the slot's occupied
 * cells: a sample at x texels filters cells floor(x − 0.5) and the next, so it reaches [lo, hi] only from
 * x ∈ [lo − 0.5, hi + 1.5); a box at the domain's edge extends past it (the lookups clamp), and a hundredth of a cell
 * covers rounding. Empty (x > y) when nothing is occupied.
 */
fn gas_occupied_span(slot: u32, o: vec3f, rd: vec3f, n: f32) -> vec2f {
  let top = occupied[slot * 2u + 1u].xyz;
  if (any(top == vec3u(0u))) { return vec2f(1.0, 0.0); }
  let lo = n - vec3f(occupied[slot * 2u].xyz);
  let hi = vec3f(top) - 1.0;
  let bmin = select((lo - 0.51) / n, vec3f(-1e6), lo < vec3f(1.5));
  let bmax = select((hi + 1.51) / n, vec3f(1e6), hi > vec3f(n - 2.5));
  let safe = select(vec3f(0.00001), rd, abs(rd) > vec3f(0.00001));
  let a = (bmin - o) / safe;
  let b = (bmax - o) / safe;
  let near = min(a, b);
  let far = max(a, b);
  return vec2f(max(max(near.x, near.y), near.z), min(min(far.x, far.y), far.z));
}

struct GasVo {
  @builtin(position) pos: vec4f,
  @location(0) q: vec3f,
  @location(1) @interpolate(flat) inst: u32,
}

@vertex fn vs_gas(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> GasVo {
  let I = insts[ii];
  let q = CUBE_P[CUBE_I[vi]];
  let world = I.center.xyz + (I.right.xyz * q.x + I.up.xyz * q.y + I.fwd.xyz * q.z) * I.center.w;
  let c = frame.view_proj * vec4f(world, 1.0);
  var o: GasVo;
  // The depth test is done by hand against the scene: keep z inside the clip volume (a vertex behind the eye still
  // clips by w).
  o.pos = vec4f(c.xy, max(c.w, 0.0) * 0.5, c.w);
  o.q = q;
  o.inst = ii;
  return o;
}

@fragment fn fs_gas(v: GasVo) -> @location(0) vec4f {
  let I = insts[v.inst];
  let edge = I.center.w;
  let eye = gas_to_domain(I, frame.eye_pos - I.center.xyz) / edge;
  let rd = normalize(v.q - eye);
  let safe = select(vec3f(0.00001), rd, abs(rd) > vec3f(0.00001));
  let a = (vec3f(-0.5) - eye) / safe;
  let b = (vec3f(0.5) - eye) / safe;
  let lo = min(a, b);
  let hi = max(a, b);
  let t0 = max(max(max(lo.x, lo.y), lo.z), 0.0);
  var t1 = min(min(hi.x, hi.y), hi.z);
  // The opaque scene, the water surface included (its depth is in the scene depth by now).
  let size = frame_internal_size();
  let px = clamp(vec2i(v.pos.xy), vec2i(0), vec2i(size) - 1);
  let d = textureLoad(depth_tex, px, 0);
  if (d > 0.0) {
    let uv = (vec2f(px) + 0.5) / size;
    t1 = min(t1, length(world_pos_from_depth(uv, d) - frame.eye_pos) / edge);
  }
  if (t1 <= t0) { discard; }
  let n = R.info.x;
  let len = t1 - t0;
  let steps = clamp(ceil(len * n * R.info.z), 3.0, R.info.w);
  let dt = len / steps;
  let jitter = fract(52.9829189 * fract(dot(v.pos.xy, vec2f(0.06711056, 0.00583715))) + R.misc.x * 0.618034);
  let slot = u32(I.right.w + 0.5);
  // Every sample outside the occupied span fails the coarse test below: march only the lattice's samples inside it (a
  // sample of margin each way), which leaves the result unchanged; a ray that misses it adds nothing.
  let span = gas_occupied_span(slot, eye + 0.5, rd, n);
  let first = max(ceil((span.x - t0) / dt - jitter) - 1.0, 0.0);
  let last = min(floor((span.y - t0) / dt - jitter) + 2.0, steps);
  if (first >= last) { discard; }
  let age = I.fwd.w;
  let sun = gas_to_domain(I, frame.sun_dir);
  let world_rd=I.right.xyz*rd.x+I.up.xyz*rd.y+I.fwd.xyz*rd.z;
  var illumination:GasIllumination;
  var light_t=-1e9;
  var lights=vec2u(0u);
  var lights_found=false;
  let steam = I.tone.y;
  var T = 1.0;
  var col = vec3f(0.0);
  for (var i = first; i < last; i += 1.0) {
    if (T < 0.02) { break; }
    let uvw = eye + rd * (t0 + (i + jitter) * dt) + 0.5;
    let coarse = textureSampleLevel(field, lin, gas_suv(slot, uvw), 0.0);
    if (coarse.x + coarse.y < 0.004) { continue; }
    // Nothing glows inside a solid, and the gas thins smoothly toward one (filtered: a hard per-cell test drew the
    // cell layers where a curved surface, the water's, crosses the domain).
    let solid_fade = smoothstep(-0.55, 0.05, textureSampleLevel(obs_tex, lin, gas_suv(slot, uvw), 0.0).w);
    if (solid_fade <= 0.0) { continue; }
    // A rounded absorbing region prevents the simulation box ever reading as a
    // square smoke wall, including noise-warped samples near the atlas boundary.
    var fade = (1.0 - smoothstep(0.32, 0.48, length(uvw.xz - vec2f(0.5))))
      * (1.0 - smoothstep(0.76, 0.98, uvw.y)) * smoothstep(0.0, 0.025, uvw.y) * solid_fade;
    // Hidden air veils the gas, as the war fog's mist does.
    if (R.misc.y > 0.5 && fog_params.settings.x > 0.5) {
      let world = I.center.xyz + (I.right.xyz * (uvw.x - 0.5) + I.up.xyz * (uvw.y - 0.5) + I.fwd.xyz * (uvw.z - 0.5)) * edge;
      fade *= 1.0 - textureSampleLevel(fog_volume, lin, world * (0.5 / fog_params.volume.y) + 0.5, 0.0).r;
    }
    let drift = vec3f(0.03, -0.55, 0.07) * age;
    let nz = textureSampleLevel(noise_tex, rep, uvw * R.look.x + drift, 0.0);
    let nz2 = textureSampleLevel(noise_tex, rep, uvw * R.look.x * 2.7 + drift * 1.9 + nz.yzw * 0.4, 0.0);
    let detail = mix(nz.x, nz2.x, R.look2.y);
    let f = textureSampleLevel(field, lin, gas_suv(slot, uvw + (nz.yzw - 0.5) * R.look2.x), 0.0);
    let ero = (1.0 - detail) * R.look.y;
    let sn = 1.0 - exp(-f.x);
    let smoke = max(0.0, (sn - ero) / max(1.0 - ero, 0.05)) * fade;
    let heat = gas_flame_heat(f.y, ero, fade, steam);
    let e = smoothstep(0.04, 0.35, heat);
    let ramp = gas_flame_ramp(heat);
    let soot = smoothstep(0.01, 0.2, heat);
    let sigma = smoke * R.look.w + soot * R.look.z;
    if (sigma < 0.01) { continue; }
    let opacity = 1.0 - exp(-sigma * dt);
    var lit = 0.0;
    if (smoke > 0.004) {
      // Reuse only over a short ray segment, never between frames or domains.
      // Sampling the live world position lets a rising plume cross the terminator or emerge from a crater shadow.
      let t=(t0+(i+jitter)*dt)*edge;
      if(t-light_t>=min(0.2,dt*edge*4.0)){
        if(!lights_found){lights=gas_light_candidates(frame.eye_pos,world_rd,(t0+first*dt)*edge,(t0+last*dt)*edge);lights_found=true;}
        illumination=gas_illumination(frame.eye_pos+world_rd*t,world_rd,lights);light_t=t;
      }
      let sh = textureSampleLevel(field, lin, gas_suv(slot, uvw + sun * 0.05), 0.0).x
             + textureSampleLevel(field, lin, gas_suv(slot, uvw + sun * 0.14), 0.0).x;
      lit = exp(-sh * 3.0) * (0.6 + detail * 0.6);
    }
    let glow = ramp * smoothstep(0.0, 0.3, heat) * R.look2.z;
    let smoke_col = (illumination.sun * lit + illumination.fill) * I.tone.x + glow;
    let smoke_frac = select(0.0, smoke * R.look.w / sigma, sigma > 0.0);
    col += T * (opacity * smoke_col * smoke_frac + ramp * e * (0.5 + detail) * dt * R.look2.w);
    T *= 1.0 - opacity;
  }
  let alpha = (1.0 - T) * I.up.w;
  return vec4f(col * I.up.w, alpha);
}
`, [frameWgsl, depthWgsl, fogParamsBindingWgsl(1, 9), gasIlluminationWgsl, gasEmissionProfileWgsl]);

/** A tiling 3D noise for the raymarch's sub-grid detail: x a two-octave value noise, yzw independent warps. */
export function buildGasNoise(size = 32): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(size * size * size * 4));
  const hash = (x: number, y: number, z: number, c: number): number => {
    let h = (Math.imul(x & (size - 1), 0x27d4eb2d) ^ Math.imul(y & (size - 1), 0x165667b1)
      ^ Math.imul(z & (size - 1), 0x9e3779b1) ^ Math.imul(c + 1, 0x85ebca6b)) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
    return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
  };
  const ease = (t: number) => t * t * (3 - 2 * t);
  const value = (x: number, y: number, z: number, cell: number, c: number): number => {
    const fx = x / cell, fy = y / cell, fz = z / cell;
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    const ux = ease(fx - ix), uy = ease(fy - iy), uz = ease(fz - iz);
    const period = size / cell;
    const h = (a: number, b: number, d: number) => hash(((ix + a) % period) * cell, ((iy + b) % period) * cell, ((iz + d) % period) * cell, c);
    const l = (p: number, q: number, t: number) => p + (q - p) * t;
    return l(
      l(l(h(0, 0, 0), h(1, 0, 0), ux), l(h(0, 1, 0), h(1, 1, 0), ux), uy),
      l(l(h(0, 0, 1), h(1, 0, 1), ux), l(h(0, 1, 1), h(1, 1, 1), ux), uy), uz);
  };
  for (let z = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const o = ((z * size + y) * size + x) * 4;
    for (let c = 0; c < 4; c++) {
      const v = value(x, y, z, 8, c) * 0.62 + value(x, y, z, 4, c + 7) * 0.38;
      out[o + c] = Math.max(0, Math.min(255, Math.round(v * 255)));
    }
  }
  return out;
}
