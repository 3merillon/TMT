import { ACTION_LABELS, bindingActions, defaultKeyBindings, keyLabel, rebindKey, validBindingCode, type BindableAction, type BindingContext } from '../input/bindings';
import { button, segmented } from '../components/controls';
import { el } from '../components/el';
import type { ScreenContext } from './context';

export function keyBindings(ctx: ScreenContext): HTMLElement {
  let mode: BindingContext = 'drive';
  let pending: { action: BindableAction; slot: number; button: HTMLButtonElement } | undefined;
  const status = el('p', { class: 'field-hint binding-status', role: 'status', 'aria-live': 'polite', text: 'Click a key, then press its replacement. Escape cancels; Delete clears a slot. Conflicting keys swap within this mode.' });
  const rows = el('div', { class: 'binding-list' });
  const cancel = () => {
    if (!pending) return;
    const { action, slot, button: target } = pending;
    target.textContent = ctx.profile.settings.controls.bindings[mode][action]?.[slot] ? keyLabel(ctx.profile.settings.controls.bindings[mode][action]![slot]) : '+ Key';
    target.classList.remove('is-listening'); pending = undefined;
  };
  const draw = () => {
    cancel();
    rows.replaceChildren(...bindingActions(mode).map(action => {
      const keys = ctx.profile.settings.controls.bindings[mode][action] ?? [];
      return el('div', { class: 'binding-row' }, el('span', { class: 'field-label', text: ACTION_LABELS[action] }),
        el('div', { class: 'binding-keys' }, ...Array.from({ length: Math.min(3, keys.length + 1) }, (_, slot) => {
          const target = button(keys[slot] ? keyLabel(keys[slot]) : '+ Key', () => {
            cancel(); pending = { action, slot, button: target };
            target.textContent = 'Press a key…'; target.classList.add('is-listening'); target.focus();
            status.textContent = `${ACTION_LABELS[action]}: press a key. Escape cancels; Delete clears. Browser shortcuts with Ctrl, Alt or Command are reserved.`;
          }, { id: `bind-${mode}-${action}-${slot}`, variant: 'quiet', class: 'binding-key' });
          target.setAttribute('aria-label', `${ACTION_LABELS[action]}, ${keys[slot] ? keyLabel(keys[slot]) : 'add key'}`);
          target.addEventListener('blur', () => { if (pending?.button === target) cancel(); });
          return target;
        }), action === 'pause' ? el('kbd', { class: 'binding-fixed', title: 'Escape always pauses', text: 'Esc' }) : null));
    }));
  };
  const root = el('div', { class: 'key-bindings' },
    segmented('Control mode', [{ id: 'drive', label: 'Driving' }, { id: 'aim', label: 'Turn-based aim' }, { id: 'watch', label: 'Spectating' }], mode, (value: BindingContext) => { cancel(); mode = value; draw(); }, 'set-binding-mode'),
    status, rows,
    button('Reset keys for this mode', () => {
      cancel();
      const bindings = { ...ctx.profile.settings.controls.bindings, [mode]: defaultKeyBindings()[mode] };
      ctx.updateSettings({ controls: { bindings } }); draw(); status.textContent = 'Default keys restored for this mode.';
    }, { id: 'bindings-reset', variant: 'quiet' }));
  root.addEventListener('keydown', event => {
    if (!pending) return;
    event.preventDefault(); event.stopPropagation();
    if (event.repeat) return;
    if (event.code === 'Escape') { cancel(); status.textContent = 'Key change cancelled.'; return; }
    if (event.ctrlKey || event.altKey || event.metaKey || (event.code !== 'Delete' && !validBindingCode(event.code))) {
      status.textContent = 'Choose a letter, number, arrow, punctuation key, Shift, Space, Tab or Enter. Escape cancels.'; return;
    }
    const { action, slot, button: target } = pending, id = target.id;
    const bindings = rebindKey(ctx.profile.settings.controls.bindings, mode, action, slot, event.code === 'Delete' ? undefined : event.code);
    cancel(); ctx.updateSettings({ controls: { bindings } }); draw();
    root.querySelector<HTMLButtonElement>(`#${id}`)?.focus();
    status.textContent = event.code === 'Delete' ? `${ACTION_LABELS[action]} key cleared.` : `${ACTION_LABELS[action]} bound to ${keyLabel(event.code)}. Any conflicting key was swapped.`;
  }, true);
  draw(); return root;
}
