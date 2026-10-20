import { describe, expect, it, vi } from 'vitest';
import type { TankState, V3 } from '../src/game/contracts';
import type { AimSelection, AimTargetAim, AimTargetResult } from '../src/game/rules/aim-target';
import { AIM_RESPONSE, approachTargetAim, GroundAimController, trimGroundTarget } from '../src/game/ui/input/ground-aim';

const origin: V3 = [0, 18, 0];
const ground = (angle: number): V3 => [18 * Math.sin(angle), 18 * Math.cos(angle), 0];
const surface = (direction: V3): V3 => direction.map(v => v * 18) as V3;

function harness() {
  const tank = { id: 0, position: [...origin], rotation: [0, 0, 0, 1], turretYaw: 0, barrelPitch: .75, power: .55,
    munition: 'explosive', loadout: { tracks: 'scout', barrel: 'mortar', armor: 'light' } } as TankState;
  let enabled = true, revision = '0/0', picked: AimSelection | null = { point: ground(.3) };
  const solve = vi.fn((target: AimSelection, previous?: AimTargetAim): AimTargetResult => ({ status: 'ready', aim: { yaw: 1, pitch: .6, power: .4 },
    point: [...target.point], target: [...target.point], error: .01, traces: previous ? 1 : 4, steps: 120 }));
  const aim = vi.fn((a: AimTargetAim) => { Object.assign(tank, { turretYaw: a.yaw, barrelPitch: a.pitch, power: a.power }); return true; });
  const show = vi.fn(), resolve = vi.fn((selection: AimSelection) => selection as AimSelection | null);
  const input = new GroundAimController({ enabled: () => enabled, tank: () => tank, pick: () => picked, resolve, surface,
    surfaceVersion: () => Number(revision.split('/')[0]), revision: () => revision, solve, aim, show });
  return { input, tank, solve, aim, show, resolve, setSelection: (value: AimSelection) => { picked = value; }, setPicked: (value: V3 | null) => { picked = value ? { point: value } : null; },
    setEnabled: (value: boolean) => { enabled = value; }, setRevision: (value: string) => { revision = value; } };
}

describe('terrain target range trim', () => {
  it('keeps the exact picked wall point until the player requests a range trim', () => {
    const wall: V3 = [3, 20, 0], query = vi.fn(surface);
    expect(trimGroundTarget(origin, wall, 1, query)).toEqual(wall);
    expect(query).not.toHaveBeenCalled();
  });

  it('changes surface distance in both directions, with the same rule behind the tank', () => {
    for (const angle of [.3, -.3]) {
      const result = trimGroundTarget(origin, ground(angle), 1.1, surface);
      result.forEach((v, i) => expect(v).toBeCloseTo(ground(angle * 1.1)[i], 10));
      const reversed = trimGroundTarget(origin, result, 1 / 1.1, surface);
      reversed.forEach((v, i) => expect(v).toBeCloseTo(ground(angle)[i], 10));
    }
    expect(trimGroundTarget(origin, ground(.3), 2, () => null)).toEqual(ground(.3));
    expect(trimGroundTarget(origin, origin, 2, surface)).toEqual(origin);
  });
});

