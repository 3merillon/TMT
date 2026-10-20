/**
 * Belt v2 (W1-KIT, brief step 4; derived from tank-belt-path.ts). One side of a track in the (z, y) plane.
 *
 * - The taut loop is the convex envelope of the belt circles (road wheels, return rollers, sprocket and the
 *   idler), found from the common external tangents like TankBeltPath. The walk is clockwise seen from +X
 *   (top run forward, lower run rearward) and starts where the top run meets the sprocket (the fixed phase
 *   origin), so links never teleport when a wheel joins or leaves the envelope.
 * - A tensioner arm swings the idler (±travel of its centre) to keep the loop at its nominal length.
 *   Remaining slack sags the top run between its supports (never through a wheel or roller); remaining
 *   tightness stretches the link spacing slightly.
 * - Optional ground heights lift the straight lower spans: the belt is a taut string between the ground and the
 *   wheel bottoms, kept out of notches between wheels narrower than a link (`linkReach`).
 * - `sample(s)` walks the loop by arclength; link i sits at (i/N + phase/nominal) · length, which is
 *   continuous in the inputs (phase continuity).
 * Allocation-free after construction (the circles, segments and polylines live in typed arrays that only grow);
 * pure and deterministic.
 */
import { hypot2 } from './geometry/hypot';

export interface BeltCircle { z: number; y: number; r: number }
export interface BeltSample { y: number; z: number; angle: number }

/** Belt centre line clearance above the ground (the grouser tip reaches 0.025 below the centre line). */
export const BELT_GROUND_CLEARANCE = 0.029;
/** Maximum top-run sag depth. */
export const MAX_SAG = 0.03;

/** The wrap ends after 32 chain entries, each an arc and a line at most. */
const MAX_SEGS = 64;
const ARC = 1, LINE = 0, POLYLINE = 2;

export class Belt {
  /** Circles in order: [...wheels, ...rollers, sprocket, idler]. The idler entry is overwritten by the solve. */
  readonly circles: BeltCircle[];
  readonly sprocket: number;
  readonly idler: number;
  nominal = 0;
  length = 0;
  /**
   * Half the length of a rigid link (plus clearance). On ground-lifted spans the wheel ceiling is eroded by it (the
   * lowest wheel bottom within ±linkReach), so the ground never presses the belt into a notch between two wheels
   * that a link cannot enter: the Crawler's interleaved wheels, one row drooped and the other compressed.
   */
  linkReach = 0;
  /** Tensioner arm angle (radians) and the idler displacement from rest along its arc (metres, + = rearward). */
  tension = 0;
  slack = 0;
  /** The last `seat`: y, z and travel angle. */
  readonly seated = new Float64Array(3);
  // The circles as numbers (mirrored into `circles`, which stays the public view).
  private readonly cz: Float64Array;
  private readonly cy: Float64Array;
  private readonly cr: Float64Array;
  private segCount = 0;
  private readonly segKind = new Uint8Array(MAX_SEGS);
  private readonly segLength = new Float64Array(MAX_SEGS);
  private readonly segZ = new Float64Array(MAX_SEGS);
  private readonly segY = new Float64Array(MAX_SEGS);
  private readonly segR = new Float64Array(MAX_SEGS);
  private readonly segA0 = new Float64Array(MAX_SEGS);
  private readonly segDz = new Float64Array(MAX_SEGS);
  private readonly segDy = new Float64Array(MAX_SEGS);
  /** Polyline segments: interval count, points (z, y) and cumulative lengths; buffers are kept per slot. */
  private readonly segN = new Int32Array(MAX_SEGS);
  private readonly segPts: Float64Array[] = [];
  private readonly segCum: Float64Array[] = [];
  private readonly cum = new Float64Array(MAX_SEGS + 1);
  /** point(): in [2] distance, out [0] z, [1] y; seatInto(): in [3] distance, [4] half shoe. */
  private readonly pt = new Float64Array(5);
  private xs = new Float64Array(256);
  private lo = new Float64Array(256);
  private hi = new Float64Array(256);
  private ys = new Float64Array(256);
  private floor = new Float64Array(256);
  private readonly restAngle: number;
  private readonly armLength: number;

