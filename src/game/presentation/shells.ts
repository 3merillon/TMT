/** Physical shells share four meshes and bounded instance pools. Visibility stays sensor/terrain gated. */
import type { InstanceHandle, MeshDesc, MeshHandle, SceneRegistry } from '../../engine';
import type { SimInterpolation } from '../api/extensions';
import type { GameSnapshot, V3, WorldQuery } from '../contracts';
import type { MunitionId } from '../munitions';
import { projectileMeshes } from './projectile-models';
import { createFlightFrame, projectileMatrix, type FlightFrame } from './projectile-frame';
import { ProjectileTrailState } from './projectile-trail-state';

/** A UV sphere as a part mesh (matId from the argument; default 5 = emissive signal). */
export function sphereMesh(radius: number, segments = 16, rings = 10, matId = 5, label = 'sphere'): MeshDesc {
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  for (let r = 0; r <= rings; r++) {
    const v = r / rings, phi = v * Math.PI;
    for (let s = 0; s <= segments; s++) {
      const u = s / segments, theta = u * Math.PI * 2;
      const n = [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
      normals.push(...n); positions.push(n[0] * radius, n[1] * radius, n[2] * radius);
    }
  }
  const row = segments + 1;
  for (let r = 0; r < rings; r++) for (let s = 0; s < segments; s++) {
    const a = r * row + s, b = a + row;
    indices.push(a, a + 1, b, a + 1, b + 1, b);
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices), matId, label };
}

export function translationScale(p: readonly number[], s: number, out = new Float32Array(16)): Float32Array {
  out.fill(0);
  out[0] = s; out[5] = s; out[10] = s; out[15] = 1;
  out[12] = p[0]; out[13] = p[1]; out[14] = p[2];
  return out;
}

const MUNITIONS: readonly MunitionId[] = ['explosive', 'heavy', 'incendiary', 'nuclear'];
/** A scene can retain at most four idle shells of each type; simultaneous live projectiles are never dropped. */
export const SHELL_POOL_PER_TYPE = 4;
interface Shell { instance: InstanceHandle | null; munition: MunitionId; frame: FlightFrame; lastAge: number; touched: boolean }

export class ShellViews {
  readonly trails = new ProjectileTrailState();
  private readonly meshes = new Map<MunitionId, MeshHandle>();
  private readonly shells = new Map<number, Shell>();
  private readonly idle = new Map<MunitionId, Shell[]>();
  private readonly model = new Float32Array(16);
  private readonly position: V3 = [0, 0, 0];
  private disposed = false;

  constructor(private readonly scene: SceneRegistry) {
    const models = projectileMeshes();
    for (const kind of MUNITIONS) {
      this.meshes.set(kind, scene.meshes.create(models[kind]));
      this.idle.set(kind, []);
    }
  }

  update(state: GameSnapshot, observer: number, world: WorldQuery | undefined, dt = 1 / 60, interp?: Pick<SimInterpolation, 'alpha' | 'projectiles'>): void {
    if (this.disposed) return;
    const own = state.tanks.find(t => t.id === observer) ?? state.tanks[0];
    if (!own) { this.clear(); return; }
    this.trails.beginFrame(dt);
    const up = norm(own.position);
    const sensor: V3 = [own.position[0] + up[0] * .8, own.position[1] + up[1] * .8, own.position[2] + up[2] * .8];
    const alpha = Number.isFinite(interp?.alpha) ? Math.max(0, Math.min(1, interp!.alpha)) : 1;
    for (const shell of this.shells.values()) shell.touched = false;
    for (const p of state.projectiles) {
      const delta: V3 = [p.position[0] - sensor[0], p.position[1] - sensor[1], p.position[2] - sensor[2]];
      const distance = Math.hypot(...delta);
      const hit = distance > 1e-6 ? world?.raycast(sensor, [delta[0] / distance, delta[1] / distance, delta[2] / distance], distance) : null;
      const visible = p.owner === observer || !hit || hit.distance >= distance - .15;
      let shell = this.shells.get(p.id);
      if (!visible) { if (shell) this.release(p.id, shell); continue; }
      const munition = p.munition ?? 'explosive';
      if (shell && shell.munition !== munition) { this.release(p.id, shell); shell = undefined; }
      // The fixed-step integrator advances with the current velocity. Reconstruct
      // its previous position for render interpolation; never predict beyond it.
      const rewind = Math.min(1 / 60, Math.max(0, p.age)) * (1 - alpha);
      const remote = interp?.projectiles?.find(shell => shell.id === p.id);
      for (let i = 0; i < 3; i++) this.position[i] = remote
        ? remote.previous[i] + (remote.current[i] - remote.previous[i]) * alpha
        : p.position[i] - p.velocity[i] * rewind;
      if (!shell) {
        shell = this.idle.get(munition)!.pop();
        if (!shell) {
          shell = { instance: null, munition, frame: createFlightFrame(), lastAge: p.age, touched: true };
        }
        shell.frame.initialized = false;
        // The engine pools instance table slots. Remove dormant entries entirely
        // so retained shells issue no hidden draws or discarded fragments.
        shell.instance = this.scene.instances.add(this.meshes.get(munition)!, { model: translationScale(this.position, 1, this.model),
          tint: [1, 1, 1], objectId: 900 + MUNITIONS.indexOf(munition), castShadow: false });
        this.shells.set(p.id, shell);
      }
      if (p.age < shell.lastAge) shell.frame.initialized = false; // restored/replayed identity
      projectileMatrix(shell.frame, this.position, p.velocity, norm(p.position), Math.max(0, dt), this.model);
      this.scene.instances.set(shell.instance!, this.model);
      this.trails.track(p.id, munition, this.position, p.age);
      shell.lastAge = p.age; shell.touched = true;
    }
    for (const [id, shell] of this.shells) if (!shell.touched) this.release(id, shell);
    this.trails.endFrame();
  }

  private release(id: number, shell: Shell): void {
    this.shells.delete(id);
    if (shell.instance) this.scene.instances.remove(shell.instance);
    shell.instance = null;
    const pool = this.idle.get(shell.munition)!;
    if (pool.length < SHELL_POOL_PER_TYPE) pool.push(shell);
  }

  get count(): number { return this.shells.size; }
  /** Retained CPU presentation records; idle records own no GPU instances. No shell adds a point/shadow light. */
  get pooled(): number { let count = 0; for (const slots of this.idle.values()) count += slots.length; return count; }

  clear(): void { for (const [id, shell] of this.shells) this.release(id, shell); this.trails.clear(); }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.idle.clear();
    for (const mesh of this.meshes.values()) this.scene.meshes.destroy(mesh);
    this.meshes.clear(); this.disposed = true;
  }
}

function norm(v: readonly number[]): V3 { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
