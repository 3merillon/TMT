/** Shared bounded belt/contact geometry, usable by renderer and authoritative collision. */
import { BELT_SHOE, END_GEAR, IDLER_TAKE_UP, ROAD_WHEEL_CENTER_Y, ROAD_WHEEL_RADIUS, TREAD_CONTACT_FLOOR, treadStationsFor, wheelStationZ } from './kit/dimensions';
const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
interface BeltCircle { z: number; y: number; radius: number }
interface BeltSegment { length: number; y: number; z: number; angle: number; radius: number; arc: boolean }
interface BeltSample { y: number; z: number; angle: number }

/** Taut outer envelope of four road wheels and two raised end gears, in local Y/Z. */
export class TankBeltPath {
  readonly circles: BeltCircle[];
  readonly nominalLength: number;
  length = 0;
  private segments: BeltSegment[] = Array.from({ length: 12 }, () => ({ length: 0, y: 0, z: 0, angle: 0, radius: 0, arc: false }));
  private segmentCount = 0;
  private next = new Int8Array(6);
  private normalZ = new Float64Array(6);
  private normalY = new Float64Array(6);
  private previousHeights = new Float64Array(4).fill(NaN);
  private ground = new Float64Array(9).fill(TREAD_CONTACT_FLOOR);
  private groundZ: number[];
  private groundActive = false;
  private terrain: readonly (readonly [number, number])[] = [];
  private terrainKey = '';
  private knots: number[] = [];
  private lower = new Float64Array(256);
  private upper = new Float64Array(256);
  private curve = new Float64Array(256);
  private baseLength = 0;
  private arcLengths = new Float64Array(1024);
  private arcParameters: number[] = [];
  private sampled = { y: 0, z: 0, angle: 0 };
  private tangentBefore = { y: 0, z: 0, angle: 0 };
  private tangentAfter = { y: 0, z: 0, angle: 0 };
  private shoeZ = new Float64Array(4);
  private shoeY = new Float64Array(4);

  /** Road-wheel stations, gears and take-up come from the kit v1 dimensions (kit/dimensions.ts). */
  constructor(readonly halfLength: number) {
    this.groundZ = treadStationsFor(halfLength);
    this.circles = Array.from({ length: 4 }, (_, i) => ({ z: wheelStationZ(i, halfLength), y: ROAD_WHEEL_CENTER_Y, radius: ROAD_WHEEL_RADIUS + BELT_SHOE }));
    // Rear sliding idler, then the front drive sprocket.
    this.circles.push({ z: -halfLength - END_GEAR.idlerBehind, y: END_GEAR.y, radius: END_GEAR.radius }, { z: halfLength + END_GEAR.sprocketAhead, y: END_GEAR.y, radius: END_GEAR.radius });
    this.rebuild();
    this.nominalLength = this.length;
  }

  update(heights: readonly number[], contacts?: readonly number[], terrain?: readonly (readonly [number, number])[]): void {
    let changed = false;
    for (let i = 0; i < 4; i++) {
      const height = Math.round(heights[i] * 10000) / 10000;
      if (height !== this.previousHeights[i]) changed = true;
      this.previousHeights[i] = height;
    }
    if (Boolean(contacts || terrain?.length) !== this.groundActive) changed = true;
    this.groundActive = Boolean(contacts || terrain?.length);
    const terrainKey = terrain?.map(point => `${Math.round(point[0] * 10000)},${Math.round(point[1] * 10000)}`).join(';') ?? '';
    if (terrainKey !== this.terrainKey) {
      changed = true;
      this.terrain = terrain?.map(([z, y]) => [Math.round(z * 10000) / 10000, Math.round(y * 10000) / 10000] as const) ?? [];
    }
    this.terrainKey = terrainKey;
    for (let i = 0; i < 9; i++) {
      const height = Math.round((contacts?.[i] ?? TREAD_CONTACT_FLOOR) * 10000) / 10000;
      if (height !== this.ground[i]) changed = true;
      this.ground[i] = height;
    }
    if (!changed) return;
    for (let i = 0; i < 4; i++) this.circles[i].y = this.previousHeights[i];
    // A sliding rear idler takes up suspension-induced length changes. The belt links
    // retain their authored dimensions/pitch instead of stretching with the wheel hull.
    const separationY = END_GEAR.y - this.circles[0].y;
    let low = Math.max(IDLER_TAKE_UP.min, Math.sqrt(Math.max(0, IDLER_TAKE_UP.wrap ** 2 - separationY ** 2)));
    let high = IDLER_TAKE_UP.max;
    // Try the authored idler position and two bounded secant corrections before falling
    // back to the original ten-step bracket. Every accepted table is exact.
    // The shared collision shape must depend on the current inputs alone, never
    // on a previous visual/collision caller's warm-start history.
    let offset = clamp(END_GEAR.idlerBehind, low, high), previousOffset = NaN, previousLength = NaN;
    for (let i = 0; i < 3; i++) {
      this.circles[4].z = -this.halfLength - offset; this.rebuild();
      const error = this.length - this.nominalLength;
      if (Math.abs(error) <= .0003) return;
      if (error < 0) low = offset; else high = offset;
      if (high - low <= .00005) return;
      const slope = Number.isFinite(previousOffset) && Math.abs(offset - previousOffset) > 1e-9 ? (this.length - previousLength) / (offset - previousOffset) : 2;
      const candidate = offset - error / (slope > .5 && slope < 3 ? slope : 2);
      previousOffset = offset; previousLength = this.length;
      offset = clamp(candidate, low, high);
    }
    for (let i = 0; i < 10; i++) {
      const offset = (low + high) * .5;
      this.circles[4].z = -this.halfLength - offset;
      this.rebuild();
      if (Math.abs(this.length - this.nominalLength) <= .0003) return;
      if (this.length < this.nominalLength) low = offset; else high = offset;
    }
    this.circles[4].z = -this.halfLength - (low + high) * .5;
    this.rebuild();
  }