  /**
   * @param circles wheel and roller circles (rest pose), then the sprocket, then the idler at rest
   * @param pivot tensioner pivot (z, y); the idler swings on an arm from the pivot to its rest centre
   * @param travel ± idler travel along the arc
   */
  constructor(circles: readonly BeltCircle[], readonly pivot: readonly [number, number], readonly travel: number) {
    this.circles = circles.map(c => ({ ...c }));
    this.cz = Float64Array.from(circles, c => c.z);
    this.cy = Float64Array.from(circles, c => c.y);
    this.cr = Float64Array.from(circles, c => c.r);
    this.near = new Int32Array(circles.length);
    const pairs = circles.length * circles.length;
    this.pairEpoch = new Float64Array(pairs).fill(-1); this.pairOk = new Uint8Array(pairs);
    this.pairD = new Float64Array(pairs); this.pairNz = new Float64Array(pairs); this.pairNy = new Float64Array(pairs); this.pairAngle = new Float64Array(pairs);
    this.sprocket = circles.length - 2;
    this.idler = circles.length - 1;
    const idler = circles[this.idler];
    this.armLength = Math.hypot(idler.z - pivot[0], idler.y - pivot[1]);
    this.restAngle = Math.atan2(idler.y - pivot[1], idler.z - pivot[0]);
    this.placeIdler(0);
    this.build(null);
    this.nominal = this.length;
  }

  private placeIdler(offset: number): void {
    // offset > 0 swings the idler rearward (away from the pivot's front): lengthens the loop.
    const a = this.restAngle - offset / this.armLength;
    const c = this.circles[this.idler], z = this.pivot[0] + Math.cos(a) * this.armLength, y = this.pivot[1] + Math.sin(a) * this.armLength;
    c.z = z; c.y = y; this.cz[this.idler] = z; this.cy[this.idler] = y;
  }

  /** The idler centre for an offset along the arc (for posing the tensioner arm). */
  idlerAt(offset: number): { z: number; y: number; angle: number } {
    const a = this.restAngle - offset / this.armLength;
    return { z: this.pivot[0] + Math.cos(a) * this.armLength, y: this.pivot[1] + Math.sin(a) * this.armLength, angle: a };
  }

  /** The taut loop length with the idler at `offset`, into `measured` (a double return would be boxed per call). */
  private lengthAt(offset: number): void { this.placeIdler(offset); this.hull(); this.hullLength(); }
  private readonly measured = new Float64Array(1);

