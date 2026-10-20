/**
 * Application-lifetime score: ONE director and ONE player for the whole app. Scene changes, world changes, threat,
 * boss phases and mission cues move the plan; nothing ever recreates the transport. The 60 ms timer drives the player
 * (pending quantized starts, retirements) and re-plans at most every 250 ms.
 */
import type { AudioManager } from './audio-manager';
import type { PlanetKind } from '../world/sun';
import scoreManifest from './score-manifest.json';
import type { ScoreManifest } from './score/manifest';
import { MusicDirector, type BossState, type DirectorInput, type DirectorPlan, type MusicScene, type Outcome } from './score/director';
import { FetchStemLoader, ScorePlayer, type StemLoader } from './score/player';

export const MAX_MUSIC_VOICES = 16;
const TIMER_MS = 60, PLAN_INTERVAL_S = 0.25;
export const SCORE_MANIFEST = scoreManifest as unknown as ScoreManifest;

export interface MusicBedOptions { loader?: StemLoader; baseUrl?: string; manifest?: ScoreManifest; offline?: boolean }

export class MusicBed {
  readonly player: ScorePlayer;
  readonly director: MusicDirector;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private enabled = false;
  private muted = false;
  private scene: MusicScene = 'title';
  private world: PlanetKind | undefined;
  private mission: string | null = null;
  private threat = 0;
  private boss: BossState | null = null;
  private phase: DirectorInput['phase'] = null;
  private escalation = -1;
  private ending: DirectorInput['ending'] = null;
  private outcome: Outcome = null;
  private dialogue = false;
  private match = 0;
  private lastPlanAt = -Infinity;
  private plan: DirectorPlan | null = null;
  private ticks = 0; private totalMs = 0; private maxMs = 0;
  pendingMs = 0;

  constructor(private readonly m: AudioManager, o: MusicBedOptions = {}) {
    const manifest = o.manifest ?? SCORE_MANIFEST;
    const loader = o.loader ?? new FetchStemLoader(m.ctx, o.baseUrl ?? (typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env.BASE_URL : '/'));
    this.player = new ScorePlayer(m.ctx, m.buses.input.music, manifest, loader, { offline: o.offline });
    this.director = new MusicDirector({ has: id => !!manifest.tracks[id] });
  }
  get playing(): boolean { return this.enabled; }
  get liveVoices(): number { return this.player.sourceCount; }
  /** Bars elapsed in the current track (kept for telemetry parity with the old synth score's `notes`). */
  get notes(): number { return this.player.position()?.bar ?? 0; }
  get skipped(): number { return 0; }

