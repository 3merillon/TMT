import { describe, expect, it } from 'vitest';
import { airLowpassHz, distanceGain, Listener, LISTENER_FOCUS_BLEND, MAX_DISTANCE, REF_DISTANCE, spatialParams, type Vec3 } from '../src/audio/listener';

const R = 18;
const norm = (v: Vec3): Vec3 => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add = (a: Vec3, b: Vec3, k = 1): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];

/** A follow camera behind and above a tank at `up` on the sphere, looking along `heading` (tangent). */
function rigAt(upDir: Vec3, heading: Vec3) {
  const up = norm(upDir);
  const fwd = norm(add(heading, up, -(heading[0] * up[0] + heading[1] * up[1] + heading[2] * up[2])));
  const focus = add([0, 0, 0], up, R + 0.4);
  const cameraPos = add(add(focus, fwd, -6), up, 4);
  const listener = new Listener();
  expect(listener.update({ position: cameraPos, target: focus, up }, focus, 1 / 60)).toBe(true);
  const right = norm(cross(fwd, up));
  return { listener, up, fwd, right, focus, cameraPos };
}

// Six places over the sphere, including the poles and the "side" of the planet where flattening the camera forward onto
// world XZ (Pinionfall's screenAlignedPos) degenerates.
const PLACES: [string, Vec3, Vec3][] = [
  ['north pole', [0, 1, 0], [0, 0, -1]],
  ['south pole', [0, -1, 0], [1, 0, 0]],
  ['east equator, heading north', [1, 0, 0], [0, 1, 0]],
  ['west equator, heading south', [-1, 0, 0], [0, -1, 0]],
  ['front equator, heading up', [0, 0, 1], [0, 1, 0]],
  ['mid latitude', [0.4, 0.7, -0.6], [1, 0, 0]],
];

describe('listener placement', () => {
  it('sits at lerp(camera, focus, 0.65) with the camera basis', () => {
    const { listener, cameraPos, focus, fwd, up } = rigAt([0, 1, 0], [0, 0, -1]);
    for (let a = 0; a < 3; a++) expect(listener.position[a]).toBeCloseTo(cameraPos[a] + (focus[a] - cameraPos[a]) * LISTENER_FOCUS_BLEND, 9);
    const f = norm([focus[0] - cameraPos[0], focus[1] - cameraPos[1], focus[2] - cameraPos[2]]);
    for (let a = 0; a < 3; a++) expect(listener.forward[a]).toBeCloseTo(f[a], 9);
    // Orthonormal basis, up close to the radial.
    const dot = (p: Vec3, q: Vec3) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
    expect(dot(listener.right, listener.up)).toBeCloseTo(0, 9);
    expect(dot(listener.right, listener.forward)).toBeCloseTo(0, 9);
    expect(Math.hypot(...listener.up)).toBeCloseTo(1, 9);
    expect(dot(listener.up, up)).toBeGreaterThan(0.8);
    expect(dot(listener.right, cross(fwd, up))).toBeGreaterThan(0.99);
  });

  it('rejects non-finite cameras and keeps the previous pose', () => {
    const { listener } = rigAt([0, 1, 0], [0, 0, -1]);
    const before = [...listener.position];
    expect(listener.update({ position: [NaN, 0, 0], target: [0, 0, 0], up: [0, 1, 0] }, [0, 18, 0], 1 / 60)).toBe(false);
    expect([...listener.position]).toEqual(before);
  });

  it('smooths its velocity and resets it on a camera cut', () => {
    const l = new Listener();
    const cam = (x: number) => ({ position: [x, 22, 6] as Vec3, target: [x, 18, 0] as Vec3, up: [0, 1, 0] as Vec3 });
    for (let i = 0; i < 120; i++) l.update(cam(i * 0.05), [i * 0.05, 18.4, 0], 1 / 60);
    expect(l.velocity[0]).toBeCloseTo(3, 1);   // 0.05 u per 1/60 s
    l.update(cam(500), [500, 18.4, 0], 1 / 60);
    expect(Math.hypot(...l.velocity)).toBe(0);
  });
});