  /**
   * Solve for new wheel positions. `wheels` gives the (z, y) of the first wheelCount circles (in order);
   * `ground(z)` optionally returns the terrain height under the belt (local y).
   */
  update(wheels: ArrayLike<number>, wheelCount: number, ground?: ((z: number) => number) | null): void {
    this.epoch++;
    for (let i = 0; i < wheelCount; i++) {
      const c = this.circles[i], z = wheels[i * 2], y = wheels[i * 2 + 1];
      c.z = z; c.y = y; this.cz[i] = z; this.cy[i] = y;
    }
    // Tensioner: find the idler offset in [−travel, travel] whose taut loop matches the nominal length.
    let lo = -this.travel, hi = this.travel;
    const measured = this.measured;
    this.lengthAt(lo);
    const atLo = measured[0];
    this.lengthAt(hi);
    const atHi = measured[0];
    let offset: number;
    if (atHi <= this.nominal) offset = hi;          // slack even with the idler fully back: sag
    else if (atLo >= this.nominal) offset = lo;     // tight even fully forward: stretch
    else {
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        this.lengthAt(mid);
        if (measured[0] < this.nominal) lo = mid; else hi = mid;
        if (hi - lo < 1e-5) break;
      }
      offset = (lo + hi) / 2;
    }
    this.tension = offset;
    this.placeIdler(offset);
    this.build(ground ?? null);
  }

  /**
   * Clockwise gift wrapping of the circles (Rappaport): from the frontmost circle's front point, repeatedly
   * take the outer tangent that turns the support normal the least. A circle may appear more than once (a
   * raised road wheel between a low sprocket and the top run: the Christie look).
   */
  private wrap(): number {
    const cz = this.cz, cy = this.cy, cr = this.cr, n = cz.length, TAU = Math.PI * 2, idler = this.idler, epoch = this.epoch;
    let start = 0;
    for (let i = 1; i < n; i++) if (cz[i] + cr[i] > cz[start] + cr[start]) start = i;
    this.start = start;
    let i = start, theta = Math.PI / 2, count = 0, turned = 0;
    for (;;) {
      let best = -1, bestDelta = Infinity, bestDist = Infinity, bz = 0, by = 0;
      const az = cz[i], ay = cy[i], ar = cr[i];
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        // The tangent of a pair depends on its two circles only: the tensioner search moves the idler alone, so the
        // other pairs keep theirs for the whole update.
        const p = i * n + j;
        let d: number, nz: number, ny: number, angle: number;
        if (this.pairEpoch[p] === epoch) {
          if (!this.pairOk[p]) continue;
          d = this.pairD[p]; nz = this.pairNz[p]; ny = this.pairNy[p]; angle = this.pairAngle[p];
        } else {
          const keep = i !== idler && j !== idler;
          if (keep) { this.pairEpoch[p] = epoch; this.pairOk[p] = 0; }
          const dz = cz[j] - az, dy = cy[j] - ay;
          d = hypot2(dz, dy);
          if (d < 1e-9) continue;
          const along = (ar - cr[j]) / d;
          if (Math.abs(along) >= 1) continue;
          const perp = Math.sqrt(1 - along * along);
          nz = (dz * along - dy * perp) / d; ny = (dy * along + dz * perp) / d; angle = Math.atan2(nz, ny);
          if (keep) { this.pairOk[p] = 1; this.pairD[p] = d; this.pairNz[p] = nz; this.pairNy[p] = ny; this.pairAngle[p] = angle; }
        }
        const delta = (((angle - theta) % TAU) + TAU) % TAU;
        if (delta < bestDelta - 1e-10 || (Math.abs(delta - bestDelta) <= 1e-10 && d < bestDist)) { best = j; bestDelta = delta; bestDist = d; bz = nz; by = ny; }
      }
      // Closing: back on the start circle, the remaining arc to the front point ends the loop.
      const toStart = i === start && count > 0 ? (((Math.PI / 2 - theta) % TAU) + TAU) % TAU : Infinity;
      if (best < 0 || toStart <= bestDelta + 1e-10 || turned + Math.min(bestDelta, toStart) > TAU * 1.5 || count >= 31) {
        this.chainCircle[count] = i; this.chainFrom[count] = theta; this.chainTo[count] = theta + (Number.isFinite(toStart) ? toStart : 0);
        this.chainNext[count] = -1;
        return count + 1;
      }
      this.chainCircle[count] = i; this.chainFrom[count] = theta; this.chainTo[count] = theta + bestDelta;
      this.chainNext[count] = best; this.chainNz[count] = bz; this.chainNy[count] = by;
      turned += bestDelta;
      count++;
      i = best; theta = Math.atan2(bz, by);
    }
  }

  /** Pair tangents (row i, column j) valid while pairEpoch = epoch, which every update advances (the wheels move). */
  private epoch = 0;
  private readonly pairEpoch: Float64Array;
  private readonly pairOk: Uint8Array;
  private readonly pairD: Float64Array;
  private readonly pairNz: Float64Array;
  private readonly pairNy: Float64Array;
  private readonly pairAngle: Float64Array;
  private start = 0;
  private chainCircle = new Int16Array(32);
  private chainNext = new Int16Array(32);
  private chainFrom = new Float64Array(32);
  private chainTo = new Float64Array(32);
  private chainNz = new Float64Array(32);
  private chainNy = new Float64Array(32);
  private chainCount = 0;

  private hull(): void { this.chainCount = this.wrap(); }

  private hullLength(): void {
    const cz = this.cz, cy = this.cy, cr = this.cr;
    let total = 0;
    for (let k = 0; k < this.chainCount; k++) {
      const i = this.chainCircle[k];
      total += (this.chainTo[k] - this.chainFrom[k]) * cr[i];
      const j = this.chainNext[k];
      if (j < 0) continue;
      const nz = this.chainNz[k], ny = this.chainNy[k];
      total += hypot2(cz[j] + nz * cr[j] - cz[i] - nz * cr[i], cy[j] + ny * cr[j] - cy[i] - ny * cr[i]);
    }
    this.measured[0] = total;
  }

  private pushSeg(at: number, kind: number, length: number, z: number, y: number, r: number, a0: number, dz: number, dy: number): number {
    this.segKind[at] = kind; this.segLength[at] = length; this.segZ[at] = z; this.segY[at] = y;
    this.segR[at] = r; this.segA0[at] = a0; this.segDz[at] = dz; this.segDy[at] = dy;
    return at + 1;
  }

  /** The polyline buffers of segment slot `at`, grown to n + 1 points. */
  private polyline(at: number, n: number): Float64Array {
    if (!this.segPts[at] || this.segCum[at].length < n + 1) {
      this.segPts[at] = new Float64Array((n + 1) * 4);
      this.segCum[at] = new Float64Array((n + 1) * 2);
    }
    this.segN[at] = n;
    return this.segPts[at];
  }

  /** Build the segment list (arcs, lines, sag and ground polylines) and the cumulative lengths. */
  private build(ground: ((z: number) => number) | null): void {
    this.hull();
    const cz = this.cz, cy = this.cy, cr = this.cr;
    let count = 0;
    for (let k = 0; k < this.chainCount; k++) {
      const i = this.chainCircle[k], sweep = this.chainTo[k] - this.chainFrom[k];
      if (sweep * cr[i] > 1e-9) count = this.pushSeg(count, ARC, sweep * cr[i], cz[i], cy[i], cr[i], this.chainFrom[k], 0, 0);
      const j = this.chainNext[k];
      if (j < 0) continue;
      const nz = this.chainNz[k], ny = this.chainNy[k];
      const z0 = cz[i] + nz * cr[i], y0 = cy[i] + ny * cr[i], z1 = cz[j] + nz * cr[j], y1 = cy[j] + ny * cr[j];
      const L = hypot2(z1 - z0, y1 - y0);
      if (L > 1e-9) count = this.pushSeg(count, LINE, L, z0, y0, 0, 0, (z1 - z0) / L, (y1 - y0) / L);
    }
    this.segCount = count;
    let total = 0;
    for (let i = 0; i < count; i++) total += this.segLength[i];
    // Slack → top-run sag (only once the tensioner is fully back).
    this.slack = this.nominal > 0 ? this.nominal - total : 0;
    if (this.slack > 1e-5) this.sag(this.slack);
    if (ground) this.liftGround(ground);
    const cum = this.cum;
    cum[0] = 0;
    for (let i = 0; i < count; i++) cum[i + 1] = cum[i] + this.segLength[i];
    this.length = cum[count];
  }

  /** Surface height of the circles under z (for sag supports), or −∞. */
  private supportAt(z: number, exclude: number): number {
    const cz = this.cz, cy = this.cy, cr = this.cr;
    let best = -Infinity;
    for (let k = 0; k < cz.length; k++) {
      if (k === exclude) continue;
      const dz = z - cz[k];
      if (Math.abs(dz) < cr[k]) best = Math.max(best, cy[k] + Math.sqrt(cr[k] * cr[k] - dz * dz));
    }
    return best;
  }

  private sag(slack: number): void {
    // Top spans: lines travelling forward (+z) with the loop interior below them.
    const kind = this.segKind, length = this.segLength, count = this.segCount;
    let total = 0;
    for (let i = 0; i < count; i++) if (kind[i] === LINE && this.segDz[i] > 0.5) total += length[i];
    if (total <= 0) return;
    for (let i = 0; i < count; i++) {
      if (kind[i] !== LINE || !(this.segDz[i] > 0.5)) continue;
      const len = length[i], sz = this.segZ[i], sy = this.segY[i], sdz = this.segDz[i], sdy = this.segDy[i];
      const share = slack * len / total;
      // Parabolic droop: extra length ≈ 8 d² / (3 L).
      const depth = Math.min(MAX_SAG, Math.sqrt(3 * len * share / 8));
      // Dense samples (≤ 1 cm) so the belt resting on a roller or wheel never chords through it.
      const n = Math.max(12, Math.ceil(len / 0.01)), pts = this.polyline(i, n), cum = this.segCum[i];
      cum[0] = 0;
      for (let k = 0; k <= n; k++) {
        const t = k / n, z = sz + sdz * len * t, yLine = sy + sdy * len * t;
        let y = yLine - depth * 4 * t * (1 - t);
        if (k > 0 && k < n) y = Math.min(yLine, Math.max(y, this.supportAt(z, -1)));
        pts[k * 2] = z; pts[k * 2 + 1] = y;
        if (k) cum[k] = cum[k - 1] + hypot2(z - pts[k * 2 - 2], y - pts[k * 2 - 1]);
      }
      kind[i] = POLYLINE; length[i] = cum[n];
    }
  }

  private liftGround(ground: (z: number) => number): void {
    for (let i = 0; i < this.segCount; i++) {
      if (this.segKind[i] !== LINE || this.segDz[i] > -0.5) continue; // lower spans travel rearward (−z)
      const len = this.segLength[i], sz = this.segZ[i], sy = this.segY[i], sdz = this.segDz[i], sdy = this.segDy[i];
      // Sampled every centimetre (as the sag): the corridor between the ground (floor) and the bottoms of the
      // belt circles (ceiling), with the span's end points fixed.
      const n = Math.max(12, Math.ceil(len / 0.01));
      if (this.xs.length < n + 1) {
        this.xs = new Float64Array(n * 2 + 2); this.lo = new Float64Array(n * 2 + 2); this.hi = new Float64Array(n * 2 + 2);
        this.ys = new Float64Array(n * 2 + 2); this.floor = new Float64Array(n * 2 + 2);
      }
      const xs = this.xs, lo = this.lo, hi = this.hi, floor = this.floor;
      // The ground first: a sample can lift the belt only where it rises above the taut line, and lo = min(floor, hi)
      // never exceeds the floor, so a span whose floor stays below the line keeps its line without any ceiling.
      let rises = false;
      for (let k = 1; k < n; k++) {
        const t = k / n, z = sz + sdz * len * t, y = sy + sdy * len * t;
        floor[k] = ground(z) + BELT_GROUND_CLEARANCE;
        if (floor[k] > y + 1e-6) rises = true;
      }
      if (!rises) continue;
      const step = len / n, reach = Math.ceil(this.linkReach / Math.abs(sdz * step) - 1e-9);
      this.nearCircles(sz, sz + sdz * len, this.linkReach + Math.abs(sdz * step) * Math.abs(reach));
      let lifted = false;
      for (let k = 0; k <= n; k++) {
        const t = k / n, z = sz + sdz * len * t, y = sy + sdy * len * t;
        xs[k] = len * t;
        if (k === 0 || k === n) { lo[k] = hi[k] = y; continue; }
        // The wheel ceiling, eroded by the link reach (samples every centimetre plus the window ends).
        let c = Math.min(this.ceilingAt(z - this.linkReach), this.ceilingAt(z + this.linkReach));
        for (let j = -reach; j <= reach; j++) c = Math.min(c, this.ceilingAt(z + sdz * step * j));
        // The taut span already lies under every circle; the ground never lifts the belt through a wheel.
        hi[k] = Math.max(y, Math.min(c, y + 1));
        lo[k] = Math.min(floor[k], hi[k]);
        if (lo[k] > y + 1e-6) lifted = true;
      }
      if (!lifted) continue;
      // The belt is a taut string in that corridor: pushed up by the ground and held down by the wheels, it
      // leaves every wheel arc tangentially. (Round 1 capped the ground's convex hull at the circles instead:
      // the kink where a steep climb met a wheel's rear arc tipped rigid links 9 mm into interleaved wheels.)
      const ys = taut(xs, lo, hi, n, this.ys);
      const pts = this.polyline(i, n), cum = this.segCum[i];
      cum[0] = 0;
      for (let k = 0; k <= n; k++) {
        pts[k * 2] = sz + sdz * xs[k]; pts[k * 2 + 1] = ys[k];
        if (k) cum[k] = cum[k - 1] + hypot2(pts[k * 2] - pts[k * 2 - 2], pts[k * 2 + 1] - pts[k * 2 - 1]);
      }
      this.segKind[i] = POLYLINE; this.segLength[i] = cum[n];
    }
  }

  /**
   * The circles a ceiling query within `margin` of [zA, zB] can touch (a 1 µm slack covers rounding). Any other circle
   * fails |z − cz| < r for every such query, so `ceilingAt` over these returns what it returns over all of them.
   */
  private nearCircles(zA: number, zB: number, margin: number): void {
    const cz = this.cz, cr = this.cr, lo = Math.min(zA, zB) - margin - 1e-6, hi = Math.max(zA, zB) + margin + 1e-6;
    let m = 0;
    for (let k = 0; k < cz.length; k++) if (!(lo <= hi) || (cz[k] + cr[k] >= lo && cz[k] - cr[k] <= hi)) this.near[m++] = k;
    this.nearCount = m;
  }
  private readonly near: Int32Array;
  private nearCount = 0;

  private ceilingAt(z: number): number {
    const cz = this.cz, cy = this.cy, cr = this.cr, near = this.near;
    let best = Infinity;
    for (let m = 0; m < this.nearCount; m++) {
      const k = near[m], dz = z - cz[k];
      if (Math.abs(dz) < cr[k]) best = Math.min(best, cy[k] - Math.sqrt(cr[k] * cr[k] - dz * dz));
    }
    return best;
  }

  /**
   * Point at arclength pt[2] (wrapped) into pt[0] (z) and pt[1] (y). The hot calls pass their numbers through `pt`:
   * a double argument or result crossing a call that is not inlined is boxed.
   */
  private point(): void {
    const pt = this.pt, L = this.length, distance = pt[2], d = ((distance % L) + L) % L, cum = this.cum;
    let lo = 0, hi = this.segCount;
    while (hi - lo > 1) { const mid = (lo + hi) >>> 1; if (cum[mid] <= d) lo = mid; else hi = mid; }
    const kind = this.segKind[lo], r = d - cum[lo];
    if (kind === ARC) {
      const a = this.segA0[lo] + r / this.segR[lo];
      pt[0] = this.segZ[lo] + Math.sin(a) * this.segR[lo]; pt[1] = this.segY[lo] + Math.cos(a) * this.segR[lo];
    } else if (kind === LINE) {
      pt[0] = this.segZ[lo] + this.segDz[lo] * r; pt[1] = this.segY[lo] + this.segDy[lo] * r;
    } else {
      const cumK = this.segCum[lo], pts = this.segPts[lo], n = this.segN[lo];
      // The first k with cumK[k + 1] ≥ r (at most n − 1). A finite running sum of lengths is non-decreasing, so a binary
      // search finds the same k as a scan from 0; a NaN in it keeps the scan.
      let k = 0;
      if (cumK[n] - cumK[n] === 0) {
        let hiK = n - 1;
        while (k < hiK) { const mid = (k + hiK) >>> 1; if (cumK[mid + 1] < r) k = mid + 1; else hiK = mid; }
      } else while (k + 1 < n && cumK[k + 1] < r) k++;
      // clamp and lerp written out (as geometry/math defines them): calls returning doubles box their results.
      const u = (r - cumK[k]) / Math.max(1e-12, cumK[k + 1] - cumK[k]), t = u < 0 ? 0 : u > 1 ? 1 : u;
      const z0 = pts[k * 2], y0 = pts[k * 2 + 1];
      pt[0] = z0 + (pts[k * 2 + 2] - z0) * t; pt[1] = y0 + (pts[k * 2 + 3] - y0) * t;
    }
  }

  /**
   * A link's seat (y, z, angle) into out[o..o + 2]: its centre at arclength pt[3] and its orientation from the chord of
   * its shoe (± pt[4]), so rigid shoes on a wrap neither flip nor dig into the wheel.
   */
  private seatInto(out: Float64Array, o: number): void {
    const pt = this.pt, distance = pt[3], halfShoe = pt[4];
    pt[2] = distance; this.point(); const oz = pt[0], oy = pt[1];
    pt[2] = distance - halfShoe; this.point(); const bz = pt[0], by = pt[1];
    pt[2] = distance + halfShoe; this.point(); const az = pt[0], ay = pt[1];
    const dz = az - bz, dy = ay - by;
    out[o + 2] = Math.atan2(-dy, dz);
    // Where the path is concave seen from outside the loop (a ground-lifted climb levelling out under a wheel, a
    // sagging top run), the chord's midpoint lies outside the path: the rigid shoe rests on both ends there, so
    // it never tips into the wheel above the bend. (The outward normal is the travel direction turned +90°:
    // up on the top run, down on the lower run.)
    const mz = (az + bz) / 2 - oz, my = (ay + by) / 2 - oy;
    if (mz * -dy + my * dz > 0) { out[o + 1] = oz + mz; out[o] = oy + my; } else { out[o + 1] = oz; out[o] = oy; }
  }

  /** One link's seat at `distance` into `seated` (y, z, angle). */
  seat(distance: number, halfShoe: number): Float64Array {
    this.pt[3] = distance; this.pt[4] = halfShoe;
    this.seatInto(this.seated, 0);
    return this.seated;
  }

  /** The seats of `count` links, link i at (i / count + phase / nominal) · length: (y, z, angle) per link, reused. */
  seatLinks(phase: number, count: number, halfShoe: number): Float64Array {
    if (this.links.length < count * 3) this.links = new Float64Array(count * 3);
    const pt = this.pt;
    pt[4] = halfShoe;
    for (let i = 0; i < count; i++) { pt[3] = (i / count + phase / this.nominal) * this.length; this.seatInto(this.links, i * 3); }
    return this.links;
  }
  private links = new Float64Array(0);

  /** `seat` into a sample object. */
  sample(distance: number, out: BeltSample, halfShoe: number): BeltSample {
    const s = this.seat(distance, halfShoe);
    out.y = s[0]; out.z = s[1]; out.angle = s[2];
    return out;
  }

  /** Highest point of the loop (belt centre line). */
  top(): number {
    let best = -Infinity;
    for (let i = 0; i < 256; i++) { this.pt[2] = i / 256 * this.length; this.point(); best = Math.max(best, this.pt[1]); }
    return best;
  }
}

