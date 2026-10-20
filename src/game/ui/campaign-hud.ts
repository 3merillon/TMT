/**
 * Campaign HUD (src/game/campaign/README.md): the mission layer over the match HUD in realtime missions.
 * - Objectives, top-left: the active list with done/failed states.
 * - The radio line, bottom centre: one speaker at a time, replaced by the next line.
 * - A hint chip under it when the player is stuck.
 * - Mission banners (title, complete, failed) in the upper centre.
 * - The objective marker: a diamond projected onto the screen with its distance, clamped to the screen edge.
 * - The gun panel: main-gun reload and coax heat.
 * It reads the session's realtime events and, per frame, the realtime match. Presentation only.
 */
import './campaign-hud.css';
import { playCampaignVoice, stopCampaignVoice } from '../../audio';
import { dispatchAudioCue } from '../../audio/cues';
import type { V3 } from '../contracts';
import type { RealtimeEvent } from '../realtime/match';
import type { GameSession } from '../app/session';
import type { GameView } from '../view';
import { el } from './components/el';
import { button } from './components/controls';
import { componentPoint } from '../realtime/components';
import { HudDock } from './components/dock';
import { missionById } from '../campaign/catalog';
import { missionIdOf } from '../campaign/mission';

interface Line { speaker: string; text: string; seconds: number; until: number }

export class CampaignHud {
  private readonly root: HTMLElement;
  private readonly objectives: HTMLElement;
  private readonly radio: HTMLElement;
  private readonly speaker: HTMLElement;
  private readonly line: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly marker: HTMLElement;
  private readonly markerLabel: HTMLElement;
  private readonly markerRange: HTMLElement;
  private readonly reload: HTMLElement;
  private readonly reloadText: HTMLElement;
  private wasReady: boolean | null = null;
  private wasHot = false;
  private readonly heat: HTMLElement;
  private readonly list = new Map<string, { text: string; state: 'active' | 'done' | 'failed' }>();
  private queue: Line[] = [];
  private current: Line | null = null;
  private bannerUntil = 0;
  private target: { point: V3 | null; tank?: number; component?: string; label: string } = { point: null, label: '' };
  private active = false;
  private radioPaused = false;
  private lastFrame = performance.now();
  private readonly choices: HTMLElement;
  private readonly repair: HTMLButtonElement;
  private readonly ultimate: HTMLButtonElement;
  private readonly posts: HTMLElement;
  private readonly postSelectors = new Map<string, HTMLSelectElement>();
  private readonly headlights: HTMLButtonElement;
  private readonly detection: HTMLElement;
  private readonly objectiveDock: HudDock;

