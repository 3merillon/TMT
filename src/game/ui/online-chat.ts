import type { OnlineClient } from '../online/client';
import { filterProfanity } from '../online/profanity';
import { HudDock } from './components/dock';
import { el } from './components/el';
import { button } from './components/controls';

export class OnlineChat {
  readonly dock: HudDock;
  private readonly log = el('ol', { class: 'chat-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Room messages' });
  private readonly input = el('input', { class: 'text-input', type: 'text', maxlength: 500, placeholder: 'Message your room…', 'aria-label': 'Chat message', autocomplete: 'off' });
  private last = 0;
  private room = '';
  private key = '';
  private muted = new Set<number>();
  constructor(host: HTMLElement, private readonly client: OnlineClient, private readonly filtered: () => boolean) {
    const form = el('form', { class: 'chat-form' }, this.input, button('Send', () => form.requestSubmit(), { variant: 'primary' }));
    form.addEventListener('submit', event => {
      event.preventDefault(); const text = this.input.value.trim(); if (!text) return;
      this.input.value = ''; void client.chat(text).then(() => { if (client.state.error) this.input.value = text; });
    });
    this.dock = new HudDock('chat', 'Chat', el('div', {}, this.log, form));
    host.append(this.dock.root); this.dock.root.hidden = true;
    // Typing/chat scrolling belongs to the panel, never the tank's key bindings.
    this.dock.body.addEventListener('keydown', event => event.stopPropagation());
    client.subscribe(() => this.update());
  }
  update(): void {
    const state = this.client.state, code = state.room?.code ?? '';
    this.dock.root.hidden = !code;
    if (this.room !== code) { this.room = code; this.last = 0; this.key = ''; this.muted.clear(); this.dock.clear(); }
    const visible = state.chat.filter(m => !this.muted.has(m.seat));
    for (const message of visible) if (message.id > this.last && message.seat !== state.room?.seat) this.dock.notify();
    this.last = Math.max(this.last, ...state.chat.map(m => m.id));
    const key = `${this.last}:${this.filtered()}:${[...this.muted]}`;
    if (this.key === key) return; this.key = key;
    const bottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 30;
    this.log.replaceChildren(...visible.map(m => el('li', {},
      el('strong', { text: `${filterProfanity(m.name, this.filtered())}: `, style: `--sender:${['#e4c287', '#7bd3c4', '#dca2db'][m.seat % 3]}` }),
      el('span', { text: filterProfanity(m.text, this.filtered()) }),
      m.seat !== state.room?.seat ? button('Mute', () => { this.muted.add(m.seat); this.update(); }, { variant: 'quiet', title: `Mute ${m.name} for this room`, class: 'chat-mute' }) : null)));
    if (bottom) this.log.scrollTop = this.log.scrollHeight;
  }
}
