/** The debris world's side of the presentation channel: a DebrisDynamics plus the per-shard work TerrainDebris used to
 * do around each step (water assignment, splash detection, shatter candidates), driven by one message per frame. It
 * runs in the debris worker, or in-process when the world has no native engine. Cosmetic: nothing here feeds gameplay. */
import type * as RAPIER from '@dimforge/rapier3d-compat';
import type { Q4, TankState, V3, WorldQuery } from '../contracts';
import { DebrisDynamics, shardWaterSpan, type RigidShard } from './debris-dynamics';
import type { DebrisWater } from './debris-physics';
import { mul, normalize } from '../math';

/** A new shard: its convex vertices (shard-local), initial state and the facts the shatter test needs. */
export interface DebrisAdd { id: number; positions: Float32Array; position: V3; velocity: V3; rotation: Q4; angularVelocity: V3; radius: number; density: number; generation: number }
export type DebrisCommand = ['add', DebrisAdd] | ['remove', number] | ['kick', number, V3] | ['place', number, V3, V3];
export type DebrisTank = Pick<TankState, 'id' | 'position' | 'rotation' | 'turretYaw' | 'barrelPitch' | 'loadout'> &
  Partial<Pick<TankState, 'health' | 'retired' | 'generation' | 'kit' | 'visualKind' | 'machinery' | 'components' | 'wheelSuspension' | 'suspension'>>;
/** A mirrored structural body. `shapes` is sent only when the body's shapes object changed (a rebuilt body). */
export interface DebrisSupport { id: number; position: V3; rotation: Q4; shapes?: { vertices: Float32Array; offset?: V3 }[] }
/** One committed terrain version: changed and removed collision pages, or the whole surface as a triangle soup. */
export interface DebrisTerrain { version: number; set?: [string, Float32Array, Uint32Array][]; remove?: string[]; triangles?: Float32Array; complete: boolean }
/** Water probe per shard: [id, sample, where it was taken]; null clears it. */
export type DebrisWaterEntry = [number, DebrisWater | null, V3 | null];
export interface DebrisFrame { frame: number; commands: DebrisCommand[]; water: DebrisWaterEntry[]; terrain?: DebrisTerrain[];
  tanks: DebrisTank[]; supports: DebrisSupport[]; substeps: number }
/** Values per shard in DebrisResult.state: id, position, velocity, rotation, angular velocity, sleeping, impact speed, age. */
export const DEBRIS_STRIDE = 17;
/** splashes: [x, y, z, radius, speed] per splash; shatters: ids of first-generation shards that hit hard enough. */
export interface DebrisResult { frame: number; state: Float64Array; splashes: Float64Array; shatters: number[] }

interface HostShard extends RigidShard { id: number; generation: number; sample?: DebrisWater; sampledAt?: V3; waterGap?: number; lastSplash?: number }
type Shapes = NonNullable<DebrisSupport['shapes']>;

