import { describe, expect, it } from 'vitest';
import { KEY_BINDINGS, PAD, PAD_PRESS, TOUCH_PRESS, type InputContext } from '../src/game/ui/input/bindings';
import { padFrame, type PadSnapshot } from '../src/game/ui/input/gamepad';
import { GESTURE, GestureArbiter } from '../src/game/ui/input/gestures';
import { stickFrame, stickState } from '../src/game/ui/input/joystick';
import { coverage, hudControls, initialInputStyle, inputStyleFor, unionArea } from '../src/game/ui/hud-layout';
import { cycleSnap, releaseSnap, sheetHeights } from '../src/game/ui/components/sheet-model';

const gamepad = (x: number, y: number): PadSnapshot => ({ axes: [x, y, 0, 0], buttons: Array.from({ length: 17 }, () => 0) });

describe('joystick math', () => {
  it('rests at zero, follows the thumb inside the rim and clamps the knob to it', () => {
    expect(stickState([100, 100], [100, 100], 50)).toMatchObject({ x: 0, y: 0, knob: [100, 100] });
    expect(stickState([100, 100], [125, 100], 50)).toMatchObject({ x: 0.5, y: 0 });
    const rim = stickState([100, 100], [100, 170], 50);
    expect(rim.y).toBeCloseTo(1); expect(rim.knob).toEqual([100, 150]); expect(rim.origin).toEqual([100, 100]);
  });

  it('keeps a fixed base by default; a finite follow drags a floating base along', () => {
    expect(stickState([100, 100], [300, 100], 50).origin).toEqual([100, 100]);
    const far = stickState([100, 100], [300, 100], 50, 1.5);
    expect(far.origin[0]).toBeCloseTo(225); expect(far.x).toBeCloseTo(1); expect(far.knob[0]).toBeCloseTo(275);
  });

  it('produces exactly the gamepad left stick drive axes and aim rates', () => {
    for (const context of ['aim', 'drive', 'watch', 'menu'] as InputContext[]) {
      for (const [x, y] of [[0, 0], [0.05, -0.1], [0.3, -0.8], [-1, 0], [0.6, 0.6]]) {
        expect(stickFrame(context, x, y)).toEqual(padFrame(context, gamepad(x, y)));
      }
    }
    const forward = stickFrame('drive', 0, -1).drive;
    expect(forward.throttle).toBeCloseTo(1); expect(forward.steer).toBeCloseTo(0);
    const idle = stickFrame('drive', 0.05, 0.05).drive;
    expect([idle.throttle + 0, idle.steer + 0]).toEqual([0, 0]);
    expect(stickFrame('aim', 1, 0).rates.yaw).toBeLessThan(0);
    expect(stickFrame('aim', 0, -1).rates.pitch).toBeGreaterThan(0);
    expect(stickFrame('watch', 1, 1)).toEqual({ drive: { throttle: 0, steer: 0 }, rates: { yaw: 0, pitch: 0, power: 0 }, presses: [] });
  });

  it('a thumb drag becomes the analog throttle and steer a gamepad would send', () => {
    const radius = 52, state = stickState([80, 700], [80 + radius * 0.5, 700 - radius * 0.8], radius);
    expect(stickFrame('drive', state.x, state.y).drive).toEqual(padFrame('drive', gamepad(state.x, state.y)).drive);
  });
});

describe('thumb buttons', () => {
  it('send the same press actions as the keyboard and the gamepad', () => {
    expect(TOUCH_PRESS.fire).toBe(KEY_BINDINGS.aim.press.Space);
    expect(TOUCH_PRESS.fire).toBe(PAD_PRESS.aim[PAD.A]);
    expect(TOUCH_PRESS.hold).toBe(KEY_BINDINGS.drive.press.Enter);
    expect(TOUCH_PRESS.hold).toBe(PAD_PRESS.drive[PAD.B]);
    expect(TOUCH_PRESS.target).toBe(KEY_BINDINGS.aim.press.Tab);
    expect(TOUCH_PRESS.munition).toBe(PAD_PRESS.aim[PAD.Y]);
    expect(TOUCH_PRESS.scan).toBe(KEY_BINDINGS.aim.press.KeyR);
    expect(TOUCH_PRESS.pause).toBe(KEY_BINDINGS.watch.press.Escape);
  });
});

