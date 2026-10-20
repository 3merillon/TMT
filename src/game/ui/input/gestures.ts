/**
 * The touch gesture arbiter (pure): one state machine decides what a touch on the world means, so tap, orbit, pinch and
 * drag-aim never fight over the same finger.
 *
 *   tap       one finger, released within `tapMs` without moving more than `tapSlop` px: aim at that point
 *   orbit     one finger moved past `tapSlop` (the whole movement orbits, so nothing is lost to the threshold)
 *   pinch     a second finger: the spread zooms (wheel pixels, as the mouse wheel) and the midpoint orbits
 *   aim       a press that starts on your own tank drags the shot (bearing and power); other fingers are ignored
 *
 * A finger left over from a pinch orbits but never taps. Controls are DOM elements outside the canvas, so a gesture
 * that starts on a control never reaches the arbiter at all.
 */
import type { Point } from './mouse';

export const GESTURE = Object.freeze({ tapSlop: 10, tapMs: 350, zoomPerPixel: 0.0015 });

export type GestureEvent =
  | { kind: 'tap'; point: Point }
  | { kind: 'orbit'; dx: number; dy: number }
  | { kind: 'pinch'; zoom: number; dx: number; dy: number }
  | { kind: 'aim'; point: Point }
  | { kind: 'aim-end' };
export type GestureMode = 'idle' | 'pending' | 'orbit' | 'pinch' | 'aim';

interface Track { start: Point; last: Point; time: number }

export class GestureArbiter {
  private readonly pointers = new Map<number, Track>();
  private aimPointer = -1;
  private modeValue: GestureMode = 'idle';

  constructor(private readonly o: { tapSlop: number; tapMs: number; zoomPerPixel: number } = GESTURE) {}

  get mode(): GestureMode { return this.modeValue; }
  get active(): boolean { return this.modeValue !== 'idle'; }

  /** A finger lands; `onTank` says whether it landed on the observer's tank while aiming is allowed. */
  down(id: number, point: Point, time: number, onTank = false): GestureEvent[] {
    if (this.modeValue === 'aim') return [];
    if (this.modeValue === 'idle' && onTank) {
      this.modeValue = 'aim'; this.aimPointer = id;
      return [{ kind: 'aim', point }];
    }
    this.pointers.set(id, { start: point, last: point, time });
    this.modeValue = this.pointers.size > 1 ? 'pinch' : this.modeValue === 'idle' ? 'pending' : this.modeValue;
    return [];
  }

  move(id: number, point: Point): GestureEvent[] {
    if (this.modeValue === 'aim') return id === this.aimPointer ? [{ kind: 'aim', point }] : [];
    const track = this.pointers.get(id);
    if (!track) return [];
    const dx = point[0] - track.last[0], dy = point[1] - track.last[1];
    if (this.modeValue === 'pinch') {
      const other = [...this.pointers].find(([key]) => key !== id)?.[1];
      if (!other) return [];
      const before = Math.hypot(track.last[0] - other.last[0], track.last[1] - other.last[1]);
      track.last = point;
      const after = Math.hypot(point[0] - other.last[0], point[1] - other.last[1]);
      const zoom = before > 1 && after > 1 ? Math.log(before / after) / this.o.zoomPerPixel : 0;
      return [{ kind: 'pinch', zoom, dx: dx / 2, dy: dy / 2 }];
    }
    if (this.modeValue === 'pending') {
      if (Math.hypot(point[0] - track.start[0], point[1] - track.start[1]) <= this.o.tapSlop) return [];
      this.modeValue = 'orbit';
      track.last = point;
      return [{ kind: 'orbit', dx: point[0] - track.start[0], dy: point[1] - track.start[1] }];
    }
    track.last = point;
    return dx || dy ? [{ kind: 'orbit', dx, dy }] : [];
  }

  up(id: number, point: Point, time: number): GestureEvent[] {
    if (this.modeValue === 'aim') {
      if (id !== this.aimPointer) return [];
      this.reset();
      return [{ kind: 'aim-end' }];
    }
    const track = this.pointers.get(id);
    if (!track) return [];
    const tap = this.modeValue === 'pending' && this.pointers.size === 1 && time - track.time <= this.o.tapMs
      && Math.hypot(point[0] - track.start[0], point[1] - track.start[1]) <= this.o.tapSlop;
    this.release(id);
    return tap ? [{ kind: 'tap', point: track.start }] : [];
  }

  /** The browser took the finger (pointercancel, lost capture): never a tap. */
  cancel(id: number): GestureEvent[] {
    if (this.modeValue === 'aim') {
      if (id !== this.aimPointer) return [];
      this.reset();
      return [{ kind: 'aim-end' }];
    }
    if (this.pointers.has(id)) this.release(id);
    return [];
  }

  /** Drops every finger (blur, context switch); ends a drag-aim. */
  reset(): GestureEvent[] {
    const aiming = this.modeValue === 'aim';
    this.pointers.clear(); this.aimPointer = -1; this.modeValue = 'idle';
    return aiming ? [{ kind: 'aim-end' }] : [];
  }

  private release(id: number): void {
    this.pointers.delete(id);
    // A finger left from a pinch keeps orbiting from where it is; it can no longer tap.
    this.modeValue = this.pointers.size === 0 ? 'idle' : this.pointers.size === 1 ? 'orbit' : 'pinch';
  }
}
