/** Match session (split from main.ts): owns the simulation, the resident terrain, the carve/commit glue and
 * practice checkpoints, and forwards every GameEvent to view.onGameEvent and the GameHooks. It never touches
 * the renderer or the scene: terrain draws through view.terrainHost (plan §5.1, §5.2). */
import type { GameView } from '../view';
import type { ResidentGameTerrain } from '../resident-terrain';
import type { ResidentGameCheckpoint } from '../resident-checkpoint';
import { GameSimulation, MatchReplay } from '../simulation';
import type { MatchRuntime } from '../api/runtime';
import { RealtimeMatch, type RealtimeEvent, type RealtimeCheckpoint } from '../realtime/match';
import { dispatchAudioCue } from '../../audio/cues';
import { loadRealtimeCore } from '../realtime/core';
import { validComponentState } from '../realtime/components';
import { MissionRunner, missionIdOf } from '../campaign/mission';
import { missionById } from '../campaign/catalog';
import { crewBuild } from '../campaign/loadout';
import { craterProfile } from '../rules/crater';
import { materialCrater, type CraterShell } from '../rules/material-craters';
import { invalidAimTarget, type AimSelection, type AimTargetAim, type AimTargetCollider, type AimTargetResult } from '../rules/aim-target';
import { add, mul, normalize, rotation } from '../math';
import type { MunitionId } from '../munitions';
import { validateMatchCheckpoint, type MatchCheckpointV2 } from '../rules/checkpoint';
import type { DriveInput, GameEvent, PlayerId, TerrainUpdate, V3 } from '../contracts';
import type { MatchSetup } from '../api/match';
import { validateMatchSetup } from '../rules/setup';
import { resolveArtillerySpawns } from '../rules/spawn-placement';
import { buildExtensions } from '../rules/extension-registry';
import { provideSession, type PlayerCommand, type SessionApi } from '../api/session';
import type { SimInterpolation, TankPose } from '../api/extensions';
import { dispatchGameEvent, dispatchMatchEnd, dispatchMatchStart } from './hooks';
import type { PracticeMode } from './dev-flags';
import { planetType, resolvePlanetType } from '../planet-field';
import { validateResidentCheckpoint } from '../resident-checkpoint';
import { readCampaignSave, writeCampaignSave, clearCampaignSave } from '../meta/campaign-save';
import type { NetworkEvent, NetworkSnapshot, Recovery, SessionNetwork } from '../online/state';

// The resident backend stays a lazily loaded chunk, as before the split.
let ResidentBackend: typeof import('../resident-terrain').ResidentGameTerrain | undefined;
const residentBackend = async () => ResidentBackend ??= (await import('../resident-terrain')).ResidentGameTerrain;

/** A warm-up whose frames stopped is handed over after this (the frame loop's own limit is 4 s). */
export const WARM_BACKSTOP_MS = 5000;
export interface WarmBreakdown { sdfMs: number; fluidsMs: number; compileMs: number; frames: number }
type SessionEvent = 'ready' | 'event' | 'finish' | 'error' | 'warming' | 'realtime';
/** Checkpoint v2 with the resident terrain checkpoint (its edit log) as `terrain`. */
export type PracticeCheckpoint = MatchCheckpointV2 & { terrain: ResidentGameCheckpoint | null };
interface CampaignCheckpoint { match: RealtimeCheckpoint; terrain: ResidentGameCheckpoint; beat: string }

/** Practice mode shown by the UI: pass-and-play and drive tests keep their own chrome, everything else plays like the bot duel. */
export function uiMode(setup: MatchSetup): PracticeMode { return setup.mode === 'local' || setup.mode === 'drive' ? setup.mode : 'bot'; }

export class GameSession implements SessionApi {
  network?: SessionNetwork;
  remoteMission?: NetworkSnapshot['mission'];
  private remoteObjectives = '';
  private aftermathTime = 0;
  private aftermathPose?: SimInterpolation;
  private generation = 0;
  private readonly listeners = new Map<SessionEvent, Set<(payload: unknown) => void>>();
  private current?: MatchSetup;
  private terrain?: ResidentGameTerrain;
  private simulation?: MatchRuntime;
  /** The campaign mission driving a realtime match, if any. */
  private missionRunner: MissionRunner | null = null;
  /** Current mission only; retry keeps the exact terrain, hull and objective state at a safe beat boundary. */
  private campaignCheckpoint: CampaignCheckpoint | null = null;
  private checkpointStorage: 'memory' | 'saved' | 'error' = 'memory';
  private checkpointAttempt: string | null = null;
  private drive?: { tank: PlayerId; input: DriveInput };
  private paused = false;
  private saving = false;
  private ended = false;
  private practiceMode: PracticeMode;
  private isReady = false;
  private isStarting = false;
  private reload = false;
  private terrainUpdate: { triangles: number; milliseconds: number; rebuilt: number; seed?: number; planetKind?: import('../planet-field').PlanetType } = { triangles: 0, milliseconds: 0, rebuilt: 0 };
  private preparation = 0;
  private startup: { stage: string; startedAt: number; elapsedMs: number; playableMs: number; completed: number; total: number; warmupMs: number;
    /** When each warm-up condition first held (ms after the warm-up began) and the frames it rendered. */
    warm?: WarmBreakdown } = { stage: 'idle', startedAt: 0, elapsedMs: 0, playableMs: 0, completed: 0, total: 0, warmupMs: 0 };
  private lastObserver = 0;
  /** COMPAT: the serial stall whose carve is running (legacySerialCarve). */
  private carving?: MatchRuntime['stalledOn'];
  /** Releases the match being warmed up (see warm). */
  private warmup?: () => void;

