import { describe, expect, it } from 'vitest';
import { HELP_BINDING_MODES, helpBindingRows } from '../src/game/ui/help-model';
import { ACTION_LABELS, BINDING_CONTEXTS, bindingActions, defaultKeyBindings, rebindKey } from '../src/game/ui/input/bindings';

describe('field manual keyboard controls', () => {
  it('shows remaps separately for driving, aiming and spectating with intact key names', () => {
    let bindings = defaultKeyBindings();
    bindings = rebindKey(bindings, 'drive', 'fire', 0, 'ShiftLeft');
    bindings = rebindKey(bindings, 'aim', 'fire', 0, 'NumpadEnter');
    bindings = rebindKey(bindings, 'watch', 'overview', 0, 'KeyV');
    expect(helpBindingRows(bindings, 'drive').find(row => row.action === 'fire')?.keys).toEqual(['Left Shift']);
    expect(helpBindingRows(bindings, 'aim').find(row => row.action === 'fire')?.keys).toEqual(['Num Enter']);
    expect(helpBindingRows(bindings, 'watch').find(row => row.action === 'overview')?.keys).toEqual(['V']);
    expect(helpBindingRows(bindings, 'drive').find(row => row.action === 'overview')?.keys).toEqual(['O']);
  });

  it('keeps unbound actions readable without inventing a default shortcut', () => {
    const bindings = defaultKeyBindings();
    bindings.drive.fire = [];
    delete bindings.aim.nextMunition;
    expect(helpBindingRows(bindings, 'drive').find(row => row.action === 'fire')).toEqual({ action: 'fire', label: 'Fire', keys: [] });
    expect(helpBindingRows(bindings, 'aim').find(row => row.action === 'nextMunition')).toEqual({ action: 'nextMunition', label: 'Next munition', keys: [] });
  });

  it('includes reserved Escape even when every editable Pause key is cleared', () => {
    const bindings = defaultKeyBindings();
    for (const context of BINDING_CONTEXTS) {
      bindings[context].pause = [];
      expect(helpBindingRows(bindings, context).find(row => row.action === 'pause')?.keys).toEqual(['Esc']);
    }
  });

  it('covers every bindable action in each input mode using the settings labels', () => {
    const bindings = defaultKeyBindings();
    expect(HELP_BINDING_MODES.map(mode => mode.id)).toEqual(BINDING_CONTEXTS);
    for (const context of BINDING_CONTEXTS) {
      const rows = helpBindingRows(bindings, context);
      expect(rows.map(row => row.action)).toEqual(bindingActions(context));
      for (const row of rows) expect(row.label).toBe(ACTION_LABELS[row.action]);
    }
  });
});