  constructor(host: HTMLElement, private readonly game: GameSession, private readonly view: GameView) {
    this.objectives = el('ol', { class: 'ch-objectives', 'aria-label': 'Mission objectives' });
    this.speaker = el('span', { class: 'ch-speaker' });
    this.line = el('span', { class: 'ch-line' });
    this.radio = el('div', { class: 'ch-radio hud-cover', role: 'status', 'aria-live': 'polite' }, this.speaker, this.line, button('Skip radio', () => this.skipRadio(), { variant: 'quiet' }));
    this.hint = el('div', { class: 'ch-hint', role: 'note' });
    this.banner = el('div', { class: 'ch-banner', 'aria-live': 'polite' });
    this.markerLabel = el('span', { class: 'ch-marker-label' });
    this.markerRange = el('span', { class: 'ch-marker-range' });
    this.marker = el('div', { class: 'ch-marker', 'aria-hidden': 'true' }, el('span', { class: 'ch-diamond' }), this.markerLabel, this.markerRange);
    this.reload = el('span', { class: 'ch-fill' });
    this.reloadText = el('span', { class: 'ch-gun-text', text: 'Ready' });
    this.heat = el('span', { class: 'ch-fill' });
    const gun = el('div', { class: 'ch-gun hud-cover', 'aria-label': 'Weapons' },
      el('div', { class: 'ch-gauge' }, el('span', { class: 'ch-gauge-label', text: 'Gun' }), el('span', { class: 'ch-bar' }, this.reload), this.reloadText),
      el('div', { class: 'ch-gauge heat' }, el('span', { class: 'ch-gauge-label', text: 'MG' }), el('span', { class: 'ch-bar' }, this.heat)));
    this.repair = button('Repair · 1 charge', () => { if (game.command(game.observer, { k: 'utility', id: 'repair' })) dispatchAudioCue({ type: 'ui', sound: 'repair' }); }, { variant: 'brass' });
    this.ultimate = button('Ultimate: 3 charges', () => game.command(game.observer, { k: 'utility', id: 'ultimate' }), { variant: 'primary' });
    this.headlights = button('Lights on', () => game.command(game.observer, { k: 'utility', id: 'headlights' }), { variant: 'quiet' });
    this.detection = el('div', { class: 'ch-detection hud-cover', hidden: true, role: 'progressbar', 'aria-label': 'Searchlight detection', 'aria-valuemin': 0, 'aria-valuemax': 100 });
    const squad = el('div', { class: 'ch-abilities', 'aria-label': 'Field commands' }, this.repair, this.ultimate, this.headlights,
      ...(['follow', 'hold', 'rally'] as const).map(order => button(`Squad ${order}`, () => game.command(game.observer, { k: 'utility', id: `squad-${order}` }), { variant: 'quiet' })));
    this.posts = el('div', { class: 'ch-posts hud-cover', hidden: true, 'aria-label': 'Companion assignments' });
    this.choices = el('div', { class: 'ch-ending', hidden: true, role: 'group', 'aria-label': 'Choose the future of the Orrery' },
      el('h2', { text: 'The future is yours' }),
      el('p', { text: 'Rewind the Mainspring and rebuild the worlds, or release it and sail for the Lantern.' }),
      button('Rewind', () => game.command(game.observer, { k: 'utility', id: 'ending-rewind' }), { variant: 'primary' }),
      button('Release', () => game.command(game.observer, { k: 'utility', id: 'ending-release' }), { variant: 'brass' }));
    this.objectiveDock = new HudDock('objectives', 'Objectives', this.objectives);
    const actionsDock = new HudDock('actions', 'Tank actions', squad);
    gun.dataset.cameraDrag = '';
    this.root = el('div', { class: 'campaign-hud', id: 'campaign-hud', hidden: true }, this.objectiveDock.root, this.banner, this.marker, gun, actionsDock.root, this.posts, this.detection, this.choices);
    host.append(this.root);
    // Dialogue floats above gameplay; discard it when another screen owns input.
    document.body.append(el('div', { class: 'ch-bottom ch-radio-overlay' }, this.radio, this.hint));
    window.addEventListener('tmt:audio-scene', event => {
      const scene = (event as CustomEvent).detail?.scene;
      this.radioPaused = scene === 'pause';
      if (['title', 'menu', 'workshop', 'setup', 'loading', 'results'].includes(scene)) this.clearRadio();
    });
    for (const node of [this.radio, this.hint, this.marker]) node.hidden = true;
    game.on('ready', () => this.reset());
    game.on('realtime', payload => this.onEvent(payload as RealtimeEvent));
  }

  private reset(): void {
    this.clearRadio(); this.list.clear(); this.bannerUntil = 0; this.wasReady = null; this.wasHot = false;
    this.objectiveDock.clear();
    this.target = { point: null, label: '' };
    this.objectives.replaceChildren(); this.banner.replaceChildren(); this.hint.textContent = '';
    this.hint.hidden = this.radio.hidden = this.marker.hidden = true;
    this.active = !!this.game.realtime;
    this.heat.closest<HTMLElement>('.ch-gauge')!.hidden = this.game.setup?.rules.autoCoax === false;
    this.root.hidden = !this.active;
    this.postSelectors.clear(); this.posts.replaceChildren();
    const mission = this.game.setup && missionIdOf(this.game.setup);
    const posts = this.game.mission?.def.commandPosts ?? (mission ? missionById(mission).commandPosts : undefined) ?? [];
    for (const name of ['mags', 'brann', 'seraphine']) if (posts.length) {
      const select = el('select', { id: `assign-${name}`, 'aria-label': `Assign ${name}` },
        el('option', { value: '', disabled: true, text: 'Squad order' }),
        ...posts.map(post => el('option', { value: post.site, text: post.label })));
      select.addEventListener('change', () => this.game.command(this.game.observer, { k: 'utility', id: `assign:${name}:${select.value}` }));
      this.posts.append(el('label', {}, name[0].toUpperCase() + name.slice(1), select)); this.postSelectors.set(name, select);
    }
    this.posts.hidden = !posts.length;
  }

