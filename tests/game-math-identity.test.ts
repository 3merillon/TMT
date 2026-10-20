/** The scalar math.ts must reproduce the historical three.js r180 temporaries bit for bit: every simulation result,
 * snapshot hash and replay depends on these last bits. The previous implementations are kept here as oracles. */
import { describe, expect, it } from 'vitest';
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Q4, V3 } from '../src/game/contracts';
import * as math from '../src/game/math';

const oracle = (() => {
  const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const length = (a: V3): number => Math.hypot(...a);
  const distance = (a: V3, b: V3): number => length(sub(a, b));
  const normalize = (a: V3, fallback: V3 = [0, 1, 0]): V3 => length(a) > 1e-10 ? mul(a, 1 / length(a)) : [...fallback];
  const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
  const tangent = (v: V3, up: V3): V3 => sub(v, mul(up, dot(v, up)));
  function frame(up: V3, heading: number) {
    up = normalize(up);
    const reference: V3 = Math.abs(up[2]) < 0.96 ? [0, 0, 1] : [1, 0, 0];
    const base = normalize(tangent(reference, up));
    const right = normalize(cross(up, base));
    const forward = add(mul(base, Math.cos(heading)), mul(right, Math.sin(heading)));
    return { right: normalize(cross(up, forward)), up, forward };
  }
  const rotation = (up: V3, heading: number): Q4 => {
    const axes = frame(up, heading);
    return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(new Vector3(...axes.right), new Vector3(...axes.up), new Vector3(...axes.forward))).toArray() as Q4;
  };
  const interpolateRotation = (from: Q4, to: Q4, fraction: number): Q4 => new Quaternion(...from).slerp(new Quaternion(...to), fraction).toArray() as Q4;
  const rotate = (v: V3, q: Q4): V3 => new Vector3(...v).applyQuaternion(new Quaternion(...q)).toArray() as V3;
  function holdPlanetBearing(before: { position: V3; rotation: Q4 }, after: { position: V3; rotation: Q4 }, yaw: number): number {
    const oldUp = new Vector3(...before.position).normalize(), newUp = new Vector3(...after.position).normalize();
    const aim = new Vector3(Math.sin(yaw), 0, Math.cos(yaw)).applyQuaternion(new Quaternion(...before.rotation));
    aim.applyQuaternion(new Quaternion().setFromUnitVectors(oldUp, newUp));
    aim.applyQuaternion(new Quaternion(...after.rotation).invert());
    return Math.atan2(aim.x, aim.z);
  }
  function segmentSphere(origin: V3, direction: V3, extent: number, center: V3, radius: number): number | null {
    const offset = sub(origin, center), b = dot(offset, direction), c = dot(offset, offset) - radius * radius;
    if (c <= 0) return 0;
    const discriminant = b * b - c;
    if (discriminant < 0) return null;
    const at = -b - Math.sqrt(discriminant);
    return at >= 0 && at <= extent ? at : null;
  }
  function segmentDistance(point: V3, a: V3, b: V3): number {
    const delta = sub(b, a), t = clamp(dot(sub(point, a), delta) / Math.max(1e-10, dot(delta, delta)), 0, 1);
    return distance(point, add(a, mul(delta, t)));
  }
  return { length, distance, normalize, tangent, frame, rotation, interpolateRotation, rotate, holdPlanetBearing, segmentSphere, segmentDistance };
})();

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rng = random(0x5eed);
const SPECIAL = [0, -0, 1, -1, 1e-11, -1e-11, 1e-10, 5e-324, 1e300, 0.5, Math.fround(0.1)];
/** Mixed magnitudes, signs, exact zeros and float32-rounded values (Rapier poses are f32). */
function scalar(): number {
  const pick = rng();
  if (pick < 0.08) return SPECIAL[Math.floor(rng() * SPECIAL.length)];
  const value = (rng() * 2 - 1) * 10 ** (rng() * 8 - 4);
  return pick < 0.4 ? Math.fround(value) : value;
}
const vector = (): V3 => [scalar(), scalar(), scalar()];
function quaternion(): Q4 {
  const q = [rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1], l = Math.hypot(...q);
  const unit = q.map(v => v / l) as Q4;
  const pick = rng();
  return pick < 0.4 ? unit.map(Math.fround) as Q4 : pick < 0.5 ? [0, 0, 0, 1] : pick < 0.55 ? [0, 0, 0, -1] : pick < 0.6 ? q as Q4 : unit;
}
/** Object.is per element: -0 and NaN must match too. */
function same(actual: unknown, expected: unknown): boolean {
  if (typeof expected === 'number') return Object.is(actual, expected);
  if (expected === null || actual === null) return actual === expected;
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => same(actual[i], v));
  if (typeof expected === 'object') return typeof actual === 'object' && Object.keys(expected as object).every(key => same((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key]));
  return actual === expected;
}
function check<A extends unknown[]>(name: string, input: () => A, actual: (...args: A) => unknown, expected: (...args: A) => unknown, count = 20000): void {
  for (let i = 0; i < count; i++) {
    const args = input(), want = expected(...args), got = actual(...args);
    if (!same(got, want)) expect.fail(`${name}(${JSON.stringify(args)}) = ${JSON.stringify(got)}, historically ${JSON.stringify(want)}`);
  }
}