  constructor(private readonly view: GameView, mode: PracticeMode) {
    this.practiceMode = mode;
    provideSession(this);
  }

  get snapshot() { return this.simulation?.state; }
  /** The realtime match, when one is running (campaign HUD: reload, coax heat, unit names). */
  get realtime(): RealtimeMatch | undefined { return this.current?.rules.turnModel === 'realtime' && this.simulation instanceof RealtimeMatch ? this.simulation : undefined; }
  /** The running campaign mission (objectives, marker, outcome). */
  get mission(): MissionRunner | null { return this.missionRunner; }
  get hasCampaignCheckpoint(): boolean { return this.campaignCheckpoint !== null; }
  get setup() { return this.current; }
  /** The tank the local player sees through: the active human in hot-seat play, else the (last) human tank; 0 when spectating bots. */
  get observer(): PlayerId {
    if (this.network) return this.network.seat;
    const simulation = this.simulation;
    if (!simulation || simulation.driveTest) return 0;
    const humans = simulation.state.tanks.filter(tank => simulation.brainOf(tank.id) === null).map(tank => tank.id);
    if (humans.includes(simulation.state.active)) this.lastObserver = simulation.state.active;
    else if (!humans.includes(this.lastObserver)) this.lastObserver = humans[0] ?? 0;
    return this.lastObserver;
  }
  get mode(): PracticeMode { return this.practiceMode; }
  get ready(): boolean { return this.isReady; }
  get starting(): boolean { return this.isStarting; }
  /** The match exists but is not ready: a frame loop renders its tick-0 snapshot behind the loading screen. */
  get warming(): boolean { return this.warmup !== undefined; }
  /** The frame loop's verdict: the renderer has done its one-time work for this match (or the warm-up gave up). */
  endWarmup(): void { this.warmup?.(); }
  /** Diagnostics only: what the warm-up waited for. */
  noteWarm(detail: WarmBreakdown): void { this.startup.warm = detail; }
  /** The graphics device was lost or the view never started: only a page reload recovers. */
  get reloadRequired(): boolean { return this.reload; }
  get world(): ResidentGameTerrain | undefined { return this.terrain; }
  get lastTerrain() { return this.terrainUpdate; }
  get preparationMs(): number { return this.preparation; }
  get startupProgress() { return { ...this.startup, elapsedMs: this.isStarting ? performance.now() - this.startup.startedAt : this.startup.elapsedMs }; }
  private progress(stage: string, completed = 0, total = 0): void {
    stage = ({ sample: 'Sampling the planet', topology: 'Building terrain geometry', connectivity: 'Checking terrain connections',
      'gpu-encode': 'Uploading terrain', collision: 'Preparing collision', 'gpu-validation': 'Validating GPU pages', ready: 'Committing terrain' } as Record<string, string>)[stage] ?? stage;
    this.startup = { ...this.startup, stage, completed, total, elapsedMs: performance.now() - this.startup.startedAt };
  }