  private onEvent(event: RealtimeEvent): void {
    const now = performance.now();
    switch (event.type) {
      case 'say': {
        if (this.game.snapshot?.phase === 'finished') break;
        const line: Line = { speaker: event.speaker, text: event.text, seconds: event.seconds, until: 0 };
        if (this.current) this.queue.push(line); else this.show(line, now);
        break;
      }
      case 'objective': {
        const previous = this.list.get(event.id);
        if (previous?.text === event.text && previous.state === event.state) break;
        this.list.set(event.id, { text: event.text, state: event.state }); this.renderObjectives(); this.objectiveDock.notify(); break;
      }
      case 'hint': this.hint.textContent = event.text ?? ''; this.hint.hidden = !event.text; break;
      case 'banner':
        this.banner.replaceChildren(el('div', { class: 'ch-banner-sub', text: event.subtitle ?? '' }), el('div', { class: 'ch-banner-title', text: event.title }));
        this.banner.classList.remove('show'); void this.banner.offsetWidth; this.banner.classList.add('show');
        this.bannerUntil = now + 3800;
        break;
      case 'marker': this.target = { point: event.point, ...(event.tank !== undefined ? { tank: event.tank } : {}), component: event.component, label: event.label ?? '' }; break;
      case 'mission': if (event.status === 'failed') this.clearRadio(); this.hint.hidden = true; this.target = { point: null, label: '' }; break;
      default: break;
    }
  }

  private show(line: Line, now: number): void {
    const current = this.current = { ...line, until: Infinity };
    void playCampaignVoice(line.speaker, line.text).then(played => {
      if (this.current === current) current.until = performance.now() + (played ? 350 : line.seconds * 1000);
    });
    this.speaker.textContent = line.speaker; this.line.textContent = line.text;
    this.radio.hidden = false;
    this.radio.classList.remove('fresh'); void this.radio.offsetWidth; this.radio.classList.add('fresh');
  }

  private clearRadio(): void {
    // A background match can become ready while the campaign board owns a
    // briefing. Clearing an empty HUD must not stop that other speaker.
    const ownsSpeech = this.current !== null;
    this.current = null; this.queue = [];
    if (ownsSpeech) stopCampaignVoice();
    this.radio.hidden = true; this.hint.hidden = true;
  }
  private skipRadio(): void {
    this.current = null; stopCampaignVoice();
    const next = this.queue.shift();
    if (next) this.show(next, performance.now()); else this.radio.hidden = true;
  }

  private renderObjectives(): void {
    this.objectives.replaceChildren(...[...this.list.values()].slice(-4).map(o => el('li', { class: `ch-objective ${o.state}` },
      el('span', { class: 'ch-check', 'aria-hidden': 'true', text: o.state === 'done' ? '✓' : o.state === 'failed' ? '✕' : '' }), el('span', { text: o.text }))));
  }