  sample(distance: number, target: BeltSample, halfShoeLength = .0002): BeltSample {
    if (!this.groundActive) return this.sampleBase(distance, target);
    this.sampleDeformed(distance, target);
    // A rigid shoe spans a finite section of the belt. Averaging its chord avoids
    // an instantaneous orientation flip when its center crosses a profile corner.
    this.sampleDeformed(distance - halfShoeLength, this.tangentBefore);
    this.sampleDeformed(distance + halfShoeLength, this.tangentAfter);
    target.angle = Math.atan2(-(this.tangentAfter.y - this.tangentBefore.y), this.tangentAfter.z - this.tangentBefore.z);
    return target;
  }

  private sampleDeformed(distance: number, target: BeltSample): void {
    const wrapped = ((distance % this.length) + this.length) % this.length;
    let low = 0, high = this.arcParameters.length - 1;
    while (high - low > 1) {
      const mid = (low + high) >>> 1;
      if (this.arcLengths[mid] <= wrapped) low = mid; else high = mid;
    }
    const fraction = (wrapped - this.arcLengths[low]) / Math.max(1e-9, this.arcLengths[high] - this.arcLengths[low]);
    const base = lerp(this.arcParameters[low], this.arcParameters[high], fraction);
    this.deform(base, target);
  }

  /** Seat the finite shoe footprint, including faces spanning a ground-profile peak. */
  fitShoe(target: BeltSample, halfLength: number): void {
    if (!this.groundActive || Math.cos(target.angle) >= 0 || target.y > END_GEAR.y) return;
    const baseY = target.y, baseAngle = target.angle;
    target.y += this.groundLift(target, halfLength);
    if (this.shoeClearance(target, halfLength) >= 0) return;
    // A chord can tilt a long inner shoe corner into a wheel while its outer
    // corner is seated on a sharp crest. Resolve that rigid-shoe orientation
    // locally; lifting the entire shoe again would only worsen wheel clearance.
    let bestScore = Infinity, bestY = target.y, bestAngle = baseAngle;
    for (let candidate = 0; candidate < 14; candidate++) {
      let angle = baseAngle;
      if (candidate < 8) angle += (candidate % 2 ? 1 : -1) * (.12 + Math.floor(candidate / 2) * .12);
      else {
        const circle = this.circles[candidate - 8];
        const tangent = Math.atan2(target.z - circle.z, baseY - circle.y);
        const difference = Math.atan2(Math.sin(tangent - baseAngle), Math.cos(tangent - baseAngle));
        if (Math.abs(difference) > .65) continue;
        angle += difference;
      }
      if (Math.cos(angle) >= 0) continue;
      target.angle = angle; target.y = baseY; target.y += this.groundLift(target, halfLength);
      if (this.shoeClearance(target, halfLength) < 0) continue;
      const score = Math.abs(angle - baseAngle) + Math.abs(target.y - baseY) * 4;
      if (score < bestScore) { bestScore = score; bestY = target.y; bestAngle = angle; }
    }
    if (Number.isFinite(bestScore)) {
      let invalid = baseAngle, valid = bestAngle;
      for (let step = 0; step < 6; step++) {
        const angle = (invalid + valid) * .5; target.angle = angle; target.y = baseY; target.y += this.groundLift(target, halfLength);
        if (this.shoeClearance(target, halfLength) >= 0) { valid = angle; bestAngle = angle; bestY = target.y; } else invalid = angle;
      }
    }
    target.y = bestY; target.angle = bestAngle;
  }

