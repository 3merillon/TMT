/** Conservative lower-belt terrain envelope over the committed triangle mesh. */
import type { Loadout, Q4, TerrainQueryBounds, V3, WorldQuery } from './contracts';
import { add, dot, mul, rotate, rotateInto, sub } from './math';
import { ROAD_WHEEL_CENTER_Y, TREAD_CONTACT_CEILING, TREAD_CONTACT_FLOOR, WHEEL_SUPPORT_RADIUS, WHEEL_SHOE_CLEARANCE } from './modules';
import { assembleLegacy, kitWheelOffsets } from './kit/assembly';
import type { KitAssembly } from './kit/types';
import { TriangleSoup } from './triangle-soup';

/** Running gear of a kit assembly, or of a v1 loadout mapped through the kit (Appendix A). */
export type TreadSource = Loadout | KitAssembly;
const gearOf = (source: TreadSource): KitAssembly => 'running' in source ? source : assembleLegacy(source);

const TRIANGLE_BUDGET = 512;
type Polygon = V3[];
export interface TrackTerrainSample {
  heights: number[];
  /** Complete clipped local polygons, or null for the bounded ray fallback. */
  bands: Polygon[][] | null;
  /** Driver-left/right upper envelope: [local Z, local Y], allowing vertical edges. */
  terrain: [number, number][][];
}
/** The allocation-free form of WorldQuery.queryTriangles (TerrainCollision, ResidentQueries, ResidentGameTerrain). */
interface TriangleSource { collect(bounds: TerrainQueryBounds, maxTriangles: number, out: TriangleSoup): boolean }

/** Polygons as vertex triples in one buffer: polygon i is vertices [first[i], first[i] + size[i]), with its range
 * low[3i + axis]..high[3i + axis] along each axis. */
class Polygons {
  data = new Float64Array(3 * 512); vertices = 0; count = 0;
  first = new Int32Array(128); size = new Int32Array(128); low = new Float64Array(3 * 128); high = new Float64Array(3 * 128);
  clear(): void { this.vertices = 0; this.count = 0; }
  reserve(vertices: number): Float64Array {
    if ((this.vertices + vertices) * 3 > this.data.length) { const grown = new Float64Array(Math.max(this.data.length * 2, (this.vertices + vertices) * 6)); grown.set(this.data); this.data = grown; }
    return this.data;
  }
  /** Keep the vertices appended since `from` as a polygon (an empty clip is dropped, as the historical filter did). */
  close(from: number): void {
    const n = this.vertices - from;
    if (!n) return;
    if (this.count === this.first.length) {
      const grow = <T extends Int32Array | Float64Array>(a: T): T => { const b = new(a.constructor as new(n: number) => T)(a.length * 2); b.set(a); return b; };
      this.first = grow(this.first); this.size = grow(this.size); this.low = grow(this.low); this.high = grow(this.high);
    }
    const i = this.count++, d = this.data;
    this.first[i] = from; this.size[i] = n;
    for (let axis = 0; axis < 3; axis++) {
      let lo = d[from * 3 + axis], hi = lo;
      for (let v = from + 1; v < this.vertices; v++) { lo = Math.min(lo, d[v * 3 + axis]); hi = Math.max(hi, d[v * 3 + axis]); }
      this.low[i * 3 + axis] = lo; this.high[i * 3 + axis] = hi;
    }
  }
}

/** One Sutherland–Hodgman pass in the historical operation order: the `n` vertices of `src` from vertex `from`
 * against axis·sign ≥ boundary·sign, appended to `dst`. */
