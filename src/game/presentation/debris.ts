/** Cosmetic fragments cut from the actual pre-impact triangle surface. */
import { removesMaterial, type CutShell } from '../../gpu/terrain/contracts';
import type { InstanceHandle, MeshDesc, MeshHandle, SceneRegistry } from '../../engine';
import { MATERIAL_CLASS } from '../../engine/contracts';
import { packPartAttrs } from '../../engine/materials/part-basic.wgsl';
import type { ImpactEvent, V3, Q4, TankState, WorldQuery } from '../contracts';
import { add, sub, mul, normalize, dot, cross, length, composeTransform, rotate, transformDirection, transformPoint } from '../math';
import type { DebrisBody } from './debris-physics';
import type { RigidShard } from './debris-dynamics';
import { DEBRIS_STRIDE, type DebrisCommand, type DebrisFrame, type DebrisSupport, type DebrisTerrain, type DebrisWaterEntry } from './debris-host';
import { LocalDebrisChannel, WorkerDebrisChannel, type DebrisChannel } from './debris-channel';
export type { DebrisBody } from './debris-physics';
import { craterProfile } from '../rules/crater';

export interface DebrisFragment { center: V3; textureOrigin?: V3; positions: Float32Array; normals: Float32Array; indices: Uint32Array; radius: number; material: number }

