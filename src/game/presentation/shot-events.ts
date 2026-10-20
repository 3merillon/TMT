import type { ShotEvent } from '../contracts';

/** Constant-space, per-match event guard. IDs increase in the authoritative simulation.
 * Restore consumes historical events before presentation; reset starts a fresh ID epoch. */
export class ShotEvents {
  private latest = -1;
  private legacy = new WeakSet<ShotEvent>();

  accept(event: ShotEvent): boolean {
    if (!event.launch) {
      if (this.legacy.has(event)) return false;
      this.legacy.add(event);
      return true;
    }
    if (event.launch.id <= this.latest) return false;
    this.latest = event.launch.id;
    return true;
  }

  clear(): void { this.latest = -1; this.legacy = new WeakSet(); }
}