function clip(src: Float64Array, from: number, n: number, axis: number, boundary: number, sign: number, dst: Polygons): void {
  const out = dst.reserve(n * 2);
  let w = dst.vertices * 3;
  for (let i = 0; i < n; i++) {
    const a = (from + i) * 3, b = (from + (i + 1) % n) * 3;
    const da = (src[a + axis] - boundary) * sign, db = (src[b + axis] - boundary) * sign;
    if (da >= -1e-10) { out[w] = src[a]; out[w + 1] = src[a + 1]; out[w + 2] = src[a + 2]; w += 3; }
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const at = da / (da - db);
      out[w] = src[a] + (src[b] - src[a]) * at; out[w + 1] = src[a + 1] + (src[b + 1] - src[a + 1]) * at; out[w + 2] = src[a + 2] + (src[b + 2] - src[a + 2]) * at; w += 3;
    }
  }
  dst.vertices = w / 3;
}
/** slab(): clip at min (sign 1), then at max (sign -1), through `via`; the result is appended to `dst`. */
function slab(src: Float64Array, from: number, n: number, axis: number, min: number, max: number, via: Polygons, dst: Polygons): void {
  via.clear(); clip(src, from, n, axis, min, 1, via); clip(via.data, 0, via.vertices, axis, max, -1, dst);
}
/** Whether slab() of a polygon spanning [low, high] along its axis is certainly empty. Each test is the clip's own
 * rounded comparison at the extreme vertex, and rounded subtraction is monotone: below `min` for every vertex in the
 * first pass, or (min ≤ max) above `max` for every vertex, which the first pass then keeps whole and the second drops. */
const outside = (low: number, high: number, min: number, max: number): boolean => high - min < -1e-10 || (min <= max && low - max > 1e-10);

const soup = new TriangleSoup(), queryBounds: TerrainQueryBounds = { min: [0, 0, 0], max: [0, 0, 0] }, tri = new Float64Array(9);
const clipped = new Polygons(), base = new Polygons(), band = new Polygons(), section = new Polygons(), axes = new Float64Array(6);
const MAX_LINES = 192, MAX_BREAKS = 4096;
const lineLo = new Float64Array(MAX_LINES + 1), lineHi = new Float64Array(MAX_LINES + 1), lineSlope = new Float64Array(MAX_LINES + 1), lineIntercept = new Float64Array(MAX_LINES + 1);
const order = new Int32Array(MAX_LINES + 1), active = new Int32Array(MAX_LINES + 1);
const breaks = new Float64Array(MAX_BREAKS + 2 * MAX_LINES + 4), zeros = new Uint8Array(breaks.length);
const pointZ = new Float64Array(2 * breaks.length), pointY = new Float64Array(2 * breaks.length);

/** Ascending sort of breaks[0..n) in the order Array.prototype.sort with (a, b) => a - b gives these finite values:
 * equal values keep their input order. The native typed-array sort orders equal values alike, as they are the same
 * bits, except that it puts -0 before +0, so the zeros get their input order back. */
function sortBreaks(n: number): void {
  let count = 0;
  for (let i = 0; i < n; i++) if (breaks[i] === 0) zeros[count++] = 1 / breaks[i] < 0 ? 1 : 0;
  breaks.subarray(0, n).sort();
  if (!count) return;
  let first = 0;
  while (breaks[first] !== 0) first++;
  for (let k = 0; k < count; k++) breaks[first + k] = zeros[k] ? -0 : 0;
}

/** Append (z, y) to the envelope's first `points` points: skip a repeat, drop a middle point made collinear. */
function append(points: number, z: number, y: number): number {
  if (points > 0 && Math.abs(pointZ[points - 1] - z) < 1e-9 && Math.abs(pointY[points - 1] - y) < 1e-8) return points;
  if (points > 1 && Math.abs((pointY[points - 1] - pointY[points - 2]) * (z - pointZ[points - 1]) - (y - pointY[points - 1]) * (pointZ[points - 1] - pointZ[points - 2])) < 1e-9) points--;
  pointZ[points] = z; pointY[points] = y;
  return points + 1;
}

/** Exact upper envelope of the projected mesh boundary. Retaining moving mesh
 * breakpoints avoids lifting whole fixed sample intervals as a vertex crosses them. */
