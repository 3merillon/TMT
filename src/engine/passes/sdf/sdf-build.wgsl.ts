/**
 * Planet SDF construction from the resident terrain pages (docs/visibility-architecture.md). One region at a time: the
 * whole domain at load, `terrainCommitted.dirtyBounds` grown by the band afterwards.
 *
 * 1. clear_heads / clear_parity: empty the region's coarse-cell triangle bins and its footprint's parity columns.
 * 2. seed (one dispatch over the build's pages, concatenated by buffer copies; one thread per triangle):
 *    - band: a triangle near the region joins a compact list and a linked bin of every coarse cell it can reach within
 *      the band (about a million atomics for a crater, instead of one atomicMin per voxel per triangle);
 *    - parity: one crossing bit per z-column whose centre lies inside the triangle's xy projection. Edge functions are
 *      evaluated in a canonical vertex order, so a shared edge is exactly antisymmetric, and a tie on it is claimed by
 *      exactly one of the two triangles (watertight, like top-left rasterization).
 *    gather: every voxel of the region walks its cell's bin and stores the exact distance to the nearest triangle as f32
 *    bits (positive floats order like u32), with that triangle's material id in the low 4 mantissa bits.
 * 3. parity_prefix: per column, the prefix XOR of the crossing bits = "inside" per voxel. A column with an odd crossing
 *    count (an open mesh) is reset to outside and counted.
 * 4. flood: a jump flood on a 4× coarser grid seeded by cells that contain a surface-adjacent voxel (decided by the
 *    gather, one workgroup per coarse cell). It gives a conservative far-field distance: |p − seed| − 0.87·(v + v_coarse)
 *    ≤ the true distance.
 * 5. resolve: band distance where valid, else the far-field bound (never below the band), signed by the parity.
 */
import { makeModule } from '../../wgsl/module';

export const SDF_EMPTY = 0x7f7fffff;
export const SDF_NO_SEED = 0xffffffff;
/** Distances are clamped to this magnitude (u) in the volume. */
export const SDF_MAX_DISTANCE = 8;
/** The coarse jump-flood grid is this many voxels per cell per axis. */
export const SDF_COARSE = 4;
/** Chamfer passes extend the exact band to this distance (u): wide penumbrae and AO read near-exact values. */
export const SDF_NEAR_DISTANCE = 3.0;
/** A 26-neighbour chamfer distance overestimates the Euclidean one by at most this factor. */
export const SDF_CHAMFER_ERROR = 1.08;

const common = /* wgsl */ `
struct BuildParams {
  grid: vec4f,   // x N, y voxel (u), z half extent (u), w band (u)
  lo: vec4u,     // region min voxel (inclusive) xyz, w coarse cells per axis
  hi: vec4u,     // region max voxel (exclusive) xyz, w parity words per column (N / 32)
  misc: vec4u,   // x jump-flood step (coarse cells), y coarse factor, z unused, w seed flags (1 band, 2 parity)
}
@group(0) @binding(0) var<uniform> P: BuildParams;

fn n_vox() -> u32 { return u32(P.grid.x); }
fn vidx(i: vec3u) -> u32 { let n = n_vox(); return (i.z * n + i.y) * n + i.x; }
fn voxel_center(i: vec3i) -> vec3f { return (vec3f(i) + 0.5) * P.grid.y - P.grid.z; }
fn col_word(x: u32, y: u32, z: u32) -> u32 { return (y * n_vox() + x) * P.hi.w + z / 32u; }
fn cidx(c: vec3u) -> u32 { let n = P.lo.w; return (c.z * n + c.y) * n + c.x; }
fn cpack(c: vec3u) -> u32 { return c.x | (c.y << 10u) | (c.z << 20u); }
fn cunpack(s: u32) -> vec3u { return vec3u(s & 1023u, (s >> 10u) & 1023u, s >> 20u); }
`;

