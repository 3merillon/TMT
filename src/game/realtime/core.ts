/** Rust tactical kernel. One isolated WASM instance per match; no browser-only dependency in the simulation. */
import type { BrainOrder, BrainView, RealtimeBrainId } from './brains';
import type { DriveInput, TankState, V3 } from '../contracts';
import { rotate, wrapAngle } from '../math';
import { componentPoint } from './components';
const ROLES: readonly RealtimeBrainId[] = ['dummy', 'patrol', 'rustling', 'rusty', 'tosser', 'ally', 'hornet', 'bulwark', 'vex'];
let compiled: WebAssembly.Module | undefined;
export function installRealtimeCore(bytes: BufferSource): void { compiled = new WebAssembly.Module(bytes); }
export async function loadRealtimeCore(): Promise<void> {
  if (compiled) return;
  const response = await fetch(new URL('./realtime-core.wasm', import.meta.url));
  if (!response.ok) throw new Error(`Realtime engine could not load (${response.status})`);
  installRealtimeCore(await response.arrayBuffer());
}
interface CoreExports extends WebAssembly.Exports { memory: WebAssembly.Memory; rt_abi(): number; rt_buffer(): number; rt_decide(): void; rt_steer(): void; rt_move(): void; rt_hit_spheres(): void; rt_damage_components(): void; rt_searchlight(): void; rt_shield(): void; rt_area(): void }
export class RealtimeCore {
  private readonly exports: CoreExports;
  private readonly w: Float64Array;
  private readonly contacts = new Map<number, { id: number; since: number; waypoint: number }>();
  constructor() {
    if (!compiled) throw new Error('Load the Rust realtime engine before creating a match');
    this.exports = new WebAssembly.Instance(compiled).exports as CoreExports;
    if (this.exports.rt_abi() !== 4) throw new Error('Unsupported realtime engine ABI');
    this.w = new Float64Array(this.exports.memory.buffer, this.exports.rt_buffer(), 2048);
  }
  forget(id: number): void { this.contacts.delete(id); }
  shieldBlocks(shield: NonNullable<TankState['shield']>, incoming: V3): boolean {
    this.w.set([...shield.direction, shield.cosine, ...incoming]);
    this.exports.rt_shield(); return !!this.w[16];
  }
  area(center: V3, radius: number, tanks: readonly TankState[]): number[] {
    const live = tanks.filter(t => t.health > 0 && !t.retired);
    const hits: number[] = [];
    // The native ABI accepts 128 actors per call. Batching also makes this helper safe for larger query lists.
    for (let offset = 0; offset < live.length; offset += 128) {
      const count = Math.min(128, live.length - offset);
      this.w.set([...center, radius, count]);
      for (let i = 0; i < count; i++) { const t = live[offset + i]; this.w.set([t.id, ...t.position], 32 + i * 4); }
      this.exports.rt_area();
      for (let i = 0; i < this.w[1024]; i++) hits.push(this.w[1025 + i]);
    }
    return hits;
  }
  exposure(origin: V3, direction: V3, target: V3, range: number, angle: number, headlights: boolean): number {
    this.w.set([...origin, ...direction, ...target, range, Math.cos(angle), +headlights]);
    this.exports.rt_searchlight(); return this.w[16];
  }
  snapshot(): [number, { id: number; since: number; waypoint: number }][] { return structuredClone([...this.contacts]); }
  restore(data: ReturnType<RealtimeCore['snapshot']>): void { this.contacts.clear(); for (const [id, value] of data) this.contacts.set(id, { ...value }); }
  move(t: TankState, forward: V3, speed: number, radius: number, gravity: number, neighbors: readonly TankState[]): V3 {
    const nearby = neighbors.filter(n => n.id !== t.id && !n.retired && n.health > 0).slice(0, 128);
    this.w.set([...t.position, ...t.velocity, ...forward, speed, 1 / 60, +(t.motionKind === 'air'), radius, gravity, nearby.length]);
    nearby.forEach((n, i) => this.w.set(n.position, 32 + i * 3)); this.exports.rt_move();
    return [this.w[448], this.w[449], this.w[450]];
  }
  /** Bounded batches keep hit testing in Rust even with many component-bearing actors. */
  sweep(from: V3, direction: V3, extent: number, tanks: readonly TankState[], ignore: number | null): { tank: number; component: number; distance: number } | null {
    let count = 0, nearest = extent, result: { tank: number; component: number; distance: number } | null = null;
    const flush = () => {
      if (!count) return;
      this.w.set([...from, ...direction, nearest, count]); this.exports.rt_hit_spheres();
      if (this.w[1800] >= 0) { nearest = this.w[1802]; result = { tank: this.w[1800], component: this.w[1801], distance: nearest }; }
      count = 0;
    };
    const sphere = (tank: number, component: number, center: V3, radius: number) => {
      this.w.set([tank, component, ...center, radius], 32 + count++ * 6);
      if (count === 256) flush();
    };
    for (const t of tanks) {
      if (t.retired || t.id === ignore) continue;
      sphere(t.id, -1, t.position, .7);
      t.components?.forEach((c, index) => { if (c.health > 0) sphere(t.id, index, componentPoint(t, c), c.radius); });
    }
    flush(); return result;
  }
  damageComponents(tank: TankState, impact: V3, damage: number, radius: number, direct: number): number {
    const components = tank.components!;
    this.w.set([components.length, ...impact, damage, radius, direct]);
    components.forEach((c, i) => this.w.set([...componentPoint(tank, c), c.radius, c.health, c.stage], 32 + i * 6));
    this.exports.rt_damage_components();
    components.forEach((c, i) => { c.health = this.w[32 + i * 6 + 4]; });
    return this.w[1800];
  }
  decide(id: RealtimeBrainId, v: BrainView): BrainOrder {
    const state = this.contacts.get(v.self.id) ?? { id: -1, since: v.tick, waypoint: 0 };
    this.contacts.set(v.self.id, state);
    if (id === 'patrol') {
      if (!v.waypoints.length) return { goal: null };
      const target = v.waypoints[state.waypoint % v.waypoints.length];
      if (Math.hypot(...target.map((n, i) => n - v.self.position[i])) < 1.6) state.waypoint++;
      return { goal: v.waypoints[state.waypoint % v.waypoints.length] };
    }
    const w = this.w; w.fill(0, 0, 1536);
    w.set([ROLES.indexOf(id), v.tick, v.tuning.reactionTicks, +v.reloadReady, ...v.self.position,
      v.self.health / (v.self.maxHealth ?? 1), +!!v.leader, ...(v.leader?.position ?? [0, 0, 0]),
      state.id, state.since, Math.min(128, v.enemies.length), v.self.id % 2 ? -1 : 1, 1 - v.tuning.yawSpread * 5]);
    v.enemies.slice(0, 128).forEach((e, i) => w.set([e.id, ...e.position, ...(e.velocity ?? [0, 0, 0]), +e.visible, e.age], 32 + i * 9));
    this.exports.rt_decide();
    state.id = w[1547]; state.since = w[1548];
    const vec = (i: number): V3 => [w[i], w[i + 1], w[i + 2]];
    const order: BrainOrder = { goal: w[1536] ? vec(1537) : null, reverse: !!w[1540], face: w[1541] ? vec(1542) : null };
    if (!order.goal && !order.face && v.waypoints.length && id !== 'dummy') order.goal = v.waypoints[0];
    if (w[1545] && order.face) {
      const aim = v.solve(order.face, !!w[1546]);
      if (aim) { order.aim = { ...aim, yaw: wrapAngle(aim.yaw + (v.random() * 2 - 1) * v.tuning.yawSpread),
        power: Math.max(0, Math.min(1, aim.power + (v.random() * 2 - 1) * v.tuning.powerSpread)) }; order.fire = true; }
    }
    return order;
  }
  steer(t: TankState, goal: V3 | null, reverse = false): DriveInput {
    if (!goal) return { throttle: 0, steer: 0 };
    this.w.set([...t.position, ...rotate([0, 0, 1], t.rotation), ...rotate([1, 0, 0], t.rotation), ...goal, +reverse]);
    this.exports.rt_steer();
    return { throttle: this.w[16], steer: this.w[17] };
  }
}