function upperEnvelope(polygons: Polygons, low: number, high: number): [number, number][] | null {
  let lines = 1;
  lineLo[0] = low; lineHi[0] = high; lineSlope[0] = 0; lineIntercept[0] = TREAD_CONTACT_FLOOR;
  const d = polygons.data;
  for (let p = 0; p < polygons.count; p++) {
    const first = polygons.first[p], n = polygons.size[p];
    for (let index = 0; index < n; index++) {
      const a = (first + index) * 3, b = (first + (index + 1) % n) * 3, az = d[a + 2], bz = d[b + 2];
      if (Math.abs(bz - az) < 1e-10) continue;
      const lo = Math.max(low, Math.min(az, bz)), hi = Math.min(high, Math.max(az, bz));
      if (hi - lo < 1e-10) continue;
      // Bounded work even for pathological edited meshes; callers preserve the
      // existing conservative envelope if this complete exact representation overflows.
      if (lines === MAX_LINES) return null;
      const slope = (d[b + 1] - d[a + 1]) / (bz - az);
      lineLo[lines] = lo; lineHi[lines] = hi; lineSlope[lines] = slope; lineIntercept[lines] = d[a + 1] - slope * az; lines++;
    }
  }
  let count = 0;
  for (let i = 0; i < lines; i++) { breaks[count++] = lineLo[i]; breaks[count++] = lineHi[i]; }
  // Crossings in the historical (first, second) order; a pair whose open common interval is empty cannot add one
  // (when the closed intervals do not overlap, rounding keeps max(lo) + 1e-9 >= min(hi) - 1e-9).
  for (let a = 0; a < lines; a++) for (let b = a + 1, loA = lineLo[a], hiA = lineHi[a]; b < lines; b++) {
    if (lineLo[b] >= hiA || lineHi[b] <= loA) continue;
    const lower = Math.max(loA, lineLo[b]) + 1e-9, upper = Math.min(hiA, lineHi[b]) - 1e-9;
    if (!(lower < upper)) continue;
    const slope = lineSlope[a] - lineSlope[b];
    if (Math.abs(slope) < 1e-10) continue;
    const z = (lineIntercept[b] - lineIntercept[a]) / slope;
    if (z > lower && z < upper) { breaks[count++] = z; if (count > MAX_BREAKS) return null; }
  }
  sortBreaks(count);
  // The highest line over each interval, lowest index on a tie (the historical first strict maximum): only the lines
  // covering the interval's midpoint can win, and the midpoints only grow.
  for (let i = 0; i < lines; i++) { const v = lineLo[i]; let j = i - 1; while (j >= 0 && lineLo[order[j]] > v) { order[j + 1] = order[j]; j--; } order[j + 1] = i; }
  let entered = 0, covering = 0, points = 0;
  for (let index = 0; index + 1 < count; index++) {
    const lo = breaks[index], hi = breaks[index + 1];
    if (hi - lo < 1e-9) continue;
    const mid = (lo + hi) * .5;
    while (entered < lines && lineLo[order[entered]] <= mid) active[covering++] = order[entered++];
    let winner = 0, height = TREAD_CONTACT_FLOOR;
    for (let k = 0; k < covering;) {
      const line = active[k];
      if (lineHi[line] < mid) { active[k] = active[--covering]; continue; }
      const y = lineSlope[line] * mid + lineIntercept[line];
      if (y > height || (y === height && line < winner)) { height = y; winner = line; }
      k++;
    }
    points = append(points, lo, lineSlope[winner] * lo + lineIntercept[winner]);
    points = append(points, hi, lineSlope[winner] * hi + lineIntercept[winner]);
  }
  if (points > 128) return null;
  const result: [number, number][] = [];
  for (let i = 0; i < points; i++) result.push([pointZ[i], pointY[i]]);
  return result;
}

/** Band polygons of both sides, kept for a sample: vertex triples in keptData; keptShape holds each side's polygon count,
 * then every polygon's vertex count. */
