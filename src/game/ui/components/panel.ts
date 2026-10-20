/**
 * Screen cards: a paper panel with a brass rim, a heading block, a scrolling body and an action row. On a phone the
 * card is a bottom sheet (game.css): a handle on top, the primary action last in a sticky footer under the thumb, and a
 * swipe down on the handle or head runs `dismiss` (Back / Resume) when the screen has one.
 */
import { el, type Child } from './el';
import { bindSwipeDismiss } from './sheet';

export interface CardOptions { id: string; eyebrow?: string; title: string; subtitle?: string; body: Child[]; actions?: Child[]; size?: 'narrow' | 'wide'; class?: string; dismiss?: () => void }
export function screenCard(o: CardOptions): HTMLElement {
  const handle = o.dismiss ? el('button', { type: 'button', class: 'sheet-handle', id: `${o.id}-handle`, 'aria-label': 'Close', title: 'Swipe down to close' }) : el('div', { class: 'sheet-handle', 'aria-hidden': 'true' });
  const head = el('header', { class: 'card-head' },
    o.eyebrow ? el('div', { class: 'eyebrow', text: o.eyebrow }) : null,
    el('h2', { class: 'card-title', id: `${o.id}-title`, text: o.title }),
    o.subtitle ? el('p', { class: 'card-subtitle', text: o.subtitle }) : null);
  const card = el('section', { class: ['screen-card', 'paper', o.size ? `card-${o.size}` : '', o.class].filter(Boolean).join(' '), id: o.id, role: 'dialog', 'aria-labelledby': `${o.id}-title` },
    handle, head,
    el('div', { class: 'card-body' }, ...o.body),
    o.actions?.length ? el('footer', { class: 'card-actions' }, ...o.actions) : null);
  if (o.dismiss) bindSwipeDismiss(card, handle, head, o.dismiss);
  return card;
}

/** Open state of collapsible sections, kept across re-renders (a screen re-renders on every change). */
const opened = new Map<string, boolean>();
/** A section that folds on a phone: open by default on wider screens, `phoneOpen` on a phone. */
export function collapsible(id: string, title: string, phoneOpen: boolean, ...children: Child[]): HTMLElement {
  const phone = typeof matchMedia === 'function' && matchMedia('(max-width: 600px)').matches;
  const open = opened.get(id) ?? (phone ? phoneOpen : true);
  const details = el('details', { class: 'card-section collapsible', id, open }, el('summary', { class: 'section-title', text: title }), ...children);
  details.addEventListener('toggle', () => opened.set(id, details.open));
  return details;
}
export function section(title: string, ...children: Child[]): HTMLElement {
  return el('section', { class: 'card-section' }, el('h3', { class: 'section-title', text: title }), ...children);
}
export function tabs<T extends string>(items: readonly { id: T; label: string; note?: string }[], value: T, onChange: (value: T) => void, label: string): HTMLElement {
  return el('div', { class: 'tabs', role: 'tablist', 'aria-label': label },
    ...items.map(item => el('button', { type: 'button', role: 'tab', class: 'tab', 'aria-selected': String(item.id === value), 'data-value': item.id,
      onclick: () => { if (item.id !== value) onChange(item.id); } }, item.label, item.note ? el('small', { class: 'tab-note', text: item.note }) : null)));
}
export function statGrid(items: readonly { label: string; value: string }[]): HTMLElement {
  return el('dl', { class: 'stat-grid' }, ...items.map(item => el('div', { class: 'stat' }, el('dt', { text: item.label }), el('dd', { text: item.value }))));
}
