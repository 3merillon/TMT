/**
 * Persistent workshop screen: the canvas and GPU resources survive every profile/UI refresh.
 * Wide screens: header tools, overall stats, the components drawer and a footer toolbar around the room.
 * Phones (≤ 700 px wide): a slim top bar (leave, build picker, ⋯ tools), the budget strip, and one part sheet that rests at
 * peek / half / full; the view shrinks to sit above the settled sheet, so the tank is never under a panel. Popups replace
 * the sheet instead of stacking on it.
 */
import type { KitLoadoutIds } from '../../api/match';
import { KIT_SLOTS, validateKitLoadout, type SlotId } from '../../kit';
import { appearanceFinish, equippedAppearance, PAINT_FINISHES, type PaintPattern, type TankAppearance } from '../../meta/cosmetics';
import { activeKit, defaultProfile, exportProfile, withAppearance } from '../../meta/profile';
import { paintTextureBytes } from '../../presentation/paint-raster';
import { fittingBudget, lockedKitParts, purchaseSpecialPart, SPECIAL_DESIGNS, type SpecialDesign } from '../../meta/special-designs';
import type { WorkshopScene } from '../../workshop/scene';
import { DEFAULT_BRUSH, PaintSession, type PaintBrush, type PaintSurfaceHit } from '../../workshop/paint';
import { prefetchWorkshop, workshopOpening } from '../../workshop/assets';
import { disableWorkshopSandbox, enableWorkshopSandbox, workshopSandbox } from '../../workshop/sandbox';
import { el } from '../components/el';
import { bindSnapSheet } from '../components/sheet';
import { sheetHeights, type SnapPoint } from '../components/sheet-model';
import { partPreview } from '../part-preview';
import { buildStats, compareStats, partCards, partName, replacementKit, sameKit, SLOT_LABELS, WorkshopInstallGuard, type PartCard } from '../workshop-model';
import type { ScreenContext } from './context';
import '../workshop.css';

type Snap = 'peek' | 'half' | 'full';
/** The part sheet's peek height: handle, category tabs, the status line and the action row. */
const PEEK = 172;
const descriptions: Record<SlotId, string> = { hull: 'Protection, mass and mobility.', runningGear: 'Put your power into the ground.', turret: 'Protection, traverse and mounting.', weapon: 'Choose how you leave your mark.', utility: 'Select the antenna on the tank to inspect accessories.' };
const control = (text: string, id: string, action: () => void, extra = '') => el('button', { type: 'button', class: `ws-control ${extra}`, id, onclick: action, text,
  ...(id.startsWith('workshop-close-') ? { 'aria-label': `Close ${id.slice('workshop-close-'.length)}` } : {}) });

export class WorkshopScreen {
  readonly element = el('section', { id: 'workshop', class: 'ws', 'aria-label': 'Tank workshop' });
  private readonly host = el('div', { class: 'ws-viewport', id: 'workshop-viewport', tabindex: 0, 'aria-label': '3D tank. Drag to orbit, scroll to zoom; select components directly or use the component controls.' });
  private readonly overlay = el('div', { class: 'ws-overlay' });
  private readonly status = el('span', { class: 'ws-status-copy', text: 'Opening the service bay…' });
  private readonly guard = new WorkshopInstallGuard();
  private readonly loading = new AbortController();
  private ctx: ScreenContext;
  private scene: WorkshopScene | null = null;
  private slot: SlotId = 'hull';
  private previewId: string | null = null;
  private displayedKit: KitLoadoutIds;
  private displayedIndex: number;
  private pending = false;
  private installError: string | null = null;
  private quick = false;
  private disposed = false;
  private ready = false;
  private failed = false;
  private presentation = false;
  private drawer = false;
  private popup: 'builds' | 'paint' | 'options' | 'more' | null = null;
  private snap: Snap = 'peek';
  private readonly compact = matchMedia('(max-width: 700px)');
  private readonly onCompact = () => { if (!this.disposed) this.draw(); };
  private paint: PaintSession | null = null;
  private paintError: string | null = null;
  private leaveDialog: HTMLDialogElement | null = null;
  private cancelLeave: (() => void) | null = null;
  private readonly beforeUnload = (event: BeforeUnloadEvent) => {
    if (this.hasUnsavedPaint) { event.preventDefault(); event.returnValue = ''; }
  };
  get hasUnsavedPaint(): boolean { return this.paint?.dirty ?? false; }
  private brush: PaintBrush = { ...DEFAULT_BRUSH };
  private get sandbox(): boolean { return workshopSandbox.active; }
  private get currentKit(): KitLoadoutIds { return this.sandbox && workshopSandbox.kit ? workshopSandbox.kit : this.ctx.profile.loadouts[this.ctx.profile.activeLoadout].kit; }
  private get appearance(): TankAppearance { return this.sandbox && workshopSandbox.appearance ? workshopSandbox.appearance : equippedAppearance(this.ctx.profile.cosmetics); }
  private get budget(): number { return this.sandbox ? Infinity : fittingBudget(this.ctx.profile); }