/** A wedge's faces over its surface triangle (corners 0-2) and that triangle pushed inward (corners 3-5). */
const WEDGE = [0, 1, 2, 5, 4, 3, 0, 3, 4, 0, 4, 1, 1, 4, 5, 1, 5, 2, 2, 5, 3, 2, 3, 0];
/** The closed wedge over six corners, relative to their mean, with outward faces. */
function wedge(v: Float64Array, material: number): DebrisFragment {
  const ox = (0 + v[0] + v[3] + v[6] + v[9] + v[12] + v[15]) * (1 / 6), oy = (0 + v[1] + v[4] + v[7] + v[10] + v[13] + v[16]) * (1 / 6), oz = (0 + v[2] + v[5] + v[8] + v[11] + v[14] + v[17]) * (1 / 6);
  const positions = new Float32Array(72), normals = new Float32Array(72), indices = new Uint32Array(24);
  for (let f = 0; f < 24; f += 3) {
    const p = WEDGE[f] * 3;
    let q = WEDGE[f + 1] * 3, r = WEDGE[f + 2] * 3;
    const ux = v[q] - v[p], uy = v[q + 1] - v[p + 1], uz = v[q + 2] - v[p + 2], wx = v[r] - v[p], wy = v[r + 1] - v[p + 1], wz = v[r + 2] - v[p + 2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const size = Math.hypot(nx, ny, nz);
    if (size > 1e-10) { const inverse = 1 / size; nx *= inverse; ny *= inverse; nz *= inverse; } else { nx = 0; ny = 1; nz = 0; }
    if (nx * ((v[p] + v[q] + v[r]) * (1 / 3) - ox) + ny * ((v[p + 1] + v[q + 1] + v[r + 1]) * (1 / 3) - oy) + nz * ((v[p + 2] + v[q + 2] + v[r + 2]) * (1 / 3) - oz) < 0) {
      const swap = q; q = r; r = swap; nx *= -1; ny *= -1; nz *= -1;
    }
    for (let corner = 0; corner < 3; corner++) {
      const k = corner === 0 ? p : corner === 1 ? q : r, o = (f + corner) * 3;
      positions[o] = v[k] - ox; positions[o + 1] = v[k + 1] - oy; positions[o + 2] = v[k + 2] - oz;
      normals[o] = nx; normals[o + 1] = ny; normals[o + 2] = nz; indices[f + corner] = f + corner;
    }
  }
  let reach = -Infinity;
  for (let k = 0; k < 18; k += 3) reach = Math.max(reach, Math.hypot(v[k] - ox, v[k + 1] - oy, v[k + 2] - oz));
  const origin: V3 = [ox, oy, oz];
  return { center: origin, textureOrigin: origin, positions, normals, indices, radius: reach * 0.6, material };
}
/** Subdivide real surface triangles into closed wedges wholly inside the removed sphere. With material crater shells
 * (rust-engine-v22) each triangle is tested against its own material's shell, and materials no shell removes give none. */
export function cutDebris(world: WorldQuery, center: V3, radius: number, limit = 48, shells?: readonly CutShell[]): DebrisFragment[] {
  if (!center.every(Number.isFinite) || !Number.isFinite(radius) || radius <= 0 || limit <= 0) return [];
  const bounds = { min: center.map(v => v - radius) as V3, max: center.map(v => v + radius) as V3 };
  // WorldQuery deliberately caps bounded queries at 2048 triangles. Overflow is
  // fine here: fragments are a bounded visual sample of the authoritative cut.
  const query = world.queryTriangles?.(bounds, 2048); if (!query) return [];
  const pieces: DebrisFragment[] = [], triangles = query.triangles, v = new Float64Array(18);
  let sx = center[0], sy = center[1], sz = center[2], r = radius;
  let nx = 0, ny = 0, nz = 0, material = 0;
  // Corners as scalars: the arithmetic of the vector helpers, without their arrays.
  const subdivide = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, depth: number): void => {
    if (pieces.length >= limit) return;
    const edge = Math.max(Math.hypot(ax - bx, ay - by, az - bz), Math.hypot(bx - cx, by - cy, bz - cz), Math.hypot(cx - ax, cy - ay, cz - az));
    if (Math.hypot((ax + bx + cx) * (1 / 3) - sx, (ay + by + cy) * (1 / 3) - sy, (az + bz + cz) * (1 / 3) - sz) - edge > r) return;
    if (edge > Math.max(0.5, r * 0.42) && depth < 6) {
      const abx = (ax + bx) * 0.5, aby = (ay + by) * 0.5, abz = (az + bz) * 0.5, bcx = (bx + cx) * 0.5, bcy = (by + cy) * 0.5, bcz = (bz + cz) * 0.5;
      const cax = (cx + ax) * 0.5, cay = (cy + ay) * 0.5, caz = (cz + az) * 0.5;
      subdivide(ax, ay, az, abx, aby, abz, cax, cay, caz, depth + 1); subdivide(abx, aby, abz, bx, by, bz, bcx, bcy, bcz, depth + 1);
      subdivide(cax, cay, caz, bcx, bcy, bcz, cx, cy, cz, depth + 1); subdivide(abx, aby, abz, bcx, bcy, bcz, cax, cay, caz, depth + 1);
      return;
    }
    const rim = r * 0.97;
    if (Math.hypot(ax - sx, ay - sy, az - sz) >= rim || Math.hypot(bx - sx, by - sy, bz - sz) >= rim || Math.hypot(cx - sx, cy - sy, cz - sz) >= rim) return;
    const thickness = Math.min(0.4, edge * 0.45, r * 0.18);
    v[0] = ax; v[1] = ay; v[2] = az; v[3] = bx; v[4] = by; v[5] = bz; v[6] = cx; v[7] = cy; v[8] = cz;
    for (let k = 0; k < 9; k += 3) { v[k + 9] = v[k] - nx * thickness; v[k + 10] = v[k + 1] - ny * thickness; v[k + 11] = v[k + 2] - nz * thickness; }
    for (let k = 9; k < 18; k += 3) if (Math.hypot(v[k] - sx, v[k + 1] - sy, v[k + 2] - sz) > r || !world.isSolid([v[k], v[k + 1], v[k + 2]])) return;
    pieces.push(wedge(v, material));
  };
  // Closest first: the cap bounds presentation cost, not authoritative destruction.
  const keys = triangles.map(t => Math.hypot(t.a[0] - center[0], t.a[1] - center[1], t.a[2] - center[2]));
  for (const i of triangles.map((_, i) => i).sort((i, j) => keys[i] - keys[j])) {
    if (pieces.length >= limit) break;
    const { a, b, c, normal } = triangles[i];
    nx = normal[0]; ny = normal[1]; nz = normal[2]; material = triangles[i].material;
    if (shells) {
      const shell = shells.find(s => removesMaterial(s.materials, material)); if (!shell) continue;
      sx = shell.center[0]; sy = shell.center[1]; sz = shell.center[2]; r = shell.radius;
    }
    subdivide(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], 0);
  }
  return pieces;
}
/** Partition a closed convex shard into tetrahedra sharing its interior origin. */
export function splitDebris(fragment: DebrisFragment): DebrisFragment[] {
  const children: DebrisFragment[] = [];
  for (let i = 0; i < fragment.positions.length; i += 9) {
    const vertices: V3[] = [[0, 0, 0], ...[0, 3, 6].map(j => Array.from(fragment.positions.slice(i + j, i + j + 3)) as V3)];
    const center = mul(vertices.reduce((s, p) => add(s, p), [0, 0, 0] as V3), 0.25);
    const positions: number[] = [], normals: number[] = [];
    for (const face of [[1, 2, 3], [0, 2, 1], [0, 3, 2], [0, 1, 3]]) {
      let [a, b, c] = face.map(k => sub(vertices[k], center));
      let n = normalize(cross(sub(b, a), sub(c, a)));
      if (dot(n, a) < 0) { [b, c] = [c, b]; n = mul(n, -1); }
      positions.push(...a, ...b, ...c); normals.push(...n, ...n, ...n);
    }
    children.push({ center, textureOrigin: add(fragment.textureOrigin ?? fragment.center, center), positions: new Float32Array(positions), normals: new Float32Array(normals),
      indices: Uint32Array.from({ length: 12 }, (_, k) => k), radius: Math.max(...vertices.map(v => length(sub(v, center)))) * 0.6, material: fragment.material });
  }
  return children;
}
/** A piece is its own rigid shard: the debris world updates its pose in place. */
interface Piece extends RigidShard { id: number; mesh: MeshHandle; instance: InstanceHandle; fragment: DebrisFragment; tint: V3; generation: number;
  /** Position, rotation and fade last written to the instance. */
  drawn: number[] }