  async startMatch(setup: MatchSetup, checkpoint?: CampaignCheckpoint, fresh = false): Promise<void> {
    this.remoteMission = undefined; this.remoteObjectives = '';
    this.aftermathTime = 0; this.aftermathPose = undefined;
    setup = validateMatchSetup(setup);
    setup.planet.kind = resolvePlanetType(setup.seed, setup.planet.kind);
    const preparationStarted = performance.now(), request = ++this.generation;
    this.warmup?.();
    this.startup = { stage: 'Preparing terrain and workers', startedAt: preparationStarted, elapsedMs: 0, playableMs: 0, completed: 0, total: 0, warmupMs: 0 };
    this.current = setup; this.practiceMode = uiMode(setup);
    this.campaignCheckpoint = checkpoint ?? null; this.checkpointAttempt = checkpoint?.beat ?? null;
    this.isStarting = true; this.isReady = false; this.ended = false; this.drive = undefined;
    this.simulation?.dispose(); this.simulation = undefined;
    this.terrain?.dispose(); this.terrain = undefined;
    this.saving = false; this.paused = false;
    this.view.reset();
    this.view.setCampaignTime(setup.rules.turnModel === 'realtime' ? setup.environment?.timeOfDay ?? .08 : undefined);
    let nextWorld: ResidentGameTerrain | undefined;
    try {
      if (!checkpoint && !fresh && setup.mode === 'campaign' && !setup.online) {
        try {
          const saved = await readCampaignSave(JSON.stringify(setup)) ?? await readCampaignSave(cooperativeSaveKey(setup), 'owned-coop');
          if (request !== this.generation) return;
          if (saved && validCampaignCheckpoint(saved, setup)) {
            checkpoint = saved; this.campaignCheckpoint = saved; this.checkpointAttempt = saved.beat; this.checkpointStorage = 'saved';
          }
        } catch (error) { this.checkpointStorage = 'error'; console.warn('Campaign autosave unavailable; starting the mission normally', error); }
      }
      const backendStarted = performance.now();
      const backend = await residentBackend();
      if (setup.rules.turnModel === 'realtime' || this.network && !this.network.host) await loadRealtimeCore();
      performance.measure('tmt:resident-backend-import', { start: backendStarted });
      if (request !== this.generation) return;
      const visualReady = this.view.preparePlanet(setup.seed, setup.planet.kind);
      visualReady.catch(() => {});
      // The presentation layer owns diagnostic wall clocks; terrain/physics creation stays clock-independent.
      let worldStageStarted = performance.now();
      let update: TerrainUpdate;
      if (checkpoint) {
        this.progress('Restoring checkpoint terrain');
        const restored = await backend.restore(checkpoint.terrain, this.view.terrainHost);
        nextWorld = restored.service; update = restored.update;
      } else {
        nextWorld = await backend.create(setup.seed, this.view.terrainHost, setup.structures, undefined, setup.planet.kind, stage => {
          performance.measure(`tmt:${stage}`, { start: worldStageStarted }); worldStageStarted = performance.now();
        });
        if (request !== this.generation) { nextWorld.dispose(); return; }
        this.terrain = nextWorld;
        nextWorld.resident.onProgress = p => { if (request === this.generation) this.progress(p.stage, p.completed, p.total); };
        update = await nextWorld.initialize();
      }
      if (request !== this.generation) { nextWorld.dispose(); return; }
      this.terrain = nextWorld;
      nextWorld.resident.onProgress = p => { if (request === this.generation) this.progress(p.stage, p.completed, p.total); };
      performance.mark('tmt:terrain-transaction');
      if (request !== this.generation) return;
      this.progress('Preparing planet shaders');
      await visualReady;
      if (request !== this.generation) return;
      this.view.setWorld(nextWorld);
      this.view.setTerrain(update);
      this.terrainUpdate = update;
      setup = resolveArtillerySpawns(nextWorld, setup);
      this.current = setup;
      this.simulation = this.createRuntime(nextWorld, setup, checkpoint?.match);
      // COMPAT: without world.transactions, authored initial cuts stall tick 0 until this serial carve commits them.
      if (this.simulation.stalledOn?.serial) void this.legacySerialCarve(this.simulation);
      this.view.focus(this.simulation.state, this.observer);
      await this.warm();
      if (request !== this.generation) return;
      this.isReady = true;
      this.preparation = performance.now() - preparationStarted;
      this.progress('Playable'); this.startup.playableMs = this.preparation;
      dispatchMatchStart(setup);
      this.emit('ready', setup);
    } catch (error) {
      if (request !== this.generation) return;
      nextWorld?.dispose(); this.terrain = undefined; this.simulation = undefined;
      this.view.reset(); this.progress('Failed');
      this.emit('error', error);
      throw error;
    } finally { if (request === this.generation) this.isStarting = false; }
  }
  /** Turn-based rules run on GameSimulation (the resident Rust match where available); realtime rules on RealtimeMatch,
   * driven by the setup's campaign mission when it names one (docs/architecture.md). */
  private createRuntime(world: ResidentGameTerrain, setup: MatchSetup, checkpoint?: RealtimeCheckpoint): MatchRuntime {
    if (this.network && !this.network.host) {
      this.missionRunner = null;
      return new RealtimeMatch(world, { ...setup, rules: { ...setup.rules, turnModel: 'realtime' } }, { replica: true });
    }
    if (setup.rules.turnModel !== 'realtime') { this.missionRunner = null; return new GameSimulation(world, setup, buildExtensions(setup)); }
    const mission = missionIdOf(setup);
    this.missionRunner = mission ? new MissionRunner(missionById(mission)) : null;
    const match = new RealtimeMatch(world, setup, { script: this.missionRunner, checkpoint });
    // The opening banner, lines and objectives were produced at construction: present them with the first frame.
    this.openingEvents = match.drainRealtimeEvents();
    return match;
  }
  private openingEvents: RealtimeEvent[] = [];
  captureNetwork(from: number, initial = false): NetworkSnapshot | null {
    if (!this.simulation || !this.terrain || !this.isReady) return null;
    const mission = this.missionRunner;
    return { state: structuredClone(this.simulation.state), ...(this.realtime ? { realtime: this.realtime.replica() } : {}), world: this.terrain.networkWorld(from, initial),
      ...(mission ? { mission: { id: mission.def.id, won: mission.outcome === 'won', medal: mission.medalEarned, optional: mission.optionalCompleted,
        beat: mission.beatId, commander: this.current?.online?.seats.find(id => this.snapshot!.tanks[id]?.health > 0 && !this.snapshot!.tanks[id]?.retired) ?? 0,
        secrets: mission.secretsFound.size, ending: mission.ending, objectives: mission.objectiveList(), marker: mission.marker } } : {}) };
  }
  async applyNetwork(value: NetworkSnapshot, events: NetworkEvent[], isCurrent: () => boolean = () => true): Promise<void> {
    const runtime = this.simulation, terrain = this.terrain, generation = this.generation;
    if (!(runtime instanceof RealtimeMatch) || !terrain || this.network?.host || !isCurrent()) return;
    const update = await terrain.applyNetworkWorld(value.world);
    if (generation !== this.generation || !isCurrent()) return;
    const replica = value.realtime ?? { ...runtime.replica(), state: value.state };
    runtime.applyReplica(replica);
    this.remoteMission = value.mission;
    if (value.mission) {
      const key = JSON.stringify(value.mission.objectives);
      if (key !== this.remoteObjectives) { this.remoteObjectives = key; for (const o of value.mission.objectives) this.dispatchRealtime({ type: 'objective', ...o }, runtime); }
      this.dispatchRealtime({ type: 'marker', point: value.mission.marker }, runtime);
    }
    this.view.setTerrain(update); this.terrainUpdate = update;
    for (const event of events) { if (event.game) this.dispatch(event.game, runtime); if (event.realtime) this.dispatchRealtime(event.realtime, runtime); }
    // A reconnect may be newer than the bounded event ledger. The final state itself must still open results.
    if (value.state.phase === 'finished' && !this.ended) this.dispatch({ type: 'finish', winner: value.state.winner, team: value.state.winnerTeam ?? null }, runtime);
  }
  predictNetwork(drive: DriveInput): void {
    if (!(this.simulation instanceof RealtimeMatch) || !this.network || this.network.host) return;
    if (this.current?.rules.turnModel !== 'realtime' && (this.snapshot?.active !== this.observer || this.snapshot.phase !== 'resolving')) return;
    this.simulation.predictReplica(this.observer, drive);
  }
  aimNetwork(c: PlayerCommand): void {
    if (this.simulation instanceof RealtimeMatch && (c.k === 'aim' || c.k === 'munition')) this.simulation.command(this.observer, c);
  }
  async captureRecovery(): Promise<Recovery | null> {
    const runtime = this.simulation, terrain = this.terrain;
    if (!runtime || !terrain || !this.current || runtime.terrainPending || this.saving) return null;
    const realtime = runtime instanceof RealtimeMatch ? runtime.checkpoint(true) : null;
    if (runtime instanceof RealtimeMatch && !realtime) return null;
    const turn = runtime instanceof GameSimulation ? runtime.checkpoint() : undefined;
    const generation = this.generation; this.saving = true;
    try { const saved = await terrain.saveCheckpoint();
      return generation === this.generation ? { setup: structuredClone(this.current), terrain: saved, ...(turn ? { turn } : {}), ...(realtime ? { realtime } : {}) } : null;
    } finally { if (generation === this.generation) this.saving = false; }
  }
  /** The campaign owner keeps a separate local fallback even when a helper hosts the simulation.
   * Solo Continue can resume it without importing helper progress or overwriting an unrelated solo checkpoint. */
  async persistOnlineRecovery(recovery: Recovery): Promise<void> {
    const setup = recovery.setup, online = setup.online, generation = this.generation, runId = online?.runId;
    const current = () => generation === this.generation && this.current?.online?.runId === runId
      && this.network?.seat === (online?.campaignOwnerSeat ?? 0) && !this.ended && this.snapshot?.phase !== 'finished';
    if (online?.kind !== 'coop' || !runId || !current() || !recovery.realtime || recovery.realtime.state.phase === 'finished') return;
    const saved = ownedCooperativeCheckpoint(recovery); if (!saved) return;
    try {
      const stored = await writeCampaignSave(cooperativeSaveKey(setup), saved, 'owned-coop', current);
      if (current()) { this.campaignCheckpoint = saved; this.checkpointStorage = stored ? 'saved' : 'memory'; }
    } catch (error) { if (current()) { this.checkpointStorage = 'error'; console.warn('Co-op checkpoint could not be persisted', error); } }
  }
  async restoreRecovery(recovery: Recovery): Promise<void> {
    if (recovery.realtime) await this.startMatch(recovery.setup, { match: recovery.realtime, terrain: recovery.terrain, beat: 'online' }, true);
    else if (recovery.turn) await this.restoreCheckpoint({ ...recovery.turn, terrain: recovery.terrain });
    else throw new Error('Recovery has no match state.');
  }
  async restart(fromStart = false): Promise<void> {
    if (!this.current) throw new Error('There is no match to restart');
    // A lost mission retries from its checkpoint; any other restart starts the mission over and drops the autosave, so
    // leaving and coming back does not resume the abandoned attempt.
    const resume = !fromStart && this.missionRunner?.outcome === 'failed' ? this.campaignCheckpoint ?? undefined : undefined;
    if (!resume && this.current.mode === 'campaign') await clearCampaignSave(JSON.stringify(this.current)).catch(error => console.warn('Campaign autosave cleanup failed', error));
    if (!resume && this.current.mode === 'campaign' && !this.current.online) await clearCampaignSave(cooperativeSaveKey(this.current), 'owned-coop').catch(error => console.warn('Co-op autosave cleanup failed', error));
    await this.startMatch(this.current, resume, !resume);
  }
  endMatch(): void {
    this.generation++;
    this.campaignCheckpoint = null; this.checkpointAttempt = null;
    this.warmup?.();
    this.simulation?.dispose();
    this.isStarting = false; this.isReady = false; this.simulation = undefined; this.drive = undefined;
    this.terrain?.dispose(); this.terrain = undefined;
    this.progress('Cancelled'); this.saving = false;
    this.view.reset();
  }
  setPaused(paused: boolean): void { this.paused = paused; }
  /** Read-only sensor check for forced fog in a playground whose match rules normally reveal every tank. */
  devCanSee(observer: PlayerId, target: PlayerId): boolean {
    return this.simulation instanceof GameSimulation ? this.simulation.sensorSees(observer, target)
      : !!this.simulation?.state.observations?.[observer]?.[target]?.visible;
  }
  /** Explicit playground tool; normal matches never enter this path. */
  devPlaceTank(): void {
    if (new URLSearchParams(location.search).get('mode') !== 'dev') throw new Error('Placement requires Engine playground mode.');
    const tank = this.simulation?.state.tanks[this.observer], hit = this.view.devControls().aimHit();
    if (!tank || !hit || !this.terrain || this.simulation?.terrainPending || this.saving) throw new Error('Wait for terrain, then aim the camera at the destination.');
    tank.position = add(hit.point, mul(normalize(hit.point), 0.65)); tank.rotation = rotation(normalize(hit.point), tank.heading); tank.velocity = [0, 0, 0];
    this.terrain.relocateTank(tank);
  }
  /** Explicit playground tool; normal matches never enter this path. */
  async devBlast(radius: number, munition: MunitionId = 'explosive'): Promise<void> {
    if (new URLSearchParams(location.search).get('mode') !== 'dev') throw new Error('Destruction tools require Engine playground mode.');
    const terrain = this.terrain, simulation = this.simulation, generation = this.generation;
    if (!terrain || !simulation || simulation.terrainPending || this.saving) throw new Error('Wait for the current terrain edit to finish.');
    const hit = this.view.devControls().aimHit(); if (!hit) throw new Error('Point the camera at terrain first.');
    const cut: { center: V3; radius: number; shells?: CraterShell[]; id: string } = { ...(terrain.materialCraters ? materialCrater(hit.point, hit.normal, radius, munition) : craterProfile(hit.point, hit.normal, radius)), id: `dev-${simulation.state.tick}` };
    this.saving = true;
    this.view.onGameEvent({ type: 'impact', position: hit.point, normal: hit.normal, radius, owner: this.observer, cut, munition }, simulation.state);
    try {
      const update = await terrain.carve(cut.center, cut.radius, undefined, cut.shells);
      if (generation !== this.generation) return;
      this.view.setTerrain(update); this.terrainUpdate = update;
      this.view.onGameEvent({ type: 'terrain-commit', cutIds: [cut.id], version: update.version }, simulation.state);
    } catch (error) {
      if (generation === this.generation) this.view.onGameEvent({ type: 'terrain-failed', code: 'dev-edit', message: String(error) }, simulation.state);
      throw error;
    } finally { if (generation === this.generation) this.saving = false; }
  }
  /** The page must reload (device lost, or the view failed to start). */
  invalidate(): void { this.reload = true; this.endMatch(); }

