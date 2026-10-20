import { describe, expect, it } from 'vitest';
import type { GameSnapshot } from '../src/game/contracts';
import {
  AIM_SPEED, combineDrive, driveFromHeld, heldActions, isBound, KEY_BINDINGS, PAD, PAD_PRESS, pressAction, ratesFromHeld, stepAim, type InputContext,
} from '../src/game/ui/input/bindings';
import { canAim, canDrive, inputContext, type ContextInput } from '../src/game/ui/input/contexts';
import { AIM_DEADZONE, DEADZONE, EXPO, padFrame, readGamepad, shapeAxis, shapeStick, type PadSnapshot } from '../src/game/ui/input/gamepad';
import { KeyState, nativeKey } from '../src/game/ui/input/keyboard';
import { dragPower, grabRadius, solveDragAim } from '../src/game/ui/input/mouse';

const snapshot = (phase: GameSnapshot['phase'], active = 0): GameSnapshot =>
  ({ tick: 0, time: 0, phase, active, turn: 1, phaseTime: 0, tanks: [], projectiles: [], contacts: [], winner: null }) as unknown as GameSnapshot;
const ctx = (o: Partial<ContextInput>): ContextInput => ({ screen: 'match', snapshot: snapshot('aim'), observer: 0, ready: true, driveTest: false, ...o });
const pad = (axes: number[] = [0, 0, 0, 0], pressed: Record<number, number> = {}): PadSnapshot =>
  ({ axes, buttons: Array.from({ length: 17 }, (_, i) => pressed[i] ?? 0) });

describe('input bindings', () => {
  it('maps Q/E and A/D to bearing, W/S to elevation, Tab to targeting, 1–4 to weapons and Space to fire', () => {
    expect([...heldActions('aim', ['KeyA', 'KeyW', 'KeyQ'])].sort()).toEqual(['bearingLeft', 'elevationUp']);
    expect([...heldActions('aim', ['ArrowRight', 'ArrowDown', 'KeyE'])].sort()).toEqual(['bearingRight', 'elevationDown']);
    expect(pressAction('aim', 'Space')).toBe('fire');
    expect(pressAction('aim', 'Tab')).toBe('nextTarget');
    for (const mode of ['aim', 'drive'] as const) for (const slot of [1, 2, 3, 4]) expect(pressAction(mode, `Digit${slot}`)).toBe(`weapon${slot}`);
    expect(pressAction('aim', 'KeyR')).toBe('scan');
    expect(pressAction('aim', 'Escape')).toBe('pause');
  });

  it('drives with W/A/S/D and keeps the arrows on the turret in the drive context', () => {
    expect([...heldActions('drive', ['KeyW', 'KeyA'])].sort()).toEqual(['driveForward', 'driveLeft']);
    expect([...heldActions('drive', ['ArrowLeft', 'ArrowUp'])].sort()).toEqual(['bearingLeft', 'elevationUp']);
    expect(ratesFromHeld(heldActions('drive', ['KeyQ']))).toEqual({ yaw: AIM_SPEED.yaw, pitch: 0, power: 0 });
    expect(ratesFromHeld(heldActions('drive', ['KeyE']))).toEqual({ yaw: -AIM_SPEED.yaw, pitch: 0, power: 0 });
    expect(ratesFromHeld(heldActions('aim', ['KeyQ', 'KeyE']))).toEqual({ yaw: 0, pitch: 0, power: 0 });
    expect(driveFromHeld(heldActions('drive', ['KeyW', 'KeyD']))).toEqual({ throttle: 1, steer: 1 });
    expect(driveFromHeld(heldActions('drive', ['KeyS', 'KeyA', 'KeyD']))).toEqual({ throttle: -1, steer: 0 });
    // Aiming never drives.
    expect(driveFromHeld(heldActions('aim', ['KeyW', 'KeyA']))).toEqual({ throttle: 0, steer: 0 });
    expect(pressAction('drive', 'Enter')).toBe('endMove');
    expect(pressAction('drive', 'Space')).toBe('fire');
  });

  it('keeps watch and menu contexts free of gameplay actions', () => {
    for (const code of ['KeyA', 'KeyW', 'KeyQ', 'KeyE', 'Space', 'Tab', 'ArrowLeft']) {
      expect(heldActions('watch', [code]).size).toBe(0);
      expect(heldActions('menu', [code]).size).toBe(0);
      expect(pressAction('menu', code)).toBeUndefined();
    }
    expect(pressAction('watch', 'Escape')).toBe('pause');
    expect(pressAction('menu', 'Escape')).toBe('back');
    expect(pressAction('menu', 'Enter')).toBe('confirm');
    expect(isBound('menu', 'Tab')).toBe(false);
    expect(isBound('aim', 'Tab')).toBe(true);
    // Every context can pause or go back with Escape.
    for (const context of Object.keys(KEY_BINDINGS) as InputContext[]) expect(pressAction(context, 'Escape')).toBeDefined();
  });

  it('turns held keys into rates with the turretYaw sign convention without a Shift modifier', () => {
    expect(ratesFromHeld(new Set(['bearingLeft']))).toEqual({ yaw: AIM_SPEED.yaw, pitch: 0, power: 0 });
    expect(ratesFromHeld(new Set(['bearingRight', 'elevationDown', 'powerDown']))).toEqual({ yaw: -AIM_SPEED.yaw, pitch: -AIM_SPEED.pitch, power: -AIM_SPEED.power });
    expect(ratesFromHeld(new Set(['bearingLeft', 'bearingRight'])).yaw).toBe(0);
    expect(ratesFromHeld(heldActions('drive', ['KeyQ', 'ShiftLeft']))).toEqual(ratesFromHeld(heldActions('drive', ['KeyQ'])));
    expect(isBound('drive', 'ShiftLeft')).toBe(false);
    expect(isBound('aim', 'ShiftRight')).toBe(false);
    expect(combineDrive({ throttle: 1, steer: 0.5 }, { throttle: 0.7, steer: -2 })).toEqual({ throttle: 1, steer: -1 });
  });

  it('steps the aim with a wrapped bearing and clamped elevation and power', () => {
    const limits = { min: -0.1, max: 1.4 };
    const step = stepAim({ yaw: 3.1, pitch: 1.39, power: 0.99 }, { yaw: 1, pitch: 1, power: 1 }, 0.1, limits);
    expect(step.yaw).toBeCloseTo(3.2 - 2 * Math.PI);
    expect(step.pitch).toBe(1.4);
    expect(step.power).toBe(1);
    expect(stepAim({ yaw: 0, pitch: 0, power: 0.02 }, { yaw: 0, pitch: -5, power: -1 }, 0.1, limits)).toEqual({ yaw: 0, pitch: -0.1, power: 0 });
    // 600 ms of ArrowLeft in the drive test: a clearly visible bearing change.
    let aim = { yaw: 0, pitch: 0.75, power: 0.55 };
    for (let i = 0; i < 36; i++) aim = stepAim(aim, ratesFromHeld(heldActions('drive', ['ArrowLeft'])), 1 / 60, limits);
    expect(aim.yaw * 180 / Math.PI).toBeCloseTo(30, 5);
  });
});

