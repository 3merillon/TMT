/**
 * Planet water, WGSL: one shallow-water layer over the whole planet on the
 * level-map grid (6·N² cells, `src/world/cube-grid.ts` order), with a viscous lava layer under it.
 *
 * - **Step** (virtual pipes, Mei et al. 2007): each cell keeps four outflows (+i, −i, +j, −j), accelerated by the drop in
 *   surface height to each neighbour and scaled so no cell goes negative. A neighbour across a face seam is read through
 *   the neighbour table, whose reverse slot names the outflow pointing back, so every seam conserves volume exactly.
 *   Stability (Chentanez & Müller 2010): the depth in the flux is capped (the wave speed stays under the CFL limit), the
 *   speed is capped, and bottom friction grows as the water thins. Fast, shallow water also loses energy to turbulence
 *   (a drag ∝ speed / depth, Manning-like), so a torrent into a crater settles instead of sloshing for long; slow waves
 *   over deep water barely feel it. A lake at rest has no height difference, so it stays still over any bed.
 * - **Lava** flows under the water with a yield height and a viscous damping factor h²/(h² + 3·dt·ν) (lisyarus), so it
 *   creeps and thin sheets stick; water rests on it (the water's ground is bed + lava). It carries a temperature
 *   (advected with it once per frame): lakes are held at theirs, vents pour in fresh molten lava, everything else cools
 *   by radiation (thin sheets fastest) and under water, and its viscosity rises steeply as it cools (Costa & Macedonio
 *   2005), so a flow slows, crusts and stops. Water on hot lava boils off (the spray pass makes the steam).
 * - **The open sea** (cells labelled sea at the initial fill, deeper than the open-water depth) relaxes slowly toward the
 *   recipe level: a reservoir that craters cannot drain.
 * - **Hulls** (every tank, hidden ones too): each column's submerged hull thickness comes from a ray–box test along the
 *   radial line. Its change since the last frame is volume the hull pushed aside (entering a column) or left behind
 *   (leaving it), handed to the column's open neighbours (Müller 2008): a bow wave ahead, a trough astern, a wake. The
 *   hull also closes its columns to flow in proportion to what it fills, so water goes around it, not through it.
 * - **Blasts:** an impulse accelerates the water outward from its centre for a moment (a ring wave) and whitens it.
 * - **Grid-scale filter:** once per frame a conservative biharmonic exchange between wet neighbours damps single-cell
 *   spikes (a box's hard edges, shocks at bores) and leaves waves longer than a few cells almost untouched.
 * - **Flow, foam and wetness** (once per frame): the velocity from the last substep's fluxes; foam carried along the flow
 *   from the last frame's atlas (which crosses seams), fading, and raised where the water runs fast or its surface is
 *   steep (a torrent, a bore, a sheet down a crater wall); wetness 1 while wet, drying over about 25 s.
 * - **Surface for drawing:** the level of the nearest liquid dilates ring by ring over dry cells. The drawn surface
 *   continues flat for two rings past the last wet cell (the terrain's depth cuts it at the true contour), or dips just
 *   under the bed where the ground there is lower than that level (a front running downhill; the composite fades the
 *   water out toward such cells, so a front has a soft edge instead of the triangles'). The wet band reads four rings.
 * - **Pack:** the atlas tiles (3 × 2 faces of (N + 2)², one-cell gutters from the neighbouring faces) for the composite.
 * - **Cull:** the dual-mesh quads whose four cells have a surface and that face the camera go to an indirect draw.
 * - **Raster** (`waterSurfaceWgsl`): the surface's depth, in front of the scene's, into a depth target of its own.
 * - **Tiles** (`waterTilesWgsl`): each frame starts by marking the 16 × 16-cell tiles where something can change (a cell
 *   within a tile holds anything, or a hull, a vent or a new bed reaches it); the passes return at once on the others,
 *   whose cells would be rewritten with what they hold. Most of a planet is dry land far from any liquid.
 */
import { makeModule } from '../../wgsl/module';
import { cubeSphereWgsl } from '../../wgsl/common/cube-sphere.wgsl';
import { frameWgsl } from '../../wgsl/common/frame.wgsl';
import { sdfBindingsWgsl, sdfWgsl } from '../sdf/sdf.wgsl';
import { liquidBarrierWgsl } from './liquid-barrier.wgsl';
import { hullWakeWgsl } from './hull-wake.wgsl';
import { HULL_WAKE } from './hull-wake';
import {
  LIQUID_PARAMS, WATER_BAND_RINGS, WATER_FLAG, WATER_FRONT_MARK, WATER_MAX_HULLS, WATER_NO_RING, WATER_SIM, WATER_SURFACE_RINGS, WATER_TILE, WATER_TILE_LINKS,
  WATER_TILE_WORDS,
} from './liquid-params';

/** Cell and atlas addressing shared by the level-map passes. Needs the cube-sphere module. */
export const levelMapAddressWgsl = makeModule('liquid-level-address', /* wgsl */ `
fn lm_cell(d: vec3f, n: u32) -> u32 {
  let f = cs_face_of(d);
  let ij = clamp(vec2i(floor((cs_uv(d, f) * 0.5 + 0.5) * f32(n))), vec2i(0), vec2i(i32(n) - 1));
  return (f * n + u32(ij.y)) * n + u32(ij.x);
}
/** The direction of an atlas texel (gutter texels continue past the face edge into the neighbouring face). */
fn lm_texel_dir(t: vec2u, n: u32) -> vec3f {
  let tile = n + 2u;
  let face = (t.y / tile) * 3u + t.x / tile;
  let local = vec2f(vec2i(t % vec2u(tile)) - vec2i(1));
  return cs_dir(face, (local + 0.5) / f32(n) * 2.0 - 1.0);
}
/** Continuous atlas pixel coordinate of a direction (texel centres at k + 0.5). */
fn lm_atlas_px(d: vec3f, n: f32) -> vec2f {
  let f = cs_face_of(d);
  let tile = vec2f(f32(f % 3u), f32(f / 3u)) * (n + 2.0);
  return tile + 1.0 + (cs_uv(d, f) * 0.5 + 0.5) * n;
}
/** The unit direction of cell c's centre. */
fn lm_cell_dir(c: u32, n: u32) -> vec3f {
  let face = c / (n * n);
  let r = c - face * n * n;
  let j = r / n;
  return cs_dir(face, (vec2f(f32(r - j * n), f32(j)) + 0.5) / f32(n) * 2.0 - 1.0);
}
`, [cubeSphereWgsl]);

/**
 * The ambient swell (D8), a render layer over the simulated water: three plane waves in world space (on the planet their
 * crests are circles), deep-water dispersion ω = √(g·k). Returns (height, gradient) for an amplitude scale; the caller
 * fades it in the shallows. Wavelengths 2.3–5.1 u, amplitudes 0.013 / 0.009 / 0.006 u at scale 1.
 */
