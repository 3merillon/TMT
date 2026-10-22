/**
 * Shared layouts of the liquid passes: the composite's params and the planet
 * water's step uniform. The level-map WGSL (fluids.wgsl.ts) and the water WGSL (water.wgsl.ts) both import from here,
 * so neither imports the other's module graph.
 */
import { wgslStruct } from '../../wgsl/module';

export const LIQUID_MAX_BASINS = 16;

/** Debug views of the composite (the ?dev panel's Fluids group). */
export const LIQUID_VIEW = { none: 0, depth: 1, flow: 2, foam: 3, bed: 4, sun: 5, ao: 6, hidden: 7, thickness: 8, wetness: 9, temperature: 10, shore: 11 } as const;
export type LiquidDebugView = keyof typeof LIQUID_VIEW;
/** Composite and simulation switches (params.info.w bits). */
export const LIQUID_TOGGLE = { liquids: 1, veil: 2, caustics: 4, wetBand: 8, refraction: 16, foam: 32, waves: 64, sim: 128, swell: 256 } as const;
export const LIQUID_TOGGLES_ALL = 511;

export const LIQUID_PARAMS = wgslStruct('LiquidParams', [
  ['grid', 'vec4f'],      // x N (cells per face edge), y atlas width, z atlas height, w valid (1 once the water is live)
  ['info', 'vec4f'],      // x basin count, y time (s), z debug view, w toggle bits (LIQUID_TOGGLE)
  ['coarse', 'vec4f'],    // x label grid N, y frame index, z sea level (0 = none), w reference radius of stored levels (u)
  ['sun', 'vec4f'],       // xyz toward the sun, w tan of its (miniature) radius
  ['moon', 'vec4f'],      // xyz toward the moon, w tan
  ['water', 'vec4f'],     // rgb absorption per u, w refraction strength
  ['shallow', 'vec4f'],   // rgb shallow resin colour, w contact-foam strength
  ['deep', 'vec4f'],      // rgb deep resin colour, w wave slope
  ['lava', 'vec4f'],      // x emission scale, y crust scale, z wet depth (u), w thin-film depth (u)
  ['swell', 'vec4f'],     // x swell amplitude scale (0 = off), y wind roughness (0 calm … 1 gale), zw unused
  ['wind', 'vec4f'],      // the ripples' drift by the wind so far, a unit quaternion (world = R · drifted)
  ['basins', { array: 'vec4f', count: LIQUID_MAX_BASINS }], // level (u), material (0 water, 1 lava), temperature, kind (0 sea, 1 lake)
]);

// ───────────────────────────── Planet water (the shallow-water layer) ─────────────────────────────

/** Cell flags in the water's info buffer: the low byte is the basin label from the initial fill. */
export const WATER_FLAG = { sea: 256, lavaLake: 512 } as const;
/** No level within reach (the level buffer's ring). */
export const WATER_NO_RING = 99;
/** Rings of the level dilation: the surface is drawn two cells past the water; the wet band reads four. */
export const WATER_SURFACE_RINGS = 2;
export const WATER_BAND_RINGS = 4;
/** A drawn surface cell that dips under its bed (a front running downhill) carries this in the atlas's water depth. */
export const WATER_FRONT_MARK = -0.2;
/** Eight three-box tanks, bounded rigid-body envelopes, and the developer hull. */
export const WATER_MAX_CHUNK_HULLS = 16; // Shared by structural chunks and cosmetic debris.
export const WATER_MAX_HULLS = 24 + WATER_MAX_CHUNK_HULLS + 1;
/** Blast impulses. */
export const WATER_MAX_IMPULSES = 8;
/** Lava vents (volcanic planets). */
export const WATER_MAX_VENTS = 4;
/**
 * Activity tiles of the water passes: TILE × TILE cells of one face; each mask region holds TILE_WORDS words (2048
 * tiles, ≥ 6·(256 / 16)²); a tile lists the tiles within one of it (TILE_LINKS at most, at the cube's corners).
 */
export const WATER_TILE = 16;
export const WATER_TILE_WORDS = 64;
export const WATER_TILE_LINKS = 12;

export const WATER_SIM = wgslStruct('WaterSim', [
  ['dims', 'vec4u'],      // x N, y cells (6·N²), z dual-mesh quads, w frame index
  ['step', 'vec4f'],      // x substep dt (s), y gravity (u/s²), z depth cap in the flux (u), w speed cap (u/s)
  ['fric', 'vec4f'],      // x bottom friction (u/s), y wave damping (1/s), z wet depth (u), w lava viscosity (u²/s)
  ['sea', 'vec4f'],       // x sea level (0 = none), y reservoir rate (1/s), z open-water depth (u), w metric radius (u)
  ['shape', 'vec4f'],     // x a front's dip under the bed (u), y lava yield (u), z water weight on lava, w foam decay (1/s)
  ['frame', 'vec4f'],     // x frame dt (s), y time (s), z foam from speed (per s above w), w speed where foam starts (u/s)
  ['foam', 'vec4f'],      // x foam from a steep surface (per s above y), y slope where foam starts, z turbulent drag, w unused
  ['eye', 'vec4f'],       // xyz camera (world), w flags (1 lava present, 2 simulate)
  ['view_proj', 'mat4x4f'],
  ['counts', 'vec4u'],    // x hulls, y impulses, z vents, w previous hulls
  ['heat', 'vec4f'],      // lava: x cooling rate (1/s), y stiffening as it cools, z a lava lake's temperature, w water boiled per s at full heat (u/s)
  ['damp', 'vec4f'],      // x grid-scale filter strength per frame, y hull edge taper width (u), z swell amplitude scale (0 = off), w 1 = every tile runs
  // Per hull, 4 × vec4f: centre (xyz) and reach (w, a bounding radius); then the box axes (xyz) with their half extents (w).
  ['hulls', { array: 'vec4f', count: WATER_MAX_HULLS * 8 }],
  // Per impulse, 2 × vec4f: centre (xyz) and radius (w); acceleration at the centre (x, u/s²), foam (y), zw unused.
  ['impulses', { array: 'vec4f', count: WATER_MAX_IMPULSES * 2 }],
  // Per vent, 2 × vec4f: centre (xyz) and radius (w); lava added (x, u/s at the centre), yzw unused.
  ['vents', { array: 'vec4f', count: WATER_MAX_VENTS * 2 }],
]);
export const WATER_SIM_FLAG = { lava: 1, simulate: 2 } as const;
