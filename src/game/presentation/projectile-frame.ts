/** A transported flight frame avoids the roll flip of look-at(localUp) at vertical launch/apex. */
import type { V3 } from '../contracts';

export interface FlightFrame { forward: V3; right: V3; initialized: boolean }
export const createFlightFrame = (): FlightFrame => ({ forward: [0, 0, 1], right: [1, 0, 0], initialized: false });

/** Orient +Z toward velocity; zero velocity retains the previous attitude. No authoritative state is modified. */
export function projectileMatrix(frame: FlightFrame, position: readonly number[], velocity: readonly number[], localUp: readonly number[], dt: number,
  out = new Float32Array(16)): Float32Array {
  const f = frame.forward, r = frame.right, speed = Math.hypot(...velocity);
  if (!frame.initialized) {
    if (speed > 1e-5) for (let i = 0; i < 3; i++) f[i] = velocity[i] / speed;
    let ux = localUp[0], uy = localUp[1], uz = localUp[2];
    if (Math.abs(ux * f[0] + uy * f[1] + uz * f[2]) > .95) {
      // The least-aligned global axis is well conditioned even at either pole.
      const axis = Math.abs(f[0]) < Math.abs(f[1]) ? (Math.abs(f[0]) < Math.abs(f[2]) ? 0 : 2) : (Math.abs(f[1]) < Math.abs(f[2]) ? 1 : 2);
      ux = axis === 0 ? 1 : 0; uy = axis === 1 ? 1 : 0; uz = axis === 2 ? 1 : 0;
    }
    r[0] = uy * f[2] - uz * f[1]; r[1] = uz * f[0] - ux * f[2]; r[2] = ux * f[1] - uy * f[0];
    const length = Math.hypot(...r) || 1; for (let i = 0; i < 3; i++) r[i] /= length;
    frame.initialized = true;
  } else if (speed > .025 && dt > 0) {
    const tx = velocity[0] / speed, ty = velocity[1] / speed, tz = velocity[2] / speed;
    const dot = Math.max(-1, Math.min(1, f[0] * tx + f[1] * ty + f[2] * tz));
    let ax = f[1] * tz - f[2] * ty, ay = f[2] * tx - f[0] * tz, az = f[0] * ty - f[1] * tx;
    const length = Math.hypot(ax, ay, az);
    if (length > 1e-7 || dot < 0) {
      if (length > 1e-7) { ax /= length; ay /= length; az /= length; }
      else { ax = r[0]; ay = r[1]; az = r[2]; } // deterministic half-turn through an exactly vertical apex
      const angle = Math.acos(dot) * (1 - Math.exp(-32 * Math.min(.1, dt))), c = Math.cos(angle), s = Math.sin(angle);
      for (const v of [f, r]) {
        const x = v[0], y = v[1], z = v[2], d = ax * x + ay * y + az * z;
        v[0] = x * c + (ay * z - az * y) * s + ax * d * (1 - c);
        v[1] = y * c + (az * x - ax * z) * s + ay * d * (1 - c);
        v[2] = z * c + (ax * y - ay * x) * s + az * d * (1 - c);
      }
    }
  }
  out[0] = r[0]; out[1] = r[1]; out[2] = r[2]; out[3] = 0;
  out[4] = f[1] * r[2] - f[2] * r[1]; out[5] = f[2] * r[0] - f[0] * r[2]; out[6] = f[0] * r[1] - f[1] * r[0]; out[7] = 0;
  out[8] = f[0]; out[9] = f[1]; out[10] = f[2]; out[11] = 0;
  out[12] = position[0]; out[13] = position[1]; out[14] = position[2]; out[15] = 1;
  return out;
}
