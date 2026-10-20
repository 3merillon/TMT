/**
 * Audio composition entry (imported once by src/game/app/composition.ts). Deliberately small: the engine is a lazy
 * chunk (engine-entry.ts), loaded in the first idle period after the page starts.
 *
 * - registerHooks('audio', …) forwards match start, events, frames and match end to the engine; the session's realtime
 *   events (coax tracers, objectives, banners, mission results) and the mission runner's beat/ending/outcome are read
 *   from the running session and forwarded too;
 * - registerTelemetry('audio', …) publishes window.__tmtGame.audio: state, voices, busPeaks, clipCount, lastError, the
 *   music plan, the bank, the threat model and the main-thread cost per frame measured here;
 * - audio starts on the first pointer or key gesture (0.6 s master fade-in). What needs no gesture is built in idle time
 *   before it: the AudioContext (created suspended and kept so) and the whole engine graph, noise pools and impulse
 *   response included, with no source started. Suspended while the tab is hidden, resumed when it is visible;
 * - window `tmt:settings` (a CustomEvent, dispatched by the shell) sets detail.audio.{master, music, sfx, ui, voice};
 * - window `tmt:audio-scene` moves the single persistent score; window `tmt:audio-cue` (or audioCue()) carries the
 *   explicit campaign cues of src/audio/cues.ts.
 */
import type { MatchSetup } from '../game/api/match';
import { registerHooks, registerTelemetry, type FrameInfo } from '../game/app/hooks';
import { session } from '../game/api/session';
import { currentSettings } from '../game/meta/settings';
import type { GameEvent, GameSnapshot } from '../game/contracts';
import type { TankAudioIntegrator, RealtimeAudioEvent } from './integrator';
import type { MusicScene } from './score/director';
import type { PlanetKind } from '../world/sun';
import { CampaignVoice } from './campaign-voice';
import { AUDIO_CUE_EVENT, type AudioCue } from './cues';
let campaignVoice: CampaignVoice | null = null;
export function playCampaignVoice(speaker: string, text: string): Promise<boolean> {
  return campaignVoice?.play(speaker, text) ?? Promise.resolve(false);
}
export function stopCampaignVoice(): void { campaignVoice?.stop(); }
/** Explicit campaign cue (also accepted as window CustomEvent 'tmt:audio-cue' with the cue as `detail`). */
export function audioCue(cue: AudioCue): void {
  s.cues++; s.lastCue = cue.type;
  if (s.engine) { guarded('cue', () => s.engine!.cue(cue)); return; }
  // Before the first gesture there is no engine: keep the latest STATE cues (boss, finale, escalation, ending) so the
  // engine starts in the right musical state; one-shots (stingers, ui) that nobody could hear are dropped.
  if (cue.type === 'boss' || cue.type === 'boss-end') s.pendingCues.set('boss', cue);
  else if (cue.type === 'finale' || cue.type === 'escalation' || cue.type === 'ending') s.pendingCues.set(cue.type, cue);
}
export type { AudioCue } from './cues';

type EngineModule = typeof import('./engine-entry');
/** The session surface the audio reads beyond the public SessionApi (structural, every field optional). */
interface SessionAudioView { on?(event: string, cb: (payload: unknown) => void): () => void; observer?: number; mission?: { beatId?: string | null; ending?: 'rewind' | 'release' | null; outcome?: 'won' | 'failed' | null } | null; snapshot?: GameSnapshot }

