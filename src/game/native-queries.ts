/** Query snapshots retain immutable native chunks. JS arrays are still lent to
 * existing bulk geometry consumers; every hot BVH traversal stays in WASM. */
import { TerrainCollision, NEAREST, type CollisionChunk } from './terrain-collision';
import type { RustTerrainCore } from '../gpu/terrain/rust-core';
import type { TerrainQueryBounds, TerrainHit, V3 } from './contracts';
import { TriangleSoup } from './triangle-soup';
import { ResidentQueries, type ResidentQueryBody } from './resident-queries';
import { TERRAIN_BOUND } from './terrain-config';
interface Lease { core: RustTerrainCore; id: number; scene: boolean | 2 }
const leases = new WeakMap<object, Lease>();
const finalizer = new FinalizationRegistry<Lease>(v => v.core.releaseQuery(v.id, v.scene));
export function retainNativeQuery(object: object, core: RustTerrainCore, id: number, scene: boolean | 2 = false): void {
  const lease = { core, id, scene }; leases.set(object, lease); finalizer.register(object, lease, object);
}
export function nativeBallisticQuery(object: object): import('./native-ballistics').BallisticQuery | undefined {
  const v = leases.get(object);
  return v && v.scene ? { core: v.core, id: v.id, kind: v.scene === 2 ? 2 : 1, range: TERRAIN_BOUND * 4 } : undefined;
}
/** One ABI call per world query. Body poses, conservative rejection, transforms,
 * snapshot tie-breaking and overflow accounting are all resident in Rust. */
export class NativeResidentQueries extends ResidentQueries {
  private readonly nativeId: number;
  private readonly triangles = new TriangleSoup();
  constructor(private readonly core: RustTerrainCore, version: number, fixed: TerrainCollision, bodies: ReadonlyMap<number, ResidentQueryBody>, handles: ReadonlyMap<number, number>) {
    super(version, fixed, bodies, false);
    const scene = (object: object) => { const lease = leases.get(object); if (lease?.core !== core || lease.scene !== true) throw new Error('Missing native query scene'); return lease.id; };
    const words = [scene(fixed), TERRAIN_BOUND * 4];
    for (const [id, body] of bodies) { const handle = handles.get(id); if (handle === undefined) throw new Error('Missing native query body'); words.push(scene(body.collision), handle); }
    this.nativeId = core.queryWorld(words); retainNativeQuery(this, core, this.nativeId, 2);
  }
  override syncPoses(): boolean { return this.core.queryWorldSync(this.nativeId); }
  /** The composed query world a v19 solver leg syncs in the engine. */
  get worldId(): number { return this.nativeId; }
  private decode(d: Float64Array): TerrainHit | null { return d.length ? { distance: d[0], point: [d[1], d[2], d[3]], normal: [d[4], d[5], d[6]], material: d[7] } : null; }
  override raycast(origin: V3, direction: V3, maximum: number): TerrainHit | null { return this.decode(this.core.queryWorldRun(this.nativeId, 0, [...origin, ...direction, maximum])); }
  override blocked(origin: V3, direction: V3, maximum: number): boolean { return !!this.core.queryWorldRun(this.nativeId, 1, [...origin, ...direction, maximum])[0]; }
  override sweepSphere(origin: V3, direction: V3, maximum: number, radius: number): number | null { const d = this.core.queryWorldRun(this.nativeId, 2, [...origin, ...direction, maximum, radius]); return d.length ? d[0] : null; }
  override isSolid(point: V3): boolean { return !!this.core.queryWorldRun(this.nativeId, 4, point)[0]; }
  override surface(direction: V3): TerrainHit | null { return this.decode(this.core.queryWorldRun(this.nativeId, 5, direction)); }
  override collect(bounds: TerrainQueryBounds, maximum: number, out: TriangleSoup): boolean {
    const d = this.core.queryWorldRun(this.nativeId, 3, [...bounds.min, ...bounds.max, maximum]);
    for (let i = 1; i < d.length; i += 13) { const at = out.append(); out.data.set(d.subarray(i, i + 13), at); } return !!d[0];
  }
  override queryTriangles(bounds: TerrainQueryBounds, maximum = 512) { const overflow = this.collect(bounds, maximum, this.triangles.clear()); return { triangles: this.triangles.triangles(), overflow }; }
}
/** Rollback releases new snapshots deterministically. Published snapshots live as
 * long as their JS owners; disposing the engine releases the entire native store. */
export function releaseNativeQuery(object: object): void { const v = leases.get(object); if (v) { v.core.releaseQuery(v.id, v.scene); finalizer.unregister(object); leases.delete(object); } }
export class NativeTerrainCollision extends TerrainCollision {
  private readonly nativeId: number;
  constructor(private readonly core: RustTerrainCore, version: number, chunks: ReadonlyMap<string, CollisionChunk>) {
    super(version, chunks, false);
    const ids = [...chunks.values()].map(chunk => { const v = leases.get(chunk); if (v?.core !== core) throw new Error('Missing resident query chunk'); return v.id; });
    this.nativeId = core.queryScene(ids); retainNativeQuery(this, core, this.nativeId, true);
  }
  override nearest(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maximum: number): boolean {
    const d = this.core.queryRun(this.nativeId, 0, [ox, oy, oz, dx, dy, dz, maximum]); if (!d.length) return false;
    NEAREST.distance = d[0]; NEAREST.px = d[1]; NEAREST.py = d[2]; NEAREST.pz = d[3]; NEAREST.nx = d[4]; NEAREST.ny = d[5]; NEAREST.nz = d[6]; NEAREST.material = d[7]; return true;
  }
  override any(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maximum: number): boolean { return this.core.queryRun(this.nativeId, 1, [ox, oy, oz, dx, dy, dz, maximum])[0] !== 0; }
  override sweep(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maximum: number, radius: number): number | null {
    const d = this.core.queryRun(this.nativeId, 2, [ox, oy, oz, dx, dy, dz, maximum, radius]); return d.length ? d[0] : null;
  }
  override collect(bounds: TerrainQueryBounds, maximum: number, out: TriangleSoup): boolean {
    const d = this.core.queryRun(this.nativeId, 3, [...bounds.min, ...bounds.max, maximum]);
    for (let i = 1; i < d.length; i += 13) { const at = out.append(); out.data.set(d.subarray(i, i + 13), at); } return !!d[0];
  }
}
