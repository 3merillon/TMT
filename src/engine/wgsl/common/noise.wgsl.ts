// Ported from Pinionfall src/gpu/material-noise.ts and src/gpu/triplanar-perturb-wgsl.ts (MIT, same owner)
/*!
 * The periodic tile noise (`tile_hash`, `tile_noise`, `tile_fbm`, `tile_worley`) adapts the modular Worley/domain-warp
 * ideas of looptile. MIT License — Copyright (c) 2026 3merillon.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
 * persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice
 * and this permission notice shall be included in all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
 * WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 * COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 * OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
/**
 * Engine noise single sources (plan §4.1 `wgsl/common/noise.wgsl.ts`).
 *
 * - `materialNoiseWgsl`: Pinionfall's hash-based 3-D value noise (`mn_hash3`, `mn_value3`, `mat_noise`), one rotated
 *   octave per call with a quintic fade (C², no lattice creases). It replaced a sum-of-sinusoids field whose four plane
 *   waves drew crop rows through every biome. TS mirrors below; tests/engine-terrain-wgsl.test.ts compares them.
 * - `tileNoiseWgsl`: PERIODIC 2-D value noise, fbm and Worley on an integer period (the terrain layer bake's tiles wrap
 *   seamlessly because every lattice lookup is taken modulo the period).
 * - `triplanarPerturbWgsl`: the one mapping from a tangent-space normal-map sample to a local perturbation for the yz / xz /
 *   xy planes (OpenGL-style maps: +Y is image-up = −V). The terrain surface keeps its own signed-axis convention.
 */
import { makeModule } from '../module';

/** σ gain that keeps `mat_noise` on the legacy field's distribution (Pinionfall MAT_NOISE_SIGMA_GAIN, measured). */
export const MAT_NOISE_SIGMA_GAIN = 0.907;

export const materialNoiseWgsl = makeModule('material-noise', /* wgsl */ `
fn mn_hash3(ix: i32, iy: i32, iz: i32, salt: u32) -> f32 {
  var h = u32(ix + 1048576) * 0x27D4EB2Du;
  h = h ^ (u32(iy + 1048576) * 0x9E3779B1u);
  h = (h ^ (h >> 15u)) * 0x85EBCA6Bu;
  h = h ^ (u32(iz + 1048576) * 0xC2B2AE35u);
  h = h ^ salt;
  h = (h ^ (h >> 13u)) * 0xC2B2AE35u;
  h = h ^ (h >> 16u);
  return f32(h & 0xFFFFFFu) / f32(0xFFFFFFu);
}

fn mn_fade(t: vec3f) -> vec3f { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }

fn mn_value3(p: vec3f, salt: u32) -> f32 {
  let pf = floor(p);
  let ix = i32(pf.x); let iy = i32(pf.y); let iz = i32(pf.z);
  let w = mn_fade(p - pf);
  let x00 = mix(mn_hash3(ix, iy, iz, salt), mn_hash3(ix + 1, iy, iz, salt), w.x);
  let x10 = mix(mn_hash3(ix, iy + 1, iz, salt), mn_hash3(ix + 1, iy + 1, iz, salt), w.x);
  let x01 = mix(mn_hash3(ix, iy, iz + 1, salt), mn_hash3(ix + 1, iy, iz + 1, salt), w.x);
  let x11 = mix(mn_hash3(ix, iy + 1, iz + 1, salt), mn_hash3(ix + 1, iy + 1, iz + 1, salt), w.x);
  return mix(mix(x00, x10, w.y), mix(x01, x11, w.y), w.z);
}

/** One octave on a rotated lattice (no axis-aligned structure), re-centred to the legacy σ. */
fn mat_noise(p_in: vec3f, freq: f32, seed: u32) -> f32 {
  let p = p_in * freq;
  let r = vec3f(0.80 * p.x + 0.36 * p.y + 0.48 * p.z, -0.50 * p.x + 0.79 * p.y + 0.35 * p.z, -0.33 * p.x - 0.50 * p.y + 0.80 * p.z);
  return clamp(0.5 + (mn_value3(r, seed) - 0.5) * ${MAT_NOISE_SIGMA_GAIN.toFixed(4)}, 0.0, 1.0);
}
`);

export const tileNoiseWgsl = makeModule('tile-noise', /* wgsl */ `
fn tile_hash(cell: vec2i, period: i32, seed: u32) -> f32 {
  let wrapped = ((cell % vec2i(period)) + vec2i(period)) % vec2i(period);
  var h = u32(wrapped.x) * 374761393u + u32(wrapped.y) * 668265263u + seed * 1442695041u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return f32(h & 16777215u) / 16777216.0;
}

fn tile_noise(uv: vec2f, period: i32, seed: u32) -> f32 {
  let p = uv * f32(period);
  let cell = vec2i(floor(p));
  let f = fract(p);
  let s = f * f * f * (f * (f * 6.0 - vec2f(15.0)) + vec2f(10.0));
  return mix(mix(tile_hash(cell, period, seed), tile_hash(cell + vec2i(1, 0), period, seed), s.x),
    mix(tile_hash(cell + vec2i(0, 1), period, seed), tile_hash(cell + vec2i(1, 1), period, seed), s.x), s.y);
}

fn tile_fbm(uv: vec2f, base: i32, seed: u32) -> f32 {
  return (tile_noise(uv, base, seed) * 0.5 + tile_noise(uv, base * 2, seed + 13u) * 0.25
    + tile_noise(uv, base * 4, seed + 29u) * 0.125 + tile_noise(uv, base * 8, seed + 53u) * 0.0625) / 0.9375;
}

/** (nearest, second nearest) feature distance on a periodic jittered grid (points kept in the middle 60 % of a cell). */
fn tile_worley(uv: vec2f, period: i32, seed: u32) -> vec2f {
  let p = uv * f32(period);
  let cell = vec2i(floor(p));
  let f = fract(p);
  var nearest = 8.0;
  var second = 8.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let offset = vec2i(x, y);
      let point = vec2f(0.2) + vec2f(tile_hash(cell + offset, period, seed), tile_hash(cell + offset, period, seed + 47u)) * 0.6;
      let delta = vec2f(offset) + point - f;
      let distance = dot(delta, delta);
      if (distance < nearest) { second = nearest; nearest = distance; }
      else { second = min(second, distance); }
    }
  }
  return sqrt(vec2f(nearest, second));
}
`);

