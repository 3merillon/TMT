import type { TerrainTriangle } from './contracts';

/** A bounded triangle query in flat form: per triangle a, b, c, the unit normal and the material (13 numbers). Its own
 * module, so the tread sampler in the game entry does not pull the collision code out of its lazy chunk. */
export class TriangleSoup {
  data = new Float64Array(13 * 128);
  count = 0;
  clear(): this { this.count = 0; return this; }
  /** Offset of a newly appended triangle. */
  append(): number {
    const at = this.count * 13;
    if (at + 13 > this.data.length) { const grown = new Float64Array(this.data.length * 2); grown.set(this.data); this.data = grown; }
    this.count++; return at;
  }
  /** The object form of triangles [from, count). */
  triangles(from = 0): TerrainTriangle[] {
    const d = this.data, result: TerrainTriangle[] = [];
    for (let i = from; i < this.count; i++) {
      const o = i * 13;
      result.push({ a: [d[o], d[o + 1], d[o + 2]], b: [d[o + 3], d[o + 4], d[o + 5]], c: [d[o + 6], d[o + 7], d[o + 8]], normal: [d[o + 9], d[o + 10], d[o + 11]], material: d[o + 12] });
    }
    return result;
  }
}
