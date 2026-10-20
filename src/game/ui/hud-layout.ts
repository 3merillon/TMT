/**
 * HUD layout (pure): which match controls are visible for an input context, which input style the HUD dresses for,
 * and how much of the viewport the HUD covers (the mobile budget, measured by captures).
 *
 *   context  stick   primary      also shown
 *   aim      aim     fire         power, munition, radar, camera        (tap = aim, drag = orbit)
 *   drive    drive   hold         camera                                (relocation after your shot)
 *   drive    drive   fire         power, munition, camera               (the drive test aims and drives at once)
 *   drive    drive   fire         power, munition, radar, camera        (a realtime match: the same, plus the radar)
 *   watch    —       —            camera                                (the opponent's turn, the finish)
 *   menu     —       —            —                                     (a screen is up; the HUD is hidden)
 */
import type { InputContext } from './input/bindings';

/** 'touch' shows the joystick and thumb buttons; 'pointer' shows the compact dock with keyboard hints. */
export type InputStyle = 'touch' | 'pointer';
export interface HudControls {
  stick: 'aim' | 'drive' | null;
  primary: 'fire' | 'hold' | null;
  power: boolean;
  munition: boolean;
  scan: boolean;
  camera: boolean;
}

export function hudControls(context: InputContext, driveTest: boolean, realtime = false): HudControls {
  if (context === 'aim') return { stick: 'aim', primary: 'fire', power: true, munition: true, scan: !driveTest, camera: true };
  if (context === 'drive') return driveTest || realtime
    ? { stick: 'drive', primary: 'fire', power: true, munition: true, scan: realtime, camera: true }
    : { stick: 'drive', primary: 'hold', power: false, munition: false, scan: false, camera: true };
  if (context === 'watch') return { stick: null, primary: null, power: false, munition: false, scan: false, camera: true };
  return { stick: null, primary: null, power: false, munition: false, scan: false, camera: false };
}

/**
 * The style a page starts in: `?touch=1` forces the thumb controls and `?touch=0` the mouse dock (forced styles never switch;
 * useful in desktop device emulation), otherwise a coarse primary pointer starts in touch.
 */
export function initialInputStyle(search: string, coarse: boolean): { style: InputStyle; forced: boolean } {
  const flag = new URLSearchParams(search).get('touch');
  if (flag === '1' || flag === 'true') return { style: 'touch', forced: true };
  if (flag === '0' || flag === 'false') return { style: 'pointer', forced: true };
  return { style: coarse ? 'touch' : 'pointer', forced: false };
}

/** The style for a pointer type ('' and unknown types keep the current style); pen counts as touch. */
export function inputStyleFor(pointerType: string, current: InputStyle): InputStyle {
  return pointerType === 'mouse' ? 'pointer' : pointerType === 'touch' || pointerType === 'pen' ? 'touch' : current;
}

export interface Rect { left: number; top: number; right: number; bottom: number }

/** Exact area of the union of rectangles clipped to a `width` × `height` viewport (coordinate compression). */
export function unionArea(rects: readonly Rect[], width: number, height: number): number {
  const clipped = rects.map(r => ({ left: Math.max(0, r.left), top: Math.max(0, r.top), right: Math.min(width, r.right), bottom: Math.min(height, r.bottom) }))
    .filter(r => r.right > r.left && r.bottom > r.top);
  const xs = [...new Set(clipped.flatMap(r => [r.left, r.right]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    const x0 = xs[i], x1 = xs[i + 1];
    const spans = clipped.filter(r => r.left <= x0 && r.right >= x1).map(r => [r.top, r.bottom] as const).sort((a, b) => a[0] - b[0]);
    let covered = 0, top = -Infinity, bottom = -Infinity;
    for (const [t, b] of spans) {
      if (t > bottom) { covered += bottom - top > 0 ? bottom - top : 0; top = t; bottom = b; } else bottom = Math.max(bottom, b);
    }
    covered += bottom - top > 0 ? bottom - top : 0;
    area += covered * (x1 - x0);
  }
  return area;
}

/** The fraction of the viewport the rectangles cover, 0..1. */
export function coverage(rects: readonly Rect[], width: number, height: number): number {
  return width > 0 && height > 0 ? unionArea(rects, width, height) / (width * height) : 0;
}
