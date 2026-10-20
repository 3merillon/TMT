/**
 * The match HUD: edge chips (tanks, phase with the aim timer or the relocation budget, wind, menu), the match-info drawer
 * (turn, objective, every tank), the floating joystick, and the fire dock (munition, power, camera,
 * radar, Fire / Hold position) with the fine-aim drawer (munition list, bearing and elevation sliders). hud-layout.ts
 * decides what each input context shows; thumb buttons send the same press actions as the keyboard (TOUCH_PRESS).
 * Refreshed by the frame loop every 100 ms and on demand; the DOM is written only when a value changes.
 */
import type { GameEvent, TankState } from '../contracts';
import { session } from '../api/session';
import { assembleKit, tankKit } from '../kit';
import { RADAR_COST } from '../simulation';
import { planetType } from '../planet-field';
import type { GameView } from '../view';
import type { MatchActions } from './actions';
import { byId, el, fill, setText } from './components/el';
import { setFill } from './components/controls';
import { mountJoystick } from './components/joystick';
import { hudControls, type InputStyle } from './hud-layout';
import { aimSecondsLeft, ammoChips, banner, isRealtime, objectiveLabel, rosterRows, windLabel, type RosterRow } from './hud-model';
import { TOUCH_PRESS, WEAPON_MUNITIONS, keyLabel, type BindableAction, type BindingContext, type WeaponAction } from './input/bindings';
import { bindButtonPress } from './input/button';
import { currentSettings } from '../meta/settings';
import { filterProfanity } from '../online/profanity';
import { canAim, canDrive, inputContext, type ContextInput } from './input/contexts';
import type { InputController } from './input/controller';
import type { DragAimGuide } from './input/mouse';
import { toast } from './toast';
import { partName } from './workshop-model';
import { weaponOperational } from '../rules/vehicle-damage';

/** Optional developer controls of the three.js view; the engine facade may drop them (W1-ENG-SCENE). */
interface DevViewControls { setVehicleDebug?(enabled: boolean): void; setTerrainDetail?(detail: 'parallax' | 'normal'): void }
export interface HudDeps {
  view: GameView;
  actions: MatchActions;
  input: InputController;
  context(): ContextInput;
  /** Latest terrain summary for the dev bar (seed, triangles); optional. */
  terrainInfo(): { seed?: number; planetKind?: import('../planet-field').PlanetType } | undefined;
  /** The input style the HUD is dressed for (the last pointer type). */
  inputStyle(): InputStyle;
  pause(): void;
  toggleDriveTest(): void;
  resetTest(): void;
}

const deg = (radians: number) => radians * 180 / Math.PI;
const number = (value: unknown, digits = 0) => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
const show = (node: HTMLElement, visible: boolean) => { if (node.hidden === visible) node.hidden = !visible; };
const hpText = (row: RosterRow) => row.destroyed ? 'KO' : row.health === null ? '??' : `${Math.ceil(row.health)}${row.stale ? '*' : ''}`;
const hpWidth = (row: RosterRow) => `${row.health === null ? 0 : Math.max(0, Math.min(1, row.health / row.maxHealth)) * 100}%`;

export class Hud {
  private readonly lastSeen = new Map<number, number>();
  private rosterKey = '';
  private infoKey = '';
  private chipsKey = '';
  private dragging: HTMLInputElement | null = null;
  private dev = false;
  private pending = 0;
  private lastActive = -1;
  private vehicleDebug = false;
  private infoOpen = false;
  private fineOpen = false;
  private joystick?: { reset(): void };
  private heading = '';

  constructor(private readonly deps: HudDeps) {}