export const waterSwellWgsl = makeModule('water-swell', /* wgsl */ `
fn w_swell(p: vec3f, t: f32, scale: f32) -> vec4f {
  var out = vec4f(0.0);
  if (scale <= 0.0) { return out; }
  let dirs = array<vec3f, 3>(normalize(vec3f(0.62, 0.21, -0.75)), normalize(vec3f(-0.35, 0.87, 0.34)), normalize(vec3f(0.18, -0.52, 0.83)));
  let lens = vec3f(5.1, 3.4, 2.3);
  let amps = vec3f(0.013, 0.009, 0.006) * scale;
  for (var i = 0; i < 3; i++) {
    let k = 6.2831853 / lens[i];
    let w = sqrt(9.81 * k);
    let phase = k * dot(dirs[i], p) - w * t + f32(i) * 1.7;
    out.x += amps[i] * sin(phase);
    out = vec4f(out.x, out.yzw + dirs[i] * (amps[i] * k * cos(phase)));
  }
  return out;
}
/** How much swell a column carries: little in the shallows, a third at the waterline (the shore laps), none on lava. */
fn w_swell_share(water: f32, lava: f32) -> f32 {
  if (lava > 0.004 && water < 0.004) { return 0.0; }
  return 0.3 + 0.7 * smoothstep(0.0, 0.6, water);
}
`);

const MASK = '0x3fffffffu';
const NO_RING = `${WATER_NO_RING}.0`;

/** The activity tile of cell c (WATER_TILE × WATER_TILE cells of one face, faces in order). */
export const waterTileWgsl = makeModule('water-tile', /* wgsl */ `
fn w_tile(c: u32, n: u32) -> u32 {
  let face = c / (n * n);
  let r = c - face * n * n;
  let side = n / ${WATER_TILE}u;
  return (face * side + (r / n) / ${WATER_TILE}u) * side + (r % n) / ${WATER_TILE}u;
}
`);

/**
 * The tiles the water passes run on this frame. A tile is on when a cell within one tile of it holds anything (water,
 * lava, foam or wetness), when its bed or a neighbouring tile's changed, when a hull (this frame's or last frame's pose) or
 * an erupting vent reaches its columns, or when everything must run (a fill). Liquid moves at most a cell per substep and
 * the drawn surface and the band reach five cells past it, so every cell of an off tile would be rewritten with the values
 * it already holds.
 */
export const waterTilesWgsl = makeModule('water-tiles', /* wgsl */ `
// A tile's centre direction and angular radius (rad), then the tiles within one of it.
struct WaterTileInfo { dir: vec4f, links: array<u32, ${WATER_TILE_LINKS}> }
@group(0) @binding(0) var<uniform> W: WaterSim;
@group(0) @binding(1) var<storage, read> t_state: array<vec4f>;
// The occupied tiles' words, then the words of the tiles on.
@group(0) @binding(2) var<storage, read_write> t_mask: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read> t_info: array<WaterTileInfo>;
@group(0) @binding(4) var<storage, read_write> t_bed: array<atomic<u32>>;   // tiles whose bed the last marches changed

fn wt_bit(word: u32, t: u32) -> bool { return (atomicLoad(&t_mask[word + (t >> 5u)]) & (1u << (t & 31u))) != 0u; }

@compute @workgroup_size(256)
fn tiles_mark(@builtin(global_invocation_id) g: vec3u) {
  let c = g.x;
  // A tile whose bed moved counts as occupied this once: its ground, and its neighbours' crests, are new.
  if (c < ${WATER_TILE_WORDS}u) {
    let moved = atomicExchange(&t_bed[c], 0u);
    if (moved != 0u) { atomicOr(&t_mask[c], moved); }
  }
  if (c >= W.dims.y || all(t_state[c] == vec4f(0.0))) { return; }
  let t = w_tile(c, W.dims.x);
  if (!wt_bit(0u, t)) { atomicOr(&t_mask[t >> 5u], 1u << (t & 31u)); }
}

/** Whether a sphere of radius r at p can come within reach of a radial line through the tile (a conservative cone test). */
fn wt_reach(info: WaterTileInfo, p: vec3f, r: f32) -> bool {
  let l = length(p);
  return l <= r || acos(clamp(dot(info.dir.xyz, p / l), -1.0, 1.0)) <= info.dir.w + asin(r / l) + 0.002;
}

@compute @workgroup_size(64)
fn tiles_spread(@builtin(global_invocation_id) g: vec3u) {
  let t = g.x;
  let side = W.dims.x / ${WATER_TILE}u;
  if (t >= 6u * side * side) { return; }
  let info = t_info[t];
  var on = W.damp.w > 0.5 || wt_bit(0u, t);
  for (var k = 0u; k < ${WATER_TILE_LINKS}u && !on; k++) { on = wt_bit(0u, info.links[k]); }
  for (var h = 0u; h < W.counts.x && !on; h++) { let head = W.hulls[h * 4u]; on = wt_reach(info, head.xyz, head.w + W.damp.y); }
  for (var h = 0u; h < W.counts.w && !on; h++) { let head = W.hulls[(h + ${WATER_MAX_HULLS}u) * 4u]; on = wt_reach(info, head.xyz, head.w + W.damp.y); }
  for (var v = 0u; v < W.counts.z && !on; v++) { let vent = W.vents[v * 2u]; on = wt_reach(info, vent.xyz, vent.w); }
  if (on) { atomicOr(&t_mask[${WATER_TILE_WORDS}u + (t >> 5u)], 1u << (t & 31u)); }
}
`, [WATER_SIM.module, waterTileWgsl]);