  /** A player command for a human-controlled tank; a brain's tank takes no outside input (its brain acts in the sim). */
  command(tank: number, c: PlayerCommand): boolean {
    if (this.network) return this.network.command(tank, c);
    return this.localCommand(tank, c);
  }
  localCommand(tank: number, c: PlayerCommand): boolean {
    const simulation = this.simulation;
    if (!simulation || this.saving || !Number.isSafeInteger(tank) || !simulation.state.tanks[tank] || simulation.brainOf(tank) !== null) return false;
    if (c.k === 'drive') {
      if (!Number.isFinite(c.throttle) || !Number.isFinite(c.steer)) return false;
      if (simulation instanceof RealtimeMatch) return simulation.command(tank, c);
      this.drive = { tank, input: { throttle: Math.max(-1, Math.min(1, c.throttle)), steer: Math.max(-1, Math.min(1, c.steer)) } };
      return true;
    }
    // aim, fire, munition, scan, endMove and hold; brace, tap, utility, selfRight and reposition arrive with W2-GAME2.
    return simulation.command(tank, c);
  }
  canFire(tank: PlayerId): boolean { return this.simulation?.canFire(tank) ?? false; }
  /** Render interpolation between the last two ticks (presentation only). */
  interpolation(): SimInterpolation | undefined { return this.network?.interpolation?.() ?? this.aftermathPose ?? this.simulation?.interpolation(); }
  preview(tank: PlayerId, full: boolean): V3[] { return this.simulation?.previewPrediction(tank, full).points ?? []; }
  previewPrediction(tank: PlayerId, full: boolean, collider?: AimTargetCollider) { return this.simulation?.previewPrediction(tank, full, collider) ?? { points: [], hit: false }; }
  solveAimTarget(tank: PlayerId, target: V3 | AimSelection, previous?: AimTargetAim): AimTargetResult {
    return this.simulation?.solveAimTarget(tank, target, previous) ?? invalidAimTarget(Array.isArray(target) ? target : target.point);
  }