  mount(): void {
    const { actions, input } = this.deps;
    for (const id of ['bearing', 'elevation', 'power']) {
      const slider = byId<HTMLInputElement>(id);
      slider.addEventListener('input', () => this.applySliders());
      slider.addEventListener('pointerdown', () => { this.dragging = slider; });
      for (const type of ['pointerup', 'pointercancel', 'change', 'blur']) slider.addEventListener(type, () => { if (this.dragging === slider) this.dragging = null; });
    }
    const press = (id: string, action: (typeof TOUCH_PRESS)[keyof typeof TOUCH_PRESS]) =>
      bindButtonPress(byId<HTMLButtonElement>(id), () => { input.press(action); this.invalidate(); this.refocus(); });
    press('fire', TOUCH_PRESS.fire);
    press('end-move', TOUCH_PRESS.hold);
    press('scan', TOUCH_PRESS.scan);
    press('munition-cycle', TOUCH_PRESS.munition);
    press('target-cycle', TOUCH_PRESS.target);
    byId('camera').addEventListener('click', () => { if (this.deps.view.isFollowing()) actions.overview(); else actions.focusTank(); this.invalidate(); this.refocus(); });
    byId('pause-open').addEventListener('click', () => this.deps.pause());
    byId('roster').addEventListener('click', () => this.setInfo(!this.infoOpen));
    byId('match-info-close').addEventListener('click', () => { this.setInfo(false); byId('roster').focus({ preventScroll: true }); });
    byId('fine-aim-toggle').addEventListener('click', () => { this.fineOpen = !this.fineOpen; this.update(); });
    this.joystick = mountJoystick(byId('stick-zone'), byId('stick-base'), byId('stick-knob'), {
      enabled: () => this.deps.inputStyle() === 'touch' && hudControls(inputContext(this.deps.context()), this.deps.context().driveTest, this.deps.context().realtime).stick !== null,
      set: (x, y) => input.setStick(x, y),
      release: () => input.releaseStick(),
    });
    input.onClear = () => this.joystick?.reset();
    byId('drive-test').addEventListener('click', () => this.deps.toggleDriveTest());
    byId('restart').addEventListener('click', () => this.deps.resetTest());
    byId('vehicle-debug').addEventListener('click', () => {
      this.vehicleDebug = !this.vehicleDebug && this.deps.context().driveTest;
      (this.deps.view as unknown as DevViewControls).setVehicleDebug?.(this.vehicleDebug);
      this.syncDevButtons();
    });
    byId('surface-relief').addEventListener('click', () => {
      const button = byId('surface-relief'), enabled = button.getAttribute('aria-pressed') !== 'true';
      (this.deps.view as unknown as DevViewControls).setTerrainDetail?.(enabled ? 'parallax' : 'normal');
      button.setAttribute('aria-pressed', String(enabled));
      button.textContent = `Surface relief: ${enabled ? 'On' : 'Off'}`;
    });
  }

  /** Turns the joystick's heading needle to the hull's on-screen forward (radians, 0 = up); null hides it. Called every
   * frame; the DOM is written only when the angle moves by half a degree. */
  setHeading(angle: number | null): void {
    const value = angle === null ? '' : `rotate(${(Math.round(angle * 360 / Math.PI) / 2).toFixed(1)}deg)`;
    if (value === this.heading) return;
    this.heading = value;
    const needle = document.getElementById('stick-needle');
    if (!needle) return;
    needle.hidden = angle === null;
    if (value) needle.style.transform = value;
  }

  setVisible(visible: boolean): void {
    byId('hud').hidden = !visible;
    if (!visible) { this.joystick?.reset(); this.setInfo(false); }
  }
  setDevChrome(dev: boolean): void { this.dev = dev; byId('dev-bar').hidden = !dev; byId('game').classList.toggle('dev-chrome', dev); this.syncDevButtons(); }

