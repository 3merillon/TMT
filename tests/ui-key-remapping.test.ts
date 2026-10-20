import { describe, expect, it } from 'vitest';
import { defaultKeyBindings, heldActions, isBound, pressAction, rebindKey, sanitizeKeyBindings } from '../src/game/ui/input/bindings';
import { defaultProfile, exportProfile, importProfile } from '../src/game/meta/profile';
import { bindKeyboard, KeyState } from '../src/game/ui/input/keyboard';
import { InputController } from '../src/game/ui/input/controller';
import type { MatchActions } from '../src/game/ui/actions';
import type { ContextInput } from '../src/game/ui/input/contexts';

describe('saved keyboard bindings', () => {
  it('routes target and weapon hotkeys without firing, and ignores them in menus', () => {
    let context = { screen: 'match', ready: true, driveTest: true, observer: 0,
      snapshot: { phase: 'aim', active: 0, tanks: [{ health: 100 }] } } as ContextInput;
    const selected: string[] = [], targets: number[] = [];
    const input = new InputController({ context: () => context, actions: { munition: id => { selected.push(id); return true; } } as MatchActions,
      pitch: { min: 0, max: 1 }, navigate: () => {}, nextTarget: () => { targets.push(1); } });
    input.press('nextTarget');
    for (const action of ['weapon1', 'weapon2', 'weapon3', 'weapon4'] as const) input.press(action);
    expect(selected).toEqual(['explosive', 'heavy', 'incendiary', 'nuclear']); expect(targets).toHaveLength(1);
    context = { ...context, screen: 'pause' }; input.press('nextTarget'); input.press('weapon2');
    expect(targets).toHaveLength(1); expect(selected).toHaveLength(4);
  });
  it('swaps conflicts only in the edited mode and removes the old action from the new key', () => {
    const bindings = rebindKey(defaultKeyBindings(), 'drive', 'fire', 0, 'KeyW');
    expect(pressAction('drive', 'KeyW', bindings)).toBe('fire');
    expect(pressAction('drive', 'Space', bindings)).toBeUndefined();
    expect(heldActions('drive', ['KeyW'], bindings)).toEqual(new Set());
    expect(heldActions('drive', ['Space'], bindings)).toEqual(new Set(['driveForward']));
    expect(heldActions('aim', ['KeyW'], bindings)).toEqual(new Set(['elevationUp']));
    expect(pressAction('aim', 'Space', bindings)).toBe('fire');
  });
  it('round-trips remapped and explicitly unbound keys through profile JSON', () => {
    const profile = defaultProfile();
    profile.settings.controls.bindings = rebindKey(rebindKey(profile.settings.controls.bindings, 'drive', 'fire', 0, 'KeyJ'), 'drive', 'endMove', 0);
    const imported = importProfile(exportProfile(profile));
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const bindings = imported.profile.settings.controls.bindings;
    expect(pressAction('drive', 'KeyJ', bindings)).toBe('fire');
    expect(isBound('drive', 'Space', bindings)).toBe(false);
    expect(isBound('drive', 'Enter', bindings)).toBe(false);
    expect(pressAction('drive', 'Escape', bindings)).toBe('pause');
    expect(pressAction('menu', 'Enter', bindings)).toBe('confirm');
  });
  it('sanitises partial/corrupt imports without losing the Escape fallback', () => {
    const bindings = sanitizeKeyBindings({ drive: { fire: ['KeyW', 'Escape', '<script>', 'KeyW'], driveBack: [], pause: [] } });
    expect(bindings.drive.fire).toEqual(['KeyW']);
    expect(bindings.drive.driveForward).toEqual([]);
    expect(bindings.drive.driveBack).toEqual([]);
    expect(pressAction('drive', 'Escape', bindings)).toBe('pause');
    expect(sanitizeKeyBindings(null)).toEqual(defaultKeyBindings());
    const overLimit = sanitizeKeyBindings({ drive: { fire: ['KeyJ', 'KeyK', 'KeyL', 'KeyW'] } });
    expect(overLimit.drive.fire).toEqual(['KeyJ', 'KeyK', 'KeyL']);
    expect(overLimit.drive.driveForward).toEqual(['KeyW']);
  });
  it('migrates the old default Tab action and adds number keys without overwriting custom bindings', () => {
    const old = sanitizeKeyBindings({ drive: { fire: ['KeyJ'], nextMunition: ['Tab'] } });
    expect(pressAction('drive', 'Tab', old)).toBe('nextTarget');
    expect(pressAction('drive', 'Digit1', old)).toBe('weapon1');
    expect(pressAction('drive', 'KeyJ', old)).toBe('fire');
    const custom = sanitizeKeyBindings({ drive: { fire: ['Digit1'], nextMunition: ['KeyK'], nextTarget: [] } });
    expect(pressAction('drive', 'Digit1', custom)).toBe('fire');
    expect(pressAction('drive', 'KeyK', custom)).toBe('nextMunition');
    expect(pressAction('drive', 'Tab', custom)).toBeUndefined();
  });
  it('uses new bindings immediately in the keyboard event path, skips repeats and releases keys', () => {
    const target = Object.assign(new EventTarget(), { document: new EventTarget() });
    const keys = new KeyState(), actions: string[] = [];
    let bindings = defaultKeyBindings();
    const dispose = bindKeyboard(target as unknown as Window, { keys, context: () => 'drive', bindings: () => bindings, onPress: action => actions.push(action) });
    const send = (type: string, code: string, repeat = false) => target.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { code, repeat }));
    bindings = rebindKey(bindings, 'drive', 'fire', 0, 'KeyJ');
    expect(send('keydown', 'KeyJ')).toBe(false);
    send('keydown', 'KeyJ', true); send('keyup', 'KeyJ'); send('keydown', 'Space');
    expect(actions).toEqual(['fire']); expect(keys.has('KeyJ')).toBe(false);
    send('keydown', 'Escape'); expect(actions.at(-1)).toBe('pause');
    dispose(); send('keydown', 'KeyJ'); expect(actions).toHaveLength(2);
  });
});
