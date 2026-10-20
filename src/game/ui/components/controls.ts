/** Shared form controls in the service-bay style: buttons, list-menu rows, segmented choices, sliders, switches, selects. */
import { el, type Child } from './el';

export type ButtonVariant = 'primary' | 'brass' | 'quiet' | 'danger';
export interface ButtonOptions { id?: string; variant?: ButtonVariant; disabled?: boolean; title?: string; badge?: string; primary?: boolean; class?: string }
export function button(label: Child, onClick: () => void, o: ButtonOptions = {}): HTMLButtonElement {
  return el('button', {
    type: 'button', id: o.id, class: ['btn', `btn-${o.variant ?? 'brass'}`, o.class].filter(Boolean).join(' '), disabled: o.disabled, title: o.title,
    'data-primary': o.primary, onclick: () => onClick(),
  }, label, o.badge ? el('span', { class: 'btn-badge', text: o.badge }) : null);
}

export interface MenuItemOptions { id: string; index?: string; hint?: string; badge?: string; variant?: 'primary' | 'danger'; primary?: boolean; disabled?: boolean }
/** A list-menu row (title, pause): an index, a label with a one-line hint, an optional badge and a chevron. */
export function menuItem(label: string, onClick: () => void, o: MenuItemOptions): HTMLButtonElement {
  return el('button', {
    type: 'button', id: o.id, class: ['menu-item', o.variant ? `menu-item-${o.variant}` : ''].filter(Boolean).join(' '), disabled: o.disabled, 'data-primary': o.primary, onclick: () => onClick(),
  }, el('span', { class: 'mi-index', 'aria-hidden': 'true', text: o.index ?? '' }),
  el('span', { class: 'mi-text' }, el('span', { class: 'mi-label', text: label }), o.hint ? el('span', { class: 'mi-hint', text: o.hint }) : null),
  o.badge ? el('span', { class: 'btn-badge', text: o.badge }) : el('span'),
  el('span', { class: 'mi-chevron', 'aria-hidden': 'true' }));
}

/** Writes a range's filled share into --fill (the rail paints up to it); call after every value change. */
export function setFill(input: HTMLInputElement): void {
  const min = Number(input.min || 0), max = Number(input.max || 100), value = Number(input.value);
  const fill = `${max > min ? Math.max(0, Math.min(100, (value - min) / (max - min) * 100)).toFixed(1) : 0}%`;
  if (input.style.getPropertyValue('--fill') !== fill) input.style.setProperty('--fill', fill);
}

export interface Choice<T extends string | number> { id: T; label: string; title?: string; disabled?: boolean }
/** A radio group of buttons. It updates its own checked state, so callers need not re-render (settings sliders keep their drag). */
export function segmented<T extends string | number>(label: string, choices: readonly Choice<T>[], value: T, onChange: (value: T) => void, id?: string): HTMLElement {
  const group = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label });
  for (const choice of choices) {
    group.append(el('button', {
      type: 'button', role: 'radio', class: 'seg', 'aria-checked': String(choice.id === value), title: choice.title, disabled: choice.disabled,
      'data-value': String(choice.id), onclick: () => {
        if (group.querySelector('[aria-checked="true"]')?.getAttribute('data-value') === String(choice.id)) return;
        for (const node of Array.from(group.children)) node.setAttribute('aria-checked', String(node.getAttribute('data-value') === String(choice.id)));
        onChange(choice.id);
      },
    }, choice.label));
  }
  return el('div', { class: 'field', id }, el('span', { class: 'field-label', text: label }), group);
}

export interface SliderOptions { id?: string; label: string; min: number; max: number; step: number; value: number; format(value: number): string; onInput(value: number): void; hint?: string }
export function slider(o: SliderOptions): HTMLElement {
  const output = el('output', { class: 'field-value', text: o.format(o.value) });
  const input = el('input', { class: 'range', type: 'range', id: o.id, min: o.min, max: o.max, step: o.step, value: o.value, 'aria-label': o.label });
  setFill(input);
  input.addEventListener('input', () => { const value = Number(input.value); output.textContent = o.format(value); setFill(input); o.onInput(value); });
  return el('label', { class: 'field slider-field' },
    el('span', { class: 'field-row' }, el('span', { class: 'field-label', text: o.label }), output), input, o.hint ? el('small', { class: 'field-hint', text: o.hint }) : null);
}

export function toggle(label: string, checked: boolean, onChange: (checked: boolean) => void, o: { id?: string; hint?: string } = {}): HTMLElement {
  const input = el('input', { type: 'checkbox', id: o.id, class: 'switch-input', checked, role: 'switch' });
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', { class: 'field switch-field' },
    input, el('span', { class: 'switch', 'aria-hidden': 'true' }), el('span', { class: 'switch-text' }, el('span', { class: 'field-label', text: label }),
      o.hint ? el('small', { class: 'field-hint', text: o.hint }) : null));
}

export function select<T extends string>(label: string, choices: readonly Choice<T>[], value: T, onChange: (value: T) => void, id?: string): HTMLElement {
  const input = el('select', { id, class: 'select', 'aria-label': label },
    ...choices.map(choice => el('option', { value: choice.id, selected: choice.id === value, disabled: choice.disabled }, choice.label)));
  input.addEventListener('change', () => onChange(input.value as T));
  return el('label', { class: 'field' }, el('span', { class: 'field-label', text: label }), input);
}

export const percent = (value: number) => `${Math.round(value * 100)}%`;