describe('ground aiming input lifecycle', () => {
  it('accepts a keyboard-selected target, tracks movement and clears when visibility is lost', () => {
    const h = harness();
    const selection: AimSelection = { point: [3, 18.35, 0], object: { id: 'tank:1', kind: 'tank', collider: { shape: 'sphere', center: [3, 18, 0], radius: .7 } } };
    h.input.point([10, 20]); h.input.select(selection); h.input.update(0);
    expect(h.input.selectedObjectId()).toBe('tank:1');
    expect(h.show.mock.calls.at(-1)![0].objectId).toBe('tank:1');
    expect(h.input.snapshot().pointer).toBeNull(); expect(h.input.snapshot().active).toBe(false);
    expect(h.solve.mock.calls.at(-1)![0]).toEqual(selection);
    const moved = { ...selection, point: [4, 18.35, 0] as V3 };
    h.resolve.mockReturnValue(moved); h.input.update(40);
    expect(h.solve.mock.calls.at(-1)![0]).toEqual(moved);
    h.resolve.mockReturnValue(null); h.input.update(80);
    expect(h.input.selectedObjectId()).toBeUndefined(); expect(h.input.collider()).toBeUndefined();
    expect(h.show).toHaveBeenLastCalledWith(null);
    h.setEnabled(false); h.input.select(selection);
    expect(h.input.selectedObjectId()).toBeUndefined();
  });
  it('bounds repeated pointer events and reuses a stationary solution', () => {
    const h = harness();
    h.input.point([100, 200]); h.input.update(0);
    for (let t = 1; t < 80; t++) { h.input.point([100, 200]); h.input.update(t); }
    expect(h.solve).toHaveBeenCalledTimes(1);
    h.input.update(80); expect(h.solve).toHaveBeenCalledTimes(1);
    h.setPicked(ground(.4)); h.input.update(160);
    expect(h.solve).toHaveBeenCalledTimes(2);
    expect(h.solve.mock.calls[1][1]).toEqual({ yaw: 1, pitch: .6, power: .4 });
    h.input.clear(); h.input.update(1000);
    expect(h.solve).toHaveBeenCalledTimes(2); expect(h.input.snapshot().active).toBe(false);
    expect(h.show).toHaveBeenLastCalledWith(null);
  });

  it('resolves a stationary cursor while the tank moves, wind advances, or terrain changes', () => {
    const h = harness(); h.input.point([100, 200]); h.input.update(0);
    h.tank.position[0] += .1; h.input.update(80);
    h.setRevision('1/0'); h.input.update(160);
    h.setRevision('1/12'); h.input.update(240);
    expect(h.solve).toHaveBeenCalledTimes(4);
  });

  it('retains wheel trim across subsequent pointer updates and restores it with reverse scroll', () => {
    const h = harness(); h.input.point([100, 200]); h.input.update(0);
    expect(h.input.adjustRange(1.1)).toBe(true); h.input.update(80);
    const farther = h.solve.mock.calls.at(-1)![0];
    expect(farther.point[0]).toBeGreaterThan(ground(.3)[0]);
    h.input.point([101, 200]); h.input.update(160);
    expect(h.input.snapshot().rangeScale).toBeCloseTo(1.1);
    expect(h.input.adjustRange(1 / 1.1)).toBe(true); h.input.update(240);
    h.solve.mock.calls.at(-1)![0].point.forEach((v, i) => expect(v).toBeCloseTo(ground(.3)[i], 10));
    h.input.clear(); expect(h.input.adjustRange(1.1)).toBe(false);
    h.input.point([100, 200]); expect(h.input.snapshot().rangeScale).toBe(1);
  });

  it('leaves the last aim unchanged over sky and cancels targeting when paused', () => {
    const h = harness(); h.input.point([100, 200]); h.input.update(0);
    h.setPicked(null); h.input.update(80);
    expect(h.aim).toHaveBeenCalledTimes(1); expect(h.show).toHaveBeenLastCalledWith(null);
    h.setEnabled(false); h.input.update(160);
    expect(h.input.snapshot().active).toBe(false);
    h.setEnabled(true); h.setPicked(ground(.3)); h.input.update(240);
    expect(h.solve).toHaveBeenCalledTimes(1);
  });

  it('flushes the latest solver goal before firing without teleporting the barrel', () => {
    const h = harness(); h.input.point([100, 200]); h.input.update(0);
    h.setPicked(ground(.5)); h.input.point([200, 300]);
    const yaw = h.tank.turretYaw; h.input.update(20, true);
    expect(h.tank.turretYaw).toBe(yaw);
    expect(h.solve).toHaveBeenCalledTimes(2); expect(h.solve.mock.calls.at(-1)![0].point).toEqual(ground(.5));
  });
});