let keptData = new Float64Array(3 * 512), keptShape = new Int32Array(256);
const EMPTY = new Float64Array(0);
function keep(polygons: Polygons, side: number, kept: number): number {
  if ((kept + polygons.vertices) * 3 > keptData.length) { const grown = new Float64Array((kept + polygons.vertices) * 6); grown.set(keptData); keptData = grown; }
  const shapes = side ? 2 + keptShape[0] : 2;
  if (shapes + polygons.count > keptShape.length) { const grown = new Int32Array((shapes + polygons.count) * 2); grown.set(keptShape); keptShape = grown; }
  keptShape[side] = polygons.count;
  if (!side) keptShape[1] = 0;
  for (let p = 0; p < polygons.count; p++) {
    const n = polygons.size[p];
    keptShape[shapes + p] = n;
    keptData.set(polygons.data.subarray(polygons.first[p] * 3, (polygons.first[p] + n) * 3), kept * 3);
    kept += n;
  }
  return kept;
}
function unpack(data: Float64Array, shape: Int32Array): Polygon[][] {
  const bands: Polygon[][] = [];
  let polygon = 2, vertex = 0;
  for (let side = 0; side < 2; side++) {
    const polygons: Polygon[] = [];
    for (let p = 0; p < shape[side]; p++, polygon++) {
      const result: Polygon = [];
      for (let v = 0; v < shape[polygon]; v++, vertex++) result.push([data[vertex * 3], data[vertex * 3 + 1], data[vertex * 3 + 2]]);
      polygons.push(result);
    }
    bands.push(polygons);
  }
  return bands;
}

const gearWords = new WeakMap<KitAssembly, readonly number[]>();
/** The engine v21 tread words of a gear (rust/terrain-core/src/tread.rs): the nine tread stations, the half spacing,
 * the half track width and the belt's half length, as sampleTrackTerrain derives them. */
export function treadGearWords(source: TreadSource): readonly number[] {
  const kit = gearOf(source);
  let words = gearWords.get(kit);
  if (!words) gearWords.set(kit, words = [...kit.running.treadStations, kit.running.halfSpacing, kit.running.trackWidth * .5, Math.abs(kitWheelOffsets(kit)[0][2]) + WHEEL_SUPPORT_RADIUS]);
  return words;
}
/** Treads: the floor and ceiling of the contact height range. */
export const TREAD_RANGE = [TREAD_CONTACT_FLOOR, TREAD_CONTACT_CEILING] as const;

