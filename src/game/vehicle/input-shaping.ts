/**
 * Deterministic drive-input shaping (W1-PHY, plan §4.3 step 1). Digital input (exactly −1, 0 or 1: keys, the bot's
 * saturated steer) slews toward its target at INPUT_SHAPING rates, so a key press ramps the belts instead of
 * stepping them. Analog input (any other finite value in [−1, 1]: a gamepad stick) passes straight through. The shaped
 * values are chassis state (ResidentTanks motions), never wall-clock time.
 */
import type { DriveInput } from '../contracts';
import { INPUT_SHAPING } from './tuning';

export interface ShapedInput { throttle: number; steer: number }

const unit = (v: number) => Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
const digital = (v: number) => v === 0 || v === 1 || v === -1;
function slew(current: number, target: number, rate: number, dt: number): number {
  if (!digital(target)) return target;
  const step = rate * dt;
  return target > current ? Math.min(target, current + step) : Math.max(target, current - step);
}

/** Advance `state` one tick toward `input`; returns `state`. */
export function shapeInput(state: ShapedInput, input: DriveInput | undefined, dt: number): ShapedInput {
  state.throttle = slew(state.throttle, unit(input?.throttle ?? 0), INPUT_SHAPING.throttle, dt);
  state.steer = slew(state.steer, unit(input?.steer ?? 0), INPUT_SHAPING.steer, dt);
  return state;
}
