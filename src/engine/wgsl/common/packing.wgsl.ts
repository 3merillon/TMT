// Ported from Pinionfall src/gpu/gbuffer-packing.ts (MIT, same owner)
/**
 * Octahedral unit-vector packing — adapted from Rune Stubbe's Survey of Efficient Representations for Independent Unit
 * Vectors. Two components per normal, both in [-1, 1]; f16-friendly. `octEncode`/`octDecode` are the CPU mirrors.
 */
import { makeModule } from '../module';

export const packingWgsl = makeModule('packing', /* wgsl */ `
fn oct_wrap(v: vec2f) -> vec2f {
  let s = vec2f(select(-1.0, 1.0, v.x >= 0.0), select(-1.0, 1.0, v.y >= 0.0));
  return (1.0 - abs(v.yx)) * s;
}

fn oct_encode(n_in: vec3f) -> vec2f {
  let n = n_in / max(abs(n_in.x) + abs(n_in.y) + abs(n_in.z), 1e-8);
  return select(oct_wrap(n.xy), n.xy, n.z >= 0.0);
}

fn oct_decode(e: vec2f) -> vec3f {
  var n = vec3f(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
  if (n.z < 0.0) {
    let xy = oct_wrap(n.xy);
    n = vec3f(xy.x, xy.y, n.z);
  }
  return normalize(n);
}

/** snorm16x2 (as used by PartMesh.primAxis) → oct → unit vector. */
fn oct_decode_snorm16x2(p: u32) -> vec3f {
  return oct_decode(unpack2x16snorm(p));
}
`);

export type V3 = [number, number, number];

function octWrap(x: number, y: number): [number, number] {
  return [(1 - Math.abs(y)) * (x >= 0 ? 1 : -1), (1 - Math.abs(x)) * (y >= 0 ? 1 : -1)];
}

export function octEncode(n: readonly number[]): [number, number] {
  const l1 = Math.max(Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]), 1e-8);
  const x = n[0] / l1, y = n[1] / l1, z = n[2] / l1;
  return z >= 0 ? [x, y] : octWrap(x, y);
}

export function octDecode(e: readonly number[]): V3 {
  let x = e[0], y = e[1];
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) [x, y] = octWrap(x, y);
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/** oct → snorm16x2 (little-endian u32: x in the low half), matching WGSL unpack2x16snorm. */
export function octEncodeSnorm16x2(n: readonly number[]): number {
  const [x, y] = octEncode(n);
  const q = (v: number) => Math.round(Math.max(-1, Math.min(1, v)) * 32767) & 0xffff;
  return (q(x) | (q(y) << 16)) >>> 0;
}
