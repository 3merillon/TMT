/** Presentation-only water coupling. Speeds are world units/s; no chassis forces or gameplay buoyancy. */
export const HULL_WAKE = { maximumSpeed: 3, response: 14, transfer: 0.85, foam: 1.8, sprayTravel: 0.35 } as const;

/** Scalar reference for the shader's bounded outgoing face flux (volume/s), before the cell-volume limiter. */
export function hullWakeFlux(previous: number, along: number, depth: number, edge: number, open: number, contact: number, dt: number, maxSpeed: number): number {
  const target = Math.max(0, Math.min(along, HULL_WAKE.maximumSpeed)) * depth * edge * HULL_WAKE.transfer * open;
  const blend = (1 - Math.exp(-dt * HULL_WAKE.response)) * Math.max(0, Math.min(contact, 1));
  return Math.min(maxSpeed * depth * edge * open, Math.max(0, previous + (target - previous) * blend));
}
