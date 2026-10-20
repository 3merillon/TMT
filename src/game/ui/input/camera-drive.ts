/**
 * Camera-relative driving (pure): "point where you want to go". A stick vector (x right, y down on screen) becomes a
 * direction on the ground around the tank, seen through the camera, and then the tank-relative throttle and steer the
 * simulation already takes. Nothing new reaches the simulation: the result is an ordinary `drive` command.
 *
 *   steer     the signed angle between the hull and the wanted direction, full lock from STEER_FULL; it eases off as
 *             the hull comes round, so a held direction settles
 *   throttle  deflection × cos(angle): pushing across the hull pivots it in place, pushing along it drives
 *   reverse   a direction behind the hull backs the tank out (the rear swings toward it) instead of a half-turn;
 *             hysteresis between REVERSE_ENTER and REVERSE_EXIT keeps it from flip-flopping near the side
 *
 * The full range survives: forward and back at full speed, pivots, and every throttle/steer blend in between. The sim's
 * yaw rate does not depend on the throttle's sign (steer +1 always yaws right), so reversing steers with the same rule.
 */
import type { DriveAxes } from './bindings';

type V3 = readonly [number, number, number];
export interface DriveFrame {
  /** The hull's forward direction (world). */
  forward: V3;
  /** The local up at the tank (the planet radial). */
  up: V3;
  /** The camera's right direction (world). */
  cameraRight: V3;
}

export const STEER_FULL = Math.PI / 4;
export const REVERSE_ENTER = 105 * Math.PI / 180;
export const REVERSE_EXIT = 75 * Math.PI / 180;

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
function unit(a: V3): V3 | null { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-9 ? scale(a, 1 / l) : null; }
/** `a` flattened onto the plane normal to `up`, normalised (null when `a` is along `up`). */
const flat = (a: V3, up: V3) => unit(sub(a, scale(up, dot(a, up))));
/** Signed angle from `a` to `b` about `up` (positive = counter-clockwise seen from above = to the left). */
const signedAngle = (a: V3, b: V3, up: V3) => Math.atan2(dot(cross(a, b), up), dot(a, b));
const clamp = (v: number) => Math.max(-1, Math.min(1, v));

/** The ground direction a screen vector points at: screen right is the camera's right, screen up is away from the camera. */
export function screenToGround(x: number, y: number, frame: Pick<DriveFrame, 'up' | 'cameraRight'>): V3 | null {
  const up = unit(frame.up), right = up && flat(frame.cameraRight, up);
  if (!up || !right) return null;
  const away = cross(up, right);
  return unit(add(scale(right, x), scale(away, -y)));
}

/**
 * Tank-relative axes for a camera-relative stick. `axes` is the stick already shaped by the gamepad dead zone and expo
 * (x = steer, screen up = throttle), so the deflection keeps the stick's feel. `reversing` is the previous result's state.
 */
export function cameraDrive(axes: DriveAxes, frame: DriveFrame, reversing: boolean): { drive: DriveAxes; reversing: boolean } {
  const x = axes.steer, y = -axes.throttle, magnitude = Math.min(1, Math.hypot(x, y));
  if (magnitude < 1e-6) return { drive: { throttle: 0, steer: 0 }, reversing: false };
  const up = unit(frame.up), wanted = screenToGround(x, y, frame), forward = up && flat(frame.forward, up);
  if (!up || !wanted || !forward) return { drive: { throttle: 0, steer: 0 }, reversing };
  const error = signedAngle(forward, wanted, up), off = Math.abs(error);
  const reverse = reversing ? off > REVERSE_EXIT : off > REVERSE_ENTER;
  // Reversing aims the rear: the error is measured from the back of the hull.
  const aimError = reverse ? signedAngle(scale(forward, -1), wanted, up) : error;
  const along = Math.max(0, Math.cos(aimError));
  // A gentle push still turns the hull, a full one turns it at full rate.
  const steer = -clamp(aimError / STEER_FULL) * Math.min(1, 0.4 + magnitude);
  return { drive: { throttle: (reverse ? -1 : 1) * magnitude * along, steer: clamp(steer) }, reversing: reverse };
}
