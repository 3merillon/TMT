import type { CompiledResidentPages, ResidentRecipe } from './arrangement';
import type { CompiledRegionPage, RegionFace, OccupiedRegion } from './contracts';
import type { Vec3 } from '../../core/types';

/** Integer topology and binary64 predicate operands transfer without cloning
 * hundreds of thousands of nested arrays/Maps. Shared faces are stored once. */
export interface PackedResidentPages { strings: string[]; words: Int32Array; values: Float64Array; samples?: Float32Array[] }
/** An append-only typed array (packets are built in place, not as JS number arrays that a large edit promotes). */
class Growing<T extends Int32Array | Float64Array> {
  length = 0;
  constructor(public data: T) {}
  push(value: number): void {
    if (this.length === this.data.length) { const next = new(this.data.constructor as { new(size: number): T })(this.data.length * 2); next.set(this.data); this.data = next; }
    this.data[this.length++] = value;
  }
  done(): T { return this.data.slice(0, this.length) as T; }
}
export function packPages(packet: CompiledResidentPages): PackedResidentPages {
  const strings: string[] = [], indices = new Map<string, number>(), words = new Growing(new Int32Array(4096)), values = new Growing(new Float64Array(4096));
  const text = (s: string) => { let i = indices.get(s); if (i === undefined) { i = strings.length; strings.push(s); indices.set(s, i); } return i; };
  const list = (data: ArrayLike<number>) => { words.push(data.length); for (let i = 0; i < data.length; i++) words.push(data[i]); };
  // Faces are shared by object, else by their (source, vertex sequence): the former `${source}/${ids}` key, hashed.
  const faces: RegionFace[] = [], faceSources: number[] = [], faceIds = new Map<number, number | number[]>(), faceObjects = new WeakMap<RegionFace, number>();
  const sameFace = (id: number, source: number, v: readonly number[]) => {
    const u = faces[id].vertices; if (faceSources[id] !== source || u.length !== v.length) return false;
    for (let i = 0; i < v.length; i++) if (u[i] !== v[i]) return false;
    return true;
  };
  const faceId = (face: RegionFace) => {
    const known = faceObjects.get(face); if (known !== undefined) return known;
    const source = text(face.source), v = face.vertices;
    let h1 = Math.imul(source ^ 0x9e3779b9, 0x85ebca6b), h2 = Math.imul(source ^ 0x7f4a7c15, 0xc2b2ae35);
    for (let i = 0; i < v.length; i++) { const x = v[i] | 0; h1 = Math.imul(h1 ^ x, 0x01000193); h2 = Math.imul(h2 ^ (x + 0x7f4a7c15 + (h2 << 6) + (h2 >>> 2)), 0x85ebca6b); h2 ^= h2 >>> 15; }
    const hash = (h1 >>> 0) * 2097152 + ((h2 >>> 0) & 0x1fffff), entry = faceIds.get(hash);
    let id = entry === undefined ? undefined : typeof entry === 'number' ? (sameFace(entry, source, v) ? entry : undefined) : entry.find(other => sameFace(other, source, v));
    if (id === undefined) {
      id = faces.length; faces.push(face); faceSources.push(source);
      if (entry === undefined) faceIds.set(hash, id); else if (typeof entry === 'number') faceIds.set(hash, [entry, id]); else entry.push(id);
    }
    faceObjects.set(face, id); return id;
  };
  for (const page of packet.pages) for (const r of page.regions) { for (const face of r.faces) faceId(face); for (const face of r.sourceFaces ?? r.faces) faceId(face); }
  words.push(faces.length);
  for (let i = 0; i < faces.length; i++) { words.push(faceSources[i]); list(faces[i].vertices); }
  words.push(packet.vertices.length);
  for (const v of packet.vertices) {
    words.push(v.id); words.push(text(v.key)); words.push(v.level); words.push(v.field ?? -1); words.push(v.edge![0]); words.push(v.edge![1]); words.push(v.weights.size);
    for (const x of v.position) values.push(x);
    values.push(v.values![0]); values.push(v.values![1]);
    if (v.weights instanceof WeightMap) { const pairs = v.weights.pairs; for (let i = 0; i < pairs.length; i += 2) { words.push(pairs[i]); values.push(pairs[i + 1]); } }
    else for (const [base, weight] of v.weights) { words.push(base); values.push(weight); }
    list(v.basis ?? []); for (const x of v.barycentric ?? []) values.push(x); list(v.planes ?? []);
  }
  words.push(packet.pages.length);
  for (const page of packet.pages) {
    words.push(text(page.brick)); words.push(page.revision); words.push(page.regions.length); values.push(page.removedVolume);
    // Per-tet outputs (the tet cache): computed tets (-1: all) and their removed volumes.
    if (page.tets) { list(page.tets); } else words.push(-1);
    const removed = page.tetRemoved ?? new Float64Array(); words.push(removed.length); for (let i = 0; i < removed.length; i++) values.push(removed[i]);
    for (const r of page.regions) {
      words.push(text(r.id)); words.push(text(r.tet)); words.push(r.material); words.push(text(r.source)); words.push(r.anchor === undefined ? -1 : text(r.anchor)); values.push(r.volume);
      list(r.constraints);
      const source = r.sourceFaces ?? r.faces; words.push(source.length); for (const face of source) words.push(faceId(face));
      words.push(r.faces.length); for (const face of r.faces) words.push(faceId(face));
    }
  }
  return { strings, words: words.done(), values: values.done() };
}
/** ReadonlyMap over one interleaved array [key0, weight0, key1, weight1, ...] (a vertex's <= 4 lattice
 * barycentrics): unpacking a packet allocates no Map per vertex. Iteration order is packet order. */
