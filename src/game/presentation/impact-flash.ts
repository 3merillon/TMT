/**
 * Impact illumination accompanying the fluid blast and the engine's pressure front:
 * - fluid fire and smoke own the visible blast; there is no opaque sphere fallback;
 * - a point-light flash with intensity `I · scale² · e^(−9t)` (scale = blast radius / 1.5);
 * - a depth-aware 3D pressure shell, owned by the bounded engine shockwave pool.
 * Durations and intensities are presentation-only (N5) and tier-independent.
 */
import type { LightHandle, SceneRegistry } from '../../engine';
import type { V3 } from '../contracts';
import type { MunitionId } from '../munitions';

export const IMPACT_FLASH = {
  duration: 0.35, light: 12.0,
  tint: [1.0, 0.62, 0.26] as V3, lightColor: [1.0, 0.64, 0.32] as V3,
} as const;

interface Flash { radius: number; age: number; light: LightHandle | null }

/** Light intensity of a flash of blast radius `radius` at age t (seconds). */
export function flashIntensity(radius: number, t: number): number {
  const scale = radius / 1.5;
  return IMPACT_FLASH.light * 40 * scale * scale * Math.exp(-9 * t);
}

export class ImpactFlashes {
  private readonly flashes: Flash[] = [];
  total = 0;

  constructor(private readonly scene: SceneRegistry) {}

  impact(position: V3, normal: V3, radius: number, munition: MunitionId = 'explosive'): void {
    const up = norm(normal);
    const center: V3 = [position[0] + up[0] * radius * 0.35, position[1] + up[1] * radius * 0.35, position[2] + up[2] * radius * 0.35];
    this.flashes.push({
      radius, age: 0,
      light: this.light(center, radius * 7, flashIntensity(radius, 0)),
    });
    this.scene.get('shockwaves')?.emit(position, up, radius, munition);
    this.total++;
  }

  private light(position: V3, range: number, intensity: number): LightHandle | null {
    try { return this.scene.lights.add({ type: 'point', position, color: IMPACT_FLASH.lightColor, intensity, range, castShadow: true }); }
    catch { return null; }
  }

  update(dt: number): void {
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.age += dt;
      if (f.light) {
        const intensity = flashIntensity(f.radius, f.age);
        if (intensity < 0.05) { this.scene.lights.remove(f.light); f.light = null; }
        else this.scene.lights.update(f.light, { intensity });
      }
      if (!f.light) this.flashes.splice(i, 1);
    }
  }

  get active(): number { return this.flashes.length; }

  clear(): void {
    for (const f of this.flashes) if (f.light) this.scene.lights.remove(f.light);
    this.flashes.length = 0;
    this.scene.get('shockwaves')?.clear();
  }

  dispose(): void {
    this.clear();
  }
}

function norm(v: readonly number[]): V3 { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