  /** A fresh match is playable. */
  onMatchReady(): void {
    this.lastSeen.clear();
    this.rosterKey = this.infoKey = this.chipsKey = '';
    this.lastActive = session().snapshot?.active ?? -1;
    this.vehicleDebug = false;
    this.fineOpen = false;
    this.setInfo(false);
    (this.deps.view as unknown as DevViewControls).setVehicleDebug?.(false);
    this.syncDevButtons();
    this.syncSliders(true);
    this.update();
    const drive = this.deps.context().driveTest || !!this.deps.context().realtime, touch = this.deps.inputStyle() === 'touch';
    toast(touch
      ? `${drive ? 'Left thumb drives. ' : ''}Tap the ground to aim · drag to look · pinch to zoom · Fire when ready.`
      : `${drive ? 'Use your drive keys to move. ' : ''}Left click or drag to aim; wheel trims range. Right-drag orbits; ${this.keyHint('fire', drive ? 'drive' : 'aim') || 'the Fire button'} fires.`, 6);
  }

  onEvent(event: GameEvent): void {
    const s = session(), setup = s.setup;
    if (event.type === 'shot') {
      if (event.player !== s.observer && setup?.mode !== 'local' && setup?.rules.turnModel !== 'realtime') toast('Incoming shot. Your turn follows the impact.');
    } else if (event.type === 'terrain-failed') {
      toast('This crater could not be applied. The battlefield is unchanged; keep playing.', 6);
    } else if (event.type === 'turn') {
      this.deps.input.clear();
      if (setup?.mode === 'local') { this.lastSeen.clear(); toast(`Pass the device to ${setup.tanks[event.player]?.name ?? `player ${event.player + 1}`}.`, 4); }
      else if (event.player === s.observer) toast('Your turn. Read the terrain and take your shot.');
      this.syncSliders(true);
    }
    this.invalidate();
  }

  /** Pass-and-play changes the observed tank: re-read its aim once per change. */
  syncActive(): void {
    const active = session().snapshot?.active ?? -1;
    if (active !== this.lastActive) { this.lastActive = active; this.syncSliders(true); }
  }

  /** Coalesces refresh requests into the next animation frame. */
  invalidate(): void {
    if (this.pending) return;
    this.pending = requestAnimationFrame(() => { this.pending = 0; this.update(); });
  }

  showGuide(guide: DragAimGuide | null): void {
    const svg = byId('drag-guide') as unknown as SVGSVGElement;
    svg.toggleAttribute('hidden', !guide);
    if (!guide) return;
    const [x1, y1] = guide.origin, [x2, y2] = guide.pointer;
    const line = byId('drag-line'), ring = byId('drag-ring'), text = byId('drag-text');
    line.setAttribute('x1', String(x1)); line.setAttribute('y1', String(y1)); line.setAttribute('x2', String(x2)); line.setAttribute('y2', String(y2));
    ring.setAttribute('cx', String(x2)); ring.setAttribute('cy', String(y2)); ring.setAttribute('r', String(8 + guide.power * 14));
    text.setAttribute('x', String(x2 + 18)); text.setAttribute('y', String(y2 - 14));
    text.textContent = Number.isFinite(guide.yaw) ? `${Math.round(deg(guide.yaw))}° · ${Math.round(guide.power * 100)}%` : 'drag to aim';
  }

  /**
   * The HUD's opaque pieces, for the coverage measure (captures): every visible `.hud-cover` box, plus the dock as one
   * panel with a mouse or as its separate thumb buttons with touch. The joystick's faint ghost is not counted.
   */
  coverRects(): DOMRect[] {
    const dock = this.deps.inputStyle() === 'touch' ? '#dock-face > *' : '#dock-face';
    return Array.from(document.querySelectorAll<HTMLElement>(`#hud .hud-cover, ${dock}`)).filter(node => node.offsetParent !== null).map(node => node.getBoundingClientRect());
  }