describe('gesture arbiter', () => {
  it('a short still touch is a tap at the landing point', () => {
    const g = new GestureArbiter();
    expect(g.down(1, [50, 60], 0)).toEqual([]);
    expect(g.move(1, [54, 63])).toEqual([]);
    expect(g.up(1, [54, 63], 200)).toEqual([{ kind: 'tap', point: [50, 60] }]);
    expect(g.mode).toBe('idle');
  });

  it('a held touch is not a tap', () => {
    const g = new GestureArbiter();
    g.down(1, [50, 60], 0);
    expect(g.up(1, [50, 60], GESTURE.tapMs + 1)).toEqual([]);
  });

  it('a drag past the slop orbits by the whole movement and never taps', () => {
    const g = new GestureArbiter();
    g.down(1, [0, 0], 0);
    expect(g.move(1, [12, 5])).toEqual([{ kind: 'orbit', dx: 12, dy: 5 }]);
    expect(g.move(1, [20, 5])).toEqual([{ kind: 'orbit', dx: 8, dy: 0 }]);
    expect(g.move(1, [10, 5])).toEqual([{ kind: 'orbit', dx: -10, dy: 0 }]);
    expect(g.up(1, [10, 5], 100)).toEqual([]);
  });

  it('two fingers pinch: spreading zooms in (negative wheel pixels) and the midpoint orbits', () => {
    const g = new GestureArbiter();
    g.down(1, [100, 100], 0); g.down(2, [200, 100], 10);
    expect(g.mode).toBe('pinch');
    const [event] = g.move(2, [300, 100]);
    expect(event.kind).toBe('pinch');
    if (event.kind !== 'pinch') return;
    expect(event.zoom).toBeCloseTo(Math.log(100 / 200) / GESTURE.zoomPerPixel);
    expect(event.dx).toBe(50);
    expect(g.up(2, [300, 100], 50)).toEqual([]);
    expect(g.mode).toBe('orbit');
    expect(g.move(1, [102, 100])).toEqual([{ kind: 'orbit', dx: 2, dy: 0 }]);
    expect(g.up(1, [102, 100], 60)).toEqual([]);
  });

  it('a press on your own tank drags the shot and ignores other fingers until it lifts', () => {
    const g = new GestureArbiter();
    expect(g.down(7, [10, 10], 0, true)).toEqual([{ kind: 'aim', point: [10, 10] }]);
    expect(g.down(8, [90, 90], 5)).toEqual([]);
    expect(g.move(8, [99, 99])).toEqual([]);
    expect(g.move(7, [40, 10])).toEqual([{ kind: 'aim', point: [40, 10] }]);
    expect(g.up(8, [99, 99], 30)).toEqual([]);
    expect(g.up(7, [40, 10], 40)).toEqual([{ kind: 'aim-end' }]);
    expect(g.mode).toBe('idle');
  });

  it('a cancelled touch never taps, and a reset ends a drag-aim', () => {
    const g = new GestureArbiter();
    g.down(1, [5, 5], 0);
    expect(g.cancel(1)).toEqual([]);
    expect(g.up(1, [5, 5], 10)).toEqual([]);
    g.down(2, [5, 5], 20, true);
    expect(g.reset()).toEqual([{ kind: 'aim-end' }]);
    expect(g.active).toBe(false);
  });
});

describe('HUD layout', () => {
  it('maps every input context to its visible controls', () => {
    expect(hudControls('aim', false)).toEqual({ stick: 'aim', primary: 'fire', power: true, munition: true, scan: true, camera: true });
    expect(hudControls('aim', true).scan).toBe(false);
    expect(hudControls('drive', false)).toEqual({ stick: 'drive', primary: 'hold', power: false, munition: false, scan: false, camera: true });
    expect(hudControls('drive', true)).toMatchObject({ stick: 'drive', primary: 'fire', power: true });
    expect(hudControls('watch', false)).toEqual({ stick: null, primary: null, power: false, munition: false, scan: false, camera: true });
    expect(Object.values(hudControls('menu', false)).every(v => !v)).toBe(true);
  });

  it('dresses for the last pointer type', () => {
    expect(inputStyleFor('touch', 'pointer')).toBe('touch');
    expect(inputStyleFor('pen', 'pointer')).toBe('touch');
    expect(inputStyleFor('mouse', 'touch')).toBe('pointer');
    expect(inputStyleFor('', 'touch')).toBe('touch');
  });

  it('starts from the primary pointer unless ?touch forces a style', () => {
    expect(initialInputStyle('', true)).toEqual({ style: 'touch', forced: false });
    expect(initialInputStyle('?mode=bot', false)).toEqual({ style: 'pointer', forced: false });
    expect(initialInputStyle('?touch=1', false)).toEqual({ style: 'touch', forced: true });
    expect(initialInputStyle('?seed=7&touch=0', true)).toEqual({ style: 'pointer', forced: true });
  });

  it('measures the union of overlapping HUD rectangles, clipped to the viewport', () => {
    const a = { left: 0, top: 0, right: 10, bottom: 10 }, b = { left: 5, top: 5, right: 15, bottom: 15 };
    expect(unionArea([a, b], 100, 100)).toBe(175);
    expect(unionArea([a, a], 100, 100)).toBe(100);
    expect(unionArea([{ left: -10, top: -10, right: 10, bottom: 10 }], 100, 100)).toBe(100);
    expect(unionArea([{ left: 0, top: 0, right: 10, bottom: 10 }, { left: 0, top: 20, right: 10, bottom: 30 }], 100, 100)).toBe(200);
    expect(coverage([a], 100, 100)).toBeCloseTo(0.01);
    expect(coverage([], 0, 0)).toBe(0);
  });
});

describe('bottom sheet snapping', () => {
  const snaps = [{ id: 'peek' as const, height: 150 }, { id: 'half' as const, height: 400 }, { id: 'full' as const, height: 720 }];
  it('settles where it is let go, and a flick moves it one step', () => {
    expect(releaseSnap(snaps, 380, 0)).toBe('half');
    expect(releaseSnap(snaps, 420, 1500)).toBe('full');
    expect(releaseSnap(snaps, 380, -1500)).toBe('peek');
  });
  it('dismisses below the lowest snap only when allowed', () => {
    expect(releaseSnap(snaps, 60, 0, true)).toBeNull();
    expect(releaseSnap(snaps, 60, 0, false)).toBe('peek');
    expect(releaseSnap([], 60, 0)).toBeNull();
  });
  it('a handle tap cycles upward and wraps', () => {
    expect(cycleSnap(snaps, 'peek')).toBe('half');
    expect(cycleSnap(snaps, 'full')).toBe('peek');
  });
  it('sizes the snaps for the viewport', () => {
    expect(sheetHeights(844, 150)).toEqual({ peek: 150, half: 405, full: 726 });
    expect(sheetHeights(390, 150)).toEqual({ peek: 150, half: 270, full: 335 });
  });
});