export const sdfClearWgsl = makeModule('sdf-build-clear', /* wgsl */ `
${common}
@group(0) @binding(1) var<storage, read_write> heads: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> parity: array<atomic<u32>>;

/** Empty the triangle bins of the region's coarse cells. */
@compute @workgroup_size(4, 4, 4)
fn clear_heads(@builtin(global_invocation_id) g: vec3u) {
  let lo = P.lo.xyz / P.misc.y;
  let hi = min((P.hi.xyz + P.misc.y - 1u) / P.misc.y, vec3u(P.lo.w));
  let c = lo + g;
  if (any(c >= hi)) { return; }
  atomicStore(&heads[cidx(c)], ${SDF_NO_SEED}u);
}

@compute @workgroup_size(8, 8, 1)
fn clear_parity(@builtin(global_invocation_id) g: vec3u) {
  let col = P.lo.xy + g.xy;
  if (col.x >= P.hi.x || col.y >= P.hi.y || g.z >= P.hi.w) { return; }
  atomicStore(&parity[(col.y * n_vox() + col.x) * P.hi.w + g.z], 0u);
}
`);

/** Closest point on a triangle (Ericson); shared with the SDF caster bricks. */
export const triangleWgsl = /* wgsl */ `
/** Ericson, Real-Time Collision Detection §5.1.5. */
fn closest_on_triangle(p: vec3f, a: vec3f, b: vec3f, c: vec3f) -> vec3f {
  let ab = b - a; let ac = c - a; let ap = p - a;
  let d1 = dot(ab, ap); let d2 = dot(ac, ap);
  if (d1 <= 0.0 && d2 <= 0.0) { return a; }
  let bp = p - b; let d3 = dot(ab, bp); let d4 = dot(ac, bp);
  if (d3 >= 0.0 && d4 <= d3) { return b; }
  let vc = d1 * d4 - d3 * d2;
  if (vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0) { return a + ab * (d1 / (d1 - d3)); }
  let cp = p - c; let d5 = dot(ab, cp); let d6 = dot(ac, cp);
  if (d6 >= 0.0 && d5 <= d6) { return c; }
  let vb = d5 * d2 - d1 * d6;
  if (vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0) { return a + ac * (d2 / (d2 - d6)); }
  let va = d3 * d6 - d5 * d4;
  if (va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0) { return b + (c - b) * ((d4 - d3) / ((d4 - d3) + (d5 - d6))); }
  let denom = 1.0 / (va + vb + vc);
  return a + ab * (vb * denom) + ac * (vc * denom);
}
`;

/**
 * Per page, one thread per triangle:
 * - band (flag 1): a triangle near the region is appended to the compact list and linked into every coarse cell whose
 *   centre lies within band + half a cell diagonal of it (so every voxel within the band of it finds it in its cell);
 * - parity (flag 2): one crossing bit per z-column whose centre lies inside the triangle's xy projection.
 */