  /** Exact circle versus conservative shoe rectangles in the belt cross-section. */
  private shoeClearance(target: BeltSample, halfLength: number): number {
    const sin = Math.sin(target.angle), cos = Math.cos(target.angle); let clearance = Infinity;
    for (const circle of this.circles) {
      if (Math.abs(circle.z - target.z) > circle.radius + halfLength + .025) continue;
      const dy = circle.y - target.y, dz = circle.z - target.z, localY = cos * dy + sin * dz, localZ = -sin * dy + cos * dz;
      for (let part = 0; part < 2; part++) {
        const lo = part === 0 ? -.0225 : .011, hi = part === 0 ? .0125 : .025, extent = part === 0 ? halfLength : halfLength * .21 / .94;
        const y = clamp(localY, lo, hi), z = clamp(localZ, -extent, extent);
        clearance = Math.min(clearance, Math.hypot(localY - y, localZ - z) - (circle.radius - .025));
      }
    }
    return clearance;
  }

  private groundLift(target: BeltSample, halfLength: number): number {
    const sin = Math.sin(target.angle), cos = Math.cos(target.angle);
    let lift = 0;
    // Conservative Y/Z rectangles for the chamfered main shoe and its short raised grouser.
    for (let part = 0; part < 2; part++) {
      const lo = part === 0 ? -.0225 : .011, hi = part === 0 ? .0125 : .025;
      const extent = part === 0 ? halfLength : halfLength * .21 / .94;
      for (let corner = 0; corner < 4; corner++) {
        const y = corner < 2 ? lo : hi, z = corner === 0 || corner === 3 ? -extent : extent;
        this.shoeZ[corner] = target.z + sin * y + cos * z;
        this.shoeY[corner] = target.y + cos * y - sin * z;
        lift = Math.max(lift, this.groundHeight(this.shoeZ[corner]) - this.shoeY[corner]);
      }
      for (let edge = 0; edge < 4; edge++) {
        const next = (edge + 1) % 4, a = this.shoeZ[edge], b = this.shoeZ[next];
        for (let station = 0; station < (this.terrain.length || 9); station++) {
          const z = this.terrain.length ? this.terrain[station][0] : this.groundZ[station];
          if (z < Math.min(a, b) || z > Math.max(a, b) || Math.abs(b - a) < 1e-9) continue;
          const y = lerp(this.shoeY[edge], this.shoeY[next], (z - a) / (b - a));
          lift = Math.max(lift, (this.terrain.length ? this.terrain[station][1] : this.ground[station]) - y);
        }
      }
    }
    return lift > 0 ? lift + .0005 : 0;
  }

  private groundHeight(z: number): number {
    if (this.terrain.length) {
      const points = this.terrain;
      if (z <= points[0][0]) return points[0][1];
      if (z >= points[points.length - 1][0]) return points[points.length - 1][1];
      let low = 0, high = points.length - 1;
      while (high - low > 1) { const middle = (low + high) >>> 1; if (points[middle][0] <= z) low = middle; else high = middle; }
      return lerp(points[low][1], points[high][1], clamp((z - points[low][0]) / Math.max(1e-9, points[high][0] - points[low][0]), 0, 1));
    }
    let interval = 0;
    while (interval < 7 && z > this.groundZ[interval + 1]) interval++;
    const t = clamp((z - this.groundZ[interval]) / (this.groundZ[interval + 1] - this.groundZ[interval]), 0, 1);
    return lerp(this.ground[interval], this.ground[interval + 1], t);
  }

  private sampleBase(distance: number, target: BeltSample): BeltSample {
    let remaining = ((distance % this.baseLength) + this.baseLength) % this.baseLength;
    for (let i = 0; i < this.segmentCount; i++) {
      const segment = this.segments[i];
      if (remaining > segment.length && i + 1 < this.segmentCount) { remaining -= segment.length; continue; }
      const angle = segment.angle + (segment.arc ? remaining / segment.radius : 0);
      target.angle = angle;
      target.z = segment.z + (segment.arc ? Math.sin(angle) * segment.radius : Math.cos(angle) * remaining);
      target.y = segment.y + (segment.arc ? Math.cos(angle) * segment.radius : -Math.sin(angle) * remaining);
      return target;
    }
    return target;
  }

