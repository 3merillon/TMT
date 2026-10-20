/**
 * Bottom-sheet snapping (pure). A sheet rests at one of a few named heights; a drag on its handle follows the finger and
 * the release picks a snap from the projected height (position plus a short flick), so a quick flick moves one step and a
 * slow drag lands where it is let go. A downward flick past the lowest snap dismisses when the sheet allows it.
 */
export interface SnapPoint<T extends string> { id: T; height: number }

/** Seconds of flick velocity added to the release height (a flick of 1000 px/s projects 160 px). */
export const FLICK_SECONDS = 0.16;
/** Below this fraction of the lowest snap a release dismisses (when dismissible). */
export const DISMISS_FRACTION = 0.6;

/**
 * The snap a released sheet settles on: `height` is the current height in px, `velocity` the handle's upward speed in
 * px/s (negative = downward). Returns null when the release dismisses the sheet.
 */
export function releaseSnap<T extends string>(snaps: readonly SnapPoint<T>[], height: number, velocity: number, dismissible = false): T | null {
  if (!snaps.length) return null;
  const projected = height + (Number.isFinite(velocity) ? velocity : 0) * FLICK_SECONDS;
  const lowest = snaps.reduce((a, b) => (b.height < a.height ? b : a));
  if (dismissible && projected < lowest.height * DISMISS_FRACTION) return null;
  return snaps.reduce((best, snap) => (Math.abs(snap.height - projected) < Math.abs(best.height - projected) ? snap : best)).id;
}

/** The next snap up (or down) from `current`, cycling: what a tap on the handle does. */
export function cycleSnap<T extends string>(snaps: readonly SnapPoint<T>[], current: T): T {
  const sorted = [...snaps].sort((a, b) => a.height - b.height);
  const index = sorted.findIndex(s => s.id === current);
  return sorted[(index + 1) % sorted.length].id;
}

/** Snap heights for a viewport: a peek that shows the tabs and the action, half the screen, and nearly all of it. */
export function sheetHeights(viewportHeight: number, peek: number): { peek: number; half: number; full: number } {
  const full = Math.round(Math.max(peek, viewportHeight * 0.86));
  const half = Math.round(Math.min(full, Math.max(peek + 120, viewportHeight * 0.48)));
  return { peek: Math.round(Math.min(peek, full)), half, full };
}
