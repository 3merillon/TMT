/**
 * The fixed virtual joystick (DOM). The base never moves: a thumb anywhere in its zone (the base plus a margin) is read
 * against the base's centre, the knob follows within the rim, and the vector goes to the input controller as a virtual
 * gamepad stick (input/joystick.ts). It releases on lift, pointercancel, lost capture, window blur, a hidden page and
 * `reset()` (context switches), and the DOM is touched only when a pointer moves.
 */
import { stickState } from '../input/joystick';
import type { Point } from '../input/mouse';

export interface JoystickBinding {
  enabled(): boolean;
  set(x: number, y: number): void;
  release(): void;
}

/** How far the knob's centre may travel, as a share of the base radius (it stays inside the rim). */
const KNOB_TRAVEL = 0.62;

export function mountJoystick(zone: HTMLElement, base: HTMLElement, knob: HTMLElement, binding: JoystickBinding): { reset(): void; dispose(): void } {
  let active: { pointer: number; origin: Point; radius: number } | null = null;
  const place = (x: number, y: number, radius: number) => {
    knob.style.transform = `translate(${(x * radius * KNOB_TRAVEL).toFixed(1)}px, ${(y * radius * KNOB_TRAVEL).toFixed(1)}px)`;
  };
  const reset = () => {
    if (!active) return;
    const pointer = active.pointer;
    active = null;
    try { if (zone.hasPointerCapture(pointer)) zone.releasePointerCapture(pointer); } catch { /* detached */ }
    zone.classList.remove('is-active');
    knob.style.transform = '';
    binding.release();
  };
  const read = (event: PointerEvent) => {
    if (!active) return;
    const state = stickState(active.origin, [event.clientX, event.clientY], active.radius, Infinity);
    place(state.x, state.y, active.radius);
    binding.set(state.x, state.y);
  };
  const down = (event: PointerEvent) => {
    if (active || (event.pointerType === 'mouse' && event.button !== 0) || !binding.enabled()) return;
    event.preventDefault();
    const rect = base.getBoundingClientRect();
    active = { pointer: event.pointerId, origin: [rect.left + rect.width / 2, rect.top + rect.height / 2], radius: Math.max(1, rect.width / 2) };
    try { zone.setPointerCapture(event.pointerId); } catch { /* synthetic events */ }
    zone.classList.add('is-active');
    read(event);
  };
  const move = (event: PointerEvent) => {
    if (!active || event.pointerId !== active.pointer) return;
    event.preventDefault();
    if (!binding.enabled()) { reset(); return; }
    read(event);
  };
  const up = (event: PointerEvent) => { if (active && event.pointerId === active.pointer) reset(); };
  const visibility = () => { if (document.hidden) reset(); };
  zone.addEventListener('pointerdown', down);
  zone.addEventListener('pointermove', move);
  zone.addEventListener('pointerup', up);
  zone.addEventListener('pointercancel', up);
  zone.addEventListener('lostpointercapture', up);
  window.addEventListener('blur', reset);
  document.addEventListener('visibilitychange', visibility);
  return { reset, dispose: () => {
    reset();
    zone.removeEventListener('pointerdown', down);
    zone.removeEventListener('pointermove', move);
    zone.removeEventListener('pointerup', up);
    zone.removeEventListener('pointercancel', up);
    zone.removeEventListener('lostpointercapture', up);
    window.removeEventListener('blur', reset);
    document.removeEventListener('visibilitychange', visibility);
  } };
}