  /** Idempotent: repeated starts never restart the transport. */
  start(_seed = 0, world?: PlanetKind): void {
    this.enabled = true;
    if (world) this.world = world;
    if (this.timer === null) this.schedule();
    this.replan(true);
  }
  stop(): void {
    this.enabled = false;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.player.request(null, [0, 0, 0, 0, 0], false);
  }
  setScene(scene: MusicScene, world?: PlanetKind): void {
    this.scene = scene; if (world) this.world = world;
    if (scene === 'title' || scene === 'menu') { this.mission = null; this.boss = null; this.phase = null; this.escalation = -1; this.ending = null; this.outcome = null; this.threat = 0; }
    this.replan(true);
  }
  setMission(id: string | null): void { this.mission = id; this.match++; this.boss = null; this.phase = null; this.escalation = id === 'ii-7' ? 0 : -1; this.ending = null; this.outcome = null; this.threat = 0; }
  setMuted(muted: boolean): void { this.muted = muted; this.player.setMuted(muted); }
  /** Legacy intensity input (0..1) from callers that have no threat model; the integrator calls setThreat. */
  setIntensity(value: number): void { this.setThreat(value); }
  setThreat(value: number): void { this.threat = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; }
  setBoss(boss: BossState | null): void { if ((boss?.id ?? null) !== (this.boss?.id ?? null) || (boss?.phase ?? -1) !== (this.boss?.phase ?? -1)) { this.boss = boss; this.replan(true); } }
  setPhase(phase: DirectorInput['phase']): void { if (phase !== this.phase) { this.phase = phase; this.replan(true); } }
  setEscalation(stage: number): void { if (stage !== this.escalation) { this.escalation = stage; this.replan(true); } }
  setEnding(ending: DirectorInput['ending']): void { if (ending !== this.ending) { this.ending = ending; this.replan(true); } }
  setOutcome(outcome: Outcome): void { if (outcome !== this.outcome) { this.outcome = outcome; this.replan(true); } }
  setDialogue(active: boolean): void { if (active !== this.dialogue) { this.dialogue = active; this.replan(true); } }
  /** A named stinger (stinger-<id> in the manifest), beat-quantized. */
  stinger(id: string): void { if (this.player.has(`stinger-${id}`)) this.player.playStinger(`stinger-${id}`); }
  /** Warms the cache for a world's tracks (loading screens). */
  prefetch(world: PlanetKind | undefined, mission: string | null): void {
    const set = this.director ? worldSetFor(world, mission) : 'cradle';
    for (const id of [`${set}-explore`, `${set}-combat`]) if (this.player.has(id)) void this.player.prefetch(id).catch(() => {});
  }
  private schedule(): void { this.timer = setTimeout(() => { this.timer = null; if (this.enabled) { this.tick(); this.schedule(); } }, TIMER_MS); }
  tick(): void {
    if (!this.enabled) return;
    const start = typeof performance !== 'undefined' ? performance.now() : 0;
    try {
      this.player.tick();
      const now = this.m.ctx.currentTime;
      if (now - this.lastPlanAt >= PLAN_INTERVAL_S) this.replan(false);
    } catch (error) { this.m.lastError = error instanceof Error ? error.message : String(error); }
    if (typeof performance !== 'undefined') { const ms = performance.now() - start; this.pendingMs += ms; this.totalMs += ms; this.maxMs = Math.max(this.maxMs, ms); this.ticks++; }
  }
  private replan(force: boolean): void {
    if (!this.enabled) return;
    const now = this.m.ctx.currentTime;
    this.lastPlanAt = now;
    const plan = this.director.update({ scene: this.scene, world: this.world, mission: this.mission, threat: this.threat, boss: this.boss, phase: this.phase, escalation: this.escalation, ending: this.ending, outcome: this.outcome, dialogue: this.dialogue, match: this.match }, now);
    const changed = !this.plan || force || plan.track !== this.plan.track || plan.layers.some((w, i) => Math.abs(w - this.plan!.layers[i]) > 0.001) || plan.level !== this.plan.level;
    this.plan = plan;
    if (plan.stinger) this.player.playStinger(plan.stinger);
    if (!changed) return;
    this.player.setLevel(plan.level);
    this.player.request(plan.track, plan.layers, plan.intro, { fade: plan.fade, quantize: plan.quantize });
    if (plan.track) this.player.pinOnly([plan.track, ...(this.scene === 'skirmish' ? [`${worldSetFor(this.world, this.mission)}-explore`, `${worldSetFor(this.world, this.mission)}-combat`] : [])]);
  }
  snapshot() {
    return { playing: this.playing, scene: this.scene, world: this.world ?? null, mission: this.mission, match: this.match, muted: this.muted, threat: Math.round(this.threat * 100) / 100, tier: this.director.currentTier, boss: this.boss, phase: this.phase, escalation: this.escalation, ending: this.ending, outcome: this.outcome,
      plan: this.plan ? { track: this.plan.track, layers: this.plan.layers, level: this.plan.level } : null, ...this.player.snapshot(), scheduler: { ticks: this.ticks, avgMs: this.ticks ? this.totalMs / this.ticks : 0, maxMs: this.maxMs } };
  }
  dispose(): void { this.stop(); this.player.dispose(); }
}
import { worldSetOf as worldSetFor } from './score/director';
