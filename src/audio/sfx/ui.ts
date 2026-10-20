/**
 * UI and feedback cues on the ui bus (non-spatial) and alerts on the alerts bus: pre-rendered sprites when the bank is
 * ready, Pinionfall-lineage recipes before. `installUiSounds` delegates at the document level (buttons click, selects
 * and checkboxes confirm, range sliders ratchet) so it keeps working whatever the shell's markup becomes.
 */
import type { AudioManager } from '../audio-manager';
import type { SfxBank } from '../sfx-bank';
import type { Voice } from './layers';
import { uiRecipe, type UiSound } from './tank-sfx-math';
import { PRIORITY } from '../voice-select';

const SPRITE: Partial<Record<UiSound, string>> = {
  click: 'ui-click', hover: 'ui-hover', confirm: 'ui-confirm', cancel: 'ui-cancel', open: 'ui-open', close: 'ui-close', denied: 'ui-denied', aim: 'ui-aim',
  turn: 'ui-objectiveNew', 'turn-other': 'ui-captureTick', 'objective-new': 'ui-objectiveNew', 'objective-done': 'ui-objectiveDone', 'objective-failed': 'ui-objectiveFailed',
  checkpoint: 'ui-checkpoint', banner: 'ui-banner', alarm: 'ui-alarm', incoming: 'ui-incoming', overheat: 'ui-overheat', repair: 'ui-repair', 'capture-tick': 'ui-captureTick', 'reload-ready': 'ui-reloadReady', 'depot-ping': 'ui-depotPing',
};
const ALERTS = new Set<UiSound>(['alarm', 'incoming']);
let bankRef: SfxBank | null = null;
/** The bank the UI layer plays from (set once by the engine). */
export function setUiBank(bank: SfxBank | null): void { bankRef = bank; }

export function playUi(m: AudioManager, kind: UiSound, value01 = 0.5, seed = 0): Voice | null {
  const sprite = SPRITE[kind], bank = bankRef;
  const alert = ALERTS.has(kind);
  if (bank?.ready && sprite && bank.sprite(sprite)) {
    const rate = kind === 'aim' ? Math.pow(2, (Math.max(0, Math.min(1, value01)) - 0.5) * 10 / 12) : 1;
    const voice = bank.play(m, sprite, { bus: alert ? 'alerts' : 'ui', priority: alert ? PRIORITY.alert : PRIORITY.ui, gain: alert ? 1 : 0.9, rate, variant: seed, burst: true, minLoudness: 0.0005 });
    if (alert && voice) m.alertDuck(m.now());
    return voice;
  }
  const voice = m.play(uiRecipe(kind, value01, seed), { bus: alert ? 'alerts' : 'ui', priority: alert ? PRIORITY.alert : PRIORITY.ui, burst: true, minLoudness: 0.0005 });
  if (alert && voice) m.alertDuck(m.now());
  return voice;
}

/** Minimum spacing of slider ticks (s) and the slider quantisation (steps across the range). */
const AIM_TICK_GAP_MS = 28;
const AIM_STEPS = 40;
/** Allow a little finger jitter, but never turn a scroll drag into a button cue. */
const TAP_SLOP_PX = 10;

export function installUiSounds(m: AudioManager, doc: Document): () => void {
  let lastAim = 0, lastStep = -1;
  const presses = new Map<number, { target: Element; x: number; y: number }>();
  const buttonTarget = (event: Event) => event.target instanceof Element ? event.target.closest('button, [role="button"], summary') : null;
  const cue = (target: Element) => {
    const disabled = (target as HTMLButtonElement).disabled || target.getAttribute('aria-disabled') === 'true';
    playUi(m, disabled ? 'denied' : 'click');
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const target = buttonTarget(event);
    if (!target) return;
    presses.set(event.pointerId, { target, x: event.clientX, y: event.clientY });
  };
  const onPointerMove = (event: PointerEvent) => {
    const press = presses.get(event.pointerId);
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > TAP_SLOP_PX) presses.delete(event.pointerId);
  };
  const onPointerUp = (event: PointerEvent) => {
    const press = presses.get(event.pointerId);
    presses.delete(event.pointerId);
    if (!press || buttonTarget(event) !== press.target || !press.target.isConnected
      || Math.hypot(event.clientX - press.x, event.clientY - press.y) > TAP_SLOP_PX) return;
    // Touch/HUD controls can capture the pointer, so event.target alone cannot establish an in-bounds release.
    const rect = press.target.getBoundingClientRect();
    if (event.clientX >= rect.left && event.clientX < rect.right && event.clientY >= rect.top && event.clientY < rect.bottom) cue(press.target);
  };
  const onPointerCancel = (event: PointerEvent) => { presses.delete(event.pointerId); };
  const reset = () => { presses.clear(); };
  const onVisibility = () => { if (doc.hidden) reset(); };
  const onClick = (event: MouseEvent) => {
    // Pointer releases already provide the cue, including disabled buttons and secondary touch HUD presses.
    // Keyboard/assistive activation and .click() have no pointing device and still deserve feedback.
    if (event.detail > 0 || (event as PointerEvent).pointerType) return;
    const target = buttonTarget(event);
    if (target) cue(target);
  };
  const onChange = (event: Event) => {
    const t = event.target;
    if (t instanceof HTMLSelectElement) playUi(m, 'confirm');
    else if (t instanceof HTMLInputElement && (t.type === 'checkbox' || t.type === 'radio')) playUi(m, t.checked ? 'confirm' : 'cancel');
  };
  const onInput = (event: Event) => {
    const t = event.target;
    if (!(t instanceof HTMLInputElement) || t.type !== 'range') return;
    const min = Number(t.min || 0), max = Number(t.max || 100), value = Number(t.value);
    const value01 = max > min ? (value - min) / (max - min) : 0.5;
    const step = Math.round(value01 * AIM_STEPS), now = performance.now();
    if (step === lastStep || now - lastAim < AIM_TICK_GAP_MS) return;
    lastStep = step; lastAim = now;
    playUi(m, 'aim', value01);
  };
  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('pointermove', onPointerMove, true);
  doc.addEventListener('pointerup', onPointerUp, true);
  doc.addEventListener('pointercancel', onPointerCancel, true);
  doc.addEventListener('lostpointercapture', onPointerCancel, true);
  doc.addEventListener('scroll', reset, true);
  doc.addEventListener('visibilitychange', onVisibility);
  doc.defaultView?.addEventListener('blur', reset);
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('change', onChange, true);
  doc.addEventListener('input', onInput, true);
  return () => {
    reset();
    doc.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('pointermove', onPointerMove, true);
    doc.removeEventListener('pointerup', onPointerUp, true);
    doc.removeEventListener('pointercancel', onPointerCancel, true);
    doc.removeEventListener('lostpointercapture', onPointerCancel, true);
    doc.removeEventListener('scroll', reset, true);
    doc.removeEventListener('visibilitychange', onVisibility);
    doc.defaultView?.removeEventListener('blur', reset);
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('change', onChange, true);
    doc.removeEventListener('input', onInput, true);
  };
}