describe('input contexts', () => {
  it('follows the flow screen and the match phase', () => {
    expect(inputContext(ctx({ screen: 'title' }))).toBe('menu');
    expect(inputContext(ctx({ screen: 'pause' }))).toBe('menu');
    expect(inputContext(ctx({}))).toBe('aim');
    expect(inputContext(ctx({ snapshot: snapshot('resolving') }))).toBe('drive');
    expect(inputContext(ctx({ snapshot: snapshot('aim', 1) }))).toBe('watch');
    expect(inputContext(ctx({ snapshot: snapshot('terrain') }))).toBe('watch');
    expect(inputContext(ctx({ snapshot: snapshot('finished') }))).toBe('watch');
    expect(inputContext(ctx({ ready: false }))).toBe('watch');
    expect(inputContext(ctx({ snapshot: undefined }))).toBe('watch');
    expect(inputContext(ctx({ driveTest: true }))).toBe('drive');
    expect(inputContext(ctx({ driveTest: true, snapshot: snapshot('resolving') }))).toBe('drive');
  });

  it('allows aiming and driving only when the session would accept them', () => {
    expect(canAim(ctx({}))).toBe(true);
    expect(canAim(ctx({ snapshot: snapshot('resolving') }))).toBe(false);
    expect(canAim(ctx({ snapshot: snapshot('resolving'), driveTest: true }))).toBe(true);
    expect(canAim(ctx({ snapshot: snapshot('aim', 1) }))).toBe(false);
    expect(canAim(ctx({ screen: 'pause' }))).toBe(false);
    expect(canDrive(ctx({}))).toBe(false);
    expect(canDrive(ctx({ snapshot: snapshot('resolving') }))).toBe(true);
    expect(canDrive(ctx({ driveTest: true }))).toBe(true);
    expect(canDrive(ctx({ driveTest: true, snapshot: snapshot('terrain') }))).toBe(false);
  });
});

