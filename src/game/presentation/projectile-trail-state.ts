/** Bounded, distance-spaced smoke samples. Never changes authoritative flight or reconstructs an unseen path. */
import type { V3 } from '../contracts';
import type { MunitionId } from '../munitions';

export const PROJECTILE_TRAIL = { capacity: 2048, maxPerStep: 64, maxSegment: 6 } as const;
export const TRAIL_STYLE = {
  explosive: { spacing: .10, radius: .14, life: 1.25, opacity: .60, color: [.72, .73, .72] },
  heavy: { spacing: .11, radius: .17, life: 1.45, opacity: .62, color: [.66, .67, .65] },
  incendiary: { spacing: .10, radius: .15, life: 1.4, opacity: .60, color: [.62, .59, .55] },
  nuclear: { spacing: .13, radius: .19, life: 1.6, opacity: .65, color: [.75, .75, .70] },
} as const;
export interface TrailPuff { position: V3; age: number; munition: MunitionId; phase: number }
interface Emitter { position: V3; age: number; remainder: number; touched: boolean; munition: MunitionId }

export class ProjectileTrailState {
  readonly particles: TrailPuff[] = [];
  private readonly emitters = new Map<number, Emitter>();
  private serial = 0;
  private replace = 0;
  private dt = 0;

  beginFrame(dt: number): void {
    this.dt = Number.isFinite(dt) ? Math.max(0, Math.min(dt, .1)) : 0;
    let live = 0;
    for (const p of this.particles) {
      p.age += this.dt;
      if (p.age < TRAIL_STYLE[p.munition].life) this.particles[live++] = p;
    }
    this.particles.length = live;
    for (const emitter of this.emitters.values()) emitter.touched = false;
  }

  track(id: number, munition: MunitionId, position: V3, age: number): void {
    if (!position.every(Number.isFinite) || !Number.isFinite(age)) return;
    let emitter = this.emitters.get(id);
    const distance = emitter ? Math.hypot(...position.map((v, i) => v - emitter!.position[i])) : 0;
    if (!emitter || age < emitter.age || munition !== emitter.munition || distance > PROJECTILE_TRAIL.maxSegment) {
      emitter = { position: [...position], age, remainder: 0, touched: true, munition };
      this.emitters.set(id, emitter);
      this.emit(position, munition, 0);
      return;
    }
    if (distance > 1e-7) {
      const spacing = TRAIL_STYLE[munition].spacing;
      let at = spacing - emitter.remainder;
      for (let count = 0; at <= distance + 1e-7 && count < PROJECTILE_TRAIL.maxPerStep; count++, at += spacing) {
        const fraction = Math.min(1, at / distance);
        this.emit(position.map((v, i) => emitter!.position[i] + (v - emitter!.position[i]) * fraction) as V3, munition, this.dt * (1 - fraction));
      }
      emitter.remainder = (emitter.remainder + distance) % spacing;
      if (spacing - emitter.remainder < 1e-7) emitter.remainder = 0;
    }
    emitter.position = [...position]; emitter.age = age; emitter.touched = true;
  }

  endFrame(): void {
    for (const [id, emitter] of this.emitters) if (!emitter.touched) this.emitters.delete(id);
  }

  private emit(position: V3, munition: MunitionId, age: number): void {
    const puff: TrailPuff = { position: [...position], munition, age, phase: (this.serial++ * 2.39996323) % (2 * Math.PI) };
    if (this.particles.length < PROJECTILE_TRAIL.capacity) this.particles.push(puff);
    else this.particles[this.replace++ % PROJECTILE_TRAIL.capacity] = puff;
  }

  snapshot() { return { particles: this.particles.length, emitters: this.emitters.size, capacity: PROJECTILE_TRAIL.capacity }; }
  clear(): void { this.particles.length = 0; this.emitters.clear(); this.serial = this.replace = 0; }
}