/** Ground heights only: the belt renderer supplies shoe thickness and clearance. */
export function sampleTrackTerrain(world: WorldQuery, position: V3, rotation: Q4, source: TreadSource): TrackTerrainSample {
  const kit = gearOf(source), stations = kit.running.treadStations, TRACK_HALF_SPACING = kit.running.halfSpacing;
  const end = Math.abs(kitWheelOffsets(kit)[0][2]) + WHEEL_SUPPORT_RADIUS;
  const halfWidth = kit.running.trackWidth * .5;
  const qx = rotation[0], qy = rotation[1], qz = rotation[2], qw = rotation[3], px = position[0], py = position[1], pz = position[2];
  rotateInto(axes, 0, 0, 1, 0, qx, qy, qz, qw);
  const upX = axes[0], upY = axes[1], upZ = axes[2], up: V3 = [upX, upY, upZ];
  const result = Array<number>(18).fill(TREAD_CONTACT_FLOOR);
  const min = queryBounds.min, max = queryBounds.max;
  min[0] = min[1] = min[2] = Infinity; max[0] = max[1] = max[2] = -Infinity;
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) {
    rotateInto(axes, 3, (i ? 1 : -1) * (TRACK_HALF_SPACING + halfWidth), j ? TREAD_CONTACT_CEILING : TREAD_CONTACT_FLOOR, k ? end : -end, qx, qy, qz, qw);
    for (let axis = 0; axis < 3; axis++) { const corner = position[axis] + axes[3 + axis]; min[axis] = Math.min(min[axis], corner) - 1e-7; max[axis] = Math.max(max[axis], corner) + 1e-7; }
  }
  const flat = (world as Partial<TriangleSource>).collect;
  let overflow = true;
  if (typeof flat === 'function') overflow = flat.call(world, queryBounds, TRIANGLE_BUDGET, soup.clear());
  else {
    const queried = world.queryTriangles?.({ min: [min[0], min[1], min[2]], max: [max[0], max[1], max[2]] }, TRIANGLE_BUDGET);
    if (queried && !queried.overflow) {
      soup.clear(); overflow = false;
      for (const { a, b, c, normal, material } of queried.triangles) {
        const o = soup.append(), s = soup.data;
        s[o] = a[0]; s[o + 1] = a[1]; s[o + 2] = a[2]; s[o + 3] = b[0]; s[o + 4] = b[1]; s[o + 5] = b[2]; s[o + 6] = c[0]; s[o + 7] = c[1]; s[o + 8] = c[2];
        s[o + 9] = normal[0]; s[o + 10] = normal[1]; s[o + 11] = normal[2]; s[o + 12] = material;
      }
    }
  }
  if (!overflow) {
    // Upward-facing triangles in the hull frame, clipped to the contact height range.
    base.clear();
    const s = soup.data, ix = -qx, iy = -qy, iz = -qz;
    for (let t = 0; t < soup.count; t++) {
      const o = t * 13;
      if (!(s[o + 9] * upX + s[o + 10] * upY + s[o + 11] * upZ > .05)) continue;
      for (let v = 0; v < 3; v++) rotateInto(tri, v * 3, s[o + v * 3] - px, s[o + v * 3 + 1] - py, s[o + v * 3 + 2] - pz, ix, iy, iz, qw);
      const yLow = Math.min(tri[1], tri[4], tri[7]), yHigh = Math.max(tri[1], tri[4], tri[7]);
      if (outside(yLow, yHigh, TREAD_CONTACT_FLOOR, TREAD_CONTACT_CEILING)) continue;
      const from = base.vertices; slab(tri, 0, 3, 1, TREAD_CONTACT_FLOOR, TREAD_CONTACT_CEILING, clipped, base); base.close(from);
    }
    const terrain: [number, number][][] = [];
    let exact = true, kept = 0;
    for (let side = 0; side < 2; side++) {
      const x = side === 0 ? TRACK_HALF_SPACING : -TRACK_HALF_SPACING, left = x - halfWidth, right = x + halfWidth;
      band.clear();
      for (let p = 0; p < base.count; p++) {
        if (outside(base.low[p * 3], base.high[p * 3], left, right)) continue;
        const from = band.vertices; slab(base.data, base.first[p], base.size[p], 0, left, right, clipped, band); band.close(from);
      }
      kept = keep(band, side, kept);
      for (let station = 0; station < 9; station++) {
        const z = stations[station], index = side * 9 + station;
        for (let p = 0; p < band.count; p++) {
          if (outside(band.low[p * 3 + 2], band.high[p * 3 + 2], z, z)) continue;
          section.clear(); slab(band.data, band.first[p], band.size[p], 2, z, z, clipped, section);
          for (let v = 0; v < section.vertices; v++) result[index] = Math.max(result[index], section.data[v * 3 + 1]);
        }
      }
      // A narrow peak can lie between stations. Lift both neighboring heights by
      // its positive residual, making the interpolated profile a conservative
      // envelope across the *entire* belt width, not just its centerline.
      for (let station = 0; station < 8; station++) {
        const a = side * 9 + station, b = a + 1, z0 = stations[station], z1 = stations[station + 1], span = z1 - z0;
        let raise = 0, maximum = Math.max(result[a], result[b]);
        for (let p = 0; p < band.count; p++) {
          if (outside(band.low[p * 3 + 2], band.high[p * 3 + 2], z0, z1)) continue;
          section.clear(); slab(band.data, band.first[p], band.size[p], 2, z0, z1, clipped, section);
          const d = section.data;
          for (let v = 0; v < section.vertices; v++) {
            const fraction = Math.max(0, Math.min(1, (d[v * 3 + 2] - z0) / span));
            raise = Math.max(raise, d[v * 3 + 1] - (result[a] * (1 - fraction) + result[b] * fraction));
            maximum = Math.max(maximum, d[v * 3 + 1]);
          }
        }
        if (Math.max(result[a], result[b]) + raise > maximum + 1e-8) result[a] = result[b] = maximum;
        else { result[a] += raise; result[b] += raise; }
      }
      const envelope = upperEnvelope(band, -end, end);
      if (!envelope) exact = false;
      terrain.push(envelope ?? stations.map((z, index) => [z, result[side * 9 + index]]));
    }
    // If either exact envelope exceeds the budget, the wheel solver must share
    // the same conservative profile as the belt; mixed constraints are infeasible.
    if (!exact) return { heights: result, bands: null, terrain: [0, 1].map(side => stations.map((z, index) => [z, result[side * 9 + index]])) };
    // Nothing in the game reads the band polygons: they are kept compactly and built on first read.
    const data = kept ? keptData.slice(0, kept * 3) : EMPTY, shape = keptShape.slice(0, 2 + keptShape[0] + keptShape[1]);
    let bands: Polygon[][] | undefined;
    return { heights: result, get bands(): Polygon[][] { return bands ??= unpack(data, shape); }, terrain };
  }
  // Analytic fixtures/older query providers: bounded center and width-edge rays.
  // A truncated triangle list is never mistaken for a complete collision surface.
  for (let side = 0; side < 2; side++) for (let station = 0; station < 9; station++) for (const edge of [-1, 0, 1]) {
    const x = (side === 0 ? TRACK_HALF_SPACING : -TRACK_HALF_SPACING) + edge * halfWidth;
    const origin = add(position, rotate([x, TREAD_CONTACT_CEILING, stations[station]], rotation));
    const hit = world.raycast(origin, mul(up, -1), TREAD_CONTACT_CEILING - TREAD_CONTACT_FLOOR);
    if (hit && dot(hit.normal, up) > .05) result[side * 9 + station] = Math.max(result[side * 9 + station], dot(sub(hit.point, position), up));
  }
  return { heights: result, bands: null, terrain: [0, 1].map(side => stations.map((z, index) => [z, result[side * 9 + index]])) };
}