describe('gamepad shaping', () => {
  it('has a 0.12 deadzone and a 1.6 expo curve', () => {
    expect(DEADZONE).toBe(0.12);
    expect(EXPO).toBe(1.6);
    expect(shapeAxis(0.1)).toBe(0);
    expect(shapeAxis(0.12)).toBe(0);
    expect(shapeAxis(-0.12)).toBe(0);
    expect(shapeAxis(1)).toBe(1);
    expect(shapeAxis(-1)).toBe(-1);
    expect(shapeAxis(1.5)).toBe(1);
    expect(shapeAxis(0.56)).toBeCloseTo(0.5 ** 1.6, 10);
    expect(shapeAxis(-0.56)).toBeCloseTo(-(0.5 ** 1.6), 10);
    expect(shapeAxis(Number.NaN)).toBe(0);
    // Monotonic and continuous at the deadzone edge.
    let last = 0;
    for (let v = 0; v <= 1.0001; v += 0.01) { const s = shapeAxis(v); expect(s).toBeGreaterThanOrEqual(last); last = s; }
    expect(shapeAxis(0.1201)).toBeLessThan(1e-5);
  });

  it('uses a radial deadzone that keeps the stick direction', () => {
    expect(shapeStick(0.08, 0.08)).toEqual([0, 0]);
    const [x, y] = shapeStick(0.6, 0.8);
    expect(Math.hypot(x, y)).toBeCloseTo(1, 10);
    expect(Math.atan2(y, x)).toBeCloseTo(Math.atan2(0.8, 0.6), 10);
    const [dx, dy] = shapeStick(0.3, 0.3);
    expect(Math.hypot(dx, dy)).toBeCloseTo(shapeAxis(Math.hypot(0.3, 0.3)), 10);
    expect(dx).toBeCloseTo(dy, 12);
    expect(Math.hypot(...shapeStick(1, 1))).toBeCloseTo(1, 10);
  });

  it('maps sticks, triggers and fresh button presses per context', () => {
    expect(AIM_DEADZONE).toBeGreaterThan(0.187);
    expect(padFrame('aim', pad([0, 0, 0.187103, 0])).rates.yaw).toBe(0);
    expect(padFrame('drive', pad([0, 0, 0.187103, 0])).rates.yaw).toBe(0);
    expect(padFrame('aim', pad([0, 0, 0.35, 0])).rates.yaw).toBeLessThan(0);
    const aim = padFrame('aim', pad([-1, 0, 0, -1], { [PAD.RT]: 1 }));
    expect(aim.rates.yaw).toBeCloseTo(AIM_SPEED.yaw);        // left stick left → bearing left
    expect(aim.rates.pitch).toBeCloseTo(AIM_SPEED.pitch);    // right stick up (negative y) → elevation up
    expect(aim.rates.power).toBeCloseTo(AIM_SPEED.power);
    // A full diagonal is length 1 after the radial clamp: each axis gets cos 45°.
    expect(padFrame('aim', pad([-1, -1, 0, 0])).rates.yaw).toBeCloseTo(AIM_SPEED.yaw * Math.SQRT1_2);
    expect(aim.drive).toEqual({ throttle: 0, steer: 0 });
    expect(padFrame('drive', pad([0, -1, 0, 0])).drive).toEqual({ throttle: 1, steer: 0 });
    const drive = padFrame('drive', pad([0.6, -0.8, 0, 0]));
    expect(drive.drive.throttle).toBeCloseTo(0.8);
    expect(drive.drive.steer).toBeCloseTo(0.6);
    expect(drive.rates.yaw).toBe(0);
    expect(padFrame('watch', pad([1, 1, 1, 1], { [PAD.RT]: 1 })).rates).toEqual({ yaw: 0, pitch: 0, power: 0 });
    // Presses are edges: held A fires once.
    const down = pad([0, 0, 0, 0], { [PAD.A]: 1 });
    expect(padFrame('aim', down).presses).toEqual(['fire']);
    expect(padFrame('aim', down, down).presses).toEqual([]);
    expect(padFrame('menu', pad([0, 0, 0, 0], { [PAD.B]: 1 })).presses).toEqual(['back']);
    expect(padFrame('watch', pad([0, 0, 0, 0], { [PAD.START]: 1 })).presses).toEqual(['pause']);
    expect(PAD_PRESS.menu[PAD.A]).toBe('confirm');
  });

  it('reads nothing without the Gamepad API or a connected pad', () => {
    expect(readGamepad(undefined)).toBeUndefined();
    expect(readGamepad({ getGamepads: () => [null] })).toBeUndefined();
    expect(readGamepad({ getGamepads: () => { throw new Error('blocked'); } })).toBeUndefined();
    const fake = { connected: true, mapping: 'standard', axes: [0.5, 0, 0, 0], buttons: [{ value: 0, pressed: true }, { value: 0.3, pressed: false }] } as unknown as Gamepad;
    expect(readGamepad({ getGamepads: () => [fake] })).toEqual({ axes: [0.5, 0, 0, 0], buttons: [1, 0.3] });
  });
});

