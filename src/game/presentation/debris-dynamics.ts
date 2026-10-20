/** Cosmetic rigid-body world. Actual convex shard vertices, mirrored kinematic
 * tanks/structures and committed terrain; never alters authoritative gameplay. */
import * as RAPIER from '@dimforge/rapier3d-compat';
import type { Loadout, Q4, TankState, V3, WorldQuery } from '../contracts';
import { tankHullBoxes } from '../tank-collision';
import { buoyDebris, type DebrisBody, type DebrisWater } from './debris-physics';
import { vehicleCollisionParts } from '../vehicle/wreck-geometry';
import { vehicleFailureMask } from '../rules/vehicle-damage';
import { decomposeTransform } from '../math';

const v = (p: V3) => ({ x: p[0], y: p[1], z: p[2] });
const q = (p: Q4) => ({ x: p[0], y: p[1], z: p[2], w: p[3] });
export interface RigidShard { body: DebrisBody; positions: Float32Array; rotation: Q4; angularVelocity: V3; water?: DebrisWater }
/** Oriented geometric support span, also used for splash contact and buoyancy. */
export function shardWaterSpan(s: RigidShard, out: [number, number] = [0, 0]): [number, number] {
  const p = s.body.position, radius = Math.hypot(p[0], p[1], p[2]), inverse = 1 / radius, up = radius > 1e-10;
  const ux = up ? p[0] * inverse : 0, uy = up ? p[1] * inverse : 1, uz = up ? p[2] * inverse : 0;
  const r = s.rotation, qx = r[0], qy = r[1], qz = r[2], qw = r[3], positions = s.positions;
  let low = Infinity, high = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    // The vertex rotated exactly as math.ts rotate() (three's applyQuaternion) does it.
    const vx = positions[i], vy = positions[i + 1], vz = positions[i + 2];
    const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
    const height = radius + ((vx + qw * tx + qy * tz - qz * ty) * ux + (vy + qw * ty + qz * tx - qx * tz) * uy + (vz + qw * tz + qx * ty - qy * tx) * uz);
    low = Math.min(low, height); high = Math.max(high, height);
  }
  out[0] = low; out[1] = high;
  return out;
}
/** Hull-height share of a shard below the sampled water surface. */
const submerged = (water: DebrisWater, span: [number, number]) => Math.max(0, Math.min(1, (water.surface - span[0]) / Math.max(1e-5, span[1] - span[0])));
/** Same value bits as the last write (a sign change of zero counts as a change). */
const same = (target: number[], i: number, value: number) => Object.is(target[i], value);
interface Shard {
  readonly rb: RAPIER.RigidBody;
  /** State arrays owned here and lent to the shard; every step rewrites them in place. */
  readonly position: V3; readonly velocity: V3; readonly rotation: Q4; readonly spin: V3;
  /** Asleep with exactly the force and damping its next step would set again: only a wake needs work. */
  parked: boolean; damping: number;
  /** Velocity the step would reach without contacts (the impact-speed reference). */
  ex: number; ey: number; ez: number;
}
interface Tank { body: RAPIER.RigidBody; colliders: RAPIER.Collider[]; offsets: { x: number; y: number; z: number }[]; key: string;
  loadout: Loadout; tracks: string; barrel: string; armor: string; pose: (number | undefined)[]; target: number[]; seen: number; geometry?: string }