  /** Advances the match by simDt seconds (the loop applies the dt cap and the hook time scale). The latest
   * drive command steers the active tank only when it was issued for that tank. */
  step(simDt: number): readonly GameEvent[] {
    if (this.network) return this.network.step(simDt);
    return this.advanceOnline(simDt);
  }
  advanceOnline(simDt: number): readonly GameEvent[] {
    const simulation = this.simulation;
    if (!simulation || !this.isReady || (this.paused && !this.network) || this.saving) return [];
    const drive = this.drive && simulation.state.active === this.drive.tank ? this.drive.input : undefined;
    const events = simulation.step(simDt, drive);
    // Committed transactions (W1-TER) publish their pages through view.terrainHost; the view still gets the update
    // for footprints and debris.
    for (const update of simulation.drainTerrainUpdates()) { this.view.setTerrain(update); this.terrainUpdate = update; }
    for (const event of events) this.dispatch(event, simulation);
    if (simulation instanceof RealtimeMatch) for (const event of [...this.openingEvents.splice(0), ...simulation.drainRealtimeEvents()]) this.dispatchRealtime(event, simulation);
    this.captureCampaignCheckpoint();
    return events;
  }

  /** The outcome is final, but rigid bodies still fall and settle behind the result card.
   * No combat, AI, mission scripts, clocks, score changes or repeated finish events run here. */
  settleWrecks(dt: number): void {
    if (this.network) return;
    const state = this.simulation?.state, world = this.terrain;
    if (!state || state.phase !== 'finished' || !world || !this.isReady) return;
    const poses = (): TankPose[] => state.tanks.map(t => ({ position: [...t.position], rotation: [...t.rotation], turretYaw: t.turretYaw, barrelPitch: t.barrelPitch }));
    this.aftermathTime = Math.min(4 / 60, this.aftermathTime + Math.max(0, dt));
    this.aftermathPose ??= { alpha: 1, prev: poses(), curr: poses() };
    const tanks = state.tanks.filter(t => !t.retired && (t.health <= 0 || t.motionKind !== 'air' && t.motionKind !== 'swarm'));
    while (this.aftermathTime >= 1 / 60) {
      this.aftermathTime -= 1 / 60;
      this.aftermathPose.prev = poses();
      world.stepTanks(tanks, [], 1 / 60);
      this.aftermathPose.curr = poses();
    }
    this.aftermathPose.alpha = this.aftermathTime * 60;
  }