const TIMING_WINDOW = 240;
// Workshop tokens only identify its SFX owners. The application owns the sole music clock.
const workshopAudioOwners = new Set<string>();
const timing = { ms: new Float64Array(TIMING_WINDOW), count: 0, cursor: 0, pending: 0, max: 0, frameMax: 0, eventMax: 0 };
const s = {
  engine: null as TankAudioIntegrator | null,
  ctx: null as AudioContext | null,
  module: null as Promise<EngineModule> | null,
  // Built before the first gesture (standby) for the seed then expected; the gesture makes it the engine.
  warm: null as { engine: TankAudioIntegrator; seed: number } | null,
  unlocked: false,
  setup: undefined as MatchSetup | undefined,
  // The latest tmt:settings broadcast (the shell's getter covers a listener that attaches after the load event).
  settings: currentSettings() as unknown,
  unsupported: false,
  lastError: null as string | null,
  warned: false,
  uninstallUi: null as (() => void) | null,
  scene: 'title' as MusicScene,
  world: undefined as PlanetKind | undefined,
  // The session whose realtime events are subscribed, and its unsubscribe.
  sessionRef: null as unknown,
  unsubscribe: null as (() => void) | null,
  missionKey: '',
  realtimeEvents: 0,
  cues: 0,
  lastCue: null as string | null,
  pendingCues: new Map<string, AudioCue>(),
};

function fail(where: string, error: unknown): void {
  const message = `${where}: ${error instanceof Error ? error.message : String(error)}`;
  s.lastError = message;
  // Warnings, not errors: audio never fails a capture or stops the frame loop.
  if (!s.warned) { s.warned = true; console.warn(`[audio] ${message}`); }
}
function guarded(where: string, run: () => void): number {
  const t0 = performance.now();
  try { run(); } catch (error) { fail(where, error); }
  const ms = performance.now() - t0;
  timing.pending += ms;
  return ms;
}

function prefetch(): Promise<EngineModule> {
  s.module ??= import('./engine-entry');
  return s.module;
}

/** The seed the engine's noise and variation take: the match that started last, as when the gesture built it. */
const engineSeed = () => s.setup?.seed ?? 0x7a11;
const idle = (run: () => void) => typeof requestIdleCallback === 'function' ? requestIdleCallback(() => run(), { timeout: 2000 }) : setTimeout(run, 50);
const contextClass = () => window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

/** Builds, in idle time, everything the gesture would otherwise build: creating an AudioContext waits on the browser's
 * audio service (tens of ms when it is cold), the engine synthesises seconds of noise. A failure is left to the gesture. */
function prepare(): void {
  if (s.ctx || s.unsupported) return;
  prefetch().then(mod => {
    const Ctor = contextClass();
    if (s.ctx || s.unsupported || !Ctor) return;
    let ctx: AudioContext;
    try { ctx = new Ctor({ latencyHint: 'interactive' }); } catch { return; }
    s.ctx = ctx;
    // Where the page may start audio unprompted the context runs at once: park it until the gesture.
    void ctx.suspend().catch(() => {});
    idle(() => {
      if (s.engine || s.warm || s.ctx !== ctx) return;
      const seed = engineSeed();
      try { s.warm = { engine: mod.createAudioEngine(ctx, { seed, dev: import.meta.env.DEV, standby: true }), seed }; } catch { /* built by the gesture */ }
    });
  }, () => {});
}

/** A match started before the first gesture: the prepared engine takes its seed now rather than inside the gesture. */
function reseedWarm(): void {
  const warm = s.warm, seed = engineSeed();
  if (warm && !s.engine && warm.seed !== seed) { warm.engine.reseed(seed); warm.seed = seed; }
}

/** The running session, or null before one is provided. */
function sessionView(): SessionAudioView | null { try { return session() as unknown as SessionAudioView; } catch { return null; } }

/** Subscribes the engine to the session's realtime events (once per session instance). */
function attachSession(): void {
  const view = sessionView();
  if (!view || view === s.sessionRef || typeof view.on !== 'function') return;
  s.unsubscribe?.(); s.unsubscribe = null;
  s.sessionRef = view;
  try {
    s.unsubscribe = view.on('realtime', payload => {
      s.realtimeEvents++;
      const event = payload as RealtimeAudioEvent;
      if (!event || typeof event.type !== 'string') return;
      if (s.engine) guarded('realtime', () => s.engine!.onRealtimeEvent(event, view.snapshot));
      else if (event.type === 'audio' && event.cue && typeof event.cue.type === 'string') audioCue(event.cue);
    });
  } catch (error) { fail('session', error); }
}
/** Mirrors the mission runner's beat/ending/outcome into the engine when they change (cheap: read per frame). */
function syncMission(): void {
  const view = sessionView(), engine = s.engine;
  if (!view || !engine) return;
  const m = view.mission, key = m ? `${m.beatId ?? ''}|${m.ending ?? ''}|${m.outcome ?? ''}` : '';
  if (key === s.missionKey) return;
  s.missionKey = key;
  guarded('mission', () => engine.setMissionState(m ? { beat: m.beatId ?? null, ending: m.ending ?? null, outcome: m.outcome ?? null } : { beat: null, ending: null, outcome: null }));
}

