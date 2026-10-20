import { el } from './el';
import '../dock.css';

/** A small edge tab with an optional panel. Collapse state survives screen changes and reloads. */
export class HudDock {
  readonly root: HTMLElement;
  readonly body: HTMLElement;
  readonly tab: HTMLButtonElement;
  private expanded: boolean;
  private count = 0;
  constructor(readonly id: string, private readonly label: string, content: HTMLElement, open = false) {
    this.expanded = open;
    try { const saved = localStorage.getItem(`tmt:dock:${id}`); if (saved !== null) this.expanded = saved === 'open'; } catch { /* storage optional */ }
    this.tab = el('button', { type: 'button', class: 'dock-tab hud-cover', id: `${id}-tab`, 'data-camera-drag': '',
      'aria-controls': `${id}-panel`, onclick: () => this.setOpen(!this.expanded) });
    this.body = el('section', { id: `${id}-panel`, class: 'dock-content hud-cover', 'aria-label': label },
      el('header', { class: 'dock-head', 'data-camera-drag': '' }, el('strong', { text: label }),
        el('button', { type: 'button', 'aria-label': `Dock ${label}`, text: '−', onclick: () => this.setOpen(false) })), content);
    this.root = el('div', { class: `hud-edge-dock dock-${id}`, id: `dock-${id}` }, this.tab, this.body);
    this.paint();
  }
  get open(): boolean { return this.expanded; }
  setOpen(open: boolean): void { this.expanded = open; if (open) this.count = 0; this.paint(); try { localStorage.setItem(`tmt:dock:${this.id}`, open ? 'open' : 'closed'); } catch { /* optional */ } }
  notify(): void { if (!this.expanded) this.count = Math.min(99, this.count + 1); this.paint(); }
  clear(): void { this.count = 0; this.paint(); }
  private paint(): void {
    this.tab.textContent = `${this.label}${this.count ? ` · ${this.count} new` : ''} ${this.expanded ? '▴' : '▾'}`;
    this.tab.setAttribute('aria-expanded', String(this.expanded));
    this.tab.classList.toggle('unread', this.count > 0); this.body.hidden = !this.expanded;
  }
}
