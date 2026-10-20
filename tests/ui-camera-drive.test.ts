import { describe, expect, it } from 'vitest';
import { cameraDrive, REVERSE_ENTER, REVERSE_EXIT, screenToGround, type DriveFrame } from '../src/game/ui/input/camera-drive';
import { stickFrame } from '../src/game/ui/input/joystick';

// The camera looks along -Z with +X to its right and +Y up: screen up on the ground is -Z.
const frame = (forward: [number, number, number]): DriveFrame => ({ forward, up: [0, 1, 0], cameraRight: [1, 0, 0] });
const AWAY: [number, number, number] = [0, 0, -1], TOWARD: [number, number, number] = [0, 0, 1], RIGHT: [number, number, number] = [1, 0, 0];
const up = { throttle: 1, steer: 0 }, right = { throttle: 0, steer: 1 };
const n = (v: number) => v + 0;

describe('camera-relative driving', () => {
  it('maps screen up to the ground away from the camera and screen right to the camera right', () => {
    const ahead = screenToGround(0, -1, frame(AWAY))!, side = screenToGround(1, 0, frame(AWAY))!;
    expect(ahead.map(n)).toEqual([0, 0, -1]);
    expect(side.map(n)).toEqual([1, 0, 0]);
    expect(screenToGround(1, 0, { up: [0, 1, 0], cameraRight: [0, 1, 0] })).toBeNull();
  });

  it('drives straight when the hull already faces where the stick points', () => {
    const { drive, reversing } = cameraDrive(up, frame(AWAY), false);
    expect(drive.throttle).toBeCloseTo(1); expect(n(drive.steer)).toBeCloseTo(0); expect(reversing).toBe(false);
  });

  it('pivots toward a direction across the hull, turning the right way', () => {
    const toRight = cameraDrive(right, frame(AWAY), false).drive;
    expect(toRight.steer).toBeCloseTo(1); expect(toRight.throttle).toBeCloseTo(0);
    const toLeft = cameraDrive({ throttle: 0, steer: -1 }, frame(AWAY), false).drive;
    expect(toLeft.steer).toBeCloseTo(-1);
    // The hull faces right on screen; pushing up turns it left (counter-clockwise) toward up.
    expect(cameraDrive(up, frame(RIGHT), false).drive.steer).toBeCloseTo(-1);
  });

  it('backs the tank out when the stick points behind the hull, and reverses straight when aligned', () => {
    const { drive, reversing } = cameraDrive(up, frame(TOWARD), false);
    expect(reversing).toBe(true); expect(drive.throttle).toBeCloseTo(-1); expect(n(drive.steer)).toBeCloseTo(0);
  });

  it('holds forward or reverse inside the hysteresis band', () => {
    const between = (REVERSE_ENTER + REVERSE_EXIT) / 2;
    const forward: [number, number, number] = [Math.sin(between), 0, -Math.cos(between)];
    expect(cameraDrive(up, frame(forward), false).reversing).toBe(false);
    expect(cameraDrive(up, frame(forward), true).reversing).toBe(true);
  });

  it('eases the steer off as the hull comes round, and a gentle push still turns', () => {
    const near: [number, number, number] = [Math.sin(.2), 0, -Math.cos(.2)];
    const settling = cameraDrive(up, frame(near), false).drive;
    expect(Math.abs(settling.steer)).toBeLessThan(.4); expect(settling.throttle).toBeGreaterThan(.95);
    expect(Math.abs(cameraDrive({ throttle: 0, steer: .2 }, frame(AWAY), false).drive.steer)).toBeGreaterThan(.5);
  });

  it('is idle without deflection and keeps the gamepad dead zone when fed the shaped stick', () => {
    expect(cameraDrive({ throttle: 0, steer: 0 }, frame(AWAY), true)).toEqual({ drive: { throttle: 0, steer: 0 }, reversing: false });
    const shaped = stickFrame('drive', .05, -.05).drive;
    expect(cameraDrive(shaped, frame(AWAY), false).drive).toEqual({ throttle: 0, steer: 0 });
  });
});