/** > 0 when (cx, cy) lies above the ray a → b (rays run toward +x). */
const area = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
let vertexX = new Float64Array(256), vertexY = new Float64Array(256);

/** tautString over the first n + 1 corridor samples. */
function taut(x: ArrayLike<number>, lo: ArrayLike<number>, hi: ArrayLike<number>, n: number, out: Float64Array): Float64Array {
  if (vertexX.length < n + 2) { vertexX = new Float64Array(n * 2 + 4); vertexY = new Float64Array(n * 2 + 4); }
  const vx = vertexX, vy = vertexY;
  let m = 0;
  vx[m] = x[0]; vy[m++] = lo[0];
  // The apex and the funnel's lower (floor) and upper (ceiling) sides, as corridor indices and heights.
  let ai = 0, ay = lo[0], li = 0, ly = ay, ui = 0, uy = ay;
  for (let i = 1; i <= n; i++) {
    const ax = x[ai];
    // A floor point on or above the lower side narrows the funnel; above the upper side, the string bends up
    // after the upper point (∨ under a ceiling point).
    if (li === ai || area(ax, ay, x[li], ly, x[i], lo[i]) >= 0) {
      if (ui === ai || area(ax, ay, x[ui], uy, x[i], lo[i]) < 0) { li = i; ly = lo[i]; }
      else { ai = ui; ay = uy; vx[m] = x[ai]; vy[m++] = ay; li = ui = ai; ly = uy = ay; i = ai; continue; }
    }
    // A ceiling point on or below the upper side narrows it; below the lower side, the string bends down after
    // the lower point (∧ over a floor point).
    if (ui === ai || area(ax, ay, x[ui], uy, x[i], hi[i]) <= 0) {
      if (li === ai || area(ax, ay, x[li], ly, x[i], hi[i]) > 0) { ui = i; uy = hi[i]; }
      else { ai = li; ay = ly; vx[m] = x[ai]; vy[m++] = ay; li = ui = ai; ly = uy = ay; i = ai; continue; }
    }
  }
  vx[m] = x[n]; vy[m++] = lo[n];
  for (let k = 0, v = 0; k <= n; k++) {
    while (v < m - 2 && vx[v + 1] <= x[k]) v++;
    const t = (x[k] - vx[v]) / Math.max(1e-12, vx[v + 1] - vx[v]);
    out[k] = vy[v] + (vy[v + 1] - vy[v]) * (t < 0 ? 0 : t > 1 ? 1 : t);
  }
  return out;
}

/**
 * The taut string through a monotone corridor (the funnel algorithm): the shortest path from (x[0], lo[0]) to
 * (x[n], lo[n]) that stays within lo[k] ≤ y ≤ hi[k] at every x[k] (x strictly increasing; lo = hi at both ends).
 * Its vertices are corridor points: floor points it passes over (∧) and ceiling points it passes under (∨), so it
 * meets a sampled circle tangentially. Writes y at every x[k] into `out` and returns it.
 */
export function tautString(x: ArrayLike<number>, lo: ArrayLike<number>, hi: ArrayLike<number>, out: Float64Array): Float64Array {
  return taut(x, lo, hi, x.length - 1, out);
}