  private captureCampaignCheckpoint(): void {
    if (this.network) return;
    const match = this.realtime, terrain = this.terrain, beat = this.missionRunner?.beatId;
    if (!match || !terrain || !beat || this.checkpointAttempt === beat || this.saving || this.missionRunner?.outcome) return;
    const saved = match.checkpoint();
    if (!saved) return; // Wait for all flights and terrain transactions to settle; never discard them to save.
    const request = this.generation;
    this.saving = true; this.checkpointAttempt = beat;
    void terrain.saveCheckpoint().then(world => {
      if (request !== this.generation) return;
      this.campaignCheckpoint = { match: saved, terrain: world, beat };
      this.checkpointStorage = 'memory';
      void writeCampaignSave(JSON.stringify(this.current), this.campaignCheckpoint).then(stored => {
        if (request === this.generation) this.checkpointStorage = stored ? 'saved' : 'memory';
      }).catch(error => {
        if (request === this.generation) { this.checkpointStorage = 'error'; console.warn('Campaign autosave could not be persisted; retry still works in this session', error); }
      });
      this.dispatchRealtime({ type: 'banner', title: 'Checkpoint saved', subtitle: 'Retry resumes here' }, match);
      dispatchAudioCue({ type: 'checkpoint' });
    }).catch(error => {
      // The mission remains playable and the previous checkpoint stays available.
      if (request === this.generation) console.warn('Campaign checkpoint could not be saved', error);
    }).finally(() => { if (request === this.generation) this.saving = false; });
  }

  /** Realtime presentation and campaign events: tracers to the view, everything to 'realtime' listeners (campaign HUD). */
  private dispatchRealtime(event: RealtimeEvent, match: RealtimeMatch): void {
    this.view.onRealtimeEvent(event, match.state);
    this.emit('realtime', event);
  }

  /** Every event goes to the view and to the hooks. */
  private dispatch(event: GameEvent, simulation: MatchRuntime): void {
    this.view.onGameEvent(event, simulation.state);
    // CC-004 bridge: the W0 facade pulses its radar ring on a view-local 'radar' event; only the observer's own scans show.
    if (event.type === 'scan' && event.tank === this.observer) this.view.onGameEvent({ type: 'radar', tank: event.tank, position: [...event.position] }, simulation.state);
    if (event.type === 'impact' && simulation.stalledOn?.serial) void this.legacySerialCarve(simulation);
    // W1-TER compacts at idle when the host says no transaction is pending (the start of every turn qualifies).
    if (event.type === 'turn' && !simulation.terrainPending) (this.terrain as { maintenance?(): void } | undefined)?.maintenance?.();
    dispatchGameEvent(event, simulation.state);
    this.emit('event', event);
    if (event.type === 'finish' && !this.ended && this.current) {
      this.ended = true;
      if (!this.current.online && this.missionRunner?.outcome === 'won') void clearCampaignSave(JSON.stringify(this.current)).catch(error => console.warn('Campaign autosave cleanup failed', error));
      if ((this.current.mode === 'campaign' && !this.current.online || this.current.online?.kind === 'coop' && this.observer === (this.current.online.campaignOwnerSeat ?? 0))
        && (this.missionRunner?.outcome === 'won' || this.remoteMission?.won)) void clearCampaignSave(cooperativeSaveKey(this.current), 'owned-coop').catch(error => console.warn('Co-op autosave cleanup failed', error));
      const result = { winner: event.winner, setup: this.current };
      dispatchMatchEnd(result);
      this.emit('finish', result);
    }
  }

  /** COMPAT, deleted by W2-GAME2: before the W1-TER merge the resident terrain has no `transactions`, so the match
   * stalls at the impact tick while this serial carve runs, exactly as the old pause did. A failed edit keeps the
   * old world and the match goes on. */
  private async legacySerialCarve(match: MatchRuntime): Promise<void> {
    const request = this.generation, world = this.terrain!, stall = match.stalledOn;
    // One carve per stall: the start of a match, an impact and a checkpoint replay each start at most one.
    if (!stall?.serial || this.carving === stall) return;
    this.carving = stall;
    const cuts = match.pendingSerialCuts();
    try {
      let update: TerrainUpdate | undefined;
      for (const cut of cuts) update = await world.carve(cut.center, cut.radius, undefined, cut.shells);
      if (request !== this.generation) return;
      match.completeLegacyCarve({ status: 'committed', update });
    } catch (error) {
      if (request !== this.generation) return;
      console.error(error);
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'carve';
      match.completeLegacyCarve({ status: 'failed', code, message: error instanceof Error ? error.message : String(error) });
    } finally { if (this.carving === stall) this.carving = undefined; }
  }

