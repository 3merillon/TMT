/**
 * Touch and pen on the match view, through the gesture arbiter (gestures.ts): a tap aims at the world, a drag orbits,
 * a pinch zooms, and a press on your own tank drags the shot. Capture-phase handlers on an ancestor of the view claim
 * every touch that lands on the canvas, so the view's own pointer handlers only ever see the mouse. Presses on HUD
 * controls marked data-camera-drag orbit on drag and activate on tap. Other controls keep their own gestures.
 * Points are canvas-relative CSS px.
 */
import { GestureArbiter, type GestureEvent } from './gestures';
import type { Point } from './mouse';

export interface TouchGestureBinding {
  /** Touch gestures belong to the match HUD now (false: the view's own handlers take the touch). */
  enabled(): boolean;
  canvas(): HTMLCanvasElement | null;
  /** The point is on the observer's tank and aiming is allowed: the press drags the shot. */
  onTank(point: Point): boolean;
  tap(point: Point): void;
  orbit(dx: number, dy: number): void;
  zoom(pixels: number): void;
  /** A drag-aim moved to `point`; null when it ended. */
  aimDrag(point: Point | null): void;
}

export function bindTouchGestures(root: HTMLElement, binding: TouchGestureBinding): { reset(): void; dispose(): void } {
  const arbiter = new GestureArbiter(), owned = new Set<number>();
  let canvas: HTMLCanvasElement | null = null;
  const taps = new Map<number, HTMLElement>();
  let lastTouchUp = -Infinity;
  const local = (event: PointerEvent): Point => {
    const rect = (canvas ?? binding.canvas())?.getBoundingClientRect();
    return rect ? [event.clientX - rect.left, event.clientY - rect.top] : [event.clientX, event.clientY];
  };
  const run = (events: GestureEvent[]) => {
    for (const event of events) {
      if (event.kind === 'tap') binding.tap(event.point);
      else if (event.kind === 'orbit') binding.orbit(event.dx, event.dy);
      else if (event.kind === 'pinch') { binding.zoom(event.zoom); binding.orbit(event.dx, event.dy); }
      else if (event.kind === 'aim') binding.aimDrag(event.point);
      else binding.aimDrag(null);
    }
  };
  const release = (id: number) => {
    owned.delete(id);
    try { if (canvas?.hasPointerCapture(id)) canvas.releasePointerCapture(id); } catch { /* detached */ }
  };
  const reset = () => { taps.clear(); for (const id of [...owned]) release(id); run(arbiter.reset()); };
  const down = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') return;
    const target = binding.canvas();
    const element = event.target instanceof Element ? event.target : null;
    const overlay = element?.closest<HTMLElement>('[data-camera-drag]');
    if (!target || (event.target !== target && !overlay) || !binding.enabled()) return;
    event.preventDefault(); event.stopPropagation();
    canvas = target; owned.add(event.pointerId);
    if (overlay) taps.set(event.pointerId, element?.closest<HTMLElement>('button') ?? overlay);
    try { target.setPointerCapture(event.pointerId); } catch { /* synthetic events */ }
    const point = local(event);
    run(arbiter.down(event.pointerId, point, event.timeStamp, !overlay && !arbiter.active && binding.onTank(point)));
  };
  const move = (event: PointerEvent) => {
    if (!owned.has(event.pointerId)) return;
    event.preventDefault(); event.stopPropagation();
    if (!binding.enabled()) { reset(); return; }
    run(arbiter.move(event.pointerId, local(event)));
  };
  const up = (event: PointerEvent) => {
    if (!owned.has(event.pointerId)) return;
    event.preventDefault(); event.stopPropagation();
    const point = local(event);
    const control = taps.get(event.pointerId); taps.delete(event.pointerId);
    const events = event.type === 'pointerup' && binding.enabled() ? arbiter.up(event.pointerId, point, event.timeStamp) : arbiter.cancel(event.pointerId);
    lastTouchUp = performance.now();
    release(event.pointerId);
    if (control) { if (events.some(e => e.kind === 'tap')) control.click(); run(events.filter(e => e.kind !== 'tap')); }
    else run(events);
  };
  const doc = root.ownerDocument, win = doc.defaultView;
  // Chromium still emits a trusted click after a prevented pointerup. We already dispatched the tap above.
  const click = (event: MouseEvent) => {
    const element = event.target instanceof Element ? event.target : null;
    const gestureSurface = event.target === canvas || !!element?.closest('[data-camera-drag]');
    // A different finger may press Fire immediately after aiming. Only suppress the arbiter's own surfaces.
    if (gestureSurface && event.isTrusted && event.detail > 0 && (event as PointerEvent).pointerType !== 'mouse' && performance.now() - lastTouchUp < 500) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  };
  const visibility = () => { if (doc.hidden) reset(); };
  root.addEventListener('pointerdown', down, true);
  root.addEventListener('pointermove', move, true);
  root.addEventListener('pointerup', up, true);
  root.addEventListener('pointercancel', up, true);
  root.addEventListener('lostpointercapture', up, true);
  root.addEventListener('click', click, true);
  win?.addEventListener('blur', reset);
  doc.addEventListener('visibilitychange', visibility);
  return { reset, dispose: () => {
    reset();
    root.removeEventListener('pointerdown', down, true);
    root.removeEventListener('pointermove', move, true);
    root.removeEventListener('pointerup', up, true);
    root.removeEventListener('pointercancel', up, true);
    root.removeEventListener('lostpointercapture', up, true);
    root.removeEventListener('click', click, true);
    win?.removeEventListener('blur', reset);
    doc.removeEventListener('visibilitychange', visibility);
  } };
}
