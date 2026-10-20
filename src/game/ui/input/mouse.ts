/**
 * Left click or drag targets the world; right-drag orbits the camera. The wheel trims range while targeting, otherwise it zooms.
 * Touch drag aiming (touch.ts, through the gesture arbiter): press on your own tank and drag toward where the shell should
 * go. The drag direction on screen becomes the turret bearing (solved in the tank's own ground plane, so it works from
 * any camera angle) and the drag length becomes the power; the helpers for it live here with the mouse's.
 */
export type Point = readonly [number, number];
/** The tank's screen position and the screen positions of points one step along its local +Z (forward) and +X (driver-left). */
export interface TankScreenFrame { origin: Point; forward: Point; left: Point }

/**
 * Turret yaw for a drag to `pointer`: writes the drag vector in the projected (forward, left) basis and returns
 * atan2(left, forward), the turretYaw convention (forward = [sin yaw, 0, cos yaw], +X driver-left). Null when the
 * drag is too short or the basis is degenerate (camera edge-on to the ground plane).
 */
export function solveDragAim(frame: TankScreenFrame, pointer: Point, minPixels = 6): number | null {
  const [ox, oy] = frame.origin;
  const fx = frame.forward[0] - ox, fy = frame.forward[1] - oy, lx = frame.left[0] - ox, ly = frame.left[1] - oy;
  const dx = pointer[0] - ox, dy = pointer[1] - oy;
  if (Math.hypot(dx, dy) < minPixels) return null;
  const det = fx * ly - fy * lx;
  const scale = Math.max(Math.hypot(fx, fy), Math.hypot(lx, ly));
  if (!Number.isFinite(det) || scale < 1e-6 || Math.abs(det) < 1e-3 * scale * scale) return null;
  const along = (dx * ly - dy * lx) / det, across = (fx * dy - fy * dx) / det;
  return Math.atan2(across, along);
}
/** Power from the drag length: `reach` pixels (a fraction of the viewport) is full power; never below 5%. */
export function dragPower(origin: Point, pointer: Point, reach: number): number {
  const length = Math.hypot(pointer[0] - origin[0], pointer[1] - origin[1]);
  return Math.max(0.05, Math.min(1, length / Math.max(1, reach)));
}
/** A press starts a drag-aim when it lands within this many CSS pixels of the tank. */
export function grabRadius(width: number, height: number): number {
  return Math.max(28, Math.min(64, Math.min(width, height) * 0.06));
}
export function dragReach(width: number, height: number): number { return Math.min(width, height) * 0.34; }

/** Wheel up lengthens approximate range by 5.1% per 100 CSS pixels; opposite gestures undo one another. */
export function wheelRangeScale(event: Pick<WheelEvent, 'deltaY' | 'deltaMode'>, pageHeight: number): number {
  if (!Number.isFinite(event.deltaY)) return 1;
  const unit = event.deltaMode === 0 ? 1 : event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? Math.max(1, pageHeight) : 0;
  const pixels = event.deltaY * unit;
  return Number.isFinite(pixels) ? Math.exp(-Math.max(-240, Math.min(240, pixels)) * 0.0005) : 1;
}

export interface MouseAimBinding {
  enabled(): boolean;
  canvas(): HTMLCanvasElement | null;
  point(point: Point): void;
  end(cancelled: boolean): void;
  adjustRange(scale: number): boolean;
}

/** The ancestor capture handler owns left-button aiming and its range wheel; otherwise the wheel reaches the camera. */
export function bindMouseAim(root: HTMLElement, binding: MouseAimBinding): { clear(): void; dispose(): void } {
  let active: { pointer: number; canvas: HTMLCanvasElement } | undefined;
  const claim = (event: PointerEvent) => { event.preventDefault(); event.stopPropagation(); };
  const point = (event: PointerEvent, canvas: HTMLCanvasElement): Point => {
    const rect = canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };
  const clear = (cancelled = true) => {
    const previous = active;
    active = undefined;
    binding.end(cancelled);
    if (previous?.canvas.hasPointerCapture(previous.pointer)) {
      try { previous.canvas.releasePointerCapture(previous.pointer); } catch { /* Canvas detached during teardown. */ }
    }
  };
  const down = (event: PointerEvent) => {
    const canvas = binding.canvas();
    if (active || event.defaultPrevented || event.pointerType !== 'mouse' || event.button !== 0 || !canvas || event.target !== canvas || !binding.enabled()) return;
    claim(event);
    active = { pointer: event.pointerId, canvas };
    try { canvas.setPointerCapture(event.pointerId); } catch { /* Synthetic events. */ }
    canvas.parentElement?.focus({ preventScroll: true });
    binding.point(point(event, canvas));
  };
  const move = (event: PointerEvent) => {
    if (!active || event.pointerId !== active.pointer) return;
    claim(event);
    if (!binding.enabled() || (event.buttons & 1) === 0) { clear(); return; }
    binding.point(point(event, active.canvas));
  };
  const end = (event: PointerEvent) => {
    if (!active || event.pointerId !== active.pointer) return;
    claim(event);
    clear(event.type !== 'pointerup');
  };
  const wheel = (event: WheelEvent) => {
    if (!active || event.target !== active.canvas || event.defaultPrevented || event.ctrlKey || event.metaKey) return;
    if (!binding.enabled()) { clear(); return; }
    const scale = wheelRangeScale(event, root.clientHeight);
    if (scale === 1 || !binding.adjustRange(scale)) return;
    event.preventDefault(); event.stopPropagation();
  };
  const doc = root.ownerDocument, win = doc.defaultView;
  const blur = () => clear();
  const visibility = () => { if (doc.hidden) clear(); };
  root.addEventListener('pointerdown', down, true);
  root.addEventListener('pointermove', move, true);
  root.addEventListener('pointerup', end, true);
  root.addEventListener('pointercancel', end, true);
  root.addEventListener('lostpointercapture', end, true);
  root.addEventListener('wheel', wheel, { capture: true, passive: false });
  win?.addEventListener('blur', blur);
  doc.addEventListener('visibilitychange', visibility);
  return { clear, dispose: () => {
    clear();
    root.removeEventListener('pointerdown', down, true);
    root.removeEventListener('pointermove', move, true);
    root.removeEventListener('pointerup', end, true);
    root.removeEventListener('pointercancel', end, true);
    root.removeEventListener('lostpointercapture', end, true);
    root.removeEventListener('wheel', wheel, true);
    win?.removeEventListener('blur', blur);
    doc.removeEventListener('visibilitychange', visibility);
  } };
}

export interface DragAimGuide { origin: Point; pointer: Point; power: number; yaw: number }