function activate(mod: EngineModule, ctx: AudioContext): void {
  if (s.engine || s.ctx !== ctx) return;
  reseedWarm();
  const engine = s.warm?.engine ?? mod.createAudioEngine(ctx, { seed: engineSeed(), dev: import.meta.env.DEV });
  s.warm = null;
  s.engine = engine;
  campaignVoice = new CampaignVoice(ctx, engine.m.buses.input.voice, speaking => { guarded('dialogue', () => engine.setDialogue(speaking)); });
  engine.applySettings(s.settings);
  engine.fadeIn();
  if (s.setup) engine.onMatchStart(s.setup);
  attachSession();
  const view = sessionView(); if (view && typeof view.observer === 'number') engine.setObserver(view.observer);
  engine.setScene(s.scene, s.world);
  // State cues that arrived before the gesture (a boss already fighting, a chosen ending) enter after the scene is set.
  for (const cue of s.pendingCues.values()) guarded('cue', () => engine.cue(cue));
  s.pendingCues.clear();
  engine.start().catch(e => fail('worklet', e));
  s.uninstallUi = mod.installUi(engine, document);
  // Dev-only handle for the audio capture harness (scripts/audio-preview.ts): the engine and its context.
  if (import.meta.env.DEV) (window as unknown as { __tmtAudio?: unknown }).__tmtAudio = { engine, ctx, cue: audioCue };
}

function unlock(): void {
  if (s.unsupported) return;
  if (s.unlocked) {
    if (s.ctx && s.ctx.state !== 'running' && s.ctx.state !== 'closed' && !document.hidden) void s.ctx.resume().catch(e => fail('resume', e));
    return;
  }
  if (!s.ctx) {
    const Ctor = contextClass();
    if (!Ctor) { s.unsupported = true; s.lastError = 'WebAudio is unavailable'; return; }
    try { s.ctx = new Ctor({ latencyHint: 'interactive' }); }
    catch (error) { s.unsupported = true; fail('AudioContext', error); return; }
  }
  const ctx = s.ctx;
  s.unlocked = true;
  // Resume inside the gesture, before anything is scheduled, so currentTime is live for every schedule.
  void ctx.resume().catch(e => fail('resume', e));
  prefetch().then(mod => activate(mod, ctx)).catch(e => fail('load', e));
}

registerHooks('audio', {
  onMatchStart(setup: MatchSetup) {
    s.setup = setup;
    s.missionKey = '';
    s.pendingCues.clear();
    void prefetch().catch(e => fail('prefetch', e));
    if (s.engine) {
      const view = sessionView(); if (view && typeof view.observer === 'number') s.engine.setObserver(view.observer);
      guarded('onMatchStart', () => s.engine!.onMatchStart(setup));
    }
    // Not among the match's first frames: a gesture before then reseeds in activate().
    else setTimeout(() => idle(reseedWarm), 1000);
    attachSession();
  },
  onEvent(e: GameEvent, snap: GameSnapshot) {
    if (s.engine) { const ms = guarded('onEvent', () => s.engine!.onEvent(e, snap)); if (ms > timing.eventMax) timing.eventMax = ms; }
  },
  onFrame(f: FrameInfo) {
    const engine = s.engine;
    if (!engine) return;
    const frameMs = guarded('onFrame', () => { syncMission(); engine.onFrame(f); });
    if (frameMs > timing.frameMax) timing.frameMax = frameMs;
    const cost = timing.pending + engine.takeSchedulerMs();
    timing.pending = 0;
    timing.ms[timing.cursor] = cost;
    timing.cursor = (timing.cursor + 1) % TIMING_WINDOW;
    timing.count++;
    if (cost > timing.max) timing.max = cost;
  },
  onMatchEnd(r) {
    if (s.engine) guarded('onMatchEnd', () => s.engine!.onMatchEnd(r));
  },
});

