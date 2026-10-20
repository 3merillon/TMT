/**
 * Gamepad input through the Gamepad API (standard mapping). Driving uses a radial deadzone of 0.12; aiming uses
 * 0.22 to reject the resting offset of real controllers, which otherwise slowly steers the bearing while idle. An expo
 * curve of 1.6, so small deflections give fine aim and full deflection still reaches full speed.
 *
 *   aim:   left or right stick aims (x bearing, y elevation), LT/RT or LB/RB power, A fire, X/Y munition, B radar
 *   drive: left stick drives, right stick aims, A fire, B hold position
 *   any match: Start pause, R3 follow the tank, Back planet view;  menus: d-pad focus, A confirm, B back
 *
 * The shaping and the per-frame mapping are pure; `readGamepad` is the only DOM access.
 */
import { AIM_SPEED, PAD, PAD_PRESS, type AimRates, type DriveAxes, type InputContext, type PressAction } from './bindings';

export const DEADZONE = 0.12;
export const AIM_DEADZONE = 0.22;
export const EXPO = 1.6;
/** A button counts as pressed above this value (analog triggers included). */
export const BUTTON_THRESHOLD = 0.5;

export interface PadSnapshot { readonly axes: readonly number[]; readonly buttons: readonly number[] }
export interface PadFrame { drive: DriveAxes; rates: AimRates; presses: PressAction[] }

const finite = (v: number | undefined) => typeof v === 'number' && Number.isFinite(v) ? v : 0;

/** One axis: zero inside the deadzone, then rescaled to [0, 1] and shaped by the expo curve, sign kept. */
export function shapeAxis(value: number, deadzone = DEADZONE, expo = EXPO): number {
  const magnitude = Math.min(1, Math.abs(finite(value)));
  if (magnitude <= deadzone) return 0;
  return Math.sign(value) * ((magnitude - deadzone) / (1 - deadzone)) ** expo;
}
/** A stick: radial deadzone on the vector length (no square "cross" artefacts), expo on the length, direction kept. */
export function shapeStick(x: number, y: number, deadzone = DEADZONE, expo = EXPO): [number, number] {
  const fx = finite(x), fy = finite(y), length = Math.hypot(fx, fy);
  if (length <= deadzone) return [0, 0];
  const shaped = shapeAxis(Math.min(1, length), deadzone, expo) / length;
  return [fx * shaped, fy * shaped];
}

const pressed = (pad: PadSnapshot | undefined, index: number) => finite(pad?.buttons[index]) > BUTTON_THRESHOLD;

/** Maps one polled pad state to drive axes, aim rates and the buttons that went down since `previous`. */
export function padFrame(context: InputContext, pad: PadSnapshot, previous?: PadSnapshot): PadFrame {
  const [lx, ly] = shapeStick(finite(pad.axes[0]), finite(pad.axes[1]), context === 'aim' ? AIM_DEADZONE : DEADZONE);
  const [rx, ry] = shapeStick(finite(pad.axes[2]), finite(pad.axes[3]), AIM_DEADZONE);
  const drive = { throttle: 0, steer: 0 }, rates = { yaw: 0, pitch: 0, power: 0 };
  const aimFrom = (x: number, y: number) => { rates.yaw += -x * AIM_SPEED.yaw; rates.pitch += -y * AIM_SPEED.pitch; };
  if (context === 'aim') { aimFrom(lx, ly); aimFrom(rx, ry); }
  if (context === 'drive') { drive.throttle = -ly; drive.steer = lx; aimFrom(rx, ry); }
  if (context === 'aim' || context === 'drive') {
    const power = shapeAxis(finite(pad.buttons[PAD.RT])) - shapeAxis(finite(pad.buttons[PAD.LT])) + Number(pressed(pad, PAD.RB)) - Number(pressed(pad, PAD.LB));
    rates.power = Math.max(-1, Math.min(1, power)) * AIM_SPEED.power;
  }
  rates.yaw = Math.max(-AIM_SPEED.yaw, Math.min(AIM_SPEED.yaw, rates.yaw));
  rates.pitch = Math.max(-AIM_SPEED.pitch, Math.min(AIM_SPEED.pitch, rates.pitch));
  const presses: PressAction[] = [];
  const table = PAD_PRESS[context];
  for (const key of Object.keys(table)) {
    const index = Number(key);
    if (pressed(pad, index) && !pressed(previous, index)) presses.push(table[index]);
  }
  return { drive, rates, presses };
}

/** The first connected standard gamepad, as a plain snapshot (undefined without the API or a pad). */
export function readGamepad(nav: Pick<Navigator, 'getGamepads'> | undefined = globalThis.navigator): PadSnapshot | undefined {
  let pads: readonly (Gamepad | null)[];
  try { pads = nav?.getGamepads?.() ?? []; } catch { return undefined; }
  const pad = pads.find(p => p && p.connected && (p.mapping === 'standard' || p.mapping === ''));
  return pad ? { axes: [...pad.axes], buttons: pad.buttons.map(b => b.value || (b.pressed ? 1 : 0)) } : undefined;
}