export const triplanarPerturbWgsl = makeModule('triplanar-perturb', /* wgsl */ `
// uv = pos.yz => U = +y, image-up = -z
fn tri_perturb_x(ns: vec3f) -> vec3f { return vec3f(0.0, ns.x, -ns.y); }
// uv = pos.xz => U = +x, image-up = -z
fn tri_perturb_y(ns: vec3f) -> vec3f { return vec3f(ns.x, 0.0, -ns.y); }
// uv = pos.xy => U = +x, image-up = -y
fn tri_perturb_z(ns: vec3f) -> vec3f { return vec3f(ns.x, -ns.y, 0.0); }
fn tri_perturb(nsx: vec3f, nsy: vec3f, nsz: vec3f, w: vec3f) -> vec3f {
  return tri_perturb_x(nsx) * w.x + tri_perturb_y(nsy) * w.y + tri_perturb_z(nsz) * w.z;
}
`);

// ───────────────────────────── TS mirrors ─────────────────────────────
const u32 = (x: number): number => x >>> 0;

/** Mirror of `mn_hash3`. */
export function mnHash3(ix: number, iy: number, iz: number, salt: number): number {
  let h = u32(Math.imul(u32(ix + 1048576), 0x27D4EB2D));
  h = u32(h ^ u32(Math.imul(u32(iy + 1048576), 0x9E3779B1 | 0)));
  h = u32(Math.imul(u32(h ^ (h >>> 15)), 0x85EBCA6B | 0));
  h = u32(h ^ u32(Math.imul(u32(iz + 1048576), 0xC2B2AE35 | 0)));
  h = u32(h ^ u32(salt));
  h = u32(Math.imul(u32(h ^ (h >>> 13)), 0xC2B2AE35 | 0));
  h = u32(h ^ (h >>> 16));
  return (h & 0xFFFFFF) / 0xFFFFFF;
}
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Mirror of `mn_value3`. */
export function mnValue3(px: number, py: number, pz: number, salt: number): number {
  const fx = Math.floor(px), fy = Math.floor(py), fz = Math.floor(pz);
  const ix = fx | 0, iy = fy | 0, iz = fz | 0;
  const wx = fade(px - fx), wy = fade(py - fy), wz = fade(pz - fz);
  const x00 = mix(mnHash3(ix, iy, iz, salt), mnHash3(ix + 1, iy, iz, salt), wx);
  const x10 = mix(mnHash3(ix, iy + 1, iz, salt), mnHash3(ix + 1, iy + 1, iz, salt), wx);
  const x01 = mix(mnHash3(ix, iy, iz + 1, salt), mnHash3(ix + 1, iy, iz + 1, salt), wx);
  const x11 = mix(mnHash3(ix, iy + 1, iz + 1, salt), mnHash3(ix + 1, iy + 1, iz + 1, salt), wx);
  return mix(mix(x00, x10, wy), mix(x01, x11, wy), wz);
}

/** Mirror of `mat_noise`. */
export function matNoise(p: readonly number[], freq: number, seed: number): number {
  const px = p[0] * freq, py = p[1] * freq, pz = p[2] * freq;
  const rx = 0.80 * px + 0.36 * py + 0.48 * pz, ry = -0.50 * px + 0.79 * py + 0.35 * pz, rz = -0.33 * px - 0.50 * py + 0.80 * pz;
  return Math.min(1, Math.max(0, 0.5 + (mnValue3(rx, ry, rz, u32(seed)) - 0.5) * MAT_NOISE_SIGMA_GAIN));
}

/** Mirror of `tile_hash`. */
export function tileHash(cx: number, cy: number, period: number, seed: number): number {
  const wx = ((cx % period) + period) % period, wy = ((cy % period) + period) % period;
  let h = u32(u32(Math.imul(wx, 374761393)) + u32(Math.imul(wy, 668265263)) + u32(Math.imul(seed, 1442695041)));
  h = u32(Math.imul(u32(h ^ (h >>> 13)), 1274126177));
  h = u32(h ^ (h >>> 16));
  return (h & 16777215) / 16777216;
}

/** Mirror of `tile_noise`: periodic in uv with period 1. */
export function tileNoise(u: number, v: number, period: number, seed: number): number {
  const px = u * period, py = v * period, cx = Math.floor(px), cy = Math.floor(py);
  const fx = px - cx, fy = py - cy, sx = fade(fx), sy = fade(fy);
  return mix(mix(tileHash(cx, cy, period, seed), tileHash(cx + 1, cy, period, seed), sx),
    mix(tileHash(cx, cy + 1, period, seed), tileHash(cx + 1, cy + 1, period, seed), sx), sy);
}