export const sdfSeedWgsl = makeModule('sdf-build-seed', /* wgsl */ `
${common}
${triangleWgsl}
@group(0) @binding(1) var<storage, read_write> parity: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> tris: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> nodes: array<vec2u>;
@group(0) @binding(4) var<storage, read_write> heads: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> counters: array<atomic<u32>, 4>; // triangles, nodes, open columns, overflow
// The build's pages concatenated (buffer copies): positions f32×3 and surface f32×8 per vertex, page-local indices, and
// per page (first triangle, first vertex, flags, triangle count), sorted by first triangle.
@group(1) @binding(0) var<storage, read> positions: array<f32>;
@group(1) @binding(1) var<storage, read> indices: array<u32>;
@group(1) @binding(2) var<storage, read> surface: array<f32>;
@group(1) @binding(3) var<storage, read> pages: array<vec4u>;

fn lex_less(a: vec2f, b: vec2f) -> bool { return a.x < b.x || (a.x == b.x && a.y < b.y); }
fn edge_raw(a: vec2f, b: vec2f, p: vec2f) -> f32 { return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x); }
/** Exactly antisymmetric in (a, b): both triangles sharing an edge see the same value with opposite signs. */
fn edge_fn(a: vec2f, b: vec2f, p: vec2f) -> f32 { if (lex_less(a, b)) { return edge_raw(a, b, p); } return -edge_raw(b, a, p); }
fn edge_in(e: f32, a: vec2f, b: vec2f, positive: bool) -> bool {
  let s = select(-e, e, positive);
  if (s > 0.0) { return true; }
  if (s < 0.0) { return false; }
  return lex_less(a, b) == positive;
}

fn vertex(i: u32) -> vec3f { return vec3f(positions[i * 3u], positions[i * 3u + 1u], positions[i * 3u + 2u]); }

@compute @workgroup_size(64)
fn seed(@builtin(global_invocation_id) gid: vec3u) {
  let tri = gid.x + gid.y * 65535u * 64u;
  if (tri * 3u + 2u >= arrayLength(&indices)) { return; }
  // The page holding this triangle (binary search on the first triangles).
  var lo_p = 0u;
  var hi_p = arrayLength(&pages);
  while (hi_p - lo_p > 1u) { let mid = (lo_p + hi_p) / 2u; if (pages[mid].x <= tri) { lo_p = mid; } else { hi_p = mid; } }
  let page = pages[lo_p];
  if (tri >= page.x + page.w) { return; }
  let flags = page.z;
  let j0 = indices[tri * 3u]; let j1 = indices[tri * 3u + 1u]; let j2 = indices[tri * 3u + 2u];
  if (j0 == j1 || j1 == j2 || j0 == j2) { return; }
  let i0 = page.y + j0; let i1 = page.y + j1; let i2 = page.y + j2;
  let a = vertex(i0); let b = vertex(i1); let c = vertex(i2);
  if (length(cross(b - a, c - a)) < 1e-12) { return; }
  let v = P.grid.y; let h = P.grid.z; let bw = P.grid.w;
  let lo3 = min(min(a, b), c); let hi3 = max(max(a, b), c);
  if ((flags & 1u) != 0u) {
    let rlo = vec3f(P.lo.xyz) * v - h - bw;
    let rhi = vec3f(P.hi.xyz) * v - h + bw;
    if (all(hi3 >= rlo) && all(lo3 <= rhi)) {
      let t = atomicAdd(&counters[0], 1u);
      if (t * 3u + 2u < arrayLength(&tris)) {
        let mat = clamp(surface[i0 * 8u], 0.0, 15.0);
        tris[t * 3u] = vec4f(a, mat);
        tris[t * 3u + 1u] = vec4f(b, 0.0);
        tris[t * 3u + 2u] = vec4f(c, 0.0);
        let f = P.misc.y;
        let cs = v * f32(f);
        let reach = bw + 0.8660254 * cs;
        let clo = max(vec3i(floor((lo3 - bw + h) / cs)), vec3i(P.lo.xyz / f));
        let chi = min(vec3i(floor((hi3 + bw + h) / cs)), vec3i((P.hi.xyz - 1u) / f));
        for (var z = clo.z; z <= chi.z; z++) {
          for (var y = clo.y; y <= chi.y; y++) {
            for (var x = clo.x; x <= chi.x; x++) {
              let centre = (vec3f(f32(x), f32(y), f32(z)) + 0.5) * cs - h;
              if (length(centre - closest_on_triangle(centre, a, b, c)) > reach) { continue; }
              let slot = atomicAdd(&counters[1], 1u);
              if (slot >= arrayLength(&nodes)) { atomicOr(&counters[3], 1u); continue; }
              let prev = atomicExchange(&heads[cidx(vec3u(u32(x), u32(y), u32(z)))], slot);
              nodes[slot] = vec2u(t, prev);
            }
          }
        }
      } else {
        atomicOr(&counters[3], 2u);
      }
    }
  }
  if ((flags & 2u) != 0u) {
    let area = edge_raw(a.xy, b.xy, c.xy);
    if (abs(area) < 1e-12) { return; }
    let positive = area > 0.0;
    let lo = max(vec2i(floor((lo3.xy + h) / v - 0.5)), vec2i(P.lo.xy));
    let hi = min(vec2i(floor((hi3.xy + h) / v - 0.5)) + 2, vec2i(P.hi.xy));
    for (var y = lo.y; y < hi.y; y++) {
      for (var x = lo.x; x < hi.x; x++) {
        // Column centres get a tiny irrational offset so they never pass exactly through a mesh vertex.
        let pc = (vec2f(f32(x), f32(y)) + vec2f(0.5 + 1.37e-4, 0.5 + 2.91e-4)) * v - h;
        let e0 = edge_fn(b.xy, c.xy, pc); let e1 = edge_fn(c.xy, a.xy, pc); let e2 = edge_fn(a.xy, b.xy, pc);
        if (!(edge_in(e0, b.xy, c.xy, positive) && edge_in(e1, c.xy, a.xy, positive) && edge_in(e2, a.xy, b.xy, positive))) { continue; }
        let z = (e0 * a.z + e1 * b.z + e2 * c.z) / (e0 + e1 + e2);
        // The first voxel centre above the crossing: centre_k = (k + 0.5)·v − h > z.
        let kz = i32(floor((z + h) / v + 0.5));
        if (kz >= i32(n_vox())) { continue; }
        let kc = u32(max(kz, 0));
        atomicXor(&parity[col_word(u32(x), u32(y), kc)], 1u << (kc % 32u));
      }
    }
  }
}
`);