  private deform(distance: number, target: BeltSample): void {
    let remaining = ((distance % this.baseLength) + this.baseLength) % this.baseLength;
    const front = this.circles[5], rear = this.circles[4], quarter = front.radius * Math.PI * .5;
    const left = this.knots[0], right = this.knots[this.knots.length - 1], span = right - left;
    if (remaining < quarter) {
      const angle = remaining / front.radius;
      target.z = front.z + Math.sin(angle) * front.radius; target.y = front.y + Math.cos(angle) * front.radius; return;
    }
    remaining -= quarter;
    if (remaining <= span) {
      target.z = right - remaining;
      let lo = 0, hi = this.knots.length - 1;
      while (hi - lo > 1) { const middle = (lo + hi) >>> 1; if (this.knots[middle] <= target.z) lo = middle; else hi = middle; }
      const t = clamp((target.z - this.knots[lo]) / (this.knots[hi] - this.knots[lo]), 0, 1);
      target.y = Math.min(this.ceiling(target.z), Math.max(this.groundHeight(target.z) + .029, lerp(this.curve[lo], this.curve[hi], t))); return;
    }
    remaining -= span;
    if (remaining < quarter) {
      const angle = Math.PI * 1.5 + remaining / rear.radius;
      target.z = rear.z + Math.sin(angle) * rear.radius; target.y = rear.y + Math.cos(angle) * rear.radius; return;
    }
    target.z = rear.z + remaining - quarter; target.y = rear.y + rear.radius;
  }

  private ceiling(z: number): number {
    let height = END_GEAR.y;
    for (const circle of this.circles) {
      const dz = z - circle.z;
      if (Math.abs(dz) < circle.radius) {
        height = Math.min(height, circle.y - Math.sqrt(Math.max(0, circle.radius ** 2 - dz ** 2)));
      }
    }
    return height;
  }

  /** Shortest string through a monotone corridor. Unlike vertical displacement
   * of the old flat run, this creates natural tangent ramps between contacts. */
  private solveLowerString(): void {
    const rear = this.circles[4], front = this.circles[5], left = rear.z - rear.radius, right = front.z + front.radius;
    const knots = this.knots; knots.length = 0;
    for (let i = 0; i <= 48; i++) knots.push(lerp(left, right, i / 48));
    for (const circle of this.circles) for (let i = 0; i <= 12; i++) knots.push(circle.z + circle.radius * Math.cos(i / 12 * Math.PI));
    for (const point of this.terrain) if (point[0] > left && point[0] < right) knots.push(point[0]);
    if (!this.terrain.length) for (const z of this.groundZ) if (z > left && z < right) knots.push(z);
    knots.sort((a, b) => a - b);
    let count = 0; for (let i = 0; i < knots.length; i++) if (!count || knots[i] - knots[count - 1] > 1e-7) knots[count++] = knots[i]; knots.length = count;
    for (let i = 0; i < count; i++) {
      this.upper[i] = this.ceiling(knots[i]);
      this.lower[i] = Math.min(this.upper[i], this.groundHeight(knots[i]) + .029);
    }
    this.lower[0] = this.upper[0] = rear.y; this.lower[count - 1] = this.upper[count - 1] = front.y;
    let anchor = 0, anchorY = rear.y;
    this.curve[0] = anchorY;
    while (anchor < count - 1) {
      let low = -Infinity, high = Infinity, lowIndex = anchor, highIndex = anchor, next = count - 1, nextY = front.y;
      for (let i = anchor + 1; i < count; i++) {
        const dx = knots[i] - knots[anchor], a = (this.lower[i] - anchorY) / dx, b = (this.upper[i] - anchorY) / dx;
        if (a > high + 1e-10) { next = highIndex; nextY = this.upper[next]; break; }
        if (b < low - 1e-10) { next = lowIndex; nextY = this.lower[next]; break; }
        if (a > low) { low = a; lowIndex = i; } if (b < high) { high = b; highIndex = i; }
      }
      if (next <= anchor) throw new Error('Invalid lower-belt contact corridor.');
      for (let i = anchor + 1; i <= next; i++) this.curve[i] = lerp(anchorY, nextY, (knots[i] - knots[anchor]) / (knots[next] - knots[anchor]));
      anchor = next; anchorY = nextY;
    }
    this.baseLength = front.radius * Math.PI + (right - left) + (front.z - rear.z);
  }

