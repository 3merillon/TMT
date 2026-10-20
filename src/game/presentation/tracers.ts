/** Short incandescent metal streaks for machine-gun rounds and armor strikes. No smoke meshes or dithered fades. */
import type { InstanceHandle, MeshDesc, MeshHandle, SceneRegistry } from '../../engine';
import type { V3 } from '../contracts';
import { add, cross, mul, normalize, sub } from '../math';
import { muzzleTransform } from './muzzle-effects';

export const TRACER = { speed: 80, minFlight: .035, spark: .22, round: .018, sparkSize: .32, pool: 48,
  tint: [1, .82, .36] as V3, sparkTint: [1, .48, .10] as V3 } as const;

/** A narrow, tapered hot-metal sliver along +Z; opacity stays one while its geometry contracts. */
export function sparkMesh(): MeshDesc {
  const positions = new Float32Array([0, 0, 0, -1, 0, .4, 0, 1, .4, 1, 0, .4, 0, -1, .4, 0, 0, 1]);
  return { positions, normals: new Float32Array([0, 0, -1, -1, 0, 0, 0, 1, 0, 1, 0, 0, 0, -1, 0, 0, 0, 1]),
    indices: new Uint32Array([0, 2, 1, 0, 3, 2, 0, 4, 3, 0, 1, 4, 5, 1, 2, 5, 2, 3, 5, 3, 4, 5, 4, 1]), matId: 5, label: 'armor-spark-streak' };
}
interface Spark { instance: InstanceHandle; velocity: V3 }
interface Round { from: V3; to: V3; normal: V3; flight: number; age: number; instance: InstanceHandle | null; sparks: Spark[]; seed: number }

export class Tracers {
  private readonly mesh: MeshHandle;
  private readonly rounds: Round[] = [];
  private readonly model = new Float32Array(16);
  total = 0;
  constructor(private readonly scene: SceneRegistry) { this.mesh = scene.meshes.create(sparkMesh()); }

  fire(from: V3, to: V3, normal: V3 = normalize(sub(from, to))): void {
    if (this.rounds.length >= TRACER.pool) this.release(this.rounds.shift()!);
    const distance = Math.hypot(...sub(to, from)), flight = distance > .001 ? Math.max(TRACER.minFlight, distance / TRACER.speed) : 0;
    muzzleTransform(from, distance > .001 ? normalize(sub(to, from)) : normal, normalize(to), TRACER.round, Math.min(.42, distance), 0, this.model);
    this.rounds.push({ from: [...from], to: [...to], normal: Math.hypot(...normal) > .001 ? normalize(normal) : normalize(to), flight, age: 0, sparks: [], seed: this.total++,
      instance: flight ? this.scene.instances.add(this.mesh, { model: this.model, tint: TRACER.tint, objectId: 902, castShadow: false }) : null });
  }
  update(dt: number): void {
    for (let i = this.rounds.length - 1; i >= 0; i--) {
      const r = this.rounds[i]; r.age += dt;
      if (r.age < r.flight && r.instance) {
        const direction = normalize(sub(r.to, r.from));
        muzzleTransform(add(r.from, mul(sub(r.to, r.from), r.age / r.flight)), direction, normalize(r.to), TRACER.round, .42, 0, this.model);
        this.scene.instances.set(r.instance, this.model); continue;
      }
      if (r.instance) { this.scene.instances.remove(r.instance); r.instance = null; }
      const age = r.age - r.flight;
      if (age >= TRACER.spark) { this.release(r); this.rounds.splice(i, 1); continue; }
      if (!r.sparks.length) {
        const right = normalize(cross(r.normal, Math.abs(r.normal[1]) < .9 ? [0, 1, 0] : [1, 0, 0])), up = cross(right, r.normal);
        for (let j = 0; j < 7; j++) {
          const angle = j * 2.39996 + r.seed * .73, speed = 1.8 + (j % 3) * .7;
          const velocity = mul(normalize(add(mul(r.normal, .5 + (j % 2) * .35), add(mul(right, Math.cos(angle)), mul(up, Math.sin(angle))))), speed);
          muzzleTransform(r.to, velocity, normalize(r.to), .014, .08, 0, this.model);
          r.sparks.push({ velocity, instance: this.scene.instances.add(this.mesh, { model: this.model, tint: TRACER.sparkTint, objectId: 903, castShadow: false }) });
        }
      }
      const shrink = 1 - age / TRACER.spark, gravity = mul(normalize(r.to), -4.9 * age * age);
      for (const s of r.sparks) {
        muzzleTransform(add(add(r.to, mul(s.velocity, age)), gravity), s.velocity, normalize(r.to), .014 * shrink,
          (.06 + age * .65) * shrink, 0, this.model);
        this.scene.instances.set(s.instance, this.model);
      }
    }
  }
  get active(): number { return this.rounds.length; }
  private release(r: Round): void {
    if (r.instance) this.scene.instances.remove(r.instance);
    for (const s of r.sparks) this.scene.instances.remove(s.instance);
    r.instance = null; r.sparks = [];
  }
  clear(): void { for (const r of this.rounds) this.release(r); this.rounds.length = 0; }
  dispose(): void { this.clear(); this.scene.meshes.destroy(this.mesh); }
}