/**
 * One workgroup per coarse cell of the region (its 4³ voxels): thread 0 walks the cell's triangle bin 64 links at a time,
 * the workgroup stages those triangles in shared memory, and every voxel tests them. Voxels of the cell outside the
 * region keep their band value. The same pass decides the cell's flood seed (any voxel within 0.87 voxel of a surface).
 */
export const sdfGatherWgsl = makeModule('sdf-build-gather', /* wgsl */ `
${common}
${triangleWgsl}
@group(0) @binding(1) var<storage, read_write> band: array<u32>;
@group(0) @binding(2) var<storage, read> tris: array<vec4f>;
@group(0) @binding(3) var<storage, read> nodes: array<vec2u>;
@group(0) @binding(4) var<storage, read> heads: array<u32>;
@group(0) @binding(5) var<storage, read_write> seeds: array<u32>;

var<workgroup> chunk_ids: array<u32, 64>;
var<workgroup> chunk_a: array<vec4f, 64>;
var<workgroup> chunk_b: array<vec3f, 64>;
var<workgroup> chunk_c: array<vec3f, 64>;
var<workgroup> chunk_count: u32;
var<workgroup> cursor: u32;
var<workgroup> near_surface: atomic<u32>;

@compute @workgroup_size(${SDF_COARSE}, ${SDF_COARSE}, ${SDF_COARSE})
fn gather(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_id) lid: vec3u, @builtin(local_invocation_index) li: u32) {
  let coarse_cell = P.lo.xyz / P.misc.y + wg;
  let cell = coarse_cell * P.misc.y + lid;
  let inside = all(cell >= P.lo.xyz) && all(cell < P.hi.xyz);
  let p = voxel_center(vec3i(cell));
  if (li == 0u) { cursor = heads[cidx(coarse_cell)]; atomicStore(&near_surface, 0u); }
  workgroupBarrier();
  var best = 1e30;
  var mat = 0u;
  for (var guard = 0u; guard < 256u; guard++) {
    if (li == 0u) {
      var n = 0u;
      var node = cursor;
      while (n < 64u && node != ${SDF_NO_SEED}u) { let link = nodes[node]; chunk_ids[n] = link.x; node = link.y; n++; }
      cursor = node;
      chunk_count = n;
    }
    let n = workgroupUniformLoad(&chunk_count);
    if (li < n) {
      let t = chunk_ids[li];
      chunk_a[li] = tris[t * 3u];
      chunk_b[li] = tris[t * 3u + 1u].xyz;
      chunk_c[li] = tris[t * 3u + 2u].xyz;
    }
    workgroupBarrier();
    for (var k = 0u; k < n; k++) {
      let a = chunk_a[k];
      let d = length(p - closest_on_triangle(p, a.xyz, chunk_b[k], chunk_c[k]));
      if (d < best) { best = d; mat = u32(a.w); }
    }
    workgroupBarrier();
    if (n < 64u) { break; }
  }
  var bits: u32;
  if (inside) {
    bits = select(${SDF_EMPTY}u, (bitcast<u32>(best) & 0xfffffff0u) | mat, best <= P.grid.w);
    band[vidx(cell)] = bits;
  } else if (all(cell < vec3u(n_vox()))) {
    bits = band[vidx(cell)];
  } else {
    bits = ${SDF_EMPTY}u;
  }
  if (bitcast<f32>(bits & 0xfffffff0u) <= P.grid.y * 0.87) { atomicStore(&near_surface, 1u); }
  workgroupBarrier();
  if (li == 0u && all(coarse_cell < vec3u(P.lo.w))) {
    seeds[cidx(coarse_cell)] = select(${SDF_NO_SEED}u, cpack(coarse_cell), atomicLoad(&near_surface) != 0u);
  }
}
`);