  private rebuild(): void {
    if (this.groundActive) { this.rebuildGround(); return; }
    this.next.fill(-1);
    // Common external tangents of six circles; reject any edge cutting another circle.
    // A clockwise walk moves the upper belt +Z and the ground-contact run -Z.
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
      if (i === j) continue;
      const a = this.circles[i], b = this.circles[j];
      const dz = b.z - a.z, dy = b.y - a.y, distance = Math.hypot(dz, dy);
      const along = (a.radius - b.radius) / distance;
      if (Math.abs(along) >= 1) continue;
      const perpendicular = Math.sqrt(1 - along * along);
      const nz = (dz * along - dy * perpendicular) / distance;
      const ny = (dy * along + dz * perpendicular) / distance;
      const az = a.z + nz * a.radius, ay = a.y + ny * a.radius;
      const bz = b.z + nz * b.radius, by = b.y + ny * b.radius;
      const lineLength = Math.hypot(bz - az, by - ay);
      let valid = true;
      for (let k = 0; k < 6; k++) {
        if (k === i || k === j) continue;
        const c = this.circles[k];
        const outside = (c.z - a.z) * nz + (c.y - a.y) * ny + c.radius - a.radius;
        if (outside > 1e-8) { valid = false; break; }
        if (Math.abs(outside) < 1e-8) {
          // Collinear supported wheels belong to one straight run, not several edges.
          const projection = ((c.z + nz * c.radius - az) * (bz - az) + (c.y + ny * c.radius - ay) * (by - ay)) / lineLength;
          if (projection < -1e-8 || projection > lineLength + 1e-8) { valid = false; break; }
        }
      }
      if (valid) { this.next[i] = j; this.normalZ[i] = nz; this.normalY[i] = ny; }
    }
    // The raised front gear always owns the top return tangent. Its top is a fixed
    // phase origin even when a road wheel enters/leaves the lower convex envelope.
    // Picking the first supported road wheel would teleport every link at that change.
    const start = 5;
    if (this.next[start] < 0) throw new Error('The fixed track phase origin is not on the belt envelope.');
    let previous = start;
    for (let i = 0; i < 6; i++) if (this.next[i] === start) previous = i;
    this.length = 0; this.segmentCount = 0;
    let current = start;
    do {
      const circle = this.circles[current], next = this.next[current];
      if (next < 0) throw new Error('The track belt envelope is not closed.');
      const begin = Math.atan2(this.normalZ[previous], this.normalY[previous]);
      const end = Math.atan2(this.normalZ[current], this.normalY[current]);
      const sweep = ((end - begin) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      const arc = this.segments[this.segmentCount++];
      arc.arc = true; arc.y = circle.y; arc.z = circle.z; arc.angle = begin;
      arc.radius = circle.radius; arc.length = sweep * circle.radius;
      this.length += arc.length;
      const destination = this.circles[next], nz = this.normalZ[current], ny = this.normalY[current];
      const z = circle.z + nz * circle.radius, y = circle.y + ny * circle.radius;
      const dz = destination.z + nz * destination.radius - z, dy = destination.y + ny * destination.radius - y;
      const line = this.segments[this.segmentCount++];
      line.arc = false; line.y = y; line.z = z; line.angle = Math.atan2(-dy, dz);
      line.radius = 0; line.length = Math.hypot(dz, dy);
      this.length += line.length;
      previous = current; current = next;
    } while (current !== start && this.segmentCount < 12);
    this.baseLength = this.length;
  }

  private rebuildGround(): void {
      this.solveLowerString();
      // Uniform Z samples undersample the nearly vertical end wraps. Their
      // arclength lookup made constant motor motion accelerate at each idler.
      // Preserve all terrain/string knots and sample circular ends in angle.
      const front = this.circles[5], quarter = front.radius * Math.PI * .5;
      const right = this.knots[this.knots.length - 1], span = right - this.knots[0], parameters = this.arcParameters;
      parameters.length = 0;
      for (let i = 0; i <= 16; i++) parameters.push(quarter * i / 16, quarter + span + quarter * i / 16);
      for (const z of this.knots) parameters.push(quarter + right - z);
      for (const circle of this.circles) for (let i = 0; i <= 64; i++) parameters.push(quarter + right - circle.z - circle.radius * Math.cos(i / 64 * Math.PI));
      parameters.push(this.baseLength); parameters.sort((a, b) => a - b);
      let count = 0; for (let i = 0; i < parameters.length; i++) if (!count || parameters[i] - parameters[count - 1] > 1e-10) parameters[count++] = parameters[i]; parameters.length = count;
      this.deform(0, this.sampled);
      let y = this.sampled.y, z = this.sampled.z;
      this.arcLengths[0] = 0;
      for (let i = 1; i < count; i++) {
        this.deform(parameters[i], this.sampled);
        this.arcLengths[i] = this.arcLengths[i - 1] + Math.hypot(this.sampled.y - y, this.sampled.z - z);
        y = this.sampled.y; z = this.sampled.z;
      }
      this.length = this.arcLengths[count - 1];
  }
}