describe('math.ts reproduces the three.js r180 arithmetic bit for bit', () => {
  it('quaternion products and shortest-arc transport, including antiparallel choices', () => {
    check('multiplyRotations', () => [quaternion(), quaternion()] as [Q4, Q4], math.multiplyRotations,
      (a, b) => new Quaternion(...a).multiply(new Quaternion(...b)).toArray());
    check('rotationBetweenUnitVectors', () => {
      const from = math.normalize(vector()), pick = rng();
      const to = pick < .25 ? from.map(v => -v) as V3 : pick < .5 ? [...from] as V3 : math.normalize(vector());
      return [from, to] as [V3, V3];
    }, math.rotationBetweenUnitVectors, (a, b) => new Quaternion().setFromUnitVectors(new Vector3(...a), new Vector3(...b)).toArray());
  });

  it('composes, extracts and decomposes signed-scale transforms without rounding intermediates', () => {
    const scales: V3[] = [[1, 1, 1], [-1, 2, 3], [1, -2, 3], [1, 2, -3], [-1, -2, -3], [0, 1, 1], [1, 0, 1], [1, 1, 0]];
    for (let i = 0; i < 2000; i++) {
      const position = vector(), rotation = i < 4 ? [[0, 0, 0, 1], [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]][i] as Q4 : quaternion(), scale = scales[i % scales.length];
      const matrix = new Matrix4().compose(new Vector3(...position), new Quaternion(...rotation), new Vector3(...scale));
      const actual = new Float64Array(16);
      math.composeTransform(actual, position, rotation, scale);
      expect(same(Array.from(actual), matrix.elements), `compose ${i}`).toBe(true);
      const actual32 = new Float32Array(16);
      math.composeTransform(actual32, position, rotation, scale);
      expect(same(Array.from(actual32), Array.from(Float32Array.from(matrix.elements))), `compose f32 ${i}`).toBe(true);
      expect(same(math.rotationFromMatrix(actual), new Quaternion().setFromRotationMatrix(matrix).toArray()), `extract ${i}`).toBe(true);
      for (const input of [actual, Float32Array.from(actual)]) {
        const pos = new Vector3(), rot = new Quaternion(), size = new Vector3();
        new Matrix4().fromArray(input).decompose(pos, rot, size);
        expect(same(math.decomposeTransform(input), { position: pos.toArray(), rotation: rot.toArray(), scale: size.toArray() }), `decompose ${i}`).toBe(true);
      }
    }
  });

  it('transforms detached points and normals with the original homogeneous and normalization arithmetic', () => {
    for (let i = 0; i < 2000; i++) {
      const matrix = new Matrix4().compose(new Vector3(...vector()), new Quaternion(...quaternion()), new Vector3(...vector()));
      if (i % 2) { matrix.elements[3] = .1; matrix.elements[7] = -.2; matrix.elements[11] = .3; }
      const point = vector();
      expect(same(math.transformPoint(matrix.elements, point), new Vector3(...point).applyMatrix4(matrix).toArray()), `point ${i}`).toBe(true);
      expect(same(math.transformDirection(matrix.elements, point), new Vector3(...point).transformDirection(matrix).toArray()), `direction ${i}`).toBe(true);
    }
  });

  it('length, distance, normalize and tangent', () => {
    check('length', () => [vector()] as [V3], math.length, oracle.length);
    check('distance', () => [vector(), vector()] as [V3, V3], math.distance, oracle.distance);
    check('normalize', () => [vector()] as [V3], v => math.normalize(v), v => oracle.normalize(v));
    check('normalize fallback', () => [rng() < .5 ? vector() : [1e-12, 0, -0] as V3, vector()] as [V3, V3], math.normalize, oracle.normalize);
    check('tangent', () => [vector(), math.normalize(vector())] as [V3, V3], math.tangent, oracle.tangent);
  });
  it('rotate, rotation, frame and slerp', () => {
    check('rotate', () => [vector(), quaternion()] as [V3, Q4], math.rotate, oracle.rotate, 50000);
    check('frame', () => [vector(), (rng() * 2 - 1) * 7] as [V3, number], math.frame, oracle.frame);
    check('rotation', () => [rng() < .1 ? [0, 0, rng() < .5 ? 1 : -1] as V3 : vector(), (rng() * 2 - 1) * 7] as [V3, number], math.rotation, oracle.rotation);
    check('interpolateRotation', () => {
      const from = quaternion(), pick = rng(), to = pick < .2 ? [...from] as Q4 : pick < .3 ? from.map(v => -v) as Q4 : pick < .4 ? from.map(v => v + 1e-9) as Q4 : quaternion();
      return [from, to, [0, 1, rng(), rng() * 2 - .5][Math.floor(rng() * 4)]] as [Q4, Q4, number];
    }, math.interpolateRotation, oracle.interpolateRotation);
  });
  it('holdPlanetBearing, including antiparallel and degenerate up vectors', () => {
    check('holdPlanetBearing', () => {
      const position = vector(), pick = rng();
      const after = pick < .1 ? position.map(v => -v) as V3 : pick < .2 ? [...position] as V3 : pick < .25 ? [0, 0, 0] as V3 : vector();
      return [{ position, rotation: quaternion() }, { position: after, rotation: quaternion() }, (rng() * 2 - 1) * 7] as [{ position: V3; rotation: Q4 }, { position: V3; rotation: Q4 }, number];
    }, math.holdPlanetBearing, oracle.holdPlanetBearing);
  });
  it('segmentSphere and segmentDistance', () => {
    check('segmentSphere', () => [vector(), math.normalize(vector()), rng() * 20, vector(), rng() * 5] as [V3, V3, number, V3, number], math.segmentSphere, oracle.segmentSphere);
    check('segmentDistance', () => { const a = vector(); return [vector(), a, rng() < .1 ? [...a] as V3 : vector()] as [V3, V3, V3]; }, math.segmentDistance, oracle.segmentDistance);
  });
});