  update(): void {
    const s = session(), state = s.snapshot;
    if (!state) return;
    const context = this.deps.context(), observer = s.observer, setup = s.setup, rules = setup?.rules;
    const tank = state.tanks[observer];
    if (!tank) return;
    const aiming = canAim(context), moving = canDrive(context), drive = context.driveTest;
    const controls = hudControls(inputContext(context), drive, context.realtime);
    const keyMode: BindingContext = drive || context.realtime || moving ? 'drive' : 'aim';
    for (const [id, action, label] of [['fire', 'fire', 'Fire'], ['target-cycle', 'nextTarget', 'Cycle visible targets'], ['scan', 'scan', 'Radar scan'], ['end-move', 'endMove', 'Hold position']] as const) {
      const node = byId(id), hint = this.keyHint(action, keyMode), kbd = node.querySelector('kbd');
      if (kbd) { setText(kbd, hint); kbd.hidden = !hint; }
      node.title = hint ? `${label} (${hint})` : label;
    }
    const touch = this.deps.inputStyle() === 'touch';

    const b = banner(state, setup, observer, drive);
    setText(byId('turn-number'), b.turn); setText(byId('phase-tag'), b.tag);
    setText(byId('info-turn'), b.turn); setText(byId('turn-title'), b.title); setText(byId('turn-detail'), drive ? 'Drive keys move · left mouse targets · left+wheel adjusts range · use Fire to shoot' : b.detail);
    const chip = byId('banner'), own = aiming || moving;
    if (chip.classList.contains('own-turn') !== own) chip.classList.toggle('own-turn', own);
    const rows = rosterRows(state, setup, observer, this.lastSeen);
    this.renderRoster(rows);
    if (this.infoOpen) this.renderInfoRoster(rows);
    const wind = windLabel(rules);
    setText(byId('wind'), rules?.wind ? `${rules.wind.mean.toFixed(1)}` : 'Calm');
    setText(byId('wind-detail'), wind);
    byId('wind-chip').title = `Wind: ${wind}`;
    const windChip = byId('wind-chip'), calm = !rules?.wind;
    if (windChip.classList.contains('is-calm') !== calm) windChip.classList.toggle('is-calm', calm);
    setText(byId('objective'), objectiveLabel(state, setup, observer));

    let weapon = 'weapon';
    try { weapon = tankKit(tank).weapon; } catch { /* keep the generic label */ }
    setText(byId('weapon-name'), partName('weapon', weapon).toUpperCase());
    const timeLeft = aimSecondsLeft(state, rules), timer = byId('aim-timer');
    show(timer, timeLeft !== null);
    setText(timer, timeLeft === null ? '' : `${Math.ceil(timeLeft)} s`);
    const urgent = timeLeft !== null && timeLeft <= 5;
    if (timer.classList.contains('urgent') !== urgent) timer.classList.toggle('urgent', urgent);

    // Relocation budget in the phase chip.
    const realtime = !!context.realtime, relocating = moving && !drive && !realtime, left = byId('movement-left'), meter = byId('move-meter');
    show(left, relocating || drive || realtime); show(meter, relocating);
    const speed = Math.hypot(...tank.velocity);
    setText(left, drive || realtime ? `${speed.toFixed(1)} m/s` : `${Math.max(0, tank.movement).toFixed(1)} m · ${Math.max(0, Math.ceil((rules?.moveSeconds ?? 30) - state.phaseTime))} s`);
    if (relocating) {
      let range = 1;
      try { range = assembleKit(tankKit(tank)).stats.fuel || 1; } catch { /* unassembled kit: show the raw budget */ }
      const width = `${Math.max(0, Math.min(1, tank.movement / range)) * 100}%`, bar = byId('move-progress');
      if (bar.style.width !== width) bar.style.width = width;
    }

    // The dock: what this context offers.
    show(byId('stick-zone'), touch && controls.stick !== null);
    if (controls.stick === null) this.joystick?.reset();
    show(byId('munition-cycle'), controls.munition);
    show(byId('target-cycle'), controls.munition);
    byId<HTMLButtonElement>('target-cycle').disabled = !aiming || !context.ready;
    show(byId('aim-readout'), controls.munition);
    show(byId('fine-aim-toggle'), controls.munition);
    show(byId('power-field'), controls.power);
    show(byId('scan'), controls.scan);
    show(byId('camera'), controls.camera);
    show(byId('fire'), controls.primary === 'fire');
    show(byId('end-move'), controls.primary === 'hold');
    const fine = this.fineOpen && controls.munition;
    show(byId('fine-aim'), fine);
    const toggle = byId('fine-aim-toggle');
    if (toggle.getAttribute('aria-expanded') !== String(fine)) { toggle.setAttribute('aria-expanded', String(fine)); toggle.textContent = fine ? '▾' : '▴'; }
    const dock = byId('aim-panel');
    if (dock.dataset.primary !== (controls.primary ?? 'none')) dock.dataset.primary = controls.primary ?? 'none';

    this.renderMunitions(tank, aiming, context.ready, keyMode);
    this.syncSliders(false);
    for (const id of ['bearing', 'elevation', 'power']) { const input = byId<HTMLInputElement>(id); if (input.disabled === aiming) input.disabled = !aiming; }
    const inFlight = state.projectiles.some(p => p.owner === observer);
    // Realtime: the button follows the reload (the campaign HUD shows its progress).
    const fireDisabled = !context.ready || (isRealtime(setup) ? !(s.canFire?.(observer) ?? aiming) : drive ? inFlight || state.phase === 'terrain' : !aiming);
    const fire = byId<HTMLButtonElement>('fire');
    const caption = fire.querySelector('span');
    if (caption) setText(caption, !isRealtime(setup) && !weaponOperational(tank) ? 'Repair' : 'Fire');
    if (fire.disabled !== fireDisabled) fire.disabled = fireDisabled;
    const radarCost = rules?.radarCost ?? RADAR_COST, scan = byId<HTMLButtonElement>('scan'), scanDisabled = drive || !aiming || tank.charge < radarCost;
    if (scan.disabled !== scanDisabled) scan.disabled = scanDisabled;
    setText(byId('charge'), `${Math.round(Math.min(1, tank.charge / radarCost) * 100)}%`);
    const hold = byId<HTMLButtonElement>('end-move');
    if (hold.disabled === moving) hold.disabled = !moving;
    const following = this.deps.view.isFollowing(), camera = byId('camera'), label = following ? 'Planet view' : 'Follow your tank';
    if (camera.getAttribute('aria-label') !== label) {
      camera.setAttribute('aria-label', label); camera.title = `${label} (${following ? 'O' : 'F'})`;
      fill(camera, el('span', { 'aria-hidden': 'true', text: following ? '◉' : '◎' }), el('kbd', { text: following ? 'O' : 'F' }));
    }
    const cameraHint = this.keyHint(following ? 'overview' : 'focusTank', keyMode);
    camera.title = cameraHint ? `${label} (${cameraHint})` : label;
    const cameraKey = camera.querySelector('kbd'); if (cameraKey) { setText(cameraKey, cameraHint); cameraKey.hidden = !cameraHint; }

    if (this.dev) this.renderTelemetry(tank);
  }

