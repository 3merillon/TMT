/**
 * The on-screen joystick (pure): a fixed base, a knob clamped to the base radius, and the
 * stick vector in gamepad axis convention (x right, y down, unit disc). The vector goes through `padFrame` exactly as a
 * gamepad's left stick does, so the dead zone, the expo curve and the drive/aim mapping are the gamepad's own:
 *
 *   drive: throttle = -y, steer = x          aim: bearing and elevation rates (the stick trims a tapped target)
 *
 * `follow` (off by default) lets a thumb that slides far past the rim drag the base along, for a floating variant.
 */
import type { InputContext } from './bindings';
import { padFrame, type PadFrame, type PadSnapshot } from './gamepad';
import type { Point } from './mouse';

export interface StickState { origin: Point; knob: Point; x: number; y: number }

/**
 * The stick for a thumb at `pointer` on a base at `origin`: clamped to the unit disc, the knob to the rim. With a finite
 * `follow`, beyond `follow` × radius the base slides toward the thumb (a floating stick).
 */
export function stickState(origin: Point, pointer: Point, radius: number, follow = Infinity): StickState {
  const r = Math.max(1, radius);
  let [ox, oy] = origin;
  let dx = pointer[0] - ox, dy = pointer[1] - oy, length = Math.hypot(dx, dy);
  if (!Number.isFinite(length)) return { origin, knob: origin, x: 0, y: 0 };
  if (length > follow * r) {
    const slide = (length - follow * r) / length;
    ox += dx * slide; oy += dy * slide;
    dx = pointer[0] - ox; dy = pointer[1] - oy; length = Math.hypot(dx, dy);
  }
  const scale = length > r ? r / length : 1;
  const kx = dx * scale, ky = dy * scale;
  return { origin: [ox, oy], knob: [ox + kx, oy + ky], x: kx / r, y: ky / r };
}

/** The virtual pad a stick vector stands for: the left stick only, no buttons. */
export function stickPad(x: number, y: number): PadSnapshot { return { axes: [x, y, 0, 0], buttons: [] }; }

/** Drive axes and aim rates for the stick in a context: the gamepad's mapping, by construction. */
export function stickFrame(context: InputContext, x: number, y: number): PadFrame { return padFrame(context, stickPad(x, y)); }
