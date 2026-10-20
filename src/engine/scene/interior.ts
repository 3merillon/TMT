/** Opt-in Cartesian interiors. These are room light blockers, independent of the planetary terrain SDF. */
import type { Vec3 } from '../contracts';

export const INTERIOR_MAX_OCCLUDERS = 32;

export interface InteriorOccluder {
  /** Closed, axis-aligned world-space solid. Leave lamp apertures and doorways out of these solids. */
  min: Vec3;
  max: Vec3;
  /** This back-wall solid contains the authored circular ventilation aperture. */
  fanAperture?: boolean;
}

export interface InteriorFacet {
  /** Low, artist-authored indirect irradiance from the room's lamps, never the sky. */
  ambient: Vec3;
  /** Radiance behind unfilled pixels (normally hidden by the closed room). */
  background: Vec3;
  fogColor: Vec3;
  /** Extinction per world unit. Zero disables the restrained lamp-lit aerial perspective. */
  fogDensity: number;
  /** Opaque walls, ceilings, floor and large machinery. At most INTERIOR_MAX_OCCLUDERS. */
  occluders: InteriorOccluder[];
  /** Local lamp behind a real wall opening; angle drives the rotating seven-blade light mask. */
  fan?: { center: Vec3; radius: number; angle: number; blades: number; emitter: Vec3; strength: number };
  /** Captured room-only HDR probe, box-projected for local reflections. */
  reflection?: { position: Vec3; min: Vec3; max: Vec3; mips: number; intensity: number };
}

declare module '../contracts' {
  interface SceneFacets { interior: InteriorFacet }
}

export function createInterior(): InteriorFacet {
  return { ambient: [0.65, 0.55, 0.43], background: [0.008, 0.011, 0.014], fogColor: [0.12, 0.14, 0.17], fogDensity: 0.007, occluders: [] };
}

/** Validate authored bounds before they reach WGSL; do not silently drop a wall and leak light. */
export function packInteriorOccluders(occluders: readonly InteriorOccluder[], out: Float32Array = new Float32Array(INTERIOR_MAX_OCCLUDERS * 8)): Float32Array {
  if (occluders.length > INTERIOR_MAX_OCCLUDERS) throw new Error(`Interior supports at most ${INTERIOR_MAX_OCCLUDERS} occluders.`);
  out.fill(0);
  occluders.forEach((box, i) => {
    for (let axis = 0; axis < 3; axis++) {
      if (!Number.isFinite(box.min[axis]) || !Number.isFinite(box.max[axis]) || box.max[axis] <= box.min[axis]) {
        throw new Error(`Interior occluder ${i} has invalid bounds on axis ${axis}.`);
      }
    }
    out.set(box.min, i * 8);
    out[i * 8 + 3] = box.fanAperture ? 1 : 0;
    out.set(box.max, i * 8 + 4);
  });
  return out;
}

/** CPU mirror of the shader's finite segment/slab test, including parallel rays and endpoints. */
export function interiorSegmentBlocked(from: Vec3, to: Vec3, box: InteriorOccluder): boolean {
  let entry = 0.0001, exit = 0.9999;
  for (let axis = 0; axis < 3; axis++) {
    const delta = to[axis] - from[axis];
    if (Math.abs(delta) < 1e-7) {
      if (from[axis] < box.min[axis] || from[axis] > box.max[axis]) return false;
    } else {
      const a = (box.min[axis] - from[axis]) / delta, b = (box.max[axis] - from[axis]) / delta;
      entry = Math.max(entry, Math.min(a, b));
      exit = Math.min(exit, Math.max(a, b));
      if (exit < entry) return false;
    }
  }
  return exit >= entry;
}