describe('keyboard and drag aim', () => {
  it('leaves form controls their native keys', () => {
    expect(nativeKey({ tagName: 'INPUT', type: 'range' }, 'ArrowLeft')).toBe(true);
    expect(nativeKey({ tagName: 'INPUT', type: 'range' }, 'KeyA')).toBe(false);
    expect(nativeKey({ tagName: 'INPUT', type: 'range' }, 'Space')).toBe(false);
    expect(nativeKey({ tagName: 'INPUT', type: 'number' }, 'KeyA')).toBe(true);
    expect(nativeKey({ tagName: 'INPUT', type: 'number' }, 'Escape')).toBe(false);
    expect(nativeKey({ tagName: 'SELECT' }, 'ArrowDown')).toBe(true);
    expect(nativeKey({ tagName: 'BUTTON' }, 'Space')).toBe(true);
    expect(nativeKey({ tagName: 'BUTTON' }, 'KeyW')).toBe(false);
    expect(nativeKey({ tagName: 'DIV' }, 'Space')).toBe(false);
    expect(nativeKey(null, 'Space')).toBe(false);
    const keys = new KeyState();
    keys.down('KeyA'); keys.down('KeyA'); keys.down('KeyW'); keys.up('KeyW');
    expect([...keys.codes]).toEqual(['KeyA']);
    keys.clear();
    expect(keys.codes.size).toBe(0);
  });

  it('solves the turret bearing from a screen drag in the tank ground plane', () => {
    // Top-down camera: forward is screen up, driver-left is screen left.
    const frame = { origin: [400, 300] as const, forward: [400, 250] as const, left: [350, 300] as const };
    expect(solveDragAim(frame, [400, 200])).toBeCloseTo(0);
    expect(solveDragAim(frame, [300, 300])).toBeCloseTo(Math.PI / 2);
    expect(solveDragAim(frame, [500, 300])).toBeCloseTo(-Math.PI / 2);
    expect(Math.abs(solveDragAim(frame, [400, 400])!)).toBeCloseTo(Math.PI);
    expect(solveDragAim(frame, [300, 200])).toBeCloseTo(Math.PI / 4);
    // A foreshortened, rotated view still recovers the ground-plane angle.
    const oblique = { origin: [0, 0] as const, forward: [30, -10] as const, left: [-12, -40] as const };
    const yaw = 0.7, pointer = [Math.cos(yaw) * 30 * 3 + Math.sin(yaw) * -12 * 3, Math.cos(yaw) * -10 * 3 + Math.sin(yaw) * -40 * 3] as const;
    expect(solveDragAim(oblique, pointer)).toBeCloseTo(yaw, 10);
    // Too short, or an edge-on camera.
    expect(solveDragAim(frame, [402, 301])).toBeNull();
    expect(solveDragAim({ origin: [0, 0], forward: [10, 0], left: [20, 0] }, [50, 50])).toBeNull();
  });

  it('maps drag length to power and grabs only near the tank', () => {
    expect(dragPower([0, 0], [0, 2], 100)).toBe(0.05);
    expect(dragPower([0, 0], [60, 80], 200)).toBeCloseTo(0.5);
    expect(dragPower([0, 0], [0, 500], 200)).toBe(1);
    expect(grabRadius(1280, 720)).toBeCloseTo(43.2);
    expect(grabRadius(390, 844)).toBe(28);
    expect(grabRadius(4000, 3000)).toBe(64);
  });
});
