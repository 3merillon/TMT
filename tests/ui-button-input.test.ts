import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountJoystick } from '../src/game/ui/components/joystick';
import { bindButtonPress } from '../src/game/ui/input/button';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function send(target: EventTarget, type: string, values: Partial<PointerEvent> = {}) {
  const event = Object.assign(new Event(type, { cancelable: true }), {
    pointerId: 2, pointerType: 'touch', button: 0, isPrimary: false,
    clientX: 250, clientY: 250, detail: 0, ...values,
  });
  target.dispatchEvent(event);
  return event;
}

function harness() {
  const win = new EventTarget(), doc = Object.assign(new EventTarget(), { defaultView: win, hidden: false });
  const captured = new Set<number>();
  const button = Object.assign(new EventTarget(), {
    ownerDocument: doc, disabled: false,
    getBoundingClientRect: () => ({ left: 200, top: 200, right: 300, bottom: 300 }),
    setPointerCapture: (id: number) => { captured.add(id); },
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => {
      captured.delete(id);
      send(button, 'lostpointercapture', { pointerId: id });
    },
  });
  const press = vi.fn(), dispose = bindButtonPress(button as unknown as HTMLButtonElement, press);
  return { button, win, doc, captured, press, dispose, send: (type: string, values?: Partial<PointerEvent>) => send(button, type, values) };
}

describe('HUD button pointer input', () => {
  it('fires repeatedly with a second finger while the joystick keeps driving, without compatibility clicks', () => {
    const h = harness();
    vi.stubGlobal('window', h.win); vi.stubGlobal('document', h.doc);
    const captured = new Set<number>(), classes = new Set<string>();
    const zone = Object.assign(new EventTarget(), {
      classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) },
      setPointerCapture: (id: number) => { captured.add(id); },
      hasPointerCapture: (id: number) => captured.has(id),
      releasePointerCapture: (id: number) => { captured.delete(id); },
    });
    const base = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) };
    const knob = { style: { transform: '' } }, drive = vi.fn(), release = vi.fn();
    const joystick = mountJoystick(zone as unknown as HTMLElement, base as HTMLElement, knob as HTMLElement, {
      enabled: () => true, set: drive, release,
    });
    send(zone, 'pointerdown', { pointerId: 1, isPrimary: true, clientX: 50, clientY: 0 });
    expect(drive).toHaveBeenLastCalledWith(0, -1);
    for (const pointerId of [2, 3, 4]) {
      h.send('pointerdown', { pointerId, isPrimary: false });
      expect(h.press).toHaveBeenCalledTimes(pointerId - 2);
      h.send('pointerup', { pointerId, isPrimary: false });
      expect(h.press).toHaveBeenCalledTimes(pointerId - 1);
      expect(captured.has(1)).toBe(true);
      expect(release).not.toHaveBeenCalled();
    }
    send(zone, 'pointermove', { pointerId: 1, clientX: 100, clientY: 50 });
    expect(drive).toHaveBeenLastCalledWith(1, 0);
    send(zone, 'pointerup', { pointerId: 1 });
    expect(release).toHaveBeenCalledOnce();
    expect(captured.size).toBe(0);
    expect(knob.style.transform).toBe('');
    joystick.dispose(); h.dispose();
  });

  it.each(['touch', 'pen'])('activates %s release once and ignores native or legacy duplicate clicks', pointerType => {
    const h = harness();
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    expect(h.send('pointerdown', { pointerType }).defaultPrevented).toBe(true);
    h.send('pointerup', { pointerType });
    expect(h.press).toHaveBeenCalledOnce();
    expect(h.captured.size).toBe(0);
    expect(h.send('click', { pointerType, detail: 1 }).defaultPrevented).toBe(true);
    expect(h.send('click', { pointerType: '', detail: 1 }).defaultPrevented).toBe(true);
    expect(h.press).toHaveBeenCalledOnce();
    h.dispose();
  });

  it.each(['pointercancel', 'lostpointercapture', 'blur', 'hidden'])('cancels on %s without firing or resuming on a stale release', ending => {
    const h = harness();
    h.send('pointerdown');
    expect(h.captured.has(2)).toBe(true);
    if (ending === 'blur') h.win.dispatchEvent(new Event('blur'));
    else if (ending === 'hidden') { h.doc.hidden = true; h.doc.dispatchEvent(new Event('visibilitychange')); }
    else h.send(ending);
    h.send('pointerup');
    expect(h.press).not.toHaveBeenCalled();
    expect(h.captured.size).toBe(0);
    h.doc.hidden = false;
    h.send('pointerdown', { pointerId: 3 }); h.send('pointerup', { pointerId: 3 });
    expect(h.press).toHaveBeenCalledOnce();
    h.dispose();
  });

  it('ignores unrelated pointers and does not activate when the finger releases outside the button', () => {
    const h = harness();
    h.send('pointerdown');
    h.send('pointerdown', { pointerId: 3 });
    h.send('pointerup', { pointerId: 3 });
    expect(h.press).not.toHaveBeenCalled();
    expect(h.captured.has(2)).toBe(true);
    h.send('pointermove', { clientX: 350 });
    h.send('pointerup', { clientX: 350 });
    expect(h.press).not.toHaveBeenCalled();
    expect(h.captured.size).toBe(0);
    h.send('click', { detail: 1 });
    expect(h.press).not.toHaveBeenCalled();
    h.dispose();
  });

  it('honors disabled state both when a press starts and when it ends', () => {
    const h = harness();
    h.button.disabled = true;
    h.send('pointerdown');
    expect(h.captured.size).toBe(0);
    h.button.disabled = false; h.send('pointerup');
    expect(h.press).not.toHaveBeenCalled();
    h.send('pointerdown'); h.button.disabled = true; h.send('pointerup');
    expect(h.press).not.toHaveBeenCalled();
    expect(h.captured.size).toBe(0);
    for (const event of [{ pointerType: 'mouse', detail: 1 }, { pointerType: '', detail: 0 }]) h.send('click', event);
    expect(h.press).not.toHaveBeenCalled();
    h.dispose();
  });

  it('preserves mouse clicks and keyboard or programmatic activation, including immediately after touch', () => {
    const h = harness();
    expect(h.send('pointerdown', { pointerType: 'mouse' }).defaultPrevented).toBe(false);
    h.send('pointerup', { pointerType: 'mouse' });
    expect(h.press).not.toHaveBeenCalled();
    expect(h.send('click', { pointerType: 'mouse', detail: 1 }).defaultPrevented).toBe(false);
    expect(h.press).toHaveBeenCalledOnce();
    h.send('pointerdown'); h.send('pointerup');
    h.send('click', { pointerType: 'mouse', detail: 1 });
    h.send('click', { pointerType: '', detail: 0 });
    h.button.dispatchEvent(new Event('click'));
    expect(h.press).toHaveBeenCalledTimes(5);
    h.dispose();
  });

  it('releases an active press and removes listeners when disposed', () => {
    const h = harness();
    h.send('pointerdown'); h.dispose();
    expect(h.captured.size).toBe(0);
    h.send('pointerup'); h.send('click', { pointerType: 'mouse', detail: 1 });
    h.send('pointerdown'); h.send('pointerup');
    h.win.dispatchEvent(new Event('blur'));
    h.doc.hidden = true; h.doc.dispatchEvent(new Event('visibilitychange'));
    expect(h.press).not.toHaveBeenCalled();
    expect(h.captured.size).toBe(0);
  });
});