describe('sphere-correct panning', () => {
  for (const [name, up, heading] of PLACES) {
    it(`pans by the camera's right at the ${name}`, () => {
      const { listener, right } = rigAt(up, heading);
      const s = spatialParams();
      const base = listener.position;
      const rightSrc = add(base, right, 4), leftSrc = add(base, right, -4), frontSrc = add(base, listener.forward, 6);
      expect(listener.spatialize(rightSrc, s).pan).toBeGreaterThan(0.8);
      expect(listener.spatialize(leftSrc, s).pan).toBeLessThan(-0.8);
      expect(Math.abs(listener.spatialize(frontSrc, s).pan)).toBeLessThan(0.05);
      expect(s.local[2]).toBeLessThan(-5.9);                 // in front: listener-local z is −forward
    });

    it(`does not pan a source on the far side of the planet as if it were in front (${name})`, () => {
      const { listener, up: n } = rigAt(up, heading);
      const s = spatialParams();
      const antipode = add([0, 0, 0], n, -(R + 0.4)) as Vec3;
      listener.spatialize(antipode, s);
      expect(Math.abs(s.pan)).toBeLessThan(0.1);
      // It is below the listener, through the planet (the camera looks down at the tank, so it is also somewhat ahead).
      expect(s.local[1]).toBeLessThan(-25);
      expect(-s.local[1]).toBeGreaterThan(Math.abs(s.local[2]));
      expect(s.occlusion).toBe(1);
      expect(s.path).toBeGreaterThan(Math.PI * R * 0.9);      // the sound goes around, not through
      expect(s.lowpass).toBeLessThan(1500);
      // Quieter than a source at the same straight-line distance with a clear line of sight.
      const clear = spatialParams();
      listener.spatialize(add(listener.position, n, s.distance), clear);
      expect(clear.occlusion).toBe(0);
      expect(s.gain).toBeLessThan(clear.gain * 0.5);
    });
  }

  it('keeps sources lying on the terrain nearby unoccluded', () => {
    const { listener, fwd, up, focus } = rigAt([0, 1, 0], [0, 0, -1]);
    const s = spatialParams();
    for (const d of [1, 3, 6]) {
      const onGround = add(add(focus, fwd, d), up, -0.4);
      expect(listener.spatialize(onGround, s).occlusion).toBeLessThan(0.05);
    }
  });

  it('darkens sources behind the listener slightly', () => {
    const { listener, fwd } = rigAt([0, 1, 0], [0, 0, -1]);
    const front = spatialParams(), back = spatialParams();
    listener.spatialize(add(listener.position, fwd, 5), front);
    listener.spatialize(add(listener.position, fwd, -5), back);
    expect(back.lowpass).toBeLessThan(front.lowpass);
    expect(back.gain).toBeCloseTo(front.gain, 9);
  });

  it('gives a silent, finite result for non-finite sources', () => {
    const { listener } = rigAt([0, 1, 0], [0, 0, -1]);
    const s = listener.spatialize([NaN, 1, 2], spatialParams());
    expect(s.gain).toBe(0);
    expect(Number.isFinite(s.pan) && Number.isFinite(s.lowpass)).toBe(true);
  });
});

describe('distance attenuation', () => {
  it('uses the inverse model with refDistance 2 and maxDistance 40', () => {
    expect(REF_DISTANCE).toBe(2);
    expect(MAX_DISTANCE).toBe(40);
    expect(distanceGain(0)).toBe(1);
    expect(distanceGain(2)).toBe(1);
    expect(distanceGain(4)).toBeCloseTo(0.5, 12);
    expect(distanceGain(40)).toBeCloseTo(2 / 40, 12);
    expect(distanceGain(400)).toBe(distanceGain(40));
    expect(distanceGain(NaN)).toBe(0);
    let prev = Infinity;
    for (let d = 0; d <= 50; d += 0.5) { const g = distanceGain(d); expect(g).toBeLessThanOrEqual(prev); prev = g; }
  });

  it('applies the air low-pass 18 kHz · e^(−d/25), clamped', () => {
    expect(airLowpassHz(0)).toBe(18000);
    expect(airLowpassHz(25)).toBeCloseTo(18000 / Math.E, 6);
    expect(airLowpassHz(200)).toBe(1200);
    let prev = Infinity;
    for (let d = 0; d <= 80; d += 1) { const f = airLowpassHz(d); expect(f).toBeLessThanOrEqual(prev); prev = f; }
  });

  it('attenuates spatialised sources monotonically with distance (clear line of sight)', () => {
    const { listener, fwd, up } = rigAt([0, 1, 0], [0, 0, -1]);
    const s = spatialParams();
    let prevGain = Infinity, prevLp = Infinity;
    for (let d = 1; d <= 30; d += 1) {
      // Rise with the distance so the chord stays above the curved surface.
      listener.spatialize(add(add(listener.position, fwd, d), up, d * 0.4), s);
      expect(s.occlusion).toBe(0);
      expect(s.gain).toBeLessThanOrEqual(prevGain);
      expect(s.lowpass).toBeLessThanOrEqual(prevLp);
      prevGain = s.gain; prevLp = s.lowpass;
    }
  });
});
