import type { QualityTier, Vec3 } from '../../contracts';

export type ShockwaveKind = 'explosive' | 'heavy' | 'incendiary' | 'nuclear';
export const MAX_SHOCKWAVES = 8;
export const SHOCKWAVE_PROFILES = {
  explosive: { duration: 0.78, reach: 2.7, pressure: 0.85, condensation: 0.13, dust: 0.30 },
  heavy: { duration: 0.94, reach: 2.9, pressure: 1.05, condensation: 0.16, dust: 0.46 },
  incendiary: { duration: 0.66, reach: 2.2, pressure: 0.62, condensation: 0.08, dust: 0.21 },
  nuclear: { duration: 1.5, reach: 3.3, pressure: 1.5, condensation: 0.23, dust: 0.56 },
} as const;

export interface Shockwave {
  readonly center: Vec3;
  readonly normal: Vec3;
  readonly radius: number;
  readonly kind: ShockwaveKind;
  readonly serial: number;
  age: number;
}

/** Fast initial expansion with a weakening tail. Radius is world-space, independent of the camera. */
export function shockwaveState(wave: Shockwave) {
  const p = SHOCKWAVE_PROFILES[wave.kind];
  const t = Math.min(1, Math.max(0, wave.age / p.duration));
  const radius = wave.radius * (0.18 + p.reach * (1 - (1 - t) ** 1.6));
  const fade = Math.min(1, t / 0.065) * (1 - t) ** 1.7;
  return { radius, thickness: 0.025 + radius * 0.012, fade, t, profile: p };
}

/** Bounded CPU metadata; all GPU data lives in one fixed uniform buffer shared by every impact. */
export class ShockwavePool {
  readonly waves: Shockwave[] = [];
  emitted = 0;
  replaced = 0;
  private serial = 0;
  capacity = MAX_SHOCKWAVES;

  setTier(tier: QualityTier): void {
    this.capacity = tier === 'low' ? 3 : tier === 'medium' ? 5 : MAX_SHOCKWAVES;
    if (this.waves.length > this.capacity) this.waves.splice(0, this.waves.length - this.capacity);
  }

  emit(point: readonly number[], normal: readonly number[], radius: number, kind: ShockwaveKind): void {
    if (!(radius > 0) || !Number.isFinite(radius) || point.length < 3 || normal.length < 3
      || ![...point, ...normal].every(Number.isFinite)) return;
    const n = Math.hypot(normal[0], normal[1], normal[2]) || 1;
    const up: Vec3 = [normal[0] / n, normal[1] / n, normal[2] / n];
    if (this.waves.length >= this.capacity) { this.waves.shift(); this.replaced++; }
    this.waves.push({
      center: [point[0] + up[0] * radius * 0.1, point[1] + up[1] * radius * 0.1, point[2] + up[2] * radius * 0.1],
      normal: up, radius, kind, age: 0, serial: ++this.serial,
    });
    this.emitted++;
  }

  advance(dt: number): void {
    const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    for (let i = this.waves.length - 1; i >= 0; i--) {
      this.waves[i].age += step;
      if (this.waves[i].age >= SHOCKWAVE_PROFILES[this.waves[i].kind].duration) this.waves.splice(i, 1);
    }
  }

  clear(): void { this.waves.length = 0; }
}

/** Ray interval of a sphere, clipped to the eye and the visible scene. CPU mirror used for occlusion gates. */
export function visibleShellLength(eye: Vec3, ray: Vec3, center: Vec3, radius: number, thickness: number, sceneDistance: number): number {
  const ox = eye[0] - center[0], oy = eye[1] - center[1], oz = eye[2] - center[2];
  const b = ox * ray[0] + oy * ray[1] + oz * ray[2];
  const c = ox * ox + oy * oy + oz * oz;
  const interval = (r: number) => {
    const discriminant = b * b - c + r * r;
    if (discriminant <= 0) return 0;
    const half = Math.sqrt(discriminant);
    return Math.max(0, Math.min(sceneDistance, -b + half) - Math.max(0, -b - half));
  };
  return Math.max(0, interval(radius) - interval(Math.max(0, radius - thickness)));
}