  constructor(ctx: ScreenContext) {
    this.ctx = ctx;
    this.displayedIndex = ctx.profile.activeLoadout;
    this.displayedKit = { ...this.currentKit };
    this.element.append(this.host, this.overlay); this.draw();
    this.compact.addEventListener('change', this.onCompact);
    window.addEventListener('beforeunload', this.beforeUnload);
    this.element.addEventListener('keydown', event => {
      if (this.leaveDialog) return;
      if (this.paint && (event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
        event.preventDefault(); event.stopPropagation(); if (event.key.toLowerCase() === 'y' || event.shiftKey) this.paint.redo(); else this.paint.undo(); this.scene?.setAppearance(this.paint.value); this.draw(); return;
      }
      if (event.key === 'Escape' && (this.drawer || this.popup)) {
        event.preventDefault(); event.stopPropagation(); this.closePanel();
      }
    });
    // Asset downloads start beside the scene code instead of after it; a renderer the title prepared is adopted.
    workshopOpening();
    void prefetchWorkshop('high').catch(() => {});
    requestAnimationFrame(() => { if (!this.disposed) void this.initialize(); });
  }
  private async initialize(): Promise<void> {
    try {
      const { createWorkshopScene } = await import('../../workshop/scene');
      if (this.disposed) return;
      const settings = this.ctx.profile.settings;
      const scene = await createWorkshopScene(this.host, {
        kit: this.displayedKit, reducedMotion: settings.gameplay.reducedMotion, palette: this.ctx.profile.cosmetics.palette,
        signal: this.loading.signal,
        audioVolume: settings.audio.master * settings.audio.sfx,
        audioSettings: settings.audio,
        graphics: settings.graphics,
        onSelect: slot => this.selectSlot(slot), onStatus: message => { if (!this.disposed) this.status.textContent = message; },
        onPaint: (hit, phase) => this.paintStroke(hit, phase),
      });
      if (this.disposed) { scene.dispose(); return; }
      this.scene = scene; this.ready = true;
      scene.setKit(this.displayedKit); scene.setPalette(this.ctx.profile.cosmetics.palette); scene.setReducedMotion(this.ctx.profile.settings.gameplay.reducedMotion);
      scene.setAppearance(this.paint?.value ?? this.appearance); scene.setPaintMode(this.paint ? this.brush : null);
      if (this.previewId) scene.setPreview(this.slot, this.previewId);
      this.draw();
    } catch (error) {
      if (this.disposed) return;
      this.failed = true;
      this.status.textContent = `Workshop could not open: ${error instanceof Error ? error.message : String(error)}`; this.draw();
    }
  }
  update(ctx: ScreenContext): HTMLElement {
    if (this.disposed) return this.element;
    this.ctx = ctx;
    const index = ctx.profile.activeLoadout, kit = this.currentKit;
    if (index !== this.displayedIndex || !sameKit(kit, this.displayedKit)) {
      this.cancel(false); this.previewId = null; this.displayedKit = { ...kit }; this.displayedIndex = index; this.scene?.setKit(kit);
    }
    this.scene?.setReducedMotion(ctx.profile.settings.gameplay.reducedMotion); this.scene?.setPalette(ctx.profile.cosmetics.palette);
    this.scene?.setAppearance(this.paint?.value ?? this.appearance);
    this.scene?.setAudioSettings(ctx.profile.settings.audio); this.scene?.setGraphicsSettings(ctx.profile.settings.graphics); this.draw();
    return this.element;
  }
  dispose(): void { window.removeEventListener('beforeunload', this.beforeUnload); this.cancelLeave?.(); this.cancelLeave = null; this.leaveDialog?.close(); this.leaveDialog?.remove(); this.leaveDialog = null; this.compact.removeEventListener('change', this.onCompact); this.disposed = true; this.loading.abort(); this.guard.cancel(); this.scene?.dispose(); this.scene = null; this.element.remove(); }
  /** Every exit shares this transaction. Failed saves leave the editor and drawing intact. */
  requestLeave(continueLeaving: () => void, cancelLeaving?: () => void): void {
    if (this.leaveDialog) { this.leaveDialog.querySelector<HTMLElement>('#workshop-paint-keep')?.focus(); cancelLeaving?.(); return; }
    this.paint?.end();
    if (!this.hasUnsavedPaint) { this.finishPaint(false); continueLeaving(); return; }
    const focusId = (document.activeElement as HTMLElement | null)?.id;
    const dismiss = (cancel = true) => {
      this.leaveDialog?.close(); this.leaveDialog?.remove(); this.leaveDialog = null;
      const cancelled = this.cancelLeave; this.cancelLeave = null; if (cancel) cancelled?.();
      this.element.querySelector<HTMLElement>(focusId ? `#${CSS.escape(focusId)}` : '#workshop-paint-save')?.focus();
    };
    const error = el('p', { class: 'ws-note', role: 'alert', id: 'workshop-paint-save-error' });
    const dialog = el('dialog', { class: 'ws-panel ws-paint-confirm', id: 'workshop-paint-confirm', 'aria-labelledby': 'workshop-paint-confirm-title', 'aria-describedby': 'workshop-paint-confirm-copy' },
      el('h2', { id: 'workshop-paint-confirm-title', text: 'Save your design?' }),
      el('p', { class: 'ws-note', id: 'workshop-paint-confirm-copy', text: this.sandbox ? 'Your paint and finish changes are not saved to this sandbox session yet.' : 'Your paint and finish changes are not saved yet. Save them before leaving the editor.' }), error,
      el('div', { class: 'ws-paint-actions' },
        control('Save design', 'workshop-paint-confirm-save', () => {
          if (!this.finishPaint(true)) { error.textContent = this.status.textContent; return; }
          dismiss(false); continueLeaving();
        }, 'ws-install'),
        control('Discard changes', 'workshop-paint-discard', () => { this.finishPaint(false); dismiss(false); continueLeaving(); }),
        control('Keep painting', 'workshop-paint-keep', () => dismiss())));
    dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
    this.cancelLeave = cancelLeaving ?? null; this.leaveDialog = dialog; this.element.append(dialog); dialog.showModal();
    dialog.querySelector<HTMLElement>('#workshop-paint-keep')?.focus();
  }
  /** Also used by gamepad/back navigation when rebuilding a popup has moved focus to the page. */
  closePanel(): boolean {
    if (this.leaveDialog) { this.leaveDialog.querySelector<HTMLButtonElement>('#workshop-paint-keep')?.click(); return true; }
    if (!this.drawer && !this.popup) return false;
    const opener = this.popup ?? (this.compact.matches ? 'sheet-handle' : 'components');
    this.requestLeave(() => {
      this.scene?.clearSelection(); this.drawer = false; this.popup = null; this.draw();
      this.element.querySelector<HTMLElement>(opener === 'sheet-handle' ? '#workshop-sheet-handle' : opener === 'more' ? '#workshop-more' : `#workshop-open-${opener}`)?.focus();
    }); return true;
  }
  private motionReduced(): boolean { return this.ctx.profile.settings.gameplay.reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches; }
  private selectSlot(slot: SlotId): void {
    if (this.disposed) return;
    if (this.paint) { this.requestLeave(() => this.selectSlot(slot)); return; }
    this.cancel(false); this.drawer = true; this.popup = null; this.slot = slot; this.previewId = null; this.scene?.setPreview(slot, null); this.scene?.focus(slot);
    this.status.textContent = `${SLOT_LABELS[slot]} inspection · choose a part to compare.`; this.draw();
  }
  private preview(part: PartCard): void {
    this.installError = null;
    this.cancel(false); this.previewId = part.status === 'fitted' ? null : part.id; this.scene?.setPreview(this.slot, this.previewId);
    this.status.textContent = this.previewId ? `${part.name} on the delivery trolley · your installed build is unchanged.` : `${part.name} is installed.`; this.draw();
  }
  private cancel(redraw = true): void {
    const wasPending = this.pending, hadPreview = this.previewId !== null;
    this.guard.cancel();
    if (this.pending) { this.scene?.cancelInstall(); this.status.textContent = 'Installation cancelled · original assembly restored.'; }
    this.pending = false;
    if (redraw) { if (!wasPending && hadPreview) this.status.textContent = 'Preview discarded · your installed build is unchanged.'; this.previewId = null; this.scene?.setPreview(this.slot, null); this.draw(); }
  }
  private async install(): Promise<void> {
    if (!this.scene || !this.previewId || this.pending || this.disposed) return;
    const { profile } = this.ctx, index = profile.activeLoadout;
    const job = this.guard.begin(index, this.currentKit, this.slot, this.previewId, this.budget, this.sandbox ? undefined : profile);
    if (!job) return;
    this.installError = null;
    this.pending = true; this.draw();
    let installed = false;
    try { installed = await this.scene.install(job.slot, job.id, { quick: this.quick || this.motionReduced(), sandbox: this.sandbox, budget: this.budget }); }
    catch (error) { if (!this.disposed) { this.installError = `Installation stopped: ${error instanceof Error ? error.message : String(error)}`; this.status.textContent = this.installError; } }
    if (this.disposed) return;
    const current = this.ctx.profile;
    const completed = this.guard.complete(job.token, current.activeLoadout, this.currentKit);
    if (!completed) return;
    this.pending = false;
    if (!installed) { this.installError ??= 'Installation did not complete. The original build is still installed.'; this.draw(); return; }
    this.previewId = null; this.displayedKit = { ...completed.candidate }; this.scene.setPreview(this.slot, null);
    if (!this.sandbox && lockedKitParts(current, validateKitLoadout(completed.candidate)).length) { this.scene.setKit(this.currentKit); this.displayedKit = { ...this.currentKit }; this.status.textContent = 'Blueprint access changed during installation. Original build restored.'; this.draw(); return; }
    this.saveKit(completed.candidate);
    const names = KIT_SLOTS.filter(slot => completed.installed[slot] !== completed.candidate[slot]).map(slot => partName(slot, completed.candidate[slot]));
    if (completed.candidate.armor === 'reactive' && completed.installed.armor !== 'reactive') names.push('reactive armor');
    this.status.textContent = `${names.join(' + ')} installed · ${this.sandbox ? 'sandbox build ready to test; normal builds unchanged' : 'build saved and ready for your next match'}.`;
  }
  private partCard(part: PartCard): HTMLElement {
    const candidate = replacementKit(this.displayedKit, this.slot, part.id);
    const selected = this.previewId === part.id || (!this.previewId && part.status === 'fitted');
    return el('button', {
      class: `ws-part ${selected ? 'is-selected' : ''} status-${part.status}`, id: `workshop-part-${part.id}`, type: 'button',
      'data-part': part.id, 'aria-pressed': String(selected), 'aria-label': `${part.name}. ${part.reason}. Preview component.`,
      disabled: part.status === 'incompatible' || part.status === 'coming-soon', onclick: () => this.preview(part),
    },
    el('span', { class: 'ws-part-drawing' }, partPreview(candidate, this.slot), el('span', { class: 'ws-part-tag', text: part.status === 'fitted' ? 'INSTALLED' : part.status === 'locked' ? 'BLUEPRINT LOCKED' : this.previewId === part.id ? 'PREVIEW' : part.status === 'over-budget' ? 'OVER BUDGET' : part.status === 'incompatible' ? 'MOUNT UNSUPPORTED' : part.adjustments?.length ? 'MATCHED ASSEMBLY' : 'COMPATIBLE' })),
    el('span', { class: 'ws-part-title' }, el('strong', { text: part.name }), el('span', { class: 'ws-part-cost', text: part.cost === null ? '—' : this.sandbox ? `${part.cost} · unrestricted` : `${part.cost} / ${this.budget}` })),
    el('span', { class: 'ws-part-description', text: part.status === 'incompatible' ? part.reason : `${part.blurb}${part.adjustments?.length ? ` Auto-fit: ${part.adjustments.join('; ')}. Installed together as one assembly.` : ''}${part.status === 'locked' ? ` ${part.reason}. Inspect freely or try it in Sandbox.` : ''}` }));
  }
  private purchase(id: string): void {
    if (this.sandbox || this.pending) return;
    const current = this.ctx.profile, next = purchaseSpecialPart(current, id);
    if (next === current) return;
    this.ctx.setProfile(next); this.status.textContent = `${partName(this.slot, id)} blueprint purchased. ${next.scrap} scrap remaining.`;
  }
  private sandboxPreset(design: SpecialDesign): void {
    if (!this.sandbox) return;
    if (this.paint) { this.requestLeave(() => this.sandboxPreset(design)); return; }
    this.cancel(false); this.previewId = null;
    workshopSandbox.kit = { ...design.kit };
    workshopSandbox.appearance = { ...this.appearance, paint: [], paintTextures: [], finish: { pattern: 'solid', colors: [...design.colors], scale: 1 } };
    this.displayedKit = { ...design.kit }; this.scene?.setKit(design.kit); this.scene?.setAppearance(this.appearance);
    this.status.textContent = `${design.name} assembled in Sandbox. Drive or Combat test uses this complete set; progression is unchanged.`; this.draw();
  }
  private saveKit(kit: KitLoadoutIds): void {
    if (this.sandbox) { workshopSandbox.kit = { ...kit }; this.displayedKit = { ...kit }; this.scene?.setKit(kit); this.draw(); }
    else this.ctx.setLoadout(this.ctx.profile.activeLoadout, kit);
  }
  private saveAppearance(appearance: TankAppearance): boolean {
    if (this.sandbox) { workshopSandbox.appearance = structuredClone(appearance); this.scene?.setAppearance(appearance); this.draw(); }
    else {
      const profile = withAppearance(this.ctx.profile, appearance);
      if (this.ctx.saveProfile) { if (!this.ctx.saveProfile(profile)) return false; }
      else this.ctx.setProfile(profile);
    }
    return true;
  }
  private toggleSandbox(): void {
    if (this.paint) { this.requestLeave(() => this.toggleSandbox()); return; }
    this.cancel(false);
    if (this.sandbox) disableWorkshopSandbox(); else enableWorkshopSandbox(this.ctx.profile);
    this.previewId = null; this.displayedKit = { ...this.currentKit }; this.scene?.setKit(this.displayedKit); this.scene?.setAppearance(this.appearance);
    const restored = this.sandbox ? null : buildStats(this.currentKit), over = !!restored && restored.cost > this.budget;
    this.status.textContent = this.sandbox ? 'SANDBOX · every catalog part and finish available; no fitting budget. Physical mount compatibility still applies. Normal progress is unchanged.'
      : over ? `Normal workshop restored · your saved build costs ${restored!.cost}, over your ${this.budget} fitting budget. Swap in cheaper parts or reset it before your next match.`
      : 'Normal workshop restored · your saved builds and progress are unchanged.';
    this.draw();
  }
  /** The saved build replaced by the standard starter build (always within the rank 1 budget). */
  private resetBuild(): void {
    this.cancel(false); const kit = activeKit(defaultProfile()); this.saveKit(kit); this.scene?.setKit(kit);
    this.status.textContent = 'Saved build reset to the standard build.'; this.draw();
  }
  private armorControls(): HTMLElement {
    const kit = this.currentKit, enabled = kit.hull === 'bastion', reactive = kit.armor === 'reactive';
    const candidate: KitLoadoutIds = { ...kit, armor: reactive ? 'standard' : 'reactive' };
    const stats = enabled ? buildStats(candidate) : null, overBudget = !!stats && stats.cost > this.budget;
    const button = el('button', { type: 'button', id: 'workshop-reactive-armor', class: 'ws-control', 'aria-pressed': String(reactive), disabled: !enabled || overBudget || this.pending,
      onclick: () => { this.cancel(false); this.saveKit(candidate); this.scene?.setKit(candidate); }, text: reactive ? 'Remove reactive armor' : overBudget ? 'Reactive armor · over budget' : 'Fit reactive armor' });
    return el('div', { class: 'ws-armor' }, button, el('p', { class: 'ws-note', text: enabled
      ? 'Bastion cassettes: +2 t, +2 fitting; four single-use hull sections. First direct shell hit −40%, rail −15%. Roof, turret, splash and nuclear hits receive no reactive benefit. Replenished each match.'
      : 'Reactive armor requires the Bastion mounting rails. Light hulls trade protection for acceleration and agility.' }));
  }
  private paintStroke(hit: PaintSurfaceHit | null, phase: 'start' | 'move' | 'end'): void {
    if (!this.paint) return;
    if (phase === 'start') this.paint.begin();
    if (phase === 'end') { this.paint.end(); this.draw(); return; }
    if (!hit) return;
    if (this.paint.dab(hit, this.brush)) this.scene?.setAppearance(this.paint.value);
  }
  private finishPaint(save: boolean): boolean {
    const session = this.paint; if (!session) return true;
    session.end();
    if (save && !this.saveAppearance(session.value)) { this.status.textContent = 'Browser storage is full or unavailable. Your drawing is still open. Export design to keep a copy, then free storage and try Save again.'; this.paintError = this.status.textContent; return false; }
    this.paint = null; this.paintError = null; this.scene?.setPaintMode(null); this.popup = null;
    if (save) { this.status.textContent = this.sandbox ? 'Design saved to the sandbox session.' : 'Design saved · paint follows retained components in workshop and gameplay.'; }
    else { this.scene?.setAppearance(this.appearance); this.status.textContent = session.dirty ? 'Paint changes discarded.' : 'Design unchanged.'; }
    return true;
  }
  private paintPanel(): HTMLElement {
    const session = this.paint!, finish = appearanceFinish(session.value);
    const update = (appearance: TankAppearance) => { session.change(appearance); this.scene?.setAppearance(session.value); this.draw(); };
    const slider = (label: string, id: string, value: number, min: number, max: number, step: number, change: (value: number) => void) => {
      const output = el('output', { text: value.toFixed(2) });
      const input = el('input', { type: 'range', id, min, max, step, value, 'aria-label': label });
      input.addEventListener('input', () => { const n = Number(input.value); output.value = n.toFixed(2); change(n); this.scene?.setPaintMode(this.brush); });
      input.addEventListener('change', () => { session.end(); this.draw(); });
      return el('label', { class: 'ws-brush-slider', for: id }, el('span', { text: label }), output, input);
    };
    const color = el('input', { type: 'color', id: 'workshop-brush-color', value: this.brush.color, 'aria-label': 'Brush color' });
    color.addEventListener('input', () => { this.brush.color = color.value; this.scene?.setPaintMode(this.brush); });
    const pattern = el('select', { id: 'workshop-paint-pattern', 'aria-label': 'Camouflage pattern' }, ...(['solid', 'woodland', 'geometric', 'stripe'] as PaintPattern[]).map(value => el('option', { value, selected: finish.pattern === value, text: value === 'stripe' ? 'Identification stripe' : value[0].toUpperCase() + value.slice(1) })));
    pattern.addEventListener('change', () => update({ ...session.value, finish: { ...finish, pattern: pattern.value as PaintPattern } }));
    const colors = finish.colors.map((value, i) => {
      const input = el('input', { type: 'color', id: `workshop-finish-color-${i}`, value, 'aria-label': `Palette color ${i + 1}` });
      input.addEventListener('change', () => { const colors = [...finish.colors] as [string, string, string]; colors[i] = input.value; update({ ...session.value, finish: { ...finish, colors } }); });
      return el('label', {}, `Color ${i + 1}`, input);
    });
    const undo = control('Undo', 'workshop-paint-undo', () => { session.undo(); this.scene?.setAppearance(session.value); this.draw(); }); undo.disabled = !session.canUndo;
    const redo = control('Redo', 'workshop-paint-redo', () => { session.redo(); this.scene?.setAppearance(session.value); this.draw(); }); redo.disabled = !session.canRedo;
    const preset = el('select', { id: 'workshop-paint-preset', 'aria-label': 'Finish preset' }, el('option', { value: '', text: 'Choose a finish…' }), ...PAINT_FINISHES.map((p, i) => el('option', { value: i, text: p.name })));
    preset.addEventListener('change', () => { if (preset.value !== '') update({ ...session.value, paintId: Number(preset.value) === 1 ? 'paint:ochre' : 'paint:sage', finish: structuredClone(PAINT_FINISHES[Number(preset.value)].finish) }); });
    return el('aside', { class: 'ws-popup ws-panel ws-paint-panel', role: 'dialog', 'aria-label': 'Tank paint editor', 'aria-modal': 'false' },
      el('div', { class: 'ws-panel-head' }, el('h2', { text: 'Surface paint' }), control('×', 'workshop-close-paint', () => this.closePanel(), 'ws-close')),
      el('p', { class: `ws-paint-save-state ${session.dirty ? 'is-unsaved' : ''}`, id: 'workshop-paint-save-state', role: 'status', text: session.dirty ? 'Unsaved changes · Save design to keep your work' : 'Design saved · no unsaved changes' }),
      this.paintError ? el('p', { class: 'ws-note ws-paint-save-error', role: 'alert', text: this.paintError }) : null,
      el('p', { class: 'ws-note', text: 'Left-drag to paint visible metal. Right-drag or Alt-drag to orbit; wheel zooms. Touch gestures orbit. Tracks, glass and hardware are masked.' }),
      el('div', { class: 'ws-paint-controls' }, el('label', {}, 'Finish', preset), el('label', {}, 'Pattern', pattern), el('div', { class: 'ws-palette-colors' }, ...colors),
        slider('Pattern scale', 'workshop-pattern-scale', finish.scale, .4, 2.5, .1, value => { session.begin(); session.value = { ...session.value, finish: { ...appearanceFinish(session.value), scale: value } }; this.scene?.setAppearance(session.value); }),
        el('label', { class: 'ws-brush-color' }, 'Brush color', color),
        slider('Radius', 'workshop-brush-radius', this.brush.radius, .02, .5, .01, value => { this.brush.radius = value; }),
        slider('Opacity', 'workshop-brush-opacity', this.brush.opacity, .05, 1, .05, value => { this.brush.opacity = value; }),
        slider('Edge softness', 'workshop-brush-softness', this.brush.softness, 0, 1, .05, value => { this.brush.softness = value; }),
        el('button', { type: 'button', class: 'ws-control', id: 'workshop-paint-eraser', 'aria-pressed': String(this.brush.eraser), text: this.brush.eraser ? 'Eraser active · clear paint' : 'Use eraser', onclick: () => { this.brush.eraser = !this.brush.eraser; this.scene?.setPaintMode(this.brush); this.draw(); } }),
        el('div', { class: 'ws-paint-actions' }, undo, redo, control('Reset paint', 'workshop-paint-reset', () => { session.reset(); this.scene?.setAppearance(session.value); this.draw(); })),
        el('div', { class: 'ws-paint-actions' }, control('Save design', 'workshop-paint-save', () => { this.finishPaint(true); this.draw(); }, 'ws-install'), control('Close editor', 'workshop-paint-cancel', () => this.closePanel())),
        control('Export design', 'workshop-paint-export', () => {
          const url = URL.createObjectURL(new Blob([exportProfile(withAppearance(this.ctx.profile, session.value))], { type: 'application/json' }));
          el('a', { href: url, download: 'tmt-painted-profile.json' }).click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
          this.status.textContent = 'Profile and current design exported. Import this JSON from Settings → Profile to restore it.';
        })),
      el('p', { class: 'ws-note', text: `No stroke limit · ${Math.ceil(paintTextureBytes(session.value) / 1024)} KB compressed paint · 32 undo gestures. Eraser clears painted pixels; Reset clears the drawing. All paint is cosmetic.` }),
      session.archivedTiles ? el('p', { class: 'ws-note', role: 'status', text: 'Some saved paint belongs to an older component geometry. It remains in your design and export; unchanged surfaces keep their paint.' }) : null);
  }
  private draw(): void {
    const profile = this.ctx.profile, index = profile.activeLoadout, build = profile.loadouts[index];
    const installed = buildStats(this.currentKit)!, cards = partCards(this.currentKit, this.slot, this.budget, this.sandbox ? undefined : profile), overBudget = installed.cost > this.budget, unowned = this.sandbox ? [] : lockedKitParts(profile, validateKitLoadout(this.currentKit));
    const preview = cards.find(p => p.id === this.previewId), proposed = preview?.stats ?? installed;
    if (!this.drawer) this.snap = 'peek'; else if (this.snap === 'peek') this.snap = 'half';
    const openPopup = (name: 'builds' | 'paint' | 'options' | 'more') => {
      if (this.paint) { const closing = this.popup === name; this.requestLeave(() => { if (!closing) openPopup(name); else this.draw(); }); return; }
      this.popup = this.popup === name ? null : name; this.drawer = false; this.draw();
      if (this.popup === 'paint') { this.cancel(); this.paintError = null; this.paint = new PaintSession(this.appearance, this.currentKit); this.scene?.setPaintMode(this.brush); this.draw(); }
      this.element.querySelector<HTMLElement>(this.popup ? '.ws-popup button' : `#workshop-open-${name}`)?.focus();
    };
    const close = () => { this.closePanel(); };
    const budgetAlert = () => overBudget || unowned.length ? [el('p', { class: 'ws-note ws-over-budget', role: 'alert', text: `${overBudget ? 'Over your fitting budget' : `Uses blueprints you do not own (${unowned.map(id => partName(KIT_SLOTS.find(slot => this.currentKit[slot] === id)!, id)).join(', ')})`}: matches will not start with this build. Swap ${overBudget ? 'in cheaper' : 'out those'} parts or reset it.` }), control('Reset to standard build', 'workshop-reset-build', () => this.resetBuild())] : [];
    const appearance = this.paint?.value ?? this.appearance;
    const lightsButton = () => el('button', { type: 'button', class: 'ws-control', id: 'workshop-lights', 'aria-pressed': String(appearance.lights !== false), text: appearance.lights !== false ? 'Lights on' : 'Lights off', onclick: () => { const next = { ...appearance, lights: appearance.lights === false }; if (this.paint) { this.paint.change(next); this.scene?.setAppearance(next); this.draw(); } else this.saveAppearance(next); } });
    const sandboxButton = () => el('button', { type: 'button', id: 'workshop-sandbox', class: `ws-control ${this.sandbox ? 'is-sandbox' : ''}`, 'aria-pressed': String(this.sandbox), onclick: () => this.toggleSandbox(), text: this.sandbox ? 'Exit sandbox' : 'Sandbox' });
    const viewButtons = () => (['hero', 'front', 'side', 'rear', 'top'] as const).map(view => control(view === 'hero' ? '↺ Reset' : view[0].toUpperCase() + view.slice(1), `workshop-view-${view}`, () => this.scene?.setView(view)));
    const presentationButton = () => control(this.presentation ? 'Show controls' : 'Hide controls', 'workshop-presentation', () => { this.presentation = !this.presentation; this.scene?.setPresentation(this.presentation); this.element.classList.toggle('is-presentation', this.presentation); this.draw(); });
    const comparison = () => preview ? el('div', { class: 'ws-comparison' },
      el('div', { class: 'ws-stat-heading' }, el('span', { text: 'Before → after' }), el('span', { text: 'Preview only' })),
      el('dl', { class: 'ws-stats' }, ...compareStats(installed, proposed).map(line => el('div', { class: `ws-stat change-${line.change}` },
        el('dt', { text: line.label }), el('dd', {}, el('span', { class: 'ws-stat-before', text: `${line.before.toFixed(line.digits)}${line.unit ? ` ${line.unit}` : ''}` }),
          el('span', { class: 'ws-stat-after', text: `→ ${line.after.toFixed(line.digits)}` }),
          line.change !== 'same' ? el('small', { text: `${line.delta > 0 ? '+' : ''}${line.delta.toFixed(line.digits)}` }) : null))))) : null;
    const overallStats = () => el('dl', { class: 'ws-overall-stats' }, ...compareStats(installed, installed).map(line => el('div', {},
      el('dt', { text: line.label }), el('dd', { text: `${line.before.toFixed(line.digits)}${line.unit ? ` ${line.unit}` : ''}` }))));
    const slotButtons = () => KIT_SLOTS.map(slot => el('button', {
      class: 'ws-slot', id: `workshop-slot-${slot}`, type: 'button', 'data-slot': slot, 'aria-pressed': String(slot === this.slot), onclick: () => this.selectSlot(slot), text: SLOT_LABELS[slot],
    }));
    const installActions = (): (HTMLElement | null)[] => {
      const action = control(this.pending ? 'Installing…' : preview?.status === 'over-budget' ? 'Over budget' : preview?.status === 'locked' ? 'Blueprint required' : `Install ${preview?.name ?? ''}`, 'workshop-install', () => { void this.install(); }, 'ws-install');
      action.disabled = !this.ready || this.pending || !preview || preview.status !== 'available';
      if (preview?.status === 'available') action.dataset.primary = '';
      return [preview?.status === 'locked' && preview.price ? el('button', { type: 'button', class: 'ws-control ws-install', id: 'workshop-purchase', text: `Buy blueprint · ${preview.price} scrap`, disabled: !preview.canPurchase || this.pending, onclick: () => this.purchase(preview.id) }) : null,
        control(this.pending ? 'Cancel' : 'Discard', 'workshop-cancel', () => this.cancel()), action];
    };
    const previewCopy = () => el('span', { ...(this.installError ? { role: 'alert', class: 'ws-install-error' } : {}), text: this.installError ?? (this.pending ? 'Mechanical installation in progress' : preview?.status === 'locked' ? preview.reason : `Preview · ${proposed.cost}${this.sandbox ? ' · unrestricted' : ` / ${this.budget} fitting`} · ${preview?.adjustments?.length ? `Auto-fit ${preview.adjustments.join('; ')} · paired assembly` : preview?.status === 'over-budget' ? 'over budget' : 'compatible mount'}`) });
    const status = () => el('div', { class: 'ws-service-status', role: 'status', 'aria-live': 'polite' }, el('span', { class: `ws-status-dot ${this.pending ? 'is-busy' : ''}`, 'aria-hidden': 'true' }), this.status);
    const testDrive = () => control('Drive test', 'workshop-test-drive', () => this.requestLeave(() => this.ctx.startWorkshopTest?.('drive')));
    const testCombat = () => control('Combat test', 'workshop-test-combat', () => this.requestLeave(() => this.ctx.startWorkshopTest?.('bot')));
    let popup: HTMLElement | null = null;
    if (this.popup === 'builds' && this.sandbox) popup = el('aside', { class: 'ws-popup ws-panel', role: 'dialog', 'aria-label': 'Sandbox builds' },
      el('div', { class: 'ws-panel-head' }, el('h2', { text: 'Sandbox build' }), control('×', 'workshop-close-builds', close, 'ws-close')),
      el('p', { class: 'ws-note', text: 'This experimental build is kept for the current session. Drive and Combat test use it. Exit sandbox to return to your three saved builds; normal progression and ownership stay unchanged.' }),
      ...SPECIAL_DESIGNS.map(design => el('div', { class: 'ws-sandbox-design' }, el('strong', { text: design.name }), el('p', { class: 'ws-note', text: design.description }), control(`Assemble ${design.name}`, `workshop-preset-${design.id}`, () => this.sandboxPreset(design)))));
    if (this.popup === 'builds' && !this.sandbox) {
      const nameInput = el('input', { id: 'build-name', class: 'ws-name-input', type: 'text', value: build.name, maxlength: 24, 'aria-label': 'Build name', enterkeyhint: 'done', autocomplete: 'off' });
      nameInput.addEventListener('change', () => this.ctx.setLoadout(index, build.kit, nameInput.value));
      popup = el('aside', { class: 'ws-popup ws-panel', role: 'dialog', 'aria-label': 'Saved builds', 'aria-modal': 'false' },
        el('div', { class: 'ws-panel-head' }, el('h2', { text: 'Saved builds' }), control('×', 'workshop-close-builds', close, 'ws-close')),
        el('div', { class: 'ws-builds', role: 'group', 'aria-label': 'Three saved builds' }, ...profile.loadouts.map((loadout, i) => el('button', {
          type: 'button', class: `ws-build ${i === index ? 'is-active' : ''}`, id: `workshop-build-${i}`, 'aria-pressed': String(i === index),
          onclick: () => { this.cancel(false); this.ctx.setActiveLoadout(i); },
        }, el('span', { class: 'ws-build-number', text: `0${i + 1}` }), el('strong', { text: loadout.name }), el('small', { text: i === index ? 'Active' : 'Saved' })))),
        el('label', { class: 'ws-name-label', for: 'build-name', text: 'Rename active build' }), nameInput,
        el('p', { class: 'ws-note', text: 'The active build is used in your next match.' }));
    }
    if (this.popup === 'paint' && this.paint) popup = this.paintPanel();
    if (this.popup === 'options') {
      const reduced = el('input', { id: 'workshop-reduced-motion', type: 'checkbox', checked: profile.settings.gameplay.reducedMotion });
      reduced.addEventListener('change', () => { this.ctx.updateSettings({ gameplay: { reducedMotion: reduced.checked } }); this.scene?.setReducedMotion(reduced.checked); this.draw(); });
      const quick = el('input', { id: 'workshop-quick-install', type: 'checkbox', checked: this.quick });
      quick.addEventListener('change', () => { this.quick = quick.checked; });
      popup = el('aside', { class: 'ws-popup ws-panel', role: 'dialog', 'aria-label': 'Workshop options', 'aria-modal': 'false' },
        el('div', { class: 'ws-panel-head' }, el('h2', { text: 'Options' }), control('×', 'workshop-close-options', close, 'ws-close')),
        el('div', { class: 'ws-options' }, el('label', {}, quick, 'Quick installation'), el('label', {}, reduced, 'Reduced motion')),
        el('p', { class: 'ws-note', text: 'Drag to orbit. Scroll or pinch to zoom. Arrow keys and + / − work too. Esc closes an open panel.' }));
    }
    if (this.popup === 'more') popup = el('aside', { class: 'ws-popup ws-panel', role: 'dialog', 'aria-label': 'Workshop tools', 'aria-modal': 'false' },
      el('div', { class: 'ws-panel-head' }, el('h2', { text: 'Tools' }), control('×', 'workshop-close-more', close, 'ws-close')),
      el('div', { class: 'ws-more-grid', role: 'group', 'aria-label': 'Workshop tools' }, testDrive(), testCombat(), sandboxButton(),
        control('Paint', 'workshop-open-paint', () => openPopup('paint')), lightsButton(), control('Options', 'workshop-open-options', () => openPopup('options'))),
      el('div', { class: 'ws-more-views', role: 'group', 'aria-label': 'Inspection camera angles' }, ...viewButtons(), presentationButton()));

    if (this.compact.matches) {
      this.element.classList.add('is-compact');
      this.drawCompact(el('header', { class: 'ws-bar' },
        el('button', { type: 'button', class: 'ws-control ws-round', id: 'workshop-back', 'aria-label': 'Leave workshop', onclick: () => this.requestLeave(() => { this.cancel(false); this.ctx.go({ type: 'BACK' }); }), text: '←' }),
        el('button', { type: 'button', class: 'ws-control ws-build-pick', id: 'workshop-open-builds', 'aria-expanded': String(this.popup === 'builds'), onclick: () => openPopup('builds') },
          el('span', { class: 'ws-bar-title', text: 'Workshop' }), el('strong', { text: `${this.sandbox ? 'Sandbox' : build.name} ▾` })),
        el('button', { type: 'button', class: 'ws-control ws-round', id: 'workshop-more', 'aria-expanded': String(this.popup === 'more'), 'aria-label': 'More workshop tools', onclick: () => openPopup('more'), text: '⋯' })),
      el('div', { class: 'ws-budget', 'aria-label': 'Fitting budget' },
        el('div', { class: 'ws-budget-row' }, el('span', { text: this.sandbox ? 'Sandbox · no budget' : `Rank ${profile.rank} · ${profile.scrap} scrap` }),
          el('strong', { id: 'build-cost', class: overBudget ? 'is-over-budget' : '', text: this.sandbox ? `${installed.cost} fitting` : `${installed.cost} / ${this.budget} fitting` })),
        this.sandbox ? null : el('span', { class: `meter ws-budget-meter ${overBudget ? 'is-over-budget' : ''}` }, el('span', { style: `width:${Math.min(100, installed.cost / Math.max(1, this.budget) * 100).toFixed(1)}%` })),
        ...budgetAlert()),
      el('section', { class: 'ws-sheet ws-panel', id: 'workshop-components', 'data-snap': this.snap, 'aria-label': 'Tank components' },
        el('button', { type: 'button', class: 'ws-sheet-handle', id: 'workshop-sheet-handle', 'aria-label': `Parts sheet (${this.snap}). Change its height` }),
        el('div', { class: 'ws-slot-list', role: 'group', 'aria-label': 'Part categories' }, ...slotButtons()),
        el('div', { class: 'ws-drawer-scroll' },
          el('div', { class: 'ws-catalog-heading' }, el('h3', { text: SLOT_LABELS[this.slot] }), el('p', { text: descriptions[this.slot] })),
          el('div', { class: 'ws-parts', id: 'part-grid' }, ...cards.map(part => this.partCard(part))),
          this.slot === 'hull' ? this.armorControls() : null,
          comparison() ?? el('div', { class: 'ws-comparison' }, el('div', { class: 'ws-stat-heading' }, el('span', { text: 'Installed build' }), el('span', { text: 'Overall' })), overallStats())),
        el('footer', { class: 'ws-sheet-actions' },
          preview || this.pending ? el('div', { class: 'ws-preview-copy' }, el('strong', { text: preview?.name ?? 'Installing component' }), previewCopy()) : status(),
          el('div', { class: 'ws-sheet-buttons' }, ...(preview || this.pending ? installActions()
            : [control('Test drive ▸', 'workshop-sheet-test', () => this.requestLeave(() => this.ctx.startWorkshopTest?.('drive')), 'ws-install')])))),
      popup, this.presentation ? el('div', { class: 'ws-present-exit' }, presentationButton()) : null);
      return;
    }
    this.element.classList.remove('is-compact');
    this.element.style.removeProperty('--ws-sheet'); this.element.style.removeProperty('--ws-view-bottom');
    const top = el('header', { class: 'ws-header' },
      el('h1', { text: 'Workshop' }),
      el('span', { class: 'ws-current-build', text: this.sandbox ? 'SANDBOX · session only' : build.name }),
      sandboxButton(), testDrive(), testCombat(),
      control('Leave ↗', 'workshop-back', () => this.requestLeave(() => { this.cancel(false); this.ctx.go({ type: 'BACK' }); }), 'ws-leave'));
    const overall = el('aside', { class: 'ws-overall', 'aria-label': 'Installed tank overall statistics' },
      el('div', { class: 'ws-overall-title' }, el('span', { text: this.sandbox ? 'Unrestricted test build' : `Rank ${profile.rank} · ${profile.scrap} scrap` }), el('strong', { id: 'build-cost', class: overBudget ? 'is-over-budget' : '', text: this.sandbox ? `${installed.cost} · no budget` : `${installed.cost} / ${this.budget} fitting${overBudget ? ' · over budget' : ''}` })),
      ...budgetAlert(), overallStats());
    const left = this.drawer ? el('aside', { class: 'ws-catalog ws-panel', id: 'workshop-components', role: 'dialog', 'aria-label': 'Tank components', 'aria-modal': 'false' },
      el('div', { class: 'ws-panel-head' }, el('h2', { text: 'Components' }), control('×', 'workshop-close-components', close, 'ws-close')),
      el('div', { class: 'ws-slot-list', role: 'group', 'aria-label': 'Part categories' }, ...slotButtons()),
      el('div', { class: 'ws-drawer-scroll' },
        el('div', { class: 'ws-catalog-heading' }, el('h3', { text: SLOT_LABELS[this.slot] }), el('p', { text: descriptions[this.slot] })),
        el('div', { class: 'ws-parts', id: 'part-grid' }, ...cards.map(part => this.partCard(part))),
        this.slot === 'hull' ? this.armorControls() : null,
        comparison())) : null;
    const actionBar = preview || this.pending ? el('div', { class: 'ws-actionbar', 'aria-label': 'Preview installation' },
      el('div', { class: 'ws-preview-copy' }, el('strong', { text: preview?.name ?? 'Installing component' }), previewCopy()),
      ...installActions()) : null;
    const bottom = el('footer', { class: 'ws-footer' },
      el('div', { class: 'ws-tools', role: 'toolbar', 'aria-label': 'Workshop tools' },
        el('button', { type: 'button', class: 'ws-control', id: 'workshop-open-components', 'aria-expanded': String(this.drawer), 'aria-controls': 'workshop-components',
          onclick: () => this.requestLeave(() => { this.drawer = !this.drawer; this.popup = null; this.draw();
            this.element.querySelector<HTMLElement>(this.drawer ? `.ws-slot[aria-pressed="true"]` : '#workshop-open-components')?.focus(); }), text: 'Components' }),
        control('Builds', 'workshop-open-builds', () => openPopup('builds')),
        control('Paint', 'workshop-open-paint', () => openPopup('paint')),
        lightsButton(),
        control('Options', 'workshop-open-options', () => openPopup('options'))),
      el('div', { class: 'ws-camera-controls', role: 'group', 'aria-label': 'Inspection camera angles' },
        ...viewButtons(), presentationButton()),
      status());
    this.overlay.replaceChildren(...[top, overall, left, popup, actionBar, bottom].filter((node): node is HTMLElement => !!node));
    this.loadingNotice();
  }
  private loadingNotice(): void {
    if (!this.ready) this.overlay.append(el('div', { class: `ws-loading ${this.failed ? 'has-error' : ''}`, role: 'status', text: this.failed ? 'The 3D workshop is unavailable. Leave and reopen to retry.' : 'Opening workshop…' }));
  }
  /** The part sheet's snap heights for this viewport. */
  private snaps(): SnapPoint<Snap>[] {
    const h = sheetHeights(innerHeight, PEEK);
    return [{ id: 'peek', height: h.peek }, { id: 'half', height: h.half }, { id: 'full', height: h.full }];
  }
  /** Phone layout: the bar, the budget strip, then the part sheet or the open popup (never both). */
  private drawCompact(bar: HTMLElement, budget: HTMLElement, sheet: HTMLElement, popup: HTMLElement | null, exit: HTMLElement | null): void {
    const snaps = this.snaps(), height = snaps.find(s => s.id === this.snap)!.height, half = snaps[1].height;
    // The view sits above the settled sheet (capped at half: a full sheet is for reading stats, not for hiding the tank).
    this.element.style.setProperty('--ws-sheet', `${height}px`);
    this.element.style.setProperty('--ws-view-bottom', `${popup ? snaps[0].height : Math.min(height, half)}px`);
    const handle = sheet.querySelector<HTMLElement>('#workshop-sheet-handle')!;
    bindSnapSheet(sheet, handle, { snaps: () => this.snaps(), current: () => this.snap, settle: id => { this.snap = id; this.drawer = id !== 'peek'; this.draw(); } });
    this.overlay.replaceChildren(...[bar, budget, popup ?? sheet, exit].filter((node): node is HTMLElement => !!node));
    this.loadingNotice();
  }
}
