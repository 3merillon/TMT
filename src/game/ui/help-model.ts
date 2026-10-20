/** The field manual reads the same saved bindings and action names as input and Settings → Keys. */
import { ACTION_LABELS, bindingActions, keyLabel, type BindableAction, type BindingContext, type KeyboardBindings } from './input/bindings';

export const HELP_BINDING_MODES: readonly { id: BindingContext; label: string; detail: string }[] = [
  { id: 'drive', label: 'Driving', detail: 'Campaign, realtime matches and free drive use these keys. Classic artillery uses them only during relocation; aiming and firing wait for your next turn.' },
  { id: 'aim', label: 'Turn-based aim', detail: 'Your aiming turn in classic artillery. Movement keys become aim controls. After you fire, the Driving bindings take over for relocation.' },
  { id: 'watch', label: 'Spectating', detail: 'While watching another turn or after your tank is destroyed, only the camera and match menu are available.' },
];

export interface HelpBindingRow { action: BindableAction; label: string; keys: string[] }

export function helpBindingRows(bindings: KeyboardBindings, context: BindingContext): HelpBindingRow[] {
  return bindingActions(context).map(action => ({
    action, label: ACTION_LABELS[action],
    // Escape is reserved by the input layer even if every editable Pause slot was cleared.
    keys: [...new Set([...(bindings[context][action] ?? []).map(keyLabel), ...(action === 'pause' ? ['Esc'] : [])])],
  }));
}