export const waterStepWgsl = makeModule('water-step', /* wgsl */ `
@group(0) @binding(0) var<uniform> W: WaterSim;
@group(0) @binding(1) var<storage, read> nbr: array<vec4u>;        // neighbour | reverse slot << 30
@group(0) @binding(2) var<storage, read> metric: array<vec4f>;     // per (i, j): (area), edges, centre distances (unit sphere)
@group(0) @binding(3) var<storage, read> bed: array<f32>;
@group(0) @binding(4) var<storage, read_write> state: array<vec4f>; // x water depth, y lava depth, z foam, w wetness
@group(0) @binding(5) var<storage, read_write> flux: array<vec4f>;  // water outflows (u³/s)
@group(0) @binding(6) var<storage, read_write> lflux: array<vec4f>; // lava outflows
@group(0) @binding(7) var<storage, read_write> vel: array<vec4f>;   // xyz flow (world, u/s), w speed (u/s)
@group(0) @binding(8) var<storage, read_write> info: array<u32>;    // basin label of the initial fill | WATER_FLAG
@group(0) @binding(9) var<storage, read> tiles_on: array<u32>;      // one bit per tile: its cells can change this frame

@group(1) @binding(0) var<uniform> P: LiquidParams;
@group(1) @binding(1) var<storage, read> labels: array<u32>;
@group(1) @binding(2) var<storage, read> lvl_in: array<vec4f>;      // x level of the nearest liquid, y ring (0 = liquid), z lava share
@group(1) @binding(3) var<storage, read_write> lvl_out: array<vec4f>;
@group(1) @binding(4) var<storage, read_write> surf: array<f32>;    // the drawn surface radius, 0 = none
@group(1) @binding(5) var<storage, read> quads: array<vec4u>;
@group(1) @binding(6) var<storage, read_write> draw_index: array<u32>;
@group(1) @binding(7) var<storage, read_write> draw_args: WaterDrawArgs;
@group(1) @binding(8) var<storage, read_write> sums: array<vec4f>;   // per workgroup: water, lava, open sea water, open sea surface
@group(1) @binding(9) var atlas_prev: texture_2d<f32>;
@group(1) @binding(10) var lin: sampler;
@group(1) @binding(11) var atlas_a: texture_storage_2d<rgba32float, write>;
@group(1) @binding(12) var atlas_n: texture_storage_2d<rgba16float, write>;
@group(1) @binding(13) var atlas_f: texture_storage_2d<rgba16float, write>;
@group(1) @binding(14) var atlas_l: texture_storage_2d<rgba16float, write>;
@group(1) @binding(16) var<storage, read_write> lap: array<f32>;    // the filter's Laplacian of the surface (scratch)
@group(1) @binding(17) var<storage, read_write> heat: array<vec2f>;  // x lava temperature, y hull contact with waterline
@group(1) @binding(18) var atlas_prev_l: texture_2d<f32>;            // last frame's atlas L (w the lava temperature)
@group(1) @binding(19) var<storage, read_write> barriers: array<vec4f>;
@group(1) @binding(23) var<storage, read_write> push_faces: array<vec4f>; // lvlA scratch, before level dilation
// xyz: submerged hull thickness at current/previous poses (u), closed share. w: neighbor open share during coupling;
// after flow(), contact travel speed for spray. No neighboring hull read occurs while flow publishes this channel.
@group(1) @binding(15) var<storage, read_write> hull: array<vec4f>;

struct WaterDrawArgs { count: atomic<u32>, instances: u32, first: u32, base: i32, first_instance: u32 }

fn w_met(c: u32) -> u32 { let n = W.dims.x; return (c % (n * n)) * 3u; }
fn w_area(c: u32) -> f32 { let r = W.sea.w; return metric[w_met(c)].x * r * r; }
fn w_dir(c: u32) -> vec3f { return lm_cell_dir(c, W.dims.x); }
fn w_liquid(s: vec4f) -> bool { return s.x > W.fric.z || s.y > W.fric.z; }
fn w_lava_on() -> bool { return (u32(W.eye.w) & 1u) != 0u; }
/**
 * Whether cell c can change this frame (waterTilesWgsl): on an off tile every pass would rewrite the values its cells
 * already hold, so they skip it.
 */
fn w_active(c: u32) -> bool {
  let t = w_tile(c, W.dims.x);
  return (tiles_on[t >> 5u] & (1u << (t & 31u))) != 0u;
}
// Slowly evolving thermal head drives volume-conserving circulation in hot, deep lava.
// This is a shallow-layer convection approximation, not a source of extra liquid.
fn w_thermal_head(c: u32, s: vec4f) -> f32 {
  let p = w_dir(c) * W.sea.w;
  let t = W.frame.y;
  let cells = sin(dot(p, vec3f(1.7, 0.8, -1.1)) + t * 0.65)
    * sin(dot(p, vec3f(-0.6, 1.5, 1.3)) - t * 0.43);
  return cells * 0.065 * smoothstep(0.55, 0.92, heat[c].x) * smoothstep(0.04, 0.45, s.y);
}
/** A neighbour's drawn surface for a slope, or the fallback where it has none. A dry cell whose surface dips under its
 *  own bed (a front: ground lower than the liquid beside it) is not a surface either: counting it tilted the waterline's
 *  normals into cliffs, which bent the refraction into cell-spaced teeth and raised grid-shaped foam along the shore. */
/** How far a dry ring cell dips under its bed (0: it continues the level flat; 1: a front, drawn just under the bed),
 *  from how far its ground g lies under that level: a ramp from zero over 0.04 u, not a switch, so a shore cell's film
 *  crossing the wet depth (or a hull pushing the water off it) never flips its surface. Starting at zero with a width
 *  under the dip (W.shape.x, 0.05), the drawn level − dip·(g + 0.05) always stays under the ground: no flat sheet floats
 *  over dry ground (on flat ground one reached the drawn mesh's edge, its foam showing the cells as white squares). The
 *  width keeps the level's own wobble from moving the shore's vertices much. */
fn w_front_dip(level: f32, ground: f32) -> f32 {
  return clamp((level - ground) / 0.04, 0.0, 1.0);
}
fn w_surf_or(c: u32, fallback: f32) -> f32 {
  let r = surf[c];
  let s = state[c];
  return select(fallback, r, r > 0.0 && (w_liquid(s) || r >= bed[c] + s.y));
}

// ───────────── Initial fill: the basins of the recipe solve ─────────────

/**
 * The basin of a cell. The labels come from a coarser solve, so a shore cell whose coarse label is dry can still lie
 * below the neighbouring basin's level: accept a basin from the 3 × 3 coarse neighbourhood wherever this cell's own bed
 * is below its level (the cell's own label first).
 */
fn w_basin(d: vec3f, b: f32) -> u32 {
  let nc = u32(P.coarse.x);
  let count = u32(P.info.x);
  let own = labels[lm_cell(d, nc)];
  if (own > 0u && own <= count && b < P.basins[own - 1u].x) { return own; }
  let f = cs_face_of(d);
  let uv = cs_uv(d, f);
  let step = 2.0 / f32(nc);
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) { continue; }
      let label = labels[lm_cell(cs_dir(f, uv + vec2f(f32(dx), f32(dy)) * step), nc)];
      if (label > 0u && label <= count && b < P.basins[label - 1u].x) { return label; }
    }
  }
  return 0u;
}

@compute @workgroup_size(256)
fn init(@builtin(global_invocation_id) g: vec3u) {
  let c = g.x;
  if (c >= W.dims.y) { return; }
  let b = bed[c];
  let label = w_basin(w_dir(c), b);
  var s = vec4f(0.0);
  var flags = 0u;
  var temp = 0.0;
  if (label > 0u) {
    let basin = P.basins[label - 1u];
    let depth = max(basin.x - b, 0.0);
    if (basin.y > 0.5) { s.y = depth; temp = W.heat.z; flags |= ${WATER_FLAG.lavaLake}u; } else { s.x = depth; s.w = 1.0; }
    flags |= label;
    if (basin.w < 0.5 && basin.y < 0.5) { flags |= ${WATER_FLAG.sea}u; }
  }
  heat[c] = vec2f(temp, 0.0);
  state[c] = s;
  flux[c] = vec4f(0.0);
  lflux[c] = vec4f(0.0);
  vel[c] = vec4f(0.0);
  info[c] = flags;
}

// ───────────── Hulls: occupancy, then the volume they push aside ─────────────

/**
 * The radial line's entry and exit radii through hull h (the box, its sides pushed out by half the taper width), or
 * (1, 0) when it misses; z is the taper (0 … 1 over the taper width across the box's sides), so a column's share of the
 * hull ramps up over a couple of cells instead of jumping at a hard edge.
 */
fn w_hull_span(h: u32, d: vec3f) -> vec3f {
  let head = W.hulls[h * 4u];
  let along = dot(head.xyz, d);
  let w = W.damp.y;
  if (along <= 0.0 || length(head.xyz - d * along) > head.w + w) { return vec3f(1.0, 0.0, 0.0); }
  var lo = 0.0;
  var hi = 1e9;
  var inside = 1e9;
  let q = d * along - head.xyz;
  for (var a = 1u; a < 4u; a++) {
    let axis = W.hulls[h * 4u + a];
    let side = a != 2u;
    let half = axis.w + select(0.0, 0.5 * w, side);
    let o = -dot(head.xyz, axis.xyz);
    let dv = dot(d, axis.xyz);
    if (side) { inside = min(inside, half - abs(dot(q, axis.xyz))); }
    if (abs(dv) < 1e-6) {
      if (abs(o) > half) { return vec3f(1.0, 0.0, 0.0); }
      continue;
    }
    let t1 = (-half - o) / dv;
    let t2 = (half - o) / dv;
    lo = max(lo, min(t1, t2));
    hi = min(hi, max(t1, t2));
  }
  return vec3f(lo, hi, smoothstep(0.0, w, inside));
}

/** Each column's submerged hull thickness (keeping last frame's) and the share of it the hull closes to flow. */
@compute @workgroup_size(256)
fn couple_occupy(@builtin(global_invocation_id) g: vec3u) {
  let c = g.x;
  if (c >= W.dims.y) { return; }
  if (!w_active(c)) { return; }
  let s = state[c];
  let lava_surface = s.x <= W.fric.z && s.y > W.fric.z;
  let ground = bed[c] + select(s.y, 0.0, lava_surface);
  let liquid_depth = select(s.x, s.y, lava_surface);
  let eta = ground + liquid_depth;
  let d = w_dir(c);
  var sub = 0.0;
  var motion_sub = 0.0;
  var surface_contact = 0.0;
  var previous = 0.0;
  var drag_velocity = vec3f(0.0);
  var drag_share = 0.0;
  for (var h = 0u; h < W.counts.x; h++) {
    let span = w_hull_span(h, d);
    if (span.y > span.x) {
      let draft = max(0.0, min(span.y, eta) - max(span.x, ground)) * span.z;
      sub = max(sub, draft);
      motion_sub = max(motion_sub, draft * exp(-max(0.0, eta - span.y) * 4.0));
      surface_contact = max(surface_contact, span.z * (1.0 - smoothstep(0.015, 0.14, max(eta - span.y, span.x - eta))));
      if (liquid_depth > W.fric.z && h < W.counts.w && W.frame.x > 0.0) {
        // Translate and rotate the contacting hull point back into its previous pose.
        // This adds tangential drag inside the footprint, where occupancy alone is constant.
        let q = d * eta - W.hulls[h * 4u].xyz;
        var old_p = W.hulls[(h + ${WATER_MAX_HULLS}u) * 4u].xyz;
        for (var a = 1u; a < 4u; a++) {
          old_p += W.hulls[(h + ${WATER_MAX_HULLS}u) * 4u + a].xyz * dot(q, W.hulls[h * 4u + a].xyz);
        }
        var speed = (d * eta - old_p) / max(W.frame.x, 0.001);
        speed -= d * dot(speed, d);
        speed /= max(1.0, length(speed) / ${HULL_WAKE.maximumSpeed}.0);
        if (length(speed) < 0.006) { speed = vec3f(0.0); }
        let contact = span.z * exp(-max(0.0, eta - span.y) * 4.0) * smoothstep(0.0, 0.04, draft);
        drag_velocity += speed * contact;
        drag_share += contact;
      }
    }
  }
  // Evaluate BOTH poses against this frame's waterline. Comparing yesterday's
  // submerged volume feeds every passing wave back into the solver as hull motion.
  for (var h = 0u; h < W.counts.w; h++) {
    let span = w_hull_span(h + ${WATER_MAX_HULLS}u, d);
    if (span.y > span.x) { previous = max(previous, max(0.0, min(span.y, eta) - max(span.x, ground)) * span.z * exp(-max(0.0, eta - span.y) * 4.0)); }
  }
  let shut = select(0.0, clamp(sub / max(liquid_depth, 1e-6), 0.0, 1.0), liquid_depth > W.fric.z);
  hull[c] = vec4f(motion_sub, previous, shut, 0.0);
  heat[c] = vec2f(heat[c].x, surface_contact);
  // Temporary scratch until flow() publishes the solved velocity later in the frame.
  vel[c] = vec4f(drag_velocity / max(drag_share, 1.0), min(drag_share, 1.0));
}

/** Sample the actual connecting terrain once per frame, not only the radial column floors. */
@compute @workgroup_size(256)
fn lava_faces(@builtin(global_invocation_id) g: vec3u) {
  let c = g.x;
  if (c >= W.dims.y) { return; }
  if (!w_active(c)) { return; }
  var crest = vec4f(0.0);
  if (w_lava_on()) {
    let nb = nbr[c];
    for (var k = 0u; k < 4u; k++) {
      let n = nb[k] & ${MASK};
      let bottom = max(bed[c], bed[n]);
      crest[k] = bottom;
      if (max(state[c].y, state[n].y) <= W.fric.z) { continue; }
      let top = max(bed[c] + state[c].y, bed[n] + state[n].y);
      crest[k] = liquid_face_crest(w_dir(c), w_dir(n), top, bottom);
    }
  }
  barriers[c] = crest;
}

@compute @workgroup_size(256)
fn couple_share(@builtin(global_invocation_id) g: vec3u) {
  let c = g.x;
  if (c >= W.dims.y) { return; }
  if (!w_active(c)) { return; }
  let nb = nbr[c];
  var open = 0.0;
  let lava = state[c].x <= W.fric.z && state[c].y > W.fric.z;
  // Sum neighbours' open shares for displacement and cache each fraction for push;
  // that dispatch cannot read neighbouring state while it is being written.
  var faces = barriers[c];
  for (var k = 0u; k < 4u; k++) {
    let share = select(1.0, liquid_face_share(bed[c] + state[c].y, state[c].y, faces[k]), lava);
    open += (1.0 - hull[nb[k] & ${MASK}].z) * share;
    faces[k] = share;
  }
  push_faces[c] = faces;
  var h = hull[c];
  // Carry the displaced material in the sign. The push pass must not inspect
  // neighbouring state while other invocations are writing that same buffer.
  h.w = select(open, -open, state[c].x <= W.fric.z && state[c].y > W.fric.z);
  hull[c] = h;
}

/** Water pushed aside by hulls entering neighbouring columns (or drawn in behind them), onto this column. */
@compute @workgroup_size(256)
fn couple_push(@builtin(global_invocation_id) g: vec3u) {
  let c = g.x;
  if (c >= W.dims.y) { return; }
  if (!w_active(c)) { return; }
  let own = hull[c];
  if (own.z >= 1.0) { return; }
  let nb = nbr[c];
  var moved = vec2f(0.0);
  for (var k = 0u; k < 4u; k++) {
    let n = nb[k] & ${MASK};
    let hn = hull[n];
    let change = hn.x - hn.y;
    if (change != 0.0 && abs(hn.w) > 1e-3) {
      // A closed face cannot receive displacement through a crater wall.
      let share = push_faces[n][nb[k] >> 30u];
      let displaced = change * w_area(n) * (1.0 - own.z) * share / abs(hn.w);
      if (hn.w < 0.0) { moved.y += displaced; }
      else { moved.x += displaced; }
    }
  }
  if (all(moved == vec2f(0.0))) { return; }
  var s = state[c];
  s = vec4f(max(vec2f(0.0), s.xy + moved / w_area(c)), s.zw);
  state[c] = s;
}

// ───────────── The step: fluxes, then depths ─────────────

@compute @workgroup_size(256)
fn flux_step(@builtin(global_invocation_id) g: vec3u) {
  let c = g.x;
  if (c >= W.dims.y) { return; }
  if (!w_active(c)) { return; }
  let m = w_met(c);
  let r = W.sea.w;
  let area = metric[m].x * r * r;
  let edge = metric[m + 1u] * r;
  let dist = metric[m + 2u] * r;
  let s = state[c];
  let dt = W.step.x;
  let hw = s.x;
  let ground = bed[c] + s.y;
  let eta = ground + hw;
  let shut = hull[c].z;
  let hf = min(hw, W.step.z);
  // Waves lose little; thin water drags on the bed.
  let keep = exp(-dt * (W.fric.y + W.fric.x / max(hw, 0.01)));
  let lava = w_lava_on();
  var fl = vec4f(0.0);
  if (lava) { fl = lflux[c]; }
  var eta_l = ground + W.shape.z * hw;
  if (lava) { eta_l += w_thermal_head(c, s); }
  // Cooler lava is stiffer (the viscosity rises exponentially as it cools).
  let visc = W.fric.w * exp(W.heat.y * (1.0 - heat[c].x));
  let stick = s.y * s.y / (s.y * s.y + 3.0 * dt * visc + 1e-9);
  var f = flux[c];
  let nb = nbr[c];
  for (var k = 0u; k < 4u; k++) {
    let n = nb[k] & ${MASK};
    let sn = state[n];
    let gn = bed[n] + sn.y;
    let coef = dt * W.step.y * edge[k] / dist[k];
    // A hull in either column narrows the pipe to the share both leave open.
    let face = 1.0 - max(shut, hull[n].z);
    f[k] = min(max(0.0, f[k] * keep + coef * hf * face * (eta - (gn + sn.x))), W.step.w * hw * edge[k] * face);
    f[k] /= 1.0 + dt * W.foam.z * f[k] / (max(hw, 0.01) * max(hw, 0.01) * edge[k]);
    let water_drag = vel[c];
    if (hw > W.fric.z && water_drag.w > 0.0 && length(water_drag.xyz) > 0.0 && face > 0.0) {
      let e = normalize(w_dir(n) - w_dir(c));
      // Moving hulls drag water as well as displacing it. Only momentum changes here; depth_step still exchanges
      // the same finite volume with the reverse neighbor slot. Check the actual intervening terrain before driving.
      let crest = liquid_face_crest(w_dir(c), w_dir(n), eta, max(ground, gn));
      let open = face * liquid_face_share(eta, hw, crest);
      f[k] = water_hull_flux(f[k], dot(water_drag.xyz, e), hf, edge[k], open, water_drag.w, dt, W.step.w);
    }
    if (lava) {
      let dl = eta_l - (gn + W.shape.z * sn.x + w_thermal_head(n, sn));
      let yield_height = W.shape.y + (1.0 - smoothstep(0.3, 0.85, heat[c].x)) * 0.025;
      // A viscous skin can shear under a hull; closing the entire pipe made it look like a solid slab.
      let lava_face = max(face, 0.2);
      fl[k] = min(max(0.0, fl[k] + coef * min(s.y, W.step.z) * lava_face * sign(dl) * max(abs(dl) - yield_height, 0.0)) * stick,
        W.step.w * s.y * edge[k] * lava_face);
      let drag = vel[c];
      if (drag.w > 0.0 && hw <= W.fric.z) {
        let e = normalize(w_dir(n) - w_dir(c));
        let driven = max(0.0, dot(drag.xyz, e)) * min(s.y, W.step.z) * edge[k] * 0.65;
        fl[k] = mix(fl[k], driven, (1.0 - exp(-dt * 8.0)) * drag.w);
      }
    }
  }
  // Blasts push the water outward from their centres (the kick fades with distance).
  let impulses = W.counts.y;
  if (impulses > 0u && w_liquid(s)) {
    let d = w_dir(c);
    let p = d * eta;
    for (var i = 0u; i < impulses; i++) {
      let centre = W.impulses[i * 2u];
      let away = p - centre.xyz;
      let r = length(away);
      if (r >= centre.w) { continue; }
      let push = W.impulses[i * 2u + 1u].x * (1.0 - r / centre.w) * (1.0 - r / centre.w);
      let out_dir = normalize(away - d * dot(away, d) + d * 1e-5);
      for (var k = 0u; k < 4u; k++) {
        let e = normalize(w_dir(nb[k] & ${MASK}) - d);
        f[k] += dt * push * max(dot(out_dir, e), 0.0) * hf * edge[k];
        if (lava) { fl[k] += dt * push * max(dot(out_dir, e), 0.0) * min(s.y, W.step.z) * edge[k] * 0.55; }
      }
    }
  }
  let out = (f.x + f.y + f.z + f.w) * dt;
  if (out > hw * area) { f *= hw * area / out; }
  flux[c] = f;
  if (lava) {
    for (var k = 0u; k < 4u; k++) {
      // Includes hull drag and blast momentum: neither may bypass a solid rim.
      fl[k] *= liquid_face_share(ground, s.y, barriers[c][k]);
    }
    let lo = (fl.x + fl.y + fl.z + fl.w) * dt;
    if (lo > s.y * area) { fl *= s.y * area / lo; }
    lflux[c] = fl;
  }
}

@compute @workgroup_size(256)
fn depth_step(@builtin(global_invocation_id) g: vec3u) {
  let c = g.x;
  if (c >= W.dims.y) { return; }
  if (!w_active(c)) { return; }
  let area = w_area(c);
  let nb = nbr[c];
  let lava = w_lava_on();
  var in_w = 0.0;
  var in_l = 0.0;
  for (var k = 0u; k < 4u; k++) {
    let e = nb[k];
    let n = e & ${MASK};
    let back = e >> 30u;
    in_w += flux[n][back];
    if (lava) { in_l += lflux[n][back]; }
  }
  let dt = W.step.x;
  let fo = flux[c];
  var s = state[c];
  s.x = max(0.0, s.x + dt * (in_w - (fo.x + fo.y + fo.z + fo.w)) / area);
  if (lava) {
    let lo = lflux[c];
    s.y = max(0.0, s.y + dt * (in_l - (lo.x + lo.y + lo.z + lo.w)) / area);
  }
  // The open sea is a reservoir: its surface relaxes toward the recipe level, slowly enough that waves pass.
  if ((info[c] & ${WATER_FLAG.sea}u) != 0u && W.sea.x > 0.0 && s.x > W.sea.z) {
    s.x = max(0.0, s.x + (W.sea.x - (bed[c] + s.y + s.x)) * (1.0 - exp(-dt * W.sea.y)));
  }
  state[c] = s;
}

// ───────────── Once per frame: the grid-scale filter ─────────────

/** The surface's Laplacian over wet neighbours (dry cells and their faces take no part). */
@compute @workgroup_size(256)
fn smooth_lap(@builtin(global_invocation_id) g: vec3u) {
  let c = g.x;
  if (c >= W.dims.y) { return; }
  if (!w_active(c)) { return; }
  let s = state[c];
  var l = 0.0;
  if (s.x > W.fric.z) {
    let eta = bed[c] + s.y + s.x;
    let nb = nbr[c];
    for (var k = 0u; k < 4u; k++) {
      let n = nb[k] & ${MASK};
      let sn = state[n];
      if (sn.x > W.fric.z) { l += bed[n] + sn.y + sn.x - eta; }
    }
  }
  lap[c] = l;
}

/** Each wet pair exchanges water down the Laplacian's difference: antisymmetric, so volume holds. */
@compute @workgroup_size(256)
fn smooth_apply(@builtin(global_invocation_id) g: vec3u) {
  let c = g.x;
  if (c >= W.dims.y) { return; }
  if (!w_active(c)) { return; }
  var s = state[c];
  if (s.x <= W.fric.z) { return; }
  let lc = lap[c];
  let nb = nbr[c];
  var dh = 0.0;
  for (var k = 0u; k < 4u; k++) {
    let n = nb[k] & ${MASK};
    if (state[n].x > W.fric.z) { dh -= lap[n] - lc; }
  }
  s.x = max(0.0, s.x + W.damp.x * dh);
  state[c] = s;
}

// ───────────── Once per frame: flow, foam, wetness ─────────────

fn w_atlas_uv(d: vec3f) -> vec2f {
  let n = f32(W.dims.x);
  return lm_atlas_px(d, n) / vec2f(3.0 * (n + 2.0), 2.0 * (n + 2.0));
}

@compute @workgroup_size(256)
fn flow(@builtin(global_invocation_id) g: vec3u) {
  let c = g.x;
  if (c >= W.dims.y) { return; }
  if (!w_active(c)) { return; }
  let m = w_met(c);
  let edge = metric[m + 1u] * W.sea.w;
  let nb = nbr[c];
  let fo = flux[c];
  var fin = vec4f(0.0);
  for (var k = 0u; k < 4u; k++) {
    let e = nb[k];
    fin[k] = flux[e & ${MASK}][e >> 30u];
  }
  var s = state[c];
  let d = w_dir(c);
  let wet = s.x > W.fric.z;
  // Net flow along the cell's i and j (the mean of the two opposite faces), per unit width, then per unit depth.
  let qi = ((fo[0] - fin[0]) + (fin[1] - fo[1])) / max(edge[0] + edge[1], 1e-5);
  let qj = ((fo[2] - fin[2]) + (fin[3] - fo[3])) / max(edge[2] + edge[3], 1e-5);
  let ei = normalize(w_dir(nb[0] & ${MASK}) - w_dir(nb[1] & ${MASK}));
  let ej = normalize(w_dir(nb[2] & ${MASK}) - w_dir(nb[3] & ${MASK}));
  var v = (qi * ei + qj * ej) / max(s.x, 0.004);
  v -= d * dot(v, d);
  if (!wet) { v = vec3f(0.0); }
  let speed = length(v);
  let hull_drag = vel[c];
  vel[c] = vec4f(v, speed);
  // couple_push has consumed the neighbor-share channel. Publish true hull travel for spray, so a stationary
  // chassis cannot spray merely because a wave passed it; couple_occupy resets all four channels next frame.
  var contact_hull = hull[c];
  contact_hull.w = length(hull_drag.xyz) * hull_drag.w * heat[c].y;
  hull[c] = contact_hull;
  let dtf = W.frame.x;
  var foam = 0.0;
  if (wet) {
    // Carried along the flow from the last frame's surface, fading; raised by fast water and by a steep surface (a bore,
    // a torrent, a sheet sliding down a crater wall). The slope comes from last frame's drawn surface.
    foam = textureSampleLevel(atlas_prev, lin, w_atlas_uv(normalize(d * W.sea.w - v * dtf)), 0.0).w;
    foam *= exp(-dtf * W.shape.w);
    let dist = metric[m + 2u] * W.sea.w;
    let r = surf[c];
    let slope = length((w_surf_or(nb[0] & ${MASK}, r) - w_surf_or(nb[1] & ${MASK}, r)) / (dist[0] + dist[1]) * ei
                     + (w_surf_or(nb[2] & ${MASK}, r) - w_surf_or(nb[3] & ${MASK}, r)) / (dist[2] + dist[3]) * ej);
    foam += dtf * (W.frame.z * max(speed - W.frame.w, 0.0) + W.foam.x * max(slope - W.foam.y, 0.0));
    // A hull entering or leaving the column churns it; blasts whiten the water they push.
    let hc = hull[c];
    foam += 2.0 * abs(hc.x - hc.y) * heat[c].y;
    foam += dtf * contact_hull.w * ${HULL_WAKE.foam};
    for (var i = 0u; i < W.counts.y; i++) {
      let centre = W.impulses[i * 2u];
      let r = length(d * (bed[c] + s.y + s.x) - centre.xyz);
      if (r < centre.w) { foam += dtf * W.impulses[i * 2u + 1u].y * (1.0 - r / centre.w); }
    }
    foam = clamp(foam, 0.0, 1.0);
  }
  s.z = foam;
  s.w = select(s.w * exp(-dtf / 25.0), 1.0, wet);
  // Lava temperature: carried along the lava's own flow from the last frame's atlas, held by lakes, renewed by vents,
  // lost to radiation (faster in thin sheets) and to water, which boils off.
  var temp = 0.0;
  if (w_lava_on()) {
    let lo = lflux[c];
    var lin_ = vec4f(0.0);
    for (var k = 0u; k < 4u; k++) {
      let e = nb[k];
      lin_[k] = lflux[e & ${MASK}][e >> 30u];
    }
    let li = ((lo[0] - lin_[0]) + (lin_[1] - lo[1])) / max(edge[0] + edge[1], 1e-5);
    let lj = ((lo[2] - lin_[2]) + (lin_[3] - lo[3])) / max(edge[2] + edge[3], 1e-5);
    var vl = (li * ei + lj * ej) / max(s.y, 0.004);
    vl -= d * dot(vl, d);
    if (!wet) { vel[c] = vec4f(vl, length(vl)); }
    for (var i = 0u; i < W.counts.z; i++) {
      let vent = W.vents[i * 2u];
      let r = length(d * (bed[c] + s.y) - vent.xyz);
      if (r < vent.w) { s.y += dtf * W.vents[i * 2u + 1u].x * (1.0 - r / vent.w); temp = 1.0; }
    }
    if (s.y > W.fric.z) {
      if (temp < 1.0) {
        // Carry heat with incoming lava. Backtracing a freshly flooded dry texel
        // sampled zero temperature and froze the new liquid into a grey sheet.
        var incoming_heat = 0.0;
        var nearby_heat = 0.0;
        var nearby_count = 0.0;
        for (var k = 0u; k < 4u; k++) {
          let hn = textureSampleLevel(atlas_prev_l, lin, w_atlas_uv(w_dir(nb[k] & ${MASK})), 0.0).w;
          incoming_heat += lin_[k] * hn;
          if (hn > 0.01) { nearby_heat += hn; nearby_count += 1.0; }
        }
        let volume_in = (lin_.x + lin_.y + lin_.z + lin_.w) * dtf / w_area(c);
        let retained = max(0.0, s.y - volume_in);
        temp = (heat[c].x * retained + incoming_heat * dtf / w_area(c)) / max(retained + volume_in, 1e-6);
        if (heat[c].x < 0.01 && nearby_count > 0.0 && abs(hull[c].x - hull[c].y) > 0.0001) {
          temp = max(temp, nearby_heat / nearby_count);
        }
      }
      if ((info[c] & ${WATER_FLAG.lavaLake}u) != 0u) {
        temp += (W.heat.z - temp) * (1.0 - exp(-dtf * 0.5)) * smoothstep(0.02, 0.16, s.y);
      }
      let thin = 1.0 - smoothstep(0.02, 0.3, s.y);
      temp -= dtf * W.heat.x * temp * temp * temp * temp * (1.0 + 3.0 * thin);
      if (s.x > W.fric.z) {
        let boil = min(s.x, dtf * W.heat.w * temp);
        s.x -= boil;
        temp -= dtf * 1.5 * min(s.x / 0.05, 1.0);
      }
      temp = clamp(temp, 0.0, 1.0);
      if (!wet) {
        // On lava, the foam channel carries exposed/broken crust, advected and healing slowly.
        var broken = textureSampleLevel(atlas_prev, lin, w_atlas_uv(normalize(d * W.sea.w - vl * dtf)), 0.0).w * exp(-dtf * 0.65);
        broken += dtf * max(0.0, length(vl) - 0.025) * 1.8;
        broken += length(hull_drag.xyz) * hull_drag.w * dtf * 4.0 + abs(hull[c].x - hull[c].y) * 3.0;
        s.z = clamp(broken, 0.0, 1.0);
      }
    }
  }
  heat[c] = vec2f(temp, heat[c].y);
  state[c] = s;
}

// ───────────── The drawn surface: level rings over dry cells ─────────────

@compute @workgroup_size(256)
fn ext_first(@builtin(global_invocation_id) g: vec3u) {
  let c = g.x;
  if (c >= W.dims.y) { return; }
  if (!w_active(c)) { return; }
  let s = state[c];
  if (w_liquid(s)) {
    lvl_out[c] = vec4f(bed[c] + s.y + s.x, 0.0, select(0.0, 1.0, s.x <= W.fric.z), 0.0);
    return;
  }
  var sum = 0.0;
  var count = 0.0;
  var lava = 0.0;
  let nb = nbr[c];
  for (var k = 0u; k < 4u; k++) {
    let n = nb[k] & ${MASK};
    let sn = state[n];
    if (w_liquid(sn)) {
      sum += bed[n] + sn.y + sn.x;
      count += 1.0;
      lava += select(0.0, 1.0, sn.x <= W.fric.z);
    }
  }
  lvl_out[c] = select(vec4f(0.0, ${NO_RING}, 0.0, 0.0), vec4f(sum / max(count, 1.0), 1.0, lava / max(count, 1.0), 0.0), count > 0.0);
}

@compute @workgroup_size(256)
fn ext_next(@builtin(global_invocation_id) g: vec3u) {
  let c = g.x;
  if (c >= W.dims.y) { return; }
  if (!w_active(c)) { return; }
  let own = lvl_in[c];
  if (own.y < ${NO_RING} - 0.5) { lvl_out[c] = own; return; }
  var sum = 0.0;
  var count = 0.0;
  var lava = 0.0;
  var ring = ${NO_RING};
  let nb = nbr[c];
  for (var k = 0u; k < 4u; k++) {
    let l = lvl_in[nb[k] & ${MASK}];
    if (l.y < ${NO_RING} - 0.5) {
      sum += l.x;
      count += 1.0;
      lava += l.z;
      ring = min(ring, l.y + 1.0);
    }
  }
  lvl_out[c] = select(vec4f(0.0, ${NO_RING}, 0.0, 0.0), vec4f(sum / max(count, 1.0), ring, lava / max(count, 1.0), 0.0), count > 0.0);
}

@compute @workgroup_size(256)
fn surface(@builtin(global_invocation_id) g: vec3u) {
  let c = g.x;
  if (c >= W.dims.y) { return; }
  if (!w_active(c)) { return; }
  let l = lvl_in[c];
  let ground = bed[c] + state[c].y;
  var r = 0.0;
  if (l.y < 0.5) { r = l.x; }
  // A dry ring cell continues the level flat, for the terrain's depth to cut at the true contour, unless its ground lies
  // under that level (a front running downhill, or water a hull pushed off it): it then dips just under its bed, along
  // a ramp (w_front_dip), so the drawn surface never jumps.
  else if (l.y < ${WATER_SURFACE_RINGS}.5) { r = mix(l.x, ground - W.shape.x, w_front_dip(l.x, ground)); }
  // Water's drawn surface eases toward that target (presentation only, ~60 ms): a shore cell changing role (wet, a flat
  // continuation, a front, none) moves its vertex instead of snapping it. A cell gaining a surface rises from just under
  // its bed; one losing it sinks back under the bed before its quads go. Lava and a fill take the target at once.
  let prev = surf[c];
  let sink = ground - W.shape.x;
  if (state[c].y <= W.fric.z && W.damp.w < 0.5) {
    let k = 1.0 - exp(-W.frame.x / 0.06);
    if (r > 0.0) { r = mix(select(sink, prev, prev > 0.0), r, k); }
    else if (prev > sink + 0.002) { r = mix(prev, sink, k); }
  }
  surf[c] = r;
}

// ───────────── Pack the atlas ─────────────

/**
 * Atlas texels: a (surface radius or 0, ground = bed + lava, water depth or WATER_FRONT_MARK where the drawn surface dips
 * under the bed, lava depth); n (surface normal, foam); f (flow, wetness); l (the band's level − the metric radius, or
 * −1000; the lava share of it; the liquid coverage of the cell and its four neighbours; the lava temperature).
 */
@compute @workgroup_size(8, 8, 1)
fn pack(@builtin(global_invocation_id) g: vec3u) {
  let n = W.dims.x;
  if (g.x >= 3u * (n + 2u) || g.y >= 2u * (n + 2u)) { return; }
  let d = lm_texel_dir(g.xy, n);
  let c = lm_cell(d, n);
  if (!w_active(c)) { return; }
  let s = state[c];
  let r = surf[c];
  let up = w_dir(c);
  var nrm = up;
  if (r > 0.0) {
    let nb = nbr[c];
    let dist = metric[w_met(c) + 2u] * W.sea.w;
    let n0 = nb[0] & ${MASK};
    let n1 = nb[1] & ${MASK};
    let n2 = nb[2] & ${MASK};
    let n3 = nb[3] & ${MASK};
    let ei = normalize(w_dir(n0) - w_dir(n1));
    let ej = normalize(w_dir(n2) - w_dir(n3));
    let grad = (w_surf_or(n0, r) - w_surf_or(n1, r)) / (dist[0] + dist[1]) * ei
             + (w_surf_or(n2, r) - w_surf_or(n3, r)) / (dist[2] + dist[3]) * ej;
    nrm = normalize(up - grad);
  }
  let l = lvl_in[c];
  let ground = bed[c] + s.y;
  let wet = s.x > W.fric.z;
  // How far this drawn cell dips under its bed (w_front_dip): the composite fades the water toward it, continuously.
  let dip = select(0.0, w_front_dip(l.x, ground), !w_liquid(s) && r > 0.0 && l.y > 0.5 && l.y < ${WATER_SURFACE_RINGS}.5);
  // Coverage (a soft gate for the wet band and the shore foam): this cell and its four neighbours.
  var cover = vec2f(select(0.0, 2.0, w_liquid(s)), select(0.0, 2.0, s.y > W.fric.z && !wet));
  let nbc = nbr[c];
  for (var k = 0u; k < 4u; k++) {
    let sn = state[nbc[k] & ${MASK}];
    cover += vec2f(select(0.0, 1.0, w_liquid(sn)), select(0.0, 1.0, sn.y > W.fric.z && sn.x <= W.fric.z));
  }
  textureStore(atlas_a, g.xy, vec4f(r, ground, mix(s.x, ${WATER_FRONT_MARK}, dip), s.y));
  textureStore(atlas_n, g.xy, vec4f(nrm, s.z));
  textureStore(atlas_f, g.xy, vec4f(vel[c].xyz, s.w));
  textureStore(atlas_l, g.xy, vec4f(select(-1000.0, l.x - W.sea.w, l.y < ${WATER_BAND_RINGS}.5), l.z, cover.x / 6.0, heat[c].x));
}

// ───────────── Cull the dual mesh to the visible wet quads ─────────────

@compute @workgroup_size(256)
fn cull(@builtin(global_invocation_id) g: vec3u) {
  let k = g.x;
  if (k >= W.dims.z) { return; }
  let q = quads[k];
  let r = vec4f(surf[q.x], surf[q.y], surf[q.z], surf[q.w]);
  if (min(min(r.x, r.y), min(r.z, r.w)) <= 0.0) { return; }
  var p = array<vec3f, 4>(w_dir(q.x) * r.x, w_dir(q.y) * r.y, w_dir(q.z) * r.z, w_dir(q.w) * r.w);
  // Only the real terrain depth may hide liquid behind a ridge. A horizon sphere
  // based on this quad's height incorrectly culled visible volcanic slopes.
  // Outside the frustum: every corner beyond the same plane. Corners behind the camera keep the quad.
  var left = true; var right = true; var low = true; var high = true; var behind = true; var near = false;
  for (var i = 0u; i < 4u; i++) {
    let cl = W.view_proj * vec4f(p[i], 1.0);
    let lim = cl.w * 1.08 + 0.02;
    left = left && cl.x < -lim;
    right = right && cl.x > lim;
    low = low && cl.y < -lim;
    high = high && cl.y > lim;
    behind = behind && cl.w <= 0.0;
    near = near || cl.w < 0.05;
  }
  if (behind || (!near && (left || right || low || high))) { return; }
  let at = atomicAdd(&draw_args.count, 6u);
  draw_index[at] = q.x;
  draw_index[at + 1u] = q.y;
  draw_index[at + 2u] = q.z;
  draw_index[at + 3u] = q.x;
  draw_index[at + 4u] = q.z;
  draw_index[at + 5u] = q.w;
}

// ───────────── Volume (per workgroup; summed on the CPU) ─────────────

var<workgroup> w_part: array<vec4f, 256>;

/** Per workgroup: water and lava volume, and the open sea's water volume and surface radius × area (its mean level). */
@compute @workgroup_size(256)
fn volume(@builtin(global_invocation_id) g: vec3u, @builtin(local_invocation_index) li: u32, @builtin(workgroup_id) wid: vec3u) {
  let c = g.x;
  var v = vec4f(0.0);
  if (c < W.dims.y) {
    let s = state[c];
    let a = w_area(c);
    v = vec4f(s.xy * a, 0.0, 0.0);
    if ((info[c] & ${WATER_FLAG.sea}u) != 0u && s.x > W.sea.z) { v.z = a; v.w = (bed[c] + s.y + s.x) * a; }
  }
  w_part[li] = v;
  workgroupBarrier();
  for (var k = 128u; k > 0u; k = k >> 1u) {
    if (li < k) { w_part[li] += w_part[li + k]; }
    workgroupBarrier();
  }
  if (li == 0u) { sums[wid.x] = w_part[0]; }
}
`, [cubeSphereWgsl, WATER_SIM.module, LIQUID_PARAMS.module, levelMapAddressWgsl, waterTileWgsl,
  sdfBindingsWgsl(1, { volume: 20, params: 21, sampler: 22 }), sdfWgsl, liquidBarrierWgsl, hullWakeWgsl]);