  private keyHint(action: BindableAction, mode: BindingContext): string {
    const code = currentSettings().controls.bindings[mode][action]?.[0];
    return code ? keyLabel(code) : '';
  }

  private setInfo(open: boolean): void {
    this.infoOpen = open;
    show(byId('match-info'), open);
    byId('roster').setAttribute('aria-expanded', String(open));
    if (open) { this.infoKey = ''; this.update(); }
  }

  private applySliders(): void {
    const yaw = Number(byId<HTMLInputElement>('bearing').value) * Math.PI / 180;
    const pitch = Number(byId<HTMLInputElement>('elevation').value) * Math.PI / 180;
    const power = Number(byId<HTMLInputElement>('power').value) / 100;
    this.deps.actions.aim(yaw, pitch, power);
    this.update();
  }

  /** Copies the tank's aim into the sliders and readouts (never the slider being dragged, unless forced by a turn change). */
  private syncSliders(force: boolean): void {
    const s = session(), tank = s.snapshot?.tanks[s.observer];
    if (!tank) return;
    const values: [string, number, string][] = [
      ['bearing', deg(tank.turretYaw), `${Math.round(deg(tank.turretYaw))}°`],
      ['elevation', deg(tank.barrelPitch), `${Math.round(deg(tank.barrelPitch))}°`],
      ['power', tank.power * 100, `${Math.round(tank.power * 100)}%`],
    ];
    for (const [id, value, label] of values) {
      const slider = byId<HTMLInputElement>(id);
      if (force || this.dragging !== slider) { const text = String(Math.round(value * 2) / 2); if (slider.value !== text) slider.value = text; }
      setFill(slider);
      setText(byId(`${id}-value`), label);
    }
    setText(byId('bearing-readout'), values[0][2]); setText(byId('elevation-readout'), values[1][2]);
  }

