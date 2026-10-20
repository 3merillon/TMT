import type { Q4, V3 } from '../game/contracts';
import { holdPlanetBearing, wrapAngle } from '../game/math';

export interface TurretPose {
  position: V3;
  rotation: Q4;
  turretYaw: number;
  barrelPitch: number;
}

/** Audible aim motion, excluding the chassis compensation performed by the simulation. Transport the previous
 * bearing across the planet before measuring yaw: a world-space direction alone would mistake spherical travel
 * and chassis tilt for an aim adjustment. Pitch is relative to the trunnion and is not automatically compensated. */
export function turretMotionRate(before: TurretPose, after: TurretPose, dt: number): number {
  // New matches, restores and long gaps must establish a new baseline without a servo burst.
  if (!(dt > 0 && dt <= .25) || !valid(before) || !valid(after)) return 0;
  const heldYaw = holdPlanetBearing(before, after, before.turretYaw);
  const yaw = wrapAngle(after.turretYaw - heldYaw);
  const pitch = wrapAngle(after.barrelPitch - before.barrelPitch);
  const rate = Math.hypot(yaw, pitch) / dt;
  return Number.isFinite(rate) ? rate : 0;
}

function valid(pose: TurretPose): boolean {
  return Number.isFinite(pose.turretYaw) && Number.isFinite(pose.barrelPitch)
    && pose.position.every(Number.isFinite) && Math.hypot(...pose.position) > 1e-6
    && pose.rotation.every(Number.isFinite) && Math.hypot(...pose.rotation) > 1e-6;
}