/**
 * The probe's gather: per point, the cell's state, then its bed, heat and a zero word, then its flow, copied bit for bit
 * (one dispatch and one copy instead of four copies per point). probe_cells[0] is the point count.
 */
export const waterProbeWgsl = makeModule('water-probe', /* wgsl */ `
@group(0) @binding(0) var<storage, read> probe_cells: array<u32>;
@group(0) @binding(1) var<storage, read> probe_state: array<vec4u>;
@group(0) @binding(2) var<storage, read> probe_bed: array<u32>;
@group(0) @binding(3) var<storage, read> probe_heat: array<vec2u>;
@group(0) @binding(4) var<storage, read> probe_vel: array<vec4u>;
@group(0) @binding(5) var<storage, read_write> probe_out: array<vec4u>;
@compute @workgroup_size(64)
fn probe(@builtin(global_invocation_id) g: vec3u) {
  let k = g.x;
  if (k >= probe_cells[0]) { return; }
  let c = probe_cells[k + 1u];
  probe_out[k * 3u] = probe_state[c];
  probe_out[k * 3u + 1u] = vec4u(probe_bed[c], probe_heat[c], 0u);
  probe_out[k * 3u + 2u] = probe_vel[c];
}
`);

/** The surface's depth: the culled dual mesh at the drawn radii, kept only in front of the scene. */
export const waterSurfaceWgsl = makeModule('water-surface', /* wgsl */ `
@group(1) @binding(0) var<uniform> W: WaterSim;
@group(1) @binding(1) var<storage, read> surf: array<f32>;
@group(1) @binding(2) var scene_depth: texture_depth_2d;
@group(1) @binding(3) var<storage, read> depths: array<vec4f>;

struct WaterVsOut { @builtin(position) pos: vec4f }

@vertex fn vs(@builtin(vertex_index) c: u32) -> WaterVsOut {
  let d = lm_cell_dir(c, W.dims.x);
  let s = depths[c];
  // The swell rises and falls with the water; drawn cells past the shore move with it, so the waterline laps.
  let swell = w_swell(d * surf[c], W.frame.y, W.damp.z).x * w_swell_share(s.x, s.y);
  let p = d * (surf[c] + swell);
  return WaterVsOut(frame.view_proj * vec4f(p, 1.0));
}

@fragment fn fs(v: WaterVsOut) {
  if (v.pos.z <= textureLoad(scene_depth, vec2i(v.pos.xy), 0)) { discard; }
}
`, [frameWgsl, WATER_SIM.module, levelMapAddressWgsl, waterSwellWgsl]);
