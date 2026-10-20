import { describe, expect, it } from 'vitest';
import { GLOBE_RADIUS, TAU, cameraPose, depthOpacity, globeScreenRadius, inverseView, orbitPoint, project, projectedPath, rotateView, spherePoint, surfaceRing, tagReveal } from '../src/game/ui/screens/title-art-math';

describe('title tactical projection', () => {
  it('fades continuously across the near/far boundary while retaining front and rear brightness', () => {
    for (const radius of [GLOBE_RADIUS, 218, 270, 298]) for (const rearOpacity of [.45, .55]) {
      expect(depthOpacity(-radius, radius, rearOpacity)).toBe(rearOpacity);
      expect(depthOpacity(radius, radius, rearOpacity)).toBe(1);
      expect(depthOpacity(-.001, radius, rearOpacity)).toBeCloseTo(depthOpacity(.001, radius, rearOpacity), 4);
      const samples = Array.from({ length: 101 }, (_, i) => depthOpacity((i / 50 - 1) * radius, radius, rearOpacity));
      expect(samples).toEqual([...samples].sort((a, b) => a - b));
      expect(samples.every(opacity => opacity >= rearOpacity && opacity <= 1)).toBe(true);
      expect(samples.filter(opacity => opacity > rearOpacity && opacity < 1).length).toBeGreaterThan(10);
    }
  });
  it('keeps projectile brightness smooth during front and rear crossings with the moving camera', () => {
    const orbits = [
      { radius: 270, tilt: 1.18, bank: -.42, phase: .56, seconds: 24 },
      { radius: 298, tilt: .91, bank: .32, phase: 3.77, seconds: 38 },
      { radius: 218, tilt: .72, bank: -1.03, phase: 5.13, seconds: 31 },
    ];
    for (const orbit of orbits) {
      let previousDepth = 0, previousOpacity = 0, maxStep = 0, frontCrossings = 0, rearCrossings = 0;
      for (let frame = 0; frame < 180 * 30; frame++) {
        const t = frame / 30, camera = cameraPose(t);
        const point = rotateView(orbitPoint(orbit.radius, orbit.tilt, orbit.bank, orbit.phase + t / orbit.seconds * TAU), camera.yaw, camera.pitch, camera.roll);
        // Match SVG serialization so quantization cannot hide a boundary jump.
        const opacity = Number(depthOpacity(point.z, orbit.radius, .45).toFixed(4));
        if (frame) {
          maxStep = Math.max(maxStep, Math.abs(opacity - previousOpacity));
          if (previousDepth < 0 && point.z >= 0) frontCrossings++;
          if (previousDepth >= 0 && point.z < 0) rearCrossings++;
        }
        previousDepth = point.z; previousOpacity = opacity;
      }
      expect(maxStep).toBeLessThan(.025);
      expect(frontCrossings).toBeGreaterThan(0);
      expect(rearCrossings).toBeGreaterThan(0);
    }
  });
  it('extends a leader before revealing text, and retracts it before fading text', () => {
    expect(tagReveal(1.35, 1, 7).line).toBeGreaterThan(0);
    expect(tagReveal(1.35, 1, 7).text).toBe(0);
    expect(tagReveal(7.35, 1, 7).line).toBeLessThan(1);
    expect(tagReveal(7.35, 1, 7).text).toBe(1);
    expect(tagReveal(7.8, 1, 7).line).toBe(0);
    expect(tagReveal(7.8, 1, 7).text).toBeGreaterThan(0);
  });
  it('flies closer, further away and around the globe with continuous camera motion', () => {
    const radii: number[] = [];
    for (let t = 0; t < 180; t += .5) {
      const a = cameraPose(t), b = cameraPose(t + 1 / 30);
      radii.push(globeScreenRadius(a.distance));
      expect(Math.abs(globeScreenRadius(b.distance) - globeScreenRadius(a.distance))).toBeLessThan(.16);
      expect(Math.abs(a.roll - b.roll)).toBeLessThan(.001);
      expect(a.distance).toBeGreaterThan(600);
    }
    expect(Math.max(...radii) / Math.min(...radii)).toBeGreaterThan(1.8);
    expect(cameraPose(30).pitch - cameraPose(0).pitch).toBeGreaterThan(.5);
  });
  it('enlarges approaching missiles and preserves radius as the camera moves', () => {
    expect(project({ x: 30, y: 20, z: 200 }).scale).toBeGreaterThan(project({ x: 30, y: 20, z: -200 }).scale);
    for (let a = 0; a < 7; a += .2) {
      const p = rotateView(orbitPoint(270, 1.18, -.42, a), .24, -.17);
      expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(270, 8);
    }
    const p = spherePoint(.3, .4), q = inverseView(rotateView(p, .8, -.3, .2), .8, -.3, .2);
    expect(q.x).toBeCloseTo(p.x, 8); expect(q.y).toBeCloseTo(p.y, 8); expect(q.z).toBeCloseTo(p.z, 8);
  });

  it('projects target rings onto the sphere, including the poles', () => {
    for (const normal of [spherePoint(.3, .4), { x: 0, y: GLOBE_RADIUS, z: 0 }]) {
      for (const point of surfaceRing(normal, .2)) {
        expect(Math.hypot(point.x, point.y, point.z)).toBeCloseTo(GLOBE_RADIUS, 8);
        const dot = (normal.x * point.x + normal.y * point.y + normal.z * point.z) / GLOBE_RADIUS ** 2;
        expect(dot).toBeCloseTo(Math.cos(.2), 8);
      }
    }
  });

  it('keeps a complete impact ring inside the projected globe at every camera distance and on either face', () => {
    for (const distance of [620, 900, 1180]) for (const longitude of [0, 1.3, 2, Math.PI]) {
      const points = surfaceRing(spherePoint(.2, longitude), .44);
      expect(projectedPath(points, () => true, distance).match(/L/g)).toHaveLength(64);
      for (const point of points) {
        const p = project(point, distance);
        expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(globeScreenRadius(distance) + .00001);
      }
    }
  });

  it('joins front and rear tracks at the same depth boundary without drawing across a hidden interval', () => {
    const points = [{ x: 10, y: 0, z: -10 }, { x: 20, y: 0, z: 10 }];
    expect(projectedPath(points, p => p.z >= 0)).toMatch(/^M15\.00,0\.00L/);
    expect(projectedPath(points, p => p.z < 0)).toMatch(/L15\.00,0\.00$/);
    const split = projectedPath([...points, { x: 30, y: 0, z: -10 }, { x: 40, y: 0, z: 10 }], p => p.z >= 0);
    expect(split.match(/M/g)).toHaveLength(2);
  });
});
