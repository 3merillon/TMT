/**
 * Bottom sheets (DOM; the snapping is sheet-model.ts). On a phone every screen card is a sheet with a handle: a swipe
 * down on the handle or the card head dismisses it (Back / Resume), a tap on the handle does the same, and the handle is
 * a real button for keyboards and screen readers. The workshop's part sheet rests at snap heights instead.
 * The card moves with a transform only while the finger is down; nothing is laid out per frame.
 */
import { cycleSnap, releaseSnap, type SnapPoint } from './sheet-model';

interface Drag { pointer: number; startY: number; lastY: number; lastT: number; velocity: number; moved: boolean }
const SLOP = 6;

function track(handle: HTMLElement, o: { begin(): void; move(dy: number): void; end(drag: Drag | null): void }): void {
  let drag: Drag | null = null;
  handle.addEventListener('pointerdown', event => {
    if (drag || (event.pointerType === 'mouse' && event.button !== 0)) return;
    drag = { pointer: event.pointerId, startY: event.clientY, lastY: event.clientY, lastT: event.timeStamp, velocity: 0, moved: false };
    o.begin();
    try { handle.setPointerCapture(event.pointerId); } catch { /* synthetic */ }
  });
  handle.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const dt = Math.max(1, event.timeStamp - drag.lastT);
    drag.velocity = (drag.lastY - event.clientY) / dt * 1000;
    drag.lastY = event.clientY; drag.lastT = event.timeStamp;
    if (Math.abs(event.clientY - drag.startY) > SLOP) drag.moved = true;
    if (drag.moved) { event.preventDefault(); o.move(event.clientY - drag.startY); }
  });
  const end = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const finished = drag; drag = null;
    o.end(event.type === 'pointerup' ? finished : null);
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

/** A dismissible card: swipe the handle or head down to close; a click on the handle (or Enter/Space on it) closes too. */
export function bindSwipeDismiss(card: HTMLElement, handle: HTMLElement, head: HTMLElement | null, dismiss: () => void): void {
  let height = 0, suppressClick = false;
  const reset = () => { card.style.transform = ''; card.classList.remove('is-dragging'); };
  for (const target of [handle, head].filter((n): n is HTMLElement => !!n)) track(target, {
    begin: () => { height = card.getBoundingClientRect().height; card.classList.add('is-dragging'); },
    move: dy => { card.style.transform = `translateY(${Math.max(0, dy)}px)`; },
    end: drag => {
      if (drag?.moved) {
        suppressClick = true;
        const shown = height - Math.max(0, drag.lastY - drag.startY);
        if (releaseSnap([{ id: 'open', height }], shown, drag.velocity, true) === null) { dismiss(); return; }
      }
      reset();
    },
  });
  handle.addEventListener('click', () => { if (suppressClick) { suppressClick = false; return; } dismiss(); });
}

/**
 * A snapping sheet: the handle drags its height (a CSS variable on the sheet), a release settles on a snap, a tap cycles.
 * `settle` runs once per settled snap (the workshop resizes its view then, never during the drag).
 */
export function bindSnapSheet<T extends string>(sheet: HTMLElement, handle: HTMLElement, o: { snaps(): SnapPoint<T>[]; current(): T; settle(id: T): void }): void {
  let start = 0, suppressClick = false;
  track(handle, {
    begin: () => { start = sheet.getBoundingClientRect().height; sheet.classList.add('is-dragging'); },
    move: dy => { sheet.style.setProperty('--sheet-drag', `${Math.max(48, start - dy)}px`); },
    end: drag => {
      sheet.classList.remove('is-dragging'); sheet.style.removeProperty('--sheet-drag');
      if (!drag?.moved) return;
      suppressClick = true;
      const snap = releaseSnap(o.snaps(), start - (drag.lastY - drag.startY), drag.velocity);
      if (snap) o.settle(snap);
    },
  });
  handle.addEventListener('click', () => { if (suppressClick) { suppressClick = false; return; } o.settle(cycleSnap(o.snaps(), o.current())); });
}