/** Legacy conservative fixed-station profile for old render/checkpoint adapters. */
export function sampleTreadContacts(world: WorldQuery, position: V3, rotation: Q4, source: TreadSource): number[] {
  return sampleTrackTerrain(world, position, rotation, source).heights;
}

/** Compression transmitted through the lower belt into each road wheel. Peaks
 * between wheels can load them even when their individual downward ray is clear. */
export function treadWheelSupport(heights: readonly number[], source: TreadSource): number[] {
  const kit = gearOf(source), stations = kit.running.treadStations;
  const radius = WHEEL_SUPPORT_RADIUS;
  const shoeClearance = WHEEL_SHOE_CLEARANCE;
  return kitWheelOffsets(kit).map((wheel, index) => {
    const side = Math.floor(index / 4), wheelZ = wheel[2];
    let required = -Infinity;
    for (let segment = 0; segment < 8; segment++) {
      const lo = Math.max(stations[segment], wheelZ - radius), hi = Math.min(stations[segment + 1], wheelZ + radius);
      if (lo > hi) continue;
      const y = heights[side * 9 + segment];
      const slope = (heights[side * 9 + segment + 1] - y) / (stations[segment + 1] - stations[segment]);
      // Extrema of a line plus the lower wheel semicircle: endpoints and the
      // unique stationary point cover every location between profile stations.
      const peak = Math.max(lo, Math.min(hi, wheelZ + slope * radius / Math.sqrt(1 + slope * slope)));
      for (const z of [lo, peak, hi]) {
        const ground = y + (z - stations[segment]) * slope;
        const arc = Math.sqrt(Math.max(0, radius * radius - (z - wheelZ) ** 2));
        required = Math.max(required, ground + shoeClearance + arc - ROAD_WHEEL_CENTER_Y);
      }
    }
    return required;
  });
}
