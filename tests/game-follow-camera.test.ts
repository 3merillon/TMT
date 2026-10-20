import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { CameraPose } from '../src/game/presentation/camera-pose';
import type { SimInterpolation, TankPose } from '../src/game/api/extensions';
import type { GameSnapshot, Q4, TankState, V3 } from '../src/game/contracts';
import { lerpAngle, renderedPose } from '../src/game/presentation/tank-view';
import { TankFollowCamera } from '../src/game/view';

function pose(angle: number) {
  const radial = new Vector3(Math.sin(angle), Math.cos(angle), 0);
  const rotation = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), radial);
  return { position: radial.multiplyScalar(18.6).toArray() as V3, rotation: rotation.toArray() as Q4 };
}

describe('planet-local tank follow camera', () => {
  it('tracks a tank around the planet and keeps a finite radial up without orbit reconstruction', () => {
    const camera = new CameraPose();
    const follow = new TankFollowCamera(camera);
    const target: V3 = [0, 0, 0];
    follow.update(pose(0), target, 0, true);
    for (let step = 1; step <= 1200; step++) {
      const tank = pose(step / 1200 * Math.PI * 1.5);
      follow.update(tank, target, 1 / 60);
      const radial = new Vector3(...tank.position).normalize();
      expect(new Vector3(...camera.up).dot(radial)).toBeGreaterThan(.999);
      expect(new Vector3(...camera.position).length()).toBeGreaterThan(18.6);
      expect(new Vector3(...target).distanceTo(new Vector3(...tank.position))).toBeLessThan(3);
      expect(new Vector3(-camera.worldMatrix[8], -camera.worldMatrix[9], -camera.worldMatrix[10]).dot(new Vector3(...target).sub(new Vector3(...camera.position)).normalize())).toBeGreaterThan(.9999);
    }
    expect(camera.position[0]).toBeLessThan(-20);
  });

  it('uses time-based smoothing rather than a frame-dependent catch-up factor', () => {
    const cameras = [new CameraPose(), new CameraPose()];
    const follows = cameras.map(camera => new TankFollowCamera(camera));
    const targets: V3[] = [[0, 0, 0], [0, 0, 0]];
    follows.forEach((follow, i) => follow.update(pose(0), targets[i], 0, true));
    follows.forEach(follow => follow.zoom(400));
    follows.forEach((follow, i) => {
      const fps = i === 0 ? 30 : 120;
      for (let frame = 0; frame < fps; frame++) follow.update(pose(.5), targets[i], 1 / fps);
    });
    expect(new Vector3(...cameras[0].position).distanceTo(new Vector3(...cameras[1].position))).toBeLessThan(1e-10);
    expect(new Vector3(...targets[0]).distanceTo(new Vector3(...targets[1]))).toBeLessThan(1e-10);
    expect(new Vector3(...cameras[0].position).distanceTo(new Vector3(...targets[0]))).toBeGreaterThan(17);
    expect(new Vector3(...cameras[0].position).distanceTo(new Vector3(...targets[0]))).toBeLessThan(follows[0].distance);
  });

  it('bounds scroll zoom and snaps cleanly when changing the observed tank', () => {
    const camera = new CameraPose();
    const follow = new TankFollowCamera(camera);
    const target: V3 = [0, 0, 0];
    for (let i = 0; i < 20; i++) follow.zoom(-400);
    expect(follow.distance).toBe(6);
    for (let i = 0; i < 20; i++) follow.zoom(400);
    expect(follow.distance).toBe(36);
    follow.update(pose(Math.PI), target, 0, true);
    expect(camera.up[1]).toBeCloseTo(-1);
    expect(new Vector3(...camera.position).distanceTo(new Vector3(...target))).toBeCloseTo(36);
    expect(camera.position[1]).toBeLessThan(-18.6);
  });
});

