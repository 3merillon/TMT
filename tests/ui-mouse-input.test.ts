import { describe, expect, it, vi } from 'vitest';
import type { GameSnapshot } from '../src/game/contracts';
import { DEFAULT_LOADOUT } from '../src/game/modules';
import type { MatchActions } from '../src/game/ui/actions';
import { InputController } from '../src/game/ui/input/controller';
import type { ContextInput } from '../src/game/ui/input/contexts';
import { bindMouseAim, wheelRangeScale } from '../src/game/ui/input/mouse';

function pointerHarness() {
  const handlers = new Map<string, (event: PointerEvent) => void>();
  const win = new EventTarget(), doc = Object.assign(new EventTarget(), { defaultView: win, hidden: false });
  const captured = new Set<number>();
  const canvas = {
    setPointerCapture: vi.fn((id: number) => captured.add(id)),
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: vi.fn((id: number) => captured.delete(id)),
    parentElement: { focus: vi.fn() },
    getBoundingClientRect: () => ({ left: 10, top: 20 }),
  } as unknown as HTMLCanvasElement;
  const root = {
    clientHeight: 800,
    ownerDocument: doc,
    addEventListener: vi.fn((type: string, handler: (event: PointerEvent) => void) => handlers.set(type, handler)),
    removeEventListener: vi.fn((type: string) => handlers.delete(type)),
  };
  let enabled = true;
  const point = vi.fn(), end = vi.fn(), adjustRange = vi.fn(() => true);
  const binding = bindMouseAim(root as unknown as HTMLElement, { canvas: () => canvas, enabled: () => enabled, point, end, adjustRange });
  const send = (type: string, overrides: Partial<PointerEvent & WheelEvent> = {}) => {
    const event = { type, target: canvas, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: 100, clientY: 100,
      deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false,
      defaultPrevented: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...overrides };
    handlers.get(type)?.(event as unknown as PointerEvent);
    return event;
  };
  return { binding, canvas, root, win, doc, point, end, adjustRange, send, captured, setEnabled: (value: boolean) => { enabled = value; } };
}