  /** Checkpoint v2 (plan §6 I9): setup + command log + the resident terrain edit log. Saving never pauses the match
   * logic: the command log is complete at any tick, pending terrain edits included. */
  async saveCheckpoint(): Promise<PracticeCheckpoint> {
    const { terrain, simulation } = this;
    if (!terrain || !simulation || !this.isReady) throw new Error('There is no running match to save');
    if (!(simulation instanceof GameSimulation)) throw new Error('Campaign checkpoints are saved automatically at settled mission beats. Retry restores the latest checkpoint.');
    const request = this.generation;
    this.saving = true;
    try {
      const saved: PracticeCheckpoint = { ...simulation.checkpoint(), terrain: null };
      saved.terrain = await terrain.saveCheckpoint();
      if (request !== this.generation) throw new Error('The match changed while it was being saved');
      return saved;
    } finally { if (request === this.generation) this.saving = false; }
  }
  /** Resume: rebuild the planet from the setup and replay the command log on it (terrain edits commit at the same
   * ticks, through the same path as live play), then prove the replay with the saved hash. */
  async restoreCheckpoint(saved: PracticeCheckpoint): Promise<void> {
    const checkpoint = validateMatchCheckpoint(saved), setup = checkpoint.setup;
    const terrainCheckpoint = checkpoint.terrain ? validateResidentCheckpoint(checkpoint.terrain) : undefined;
    if (terrainCheckpoint && terrainCheckpoint.seed !== setup.seed) throw new Error('Checkpoint terrain seed differs from its match setup');
    const request = ++this.generation;
    this.warmup?.();
    // Old saves recorded a choice which the generator ignored. Replay the world actually saved, retaining its profile.
    setup.planet.kind = terrainCheckpoint?.kind ?? planetType(setup.seed);
    this.current = setup;
    this.startup = { stage: 'Restoring saved world', startedAt: performance.now(), elapsedMs: 0, playableMs: 0, completed: 0, total: 0, warmupMs: 0 };
    this.isReady = false; this.isStarting = true; this.ended = false; this.drive = undefined;
    this.simulation?.dispose(); this.terrain?.dispose(); this.terrain = undefined; this.view.reset(); this.simulation = undefined;
    this.saving = false; this.paused = false;
    let world: ResidentGameTerrain | undefined;
    try {
      const backend = await residentBackend();
      if (request !== this.generation) return;
      world = await backend.create(setup.seed, this.view.terrainHost, terrainCheckpoint?.structures ?? setup.structures, terrainCheckpoint?.profile, setup.planet.kind,
        undefined, terrainCheckpoint?.engine ?? 'compatibility-v1');
      if (request !== this.generation) { world.dispose(); return; }
      this.terrain = world;
      world.resident.onProgress = p => { if (request === this.generation) this.progress(p.stage, p.completed, p.total); };
      const update = await world.initialize();
      if (request !== this.generation) return;
      await this.view.preparePlanet(setup.seed, setup.planet.kind, update.sphericalNoise);
      if (request !== this.generation) return;
      this.view.setWorld(world); this.view.setTerrain(update); this.terrainUpdate = update;
      const replay = new MatchReplay(world, checkpoint, buildExtensions(setup));
      for (;;) {
        const status = replay.advance(240);
        if (request !== this.generation) return;
        if (status === 'done') break;
        if (status === 'stalled' && replay.simulation.stalledOn?.serial) await this.legacySerialCarve(replay.simulation);
        else await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (!replay.verified()) throw new Error('Checkpoint replay diverged: the replayed match hash differs from the saved one');
      const simulation = replay.simulation;
      simulation.step(0); // the replayed events were presented when they happened
      for (const terrainUpdate of simulation.drainTerrainUpdates()) { this.view.setTerrain(terrainUpdate); this.terrainUpdate = terrainUpdate; }
      this.current = setup; this.practiceMode = uiMode(setup); this.simulation = simulation; this.missionRunner = null;
      this.view.focus(simulation.state, this.observer);
      await this.warm();
      if (request !== this.generation) return;
      this.isReady = true;
      this.progress('Playable'); this.startup.playableMs = this.startup.elapsedMs;
      dispatchMatchStart(setup);
      this.emit('ready', setup);
    } catch (error) {
      if (request !== this.generation) return;
      world?.dispose(); this.terrain = undefined; this.simulation = undefined;
      this.view.reset(); this.progress('Failed');
      this.emit('error', error);
      throw error;
    } finally { if (request === this.generation) this.isStarting = false; }
  }

  /**
   * The renderer's one-time work for a new match (the first full SDF build, first-use allocations, the basin solve and
   * water fill, tank meshes and casters) used to land on its first frames of play. A frame loop that listens for
   * 'warming' renders the tick-0 snapshot behind the loading screen until that work is done; the simulation does not
   * step meanwhile, so the match is the same. Without such a loop (tests, tools) or in a hidden tab it is ready at once.
   */
  private warm(): Promise<void> {
    if (!this.listeners.get('warming')?.size || (typeof document !== 'undefined' && document.hidden)) return Promise.resolve();
    this.progress('Rendering the first frames');
    const started = performance.now();
    return new Promise(resolve => {
      // The frame loop gives up after WARM_LIMIT_MS, but only from a frame: if frames stop (an occluded window that still
      // reports visible), this hands the match over anyway.
      const backstop = setTimeout(() => release(), WARM_BACKSTOP_MS);
      const release = () => {
        if (this.warmup !== release) return;
        clearTimeout(backstop); this.warmup = undefined; this.startup.warmupMs = performance.now() - started; resolve();
      };
      this.warmup = release;
      this.emit('warming', this.current);
    });
  }

  on(event: SessionEvent, cb: (payload: unknown) => void): () => void {
    let listeners = this.listeners.get(event);
    if (!listeners) this.listeners.set(event, listeners = new Set());
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  }
  private emit(event: SessionEvent, payload: unknown): void {
    // A failing listener is reported and never stops the frame loop or the other listeners.
    for (const cb of [...this.listeners.get(event) ?? []]) {
      try { cb(payload); } catch (error) { console.error(`Session '${event}' listener failed:`, error); }
    }
  }

  /** window.__tmtGame keys, in their historical order; scripts/capture.ts depends on them. */
  telemetryFields(): Record<string, () => unknown> {
    return {
      ready: () => this.isReady, mode: () => this.practiceMode, phase: () => this.simulation?.state.phase, active: () => this.simulation?.state.active,
      tick: () => this.simulation?.state.tick, turn: () => this.simulation?.state.turn, terrainVersion: () => this.terrain?.version,
      terrain: () => ({ ...this.terrainUpdate, chunks: undefined, removed: undefined, visualReset: undefined }),
      performance: () => this.view.telemetry(), camera: () => this.view.cameraTelemetry(),
      vehicleAppearance: () => this.view.devControls().vehicleAppearance(),
      snapshot: () => this.simulation ? structuredClone(this.simulation.state) : null,
      resident: () => this.terrain?.diagnostics(),
      startup: () => this.startupProgress,
      // W1-GAME: what a stalled match waits for, brain work per tick and the Tempo timeline (next six actors).
      stall: () => this.simulation?.stalledOn ?? null, stalledFrames: () => this.simulation?.stalledFrames,
      ai: () => this.simulation?.aiTelemetry(), timeline: () => this.simulation?.timeline(),
      // Campaign: the mission's beat, objectives, result and the player's gun (capture plans and playtest logs).
      mission: () => this.missionRunner ? { id: this.missionRunner.def.id, beat: this.missionRunner.beatId, outcome: this.missionRunner.outcome,
        checkpoint: this.campaignCheckpoint?.beat ?? null, checkpointStorage: this.checkpointStorage,
        objectives: this.missionRunner.objectiveList(), marker: this.missionRunner.marker, medal: this.missionRunner.medalEarned,
        reload: this.realtime?.reloadOf(this.observer), coax: this.realtime?.coaxOf(this.observer) } : null,
    };
  }
  /** window.__tmtMemory(): long-session sizes, read on demand (the command log is decoded from the engine). */
  memoryTelemetry(): Record<string, unknown> {
    const heap = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
    return { tick: this.simulation?.state.tick, turn: this.simulation?.state.turn, terrainVersion: this.terrain?.version, jsHeap: heap?.usedJSHeapSize, jsHeapTotal: heap?.totalJSHeapSize,
      commands: this.simulation?.commandLog().length, terrain: this.terrain?.memory() };
  }
  telemetry(): Record<string, unknown> {
    return Object.fromEntries(Object.entries(this.telemetryFields()).map(([key, read]) => [key, read()]));
  }
  dispose(): void { this.endMatch(); this.listeners.clear(); }
}

/** Same owner build and mission can continue offline; guest builds and host authority are deliberately excluded. */
export function cooperativeSaveKey(setup: MatchSetup): string {
  const owner = setup.tanks[setup.online?.campaignOwnerSeat ?? 0];
  return JSON.stringify({ id: setup.id, seed: setup.seed, kit: owner?.loadout, difficulty: owner?.difficulty, crew: crewBuild(setup.crew) });
}
export function ownedCooperativeCheckpoint(recovery: Recovery): CampaignCheckpoint | null {
  const id = missionIdOf(recovery.setup), online = recovery.setup.online, match = recovery.realtime && structuredClone(recovery.realtime);
  if (!id || online?.kind !== 'coop' || !match || (online.campaignOwnerSeat ?? 0) !== 0) return null;
  const script = match.script as ReturnType<MissionRunner['checkpoint']>, beat = missionById(id).beats[script?.beat]?.id;
  if (!beat || match.state.phase === 'finished' || !(match.state.tanks[0]?.health > 0)) return null;
  for (const seat of online.seats) if (seat !== 0 && match.state.tanks[seat]) {
    match.state.tanks[seat].health = 0; match.state.tanks[seat].retired = true;
  }
  if (match.online) match.online.seats = [0];
  return { match, terrain: recovery.terrain, beat };
}

/** Reject incompatible/corrupt stored records before handing any state to the runtime. */
function validCampaignCheckpoint(value: unknown, setup: MatchSetup): value is CampaignCheckpoint {
  const c = value as CampaignCheckpoint | null, id = missionIdOf(setup);
  if (!c || !id || typeof c.beat !== 'string' || !c.match || !c.terrain) return false;
  const def = missionById(id), m = c.match, script = m.script as ReturnType<MissionRunner['checkpoint']>;
  if (!script || !Number.isInteger(script.beat) || def.beats[script.beat]?.id !== c.beat || !Array.isArray(script.objectives) || !Array.isArray(script.secrets)) return false;
  if (!m.state || !Array.isArray(m.units) || !m.units.length || m.units.length > 128 || m.state.tanks?.length !== m.units.length) return false;
  if (!Array.isArray(m.core) || !Array.isArray(m.archived) || !Array.isArray(m.sightings) || !Array.isArray(m.incoming)) return false;
  for (const [i, tank] of m.state.tanks.entries()) if (tank.position?.length !== 3 || tank.rotation?.length !== 4 || !Number.isFinite(tank.health)
    || !m.units[i]?.spec || !validComponentState(tank, m.units[i].spec.components)) return false;
  const finite = (node: unknown): boolean => typeof node === 'number' ? Number.isFinite(node)
    : node && typeof node === 'object' ? Object.values(node).every(finite) : true;
  if (!finite(m)) return false;
  try { validateResidentCheckpoint(c.terrain); return true; } catch { return false; }
}