export class WeightMap implements ReadonlyMap<number, number> {
  constructor(readonly pairs: number[]) {}
  get size(): number { return this.pairs.length / 2; }
  get(key: number): number | undefined { for (let i = 0; i < this.pairs.length; i += 2) if (this.pairs[i] === key) return this.pairs[i + 1]; return undefined; }
  has(key: number): boolean { for (let i = 0; i < this.pairs.length; i += 2) if (this.pairs[i] === key) return true; return false; }
  forEach(callback: (value: number, key: number, map: ReadonlyMap<number, number>) => void): void { for (let i = 0; i < this.pairs.length; i += 2) callback(this.pairs[i + 1], this.pairs[i], this); }
  * entries(): MapIterator<[number, number]> { for (let i = 0; i < this.pairs.length; i += 2) yield [this.pairs[i], this.pairs[i + 1]]; }
  * keys(): MapIterator<number> { for (let i = 0; i < this.pairs.length; i += 2) yield this.pairs[i]; }
  * values(): MapIterator<number> { for (let i = 1; i < this.pairs.length; i += 2) yield this.pairs[i]; }
  [Symbol.iterator](): MapIterator<[number, number]> { return this.entries(); }
}
export function unpackPages(packet: PackedResidentPages): CompiledResidentPages {
  const steps = unpackPageSteps(packet); for (;;) { const next = steps.next(); if (next.done) return next.value; }
}
export function* unpackPageSteps(packet: PackedResidentPages): Generator<void, CompiledResidentPages> {
  const { words, values, strings } = packet; let cursor = 0, operand = 0;
  const read = () => words[cursor++], value = () => values[operand++], text = () => strings[read()], list = () => { const count = read(), data: number[] = new Array(count); for (let i = 0; i < count; i++) data[i] = words[cursor++]; return data; };
  const faces: RegionFace[] = [], vertices: ResidentRecipe[] = [], pages: CompiledRegionPage[] = [];
  for (let count = read(); count > 0; count--) { faces.push({ source: text(), vertices: list() }); if (count % 512 === 0) yield; }
  for (let count = read(); count > 0; count--) {
    const id = read(), key = text(), level = read(), field = read(), edge = [read(), read()] as [number, number], size = read(), position = [value(), value(), value()] as Vec3, operands = [value(), value()] as [number, number];
    const pairs: number[] = new Array(size * 2); for (let i = 0; i < size; i++) { pairs[i * 2] = read(); pairs[i * 2 + 1] = value(); } const weights = new WeightMap(pairs);
    const basis = list(), barycentric = basis.map(value), planes = list();
    vertices.push({ id, key, level, field: field < 0 ? undefined : field, position, edge, values: operands, weights, basis: basis.length ? basis : undefined, barycentric: barycentric.length ? barycentric : undefined, planes: planes.length ? planes : undefined });
    if (count % 256 === 0) yield;
  }
  for (let count = read(); count > 0; count--) {
    const brick = text(), revision = read(), size = read(), removedVolume = value(), regions: OccupiedRegion[] = [];
    const tetCount = read(), tets = tetCount < 0 ? undefined : Array.from(words.subarray(cursor, cursor + tetCount)); if (tets) cursor += tets.length;
    const removedCount = read(), tetRemoved = Float64Array.from(values.subarray(operand, operand + removedCount)); operand += removedCount;
    for (let i = 0; i < size; i++) {
      const id = text(), tet = text(), material = read(), source = text(), anchor = read(), volume = value(), constraints = list(), sourceFaces = list().map(id => faces[id]), physical = list().map(id => faces[id]);
      regions.push({ id, tet, brick, material, source, anchor: anchor < 0 ? undefined : strings[anchor], volume, constraints, sourceFaces, faces: physical });
      if (i % 256 === 255) yield;
    }
    pages.push({ brick, revision, removedVolume, regions, tetRemoved, ...(tets ? { tets } : {}) }); yield;
  }
  if (cursor !== words.length || operand !== values.length) throw new Error('Invalid resident topology packet');
  return { vertices, pages };
}