/** Bytes of terrain page copies posted to the debris world per frame while it catches up with a commit. */
const PAGE_BYTES_PER_FRAME = 2 << 20;
/** Frames the debris world may lag before the main thread stops posting and folds steps into the next frame. */
const MAX_PENDING = 2;
export class TerrainDebris {
  private readonly pieces: Piece[] = [];
  private readonly pending = new Map<string, { event: ImpactEvent; fragments: DebrisFragment[] }>();
  private accumulator = 0;
  private serial = 0;
  private waterClock = 0;
  private readingWater = false;
  private epoch = 0;
  /** The debris world (a worker when the world has a native engine) and what it has been told. */
  private channel?: DebrisChannel;
  private readonly byId = new Map<number, Piece>();
  private outbox: DebrisCommand[] = [];
  private water: DebrisWaterEntry[] = [];
  private substeps = 0;
  private frame = 0;
  private sentVersion = NaN;
  private readonly sentPages = new Map<string, object>();
  private sentSoup = false;
  private terrainParts: DebrisTerrain[] = [];
  private readonly sentShapes = new Map<number, unknown>();
  private readonly model = new Float64Array(16);
  private readonly matrix = new Float32Array(16);
  constructor(private readonly scene: SceneRegistry) {}
  /** A real vehicle part, baked at its last rendered pose, uses the same collision/rigid-body world as rock shards. */
  detach(desc: MeshDesc, transform: ArrayLike<number>, tint: V3, velocity: V3): void {
    if (!desc.positions.length) return;
    while (this.pieces.length >= 96) this.remove(this.pieces.shift()!);
    const positions = new Float32Array(desc.positions.length), normals = new Float32Array(desc.normals.length);
    const center: V3 = [0, 0, 0], count = positions.length / 3;
    for (let i = 0; i < positions.length; i += 3) {
      const vertex = transformPoint(transform, [desc.positions[i], desc.positions[i + 1], desc.positions[i + 2]]);
      positions.set(vertex, i); center[0] += vertex[0] / count; center[1] += vertex[1] / count; center[2] += vertex[2] / count;
      normals.set(transformDirection(transform, [desc.normals[i], desc.normals[i + 1], desc.normals[i + 2]]), i);
    }
    let radius = .03;
    for (let i = 0; i < positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) positions[i + axis] -= center[axis];
      radius = Math.max(radius, Math.hypot(positions[i], positions[i + 1], positions[i + 2]));
    }
    const fragment: DebrisFragment = { center, positions, normals, indices: desc.indices, radius, material: 3 };
    const mesh = this.scene.meshes.create({ ...desc, positions, normals, instances: undefined, label: 'vehicle:detached' });
    const body: DebrisBody = { position: center, velocity: [...velocity], radius, density: 7.5, age: 0, bounces: 0, sleeping: false };
    composeTransform(this.model, center, [0, 0, 0, 1], [1, 1, 1]); this.matrix.set(this.model);
    const instance = this.scene.instances.add(mesh, { model: this.matrix, tint, objectId: 421, castShadow: true });
    const serial = ++this.serial;
    const piece: Piece = { id: serial, body, mesh, instance, positions, rotation: [0, 0, 0, 1],
      angularVelocity: [Math.sin(serial) * 5, Math.cos(serial * 2) * 4, Math.sin(serial * 3) * 5], fragment, tint, generation: 1, drawn: [] };
    this.pieces.push(piece); this.add(piece);
  }
  impact(event: ImpactEvent, world: WorldQuery): void {
    this.open(world);
    for (const p of this.pieces) {
      const d = sub(p.body.position, event.position), reach = event.radius * 2;
      if (length(d) >= reach) continue;
      p.body.velocity = add(p.body.velocity, mul(normalize(add(d, event.normal)), (1 - length(d) / reach) * event.radius * 4));
      p.body.sleeping = false; p.body.bounces = 0;
      this.outbox.push(['kick', p.id, p.body.velocity]);
    }
    const cut = event.cut ?? craterProfile(event.position, event.normal, event.radius);
    try {
      this.pending.set(event.cut?.id ?? `visual-${++this.serial}`, { event, fragments: cutDebris(world, cut.center, cut.radius, 48, event.cut?.shells) });
    } catch (error) {
      // A failed cosmetic query must not interrupt impact dispatch or the carve.
      console.warn('Terrain debris unavailable for this impact:', error);
    }
  }
  commit(ids?: readonly string[]): void {
    for (const [id, pending] of this.pending) {
      if (ids && !ids.includes(id)) continue;
      this.pending.delete(id);
      const { event, fragments } = pending;
      let seed = ++this.serial * 7919;
      const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
      for (const fragment of fragments) {
        while (this.pieces.length >= 96) this.remove(this.pieces.shift()!);
        const direction = normalize(add(normalize(sub(fragment.center, event.position)), mul(event.normal, 1.8)));
        const body: DebrisBody = { position: [...fragment.center], velocity: mul(direction, 3 + event.radius * 2 + random() * 5),
          radius: Math.max(0.03, fragment.radius), age: 0, bounces: 0, sleeping: false };
        const mesh = this.createMesh(fragment);
        const kind = this.scene.get('planet')?.kind;
        const tint: V3 = fragment.material === 3 ? [0.35, 0.33, 0.29] : kind === 'dune' ? [0.38, 0.22, 0.12] : kind === 'glacial' ? [0.45, 0.56, 0.62] : kind === 'volcanic' ? [0.10, 0.08, 0.07] : [0.22, 0.25, 0.13];
        composeTransform(this.model, body.position, [0, 0, 0, 1], [1, 1, 1]);
        this.matrix.set(this.model);
        const instance = this.scene.instances.add(mesh, { model: this.matrix, tint, objectId: 420, classId: MATERIAL_CLASS.DEBRIS, castShadow: true });
        const angularVelocity: V3 = [random() * 8 - 4, random() * 8 - 4, random() * 8 - 4];
        body.density = fragment.material === 3 ? 2.5 : kind === 'glacial' ? 0.92 : kind === 'volcanic' ? 0.78 : 2.2;
        const piece: Piece = { id: ++this.serial, body, mesh, instance, positions: fragment.positions, rotation: [0, 0, 0, 1], angularVelocity, fragment, tint, generation: 0, drawn: [] };
        this.pieces.push(piece); this.add(piece);
      }
    }
  }
  update(world: WorldQuery, dt: number, tanks: readonly TankState[] = []): void {
    const channel = this.open(world);
    this.absorb(channel);
    this.syncTerrain(world);
    this.recoverEmbedded(world.footprintSurface ?? world);
    this.waterClock += dt;
    const fluids = this.scene.get('fluids');
    if (fluids && this.pieces.length && this.waterClock >= 0.15 && !this.readingWater) {
      this.waterClock = 0; this.readingWater = true;
      const epoch = this.epoch, pieces = [...this.pieces], positions = pieces.map(p => [...p.body.position] as V3);
      // The GPU probe caps each readback at 64 points. Never stall the render loop.
      const batches = Array.from({ length: Math.ceil(pieces.length / 64) }, (_, i) => fluids.probe(positions.slice(i * 64, i * 64 + 64)));
      void Promise.all(batches).then(results => {
        if (epoch !== this.epoch) return;
        results.flat().forEach((water, i) => this.water.push([pieces[i].id, water, positions[i]]));
      }).catch(() => {}).finally(() => { this.readingWater = false; });
    }
    // Fixed 60 Hz steps, at most four per frame; while the debris world lags they fold into the next frame it accepts.
    this.accumulator = Math.min(4 / 60, this.accumulator + Math.max(0, dt));
    while (this.accumulator >= 1 / 60) { this.accumulator -= 1 / 60; this.substeps = Math.min(4, this.substeps + 1); }
    if (this.pieces.length || this.outbox.length || this.terrainParts.length) this.post(world, tanks);
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i]; if (p.body.age > 14) { this.remove(p); this.pieces.splice(i, 1); continue; }
      // A resting piece keeps its instance as written: the same pose gives the same matrix.
      const x = p.body.position, r = p.rotation, d = p.drawn;
      if (p.body.age > 12 || !(Object.is(d[0], x[0]) && Object.is(d[1], x[1]) && Object.is(d[2], x[2]) && Object.is(d[3], r[0]) && Object.is(d[4], r[1]) && Object.is(d[5], r[2]) && Object.is(d[6], r[3]))) {
        d[0] = x[0]; d[1] = x[1]; d[2] = x[2]; d[3] = r[0]; d[4] = r[1]; d[5] = r[2]; d[6] = r[3];
        composeTransform(this.model, x, r, [1, 1, 1]);
        // Settle old fragments below the surface instead of dissolving opaque metal into screen-door pixels.
        const sink = Math.max(0, (p.body.age - 12) / 2) * (p.body.radius * 2 + .1), radius = Math.hypot(...x) || 1;
        for (let axis = 0; axis < 3; axis++) this.model[12 + axis] -= x[axis] / radius * sink;
        this.matrix.set(this.model);
        this.scene.instances.set(p.instance, this.matrix);
      }
    }
  }
  get active(): number { return this.pieces.length; }

  /** Detachment can start inside a crater wall, and a moving collider can push a tiny shard through a mesh.
   * CCD cannot escape an already embedded body. Return it to free space and let the solver settle it again. */
  private recoverEmbedded(world: WorldQuery): void {
    for (const piece of this.pieces) {
      const b = piece.body;
      if (!world.isSolid(b.position)) continue;
      const up = normalize(b.position), reach = b.radius * 2 + .5, outside = add(b.position, mul(up, reach));
      const hit = !world.isSolid(outside) ? world.raycast(outside, mul(up, -1), reach + .1) : world.surface(up);
      if (!hit) continue;
      b.position = add(hit.point, mul(hit.normal, b.radius + .02));
      b.velocity = sub(b.velocity, mul(hit.normal, Math.min(0, dot(b.velocity, hit.normal))));
      b.sleeping = false;
      this.outbox.push(['place', piece.id, [...b.position], [...b.velocity]]);
    }
  }
  private createMesh(fragment: DebrisFragment): MeshHandle {
    const kind = this.scene.get('planet')?.kind;
    const layer = fragment.material === 3 ? 2 : kind === 'volcanic' ? 5 : fragment.material === 2 ? 1 : kind === 'dune' ? 3 : kind === 'glacial' ? 4 : 0;
    const origin = fragment.textureOrigin ?? fragment.center;
    return this.scene.meshes.create({ ...fragment, matId: 8, label: 'terrain-shard',
      partLocal: fragment.positions.map((value, i) => value + origin[i % 3]),
      attrs: new Uint32Array(fragment.positions.length / 3).fill(packPartAttrs(0, 255, 8, layer)) });
  }
  private shatter(p: Piece): void {
    const children = splitDebris(p.fragment);
    if (this.pieces.length + children.length > 144) return;
    this.pieces.splice(this.pieces.indexOf(p), 1); this.remove(p);
    const r = p.rotation;
    for (const fragment of children) {
      const offset = rotate(fragment.center, r);
      const body: DebrisBody = { ...p.body, position: add(p.body.position, offset), radius: Math.max(0.025, fragment.radius),
        velocity: add(p.body.velocity, mul(normalize(offset), 1.2)), sleeping: false, bounces: 0 };
      const mesh = this.createMesh(fragment);
      composeTransform(this.model, body.position, r, [1, 1, 1]);
      this.matrix.set(this.model);
      const instance = this.scene.instances.add(mesh, { model: this.matrix, tint: p.tint, objectId: 420, classId: MATERIAL_CLASS.DEBRIS, castShadow: true });
      const piece: Piece = { ...p, id: ++this.serial, body, mesh, instance, fragment, positions: fragment.positions, rotation: [r[0], r[1], r[2], r[3]] as Q4, generation: 1, drawn: [] };
      this.pieces.push(piece); this.add(piece);
    }
  }
  cancel(): void { this.pending.clear(); }
  /** The debris world's channel, opened on first use: a worker with its own engine instance for a native world
   * (?debris=main keeps it in-process), else in-process. A failed worker hands its shards to an in-process world. */
  private open(world: WorldQuery): DebrisChannel {
    if (this.channel?.failure && this.channel.kind === 'worker') {
      this.channel.dispose(); this.channel = new LocalDebrisChannel(() => world.createPresentationPhysics?.());
      this.forget(); this.water = []; this.outbox = this.outbox.filter(c => c[0] !== 'add' && c[0] !== 'remove');
      for (const p of this.pieces) this.add(p);
    }
    if (this.channel) return this.channel;
    const inProcess = typeof Worker === 'undefined' || new URLSearchParams(globalThis.location?.search ?? '').get('debris') === 'main';
    const module = inProcess ? undefined : world.presentationEngine?.();
    return this.channel = module ? new WorkerDebrisChannel(module) : new LocalDebrisChannel(() => world.createPresentationPhysics?.());
  }
  /** Where the debris world runs (view telemetry). */
  get thread(): 'worker' | 'main' | 'none' { return this.channel?.kind ?? 'none'; }
  /** The debris world forgot everything sent to it (a new channel). */
  private forget(): void { this.sentVersion = NaN; this.sentPages.clear(); this.sentSoup = false; this.terrainParts = []; this.sentShapes.clear(); }
  private add(p: Piece): void {
    this.byId.set(p.id, p);
    this.outbox.push(['add', { id: p.id, positions: p.positions, position: [...p.body.position], velocity: [...p.body.velocity], rotation: [...p.rotation],
      angularVelocity: [...p.angularVelocity], radius: p.body.radius, density: p.body.density ?? 2.5, generation: p.generation }]);
  }
  /** Shard states, splashes and shatters the debris world published since the last frame, oldest first. */
  private absorb(channel: DebrisChannel): void {
    for (const result of channel.take()) {
      const state = result.state;
      for (let o = 0; o < state.length; o += DEBRIS_STRIDE) {
        const p = this.byId.get(state[o]); if (!p) continue;
        const b = p.body, x = b.position, v = b.velocity, r = p.rotation, w = p.angularVelocity;
        x[0] = state[o + 1]; x[1] = state[o + 2]; x[2] = state[o + 3]; v[0] = state[o + 4]; v[1] = state[o + 5]; v[2] = state[o + 6];
        r[0] = state[o + 7]; r[1] = state[o + 8]; r[2] = state[o + 9]; r[3] = state[o + 10]; w[0] = state[o + 11]; w[1] = state[o + 12]; w[2] = state[o + 13];
        b.sleeping = state[o + 14] === 1; b.impactSpeed = state[o + 15]; b.age = state[o + 16];
      }
      const fluids = this.scene.get('fluids'), s = result.splashes;
      for (let i = 0; i < s.length; i += 5) fluids?.splash([s[i], s[i + 1], s[i + 2]], s[i + 3], s[i + 4]);
      for (const id of result.shatters) {
        const p = this.byId.get(id);
        if (p && p.generation === 0 && this.pieces.length < 130) this.shatter(p);
      }
    }
  }
  /** Changed collision pages of the committed terrain, copied at most PAGE_BYTES_PER_FRAME per frame. */
  private syncTerrain(world: WorldQuery): void {
    const fixed = world.footprintSurface ?? world;
    if (fixed.version === this.sentVersion) return;
    const pages = fixed.fixedChunks?.();
    if (!pages) {
      // The whole-surface fallback is built only once there are shards, never ahead of the first blast.
      if (!fixed.visibilityTriangles || !this.pieces.length) return;
      const positions: number[] = [];
      for (const t of fixed.visibilityTriangles()) positions.push(...t.a, ...t.b, ...t.c);
      this.terrainParts.push({ version: fixed.version, triangles: new Float32Array(positions), complete: true });
      this.sentVersion = fixed.version; this.sentSoup = true; this.sentPages.clear();
      return;
    }
    const part: DebrisTerrain = { version: fixed.version, set: [], remove: [], complete: false };
    if (this.sentSoup) { this.sentSoup = false; this.sentPages.clear(); }
    for (const id of [...this.sentPages.keys()]) if (!pages.has(id)) { part.remove!.push(id); this.sentPages.delete(id); }
    let bytes = 0;
    for (const [id, { mesh }] of pages) {
      if (this.sentPages.get(id) === mesh) continue;
      if (bytes >= PAGE_BYTES_PER_FRAME) { this.terrainParts.push(part); return; }
      part.set!.push([id, mesh.positions.slice(), mesh.indices.slice()]); this.sentPages.set(id, mesh);
      bytes += mesh.positions.byteLength + mesh.indices.byteLength;
    }
    part.complete = true; this.terrainParts.push(part); this.sentVersion = fixed.version;
  }
  /** One frame for the debris world: commands in order, water probes, terrain, mirrors and the steps it owes. */
  private post(world: WorldQuery, tanks: readonly TankState[]): void {
    const channel = this.channel!;
    if (channel.pending >= MAX_PENDING) return;
    const supports: DebrisSupport[] = [], seen = new Set<number>();
    if (this.pieces.length) for (const s of world.collisionBodies?.() ?? []) {
      seen.add(s.id);
      const fresh = this.sentShapes.get(s.id) !== s.shapes; if (fresh) this.sentShapes.set(s.id, s.shapes);
      supports.push({ id: s.id, position: s.position, rotation: s.rotation, ...(fresh ? { shapes: s.shapes.map(c => ({ vertices: c.vertices, ...(c.offset ? { offset: c.offset } : {}) })) } : {}) });
    }
    for (const id of [...this.sentShapes.keys()]) if (!seen.has(id)) this.sentShapes.delete(id);
    const terrain = this.terrainParts, transfer: Transferable[] = [];
    for (const t of terrain) { for (const [, p, i] of t.set ?? []) transfer.push(p.buffer, i.buffer); if (t.triangles) transfer.push(t.triangles.buffer); }
    const frame: DebrisFrame = { frame: ++this.frame, commands: this.outbox, water: this.water, ...(terrain.length ? { terrain } : {}), supports,
      tanks: this.pieces.length ? tanks.filter(t => !t.retired).map(t => ({ id: t.id, generation: t.generation, position: t.position, rotation: t.rotation,
        turretYaw: t.turretYaw, barrelPitch: t.barrelPitch, suspension: t.suspension, wheelSuspension: t.wheelSuspension, loadout: t.loadout,
        kit: t.kit, visualKind: t.visualKind, health: t.health, machinery: t.machinery, components: t.components })) : [],
      substeps: this.pieces.length ? this.substeps : 0 };
    this.outbox = []; this.water = []; this.terrainParts = []; this.substeps = 0;
    channel.post(frame, transfer);
  }
  private remove(p: Piece): void { this.byId.delete(p.id); this.outbox.push(['remove', p.id]); this.scene.instances.remove(p.instance); this.scene.meshes.destroy(p.mesh); }
  clear(): void {
    this.epoch++; this.pending.clear(); this.pieces.splice(0).forEach(p => this.remove(p));
    this.channel?.dispose(); this.channel = undefined; this.forget(); this.outbox = []; this.water = []; this.accumulator = 0; this.substeps = 0;
  }
  dispose(): void { this.clear(); }
}
