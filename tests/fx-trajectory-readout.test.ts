import { describe, expect, it } from 'vitest';
import { placeTrajectoryLabel, trajectoryTarget, trajectoryTargetOccluded, type ScreenRect, type TrajectoryTarget } from '../src/game/presentation/trajectory-readout';
import type { V3 } from '../src/game/contracts';
import { GameSimulation } from '../src/game/simulation';
import { practiceSetup } from '../src/game/api/match';
import { SphereWorld } from './helpers/sphere-world';

const overlaps = (a: ScreenRect, b: ScreenRect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

describe('trajectory target readout', () => {
  it('keeps the complete authoritative trace and identifies its actual landing point and surface range', () => {
    const simulation = new GameSimulation(new SphereWorld(), practiceSetup({ seed: 7, mode: 'drive', player: { tracks: 'scout', barrel: 'mortar', armor: 'light' } }));
    const tank = simulation.state.tanks[0], prediction = simulation.previewPrediction(0, true);
    expect(prediction.points.length).toBeGreaterThan(8); expect(prediction.hit).toBe(true);
    const hash = simulation.matchHash(), original = structuredClone(prediction);
    const target = trajectoryTarget(prediction.points, tank.position, 18, true, prediction.hit)!;
    expect(target.kind).toBe('landing'); expect(target.position).toEqual(prediction.points.at(-1));
    expect(target.range).toBeGreaterThan(1); expect(target.range).toBeLessThan(Math.PI * 18);
    target.position[0] += 1;
    expect(prediction).toEqual(original); expect(simulation.matchHash()).toBe(hash);
  });

  it('does not call a truncated or expired airborne trace a landing', () => {
    const points: V3[] = [[0, 20, 0], [5, 24, 0]];
    expect(trajectoryTarget(points, [0, 18, 0], 18, false, false)).toBeNull();
    expect(trajectoryTarget(points, [0, 18, 0], 18, true, false)?.kind).toBe('flight-limit');
    expect(trajectoryTarget(points, [0, 18, 0], 18, true)?.kind).toBe('flight-limit');
    // A water/tree extension hit is authoritative even above the terrain radius.
    expect(trajectoryTarget(points, [0, 18, 0], 18, true, true)?.kind).toBe('landing');
    expect(trajectoryTarget(points, [0, 18, 0], 18, true, true, true)?.kind).toBe('impact');
    expect(trajectoryTarget(points, [0, 18, 0], 18, true, false, true)?.kind).toBe('flight-limit');
    expect(trajectoryTarget([], [0, 18, 0], 18, true, true)).toBeNull();
    expect(trajectoryTarget([[0, 20, 0], [NaN, 0, 0]], [0, 18, 0], 18, true, true)).toBeNull();
    const quarter: V3[] = [[0, 20, 0], [18, 0, 0]];
    expect(trajectoryTarget(quarter, [0, 18, 0], 18, true, true)?.range).toBeCloseTo(Math.PI * 9, 8);
  });

  it('distinguishes an obscured landing from the visible surface itself', () => {
    const world = new SphereWorld(), target: TrajectoryTarget = { position: [0, 18, 0], range: 5, kind: 'landing' };
    expect(trajectoryTargetOccluded(target, [0, 26, 8], world)).toBe(false);
    expect(trajectoryTargetOccluded({ ...target, position: [0, -18, 0] }, [0, 26, 8], world)).toBe(true);
    expect(trajectoryTargetOccluded(null, [0, 26, 8], world)).toBe(false);
  });
});

describe('trajectory readout placement', () => {
  it('keeps the impact label beside a selected body instead of jumping to a distant HUD boundary', () => {
    const body = { x: 570, y: 310, width: 120, height: 100 };
    const box = placeTrajectoryLabel([630, 350], 1200, 800, [{ x: 10, y: 10, width: 250, height: 100 }, body])!;
    expect(box.x).toBe(700); expect(box.y).toBe(329); expect(overlaps(box, body)).toBe(false);
  });
  it('keeps labels near the landing point when the battlefield is clear', () => {
    expect(placeTrajectoryLabel([600, 350], 1200, 800, [])).toEqual({ x: 623, y: 329, width: 156, height: 42 });
  });

  it.each([
    { width: 1200, height: 800, obstacles: [{ x: 15, y: 15, width: 250, height: 135 }, { x: 420, y: 15, width: 360, height: 100 },
      { x: 15, y: 555, width: 240, height: 230 }, { x: 880, y: 410, width: 305, height: 375 }] },
    { width: 390, height: 844, obstacles: [{ x: 10, y: 10, width: 310, height: 110 }, { x: 330, y: 10, width: 50, height: 160 },
      { x: 10, y: 500, width: 370, height: 334 }] },
  ])('avoids the visible HUD at $width × $height, including a target behind the fire panel', ({ width, height, obstacles }) => {
    for (const anchor of [[width - 80, height - 80], [50, 50], [width * .5, height * .5], null]) {
      const box = placeTrajectoryLabel(anchor, width, height, obstacles);
      expect(box).not.toBeNull();
      expect(obstacles.some(obstacle => overlaps(box!, obstacle))).toBe(false);
      expect(box!.x).toBeGreaterThanOrEqual(12); expect(box!.x + box!.width).toBeLessThanOrEqual(width - 12);
      expect(box!.y).toBeGreaterThanOrEqual(12); expect(box!.y + box!.height).toBeLessThanOrEqual(height - 12);
    }
  });

  it('hides when there is no free space rather than covering controls', () => {
    expect(placeTrajectoryLabel([40, 40], 100, 80, [])).toBeNull();
    expect(placeTrajectoryLabel([200, 300], 400, 600, [{ x: 0, y: 0, width: 400, height: 600 }])).toBeNull();
  });
});
