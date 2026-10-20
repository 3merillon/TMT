/**
 * Keyboard input: which codes are held (integrated every frame) and which bound keys were pressed (dispatched
 * once). Form controls keep their native keys: text fields and selects swallow everything, a focused slider keeps
 * its arrow keys, and a focused button keeps Space/Enter, but W/A/S/D, Q/E and Space still reach the tank after a
 * slider was used with the mouse.
 */
import { isBound, pressAction, type InputContext, type PressAction, type KeyboardBindings } from './bindings';

export class KeyState {
  private readonly held = new Set<string>();
  down(code: string): void { this.held.add(code); }
  up(code: string): void { this.held.delete(code); }
  clear(): void { this.held.clear(); }
  has(code: string): boolean { return this.held.has(code); }
  get codes(): ReadonlySet<string> { return this.held; }
}

/** What the key handler needs to know about the event target (a plain object in tests). */
export interface KeyTarget { tagName?: string; type?: string; isContentEditable?: boolean }
/** True when the focused element should keep this key for itself. */
export function nativeKey(target: KeyTarget | null | undefined, code: string): boolean {
  if (!target?.tagName) return false;
  const tag = target.tagName.toUpperCase();
  if (target.isContentEditable || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target.type ?? 'text').toLowerCase();
    if (type === 'range') return code.startsWith('Arrow') || code === 'Home' || code === 'End' || code === 'PageUp' || code === 'PageDown';
    if (type === 'checkbox' || type === 'radio') return code === 'Space' || code.startsWith('Arrow');
    return code !== 'Escape' && code !== 'Tab';
  }
  if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY') return code === 'Space' || code === 'Enter' || code === 'NumpadEnter';
  return false;
}

export interface KeyboardBinding {
  keys: KeyState;
  context(): InputContext;
  bindings?(): KeyboardBindings;
  onPress(action: PressAction, event: KeyboardEvent): void;
}
export function bindKeyboard(target: Window, binding: KeyboardBinding): () => void {
  const { keys } = binding;
  const down = (event: KeyboardEvent) => {
    const context = binding.context();
    if (nativeKey(event.target as KeyTarget | null, event.code)) return;
    if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;
    if (context !== 'menu' && isBound(context, event.code, binding.bindings?.())) event.preventDefault();
    keys.down(event.code);
    if (event.repeat) return;
    const action = pressAction(context, event.code, binding.bindings?.());
    if (action) binding.onPress(action, event);
  };
  const up = (event: KeyboardEvent) => { keys.up(event.code); };
  const clear = () => keys.clear();
  target.addEventListener('keydown', down);
  target.addEventListener('keyup', up);
  target.addEventListener('blur', clear);
  target.addEventListener('pagehide', clear);
  target.document.addEventListener('visibilitychange', clear);
  return () => {
    target.removeEventListener('keydown', down);
    target.removeEventListener('keyup', up);
    target.removeEventListener('blur', clear);
    target.removeEventListener('pagehide', clear);
    target.document.removeEventListener('visibilitychange', clear);
  };
}