describe('responsive world targeting', () => {
  it('updates cursor feedback and barrel motion on frames between expensive solves', () => {
    const h = harness(); h.input.point([100, 200]); h.input.update(0);
    const firstYaw = h.tank.turretYaw;
    h.setPicked(ground(.31)); h.input.update(16);
    expect(h.solve).toHaveBeenCalledTimes(1);
    expect(h.show.mock.calls.at(-1)![0].target).toEqual(ground(.31));
    expect(h.tank.turretYaw).toBeGreaterThan(firstYaw);
    h.input.update(34); expect(h.solve).toHaveBeenCalledTimes(2);
    expect(h.tank.turretYaw).toBeLessThan(1);
  });

  it('accepts a click released before the next frame and finishes turning after release', () => {
    const h = harness(); h.input.point([100, 200]); h.input.release(); h.input.update(0);
    expect(h.input.snapshot().active).toBe(false); expect(h.input.snapshot().tracking).toBe(true);
    expect(h.solve).toHaveBeenCalledOnce();
    h.setPicked(ground(.8)); // A released cursor no longer changes the selected place.
    for (let t = 16; t < 1000; t += 16) h.input.update(t);
    expect(h.solve).toHaveBeenCalledOnce();
    expect(h.tank.turretYaw).toBeCloseTo(1, 4);
    expect(h.tank.barrelPitch).toBeCloseTo(.6, 4);
    expect(h.tank.power).toBeCloseTo(.4, 4);
  });

  it('pins the chosen place through recoil and crater changes until a fresh drag', () => {
    const h = harness(); h.input.point([100, 200]); h.input.update(0);
    h.input.shotFired();
    h.setPicked(ground(.8)); // Camera shake changes the ray underneath the unmoved screen cursor.
    h.input.update(40);
    expect(h.solve).toHaveBeenCalledOnce();
    expect(h.input.snapshot().active).toBe(true);
    const crater: AimSelection = { point: [2, 16, 0] };
    h.resolve.mockReturnValue(crater); h.setRevision('1/0'); h.input.update(80);
    expect(h.solve.mock.calls.at(-1)![0]).toEqual(crater);
    h.input.update(120); expect(h.solve).toHaveBeenCalledTimes(2);
    h.input.point([110, 200]); h.input.update(160);
    expect(h.solve.mock.calls.at(-1)![0].point).toEqual(ground(.8));
  });

  it('pins the effective wheel-trimmed spot after firing while the tank continues moving', () => {
    const h = harness(); h.input.point([100, 200]); h.input.update(0);
    h.input.adjustRange(1.2); h.input.update(40);
    const firedAt = structuredClone(h.solve.mock.calls.at(-1)![0]);
    h.input.shotFired(); h.tank.position[0] += 1; h.input.update(80);
    expect(h.input.snapshot().rangeScale).toBe(1);
    expect(h.input.snapshot().selection).toEqual(firedAt);
    expect(h.solve.mock.calls.at(-1)![0]).toEqual(firedAt);
    expect(firedAt.terrain?.version).toBe(0);
  });

  it('takes the short path across the yaw seam and obeys physical slew limits', () => {
    const start = { yaw: Math.PI - .01, pitch: .2, power: .3 };
    const next = approachTargetAim(start, { yaw: -Math.PI + .05, pitch: 1.3, power: 1 }, .016);
    const yawStep = Math.atan2(Math.sin(next.yaw - start.yaw), Math.cos(next.yaw - start.yaw));
    expect(yawStep).toBeGreaterThan(0); expect(yawStep).toBeLessThan(.06);
    expect(next.pitch - start.pitch).toBeLessThanOrEqual(AIM_RESPONSE.pitchRate * .016);
    expect(next.power - start.power).toBeLessThanOrEqual(AIM_RESPONSE.powerRate * .016 + 1e-9);
    const huge = approachTargetAim(start, { yaw: 0, pitch: 1.3, power: 1 }, 10);
    expect(Math.abs(huge.yaw - start.yaw)).toBeLessThanOrEqual(AIM_RESPONSE.yawRate * .05 + 1e-9);
  });
});


it('keeps the exact hovered object point, refreshes a released visible target, and drops a hidden one', () => {
  const h = harness(), center: V3 = [3, 18, 0], point: V3 = [3.1, 18.2, .3];
  const selected: AimSelection = { point, object: { id: 'tank:1', kind: 'tank', collider: { shape: 'sphere', center, radius: .7 } } };
  h.setSelection(selected); h.input.point([100, 200]); h.input.update(0);
  expect(h.solve.mock.calls[0][0]).toEqual(selected);
  expect(h.input.collider()).toEqual(selected.object!.collider);
  h.input.release();
  const moved: AimSelection = { point: [3.2, 18.2, .3], object: { ...selected.object!, collider: { ...selected.object!.collider, center: [3.1, 18, 0] } } };
  h.resolve.mockReturnValue(moved); h.input.update(40);
  expect(h.solve.mock.calls[1][0]).toEqual(moved);
  h.resolve.mockReturnValue(null); h.input.update(80);
  expect(h.input.collider()).toBeUndefined(); expect(h.show).toHaveBeenLastCalledWith(null);
  expect(h.input.snapshot().tracking).toBe(false);
});
