import { describe, expect, it } from 'vitest';
import type { V3 } from '../src/game/contracts';
import { TrajectoryPreview, trajectoryPreviewAllowed, trajectoryPreviewKeys } from '../src/game/presentation/trajectory-preview';
import { GameSimulation, FIXED_DT } from '../src/game/simulation';
import { practiceSetup } from '../src/game/api/match';
import { SphereWorld } from './helpers/sphere-world';
import { renderedPose, composeTRS, transformPoint } from '../src/game/presentation/tank-view';
import { assembleKit, tankKit } from '../src/game/kit';
import { kitTrunnionPivot } from '../src/game/kit/assembly';
import { add, mul, normalize, rotate } from '../src/game/math';

const short = (x: number): V3[] => [[x, 20, 0], [x + 1, 21, 0], [x + 2, 21, 0], [x + 3, 20, 0]];
const full = (x: number): V3[] => [[x, 20, 0], [1 + x, 21, 0], [3 + x * .5, 21, 0], [6, 18, 0]];
const expectPoint = (actual: readonly number[], expected: readonly number[]) => actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 10));

describe('trajectory presentation while driving', () => {
  it('keeps the next-shot arc through free-drive flight and terrain resolution without revealing turn-mode previews', () => {
    for (const phase of ['aim', 'resolving', 'terrain'] as const) {
      expect(trajectoryPreviewAllowed({ phase, active: 0 }, 0, true)).toBe(true);
      expect(trajectoryPreviewAllowed({ phase, active: 0 }, 0, false)).toBe(phase === 'aim');
      expect(trajectoryPreviewAllowed({ phase, active: 0 }, 1, false)).toBe(false);
    }
    expect(trajectoryPreviewAllowed({ phase: 'finished', active: 0 }, 0, true)).toBe(false);
  });

  it('continues authoritative predictions after a real shot and replaces the endpoint after a crater commit', () => {
    const world = new SphereWorld(), simulation = new GameSimulation(world,
      practiceSetup({ seed: 7, mode: 'drive', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } }));
    const before = simulation.previewPrediction(0, true), preview = new TrajectoryPreview();
    expect(before.hit).toBe(true); expect(simulation.fire(0)).toBe(true);
    expect(simulation.state.phase).toBe('resolving');
    for (let frame = 0; frame < 12; frame++) {
      const hash = simulation.matchHash(), state = simulation.state, tank = state.tanks[0];
      const prediction = trajectoryPreviewAllowed(state, 0, true) ? simulation.previewPrediction(0, true) : { points: [], hit: false };
      const keys = trajectoryPreviewKeys(state, tank, 0, world.version, true);
      preview.set(prediction.points, state.tick, keys.identity);
      expect(preview.render(.5, simulation.muzzle(0).position).length).toBeGreaterThan(8);
      expect(simulation.matchHash()).toBe(hash);
      simulation.step(FIXED_DT, { throttle: 0, steer: 0 });
    }
    world.crater = { center: [...before.points.at(-1)!], radius: 2 }; world.version++;
    const after = simulation.previewPrediction(0, true);
    expect(after.hit).toBe(true);
    expect(Math.hypot(...after.points.at(-1)!.map((value, i) => value - before.points.at(-1)![i]))).toBeGreaterThan(.5);
    expect(trajectoryPreviewAllowed(simulation.state, 0, true)).toBe(true);
  });

  it('continues interpolation across real simulation driving ticks that automatically counter-rotate the turret', () => {
    const world = new SphereWorld(), simulation = new GameSimulation(world,
      practiceSetup({ seed: 7, mode: 'drive', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } }));
    const preview = new TrajectoryPreview(), tank = simulation.state.tanks[0];
    const initialKeys = trajectoryPreviewKeys(simulation.state, tank, 0, world.version, false);
    preview.set(simulation.preview(0, false), simulation.state.tick, initialKeys.identity, false);
    let lastYaw = tank.turretYaw, lastRefresh = initialKeys.refresh, compensatedTicks = 0;
    for (let i = 0; i < 20; i++) {
      simulation.step(FIXED_DT, { throttle: .6, steer: .5 });
      // Moving supports advance collision-query revisions without changing the static terrain epoch.
      const keys = trajectoryPreviewKeys(simulation.state, tank, 0, world.version, false, i + 1);
      if (Math.abs(tank.turretYaw - lastYaw) > 1e-6) compensatedTicks++;
      expect(keys.identity).toBe(initialKeys.identity);
      expect(keys.refresh).not.toBe(lastRefresh);
      const points = simulation.preview(0, false), before = structuredClone(points), hash = simulation.matchHash();
      preview.set(points, simulation.state.tick, keys.identity, false);
      expect(preview.stats().interpolating).toBe(true);
      const interpolation = simulation.interpolation();
      let firstInterior: V3 | undefined;
      for (const alpha of [0, .5]) {
        const pose = renderedPose(simulation.state, tank, { ...interpolation, alpha });
        const kit = assembleKit(tankKit(tank)), trunnion = kitTrunnionPivot(kit);
        const up = rotate([0, 1, 0], pose.rotation), forward = rotate([Math.sin(pose.turretYaw), 0, Math.cos(pose.turretYaw)], pose.rotation);
        const direction = normalize(add(mul(forward, Math.cos(pose.barrelPitch)), mul(up, Math.sin(pose.barrelPitch))));
        const pivot = add(transformPoint(composeTRS(pose.position, pose.rotation), trunnion.axisPoint), mul(forward, trunnion.forward));
        const muzzle = add(pivot, mul(direction, kit.weapon.barrelLength));
        const presented = preview.render(alpha, muzzle);
        expectPoint(presented[0], muzzle);
        if (firstInterior) expect(Math.hypot(...presented[2].map((v, k) => v - firstInterior![k]))).toBeGreaterThan(1e-6);
        firstInterior = [...presented[2]];
      }
      expect(points).toEqual(before); expect(simulation.matchHash()).toBe(hash);
      expect(preview.stats().muzzleError).toBe(0);
      lastYaw = tank.turretYaw; lastRefresh = keys.refresh;
    }
    expect(compensatedTicks).toBe(20);
    const beforeAim = trajectoryPreviewKeys(simulation.state, tank, 0, world.version, false);
    simulation.aim(0, tank.turretYaw + .01, tank.barrelPitch, tank.power);
    const smallAim = trajectoryPreviewKeys(simulation.state, tank, 0, world.version, false);
    expect(smallAim.identity).toBe(beforeAim.identity); expect(smallAim.refresh).not.toBe(beforeAim.refresh);
  });

  it('moves the whole short guide continuously at render frequency, attached to the rendered muzzle', () => {
    const preview = new TrajectoryPreview();
    preview.set(short(0), 0, 'same aim', false);
    let last: V3 | undefined;
    for (let tick = 1; tick < 20; tick++) {
      preview.set(short(tick * .1), tick, 'same aim', false);
      for (const alpha of [0, .5]) {
        const x = (tick - 1 + alpha) * .1;
        const result = preview.render(alpha, [x, 20, 0]);
        result.forEach((point, i) => expectPoint(point, short(x)[i]));
        if (last) expect(result[1][0] - last[0]).toBeCloseTo(.05, 10);
        last = [...result[1]];
        expect(preview.stats().muzzleError).toBe(0);
      }
    }
    expect(preview.stats().sourceStep).toBeCloseTo(.1, 10);
    expect(preview.stats().renderedStep).toBeCloseTo(.05, 10);
  });

  it('uses the final fixed-tick interval when lower frame rates skip simulation ticks', () => {
    const preview = new TrajectoryPreview();
    preview.set(short(0), 0, 'aim', false);
    preview.set(short(.2), 2, 'aim', false);
    preview.render(0, [.1, 20, 0]).forEach((point, i) => expectPoint(point, short(.1)[i]));
    preview.render(.5, [.15, 20, 0]).forEach((point, i) => expectPoint(point, short(.15)[i]));
  });

  it('keeps the latest actual terrain hit anchored while smoothing the arc and never changes predictor data', () => {
    const preview = new TrajectoryPreview(), current = full(.1), original = structuredClone(current);
    preview.set(full(0), 1, 'aim');
    current.at(-1)![0] += .05;
    const target = [...current.at(-1)!];
    preview.set(current, 2, 'aim');
    for (const alpha of [0, .25, .5, 1]) {
      const muzzle: V3 = [alpha * .1, 20, 0];
      const result = preview.render(alpha, muzzle);
      expect(result[0]).toEqual(muzzle);
      expect(result.at(-1)).toEqual(target);
      expect(result.every(point => point.every(Number.isFinite))).toBe(true);
    }
    current.at(-1)![0] -= .05;
    expect(current).toEqual(original);
  });

  it('responds immediately to deliberate aim/munition/turn changes instead of dragging the old arc behind input', () => {
    const preview = new TrajectoryPreview();
    preview.set(short(0), 10, 'mortar / tank 0 / yaw 0');
    const turned: V3[] = [[0, 20, 0], [0, 21, 1], [0, 21, 2], [0, 20, 3]];
    preview.set(turned, 10, 'rail / tank 1 / yaw 90');
    expect(preview.render(0, null)).toEqual(turned);
    expect(preview.stats().interpolating).toBe(false);
  });

  it('snaps changed terrain/obstruction targets and handles an extra terminal sample without reshaping a straight segment', () => {
    const preview = new TrajectoryPreview();
    preview.set([[0, 0, 0], [2, 0, 0], [4, 0, 0]], 1, 'aim');
    const split: V3[] = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [4, 0, 0]];
    preview.set(split, 2, 'aim');
    expect(preview.render(.25, null)).toEqual(split);
    const blocked: V3[] = [[0, 0, 0], [1, 0, 0]];
    preview.set(blocked, 3, 'aim');
    expect(preview.render(0, null)).toEqual(blocked);
    expect(preview.stats().interpolating).toBe(false);
    preview.clear(); expect(preview.render(0, null)).toEqual([]);
    preview.set(full(.2), 1, 'new match');
    expect(preview.render(0, null)).toEqual(full(.2));
  });

  it('bounds long guides while preserving the endpoint and clears invalid or hidden traces', () => {
    const preview = new TrajectoryPreview();
    const points = Array.from({ length: 2000 }, (_, i) => [i * .01, 20, 0] as V3);
    preview.set(points, 1, 'aim');
    const result = preview.render(1, points[0]);
    expect(result).toHaveLength(512); expect(result.at(-1)).toEqual(points.at(-1));
    preview.set([[0, 0, 0], [NaN, 0, 0]], 2, 'aim'); expect(preview.render(1, null)).toEqual([]);
    preview.set(points, 3, 'aim'); preview.set([], 4, 'resolving'); expect(preview.render(1, null)).toEqual([]);
  });
});