  /** Throttled panel refresh: radio timing, banner fade and gun gauges. */
  update(): void {
    const now = performance.now(), dt = now - this.lastFrame; this.lastFrame = now;
    if (!this.active) return;
    if (this.radioPaused || document.hidden) { if (this.current) this.current.until += dt; return; }
    if (this.current && now >= this.current.until) {
      const next = this.queue.shift();
      if (next) this.show(next, now); else { this.current = null; this.radio.hidden = true; }
    }
    if (this.bannerUntil && now >= this.bannerUntil) { this.banner.classList.remove('show'); this.bannerUntil = 0; }
    const match = this.game.realtime, state = this.game.snapshot;
    if (!match || !state) return;
    const own = state.tanks[this.game.observer];
    for (const [name, select] of this.postSelectors) {
      const post = this.game.mission?.companionPost(name);
      if (this.game.mission && document.activeElement !== select) select.value = post ?? '';
      select.disabled = !state.tanks.some(t => t.name?.toLowerCase() === name && t.health > 0);
    }
    const abilities = match.abilities();
    this.headlights.textContent = own?.headlights === false ? 'Lights off' : 'Lights on';
    this.headlights.setAttribute('aria-pressed', String(own?.headlights !== false));
    this.detection.hidden = own?.detection === undefined;
    if (own?.detection !== undefined) {
      const value = Math.round(own.detection * 100);
      this.detection.textContent = value === 100 ? 'DETECTED · Break line of sight' : `Detection ${value}%`;
      this.detection.setAttribute('aria-valuenow', String(value));
      this.detection.style.setProperty('--detection', `${value}%`);
    }
    const machineryDamage = own?.machinery && [own.machinery.engine, own.machinery.weapon, own.machinery.leftTrack, own.machinery.rightTrack].some(h => h < 1);
    this.repair.disabled = !own || abilities.repairKits === 0 && own.charge < abilities.repairCost || own.health >= (own.maxHealth ?? own.health) && !machineryDamage;
    this.repair.textContent = abilities.repairKits ? `Repair kit: ${abilities.repairKits} left` : `Repair: ${abilities.repairCost} charge`;
    this.ultimate.hidden = !abilities.ultimate;
    this.ultimate.textContent = abilities.charging ? 'Ultimate charging...' : abilities.used ? 'Ultimate spent' : `${abilities.ultimate === 'nuclear' ? 'Nuclear shell' : abilities.ultimate === 'hammer' ? 'Forge Hammer' : 'Orbital Lance'}: 3 charges`;
    this.ultimate.disabled = abilities.used || !own || own.charge < 3 || !match.canFire(this.game.observer);
    const beat = this.game.mission?.beatId ?? this.game.remoteMission?.beat;
    const ending = this.game.mission?.ending ?? this.game.remoteMission?.ending;
    const commander = this.game.remoteMission?.commander ?? this.game.setup?.online?.seats.find(id => state.tanks[id]?.health > 0 && !state.tanks[id]?.retired) ?? 0;
    this.choices.hidden = beat !== 'ending-choice' || !!ending || this.game.observer !== commander;
    const reload = match.reloadOf(this.game.observer), coax = match.coaxOf(this.game.observer);
    const ready = reload.remaining <= 0;
    // Gun feedback on transitions only: the loader clunk is the weapon's own sound; this is the ready tick and the coax overheat.
    if (ready && this.wasReady === false) dispatchAudioCue({ type: 'ui', sound: 'reload-ready' });
    if (coax.overheated && !this.wasHot) dispatchAudioCue({ type: 'ui', sound: 'overheat' });
    this.wasReady = ready; this.wasHot = coax.overheated;
    this.reload.style.width = `${(ready ? 1 : 1 - reload.remaining / Math.max(1e-6, reload.total)) * 100}%`;
    this.reload.parentElement!.classList.toggle('ready', ready);
    this.reloadText.textContent = ready ? 'Ready' : `${reload.remaining.toFixed(1)} s`;
    this.heat.style.width = `${Math.min(1, coax.heat) * 100}%`;
    this.heat.parentElement!.classList.toggle('hot', coax.overheated);
  }

  /** Run after every rendered frame; gameplay facts and panel text can retain the slower HUD cadence. */
  updateMarker(): void {
    const state = this.game.snapshot, own = state?.tanks[this.game.observer];
    if (!this.active || !state || !own) { this.marker.hidden = true; return; }
    let point = this.target.point;
    if (this.target.tank !== undefined) {
      const unit = state.tanks[this.target.tank], pose = this.view.renderedTankPose(this.target.tank), component = unit?.components?.find(c => c.id === this.target.component);
      point = unit && unit.health > 0 && pose ? component ? componentPoint(pose, component) : pose.position : null;
    }
    if (!point) { this.marker.hidden = true; return; }
    const up = normalize(point), lift = this.target.component ? .35 : 1.4, lifted: V3 = [point[0] + up[0] * lift, point[1] + up[1] * lift, point[2] + up[2] * lift];
    const screen = this.view.worldToScreen(lifted), w = this.root.clientWidth || innerWidth, h = this.root.clientHeight || innerHeight;
    const origin = this.view.renderedTankPose(own.id)?.position ?? own.position;
    const range = Math.hypot(point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]);
    let x: number, y: number, edge = false;
    if (screen) { [x, y] = screen; edge = x < 24 || y < 24 || x > w - 24 || y > h - 24; }
    else {
      const ground = this.view.worldToScreen(point);
      const cx = w / 2, cy = h / 2, dx = ground ? ground[0] - cx : 0, dy = ground ? ground[1] - cy : -1;
      const scale = Math.min((w / 2 - 28) / Math.max(1e-6, Math.abs(dx)), (h / 2 - 28) / Math.max(1e-6, Math.abs(dy)));
      x = cx + dx * scale; y = cy + dy * scale; edge = true;
    }
    x = Math.max(24, Math.min(w - 24, x)); y = Math.max(24, Math.min(h - 24, y));
    this.marker.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`;
    this.marker.classList.toggle('edge', edge);
    if (this.markerLabel.textContent !== this.target.label) this.markerLabel.textContent = this.target.label;
    const text = `${Math.round(range)} m`;
    if (this.markerRange.textContent !== text) this.markerRange.textContent = text;
    this.marker.hidden = false;
  }
}

function normalize(v: V3): V3 { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
