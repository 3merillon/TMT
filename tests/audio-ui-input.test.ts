import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AudioManager } from '../src/audio/audio-manager';
import type { SfxBank } from '../src/audio/sfx-bank';
import { installUiSounds, setUiBank } from '../src/audio/sfx/ui';

class Button extends EventTarget {
  disabled = false;
  ariaDisabled = false;
  isConnected = true;
  getAttribute(name: string) { return name === 'aria-disabled' && this.ariaDisabled ? 'true' : null; }
  closest() { return this; }
  getBoundingClientRect() { return { left: 100, right: 200, top: 100, bottom: 200 }; }
}

afterEach(() => { setUiBank(null); vi.unstubAllGlobals(); });

function harness() {
  vi.stubGlobal('Element', Button);
  const win = new EventTarget(), doc = Object.assign(new EventTarget(), { defaultView: win, hidden: false });
  // Node's EventTarget needs the options object to remove a capture listener; browsers accept the boolean too.
  doc.removeEventListener = (type, listener, options) => EventTarget.prototype.removeEventListener.call(doc, type, listener,
    typeof options === 'boolean' ? { capture: options } : options);
  const sounds: string[] = [];
  setUiBank({ ready: true, sprite: () => ({}), play: (_manager: AudioManager, sprite: string) => { sounds.push(sprite); return null; } } as unknown as SfxBank);
  const dispose = installUiSounds({} as AudioManager, doc as unknown as Document);
  const button = new Button();
  const send = (type: string, values: Partial<PointerEvent> = {}, target: EventTarget = button) => {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      pointerId: 1, pointerType: 'touch', button: 0, isPrimary: true, clientX: 150, clientY: 150, detail: 1, ...values,
    });
    Object.defineProperty(event, 'target', { value: target });
    doc.dispatchEvent(event);
    return event;
  };
  return { win, doc, button, sounds, dispose, send };
}

describe('delegated UI button sounds', () => {
  it.each(['enabled', 'disabled', 'aria-disabled'])('waits for a real %s button tap without preventing scrolling', state => {
    const h = harness();
    h.button.disabled = state === 'disabled'; h.button.ariaDisabled = state === 'aria-disabled';
    expect(h.send('pointerdown').defaultPrevented).toBe(false);
    expect(h.sounds).toEqual([]);
    expect(h.send('pointermove', { clientY: 155 }).defaultPrevented).toBe(false);
    expect(h.send('pointerup', { clientY: 155 }).defaultPrevented).toBe(false);
    expect(h.sounds).toEqual([state === 'enabled' ? 'ui-click' : 'ui-denied']);
    h.send('click');
    h.send('click', { pointerType: '' }); // Legacy compatibility click.
    expect(h.sounds).toHaveLength(1);
    h.dispose();
  });

  it.each([false, true])('keeps drags silent even if they return to a disabled=%s starting button', disabled => {
    const h = harness(); h.button.disabled = disabled;
    h.send('pointerdown');
    h.send('pointermove', { clientY: 175 });
    h.send('pointermove'); h.send('pointerup'); h.send('click');
    expect(h.sounds).toEqual([]);
    h.send('pointerdown'); h.send('pointerup', { clientY: 175 }); // Release may arrive without a final move.
    expect(h.sounds).toEqual([]);
    h.dispose();
  });

  it.each(['pointercancel', 'lostpointercapture', 'scroll', 'blur', 'hidden'])('cancels a pending cue on %s', ending => {
    const h = harness(); h.button.disabled = true;
    h.send('pointerdown');
    if (ending === 'blur') h.win.dispatchEvent(new Event('blur'));
    else if (ending === 'hidden') { h.doc.hidden = true; h.doc.dispatchEvent(new Event('visibilitychange')); }
    else h.send(ending);
    h.send('pointerup'); h.send('click');
    expect(h.sounds).toEqual([]);
    h.doc.hidden = false;
    h.send('pointerdown'); h.send('pointerup');
    expect(h.sounds).toEqual(['ui-denied']);
    h.dispose();
  });

  it('tracks separate fingers so a HUD tap still sounds while another finger is down or dragging', () => {
    const h = harness(), second = new Button();
    h.send('pointerdown'); h.send('pointermove', { clientY: 180 });
    for (const pointerId of [2, 3]) {
      h.send('pointerdown', { pointerId, isPrimary: false }, second);
      h.send('pointerup', { pointerId, isPrimary: false }, second);
    }
    h.send('pointerup');
    expect(h.sounds).toEqual(['ui-click', 'ui-click']);
    h.dispose();
  });

  it('preserves mouse and keyboard activation without duplicate pointer click cues', () => {
    const h = harness();
    h.send('pointerdown', { pointerType: 'mouse' }); h.send('pointerup', { pointerType: 'mouse' });
    h.send('click', { pointerType: 'mouse' });
    expect(h.sounds).toEqual(['ui-click']);
    h.send('click', { pointerType: '', detail: 0 }); // Keyboard and .click().
    expect(h.sounds).toEqual(['ui-click', 'ui-click']);
    h.send('pointerdown', { pointerType: 'mouse', button: 2 }); h.send('pointerup', { pointerType: 'mouse', button: 2 });
    expect(h.sounds).toHaveLength(2);
    h.dispose();
  });

  it('requires the original connected button and an in-bounds release, even with pointer capture', () => {
    const h = harness();
    h.send('pointerup');
    h.send('pointerdown'); h.send('pointerup', {}, new Button());
    h.send('pointerdown', { clientX: 198 }); h.send('pointerup', { clientX: 201 });
    h.send('pointerdown'); h.button.isConnected = false; h.send('pointerup');
    expect(h.sounds).toEqual([]);
    h.button.isConnected = true;
    h.send('pointerdown'); h.button.disabled = true; h.send('pointerup');
    expect(h.sounds).toEqual(['ui-denied']);
    h.dispose();
  });

  it('clears pending presses and removes listeners on disposal', () => {
    const h = harness();
    h.send('pointerdown'); h.dispose(); h.send('pointerup');
    h.send('pointerdown'); h.send('pointerup'); h.send('click', { pointerType: '', detail: 0 });
    expect(h.sounds).toEqual([]);
  });
});