  /** The tank chip: a swatch, health and a bar per tank (names live in the match-info drawer). */
  private renderRoster(rows: RosterRow[]): void {
    const roster = byId('roster');
    roster.dataset.cameraDrag = '';
    byId('banner').dataset.cameraDrag = '';
    byId('wind-chip').dataset.cameraDrag = '';
    const key = rows.map(r => `${r.index}:${r.team}`).join('|');
    if (key !== this.rosterKey) {
      this.rosterKey = key;
      fill(roster, ...rows.map(row => el('span', { class: 'roster-pip', 'data-tank': row.index },
        el('span', { class: 'roster-swatch', style: `background:${row.color}` }), el('span', { class: 'roster-hp' }),
        el('span', { class: 'roster-bar' }, el('span', { class: 'roster-fill' })))));
    }
    rows.forEach((row, i) => {
      const node = roster.children[i] as HTMLElement;
      this.rowState(node, row);
      setText(node.querySelector('.roster-hp'), hpText(row));
      node.title = filterProfanity(row.stale ? `${row.name}: last seen` : row.name, currentSettings().gameplay.profanityFilter);
      const fillNode = node.querySelector<HTMLElement>('.roster-fill')!, width = hpWidth(row);
      if (fillNode.style.width !== width) fillNode.style.width = width;
    });
  }

  private renderInfoRoster(rows: RosterRow[]): void {
    const box = byId('info-roster');
    const filtered = currentSettings().gameplay.profanityFilter;
    const key = `${filtered}:` + rows.map(r => `${r.index}:${r.name}:${r.team}`).join('|');
    if (key !== this.infoKey) {
      this.infoKey = key;
      fill(box, ...rows.map(row => el('div', { class: 'roster-row', 'data-tank': row.index },
        el('span', { class: 'roster-swatch', style: `background:${row.color}` }), el('span', { class: 'roster-name', text: filterProfanity(row.name, filtered) }),
        el('span', { class: 'roster-hp' }), el('span', { class: 'roster-bar' }, el('span', { class: 'roster-fill' })))));
    }
    rows.forEach((row, i) => {
      const node = box.children[i] as HTMLElement;
      this.rowState(node, row);
      setText(node.querySelector('.roster-hp'), hpText(row));
      const fillNode = node.querySelector<HTMLElement>('.roster-fill')!, width = hpWidth(row);
      if (fillNode.style.width !== width) fillNode.style.width = width;
      node.title = filterProfanity(row.stale ? `${row.name}: last seen` : row.name, filtered);
    });
  }

  private rowState(node: HTMLElement, row: RosterRow): void {
    const set = (name: string, on: boolean) => { if (node.classList.contains(name) !== on) node.classList.toggle(name, on); };
    set('self', row.self); set('ally', row.ally && !row.self); set('active', row.active); set('destroyed', row.destroyed); set('stale', row.stale);
  }

