import { expect, it, vi } from 'vitest';
import { bindGameBrowserInput } from '../src/game/ui/input/browser';

it('cancels native menus, selection and drag without swallowing game input, and cleans up', () => {
  const target = new EventTarget(), listener = vi.fn();
  const dispose = bindGameBrowserInput(target);
  for (const type of ['contextmenu', 'selectstart', 'dragstart']) {
    target.addEventListener(type, listener);
    const event = new Event(type, { cancelable: true });
    expect(target.dispatchEvent(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
  }
  expect(listener).toHaveBeenCalledTimes(3);
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'click', 'keydown', 'input']) {
    expect(target.dispatchEvent(new Event(type, { cancelable: true }))).toBe(true);
  }
  dispose();
  for (const type of ['contextmenu', 'selectstart', 'dragstart']) {
    expect(target.dispatchEvent(new Event(type, { cancelable: true }))).toBe(true);
  }
});

it('installs at capture phase so menu handlers cannot hide browser default actions', () => {
  const target = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
  bindGameBrowserInput(target as unknown as EventTarget);
  for (const [type,, options] of target.addEventListener.mock.calls) {
    expect(['contextmenu', 'selectstart', 'dragstart']).toContain(type);
    expect(options).toEqual({ capture: true, passive: false });
  }
});