describe('left-mouse world targeting', () => {
  it('claims only left-button targeting, leaves right-drag to the camera and uses canvas coordinates', () => {
    const h = pointerHarness();
    for (const ignored of [{ button: 2, buttons: 2 }, { pointerType: 'touch' }, { target: {} as EventTarget }, { defaultPrevented: true }]) {
      expect(h.send('pointerdown', ignored).stopPropagation).not.toHaveBeenCalled();
    }
    h.setEnabled(false);
    expect(h.send('pointerdown').stopPropagation).not.toHaveBeenCalled();
    h.setEnabled(true);
    expect(h.send('pointerdown').stopPropagation).toHaveBeenCalledOnce();
    expect(h.canvas.setPointerCapture).toHaveBeenCalledWith(1);
    expect(h.point).toHaveBeenLastCalledWith([90, 80]);
    h.send('pointermove', { clientX: 104, clientY: 98 });
    expect(h.point).toHaveBeenLastCalledWith([94, 78]);
    h.send('pointermove', { clientX: 105, clientY: 97, shiftKey: true });
    expect(h.point).toHaveBeenLastCalledWith([95, 77]);
    h.binding.dispose();
  });

  it('uses the range wheel only during an active left-button aim and returns it to zoom on release', () => {
    const h = pointerHarness();
    expect(h.send('wheel', { deltaY: -100 }).preventDefault).not.toHaveBeenCalled();
    expect(h.adjustRange).not.toHaveBeenCalled();
    h.send('pointerdown');
    expect(h.send('wheel', { deltaY: -100 }).stopPropagation).toHaveBeenCalledOnce();
    expect(h.adjustRange).toHaveBeenLastCalledWith(Math.exp(0.05));
    h.send('wheel', { deltaY: 100, shiftKey: true });
    expect(h.adjustRange).toHaveBeenLastCalledWith(Math.exp(-0.05)); // Shift has no special behavior.
    for (const ignored of [{ ctrlKey: true }, { metaKey: true }, { target: {} as EventTarget }, { defaultPrevented: true }]) {
      h.adjustRange.mockClear();
      expect(h.send('wheel', { deltaY: -100, ...ignored }).preventDefault).not.toHaveBeenCalled();
      expect(h.adjustRange).not.toHaveBeenCalled();
    }
    h.send('pointerup');
    expect(h.send('wheel', { deltaY: -100 }).preventDefault).not.toHaveBeenCalled();
    expect(h.adjustRange).not.toHaveBeenCalled();
    h.send('pointerdown'); h.setEnabled(false);
    expect(h.send('wheel', { deltaY: -100 }).preventDefault).not.toHaveBeenCalled();
    expect(h.captured.size).toBe(0);
    h.binding.dispose();
  });

  it('normalizes range wheel devices, retains fractional precision and caps large deltas', () => {
    const wheel = (deltaY: number, deltaMode = 0) => ({ deltaY, deltaMode });
    expect(wheelRangeScale(wheel(-100), 800)).toBeCloseTo(Math.exp(0.05));
    expect(wheelRangeScale(wheel(-3, 1), 800)).toBe(wheelRangeScale(wheel(-48), 800));
    expect(wheelRangeScale(wheel(-0.1, 2), 800)).toBe(wheelRangeScale(wheel(-80), 800));
    expect(wheelRangeScale(wheel(-0.5), 800)).toBeCloseTo(Math.exp(0.00025));
    expect(wheelRangeScale(wheel(-800), 800)).toBe(Math.exp(0.12));
    expect(wheelRangeScale(wheel(1, 2), 800)).toBe(Math.exp(-0.12));
    expect(wheelRangeScale(wheel(-100), 800) * wheelRangeScale(wheel(100), 800)).toBeCloseTo(1, 12);
    expect(wheelRangeScale(wheel(Number.NaN), 800)).toBe(1);
  });

  it('releases capture on up, cancellation, loss, pause, blur and hiding without resuming stale movement', () => {
    for (const end of ['pointerup', 'pointercancel', 'lostpointercapture', 'pause', 'blur', 'hidden', 'context', 'buttons']) {
      const h = pointerHarness();
      h.send('pointerdown');
      expect(h.captured.has(1)).toBe(true);
      h.point.mockClear();
      if (end === 'pause') h.binding.clear();
      else if (end === 'blur') h.win.dispatchEvent(new Event('blur'));
      else if (end === 'hidden') { h.doc.hidden = true; h.doc.dispatchEvent(new Event('visibilitychange')); }
      else if (end === 'context') { h.setEnabled(false); h.send('pointermove'); }
      else if (end === 'buttons') h.send('pointermove', { buttons: 0 });
      else h.send(end);
      expect(h.captured.size).toBe(0);
      h.setEnabled(true);
      h.send('pointermove', { clientX: 1000, clientY: 0 });
      expect(h.point).not.toHaveBeenCalled();
      expect(h.end).toHaveBeenCalled();
      h.binding.dispose();
      expect(h.root.removeEventListener).toHaveBeenCalledTimes(6);
    }
  });

  it('aims during WASD driving, wraps yaw, clamps elevation and preserves power', () => {
    const tank = { turretYaw: 3.1, barrelPitch: 1.39, power: 0.57, loadout: DEFAULT_LOADOUT };
    const snapshot = { active: 0, phase: 'resolving', tanks: [tank] } as unknown as GameSnapshot;
    const context: ContextInput = { screen: 'match', snapshot, observer: 0, ready: true, driveTest: true };
    const aim = vi.fn((yaw: number, pitch: number, power: number) => {
      Object.assign(tank, { turretYaw: yaw, barrelPitch: pitch, power }); return true;
    });
    const input = new InputController({ context: () => context, actions: { aim } as unknown as MatchActions, pitch: { min: -0.1, max: 1.4 }, navigate: () => {} });
    input.keys.down('KeyW'); input.keys.down('KeyD');
    expect(input.driveInput()).toEqual({ throttle: 1, steer: 1 });
    expect(input.adjustAim(0.2, 0.2)).toBe(true);
    expect(tank.turretYaw).toBeCloseTo(3.3 - 2 * Math.PI);
    expect(tank.barrelPitch).toBe(1.4);
    expect(tank.power).toBe(0.57);
    expect(input.driveInput()).toEqual({ throttle: 1, steer: 1 });
    expect(input.adjustAim(0, -3)).toBe(true);
    expect(tank.barrelPitch).toBe(-0.1);
    expect(input.adjustAim(Infinity, 0)).toBe(false);
    expect(input.adjustRange(100)).toBe(true);
    expect(tank.power).toBe(1);
    aim.mockClear();
    expect(input.adjustRange(1.05)).toBe(true); // Keep consuming the wheel at the power clamp.
    expect(aim).not.toHaveBeenCalled();
    expect(input.adjustRange(0.0001)).toBe(true);
    expect(tank.power).toBe(0);

    for (const patch of [
      { screen: 'pause' }, { screen: 'title' }, { ready: false }, { observer: 1 }, { driveTest: false },
      { snapshot: { ...snapshot, phase: 'terrain' } }, { snapshot: { ...snapshot, phase: 'finished' } }, { snapshot: undefined },
    ] as Partial<ContextInput>[]) {
      const blocked = { ...context, ...patch };
      const blockedInput = new InputController({ context: () => blocked, actions: { aim } as unknown as MatchActions, pitch: { min: 0, max: 1.4 }, navigate: () => {} });
      aim.mockClear();
      expect(blockedInput.adjustAim(0.1, 0.1)).toBe(false);
      expect(blockedInput.adjustRange(1.05)).toBe(false);
      expect(aim).not.toHaveBeenCalled();
    }
    snapshot.phase = 'aim'; context.driveTest = false;
    expect(input.adjustAim(0.1, 0.1)).toBe(true);
  });
});