function cpu() {
  const n = Math.min(timing.count, TIMING_WINDOW);
  if (!n) return { frames: 0, avgMs: 0, p95Ms: 0, maxMs: 0, frameMaxMs: 0, eventMaxMs: 0 };
  const window_ = Array.from(timing.ms.subarray(0, n)).sort((a, b) => a - b);
  const avg = window_.reduce((a, b) => a + b, 0) / n;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return { frames: timing.count, avgMs: r3(avg), p95Ms: r3(window_[Math.min(n - 1, Math.floor(n * 0.95))]), maxMs: r3(timing.max),
    frameMaxMs: r3(timing.frameMax), eventMaxMs: r3(timing.eventMax) };
}

registerTelemetry('audio', () => {
  let base: Record<string, unknown>;
  try {
    base = s.engine?.telemetry() ?? {
      state: s.unsupported ? 'unsupported' : s.unlocked && s.ctx ? s.ctx.state : 'locked',
      voices: { total: 0, max: 56, buses: {} }, busPeaks: {}, clipCount: 0, nan: 0,
    };
  } catch (error) { fail('telemetry', error); base = { state: 'error' }; }
  return { ...base, dialogue: campaignVoice?.telemetry() ?? null, unlocked: s.unlocked, workshopSuppressed: false, workshopOwners: workshopAudioOwners.size, scene: s.scene, realtimeEvents: s.realtimeEvents, cues: s.cues, lastCue: s.lastCue, cpu: cpu(), lastError: (base.lastError as string | null | undefined) ?? s.lastError };
});

if (typeof window !== 'undefined') {
  for (const type of ['pointerdown', 'keydown', 'touchend'] as const) window.addEventListener(type, unlock, { capture: true, passive: true });
  window.addEventListener('tmt:settings', event => {
    s.settings = (event as CustomEvent).detail;
    if (s.engine) guarded('settings', () => s.engine!.applySettings(s.settings));
  });
  window.addEventListener('tmt:workshop-audio', event => {
    const detail = (event as CustomEvent).detail;
    if (!detail || typeof detail.token !== 'string' || typeof detail.active !== 'boolean') return;
    if (detail.active) workshopAudioOwners.add(detail.token); else workshopAudioOwners.delete(detail.token);
  });
  window.addEventListener('tmt:audio-scene', event => {
    const detail = (event as CustomEvent).detail;
    if (!detail || !['title', 'menu', 'workshop', 'setup', 'loading', 'skirmish', 'pause', 'results'].includes(detail.scene)) return;
    s.scene = detail.scene as MusicScene;
    campaignVoice?.setPaused(s.scene === 'pause');
    if (['title', 'menu', 'workshop', 'setup', 'loading'].includes(s.scene)) campaignVoice?.stop();
    if (['temperate', 'glacial', 'dune', 'volcanic'].includes(detail.world)) s.world = detail.world;
    if (s.engine) { s.engine.takeSchedulerMs(); guarded('scene', () => s.engine!.setScene(s.scene, s.world)); }
  });
  window.addEventListener(AUDIO_CUE_EVENT, event => {
    const detail = (event as CustomEvent).detail as AudioCue | undefined;
    if (detail && typeof detail.type === 'string') audioCue(detail);
  });
  document.addEventListener('visibilitychange', () => {
    const ctx = s.ctx;
    if (!ctx || !s.unlocked || ctx.state === 'closed') return;
    if (document.hidden) void ctx.suspend().catch(e => fail('suspend', e));
    else void ctx.resume().catch(e => fail('resume', e));
  });
  idle(prepare);
}
