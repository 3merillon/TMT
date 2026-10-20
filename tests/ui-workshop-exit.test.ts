import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkshopScreen } from '../src/game/ui/screens/workshop';
import { PaintSession } from '../src/game/workshop/paint';
import { defaultAppearance } from '../src/game/meta/cosmetics';
import { activeKit, defaultProfile } from '../src/game/meta/profile';

class Element {
  id = ''; className = ''; textContent: string | null = ''; parent: Element | null = null; children: Element[] = []; open = false;
  listeners = new Map<string, ((event: { preventDefault(): void }) => void)[]>();
  setAttribute(key: string, value: string) { if (key === 'id') this.id = value; }
  append(...children: unknown[]) { for (const child of children) if (child instanceof Element) { child.parent = this; this.children.push(child); } }
  addEventListener(type: string, callback: (event: { preventDefault(): void }) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]); }
  querySelector(selector: string): Element | null { return this.children.find(child => `#${child.id}` === selector) ?? this.children.map(child => child.querySelector(selector)).find(Boolean) ?? null; }
  focus() { active = this; }
  click() { this.dispatch('click'); }
  dispatch(type: string) { for (const callback of this.listeners.get(type) ?? []) callback({ preventDefault() {} }); }
  showModal() { this.open = true; } close() { this.open = false; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
}
let active: Element | null = null;
afterEach(() => { vi.unstubAllGlobals(); active = null; });
function editor(saveSucceeds = true) {
  vi.stubGlobal('document', { createElement: () => new Element(), get activeElement() { return active; } });
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  const profile = defaultProfile(), paint = new PaintSession(defaultAppearance(), activeKit(profile));
  paint.change({ ...paint.value, lights: false });
  const root = new Element(), save = vi.fn(() => saveSucceeds), restore = vi.fn();
  const screen = Object.assign(Object.create(WorkshopScreen.prototype) as object, {
    element: root, paint, ctx: { profile, saveProfile: save }, status: new Element(), leaveDialog: null, cancelLeave: null,
    scene: { setAppearance: restore, setPaintMode() {} }, popup: 'paint', draw() {},
  }) as unknown as WorkshopScreen;
  return { screen, root, paint, save, restore, click: (id: string) => { const button = root.querySelector(`#${id}`); expect(button).not.toBeNull(); button!.click(); } };
}
describe('unsaved workshop design transaction', () => {
  it('keeps the drawing on Keep, Escape and duplicate requests; safe focus is the default', () => {
    const f = editor(), leave = vi.fn(), cancel = vi.fn();
    f.screen.requestLeave(leave, cancel);
    expect(active?.id).toBe('workshop-paint-keep');
    const other = vi.fn(), otherCancel = vi.fn(); f.screen.requestLeave(other, otherCancel); expect(otherCancel).toHaveBeenCalledOnce();
    f.click('workshop-paint-keep'); expect(leave).not.toHaveBeenCalled(); expect(other).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce();
    expect(f.screen.hasUnsavedPaint).toBe(true);
    f.screen.requestLeave(leave, cancel); f.root.querySelector('#workshop-paint-confirm')!.dispatch('cancel');
    expect(leave).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledTimes(2);
  });
  it('persists before continuing and never continues when storage fails', () => {
    const f = editor(false), leave = vi.fn(), cancel = vi.fn(); f.screen.requestLeave(leave, cancel); f.click('workshop-paint-confirm-save');
    expect(f.save).toHaveBeenCalledOnce(); expect(leave).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
    expect(f.screen.hasUnsavedPaint).toBe(true); expect(f.root.querySelector('#workshop-paint-confirm')?.open).toBe(true);
    expect(f.root.querySelector('#workshop-paint-save-error')?.textContent).toMatch(/storage.*full|unavailable/i);
    f.save.mockReturnValue(true); f.click('workshop-paint-confirm-save'); expect(leave).toHaveBeenCalledOnce();
    expect(f.screen.hasUnsavedPaint).toBe(false); expect(f.root.querySelector('#workshop-paint-confirm')).toBeNull();
  });
  it('requires explicit discard and skips prompting after undo to the saved state', () => {
    const f = editor(), leave = vi.fn(); f.screen.requestLeave(leave); f.click('workshop-paint-discard');
    expect(f.save).not.toHaveBeenCalled(); expect(f.restore).toHaveBeenCalled(); expect(leave).toHaveBeenCalledOnce();
    const clean = editor(); clean.paint.undo(); expect(clean.screen.hasUnsavedPaint).toBe(false);
    clean.screen.requestLeave(leave); expect(leave).toHaveBeenCalledTimes(2); expect(clean.root.querySelector('#workshop-paint-confirm')).toBeNull();
  });
});
