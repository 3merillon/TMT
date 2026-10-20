import type { OccupiedRegion, FacePortal, RegionFace, RegionPage } from '../gpu/terrain/contracts';
import type { ResidentArrangement } from '../gpu/terrain/arrangement';
import { area, faceKey } from '../gpu/terrain/math';

export interface BoundaryFace { region: OccupiedRegion; face: RegionFace }
export interface Connectivity {
  anchored: OccupiedRegion[]; detached: OccupiedRegion[][]; portals: FacePortal[];
  boundary: BoundaryFace[]; nodes: number; graphBytes: number; milliseconds: number;
}
/** Physical f32 vertices can coincide across distinct source planes. Their supporting face is part of a portal's
 * identity: pairing by positions alone joins unrelated incidences when a thin arrangement wedge rounds flat. */
const portalKey = (face: RegionFace) => `${face.source}/${faceKey(face.vertices)}`;
function* componentsSteps(ids: readonly string[], adjacency: Map<string, Set<string>>): Generator<void, string[][]> {
  const unseen = new Set(ids), result: string[][] = []; let visited = 0;
  while (unseen.size) {
    const first = unseen.values().next().value!, queue = [first]; unseen.delete(first);
    for (let i = 0; i < queue.length; i++) {
      for (const neighbor of adjacency.get(queue[i]) ?? []) if (unseen.delete(neighbor)) queue.push(neighbor);
      if (++visited % 4096 === 0) yield;
    }
    result.push(queue);
  }
  return result;
}
/** Two partitions of the same ids are equal (sliced; no sorting of joined strings). */
function* samePartition(a: readonly string[][], b: readonly string[][]): Generator<void, boolean> {
  if (a.length !== b.length) return false;
  const group = new Map<string, number>(); let visited = 0;
  a.forEach((members, i) => { for (const id of members) group.set(id, i); });
  yield;
  const used = new Set<number>();
  for (const members of b) {
    const index = group.get(members[0]);
    if (index === undefined || used.has(index) || a[index].length !== members.length) return false;
    used.add(index);
    for (const id of members) { if (group.get(id) !== index) return false; if (++visited % 8192 === 0) yield; }
  }
  return true;
}
function edge(graph: Map<string, Set<string>>, a: string, b: string): void {
  if (!graph.has(a)) graph.set(a, new Set()); if (!graph.has(b)) graph.set(b, new Set()); graph.get(a)!.add(b); graph.get(b)!.add(a);
}
/** The independent fine-graph oracle (tests, ?residentCheck=1): every region, every face, from scratch. */
export function terrainConnectivity(regions: readonly OccupiedRegion[], arrangement: ResidentArrangement): Connectivity {
  const steps = terrainConnectivitySteps(regions, arrangement); for (;;) { const next = steps.next(); if (next.done) return next.value; }
}
/** The same oracle, yielding periodically (idle-time qualification in the browser). */
export function* terrainConnectivitySteps(regions: readonly OccupiedRegion[], arrangement: ResidentArrangement): Generator<void, Connectivity> {
  const start = performance.now(), lookup = new Map(regions.map(r => [r.id, r])), patches = new Map<string, BoundaryFace[]>();
  let visited = 0;
  for (const region of regions) {
    for (const face of region.faces) { const key = portalKey(face), entries = patches.get(key) ?? []; entries.push({ region, face }); patches.set(key, entries); }
    if (++visited % 512 === 0) yield;
  }
  const portals: FacePortal[] = [], boundary: BoundaryFace[] = [], fine = new Map<string, Set<string>>(), local = new Map<string, Set<string>>();
  for (const [key, entries] of patches) {
    if (entries.length > 2) throw new Error(`Non-manifold occupied portal ${key}`);
    const patchArea = area(entries[0].face.vertices.map(id => arrangement.vertices[id].position));
    if (!(patchArea > 0)) throw new Error(`Zero-area portal ${key}`);
    if (++visited % 4096 === 0) yield;
    if (entries.length === 1) { boundary.push(entries[0]); continue; }
    const [a, b] = entries.map(e => e.region), crossBrick = a.brick !== b.brick;
    portals.push({ key, a: a.id, b: b.id, area: patchArea, crossBrick }); edge(fine, a.id, b.id);
    if (!crossBrick) edge(local, a.id, b.id);
  }
  // Rebuild local components after EVERY deletion. No merge-only union-find state.
  const nodes = yield* componentsSteps(regions.map(r => r.id), local), membership = new Map<string, string>(), contracted = new Map<string, Set<string>>();
  nodes.forEach((group, i) => group.forEach(id => membership.set(id, String(i))));
  yield;
  for (const portal of portals) { if (portal.crossBrick) edge(contracted, membership.get(portal.a)!, membership.get(portal.b)!); if (++visited % 8192 === 0) yield; }
  const groups = (yield* componentsSteps(nodes.map((_, i) => String(i)), contracted)).map(group => group.flatMap(node => nodes[Number(node)]));
  yield;
  const anchored: OccupiedRegion[] = [], detached: OccupiedRegion[][] = [];
  for (const group of groups) {
    const members = group.map(id => lookup.get(id)!);
    if (members.some(r => r.anchor)) { for (const member of members) anchored.push(member); } else detached.push(members);
    yield;
  }
  // Independent traversal over the uncontracted region bonds verifies full partition,
  // including remote, unedited bricks and multiple disconnected nodes in one brick.
  const fineGroups = yield* componentsSteps(regions.map(r => r.id), fine);
  if (!(yield* samePartition(groups, fineGroups))) throw new Error('Fine BFS and contracted connectivity disagree');
  return { anchored, detached, portals, boundary, nodes: nodes.length, graphBytes: portals.length * 16 + regions.length * 8 + nodes.length * 8, milliseconds: performance.now() - start };
}