/**
 * One chamfer step over the region, in place: a voxel beyond the exact band takes min(neighbour + step length) over its
 * 26 neighbours, up to SDF_NEAR_DISTANCE. Concurrent in-place updates only ever lower values to valid upper bounds, so
 * the races are benign. The resolve divides these values by SDF_CHAMFER_ERROR to keep a lower bound.
 */
export const sdfGrowWgsl = makeModule('sdf-build-grow', /* wgsl */ `
${common}
@group(0) @binding(1) var<storage, read_write> band: array<u32>;
@group(0) @binding(2) var<storage, read> cells: array<u32>;

@compute @workgroup_size(4, 4, 4)
fn grow(@builtin(global_invocation_id) g: vec3u) {
  let cell = P.lo.xyz + g;
  if (any(cell >= P.hi.xyz)) { return; }
  let i = vidx(cell);
  let own = band[i];
  let current = bitcast<f32>(own & 0xfffffff0u);
  if (current <= P.grid.w) { return; }
  // Skip voxels the coarse flood places well beyond the near field (most of the volume): one read instead of 26.
  let f = P.misc.y;
  let s = cells[cidx(cell / f)];
  if (s == ${SDF_NO_SEED}u) { return; }
  let v = P.grid.y;
  let centre = (vec3f(cunpack(s)) + 0.5) * (v * f32(f)) - P.grid.z;
  let far = length(voxel_center(vec3i(cell)) - centre) - 0.87 * v * (1.0 + f32(f));
  if (far > ${SDF_NEAR_DISTANCE} + P.grid.w + v * f32(f)) { return; }
  var best = current;
  var mat = own & 15u;
  let n = i32(n_vox());
  for (var z = -1; z <= 1; z++) {
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        if (x == 0 && y == 0 && z == 0) { continue; }
        let c = vec3i(cell) + vec3i(x, y, z);
        if (any(c < vec3i(0)) || any(c >= vec3i(n))) { continue; }
        let nb = band[vidx(vec3u(c))];
        let d = bitcast<f32>(nb & 0xfffffff0u);
        if (d > ${SDF_NEAR_DISTANCE}) { continue; }
        let cand = d + length(vec3f(f32(x), f32(y), f32(z))) * P.grid.y;
        if (cand < best) { best = cand; mat = nb & 15u; }
      }
    }
  }
  if (best < current && best <= ${SDF_NEAR_DISTANCE}) { band[i] = (bitcast<u32>(best) & 0xfffffff0u) | mat; }
}
`);