interface Support { body: RAPIER.RigidBody; shapes: unknown; target: number[]; seen: number }
export class DebrisDynamics {
  readonly world: RAPIER.World;
  private shards = new Map<DebrisBody, Shard>();
  private tanks = new Map<number, Tank>();
  private supports = new Map<number, Support>();
  private terrain?: RAPIER.Collider;
  private terrainVersion = -1;
  /** One trimesh per committed collision page, kept while the page keeps its mesh object. */
  private pages = new Map<string, { mesh: object; collider?: RAPIER.Collider }>();
  /** Measured cooking cost in ms per triangle: a budgeted sync stops before the page that would overrun it. */
  private cost = 0.001;
  private stamp = 0;
  private readonly vector = { x: 0, y: 0, z: 0 };
  private readonly quaternion = { x: 0, y: 0, z: 0, w: 1 };
  private readonly span: [number, number] = [0, 0];
  constructor(world?: RAPIER.World) {
    this.world = world ?? new RAPIER.World({ x: 0, y: 0, z: 0 });
    this.world.timestep = 1 / 60;
    this.world.integrationParameters.numSolverIterations = 8;
    this.world.integrationParameters.maxCcdSubsteps = 4;
  }
  add(s: RigidShard): void {
    const shape = RAPIER.ColliderDesc.convexHull(s.positions);
    if (!shape) throw new Error('Invalid convex debris geometry');
    const rb = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(...s.body.position).setRotation(q(s.rotation))
      .setLinvel(...s.body.velocity).setAngvel(v(s.angularVelocity)).setCcdEnabled(true).setLinearDamping(0.12).setAngularDamping(0.5));
    this.world.createCollider(shape.setDensity(s.body.density ?? 2.5).setFriction(0.8).setRestitution(0.25), rb);
    this.shards.set(s.body, { rb, position: [NaN, NaN, NaN], velocity: [0, 0, 0], rotation: [NaN, NaN, NaN, NaN], spin: [0, 0, 0], parked: false, damping: NaN, ex: 0, ey: 0, ez: 0 });
  }
  remove(b: DebrisBody): void { const e = this.shards.get(b); if (e) this.world.removeRigidBody(e.rb); this.shards.delete(b); }
  kick(b: DebrisBody): void { const e = this.shards.get(b); if (e) { e.parked = false; e.rb.setLinvel(v(b.velocity), true); } }
  relocate(b: DebrisBody): void {
    const e = this.shards.get(b); if (!e) return;
    e.parked = false; e.rb.setTranslation(v(b.position), true); e.rb.setLinvel(v(b.velocity), true);
  }
  /** Match the committed terrain. With collision pages, only pages whose mesh changed are cooked, one trimesh each as
   * in the gameplay solver; a budget (ms) spreads that over calls. True once the colliders match the terrain. */
  syncTerrain(query: WorldQuery, budgetMs = Infinity): boolean {
    const fixed = query.footprintSurface ?? query;
    if (fixed.version === this.terrainVersion) return true;
    const pages = fixed.fixedChunks?.();
    if (!pages) {
      if (!fixed.visibilityTriangles) return false;
      const positions: number[] = [];
      for (const t of fixed.visibilityTriangles()) positions.push(...t.a, ...t.b, ...t.c);
      if (this.terrain) this.world.removeCollider(this.terrain, true);
      this.terrain = positions.length ? this.world.createCollider(RAPIER.ColliderDesc.trimesh(new Float32Array(positions),
        Uint32Array.from({ length: positions.length / 3 }, (_, i) => i), RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES).setFriction(0.85).setRestitution(0.18)) : undefined;
      this.terrainVersion = fixed.version;
      return true;
    }
    // Removing a page wakes the shards whose broad phase touched it; shards resting on unchanged pages stay asleep.
    for (const [id, page] of this.pages) if (!pages.has(id)) { if (page.collider) this.world.removeCollider(page.collider, true); this.pages.delete(id); }
    const deadline = performance.now() + budgetMs;
    let cooked = false;
    for (const [id, { mesh }] of pages) {
      const page = this.pages.get(id);
      if (page?.mesh === mesh) continue;
      const triangles = mesh.indices.length / 3, start = performance.now();
      // Every call cooks at least one page, however small its budget.
      if (cooked && start + triangles * this.cost > deadline) return false;
      if (page?.collider) this.world.removeCollider(page.collider, true);
      this.pages.set(id, { mesh, collider: this.cook(mesh) });
      if (triangles >= 256) this.cost += ((performance.now() - start) / triangles - this.cost) / 4;
      cooked = true;
    }
    this.terrainVersion = fixed.version;
    return true;
  }
  /** The page's triangles straight from its typed arrays, minus the zero-area ones the whole-surface walk skipped. */
  private cook(mesh: { positions: Float32Array; indices: Uint32Array }): RAPIER.Collider | undefined {
    const p = mesh.positions, index = mesh.indices;
    let indices = index, count = 0;
    for (let f = 0; f < index.length; f += 3) {
      const a = index[f] * 3, b = index[f + 1] * 3, c = index[f + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2], wx = p[c] - p[a], wy = p[c + 1] - p[a + 1], wz = p[c + 2] - p[a + 2];
      if (!(Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) > 1e-12)) { if (indices === index) { indices = new Uint32Array(index.length); indices.set(index.subarray(0, f)); } continue; }
      if (indices !== index) { indices[count] = index[f]; indices[count + 1] = index[f + 1]; indices[count + 2] = index[f + 2]; }
      count += 3;
    }
    if (indices !== index) indices = indices.subarray(0, count);
    return count ? this.world.createCollider(RAPIER.ColliderDesc.trimesh(p, indices, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES).setFriction(0.85).setRestitution(0.18)) : undefined;
  }
  syncScene(query: WorldQuery, tanks: readonly TankState[]): void {
    this.syncTerrain(query);
    const stamp = ++this.stamp;
    for (const t of tanks) {
      if (t.retired) continue;
      let entry = this.tanks.get(t.id);
      const loadout = t.loadout;
      const mask = t.health <= 0 ? 15 : vehicleFailureMask(t);
      const geometry = t.visualKind || t.health <= 0 || mask || t.kit ? JSON.stringify([t.kit ?? loadout, t.visualKind, mask, t.generation,
        t.components?.map(c => [c.id, c.health <= 0])]) : undefined;
      if (entry && entry.geometry !== geometry) { this.world.removeRigidBody(entry.body); this.tanks.delete(t.id); entry = undefined; }
      if (geometry) {
        const posed = !!entry && entry.pose[0] === t.turretYaw && entry.pose[1] === t.barrelPitch &&
          Array.from({ length: 8 }, (_, i) => t.wheelSuspension?.[i]).every((v, i) => v === entry!.pose[i + 2]);
        const parts = posed ? undefined : vehicleCollisionParts(t);
        if (!entry) {
          const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(...t.position).setRotation(q(t.rotation)));
          const colliders = parts!.map(part => this.world.createCollider(
            RAPIER.ColliderDesc.convexHull(part.positions)!.setFriction(.8).setRestitution(.05), body));
          entry = { body, colliders, offsets: [], key: '', loadout, tracks: loadout.tracks, barrel: loadout.barrel, armor: loadout.armor,
            pose: [], target: [], seen: stamp, geometry };
          this.tanks.set(t.id, entry);
        }
        if (parts) {
          parts.forEach((part, i) => {
            const pose = decomposeTransform(part.transform);
            entry!.colliders[i].setTranslationWrtParent(v(pose.position)); entry!.colliders[i].setRotationWrtParent(q(pose.rotation));
          });
          entry.pose = [t.turretYaw, t.barrelPitch, ...Array.from({ length: 8 }, (_, i) => t.wheelSuspension?.[i])];
        }
        entry.seen = stamp; this.follow(entry, t.position, t.rotation);
        continue;
      }
      if (entry && (entry.loadout !== loadout || entry.tracks !== loadout.tracks || entry.barrel !== loadout.barrel || entry.armor !== loadout.armor)) {
        if (entry.key !== JSON.stringify(loadout)) { this.world.removeRigidBody(entry.body); this.tanks.delete(t.id); entry = undefined; }
        else Object.assign(entry, { loadout, tracks: loadout.tracks, barrel: loadout.barrel, armor: loadout.armor });
      }
      // The hull boxes depend on the loadout, turret, barrel and suspension alone.
      const pose = entry?.pose, suspension = t.suspension;
      let posed = !!pose && pose[0] === t.turretYaw && pose[1] === t.barrelPitch;
      for (let i = 0; posed && i < 8; i++) posed = pose![i + 2] === suspension?.[i];
      const shapes = posed ? undefined : tankHullBoxes(loadout, { turretYaw: t.turretYaw, barrelPitch: t.barrelPitch, wheelSuspension: suspension });
      if (!entry) {
        const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(...t.position).setRotation(q(t.rotation)));
        entry = { body, key: JSON.stringify(loadout), loadout, tracks: loadout.tracks, barrel: loadout.barrel, armor: loadout.armor, offsets: [], pose: [], target: [], seen: 0,
          colliders: shapes!.map(s => this.world.createCollider(RAPIER.ColliderDesc.cuboid(...s.half).setTranslation(...s.center)
            .setRotation(q(s.rotation ?? [0, 0, 0, 1])).setFriction(0.7).setRestitution(0.3), body)) };
        this.tanks.set(t.id, entry);
      }
      entry.seen = stamp;
      if (shapes) {
        shapes.forEach((s, i) => { const offset = v(s.center); entry!.offsets[i] = offset; entry!.colliders[i].setTranslationWrtParent(offset); entry!.colliders[i].setRotationWrtParent(q(s.rotation ?? [0, 0, 0, 1])); });
        entry.pose = [t.turretYaw, t.barrelPitch, ...Array.from({ length: 8 }, (_, i) => suspension?.[i])];
      }
      // Rewriting an unchanged local pose still marks the collider changed, which wakes every shard whose broad phase
      // touches it: debris lying against a tank never sleeps. One same-value write per collider keeps exactly that.
      else for (let i = 0; i < entry.colliders.length; i++) entry.colliders[i].setTranslationWrtParent(entry.offsets[i]);
      this.follow(entry, t.position, t.rotation);
    }
    for (const [id, t] of this.tanks) if (t.seen !== stamp) { this.world.removeRigidBody(t.body); this.tanks.delete(id); }
    for (const s of query.collisionBodies?.() ?? []) {
      let entry = this.supports.get(s.id);
      if (entry && entry.shapes !== s.shapes) { this.world.removeRigidBody(entry.body); this.supports.delete(s.id); entry = undefined; }
      if (!entry) {
        const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(...s.position).setRotation(q(s.rotation)));
        for (const c of s.shapes) {
          const shape = RAPIER.ColliderDesc.convexHull(c.vertices);
          if (shape) this.world.createCollider(shape.setTranslation(...(c.offset ?? [0, 0, 0])).setFriction(0.8).setRestitution(0.2), body);
        }
        entry = { body, shapes: s.shapes, target: [], seen: 0 }; this.supports.set(s.id, entry);
      }
      entry.seen = stamp;
      this.follow(entry, s.position, s.rotation);
    }
    for (const [id, s] of this.supports) if (s.seen !== stamp) { this.world.removeRigidBody(s.body); this.supports.delete(id); }
  }
  /** The shard still holds the state arrays of its last read-back, so they hold what Rapier holds. */
  private lent(s: RigidShard, e: Shard): boolean {
    return s.body.position === e.position && s.body.velocity === e.velocity && s.rotation === e.rotation && s.angularVelocity === e.spin;
  }
  /** Kinematic target, written only when it differs from the last one: a repeated target is already the body's pose. */
  private follow(entry: { body: RAPIER.RigidBody; target: number[] }, p: V3, r: Q4): void {
    const k = entry.target;
    if (same(k, 0, p[0]) && same(k, 1, p[1]) && same(k, 2, p[2]) && same(k, 3, r[0]) && same(k, 4, r[1]) && same(k, 5, r[2]) && same(k, 6, r[3])) return;
    k[0] = p[0]; k[1] = p[1]; k[2] = p[2]; k[3] = r[0]; k[4] = r[1]; k[5] = r[2]; k[6] = r[3];
    entry.body.setNextKinematicTranslation(v(p)); entry.body.setNextKinematicRotation(q(r));
  }
  step(shards: readonly RigidShard[]): void {
    for (const s of shards) {
      const e = this.shards.get(s.body); if (!e) continue;
      const b = s.body; b.age += 1 / 60; b.impactSpeed = 0;
      const water = s.water, wet = !!water && water.water > 0.005 && water.surface > 0, density = b.density ?? 2.5;
      if (e.parked) {
        // Asleep and untouched since the step that parked it: the same force stands, so only buoyancy (which may wake
        // a light shard) and the water's angular damping can differ.
        if (b.sleeping && this.lent(s, e) && !(wet && density < 1 && submerged(water!, shardWaterSpan(s, this.span)))) {
          const damping = water && water.surface > Math.hypot(b.position[0], b.position[1], b.position[2]) ? 2 : 0.5;
          if (damping !== e.damping) { e.rb.setAngularDamping(damping); e.damping = damping; }
          continue;
        }
        e.parked = false;
      }
      const rb = e.rb;
      rb.resetForces(false);
      const before = b.velocity, bx = before[0], by = before[1], bz = before[2];
      if (before !== e.velocity) { e.velocity[0] = bx; e.velocity[1] = by; e.velocity[2] = bz; b.velocity = e.velocity; }
      const wasSleeping = b.sleeping;
      // Approximate submerged volume over the actual oriented hull height;
      // thin shards float at their physical draft, not their bounding radius.
      if (wet && (density < 1 || !b.sleeping)) buoyDebris(b, water!, 1 / 60, submerged(water!, shardWaterSpan(s, this.span)));
      const p = b.position, distance = Math.hypot(p[0], p[1], p[2]), inverse = 1 / distance, up = distance > 1e-10, w = b.velocity;
      const ax = (up ? p[0] * inverse : 0) * -9.8 + (w[0] - bx) * 60, ay = (up ? p[1] * inverse : 1) * -9.8 + (w[1] - by) * 60, az = (up ? p[2] * inverse : 0) * -9.8 + (w[2] - bz) * 60;
      e.ex = bx + ax * (1 / 60); e.ey = by + ay * (1 / 60); e.ez = bz + az * (1 / 60);
      if (wasSleeping && !b.sleeping) rb.wakeUp();
      const mass = rb.mass(), force = this.vector;
      force.x = ax * mass; force.y = ay * mass; force.z = az * mass;
      rb.addForce(force, false);
      e.damping = water && water.surface > distance ? 2 : 0.5;
      rb.setAngularDamping(e.damping);
      e.parked = b.sleeping && this.lent(s, e);
    }
    this.world.step();
    const t = this.vector, r = this.quaternion;
    for (const s of shards) {
      const e = this.shards.get(s.body); if (!e) continue;
      const rb = e.rb, b = s.body, position = e.position, rotation = e.rotation, velocity = e.velocity;
      if (e.parked) {
        // A sleeper can be woken and put back to sleep within one step (CCD substeps): only an unmoved one is skipped.
        if (rb.isSleeping()) {
          rb.translation(t); rb.rotation(r);
          if (Object.is(t.x, position[0]) && Object.is(t.y, position[1]) && Object.is(t.z, position[2])
            && Object.is(r.x, rotation[0]) && Object.is(r.y, rotation[1]) && Object.is(r.z, rotation[2]) && Object.is(r.w, rotation[3])) {
            b.impactSpeed = Math.hypot(velocity[0] - e.ex, velocity[1] - e.ey, velocity[2] - e.ez);
            continue;
          }
        }
        e.parked = false;
      }
      rb.translation(t); position[0] = t.x; position[1] = t.y; position[2] = t.z; b.position = position;
      rb.linvel(t); velocity[0] = t.x; velocity[1] = t.y; velocity[2] = t.z; b.velocity = velocity;
      b.sleeping = rb.isSleeping();
      b.impactSpeed = Math.hypot(velocity[0] - e.ex, velocity[1] - e.ey, velocity[2] - e.ez);
      rb.rotation(r); rotation[0] = r.x; rotation[1] = r.y; rotation[2] = r.z; rotation[3] = r.w; s.rotation = rotation;
      rb.angvel(t); e.spin[0] = t.x; e.spin[1] = t.y; e.spin[2] = t.z; s.angularVelocity = e.spin;
    }
  }
  dispose(): void { this.world.free(); }
}