export class DebrisHost {
  private dynamics?: DebrisDynamics;
  private readonly shards: HostShard[] = [];
  private readonly byId = new Map<number, HostShard>();
  private readonly pages = new Map<string, { mesh: { positions: Float32Array; indices: Uint32Array } }>();
  private staged?: { set: Map<string, [Float32Array, Uint32Array]>; remove: Set<string> };
  private soup?: Float32Array;
  private version = -1;
  private readonly shapes = new Map<number, Shapes>();
  private supports: { id: number; position: V3; rotation: Q4; shapes: Shapes }[] = [];
  private readonly span: [number, number] = [0, 0];
  /** The committed terrain and mirrored structures, read by DebrisDynamics.syncScene as a WorldQuery. */
  private readonly query: WorldQuery;
  constructor(private readonly createWorld: () => RAPIER.World | undefined) {
    const self = this;
    this.query = { get version() { return self.version; }, get fixedChunks() { return self.soup ? undefined : () => self.pages; },
      visibilityTriangles: () => self.triangles(), collisionBodies: () => self.supports } as unknown as WorldQuery;
  }
  private * triangles() {
    const t = this.soup!;
    for (let i = 0; i < t.length; i += 9) yield { a: [t[i], t[i + 1], t[i + 2]] as V3, b: [t[i + 3], t[i + 4], t[i + 5]] as V3, c: [t[i + 6], t[i + 7], t[i + 8]] as V3 };
  }
  get size(): number { return this.shards.length; }
  apply(frame: DebrisFrame): DebrisResult {
    const dynamics = this.dynamics ??= new DebrisDynamics(this.createWorld());
    for (const command of frame.commands) {
      if (command[0] === 'add') {
        const a = command[1];
        const shard: HostShard = { id: a.id, generation: a.generation, positions: a.positions, rotation: a.rotation, angularVelocity: a.angularVelocity,
          body: { position: a.position, velocity: a.velocity, radius: a.radius, age: 0, bounces: 0, sleeping: false, density: a.density } };
        this.shards.push(shard); this.byId.set(a.id, shard); dynamics.add(shard);
      } else if (command[0] === 'remove') {
        const shard = this.byId.get(command[1]); if (!shard) continue;
        dynamics.remove(shard.body); this.byId.delete(shard.id); this.shards.splice(this.shards.indexOf(shard), 1);
      } else if (command[0] === 'place') {
        const shard = this.byId.get(command[1]); if (!shard) continue;
        shard.body.position = [...command[2]]; shard.body.velocity = [...command[3]];
        shard.body.sleeping = false; dynamics.relocate(shard.body);
      } else {
        const shard = this.byId.get(command[1]); if (!shard) continue;
        const b = shard.body; b.velocity = [command[2][0], command[2][1], command[2][2]]; b.sleeping = false; b.bounces = 0; dynamics.kick(b);
      }
    }
    for (const [id, sample, at] of frame.water) {
      const shard = this.byId.get(id); if (!shard) continue;
      shard.sample = sample ?? undefined; shard.sampledAt = at ?? undefined;
    }
    for (const t of frame.terrain ?? []) this.terrain(t);
    for (const s of frame.supports) if (s.shapes) this.shapes.set(s.id, s.shapes);
    for (const id of [...this.shapes.keys()]) if (!frame.supports.some(s => s.id === id)) this.shapes.delete(id);
    this.supports = frame.supports.map(s => ({ id: s.id, position: s.position, rotation: s.rotation, shapes: this.shapes.get(s.id)! }));
    const splashes: number[] = [], shatters = new Set<number>();
    // Idle, the terrain is cooked ahead of the next blast; with shards, the whole scene is mirrored every frame.
    if (!this.shards.length) dynamics.syncTerrain(this.query);
    else dynamics.syncScene(this.query, frame.tanks as unknown as TankState[]);
    // Initial collision pages arrive over several frames. Never drop shards into an empty world
    // while that first snapshot is still staged. Later edits keep the previous complete surface.
    for (let step = 0; this.version >= 0 && step < frame.substeps; step++) {
      for (const p of this.shards) this.wet(p, splashes);
      dynamics.step(this.shards);
      for (const p of this.shards) if (p.generation === 0 && p.body.age > 0.18 && p.body.radius > 0.25 && (p.body.impactSpeed ?? 0) > 10) shatters.add(p.id);
    }
    const state = new Float64Array(this.shards.length * DEBRIS_STRIDE);
    this.shards.forEach((s, i) => {
      const o = i * DEBRIS_STRIDE, b = s.body;
      state[o] = s.id; state.set(b.position, o + 1); state.set(b.velocity, o + 4); state.set(s.rotation, o + 7); state.set(s.angularVelocity, o + 11);
      state[o + 14] = b.sleeping ? 1 : 0; state[o + 15] = b.impactSpeed ?? -1; state[o + 16] = b.age;
    });
    return { frame: frame.frame, state, splashes: new Float64Array(splashes), shatters: [...shatters] };
  }
  /** Water assignment and splash detection before a step, exactly as TerrainDebris did on the main thread. */
  private wet(p: HostShard, splashes: number[]): void {
    const at = p.sampledAt, x = p.body.position;
    const water = p.water = at && Math.hypot(x[0] - at[0], x[1] - at[1], x[2] - at[2]) < 1 ? p.sample : undefined;
    if (!water || water.water < 0.01) { p.waterGap = undefined; return; }
    const gap = shardWaterSpan(p, this.span)[0] - water.surface;
    const v = p.body.velocity, flow = water.velocity, distance = Math.hypot(x[0], x[1], x[2]), inverse = 1 / distance, up = distance > 1e-10;
    const speed = -((v[0] - (flow ? flow[0] : 0)) * (up ? x[0] * inverse : 0) + (v[1] - (flow ? flow[1] : 0)) * (up ? x[1] * inverse : 1) + (v[2] - (flow ? flow[2] : 0)) * (up ? x[2] * inverse : 0));
    if (gap <= 0 && (p.waterGap === undefined || p.waterGap > 0) && speed > 0.7 && p.body.age - (p.lastSplash ?? -1) > 0.6) {
      splashes.push(...mul(normalize(x), water.surface), p.body.radius, speed); p.lastSplash = p.body.age;
    }
    p.waterGap = gap;
  }
  /** Pages of one terrain version arrive in parts; the world sees them only once the version is complete. */
  private terrain(t: DebrisTerrain): void {
    if (t.triangles) { this.soup = t.triangles; this.pages.clear(); this.staged = undefined; this.version = t.version; return; }
    const staged = this.staged ??= { set: new Map(), remove: new Set() };
    for (const [id, positions, indices] of t.set ?? []) { staged.set.set(id, [positions, indices]); staged.remove.delete(id); }
    for (const id of t.remove ?? []) { staged.remove.add(id); staged.set.delete(id); }
    if (!t.complete) return;
    this.soup = undefined;
    for (const id of staged.remove) this.pages.delete(id);
    for (const [id, [positions, indices]] of staged.set) this.pages.set(id, { mesh: { positions, indices } });
    this.staged = undefined; this.version = t.version;
  }
  dispose(): void { this.dynamics?.dispose(); this.dynamics = undefined; this.shards.length = 0; this.byId.clear(); }
}