  private renderMunitions(tank: TankState, aiming: boolean, ready: boolean, keyMode: BindingContext): void {
    const chips = ammoChips(tank, session().setup?.rules), box = byId('munitions');
    const key = chips.map(c => c.id).join('|');
    if (key !== this.chipsKey) {
      this.chipsKey = key;
      fill(box, ...chips.map(chip => el('button', { type: 'button', class: 'ammo-chip', role: 'radio', 'data-munition': chip.id, title: chip.name,
        onclick: () => { this.deps.actions.munition(chip.id); this.refocus(); } }, el('span', { class: 'ammo-name', text: chip.short }), el('span', { class: 'ammo-count' }), el('kbd'))));
    }
    chips.forEach((chip, i) => {
      const node = box.children[i] as HTMLButtonElement;
      if (node.getAttribute('aria-checked') !== String(chip.selected)) node.setAttribute('aria-checked', String(chip.selected));
      const disabled = !aiming || !ready || chip.empty;
      if (node.disabled !== disabled) node.disabled = disabled;
      setText(node.querySelector('.ammo-count'), chip.count === null ? '∞' : `×${chip.count}`);
      const action = (Object.keys(WEAPON_MUNITIONS) as WeaponAction[]).find(action => WEAPON_MUNITIONS[action] === chip.id)!;
      const hint = this.keyHint(action, keyMode), key = node.querySelector('kbd')!;
      setText(key, hint); key.hidden = !hint;
      node.title = hint ? `${chip.name} (${hint})` : chip.name;
    });
    const selected = chips.find(c => c.selected) ?? chips[0];
    if (selected) {
      setText(byId('munition-name'), selected.short);
      setText(byId('munition-count'), selected.count === null ? '∞' : `×${selected.count}`);
      const cycle = byId<HTMLButtonElement>('munition-cycle'), label = `Munition: ${selected.name}. Next munition`;
      if (cycle.getAttribute('aria-label') !== label) cycle.setAttribute('aria-label', label);
      const action = (Object.keys(WEAPON_MUNITIONS) as WeaponAction[]).find(action => WEAPON_MUNITIONS[action] === selected.id)!;
      const hint = this.keyHint(action, keyMode), key = cycle.querySelector('kbd')!;
      setText(key, hint); key.hidden = !hint;
      cycle.title = `${label}${hint ? ` · Select with ${hint}` : ''}`;
      const disabled = !aiming || !ready || chips.filter(c => !c.empty).length < 2;
      if (cycle.disabled !== disabled) cycle.disabled = disabled;
    }
  }

  private renderTelemetry(tank: TankState): void {
    const stats = this.deps.view.telemetry() as unknown as Record<string, unknown>;
    const gpu = typeof stats.gpuMs === 'number' ? ` · GPU ${number(stats.gpuMs, 2)} ms` : '';
    setText(byId('perf'), `WEBGPU · ${number(stats.fps)} FPS · P95 ${number(stats.p95, 1)} ms${gpu}`);
    const seed = this.deps.terrainInfo()?.seed ?? session().setup?.seed ?? 7;
    const triangles = typeof stats.triangles === 'number' ? stats.triangles.toLocaleString('en-US') : '—';
    setText(byId('terrain-perf'), `${(this.deps.terrainInfo()?.planetKind ?? planetType(seed)).toUpperCase()} · SEED ${seed} · ${triangles} △`);
    byId('perf').title = `Position ${tank.position.map(v => v.toFixed(2)).join(', ')} · heading ${deg(tank.heading).toFixed(1)}°`;
  }

  private syncDevButtons(): void {
    const drive = this.deps.context().driveTest;
    const button = byId('drive-test');
    button.textContent = drive ? 'Exit drive test' : 'Dev: Drive test';
    button.setAttribute('aria-pressed', String(drive));
    byId('restart').hidden = !drive;
    const debug = byId('vehicle-debug');
    debug.hidden = !drive;
    debug.setAttribute('aria-pressed', String(this.vehicleDebug));
    debug.textContent = `Vehicle debug: ${this.vehicleDebug ? 'On' : 'Off'}`;
  }

  /** Mouse and keyboard play keep focus on the view so keys keep working; a thumb tap leaves focus alone. */
  private refocus(): void { if (this.deps.inputStyle() === 'pointer') byId('viewport').focus({ preventScroll: true }); }
}