export const sdfParityWgsl = makeModule('sdf-build-parity', /* wgsl */ `
${common}
@group(0) @binding(1) var<storage, read_write> parity: array<u32>;
@group(0) @binding(2) var<storage, read_write> stats: array<atomic<u32>>;

@compute @workgroup_size(8, 8, 1)
fn parity_prefix(@builtin(global_invocation_id) g: vec3u) {
  let col = P.lo.xy + g.xy;
  if (col.x >= P.hi.x || col.y >= P.hi.y) { return; }
  let base = (col.y * n_vox() + col.x) * P.hi.w;
  var carry = 0u;
  for (var w = 0u; w < P.hi.w; w++) {
    let bits = parity[base + w];
    var x = bits;
    x ^= x << 1u; x ^= x << 2u; x ^= x << 4u; x ^= x << 8u; x ^= x << 16u;
    if (carry != 0u) { x = ~x; }
    carry ^= countOneBits(bits) & 1u;
    parity[base + w] = x;
  }
  if (carry != 0u) {
    atomicAdd(&stats[2], 1u);
    for (var w = 0u; w < P.hi.w; w++) { parity[base + w] = 0u; }
  }
}
`);

export const sdfFloodWgsl = makeModule('sdf-build-flood', /* wgsl */ `
${common}
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;

@compute @workgroup_size(4, 4, 4)
fn flood(@builtin(global_invocation_id) g: vec3u) {
  let n = P.lo.w;
  if (any(g >= vec3u(n))) { return; }
  let me = vec3f(g);
  var best = src[cidx(g)];
  var bd = 1e30;
  if (best != ${SDF_NO_SEED}u) { let q = vec3f(cunpack(best)) - me; bd = dot(q, q); }
  let k = i32(P.misc.x);
  for (var z = -1; z <= 1; z++) {
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        if (x == 0 && y == 0 && z == 0) { continue; }
        let c = vec3i(g) + vec3i(x, y, z) * k;
        if (any(c < vec3i(0)) || any(c >= vec3i(i32(n)))) { continue; }
        let s = src[cidx(vec3u(c))];
        if (s == ${SDF_NO_SEED}u) { continue; }
        let q = vec3f(cunpack(s)) - me;
        let dd = dot(q, q);
        if (dd < bd) { bd = dd; best = s; }
      }
    }
  }
  dst[cidx(g)] = best;
}
`);

export function sdfResolveWgsl(format: GPUTextureFormat) {
  return makeModule(`sdf-build-resolve:${format}`, /* wgsl */ `
${common}
@group(0) @binding(1) var<storage, read> band: array<u32>;
@group(0) @binding(2) var<storage, read> parity: array<u32>;
@group(0) @binding(3) var<storage, read> cells: array<u32>;
@group(0) @binding(4) var volume: texture_storage_3d<${format}, write>;

@compute @workgroup_size(4, 4, 4)
fn resolve(@builtin(global_invocation_id) g: vec3u) {
  let cell = P.lo.xyz + g;
  if (any(cell >= P.hi.xyz)) { return; }
  let v = P.grid.y;
  let bw = P.grid.w;
  var d = bitcast<f32>(band[vidx(cell)] & 0xfffffff0u);
  if (d > bw && d <= ${SDF_NEAR_DISTANCE}) {
    d = max(bw, d / ${SDF_CHAMFER_ERROR});
  } else if (!(d <= bw)) {
    let f = P.misc.y;
    let s = cells[cidx(cell / f)];
    d = ${SDF_MAX_DISTANCE}.0;
    if (s != ${SDF_NO_SEED}u) {
      let centre = (vec3f(cunpack(s)) + 0.5) * (v * f32(f)) - P.grid.z;
      d = length(voxel_center(vec3i(cell)) - centre) - 0.87 * v * (1.0 + f32(f));
    }
    d = clamp(d, bw, ${SDF_MAX_DISTANCE}.0);
  }
  let word = parity[col_word(cell.x, cell.y, cell.z)];
  let inside = ((word >> (cell.z % 32u)) & 1u) != 0u;
  textureStore(volume, cell, vec4f(select(d, -d, inside), 0.0, 0.0, 0.0));
}
`);
}