describe('follow camera outputs for presenters (W1-ENG-SCENE)', () => {
  it('exposes the focus, the effective boom and the altitude', () => {
    const camera = new CameraPose();
    const follow = new TankFollowCamera(camera);
    const target: V3 = [0, 0, 0];
    follow.update(pose(0), target, 0, true);
    expect(new Vector3(...follow.focus).distanceTo(new Vector3(...target))).toBeLessThan(1e-12);
    expect(follow.effectiveDistance).toBeCloseTo(17);
    expect(new Vector3(...camera.position).distanceTo(new Vector3(...target))).toBeCloseTo(follow.effectiveDistance);
    expect(follow.altitude).toBeCloseTo(17 * .55, 6); // sin(elevation) = .55 above the focus
    expect(follow.elevationAngle).toBeCloseTo(Math.asin(.55));
  });

  it('applies camera constraints in order after collision and re-aims at the target', () => {
    const camera = new CameraPose();
    const follow = new TankFollowCamera(camera);
    const target: V3 = [0, 0, 0];
    const calls: string[] = [];
    const lift = (p: V3): V3 => { calls.push('lift'); return [p[0], p[1] + 2, p[2]]; };
    const clamp = (p: V3, t: V3): V3 => { calls.push('clamp'); const d = new Vector3(...p).sub(new Vector3(...t)); return d.length() > 10 ? new Vector3(...t).addScaledVector(d.normalize(), 10).toArray() as V3 : p; };
    follow.update(pose(0), target, 1 / 60, true, undefined, [lift, clamp]);
    expect(calls).toEqual(['lift', 'clamp']);
    expect(new Vector3(...camera.position).distanceTo(new Vector3(...target))).toBeCloseTo(10, 6);
    expect(new Vector3(-camera.worldMatrix[8], -camera.worldMatrix[9], -camera.worldMatrix[10]).dot(new Vector3(...target).sub(new Vector3(...camera.position)).normalize())).toBeGreaterThan(.9999);
    expect(() => follow.update(pose(0), target, 1 / 60, false, undefined, [() => [Number.NaN, 0, 0]])).toThrow(/invalid position/);
  });

  it('trauma shakes the view by at most the configured amount and decays to rest', () => {
    const still = new CameraPose(), shaken = new CameraPose();
    const a = new TankFollowCamera(still), b = new TankFollowCamera(shaken);
    const ta: V3 = [0, 0, 0], tb: V3 = [0, 0, 0];
    a.update(pose(0), ta, 0, true); b.update(pose(0), tb, 0, true);
    b.addTrauma(1); b.addTrauma(5);
    expect(b.trauma).toBe(1);
    let moved = 0;
    for (let i = 0; i < 90; i++) {
      a.update(pose(0), ta, 1 / 60); b.update(pose(0), tb, 1 / 60);
      moved = Math.max(moved, new Vector3(...still.position).distanceTo(new Vector3(...shaken.position)));
      expect(new Vector3(...still.position).distanceTo(new Vector3(...shaken.position))).toBeLessThanOrEqual(.12 * Math.SQRT2 + 1e-9);
    }
    expect(moved).toBeGreaterThan(1e-3);
    expect(b.trauma).toBe(0);
    a.update(pose(0), ta, 1 / 60); b.update(pose(0), tb, 1 / 60);
    expect(new Vector3(...still.position).distanceTo(new Vector3(...shaken.position))).toBeLessThan(1e-9);
    expect(new Vector3(...ta).distanceTo(new Vector3(...tb))).toBeLessThan(1e-12);
  });
});

describe('rendered pose shared by the tank, its follow camera and its label (W1-ENG-SCENE)', () => {
  const tankPose = (turretYaw: number, x: number): TankPose => ({ position: [x, 18.6, 0], rotation: [0, 0, 0, 1], turretYaw, barrelPitch: .1 });
  const snapshot = (tank: TankState) => ({ tanks: [tank] }) as unknown as GameSnapshot;
  const tank = { id: 0, position: [0, 18.6, 0], rotation: [0, 0, 0, 1], turretYaw: 0, barrelPitch: 0 } as unknown as TankState;

  it('uses the snapshot pose without interpolation', () => {
    const pose = renderedPose(snapshot(tank), tank);
    expect(pose.position).toEqual([0, 18.6, 0]);
    expect(pose.turretYaw).toBe(0);
  });

  it('blends position linearly and turret yaw along the shorter arc across ±π', () => {
    const state = snapshot(tank);
    const interp: SimInterpolation = { alpha: .5, prev: [tankPose(Math.PI - .1, 0)], curr: [tankPose(-Math.PI + .1, 2)] };
    const pose = renderedPose(state, tank, interp);
    expect(pose.position[0]).toBeCloseTo(1, 12);
    // Half way through the seam, not back through zero.
    expect(Math.abs(Math.atan2(Math.sin(pose.turretYaw), Math.cos(pose.turretYaw)))).toBeCloseTo(Math.PI, 9);
    expect(renderedPose(state, tank, { ...interp, alpha: 1 }).turretYaw).toBe(-Math.PI + .1);
    expect(renderedPose(state, tank, { ...interp, alpha: 0 }).turretYaw).toBeCloseTo(Math.PI - .1, 12);
    expect(lerpAngle(.2, .6, .25)).toBeCloseTo(.3, 12);
  });
});