/** Closed regular fixture audit: common subdivisions, orientation, no T junctions. */
export function auditBoundary(boundary: readonly BoundaryFace[]): { edges: number; unpaired: number; orientationErrors: number } {
  const steps = auditBoundarySteps(boundary); for (;;) { const next = steps.next(); if (next.done) return next.value; }
}
export function* auditBoundarySteps(boundary: readonly BoundaryFace[]): Generator<void, { edges: number; unpaired: number; orientationErrors: number }> {
  let visited = 0;
  const edges = new Map<string, { count: number; balance: number }>();
  for (const { face } of boundary) for (let i = 0; i < face.vertices.length; i++) {
    const a = face.vertices[i], b = face.vertices[(i + 1) % face.vertices.length], key = a < b ? `${a}/${b}` : `${b}/${a}`;
    const e = edges.get(key) ?? { count: 0, balance: 0 }; e.count++; e.balance += a < b ? 1 : -1; edges.set(key, e);
    if (++visited % 1024 === 0) yield;
  }
  return { edges: edges.size, unpaired: [...edges.values()].filter(e => e.count !== 2).length, orientationErrors: [...edges.values()].filter(e => e.balance !== 0).length };
}

// ---- O(dirty) connectivity -------------------------------------------------------------------------------------------
/** Numeric key of a face's sorted physical ids (53 bits); equal keys are always confirmed by comparing the ids. */
export function faceHash(ids: ArrayLike<number>): number {
  let h1 = 0x811c9dc5 | 0, h2 = 0x2545f491 | 0;
  for (let i = 0; i < ids.length; i++) {
    const v = ids[i] | 0;
    h1 = Math.imul(h1 ^ v, 0x01000193);
    h2 = Math.imul(h2 ^ (v + 0x7f4a7c15 + (h2 << 6) + (h2 >>> 2)), 0x85ebca6b); h2 ^= h2 >>> 15;
  }
  return (h1 >>> 0) * 2097152 + ((h2 >>> 0) & 0x1fffff);
}
const EDGE = 67108864; // vertex ids < 2^26: the edge key a·2^26 + b is exact
const sameIds = (a: Int32Array, b: Int32Array) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
/** A face not bonded inside its brick: a cross-brick portal candidate, or exterior boundary. */
export interface OpenFace extends BoundaryFace { readonly key: number; readonly ids: Int32Array; readonly faceIndex: number; readonly node: LocalNode }
/** A connected component of one brick's regions: a node of the contracted graph. */
export interface LocalNode { readonly id: number; readonly brick: string; readonly regions: OccupiedRegion[]; volume: number; anchored: boolean; readonly open: OpenFace[] }
export interface LocalTopology { readonly page: RegionPage; readonly nodes: LocalNode[]; readonly open: OpenFace[]; readonly bonds: number }
export interface SeamAudit { edges: number; unpaired: number; orientationErrors: number }
/** Per-region face keys (regions are immutable; clean tets reuse their region objects, so these are computed once). */
const faceKeys = new WeakMap<OccupiedRegion, Float64Array>();
const scratch = new Int32Array(256);
function sortedKey(vertices: readonly number[]): number {
  const n = vertices.length;
  if (n > scratch.length) return faceHash(Int32Array.from(vertices).sort());
  for (let i = 0; i < n; i++) { const v = vertices[i]; let j = i; while (j > 0 && scratch[j - 1] > v) { scratch[j] = scratch[j - 1]; j--; } scratch[j] = v; }
  return faceHash(scratch.subarray(0, n));
}
/** Same vertex set (faces are simple polygons without repeated vertices). */
function sameFace(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (const v of a) if (!b.includes(v)) return false;
  return true;
}
function positiveArea(vertices: readonly number[], arrangement: ResidentArrangement): boolean {
  const o = arrangement.vertices[vertices[0]].position;
  for (let i = 1; i + 1 < vertices.length; i++) {
    const a = arrangement.vertices[vertices[i]].position, b = arrangement.vertices[vertices[i + 1]].position;
    const ax = a[0] - o[0], ay = a[1] - o[1], az = a[2] - o[2], bx = b[0] - o[0], by = b[1] - o[1], bz = b[2] - o[2];
    if (Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) > 0) return true;
  }
  return false;
}
function regionKeys(region: OccupiedRegion, arrangement: ResidentArrangement): Float64Array {
  let keys = faceKeys.get(region);
  if (!keys) {
    keys = new Float64Array(region.faces.length);
    for (let i = 0; i < region.faces.length; i++) {
      const face = region.faces[i];
      if (face.vertices.length < 3 || !positiveArea(face.vertices, arrangement)) throw new Error(`Zero-area portal ${faceKey(face.vertices)}`);
      keys[i] = sortedKey(face.vertices);
    }
    faceKeys.set(region, keys);
  }
  return keys;
}
/** Local topology of one brick: bonded faces union regions into nodes; every other face is open. */
export function localTopology(page: RegionPage, arrangement: ResidentArrangement, nextNode: () => number): LocalTopology {
  const steps = localTopologySteps(page, arrangement, nextNode); for (;;) { const next = steps.next(); if (next.done) return next.value; }
}
/** The same, yielding every few hundred regions (edits slice it to keep frames short). */
export function* localTopologySteps(page: RegionPage, arrangement: ResidentArrangement, nextNode: () => number): Generator<void, LocalTopology> {
  const regions = page.regions, parent = new Int32Array(regions.length).map((_, i) => i);
  const find = (i: number) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const first = new Map<number, number | number[]>(), keys: Float64Array[] = [];
  for (let r = 0; r < regions.length; r++) { keys.push(regionKeys(regions[r], arrangement)); if (r % 128 === 127) yield; }
  const paired = keys.map(k => new Uint8Array(k.length));
  const faceOf = (ref: number) => regions[Math.floor(ref / 4096)].faces[ref % 4096];
  let bonds = 0;
  for (let r = 0; r < regions.length; r++) {
    const k = keys[r], faces = regions[r].faces;
    for (let f = 0; f < k.length; f++) {
      const key = k[f], ref = r * 4096 + f, entry = first.get(key);
      if (entry === undefined) { first.set(key, ref); continue; }
      const refs = typeof entry === 'number' ? [entry] : entry;
      const match = refs.find(other => { const face = faceOf(other); return face.source === faces[f].source && sameFace(face.vertices, faces[f].vertices); });
      if (match === undefined) { refs.push(ref); if (typeof entry === 'number') first.set(key, refs); continue; }
      const mr = Math.floor(match / 4096), mf = match % 4096;
      if (paired[mr][mf]) throw new Error(`Non-manifold occupied portal ${faceKey(faces[f].vertices)}`);
      paired[mr][mf] = 1; paired[r][f] = 1; bonds++;
      const a = find(mr), b = find(r); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
    if (r % 256 === 255) yield;
  }
  const byRoot = new Map<number, LocalNode>(), nodes: LocalNode[] = [], open: OpenFace[] = [];
  for (let r = 0; r < regions.length; r++) {
    const root = find(r); let node = byRoot.get(root);
    if (!node) { node = { id: nextNode(), brick: page.brick, regions: [], volume: 0, anchored: false, open: [] }; byRoot.set(root, node); nodes.push(node); }
    node.regions.push(regions[r]); node.volume += regions[r].volume; if (regions[r].anchor) node.anchored = true;
  }
  for (let r = 0; r < regions.length; r++) {
    const k = keys[r], node = byRoot.get(find(r))!;
    for (let f = 0; f < k.length; f++) if (!paired[r][f]) {
      const face: OpenFace = { region: regions[r], face: regions[r].faces[f], key: k[f], ids: Int32Array.from(regions[r].faces[f].vertices).sort(), faceIndex: f, node };
      node.open.push(face); open.push(face);
    }
    if (r % 512 === 511) yield;
  }
  return { page, nodes, open, bonds };
}

export interface ConnectivityState {
  local: Map<string, LocalTopology>;
  portals: Map<number, OpenFace[]>;
  adjacency: Map<number, Map<number, number>>;
  edgeCount: Map<number, number>; edgeBalance: Map<number, number>;
}
const samePortal = (a: OpenFace, b: OpenFace) => a.face.source === b.face.source && sameIds(a.ids, b.ids);
const partnerOf = (face: OpenFace, list: readonly OpenFace[] | undefined) => list?.find(e => e !== face && e.node.brick !== face.node.brick && samePortal(e, face));

/** Persistent cross-brick connectivity: per-brick local topology, a numeric portal map of every open face, the
 * contracted node graph with portal multiplicities, and the boundary edge-balance table. An edit touches only its
 * changed bricks (plus the portal partners of their faces) through a ConnectivityDelta applied at commit. The
 * fine-graph oracle above stays independent (tests, ?residentCheck=1). */
export class ResidentConnectivity {
  private state: ConnectivityState = { local: new Map(), portals: new Map(), adjacency: new Map(), edgeCount: new Map(), edgeBalance: new Map() };
  private nodeSeq = 0;
  get bricks(): number { return this.state.local.size; }
  get nodes(): number { let n = 0; for (const t of this.state.local.values()) n += t.nodes.length; return n; }
  local(brick: string): LocalTopology | undefined { return this.state.local.get(brick); }
  /** Start an edit against the committed state; nothing changes until apply(delta). */
  begin(arrangement: ResidentArrangement): ConnectivityDelta { return new ConnectivityDelta(this.state, arrangement, () => ++this.nodeSeq); }
  apply(delta: ConnectivityDelta): void {
    if (delta.base !== this.state) throw new Error('Connectivity delta is out of date');
    const s = this.state;
    for (const [k, v] of delta.local) if (v) s.local.set(k, v); else s.local.delete(k);
    for (const [k, v] of delta.portals) if (v && v.length) s.portals.set(k, v); else s.portals.delete(k);
    for (const [k, v] of delta.adjacency) if (v && v.size) s.adjacency.set(k, v); else s.adjacency.delete(k);
    for (const [k, v] of delta.edgeCount) if (v) s.edgeCount.set(k, v); else s.edgeCount.delete(k);
    for (const [k, v] of delta.edgeBalance) if (v) s.edgeBalance.set(k, v); else s.edgeBalance.delete(k);
  }
  /** Every committed boundary face (O(world): diagnostics and tests only). */
  boundary(): BoundaryFace[] { const steps = this.boundarySteps(); for (;;) { const next = steps.next(); if (next.done) return next.value; } }
  * boundarySteps(): Generator<void, BoundaryFace[]> {
    const out: BoundaryFace[] = [], state = this.state;
    for (const topology of state.local.values()) { for (const face of topology.open) if (!partnerOf(face, state.portals.get(face.key))) out.push(face); yield; }
    return out;
  }
  /** Remap every id-derived key after a vertex compaction (sliced; swap the result in with adopt()). */
  * remapSteps(pages: ReadonlyMap<string, RegionPage>, regions: ReadonlyMap<OccupiedRegion, OccupiedRegion>, remap: Int32Array): Generator<void, ConnectivityState> {
    const next: ConnectivityState = { local: new Map(), portals: new Map(), adjacency: this.state.adjacency, edgeCount: new Map(), edgeBalance: new Map() };
    let visited = 0;
    for (const [brick, topology] of this.state.local) {
      const page = pages.get(brick);
      if (!page) throw new Error(`Compaction lost resident brick ${brick}`);
      const open: OpenFace[] = [], nodes: LocalNode[] = topology.nodes.map(node => ({ ...node, regions: node.regions.map(r => regions.get(r) ?? r), open: [] }));
      const byId = new Map(nodes.map(node => [node.id, node]));
      for (const face of topology.open) {
        const region = regions.get(face.region) ?? face.region, ids = face.ids.map(id => remap[id]), node = byId.get(face.node.id)!;
        if (ids.some(id => id < 0)) throw new Error('Compaction dropped an open face vertex');
        const moved: OpenFace = { region, face: region.faces[face.faceIndex], key: faceHash(ids), ids, faceIndex: face.faceIndex, node };
        node.open.push(moved); open.push(moved);
        const list = next.portals.get(moved.key); if (list) list.push(moved); else next.portals.set(moved.key, [moved]);
      }
      next.local.set(brick, { page, nodes, open, bonds: topology.bonds });
      if (++visited % 16 === 0) yield;
    }
    for (const [key, count] of this.state.edgeCount) {
      const a = remap[Math.floor(key / EDGE)], b = remap[key % EDGE];
      if (a < 0 || b < 0) throw new Error('Compaction dropped a boundary edge vertex');
      const moved = a * EDGE + b; next.edgeCount.set(moved, count);
      const balance = this.state.edgeBalance.get(key); if (balance) next.edgeBalance.set(moved, balance);
      if (++visited % 8192 === 0) yield;
    }
    return next;
  }
  get current(): ConnectivityState { return this.state; }
  adopt(state: ConnectivityState): void { this.state = state; }
  /** Compatibility API (tests): bring the persistent state to `pages` and return the full graph (O(world)). */
  rebuild(pages: ReadonlyMap<string, RegionPage>, arrangement: ResidentArrangement): { cache: ResidentConnectivity; graph: Connectivity } {
    const start = performance.now(), delta = this.begin(arrangement), changed = new Map<string, RegionPage>();
    for (const [brick, page] of pages) if (this.state.local.get(brick)?.page !== page) changed.set(brick, page);
    for (const brick of this.state.local.keys()) if (!pages.has(brick)) throw new Error(`Connectivity rebuild dropped brick ${brick}`);
    delta.update(changed);
    const audit = delta.finish(), { detached } = delta.components();
    if (audit.unpaired || audit.orientationErrors) throw new Error(`Shared boundary audit failed: ${JSON.stringify(audit)}`);
    this.apply(delta);
    const anchored: OccupiedRegion[] = [], detachedSet = new Set(detached.flat());
    for (const topology of this.state.local.values()) for (const node of topology.nodes) for (const region of node.regions) if (!detachedSet.has(region)) anchored.push(region);
    const portals: FacePortal[] = [];
    for (const list of this.state.portals.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++)
      if (list[i].node.brick !== list[j].node.brick && samePortal(list[i], list[j])) portals.push({ key: portalKey(list[i].face), a: list[i].region.id, b: list[j].region.id, area: area(list[i].face.vertices.map(id => arrangement.vertices[id].position)), crossBrick: true });
    return { cache: this, graph: { anchored, detached, portals, boundary: this.boundary(), nodes: this.nodes, graphBytes: portals.length * 16 + anchored.length * 8 + this.nodes * 8, milliseconds: performance.now() - start } };
  }
}

/** One edit's overlay on the committed connectivity. update() may run repeatedly (again for the bricks that lose a
 * detached group); finish() audits every boundary edge the delta touched. */
export class ConnectivityDelta {
  readonly local = new Map<string, LocalTopology | null>();
  readonly portals = new Map<number, OpenFace[] | null>();
  readonly adjacency = new Map<number, Map<number, number> | null>();
  readonly edgeCount = new Map<number, number>();
  readonly edgeBalance = new Map<number, number>();
  /** Unchanged bricks whose boundary changed because a portal partner appeared or vanished. */
  readonly reboundaried = new Set<string>();
  /** Every brick given a new local topology by this delta. */
  readonly changed = new Set<string>();
  readonly touchedEdges = new Set<number>();
  milliseconds = 0;
  private readonly prepared = new Map<string, LocalTopology>();
  constructor(readonly base: ConnectivityState, private readonly arrangement: ResidentArrangement, private readonly nextNode: () => number) {}
  /** Compute a changed brick's local topology ahead of update() (lets the caller yield between bricks). */
  prepare(page: RegionPage): void { const steps = this.prepareSteps(page); for (;;) if (steps.next().done) return; }
  /** prepare(), resumable: the caller may yield between steps (edits keep their slices short). */
  * prepareSteps(page: RegionPage): Generator<void, void> {
    const steps = localTopologySteps(page, this.arrangement, this.nextNode);
    for (;;) {
      const start = performance.now(), next = steps.next();
      this.milliseconds += performance.now() - start;
      if (next.done) { this.prepared.set(page.brick, next.value); return; }
      yield;
    }
  }
  getLocal(brick: string): LocalTopology | undefined { return this.local.has(brick) ? this.local.get(brick) ?? undefined : this.base.local.get(brick); }
  private getPortals(key: number): OpenFace[] | undefined { return this.portals.has(key) ? this.portals.get(key) ?? undefined : this.base.portals.get(key); }
  private row(node: number): Map<number, number> | undefined { return this.adjacency.has(node) ? this.adjacency.get(node) ?? undefined : this.base.adjacency.get(node); }
  private writable(node: number): Map<number, number> {
    const current = this.row(node);
    if (this.adjacency.has(node) && current) return current;
    const copy = new Map(current ?? []); this.adjacency.set(node, copy); return copy;
  }
  private link(a: number, b: number, delta: number): void {
    for (const [x, y] of [[a, b], [b, a]]) {
      const row = this.writable(x), count = (row.get(y) ?? 0) + delta;
      if (count < 0) throw new Error('Connectivity portal multiplicity underflow');
      if (count) row.set(y, count); else row.delete(y);
    }
  }
  private edges(face: OpenFace, sign: 1 | -1): void {
    const v = face.face.vertices;
    for (let i = 0; i < v.length; i++) {
      const a = v[i], b = v[(i + 1) % v.length], key = a < b ? a * EDGE + b : b * EDGE + a;
      this.edgeCount.set(key, (this.edgeCount.has(key) ? this.edgeCount.get(key)! : this.base.edgeCount.get(key) ?? 0) + sign);
      this.edgeBalance.set(key, (this.edgeBalance.has(key) ? this.edgeBalance.get(key)! : this.base.edgeBalance.get(key) ?? 0) + sign * (a < b ? 1 : -1));
      this.touchedEdges.add(key);
    }
  }
  /** Replace the local topology of every changed brick (complete pages; an empty page is allowed). */
  update(changed: ReadonlyMap<string, RegionPage>): void { const steps = this.updateSteps(changed); for (;;) if (steps.next().done) return; }
  /** update(), resumable (edits yield between steps). The delta is only read by its owner until it finishes. */
  * updateSteps(changed: ReadonlyMap<string, RegionPage>): Generator<void, void> {
    let clock = performance.now(), visited = 0;
    const pause = () => { this.milliseconds += performance.now() - clock; }, resume = () => { clock = performance.now(); };
    const next = new Map<string, LocalTopology>();
    for (const [brick, page] of changed) { const ready = this.prepared.get(brick); next.set(brick, ready?.page === page ? ready : localTopology(page, this.arrangement, this.nextNode)); this.prepared.delete(brick); }
    const touched = new Set<number>(), isChanged = (face: OpenFace) => changed.has(face.node.brick);
    for (const brick of changed.keys()) for (const face of this.getLocal(brick)?.open ?? []) touched.add(face.key);
    for (const topology of next.values()) for (const face of topology.open) touched.add(face.key);
    pause(); yield; resume();
    // Boundary status of the unchanged portal partners before the edit.
    const before = new Map<OpenFace, boolean>();
    for (const key of touched) {
      const list = this.getPortals(key); if (list) for (const face of list) if (!isChanged(face)) before.set(face, !partnerOf(face, list));
      if (++visited % 2048 === 0) { pause(); yield; resume(); }
    }
    // Retire the old topology: its boundary edges and every contracted edge of its nodes.
    const retiring = new Set<number>();
    for (const brick of changed.keys()) for (const node of this.getLocal(brick)?.nodes ?? []) retiring.add(node.id);
    for (const brick of changed.keys()) {
      const old = this.getLocal(brick); if (!old) continue;
      for (const face of old.open) { if (!partnerOf(face, this.getPortals(face.key))) this.edges(face, -1); if (++visited % 1024 === 0) { pause(); yield; resume(); } }
      for (const node of old.nodes) {
        for (const [neighbor, count] of this.row(node.id) ?? []) if (!retiring.has(neighbor)) {
          const row = this.writable(neighbor), left = (row.get(node.id) ?? 0) - count;
          if (left !== 0) throw new Error('Connectivity portal multiplicity mismatch');
          row.delete(node.id);
        }
        this.adjacency.set(node.id, null);
      }
    }
    // Rewrite the touched portal lists: unchanged entries stay, the new open faces join.
    for (const key of touched) { this.portals.set(key, this.getPortals(key)?.filter(face => !isChanged(face)) ?? []); if (++visited % 2048 === 0) { pause(); yield; resume(); } }
    for (const topology of next.values()) for (const face of topology.open) this.portals.get(face.key)!.push(face);
    for (const key of touched) {
      const list = this.portals.get(key)!;
      for (let i = 0; i < list.length; i++) {
        let partners = 0;
        for (let j = 0; j < list.length; j++) if (i !== j && samePortal(list[i], list[j])) {
          partners++;
          if (list[i].node.brick === list[j].node.brick) throw new Error(`Unbonded duplicate face ${[...list[i].ids].join(',')}`);
          if (j > i && (isChanged(list[i]) || isChanged(list[j]))) this.link(list[i].node.id, list[j].node.id, 1);
        }
        if (partners > 1) throw new Error(`Non-manifold cross-brick portal ${[...list[i].ids].join(',')}`);
      }
      if (++visited % 2048 === 0) { pause(); yield; resume(); }
    }
    for (const [brick, topology] of next) { this.local.set(brick, topology); this.changed.add(brick); this.reboundaried.delete(brick); }
    for (const topology of next.values()) for (const face of topology.open) { if (!partnerOf(face, this.getPortals(face.key))) this.edges(face, 1); if (++visited % 1024 === 0) { pause(); yield; resume(); } }
    for (const [face, was] of before) {
      const now = !partnerOf(face, this.getPortals(face.key));
      if (now === was) continue;
      this.edges(face, now ? 1 : -1);
      if (!this.changed.has(face.node.brick)) this.reboundaried.add(face.node.brick);
    }
    pause();
  }
  /** Current boundary of a brick (its open faces without a partner). */
  boundary(brick: string): OpenFace[] {
    const topology = this.getLocal(brick); if (!topology) return [];
    return topology.open.filter(face => !partnerOf(face, this.getPortals(face.key)));
  }
  /** A brick's boundary in the committed state this delta started from. */
  previousBoundary(brick: string): OpenFace[] {
    const topology = this.base.local.get(brick); if (!topology) return [];
    return topology.open.filter(face => !partnerOf(face, this.base.portals.get(face.key)));
  }
  /** Boundary of a group of nodes (e.g. a detached group). */
  groupBoundary(nodes: readonly LocalNode[]): OpenFace[] { return nodes.flatMap(node => node.open.filter(face => !partnerOf(face, this.getPortals(face.key)))); }
  /** Components of the contracted graph (every node; a few hundred). Unanchored components are detached. */
  components(): { detached: OccupiedRegion[][]; groups: LocalNode[][]; nodes: number } {
    const nodes = new Map<number, LocalNode>();
    for (const brick of new Set([...this.base.local.keys(), ...this.local.keys()])) for (const node of this.getLocal(brick)?.nodes ?? []) nodes.set(node.id, node);
    const seen = new Set<number>(), groups: LocalNode[][] = [];
    for (const node of nodes.values()) {
      if (seen.has(node.id)) continue;
      seen.add(node.id); const queue = [node]; let anchored = node.anchored;
      for (let i = 0; i < queue.length; i++) for (const neighbor of this.row(queue[i].id)?.keys() ?? []) if (!seen.has(neighbor)) {
        const n = nodes.get(neighbor); if (!n) throw new Error(`Dangling contracted edge to node ${neighbor}`);
        seen.add(neighbor); queue.push(n); anchored ||= n.anchored;
      }
      if (!anchored) groups.push(queue);
    }
    return { groups, detached: groups.map(group => group.flatMap(node => node.regions)), nodes: nodes.size };
  }
  /** Audit every boundary edge this delta touched: each must be used exactly twice, in opposite directions. */
  finish(): SeamAudit {
    let unpaired = 0, orientationErrors = 0;
    for (const key of this.touchedEdges) {
      const count = this.edgeCount.get(key) ?? 0, balance = this.edgeBalance.get(key) ?? 0;
      if (count !== 0 && count !== 2) unpaired++;
      if (balance !== 0) orientationErrors++;
    }
    return { edges: this.touchedEdges.size, unpaired, orientationErrors };
  }
}
