/** Player damage feedback follows actual health loss, including coax fire. DOM compositing keeps it smooth and opaque geometry-free. */
import type { TankState } from '../contracts';

export class HitFeedback {
  private readonly element: HTMLElement;
  private actor = '';
  private health = NaN;
  private strength = 0;
  constructor(host: HTMLElement) {
    this.element = document.createElement('div');
    this.element.className = 'hit-feedback'; this.element.setAttribute('aria-hidden', 'true');
    host.append(this.element);
  }
  /** Returns the fraction of health lost this frame, for a small matching camera jolt. */
  update(tank: TankState, dt: number): number {
    const actor = `${tank.id}:${tank.generation ?? 0}`, loss = actor === this.actor ? Math.max(0, this.health - tank.health) : 0;
    if (actor !== this.actor) this.strength = 0;
    this.actor = actor; this.health = tank.health;
    this.strength = Math.max(0, this.strength - Math.max(0, dt) * 2.4);
    const fraction = loss / Math.max(1, tank.maxHealth ?? 100);
    if (loss > 0) this.strength = Math.min(1, Math.max(.4, this.strength) + fraction * 2);
    this.element.style.opacity = this.strength.toFixed(3);
    return fraction;
  }
  clear(): void { this.actor = ''; this.health = NaN; this.strength = 0; this.element.style.opacity = '0'; }
  dispose(): void { this.element.remove(); }
}
