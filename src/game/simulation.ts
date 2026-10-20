import { projectileWater, type ProjectileWater } from './rules/projectile-water';
import { isW1Profile } from './ai/profiles';
import type { Contact, DriveInput, GameEvent, GameSnapshot, ImpactEvent, Loadout, PlayerId, ProjectileState, TankState, TerrainHit, TerrainQueryBounds, TerrainUpdate, TrajectoryPrediction, V3, WorldQuery } from './contracts';
import type { CommitResult, CutRequest, TerrainTicket } from '../gpu/terrain/transactions';
import { craterProfile } from './rules/crater';
import { materialCrater, type CraterShell } from './rules/material-craters';
import { validateLoadout } from './modules';
import { add, clamp, distance, dot, frame, holdPlanetBearing, length, mul, normalize, rotate, segmentSphere, sub, wrapAngle } from './math';
import { sampleTrackTerrain, treadGearWords, TREAD_RANGE, type TrackTerrainSample } from './tread-contact';
import { munitionSpeed, munitionStats, validMunition, windFactor, type MunitionId } from './munitions';
import { assembleKit, kitLoadoutToLegacy, tankKit, V1_PROXY, validateKitLoadout, type KitAssembly } from './kit';
import { kitTrunnionPivot } from './kit/assembly';
import { MAX_BARREL_PITCH, MIN_BARREL_PITCH, ROOT_SURFACE_LIFT, SIGHT_TARGET } from './kit/dimensions';
import { GRAVITY_BALLISTIC } from './world-constants';
import { legacyToKitIds, type BotProfileId, type MatchRules, type MatchSetup } from './api/match';
import type { PlayerCommand } from './api/session';
import type { SegmentHit, SimContext, SimExtension, SimInterpolation, TankPose } from './api/extensions';
import { validateExtension } from './rules/extension-registry';
import { brainOf, isMatchSetup, MAX_CHARGE, optionsSetup, spawnPose, validateMatchSetup, type SimOptionsV1 } from './rules/setup';
import { advanceReady, nextActor, previewTimeline, type TempoAction } from './rules/tempo';
import { advanceFlight, FIXED_DT, flightStats, integrateProjectile, type BallisticEnv, type Flight } from './rules/ballistics';
import { invalidAimTarget, solveAimTarget, TANK_TARGET_RADIUS, type AimSelection, type AimTargetAim, type AimTargetCollider, type AimTargetResult } from './rules/aim-target';
import { ammoBlock, initialAmmo, spendAmmo } from './rules/ammo';
import { sanitizeCommand, validateMatchCheckpoint, type MatchCheckpointV2, type MatchCommand } from './rules/checkpoint';
import { hashString, snapshotHash } from './rules/hash';
import { damagedDrive, damageVehicle, repairVehicle, weaponOperational } from './rules/vehicle-damage';
import { sampleWind, windAcceleration, type WindState } from '../world/weather';
import type { BallisticTrace, BotBrain, BotObservation } from './api/bot';
import { createBrain } from './ai/brain';
import { brainSeed } from './ai/random';
import { armorResponse } from './rules/armor';

export { FIXED_DT, integrateProjectile };
export const GRAVITY = GRAVITY_BALLISTIC;
export const MOVE_SECONDS = 30;
export const MAX_PROJECTILE_AGE = 8;
export const RADAR_COST = 3;
export { MIN_BARREL_PITCH, MAX_BARREL_PITCH };
export type { SimOptionsV1, MatchCheckpointV2, MatchCommand };
const MAX_TICKS_PER_STEP = 8;
const TANK_RADIUS = TANK_TARGET_RADIUS;
const NO_DRIVE: DriveInput = Object.freeze({ throttle: 0, steer: 0 });
/** Every dimension and stat of a tank comes from its kit (plan §5.3). While a kit-ids object holds the same ids,
 * validation succeeds again and the assembly cache returns the same object, so it is remembered per ids object. */
const kits = new WeakMap<object, { hull: string; runningGear: string; turret: string; weapon: string; utility: string; armor: string | undefined; assembly: KitAssembly }>();
const kitOf = (tank: TankState): KitAssembly => {
  const ids = tank.kit;
  if (!ids) return assembleKit(tankKit(tank));
  const known = kits.get(ids);
  if (known && known.hull === ids.hull && known.runningGear === ids.runningGear && known.turret === ids.turret && known.weapon === ids.weapon
    && known.utility === ids.utility && known.armor === ids.armor) return known.assembly;
  const assembly = assembleKit(tankKit(tank));
  kits.set(ids, { hull: ids.hull, runningGear: ids.runningGear, turret: ids.turret, weapon: ids.weapon, utility: ids.utility, armor: ids.armor, assembly });
  return assembly;
};
/** The historical cache keys compared their fields as joined text: numbers equal unless they print differently (so
 * -0 matches 0 and NaN matches NaN), and a missing value prints like an empty one. */
const sameNumber = (a: number, b: number) => a === b || (a !== a && b !== b);
const sameText = (a: string | undefined, b: string | undefined) => (a ?? '') === (b ?? '');
const samePose = (a: readonly number[], b: readonly number[]) => { for (let i = 0; i < a.length; i++) if (!sameNumber(a[i], b[i])) return false; return true; };
const samePreview = (a: PreviewKey, b: PreviewKey) => a.player === b.player && a.full === b.full && sameNumber(a.version, b.version) && sameNumber(a.tick, b.tick)
  && samePose(a.pose, b.pose) && a.kit === b.kit && sameText(a.munition, b.munition) && (a.collider === null ? b.collider === null : b.collider !== null && samePose(a.collider, b.collider));
const flightOf = (projectile: ProjectileState): Flight => ({ position: projectile.position, vx: projectile.velocity[0], vy: projectile.velocity[1], vz: projectile.velocity[2],
  age: projectile.age, launchTick: projectile.launchTick });
/** The hull-frame part of GameSimulation.sightPoints: a function of the kit and the turret yaw only. */
function hullSightPoints(kit: KitAssembly, yaw: number): V3[] {
  const hull = kit.proxies[V1_PROXY.hull].box, turret = kit.proxies[V1_PROXY.turret].box;
  const local: V3[] = [];
  const inset = 0.05;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    local.push([hull.center[0] + sx * Math.max(0, hull.half[0] - inset), hull.center[1] + sy * Math.max(0, hull.half[1] - inset),
      hull.center[2] + sz * Math.max(0, hull.half[2] - inset)]);
  }
  local.push([...hull.center] as V3, [...SIGHT_TARGET] as V3);
  const ring = kit.frames.turretRing.position, c = Math.cos(yaw), s = Math.sin(yaw);
  const turretToHull = (p: readonly number[]): V3 => [ring[0] + p[0] * c + p[2] * s, ring[1] + p[1], ring[2] - p[0] * s + p[2] * c];
  local.push(turretToHull(turret.center), turretToHull([turret.center[0], turret.center[1] + Math.max(0, turret.half[1] - inset), turret.center[2]]));
  return local;
}

interface ShotResult { projectile: ProjectileState; impactProjectile?: ProjectileState; hit: TerrainHit | null; tank: PlayerId | null; expired: boolean; hitTarget?: boolean }
/** The outcome of one shell step (advance()); `stepped` is false when the launch guard stopped the shell unmoved. */
interface StepOutcome { hit: TerrainHit | null; victim: PlayerId | null; hitTarget: boolean; expired: boolean; stepped: boolean }
/** The previewPrediction cache key, compared field by field. */
interface PreviewKey { player: PlayerId; full: boolean; version: number; tick: number; pose: number[]; kit: string; munition: string | undefined; collider: number[] | null }
/** One cached tread profile per pose: the world revision, running gear, position and rotation it was sampled at. */
interface TreadEntry { version: number; gear: string; pose: number[]; sample: TrackTerrainSample }
/** A prepared terrain transaction waiting for its fixed commit tick (plan §4.3 steps 5–6). */
interface PendingCommit { readonly ticket: TerrainTicket; readonly commitTick: number; readonly cuts: readonly CutRequest[] }
/** What a stalled simulation is waiting for: the edit due at `commitTick` is not prepared yet (I9: a deterministic stall). */
export interface TerrainStall { readonly commitTick: number; readonly cutIds: readonly string[]; readonly ticket: TerrainTicket | null; readonly serial: boolean }
const cutBounds = (cut: CutRequest): TerrainQueryBounds => ({ min: cut.center.map(v => v - cut.radius) as V3, max: cut.center.map(v => v + cut.radius) as V3 });
const sameCuts = (a: readonly CutRequest[], b: readonly CutRequest[]) => a.length === b.length
  && a.every((cut, i) => cut.id === b[i].id && cut.radius === b[i].radius && cut.center.every((value, axis) => value === b[i].center[axis]));
const cleanDrive = (drive: DriveInput): DriveInput => ({ throttle: Number.isFinite(drive.throttle) ? clamp(drive.throttle, -1, 1) : 0, steer: Number.isFinite(drive.steer) ? clamp(drive.steer, -1, 1) : 0 });
interface AimCandidate { yaw: number; pitch: number; power: number; munition?: MunitionId }
/** Trace steps (one raycast each) a brain may spend per fixed tick (plan §3: ≤ 48 per tick on desktop). */
export const AI_TRACE_BUDGET = 48;
/** Enemy shots within this range are heard as a bearing wedge (Experience §1.9). */
export const SOUND_RANGE = 40;
const SOUND_WEDGE = 15 * Math.PI / 180;
/** How far ahead a brain may plan its fire tick for a trace's wind timeline (60 s). */
const MAX_TRACE_LEAD_TICKS = 3600;
/** Test and harness hooks; never used by gameplay. */
export interface SimulationOptions { wrapObservation?: (o: BotObservation, tank: PlayerId) => BotObservation }

export class GameSimulation {
  private readonly nativeMatch?: import('./native-match').NativeMatch;
  private readonly nativeBallistics?: import('./native-ballistics').NativeBallistics;
  private readonly nativeCombat?: import('./native-combat').NativeCombat;
  private liveFlight: { id: number; flight: Flight } | null = null;
  private readonly traceCleanup = new Set<() => void>();
  readonly state: GameSnapshot;
  readonly setup: MatchSetup;
  readonly rules: Readonly<MatchRules>;
  readonly driveTest: boolean;
  /** Radial gravity of this match: GRAVITY_BALLISTIC × rules.gravityScale. */
  readonly gravity: number;
  private readonly extensions: SimExtension[];
  /** The brain driving each tank, or null for a human (plan §5.2 TankSpawn.brain). */
  private readonly brains: (BotProfileId | null)[];
  /** Teams with `ai: false`: they win Tempo ties. */
  private readonly playerTeams: Set<number>;
  private readonly windSeed: number;
  private accumulator = 0;
  private pending: GameEvent[] = [];
  private nextShot = 1;
  private rng: number;
  private moveTime = 0;
  private aiMoveAnchor: { tank: PlayerId; position: V3; elapsed: number; idle: number } | null = null;
  private hasFired = false;
  /** Brain instances per tank (null for humans) and the turn each last began. */
  private readonly brainInstances: (BotBrain | null)[];
  private readonly brainTurns: number[];
  /** The per-tick trace-step meter shared by every brain call of the tick. */
  private readonly aiMeter = { used: 0, limit: AI_TRACE_BUDGET, peak: 0, decisions: 0, lastDecisionTicks: 0 };
  private readonly aiBudget = { get traceSteps() { return 0; } };
  /** What each tank heard (enemy shots within SOUND_RANGE out of sight) and where its own shells landed. */
  private readonly heard: { bearing: number; tick: number }[][];
  private readonly ownImpacts: { tick: number; position: V3 }[][];
  /** Ticks at which each tank's turns began (last-known uncertainty grows per enemy turn). */
  private readonly turnStarts: number[][];
  private previewCache: { key: PreviewKey; points: V3[]; hit: boolean; hitTarget?: boolean } | null = null;
  /** Per tank, the last four tread profiles in insertion order (the oldest is replaced first). */
  private treadCache: TreadEntry[][] = [];
  private readonly treadNext: number[] = [];
  /** Hull-frame sight points (all but the trunnion and muzzle) per tank, for the kit and turret yaw they were built at. */
  private readonly sightCache: { kit: KitAssembly; yaw: number; points: V3[] }[] = [];
  private readonly outcome: StepOutcome = { hit: null, victim: null, hitTarget: false, expired: false, stepped: true };
  private water?: ProjectileWater;
  private stillAir: BallisticEnv | null = null;
  /** Transactions path: prepared edits ordered by commit tick. */
  private commits: PendingCommit[] = [];
  /** COMPAT (W2-GAME2 deletes it): a world without transactions stalls at the impact tick until the host's serial
   * carve finishes and calls completeLegacyCarve(). */
  private serialCarve: { readonly cuts: readonly CutRequest[]; readonly tick: number } | null = null;
  /** A speculative prepare made at fire time from a pre-trace, promoted at impact when the cut is identical. */
  private speculative: { readonly ticket: TerrainTicket; readonly shot: number; readonly cuts: readonly CutRequest[] } | null = null;
  private stall: TerrainStall | null = null;
  private stallFrames = 0;
  private terrainUpdates: TerrainUpdate[] = [];
  /** How the active tank ended its turn (the Tempo cost of the handover). */
  private turnAction: TempoAction = 'fire';
  private windCache: WindState | null = null;
  /** Tank poses before the latest tick, for render interpolation (never read by the simulation). */
  private previousPoses: TankPose[] | null = null;
  /** Checkpoint v2: every accepted input with the tick boundary it was applied at. */
  private readonly commands: MatchCommand[] = [];
  /** The drive input last written to the log (drive changes are logged only while they can move a tank). */
  private loggedDrive: DriveInput = NO_DRIVE;
  /** Seeded RNG streams handed to extensions (SimContext.rng), keyed by `${extension}/${stream}`. */
  private readonly rngStreams = new Map<string, number>();
  private readonly contexts = new Map<string, SimContext>();

  /** `new GameSimulation(world, setup, extensions)`; the old options form is a thin wrapper through practiceSetup. */
  constructor(private readonly world: WorldQuery, input: MatchSetup | SimOptionsV1 = {}, extensions: readonly SimExtension[] = [], private readonly options: SimulationOptions = {}) {
    this.setup = validateMatchSetup(isMatchSetup(input) ? input : optionsSetup(input));
    this.rules = Object.freeze({ ...this.setup.rules, ammo: Object.freeze({ ...this.setup.rules.ammo }) });
    this.extensions = [];
    for (const extension of extensions) { validateExtension(extension, this.extensions); this.extensions.push(extension); }
    this.rng = this.setup.seed >>> 0;
    this.driveTest = this.setup.mode === 'drive';
    this.gravity = GRAVITY_BALLISTIC * this.rules.gravityScale;
    this.windSeed = (this.setup.environment?.weatherSeed ?? this.setup.seed) >>> 0;
    this.nativeBallistics = world.createBallistics?.(this.setup, this.gravity);
    this.brains = this.setup.tanks.map((_, id) => this.driveTest ? null : brainOf(this.setup, id));
    // Today's bot draws from the match stream (byte-identical duel); every other brain owns a seeded stream.
    this.brainInstances = this.brains.map((profile, id) => profile === null ? null
      : createBrain(profile, this.setup.tanks[id].difficulty ?? 'normal', brainSeed(this.setup.seed, id, profile), () => this.random()));
    this.brainTurns = this.brains.map(() => 0);
    this.heard = this.brains.map(() => []);
    this.ownImpacts = this.brains.map(() => []);
    this.turnStarts = this.brains.map(() => []);
    const sim = this;
    this.aiBudget = { get traceSteps() { return sim.meterRemaining(); } };
    const tanks = this.setup.tanks.map((spawn, id): TankState => {
      const kit = validateKitLoadout(spawn.loadout), pose = spawnPose(world, this.setup, id);
      return {
        id, position: pose.position, rotation: pose.rotation, velocity: [0, 0, 0], heading: pose.heading,
        turretYaw: 0, barrelPitch: 0.75, power: 0.55,
        health: spawn.maxHealth ?? assembleKit(kit).stats.hp, charge: this.rules.startCharge, movement: 0, recoil: 0,
        suspension: [0.5, 0.5, 0.5, 0.5], trackPhase: 0,
        trackPhases: [0, 0], trackSpeeds: [0, 0], trackGroundSpeeds: [0, 0], trackSlip: [0, 0], trackContact: [0, 0], yawVelocity: 0,
        wheelSuspension: Array(8).fill(0.5), treadContacts: Array(18).fill(-0.5), treadTerrain: [[], []],
        // The deprecated v1 field holds the nearest legacy equivalent until W2-GAME2 removes it; the kit ids are authoritative.
        loadout: kitLoadoutToLegacy(kit), kit: { ...spawn.loadout },
        team: spawn.team, readyAt: 0, maxHealth: spawn.maxHealth ?? assembleKit(kit).stats.hp, ...(spawn.name !== undefined ? { name: spawn.name } : {}),
        ...(this.driveTest ? {} : { ammo: initialAmmo(this.rules) }),
      };
    });
    this.playerTeams = new Set(this.setup.teams.filter(team => !team.ai).map(team => team.id));
    this.state = { tick: 0, time: 0, phase: 'aim', active: 0, turn: 1, phaseTime: 0, tanks, projectiles: [], contacts: tanks.map(() => null), winner: null, fog: this.rules.fog,
      observations: tanks.map(() => tanks.map(() => null)), wind: this.windAt(0) };
    world.configureLiquids?.(tanks.map(t => t.position));
    this.water = this.rules.projectileWater ? projectileWater(world.liquidBasins?.()) : undefined;
    this.nativeBallistics?.configureWater(this.water);
    this.nativeMatch = world.createMatchLifecycle?.(this.setup, this.state);
    if (this.nativeMatch?.nativeAI) for (let id = 0; id < this.brains.length; id++) {
      const profile = this.brains[id];
      if (profile === 'legacy') this.brainInstances[id] = this.nativeMatch.legacyBrain(id)!;
      else if (profile && isW1Profile(profile) && this.nativeMatch.nativeProfiles) this.brainInstances[id] = this.nativeMatch.profileBrain(profile, this.setup.tanks[id].difficulty ?? 'normal', brainSeed(this.setup.seed, id, profile), id)!;
    }
    this.nativeCombat = world.createCombat?.(this.setup, this.state, kitOf);
    if (this.nativeCombat) {
      if (!this.nativeMatch) throw new Error('Resident combat requires a resident match lifecycle');
      this.nativeCombat.bind(this.nativeMatch);
    }
    if (this.nativeMatch?.nativeActions) this.nativeMatch.admitActions(world.radius);
    if (this.nativeMatch?.nativeShots) {
      if (!this.nativeBallistics) throw new Error('Resident live shots require native ballistics');
      this.nativeBallistics.bind(this.nativeMatch);
    }
    if (this.nativeMatch?.nativeCanonical) this.nativeMatch.admitCanonical();
    if (this.nativeMatch?.nativeQueries) this.nativeMatch.admitMeter(AI_TRACE_BUDGET);
    if (!this.nativeMatch) this.state.active = this.nextActor() ?? 0;
    this.turnStarts[this.state.active].push(0);
    this.updateContacts();
    // Authored initial cuts commit before the first tick (a stall at tick 0 until they are prepared).
    const initial: CutRequest[] = (this.setup.initialCuts ?? []).map(cut => ({ id: cut.id, center: [...cut.center] as V3, radius: cut.radius }));
    if (initial.length && world.transactions) this.commits.push({ ticket: world.transactions.prepare(initial, 0), commitTick: 0, cuts: initial });
    else if (initial.length) { this.serialCarve = { cuts: initial, tick: 0 }; this.stall = { commitTick: 0, cutIds: initial.map(cut => cut.id), ticket: null, serial: true }; }
    for (const extension of this.extensions) if (extension.onMatchStart) this.extensionMotion(() => extension.onMatchStart!(this.context(extension)));
  }

  // ---- extensions (plan §5.5) ---------------------------------------------------------------------------------------

  /** The SimContext of one extension: shared state, deterministic RNG streams, events and damage. */
  private extensionMotion<T>(callback: () => T): T {
    const invoke = () => this.nativeMatch?.shots ? this.nativeMatch.shots.extension(callback) : callback();
    return this.nativeMatch?.motion ? this.nativeMatch.motion.extension(invoke) : invoke();
  }
  private context(extension: SimExtension): SimContext {
    let context = this.contexts.get(extension.id);
    if (!context) {
      const simulation = this;
      context = {
        get tick() { return simulation.state.tick; },
        state: this.state, rules: this.rules, world: this.world,
        rng: (stream: string) => {
          const key = `${extension.id}/${stream}`;
          return () => {
            // mulberry32 over a per-stream state seeded from (match seed, extension, stream).
            let state = this.rngStreams.get(key) ?? (parseInt(hashString(key, this.setup.seed >>> 0).slice(0, 8), 16) >>> 0);
            state = (state + 0x6d2b79f5) >>> 0;
            this.rngStreams.set(key, state);
            let t = state;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
          };
        },
        emit: event => { this.pending.push(event); },
        damage: (tank, amount, cause) => this.extensionDamage(tank, amount, cause),
      };
      this.contexts.set(extension.id, context);
    }
    return context;
  }

  private extensionDamage(id: PlayerId, amount: number, cause: string): void {
    const tank = this.state.tanks[id];
    if (!tank || !Number.isFinite(amount) || amount <= 0) return;
    if (this.nativeCombat) {
      if (this.nativeCombat.damage(id, amount)) this.pending.push({ type: 'kill', tank: id, by: null, cause });
      return;
    }
    if (this.driveTest || tank.health <= 0) return;
    tank.health = Math.max(0, tank.health - amount);
    if (tank.health === 0) this.pending.push({ type: 'kill', tank: id, by: null, cause });
  }

  /** Every extension's snapshot, by id (checkpoints and the match hash). */
  extensionSnapshots(): Record<string, unknown> {
    return Object.fromEntries(this.extensions.map(extension => [extension.id, extension.snapshot?.() ?? null]));
  }
  /** Restore extension state from snapshots (by id); unknown ids throw. */
  restoreExtensions(snapshots: Readonly<Record<string, unknown>>): void {
    for (const [id, value] of Object.entries(snapshots)) {
      const extension = this.extensions.find(candidate => candidate.id === id);
      if (!extension) throw new Error(`No sim extension '${id}' in this match`);
      extension.restore?.(structuredClone(value));
    }
  }

  // ---- queries -------------------------------------------------------------------------------------------------------

  /** Whether any tank is driven by a brain. */
  get bot(): boolean { return this.brains.some(brain => brain !== null); }
  /** The brain profile of a tank, or null for a human. */
  brainOf(tank: PlayerId): BotProfileId | null { return this.brains[tank] ?? null; }
  /** The tempo multiplier of a tank's kit (the product of its part multipliers). */
  tempoOf(tank: PlayerId): number { return kitOf(this.state.tanks[tank]).stats.tempo; }
  /** The next `count` actors on the timeline if everyone fires (for the HUD rail). */
  timeline(count = 6): PlayerId[] { return previewTimeline(this.timelineUnits(), id => this.tempoOf(id), count); }
  /** The match wind at a tick (null in still air): a pure function of (weather seed, tick), cached for the current tick. */
  windAt(tick: number): WindState | null {
    if (!this.rules.wind) return null;
    if (this.windCache?.tick !== tick) this.windCache = this.nativeBallistics ? this.nativeBallistics.windAt(tick) : sampleWind(this.windSeed, tick, this.rules.wind);
    return this.windCache;
  }
  /** Whether a terrain edit is prepared or carving and not yet committed. */
  get terrainPending(): boolean { return this.commits.length > 0 || this.serialCarve !== null; }
  /** The edit the match is stalled on, or null while it runs. */
  get stalledOn(): TerrainStall | null { return this.stall; }
  /** Frames spent stalled on unprepared terrain since the match started (telemetry). */
  get stalledFrames(): number { return this.stallFrames; }
  /** Committed terrain updates since the last call, for the presentation (footprints, debris). */
  drainTerrainUpdates(): TerrainUpdate[] { return this.terrainUpdates.splice(0); }
  /** COMPAT: the cuts the serial carve must apply (in order) before completeLegacyCarve(). */
  pendingSerialCuts(): readonly CutRequest[] { return this.serialCarve?.cuts ?? []; }
  /** The accepted inputs so far (checkpoint v2). */
  commandLog(): readonly MatchCommand[] { return this.nativeMatch?.journal?.log() ?? this.commands; }
  /** Replay retains its immutable plan and boundary cursor in the resident match. */
  residentReplay(checkpoint: MatchCheckpointV2): import('./native-journal').NativeReplay | undefined { return this.nativeMatch?.journal?.replay(checkpoint, this); }
  /** Brain work telemetry: the most trace steps spent in any tick, and decisions made. */
  aiTelemetry(): { peakStepsPerTick: number; budget: number; decisions: number; lastDecisionTicks: number } {
    const resident = this.nativeMatch?.meter?.read();
    return { peakStepsPerTick: resident?.peak ?? this.aiMeter.peak, budget: resident?.limit ?? this.aiMeter.limit, decisions: this.aiMeter.decisions, lastDecisionTicks: this.aiMeter.lastDecisionTicks };
  }
  /** v16 matches own the per-tick query meter; older engines keep the host meter. */
  private meterCharge(cost: number, unmetered: boolean): boolean {
    const resident = this.nativeMatch?.meter;
    if (resident) return resident.charge(cost, unmetered);
    if (!unmetered && this.aiMeter.used + cost > this.aiMeter.limit) return false;
    this.aiMeter.used += cost; return true;
  }
  private meterRemaining(): number {
    const resident = this.nativeMatch?.meter?.read();
    return resident ? Math.max(0, resident.limit - resident.used) : Math.max(0, this.aiMeter.limit - this.aiMeter.used);
  }
  /** The world's own composed query lease, when a resident controller may serve
   * its rays, surfaces and traces without host callbacks: no observation
   * wrapper and no extension segment hook can observe or alter those queries. */
  private residentBotLease(): import('./native-ballistics').BallisticQuery | undefined {
    if (!this.nativeMatch?.meter || this.options.wrapObservation || this.extensions.some(e => e.traceSegment)) return undefined;
    return this.world.botQuery?.();
  }
  /** The brain instance of a tank (tests and presentation hints), or null for a human. */
  brainFor(tank: PlayerId): BotBrain | null { return this.brainInstances[tank] ?? null; }

  /** Render interpolation (plan §5.5): the poses before and after the latest tick and how far wall time has run into
   * the next one. A stalled, paused or finished match shows its current poses (alpha 1). Presentation only. */
  interpolation(): SimInterpolation {
    const curr = this.poses();
    const running = !this.stall && this.state.phase !== 'finished' && this.previousPoses?.length === curr.length;
    return { alpha: running ? Math.min(1, (this.nativeMatch?.accumulator ?? this.accumulator) / FIXED_DT) : 1, prev: running ? this.previousPoses! : curr, curr };
  }

  /** Release this match's resident state. The world also releases all matches on disposal. */
  dispose(): void { this.nativeBallistics?.dispose(); this.retireFlights(); for (const brain of this.brainInstances) brain?.dispose?.(); this.nativeMatch?.dispose(); this.nativeCombat?.dispose(); }
  /** `shots = false`: the engine already cleared the live shots (a v20 tick tail's settlement). */
  private retireFlights(shots = true): void {
    if (shots) this.nativeMatch?.shots?.clear();
    for (const close of [...this.traceCleanup]) close();
    if (this.liveFlight) { this.nativeBallistics?.release(this.liveFlight.flight); this.liveFlight = null; }
  }

  /** Hash of the match state (and every extension snapshot) for replay checks. */
  matchHash(): string { const extensions = this.extensionSnapshots(); return this.nativeMatch?.canonical?.checkpoint(extensions).hash ?? snapshotHash({ state: this.state, extensions }); }

  // ---- checkpoint v2 ------------------------------------------------------------------------------------------------

  /** Checkpoint v2: setup + command log (+ the host's terrain edit log). Replaying it on the same build reproduces
   * the match hash; saving is allowed at any tick, pending terrain included (the replay re-derives it). */
  checkpoint(): MatchCheckpointV2 {
    if (this.nativeMatch?.canonical) {
      const extensions = this.extensionSnapshots(), { hash, tick } = this.nativeMatch.canonical.checkpoint(extensions);
      return validateMatchCheckpoint({ format: 'tmt-match', version: 2, setup: this.setup, commands: this.commandLog(), tick, hash, extensions, terrain: null });
    }
    return validateMatchCheckpoint({ format: 'tmt-match', version: 2, setup: this.setup, commands: this.commandLog(), tick: this.state.tick,
      hash: this.matchHash(), extensions: this.extensionSnapshots(), terrain: null });
  }

  // ---- commands ------------------------------------------------------------------------------------------------------

  /** Apply a player command now (at the current tick boundary). Accepted commands go into the checkpoint log;
   * 'drive' sets the input of the next step() calls. False = not accepted now or not supported yet. */
  command(tank: PlayerId, c: PlayerCommand): boolean {
    // A stalled match takes no input: every logged command at a tick boundary then follows the terrain commits due
    // there, which is the order a replay reproduces (MatchReplay steps 0 first). The edits due at this boundary are
    // resolved here too, so a command between construction and the first step() still follows the tick-0 initial cuts;
    // the events that pushes flush on the next step().
    if (this.stall || !this.resolveCommits()) return false;
    const journal = this.nativeMatch?.journal;
    return journal ? journal.record(() => this.dispatchCommand(tank, c)) : this.dispatchCommand(tank, c);
  }
  private dispatchCommand(tank: PlayerId, c: PlayerCommand): boolean {
    let accepted: boolean;
    switch (c.k) {
      case 'aim': accepted = this.actAim(tank, c.yaw, c.pitch, c.power); break;
      case 'fire': accepted = this.actFire(tank); break;
      case 'munition': accepted = this.actMunition(tank, c.id); break;
      case 'scan': accepted = this.actScan(tank); break;
      case 'endMove': accepted = this.actEndMove(tank); break;
      case 'hold': accepted = this.actHold(tank); break;
      default: return false;
    }
    if (accepted && !this.nativeMatch?.journal) this.commands.push({ tick: this.state.tick, tank, c: sanitizeCommand(c) });
    return accepted;
  }
  aim(player: PlayerId, yaw: number, pitch: number, power: number): boolean { return this.command(player, { k: 'aim', yaw, pitch, power }); }
  fire(player: PlayerId): boolean { return this.command(player, { k: 'fire' }); }
  scan(player: PlayerId): boolean { return this.command(player, { k: 'scan' }); }
  /** End the turn without firing (an expired aim timer does this too). */
  hold(player: PlayerId): boolean { return this.command(player, { k: 'hold' }); }
  endMove(player: PlayerId): boolean { return this.command(player, { k: 'endMove' }); }
  selectMunition(player: PlayerId, munition: MunitionId): boolean { return this.command(player, { k: 'munition', id: munition }); }

  /** @deprecated The online referee's pre-match loadout swap; it is not in the command log and goes with server/**. */
  setLoadout(player: PlayerId, loadout: Loadout): boolean {
    const tank = this.state.tanks[player];
    if (!tank || (this.nativeMatch?.nativeActions ? !this.nativeMatch.actionAllowed('kit', player) : this.hasFired || this.state.phase !== 'aim') || !validateLoadout(loadout)) return false;
    tank.loadout = { ...loadout }; tank.kit = legacyToKitIds(loadout);
    if (this.nativeMatch?.nativeActions) this.nativeMatch.setActionKit(tank);
    if (this.nativeCombat) this.nativeCombat.setKit(tank);
    else tank.health = kitOf(tank).stats.hp;
    this.previewCache = null;
    return true;
  }

  canFire(player: PlayerId): boolean {
    if (!this.state.tanks[player] || !weaponOperational(this.state.tanks[player])) return false;
    if (this.nativeMatch?.nativeActions) return this.nativeMatch.actionAllowed('fire', player, !!this.serialCarve, this.state.projectiles.length, this.commits.length);
    return this.canAim(player) && ammoBlock(this.state.tanks[player], this.state.tanks[player].munition ?? 'explosive', this.driveTest) === null
      && (!this.driveTest || (!this.state.projectiles.length && !this.commits.length && (!this.hasFired || this.state.phaseTime >= 0.45)));
  }

  /** World-space kit socket: +Z forward, +Y up; yaw and pitch are radians. */
  muzzle(player: PlayerId): { position: V3; direction: V3 } { return this.nativeMatch?.nativeActions ? this.nativeMatch.socket(player) : this.muzzleFor(this.state.tanks[player]); }

  /** Terrain-only prediction: hidden tanks cannot leak through an endpoint marker. */
  preview(player: PlayerId, full = true): V3[] {
    return this.previewPrediction(player, full).points;
  }

  /** Same trace as preview, including whether its last point is an actual contact or only the flight limit. */
  previewPrediction(player: PlayerId, full = true, collider?: AimTargetCollider): TrajectoryPrediction {
    const tank = this.state.tanks[player];
    if (!tank) return { points: [], hit: false };
    const p = tank.position, q = tank.rotation, key: PreviewKey = { player, full, version: this.world.version, tick: this.rules.wind ? this.state.tick : 0,
      pose: [p[0], p[1], p[2], q[0], q[1], q[2], q[3], tank.turretYaw, tank.barrelPitch, tank.power], kit: kitOf(tank).key, munition: tank.munition,
      collider: collider ? [collider.center[0], collider.center[1], collider.center[2], collider.radius] : null };
    const cached = this.previewCache;
    if (cached && samePreview(cached.key, key)) return { points: cached.points.map(point => [...point]), hit: cached.hit, ...(cached.hitTarget ? { hitTarget: true } : {}) };
    const projectile = this.makeProjectile(player, false), flight = flightOf(projectile);
    const points: V3[] = [[...projectile.position]];
    let hit = false, hitTarget = false;
    try { for (let tick = 0; tick < (full ? Math.ceil(this.rules.projectileAge / FIXED_DT) : 21); tick++) {
      const result = this.advance(flight, projectile, false, collider, this.world);
      if (result.hit) { points.push([...result.hit.point]); hit = true; hitTarget = result.hitTarget; break; }
      if (tick % 3 === 2 || result.expired) points.push(flight.position);
      if (result.expired) break;
    } } finally { this.nativeBallistics?.release(flight); }
    this.previewCache = { key, points, hit, hitTarget };
    return { points: points.map(point => [...point]), hit, ...(hitTarget ? { hitTarget: true } : {}) };
  }

  /** Ground-target assistance uses the live integrator without commands, shot ids, AI budgets or enemy queries. */
  solveAimTarget(player: PlayerId, selection: V3 | AimSelection, previous?: AimTargetAim): AimTargetResult {
    const target = Array.isArray(selection) ? selection : selection.point, collider = Array.isArray(selection) ? undefined : selection.object?.collider;
    const tank = this.state.tanks[player];
    if (!tank || tank.health <= 0) return invalidAimTarget(target);
    const kit = kitOf(tank), cachedWind = this.windCache;
    // Retained aim describes the intended route through committed ground, not a new route around each piece of
    // falling debris. The actual preview and fired shell still test the complete moving collision world.
    const aimWorld = this.world.footprintSurface ?? this.world;
    try {
      return solveAimTarget({ position: tank.position, rotation: tank.rotation, gravity: this.gravity, collider,
        speed: power => munitionSpeed(kit, power, tank.munition), limits: yaw => kit.pitchLimits(yaw),
        muzzle: aim => this.muzzleFor({ ...tank, turretYaw: aim.yaw, barrelPitch: aim.pitch, power: aim.power }).position,
        trace: (aim, budget) => {
          const projectile = this.makeProjectile(player, false, aim), flight = flightOf(projectile);
          let nearest = projectile.position, nearestDistance = collider ? distance(nearest, target) : Infinity;
          let targetContact: V3 | null = null;
          const limit = Math.min(budget, Math.ceil(this.rules.projectileAge / FIXED_DT));
          try { for (let step = 0; step < limit; step++) {
            // Refine the hovered point along the hypothetical path through the selected object. Keep its first
            // real contact separately for feedback; terrain/extensions still terminate the hypothetical flight.
            const from = flight.position, result = this.advance(flight, projectile, false, undefined, aimWorld);
            if (collider) {
              const delta = sub(result.hit?.point ?? flight.position, from), squared = dot(delta, delta);
              const at = squared > 1e-10 ? clamp(dot(sub(target, from), delta) / squared, 0, 1) : 0;
              const point = add(from, mul(delta, at)), error = distance(point, target);
              if (error < nearestDistance) { nearest = point; nearestDistance = error; }
              if (!targetContact && squared > 1e-10) {
                const extent = Math.sqrt(squared), direction = mul(delta, 1 / extent);
                const contact = segmentSphere(from, direction, extent, collider.center, collider.radius);
                if (contact !== null) targetContact = add(from, mul(direction, contact));
              }
            }
            if (result.hit) return { point: targetContact ?? result.hit.point, hit: true, hitTarget: targetContact !== null, nearest, steps: step + 1 };
            if (result.expired) return { point: targetContact ?? flight.position, hit: targetContact !== null, hitTarget: targetContact !== null, nearest, steps: step + 1 };
          }
          return { point: targetContact ?? flight.position, hit: targetContact !== null, hitTarget: targetContact !== null, nearest, steps: limit };
          } finally { this.nativeBallistics?.release(flight); }
        },
      }, target, previous);
    } finally { this.windCache = cachedWind; }
  }

  // ---- stepping ------------------------------------------------------------------------------------------------------

  /** dt is real seconds. Overload is dropped, never converted into an unbounded catch-up. A terrain edit that is due
   * but not prepared stalls the match at its commit tick (stalledOn) and the waiting wall time is dropped too. */
  step(dt: number, drive: DriveInput = NO_DRIVE): GameEvent[] {
    if (this.state.phase === 'finished' || this.serialCarve) { this.discardTime(); return this.pending.splice(0); }
    if (this.nativeMatch) this.nativeMatch.frame(dt);
    else if (Number.isFinite(dt) && dt > 0) this.accumulator += Math.min(dt, FIXED_DT * MAX_TICKS_PER_STEP);
    const input = cleanDrive(drive);
    let steps = 0;
    for (;;) {
      if (!this.resolveCommits()) { this.discardTime(); this.stallFrames++; break; }
      if (this.paused()) { this.discardTime(); break; }
      if (this.nativeMatch ? !this.nativeMatch.canTick : !(this.accumulator + 1e-10 >= FIXED_DT && steps++ < MAX_TICKS_PER_STEP)) break;
      if (!this.nativeMatch) this.accumulator = Math.max(0, this.accumulator - FIXED_DT);
      this.fixedStep(input);
    }
    return this.pending.splice(0);
  }
  private discardTime(): void { if (this.nativeMatch) this.nativeMatch.frame(0, true); else this.accumulator = 0; }

  /** COMPAT (W2-GAME2 deletes it with the serial carve): the host finished the serial carve of `stalledOn`.
   * Without a result the edit counts as committed (analytic fixtures have no terrain to carve). */
  completeLegacyCarve(result: { status: 'committed'; update?: TerrainUpdate } | { status: 'failed'; code: string; message: string } = { status: 'committed' }): void {
    const carve = this.serialCarve;
    if (!carve) return;
    this.serialCarve = null; this.stall = null;
    this.applyCommit(carve.cuts, result);
  }
  /** @deprecated The online referee's name for completeLegacyCarve(); it goes when W1-SHELL deletes server/**. */
  completeTerrain(): void { this.completeLegacyCarve(); }

  // ---- actions (brains call these directly: their decisions are re-derived on replay, never logged) -----------------

  private actAim(player: PlayerId, yaw: number, pitch: number, power: number): boolean {
    if (this.nativeMatch?.nativeActions) return this.nativeMatch.admitAction('aim', player, !!this.serialCarve, [yaw, pitch, power]);
    if (!this.canAim(player) || ![yaw, pitch, power].every(Number.isFinite)) return false;
    const tank = this.state.tanks[player];
    // Barrel and chassis contacts belong to the solver chassis (world.stepTanks); aim clamps to the kit's elevation
    // envelope at this bearing (pitchLimits, plan §5.3).
    tank.turretYaw = wrapAngle(yaw);
    const limits = kitOf(tank).pitchLimits(tank.turretYaw);
    tank.barrelPitch = clamp(pitch, limits.min, limits.max);
    tank.power = clamp(power, 0, 1);
    return true;
  }

  private actFire(player: PlayerId): boolean {
    if (!this.canFire(player)) return false;
    const tank = this.state.tanks[player];
    const stats = kitOf(tank).stats;
    const native = this.nativeMatch?.nativeActions ? this.nativeMatch : undefined;
    if (!native) {
      if (this.nativeCombat) { if (!this.nativeCombat.spend(player, tank.munition ?? 'explosive')) return false; }
      else spendAmmo(tank, tank.munition ?? 'explosive', this.driveTest);
    }
    const projectile = native ? native.fireAction(player, !!this.serialCarve, this.commits.length) : this.makeProjectile(player);
    if (!projectile) return false;
    if (native) this.nativeCombat!.refresh();
    this.turnAction = 'fire';
    this.state.projectiles = [projectile];
    this.aiMoveAnchor = null;
    if (!native) {
      if (this.nativeMatch) this.nativeMatch.action('fire', player);
      else { this.state.phase = 'resolving'; this.state.phaseTime = 0; this.moveTime = this.rules.moveSeconds; }
      tank.movement = stats.fuel;
      tank.recoil = stats.recoil;
      tank.velocity = sub(tank.velocity, mul(normalize(projectile.velocity), stats.recoil * 5 / stats.mass));
    }
    this.hasFired = true;
    this.hear(tank, projectile);
    this.pending.push({ type: 'shot', player, launch: {
      id: projectile.id, tick: this.state.tick, munition: projectile.munition ?? 'explosive',
      weapon: kitOf(tank).loadout.weapon === 'rail' ? 'rail' : kitOf(tank).loadout.weapon === 'cannon' ? 'cannon' : 'mortar',
      power: tank.power, position: [...projectile.position], direction: normalize(projectile.velocity), up: normalize(projectile.position),
    } });
    this.prepareSpeculative(projectile);
    return true;
  }

  private actScan(player: PlayerId): boolean {
    if (this.nativeMatch?.observations) {
      if (!this.nativeMatch.observations.scan(this.world, player, !!this.serialCarve)) return false;
      this.nativeCombat!.refresh();
      this.pending.push({ type: 'scan', tank: player, position: [...this.state.tanks[player].position] });
      return true;
    }
    if (this.nativeMatch?.nativeActions) {
      if (!this.nativeMatch.admitAction('scan', player, !!this.serialCarve)) return false;
      this.nativeCombat!.refresh();
    } else {
      if (!this.canAim(player) || this.state.tanks[player].charge < this.rules.radarCost) return false;
      if (this.nativeCombat) { if (!this.nativeCombat.scan(player)) return false; }
      else this.state.tanks[player].charge -= this.rules.radarCost;
    }
    const scanner = this.state.tanks[player];
    for (const opponent of this.enemiesOf(scanner)) {
      if (opponent.health <= 0) continue;
      const up = normalize(opponent.position);
      const axes = frame(up, 0);
      const angle = this.random() * Math.PI * 2;
      // A timestamped area estimate. It never becomes a live hidden-position feed.
      const offset = add(mul(axes.right, Math.cos(angle) * 1.15), mul(axes.forward, Math.sin(angle) * 1.15));
      const estimatedUp = normalize(add(opponent.position, offset));
      const surface = this.world.surface(estimatedUp);
      const position = add(surface?.point ?? mul(estimatedUp, this.world.radius), mul(estimatedUp, ROOT_SURFACE_LIFT));
      this.observations[player][opponent.id] = { position, observedAt: this.state.time, source: 'scan', visible: false };
    }
    this.refreshPrimary(player);
    this.pending.push({ type: 'scan', tank: player, position: [...scanner.position] });
    return true;
  }

  private actHold(player: PlayerId): boolean {
    if (this.nativeMatch?.nativeActions) { if (!this.nativeMatch.admitAction('hold', player, !!this.serialCarve)) return false; }
    else {
      if (this.driveTest || !this.canAim(player)) return false;
      if (this.nativeMatch) this.nativeMatch.action('hold', player);
      else { this.state.phase = 'resolving'; this.state.phaseTime = 0; this.moveTime = 0; }
      this.state.tanks[player].movement = 0;
    }
    this.turnAction = 'hold';
    repairVehicle(this.state.tanks[player], (this.state.tanks[player].maxHealth ?? 130) * .5);
    this.finishOrPass();
    return true;
  }

  private actEndMove(player: PlayerId): boolean {
    if (this.nativeMatch?.nativeActions) return this.nativeMatch.admitAction('endMove', player, !!this.serialCarve);
    if (this.driveTest) return false;
    if (player !== this.state.active || this.state.phase !== 'resolving') return false;
    if (this.nativeMatch) this.nativeMatch.action('endMove', player);
    else this.moveTime = 0;
    this.state.tanks[player].movement = 0;
    return true;
  }

  private actMunition(player: PlayerId, munition: MunitionId): boolean {
    if (this.nativeMatch?.nativeActions) {
      const accepted = this.nativeMatch.admitAction('munition', player, !!this.serialCarve, [['explosive', 'heavy', 'incendiary', 'nuclear'].indexOf(munition)]);
      if (accepted) this.previewCache = null; return accepted;
    }
    if (!validMunition(munition) || !this.canAim(player) || ammoBlock(this.state.tanks[player], munition, this.driveTest) === 'empty') return false;
    this.state.tanks[player].munition = munition;
    this.previewCache = null;
    return true;
  }

  // ---- terrain transactions -------------------------------------------------------------------------------------------

  /** At a fixed-tick boundary: commit every edit due at or before the current tick, in order. False = stalled. */
  private resolveCommits(): boolean {
    const transactions = this.world.transactions;
    while (transactions && this.commits.length && this.commits[0].commitTick <= this.state.tick) {
      const commit = this.commits[0];
      const result = transactions.commitReady(commit.ticket, commit.commitTick);
      if (result.status === 'not-ready') {
        this.stall = { commitTick: commit.commitTick, cutIds: commit.cuts.map(cut => cut.id), ticket: commit.ticket, serial: false };
        return false;
      }
      this.commits.shift();
      this.applyCommit(commit.cuts, result);
    }
    this.stall = this.serialCarve ? this.stall : null;
    return true;
  }

  private applyCommit(cuts: readonly CutRequest[], result: Exclude<CommitResult, { status: 'not-ready' }> | { status: 'committed'; update?: TerrainUpdate }): void {
    if (result.status === 'committed') {
      if (result.update) this.terrainUpdates.push(result.update);
      this.pending.push({ type: 'terrain-commit', cutIds: cuts.map(cut => cut.id), version: result.update?.version ?? this.world.version });
      this.previewCache = null;
      this.updateContacts();
      const update: TerrainUpdate = result.update ?? { version: this.world.version, chunks: [], removed: [], milliseconds: 0, triangles: 0, rebuilt: 0 };
      for (const extension of this.extensions) if (extension.onTerrainCommit) this.extensionMotion(() => extension.onTerrainCommit!(this.context(extension), update));
    } else this.pending.push({ type: 'terrain-failed', code: result.code, message: result.message });
    this.finishOrPass();
  }

  /** Pre-trace the shot on the committed terrain and the current tank poses and prepare its crater speculatively,
   * so the edit is usually ready by its commit tick (zero stall). A mismatch at impact cancels it. */
  private prepareSpeculative(projectile: ProjectileState): void {
    const transactions = this.world.transactions;
    if (!transactions) return;
    this.cancelSpeculative();
    const flight = flightOf(projectile);
    let tick = this.state.tick;
    try { for (let step = 0; step < Math.ceil(this.rules.projectileAge / FIXED_DT) + 1; step++) {
      const result = this.advance(flight, projectile, true, undefined, this.world);
      if (result.hit) {
        // Trace step k runs in the live tick (fire tick + 1 + k), exactly where the impact would land.
        const cuts = [this.crater(tick + 1, projectile, result.hit)];
        this.speculative = { ticket: transactions.prepare(cuts, tick + 1 + this.rules.commitWindowTicks, { speculative: true }), shot: projectile.id, cuts };
        return;
      }
      if (result.expired) return;
      tick++;
    } } finally { this.nativeBallistics?.release(flight); }
  }

  /** Drop the outstanding speculative prepare (a new shot, an expired shell or the end of the match). */
  private cancelSpeculative(): void {
    if (!this.speculative) return;
    this.world.transactions?.cancel(this.speculative.ticket);
    this.speculative = null;
  }

  /** The lifted-centre crater of an impact (rules/crater.ts), with the deterministic id `${tick}:${shot}:0`. A world with
   * material craters (rust-engine-v22) also gets its material shells (rules/material-craters.ts). */
  private crater(tick: number, projectile: ProjectileState, hit: TerrainHit): CutRequest {
    const radius = munitionStats(kitOf(this.state.tanks[projectile.owner]), projectile.munition).radius;
    const profile: { center: V3; radius: number; shells?: CraterShell[] } = this.world.materialCraters ? materialCrater(hit.point, hit.normal, radius, projectile.munition) : craterProfile(hit.point, hit.normal, radius);
    return { id: `${tick}:${projectile.id}:0`, center: profile.center, radius: profile.radius, ...(profile.shells ? { shells: profile.shells } : {}) };
  }

  // ---- internals -----------------------------------------------------------------------------------------------------

  private timelineUnits() {
    return this.state.tanks.map(tank => ({ id: tank.id, readyAt: tank.readyAt ?? 0, alive: tank.health > 0, playerTeam: this.playerTeams.has(tank.team ?? -1) }));
  }
  /** Tempo timeline: the living tank with the lowest readyAt acts next (ties: player team, then lower id). */
  private nextActor(): PlayerId | null { return nextActor(this.timelineUnits()); }
  /** Tanks on another team: the only valid targets of sight, radar and brains. */
  private enemiesOf(tank: TankState): TankState[] { return this.state.tanks.filter(other => other.team !== tank.team); }
  private get observations(): (Contact | null)[][] { return this.state.observations!; }
  private poses(): TankPose[] {
    return this.state.tanks.map(tank => ({ position: [...tank.position], rotation: [...tank.rotation], turretYaw: tank.turretYaw, barrelPitch: tank.barrelPitch }));
  }
  /** The ballistic environment of a shell (live, preview and AI traces all use it). */
  private ballistics(projectile: ProjectileState): BallisticEnv {
    if (!this.rules.wind) return this.stillAir ??= { gravity: this.gravity, wind: null, windFactor: 0, water: this.water };
    return { gravity: this.gravity, water: this.water, wind: tick => this.windAt(tick)!, windFactor: windFactor(kitOf(this.state.tanks[projectile.owner]), projectile.munition) };
  }

  /** The v1 `contacts[observer]`: the visible enemy nearest the observer, else the most recently observed one. */
  private refreshPrimary(observer: PlayerId): void {
    const self = this.state.tanks[observer];
    let best: Contact | null = null, bestDistance = Infinity;
    for (const contact of this.observations[observer]) {
      if (!contact) continue;
      const range = distance(contact.position, self.position);
      if (!best || (contact.visible && !best.visible) || (contact.visible === best.visible
        && (contact.visible ? range < bestDistance : contact.observedAt > best.observedAt))) { best = contact; bestDistance = range; }
    }
    this.state.contacts[observer] = best;
  }

  private canAim(player: PlayerId): boolean {
    if (this.nativeMatch?.nativeActions) return this.nativeMatch.actionAllowed('aim', player, !!this.serialCarve);
    if (this.driveTest) return player === 0 && !this.serialCarve && this.state.phase !== 'finished';
    return this.state.phase === 'aim' && this.state.active === player && !!this.state.tanks[player] && this.state.tanks[player].health > 0;
  }

  private paused(): boolean { return this.serialCarve !== null || this.state.phase === 'finished'; }

  private random(): number {
    if (this.nativeMatch?.nativeAI) return this.nativeMatch.random();
    this.rng = (Math.imul(1664525, this.rng) + 1013904223) >>> 0;
    return this.rng / 4294967296;
  }

  private muzzleFor(tank: TankState): { position: V3; direction: V3 } {
    if (this.nativeMatch?.nativeActions) return this.nativeMatch.socket(tank.id, { yaw: tank.turretYaw, pitch: tank.barrelPitch, power: tank.power, munition: tank.munition });
    const up = rotate([0, 1, 0], tank.rotation);
    const forward = rotate([Math.sin(tank.turretYaw), 0, Math.cos(tank.turretYaw)], tank.rotation);
    const direction = normalize(add(mul(forward, Math.cos(tank.barrelPitch)), mul(up, Math.sin(tank.barrelPitch))));
    const kit = kitOf(tank), trunnion = kitTrunnionPivot(kit);
    const pivot = add(add(tank.position, rotate(trunnion.axisPoint, tank.rotation)), mul(forward, trunnion.forward));
    return { position: add(pivot, mul(direction, kit.weapon.barrelLength)), direction };
  }

  private makeProjectile(player: PlayerId, allocateId = true, candidate?: AimCandidate): ProjectileState {
    if (this.nativeMatch?.nativeActions) {
      if (allocateId) throw new Error('Native shots require atomic fire admission');
      return this.nativeMatch.projectile(player, candidate);
    }
    const actual = this.state.tanks[player];
    const tank = candidate ? { ...actual, turretYaw: candidate.yaw, barrelPitch: candidate.pitch, power: candidate.power, munition: candidate.munition ?? actual.munition } : actual;
    const socket = this.muzzleFor(tank);
    return { id: allocateId ? this.nextShot++ : -1, owner: player, position: socket.position,
      velocity: mul(socket.direction, munitionSpeed(kitOf(tank), tank.power, tank.munition)), age: 0, munition: tank.munition ?? 'explosive',
      launchTick: this.state.tick, origin: [...socket.position], peakAltitude: length(socket.position) - this.world.radius };
  }

  /** Native live flights persist across ticks; immutable projectile snapshots are output for presentation. */
  private traceStep(projectile: ProjectileState, tanks: boolean, selected?: AimTargetCollider, world: WorldQuery = this.world): ShotResult {
    const shots = tanks && !selected && world === this.world ? this.nativeMatch?.shots : undefined;
    if (shots) {
      try { const flight = shots.start(projectile), result = this.advance(flight, projectile, true, undefined, world, shots); return shots.finish(result.hit); }
      catch (error) { shots.abort(); throw error; }
    }
    if (this.nativeBallistics && this.liveFlight?.id !== projectile.id) {
      if (this.liveFlight) this.nativeBallistics.release(this.liveFlight.flight);
      this.liveFlight = { id: projectile.id, flight: flightOf(projectile) };
    }
    const flight = this.liveFlight?.flight ?? flightOf(projectile), result = this.advance(flight, projectile, tanks, selected, world);
    if (result.hit || result.expired) { this.nativeBallistics?.release(flight); this.liveFlight = null; }
    if (!result.stepped) return { projectile, hit: result.hit, tank: null, expired: false };
    return { projectile: { ...projectile, velocity: [flight.vx, flight.vy, flight.vz], position: flight.position, age: flight.age }, hit: result.hit, tank: result.victim,
      hitTarget: result.hitTarget, expired: result.expired };
  }

  /** One step of a shell launched as `launch`, in place on `flight` (previews, the aim solver, brains and the pre-trace
   * keep one flight per trace): the same arithmetic and hit order as every live step. */
  private advance(flight: Flight, launch: ProjectileState, tanks: boolean, selected: AimTargetCollider | undefined, world: WorldQuery, live?: import('./native-shots').NativeShots): StepOutcome {
    const out = this.outcome, from = flight.position, age = flight.age, vx = flight.vx, vy = flight.vy, vz = flight.vz;
    out.hit = null; out.victim = null; out.hitTarget = false; out.expired = false; out.stepped = true;
    const nativeQuery = this.nativeBallistics ? world.ballisticQuery?.() : undefined;
    const barrelLength = kitOf(this.state.tanks[launch.owner]).weapon.barrelLength;
    // Keep the historical launch guard. Later segments use CCD on the current
    // query snapshot without adding a global inside query every tick.
    if (age === 0 && !nativeQuery) {
      const direction = normalize([vx, vy, vz]);
      const breech = sub(from, mul(direction, barrelLength));
      const blocked = world.raycast(breech, direction, barrelLength);
      if (blocked) { live?.blocked(blocked); out.hit = blocked; out.stepped = false; return out; }
      if (world.isSolid(from)) { out.hit = { point: [...from], normal: normalize(from), distance: 0, material: 0 }; live?.blocked(out.hit); out.stepped = false; return out; }
    }
    const nativeStep = live ? live.advance(flight, nativeQuery) : this.nativeBallistics?.advance(flight, barrelLength, this.rules.wind ? windFactor(kitOf(this.state.tanks[launch.owner]), launch.munition) : 0, nativeQuery);
    if (nativeStep && !nativeStep.stepped) { out.hit = nativeStep.hit; out.stepped = false; return out; }
    if (!nativeStep) advanceFlight(flight, this.ballistics(launch));
    const to = flight.position, dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2], extent = nativeStep?.extent ?? Math.hypot(dx, dy, dz);
    // normalize(delta): the same hypot, reciprocal and fallback.
    const scale = 1 / extent, direction: V3 = nativeStep?.direction ?? (extent > 1e-10 ? [dx * scale, dy * scale, dz * scale] : [0, 1, 0]);
    let hit = nativeQuery ? nativeStep!.hit : world.raycast(from, direction, extent), state: ProjectileState | null = null;
    // Extension segment hooks (trees, water, …): the nearest detonating hit before the terrain wins.
    for (const extension of this.extensions) {
      if (!extension.traceSegment) continue;
      state ??= launch.position === from && launch.age === age ? launch : { ...launch, velocity: [vx, vy, vz], position: from, age };
      const found: SegmentHit | null = this.extensionMotion(() => extension.traceSegment!(this.context(extension), from, to, state!));
      if (!found?.detonate || !(found.t >= 0 && found.t <= 1)) continue;
      const at = found.t * extent;
      if (!hit || at < hit.distance) hit = { point: [...found.point], normal: normalize(found.normal), distance: at, material: 0 };
    }
    // Resident live shots resolve entities in finish(), after these ordered hooks.
    if (!live && this.nativeCombat && (tanks || selected)) {
      const resolved = this.nativeCombat.resolve(from, direction, extent, age, launch.owner, tanks, selected, hit);
      hit = resolved.hit; out.victim = resolved.victim; out.hitTarget = resolved.hitTarget;
    } else if (!live) {
    if (selected) {
      const at = segmentSphere(from, direction, extent, selected.center, selected.radius);
      if (at !== null && (!hit || at < hit.distance)) {
        const point = add(from, mul(direction, at));
        hit = { point, normal: normalize(sub(point, selected.center)), distance: at, material: 0 };
        out.hitTarget = true;
      }
    }
    if (tanks) for (const tank of this.state.tanks) {
      if (tank.health <= 0 || (tank.id === launch.owner && age < 0.3)) continue;
      const at = segmentSphere(from, direction, extent, tank.position, TANK_RADIUS);
      if (at !== null && (!hit || at < hit.distance)) {
        const point = add(from, mul(direction, at));
        hit = { point, normal: normalize(sub(point, tank.position)), distance: at, material: 0 };
        out.victim = tank.id;
      }
    }
    }
    out.hit = hit;
    out.expired = nativeStep?.expired ?? (flight.age + 1e-9 >= this.rules.projectileAge || Math.hypot(to[0], to[1], to[2]) > this.world.radius * 5);
    return out;
  }

  private fixedStep(drive: DriveInput): void {
    if (this.nativeMatch?.nativeTick) return this.residentStep(drive);
    this.nativeMatch?.motion?.refresh();
    const movable = this.nativeMatch?.nativeActions ? this.nativeMatch.actionAllowed('move', 0) : this.driveTest || (this.state.phase === 'resolving' && (this.nativeMatch?.moveTime ?? this.moveTime) > 0 && this.state.tanks[this.state.active].movement > 0);
    const human = this.brains[this.state.active] === null;
    // Checkpoint v2: a human drive input that can move a tank is logged at this boundary when it changes.
    if (this.nativeMatch?.journal) this.nativeMatch.journal.drive(drive);
    else if (movable && human && (drive.throttle !== this.loggedDrive.throttle || drive.steer !== this.loggedDrive.steer)) {
      this.commands.push({ tick: this.state.tick, tank: this.state.active, c: { k: 'drive', throttle: drive.throttle, steer: drive.steer } });
      this.loggedDrive = { ...drive };
    }
    this.previousPoses = this.poses();
    this.aiMeter.used = 0;
    if (this.nativeMatch) this.nativeMatch.beginTick();
    else { this.state.tick++; this.state.time = this.state.tick * FIXED_DT; this.state.phaseTime += FIXED_DT; }
    if (this.rules.wind) this.state.wind = this.windAt(this.state.tick);
    const before = this.state.tanks.map(tank => [...tank.position] as V3);
    const inputs: DriveInput[] = [];
    for (const tank of this.state.tanks) {
      let input: DriveInput = NO_DRIVE;
      if (movable && tank.id === this.state.active && tank.health > 0) {
        const brain = this.brainInstances[tank.id];
        const resident = this.nativeMatch?.residentBrain(tank.id);
        input = resident ? cleanDrive(resident.drive(this.options.wrapObservation ? this.observe(tank.id) : undefined)) : brain ? cleanDrive(brain.drive?.(this.observe(tank.id), this.aiBudget) ?? NO_DRIVE) : drive;
      }
      inputs.push(input);
    }
    // The solver chassis owns all tank dynamics. A world without one (analytic fixtures) holds every pose.
    this.motionStep(movable, inputs, before);
  }

  /** v17: one engine call runs the tick head; host-owned stages follow in the original order. */
  private residentStep(drive: DriveInput): void {
    const match = this.nativeMatch!, active = this.state.active, resident = this.options.wrapObservation ? undefined : match.residentBrain(active);
    this.aiMeter.used = 0;
    try {
      const head = match.tickHead(drive, resident);
      // Poses at the tick boundary: the tick start changes neither the bound chassis nor the aim.
      this.previousPoses = this.poses();
      if (this.rules.wind) {
        if (!this.nativeBallistics) throw new Error('Resident tick heads require native ballistics');
        const w = head.wind;
        this.windCache = w.length ? { tick: w[0], strength: w[1], bars: w[2], heading: w[3], axis: [w[4], w[5], w[6]] } : null;
        this.state.wind = this.windAt(this.state.tick);
      }
      const before = this.state.tanks.map(tank => [...tank.position] as V3);
      const inputs: DriveInput[] = this.state.tanks.map(() => NO_DRIVE);
      if (head.mode === 2) inputs[active] = head.input;
      else if (head.mode === 1) {
        const brain = this.brainInstances[active], wrapped = match.residentBrain(active);
        inputs[active] = wrapped ? cleanDrive(wrapped.drive(this.observe(active))) : brain ? cleanDrive(brain.drive?.(this.observe(active), this.aiBudget) ?? NO_DRIVE) : drive;
      }
      this.motionStep(head.movable, inputs, before);
    } finally { match.motion?.endTick(); }
  }

  /** Physics and everything after it; `previousPoses` holds this tick's starting poses. */
  private motionStep(movable: boolean, inputs: DriveInput[], before: V3[]): void {
    inputs = inputs.map((input, i) => damagedDrive(this.state.tanks[i], input));
    const previous = this.previousPoses!;
    if (this.world.stepTanks) this.world.stepTanks(this.state.tanks, inputs, FIXED_DT);
    else this.world.fixedStep?.();
    // During the aim phase the chassis still settles under gravity. Counter-rotate the turret so the selected
    // direction stays fixed in the planet's tangent frame until the player actually changes the aim.
    if (this.nativeMatch?.nativeTail) { this.residentTail(movable, inputs); return; }
    if (this.nativeMatch?.nativeActions) this.nativeMatch.actionMotion(movable, previous);
    else if (this.state.phase === 'aim' || this.driveTest) {
      const tank = this.state.tanks[this.state.active];
      const beforeAim = previous[this.state.active];
      tank.turretYaw = holdPlanetBearing(beforeAim, tank, tank.turretYaw);
    }
    for (const tank of this.state.tanks) {
      const profile = this.treadProfile(tank, tank.position);
      tank.treadContacts = [...profile.heights]; tank.treadTerrain = profile.terrain;
      if (!this.driveTest) {
        if (!this.nativeMatch?.nativeActions && movable && tank.id === this.state.active) tank.movement = Math.max(0, tank.movement - distance(before[tank.id], tank.position));
        if (length(tank.position) < this.world.radius * .25 && tank.health > 0) {
          const killed = this.nativeCombat ? this.nativeCombat.fall(tank.id) : (tank.health = 0, true);
          if (killed) this.pending.push({ type: 'kill', tank: tank.id, by: null, cause: 'fall' });
        }
      }
    }
    for (const extension of this.extensions) if (extension.onTick) this.extensionMotion(() => extension.onTick!(this.context(extension)));
    if (this.state.phase === 'resolving') {
      if (this.nativeMatch) {
        const active = this.state.active;
        this.nativeMatch.afterMotion(movable, !!this.brainInstances[active], inputs[active], before[active]);
      } else {
        this.moveTime = Math.max(0, this.moveTime - FIXED_DT);
        const active = this.state.active;
        if (!this.driveTest && movable && this.brainInstances[active] && this.moveTime > 0) {
          const tank = this.state.tanks[active];
          let anchor = this.aiMoveAnchor;
          if (!anchor || anchor.tank !== active) anchor = this.aiMoveAnchor = { tank: active, position: [...before[active]], elapsed: 0, idle: 0 };
          anchor.elapsed += FIXED_DT;
          anchor.idle = Math.abs(inputs[active].throttle) < 0.01 && Math.abs(inputs[active].steer) < 0.01 ? anchor.idle + FIXED_DT : 0;
          if (distance(anchor.position, tank.position) >= 0.2) {
            anchor.position = [...tank.position]; anchor.elapsed = 0;
          }
          // Allow pivot and reverse recovery, then pass a blocked or completed turn.
          if (anchor.elapsed >= 8 || anchor.idle >= 0.5) { this.moveTime = 0; tank.movement = 0; }
        }
        if (this.moveTime === 0) this.state.tanks[this.state.active].movement = 0;
      }
      const projectile = this.nativeMatch?.shots ? this.nativeMatch.shots.current() : this.state.projectiles[0];
      if (projectile) {
        const result = this.traceStep(projectile, true);
        if (result.hit) this.impact(result.impactProjectile ?? projectile, result.hit, result.tank);
        else if (this.nativeMatch?.shots) { if (result.expired) this.cancelSpeculative(); }
        else {
          const next = result.projectile;
          next.peakAltitude = Math.max(projectile.peakAltitude ?? -Infinity, length(next.position) - this.world.radius);
          this.state.projectiles = result.expired ? [] : [next];
          // The pre-trace hit something the live shell missed (a tank moved away): its speculative crater goes.
          if (result.expired) this.cancelSpeculative();
        }
      }
      if (!this.paused()) this.finishOrPass();
    }
    if (this.state.tick % 6 === 0) this.updateContacts();
    if (this.state.phase === 'aim') this.finishOrPass();
    // An optional aim timer turns an expired aim phase into a Hold (Experience §1.8), for humans and brains alike.
    if (this.nativeMatch ? this.nativeMatch.aimExpired : this.rules.aimSeconds !== undefined && this.state.phase === 'aim' && this.state.phaseTime >= this.rules.aimSeconds - 1e-9) this.actHold(this.state.active);
    if (this.brainInstances[this.state.active] && this.state.phase === 'aim') this.think(this.state.active);
    this.aiMeter.peak = Math.max(this.aiMeter.peak, this.aiMeter.used);
  }

  /** v20: the post-solver part of the tick runs in the engine, which stops only for host services (extension tick
   * hooks, host-serviced shots, impacts, host-serviced contacts). Its records are the outputs of the operations it
   * ran; each is handled exactly as the original call's result was, so events keep their order. */
  private residentTail(movable: boolean, inputs: DriveInput[]): void {
    const match = this.nativeMatch!, active = this.state.active, lease = this.world.ballisticQuery?.();
    if (lease && !match.owns(lease)) throw new Error('Tick tail query belongs to another engine');
    const blocked = () => +(!!this.serialCarve || this.commits.length > 0);
    const start = [this.world.radius, +movable, +!!this.brainInstances[active], inputs[active].throttle, inputs[active].steer, blocked(), +!!this.serialCarve,
      +this.extensions.some(e => e.onTick), +this.extensions.some(e => e.traceSegment), lease?.kind ?? 0, lease?.id ?? 0, lease?.range ?? 1, ...this.state.tanks.map(t => this.tempoOf(t.id))];
    // v21: the engine samples the tread profiles of a composed resident query world after the first batch (record 103).
    const engineTreads = match.nativeTreads && lease?.kind === 2;
    if (match.nativeTreads) { start.push(this.world.version, ...TREAD_RANGE); for (const tank of this.state.tanks) start.push(...treadGearWords(kitOf(tank))); }
    let tail = match.tail(match.nativeTreads ? 70 : 67, start);
    let treads = engineTreads, projectile: ProjectileState | undefined, shot: ReturnType<import('./native-shots').NativeShots['finished']> | undefined;
    for (;;) {
      for (const { tag, words } of tail.records) {
        if (tag === 12 || tag === 4) match.published(words);
        else if (tag === 102) { if (this.nativeCombat!.fell(words.subarray(1))) this.pending.push({ type: 'kill', tank: words[0], by: null, cause: 'fall' }); }
        else if (tag === 49) { match.shots!.published(words); projectile = this.state.projectiles[0]; }
        else if (tag === 51) { shot = match.shots!.finished(words); if (!shot.hit && shot.expired) this.cancelSpeculative(); }
        else if (tag === 5) { match.published(words); this.settled(words[13]); }
        else if (tag === 52) match.shots!.published(words, true);
        else if (tag === 26) match.observations!.publish(words);
        else if (tag === 10) { match.published(words); if (words[13]) this.turnAction = 'hold'; }
        else if (tag === 103) this.engineTread(words);
      }
      // Tread contacts sample the poses the solver left: nothing in the tail moves a chassis before a host service.
      if (!treads) { treads = true; for (const tank of this.state.tanks) { const profile = this.treadProfile(tank, tank.position); tank.treadContacts = [...profile.heights]; tank.treadTerrain = profile.terrain; } }
      if (tail.status === 0) break;
      if (tail.status === 1) for (const extension of this.extensions) { if (extension.onTick) this.extensionMotion(() => extension.onTick!(this.context(extension))); }
      else if (tail.status === 2) {
        const result = this.traceStep(projectile!, true);
        if (result.hit) this.impact(result.impactProjectile ?? projectile!, result.hit, result.tank);
        else if (result.expired) this.cancelSpeculative();
      } else if (tail.status === 3) this.impact(shot!.impactProjectile ?? projectile!, shot!.hit!, shot!.tank);
      else this.updateContacts();
      tail = match.tail(68, [tail.status === 3 ? 2 : tail.status === 4 ? 4 : tail.status, blocked(), +!!this.serialCarve]);
    }
    if (this.brainInstances[this.state.active] && this.state.phase === 'aim') this.think(this.state.active);
    this.aiMeter.peak = Math.max(this.aiMeter.peak, this.aiMeter.used);
  }
  /** A v21 engine tread profile [tank, changed, 18 heights, n0, (z, y)*n0, n1, (z, y)*n1]; unchanged keeps the last one. */
  private engineTread(w: Float64Array): void {
    const tank = this.state.tanks[w[0]];
    if (w[1] === 0) { const last = this.engineTreads[w[0]]; if (!last) throw new Error('Engine tread profile has no predecessor'); tank.treadContacts = last.contacts; tank.treadTerrain = last.terrain; return; }
    const contacts = Array.from(w.subarray(2, 20)), terrain: [number, number][][] = [];
    for (let side = 0, p = 20; side < 2; side++) { const points: [number, number][] = []; for (let i = 0, n = w[p++]; i < n; i++, p += 2) points.push([w[p], w[p + 1]]); terrain.push(points); }
    this.engineTreads[w[0]] = { contacts, terrain }; tank.treadContacts = contacts; tank.treadTerrain = terrain;
  }
  private readonly engineTreads: { contacts: number[]; terrain: [number, number][][] }[] = [];
  /** The host side of a resident settlement event (finishOrPass after settle; the engine already cleared the shots). */
  private settled(event: number): void {
    if (event === 1) {
      this.retireFlights(false);
      if (this.nativeMatch!.observations) this.turnStarts[this.state.active] = [this.state.tick];
      else this.turnStarts[this.state.active].push(this.state.tick);
      this.pending.push({ type: 'turn', player: this.state.active });
    } else if (event === 2) {
      this.retireFlights(false);
      this.cancelSpeculative(); this.state.projectiles = [];
      this.pending.push({ type: 'finish', winner: this.state.winner, team: this.state.winnerTeam! });
    }
  }

  private treadProfile(tank: TankState, position: V3): TrackTerrainSample {
    const kit = kitOf(tank), version = this.world.version, gear = kit.loadout.runningGear, q = tank.rotation;
    const cache = this.treadCache[tank.id] ??= [];
    for (const entry of cache) {
      const p = entry.pose;
      if (sameNumber(entry.version, version) && sameText(entry.gear, gear) && sameNumber(p[0], position[0]) && sameNumber(p[1], position[1]) && sameNumber(p[2], position[2])
        && sameNumber(p[3], q[0]) && sameNumber(p[4], q[1]) && sameNumber(p[5], q[2]) && sameNumber(p[6], q[3])) return entry.sample;
    }
    const sample = sampleTrackTerrain(this.world, position, q, kit), entry: TreadEntry = { version, gear, pose: [position[0], position[1], position[2], q[0], q[1], q[2], q[3]], sample };
    if (cache.length < 4) cache.push(entry);
    else { const next = this.treadNext[tank.id] ?? 0; cache[next] = entry; this.treadNext[tank.id] = (next + 1) % 4; }
    return sample;
  }

  private impact(projectile: ProjectileState, hit: TerrainHit, direct: PlayerId | null): void {
    const stats = munitionStats(kitOf(this.state.tanks[projectile.owner]), projectile.munition);
    const shooter = this.state.tanks[projectile.owner];
    const hits: NonNullable<ImpactEvent['hits']> = [], kills: GameEvent[] = [];
    if (this.nativeCombat) {
      hits.push(...this.nativeCombat.impact(projectile, hit, direct, this.world.ballisticQuery?.(), (o, d, n) => this.blocked(o, d, n)));
      for (const h of hits) if (h.lethal) kills.push({ type: 'kill', tank: h.tank, by: projectile.owner, cause: h.direct ? 'direct' : 'blast' });
    } else for (const tank of this.state.tanks) {
      const blastExtent = stats.radius * 1.65 + TANK_RADIUS;
      const separation = distance(hit.point, tank.position);
      let exposure = direct === tank.id ? 1 : clamp(1 - separation / blastExtent, 0, 1);
      if (exposure <= 0) continue;
      const start = add(hit.point, mul(hit.normal, 0.08));
      const obstruction = this.blocked(start, normalize(sub(tank.position, start)), Math.max(0, distance(start, tank.position) - TANK_RADIUS));
      if (obstruction && direct !== tank.id) exposure *= 0.35;
      const targetKit = kitOf(tank), target = targetKit.stats;
      // Friendly fire off spares teammates (never the shooter's own tank).
      const spared = !this.rules.friendlyFire && tank.team === shooter.team && tank.id !== shooter.id;
      const before = tank.health;
      const protection = armorResponse(tank, targetKit, { point: hit.point, direct: direct === tank.id,
        weapon: kitOf(shooter).loadout.weapon, munition: projectile.munition ?? 'explosive' });
      const canDamage = !this.driveTest && !spared && before > 0;
      if (canDamage) {
        tank.health = Math.max(0, tank.health - Math.max(1, Math.round(stats.damage * exposure * protection.multiplier)));
        if (protection.reactiveSpent) tank.reactiveArmor = ((tank.reactiveArmor ?? 0) | protection.reactiveSpent) & 15;
      }
      tank.velocity = add(tank.velocity, mul(normalize(sub(tank.position, hit.point)), exposure * 25 / target.mass));
      hits.push({ tank: tank.id, damage: before - tank.health, exposure, direct: direct === tank.id, lethal: before > 0 && tank.health === 0,
        armorSection: protection.section, ...(canDamage && protection.reactiveSpent ? { reactiveSpent: protection.reactiveSpent } : {}) });
      if (before > 0 && tank.health === 0) kills.push({ type: 'kill', tank: tank.id, by: projectile.owner, cause: direct === tank.id ? 'direct' : 'blast' });
    }
    for (const h of hits) damageVehicle(this.state.tanks[h.tank], hit.point, h.damage, h.direct);
    if (this.nativeMatch?.shots) this.nativeMatch.shots.clear(); else this.state.projectiles = [];
    const tick = this.state.tick, cut = this.crater(tick, projectile, hit);
    const transactions = this.world.transactions;
    let commitTick = tick;
    if (transactions) {
      commitTick = tick + this.rules.commitWindowTicks;
      const speculative = this.speculative?.shot === projectile.id ? this.speculative : null;
      let ticket: TerrainTicket;
      if (speculative && sameCuts(speculative.cuts, [cut]) && transactions.promote(speculative.ticket, [cut], commitTick)) ticket = speculative.ticket;
      else {
        if (this.speculative) transactions.cancel(this.speculative.ticket);
        ticket = transactions.prepare([cut], commitTick);
      }
      this.speculative = null;
      transactions.freezeBodies(cutBounds(cut), commitTick);
      this.commits.push({ ticket, commitTick, cuts: [cut] });
      this.commits.sort((a, b) => a.commitTick - b.commitTick);
    } else {
      // COMPAT: no transactions (before the W1-TER merge, and analytic fixtures): stall now for the serial carve.
      this.serialCarve = { cuts: [cut], tick };
      this.stall = { commitTick: tick, cutIds: [cut.id], ticket: null, serial: true };
    }
    const flight = flightStats(projectile.origin ?? projectile.position, hit.point, Math.round(projectile.age / FIXED_DT) + 1,
      Math.max(projectile.peakAltitude ?? -Infinity, length(hit.point) - this.world.radius), this.world.radius);
    const event: ImpactEvent = { type: 'impact', position: [...hit.point], normal: [...hit.normal], radius: stats.radius, owner: projectile.owner, munition: projectile.munition ?? 'explosive',
      commitTick, cut, hits, flight };
    this.pending.push(event, ...kills);
    if (this.nativeMatch?.observations) this.nativeMatch.observations.impact(projectile.owner, hit.point);
    else {
      const own = this.ownImpacts[projectile.owner];
      own.push({ tick, position: [...hit.point] });
      if (own.length > 4) own.shift();
    }
    for (const extension of this.extensions) if (extension.onImpact) this.extensionMotion(() => extension.onImpact!(this.context(extension), event));
  }

  private finishOrPass(): void {
    // Neither a handover nor the result happens before the pending terrain edits have committed.
    if (this.serialCarve || this.commits.length || this.state.phase === 'finished') return;
    if (this.nativeMatch) {
      const event = this.nativeMatch.settle(id => this.tempoOf(id));
      if (event === 'turn') {
        this.retireFlights();
        if (this.nativeMatch.observations) this.turnStarts[this.state.active] = [this.state.tick];
        else this.turnStarts[this.state.active].push(this.state.tick);
        this.pending.push({ type: 'turn', player: this.state.active });
      } else if (event === 'finish') {
        this.retireFlights();
        this.cancelSpeculative(); this.state.projectiles = [];
        this.pending.push({ type: 'finish', winner: this.state.winner, team: this.state.winnerTeam! });
      }
      return;
    }
    if (this.driveTest) {
      if (!this.state.projectiles.length) this.state.phase = 'aim';
      return;
    }
    const living = this.state.tanks.filter(tank => tank.health > 0);
    const teams = new Set(living.map(tank => tank.team));
    // Finish by team elimination; the winner is the lowest-id survivor of the last team standing.
    if (teams.size < 2) return this.finish(living.length ? living[0].team ?? null : null);
    // A tank that dies during its own aim phase (a fall, an extension's damage) can never act: it passes as a Hold.
    if (this.state.phase === 'aim' && this.state.tanks[this.state.active].health <= 0) {
      this.turnAction = 'hold'; this.state.phase = 'resolving'; this.moveTime = 0;
    }
    if (this.state.phase !== 'resolving' || this.state.projectiles.length || (this.moveTime > 0 && this.state.tanks[this.state.active].movement > 0)) return;
    // A turn limit ends the match after its last turn: the team with the most health left wins (a tie is a draw).
    if (this.rules.maxTurns !== undefined && this.state.turn >= this.rules.maxTurns) {
      const health = new Map<number, number>();
      for (const tank of living) health.set(tank.team ?? -1, (health.get(tank.team ?? -1) ?? 0) + tank.health);
      const ranked = [...health].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      return this.finish(ranked.length > 1 && ranked[0][1] === ranked[1][1] ? null : ranked[0][0]);
    }
    const previous = this.state.tanks[this.state.active];
    previous.charge = Math.min(MAX_CHARGE, previous.charge + 1);
    previous.readyAt = advanceReady(previous.readyAt ?? 0, this.turnAction, kitOf(previous).stats.tempo);
    this.turnAction = 'fire';
    this.state.active = this.nextActor()!;
    this.state.turn++;
    if (this.rules.suddenDeathTurn !== undefined && this.state.turn >= this.rules.suddenDeathTurn) this.state.suddenDeath = true;
    this.state.phase = 'aim';
    this.state.phaseTime = 0;
    this.retireFlights();
    this.turnStarts[this.state.active].push(this.state.tick);
    this.pending.push({ type: 'turn', player: this.state.active });
  }

  private finish(team: number | null): void {
    const winner = team === null ? null : this.state.tanks.find(tank => tank.team === team && tank.health > 0)?.id ?? null;
    // A match can end with a shell still in flight (the last enemy fell): nothing will promote its speculative crater.
    this.cancelSpeculative();
    this.retireFlights();
    this.state.phase = 'finished';
    this.state.winner = winner;
    this.state.winnerTeam = team;
    this.state.projectiles = [];
    this.pending.push({ type: 'finish', winner, team });
  }

  /**
   * Line of sight (docs/visibility-architecture.md). A team sees an enemy when any living team tank's kit sensor has a
   * clear ray to any of the enemy's sight points: any visible portion identifies the tank. The team's result is written
   * into every member's row, so allies share sightings. Tanks never occlude; fog off reveals every living enemy.
   */
  private updateContacts(): void {
    if (this.nativeMatch?.observations) { this.nativeMatch.observations.refresh(this.world); return; }
    const teams = new Map<unknown, TankState[]>();
    for (const tank of this.state.tanks) {
      const key = tank.team ?? `tank:${tank.id}`;
      const members = teams.get(key);
      if (members) members.push(tank); else teams.set(key, [tank]);
    }
    for (const members of teams.values()) {
      const sensors = members.filter(tank => tank.health > 0).map(tank => add(tank.position, rotate(kitOf(tank).frames.sensor.position, tank.rotation)));
      for (const target of this.enemiesOf(members[0])) {
        const visible = target.health > 0 && sensors.length > 0 && (!this.rules.fog || this.teamSees(sensors, target));
        for (const observer of members) {
          const known = this.observations[observer.id][target.id];
          if (visible) this.observations[observer.id][target.id] = { position: [...target.position], observedAt: this.state.time, source: 'sight', visible: true };
          else if (known) known.visible = false;
        }
      }
      for (const observer of members) this.refreshPrimary(observer.id);
    }
  }

  /** Any sensor with a clear ray (within 1.65 R, stopping 0.12 u short) to any sight point of the target. */
  sensorSees(observerId: PlayerId, targetId: PlayerId): boolean {
    const observer = this.state.tanks.find(tank => tank.id === observerId), target = this.state.tanks.find(tank => tank.id === targetId);
    if (!observer || !target || target.health <= 0) return false;
    if (target.id === observer.id || (observer.team !== undefined && target.team === observer.team)) return true;
    const sensors = this.state.tanks.filter(tank => tank.health > 0 && (tank.id === observer.id || (observer.team !== undefined && tank.team === observer.team)))
      .map(tank => add(tank.position, rotate(kitOf(tank).frames.sensor.position, tank.rotation)));
    return this.teamSees(sensors, target);
  }

  /** Shared by authoritative contacts and the developer's forced-fog visibility query. */
  private teamSees(sensors: readonly V3[], target: TankState): boolean {
    const points = this.sightPoints(target);
    for (const origin of sensors) {
      for (const point of points) {
        const extent = distance(origin, point);
        if (extent >= this.world.radius * 1.65) continue;
        if (!this.blocked(origin, normalize(sub(point, origin)), Math.max(0, extent - 0.12))) return true;
      }
    }
    return false;
  }

  /** Whether world.raycast() would return a hit, through the world's any-hit query where it has one (it stops at the
   * first triangle it would accept instead of searching for the nearest). */
  private blocked(origin: V3, direction: V3, maxDistance: number): boolean {
    const world = this.world as WorldQuery & { blocked?(origin: V3, direction: V3, maxDistance: number): boolean };
    return typeof world.blocked === 'function' ? world.blocked(origin, direction, maxDistance) : !!world.raycast(origin, direction, maxDistance);
  }

  /**
   * World points spanning a tank: the hull box corners (inset 0.05 u) and centre, the legacy sight target, the turret box
   * centre and top (at the current turret yaw), the trunnion pivot and the muzzle.
   */
  sightPoints(tank: TankState): V3[] {
    if (this.nativeMatch?.observations) return this.nativeMatch.observations.sightPoints(tank);
    const kit = kitOf(tank);
    let cached = this.sightCache[tank.id];
    if (!cached || cached.kit !== kit || !Object.is(cached.yaw, tank.turretYaw)) cached = this.sightCache[tank.id] = { kit, yaw: tank.turretYaw, points: hullSightPoints(kit, tank.turretYaw) };
    const world = cached.points.map(p => add(tank.position, rotate(p, tank.rotation)));
    const trunnion = kitTrunnionPivot(kit);
    const forward = rotate([Math.sin(tank.turretYaw), 0, Math.cos(tank.turretYaw)], tank.rotation);
    world.push(add(add(tank.position, rotate(trunnion.axisPoint, tank.rotation)), mul(forward, trunnion.forward)), this.muzzleFor(tank).position);
    return world;
  }

  // ---- brains (observation only, plan §3 AI) -----------------------------------------------------------------------

  /** One tick of the active brain's thinking: free decisions (aim, scan) continue in the same tick; fire, hold and
   * reposition end it. Resident brains use the same private-knowledge filter. */
  private think(id: PlayerId): void {
    const brain = this.brainInstances[id]!, resident = this.nativeMatch?.residentBrain(id);
    if (this.brainTurns[id] !== this.state.turn) { this.brainTurns[id] = this.state.turn;
      if (resident) resident.begin(this.options.wrapObservation ? this.observe(id) : undefined); else brain.begin(this.observe(id)); }
    const lease = resident ? this.residentBotLease() : undefined;
    for (let decisions = 0; decisions < 4 && this.state.phase === 'aim' && this.state.active === id; decisions++) {
      const decision = resident ? lease ? resident.stepResident(lease) : resident.step(this.botQueries(id), this.aiBudget) : brain.step(this.observe(id), this.aiBudget);
      if (!decision) return;
      switch (decision.kind) {
        case 'aim': this.actAim(id, decision.yaw, decision.pitch, decision.power); return;
        case 'scan': if (!this.actScan(id)) return; continue;
        case 'fire': {
          const tank = this.state.tanks[id];
          if ((tank.munition ?? 'explosive') !== decision.munition && !this.actMunition(id, decision.munition)) this.actMunition(id, 'explosive');
          this.actAim(id, decision.yaw, decision.pitch, decision.power);
          if (!this.actFire(id)) this.actHold(id);
          this.recordDecision(id);
          return;
        }
        case 'reposition': this.actReposition(id); this.recordDecision(id); return;
        default: this.actHold(id); this.recordDecision(id); return;
      }
    }
  }

  private recordDecision(id: PlayerId): void {
    for (const close of [...this.traceCleanup]) close();
    this.aiMeter.decisions++;
    this.aiMeter.lastDecisionTicks = this.state.tick - (this.turnStarts[id].at(-1) ?? this.state.tick);
  }

  /** A turn spent driving instead of firing (the brain's drive() steers; costs a fire's tempo in Wave 1). */
  private actReposition(player: PlayerId): boolean {
    if (this.nativeMatch?.nativeActions) { if (!this.nativeMatch.admitAction('reposition', player, !!this.serialCarve)) return false; }
    else {
      if (this.driveTest || !this.canAim(player)) return false;
      if (this.nativeMatch) this.nativeMatch.action('reposition', player);
      else { this.state.phase = 'resolving'; this.state.phaseTime = 0; this.moveTime = this.rules.moveSeconds; }
      this.state.tanks[player].movement = kitOf(this.state.tanks[player]).stats.fuel;
    }
    this.turnAction = 'hold';
    this.aiMoveAnchor = null;
    return true;
  }

  /** Record a shot for every enemy within earshot that cannot see the shooter: a bearing wedge (±15°), seeded per
   * shot and listener (never the match stream). */
  private hear(shooter: TankState, projectile: ProjectileState): void {
    if (this.nativeMatch?.observations) { this.nativeMatch.observations.hear(shooter.id, projectile.id); return; }
    for (const listener of this.enemiesOf(shooter)) {
      if (listener.health <= 0 || distance(listener.position, shooter.position) > SOUND_RANGE || this.observations[listener.id][shooter.id]?.visible) continue;
      const delta = sub(shooter.position, listener.position);
      const bearing = Math.atan2(dot(delta, rotate([1, 0, 0], listener.rotation)), dot(delta, rotate([0, 0, 1], listener.rotation)));
      const noise = (brainSeed(this.setup.seed, projectile.id, listener.id) / 4294967296 * 2 - 1) * SOUND_WEDGE;
      const heard = this.heard[listener.id];
      heard.push({ bearing: wrapAngle(bearing + noise), tick: this.state.tick });
      if (heard.length > 4) heard.shift();
    }
  }

  /** Resident controllers already own their private observations; only ordered,
   * metered callbacks cross the host boundary during ordinary native play. */
  private botQueries(id: PlayerId): import('./ai/native-legacy').ResidentBotQueries {
    if (this.options.wrapObservation) return this.observe(id);
    return { world: this.meteredWorld(), trace: (yaw, pitch, power, munition, launchTick) => this.trace(id, { yaw, pitch, power, munition }, false, launchTick) };
  }
  /** Detached private view: own state, allies, contacts, sound, impacts and wind;
   * never another tank's true hidden position. Also used by explicit inspection hooks. */
  private observe(id: PlayerId): BotObservation {
    const self = this.state.tanks[id], time = this.state.time;
    const knowledge = this.nativeMatch?.observations?.knowledge(id);
    const visible: BotObservation['visible'] = [], lastKnown: BotObservation['lastKnown'] = [];
    for (const other of knowledge ? [] : this.state.tanks) {
      if (other.id === id || other.health <= 0) continue;
      if (!this.rules.fog || other.team === self.team) { visible.push({ tank: other.id, team: other.team ?? 0, position: [...other.position], observedAt: time }); continue; }
      const contact = this.observations[id][other.id];
      if (!contact) continue;
      if (contact.visible) visible.push({ tank: other.id, team: other.team ?? 0, position: [...contact.position], observedAt: contact.observedAt });
      else {
        // Every enemy turn that began at or after the sighting could have moved it (by up to its fuel).
        const turnsSince = this.turnStarts[other.id].filter(tick => tick * FIXED_DT >= contact.observedAt - 1e-9).length;
        lastKnown.push({ tank: other.id, team: other.team ?? 0, position: [...contact.position], observedAt: contact.observedAt,
          uncertainty: Math.min(kitOf(other).stats.fuel * turnsSince, 20) });
      }
    }
    const wind = this.rules.wind ? windAcceleration(this.windAt(this.state.tick)!, self.position) : null;
    const observation: BotObservation = {
      tick: this.state.tick, self: structuredClone(self), rules: this.rules, wind,
      visible: knowledge?.visible ?? visible, lastKnown: knowledge?.lastKnown ?? lastKnown,
      sounds: knowledge?.sounds ?? this.heard[id].map(sound => ({ ...sound })), world: this.meteredWorld(),
      predict: (yaw, pitch, power, munition) => {
        const trace = this.trace(id, { yaw, pitch, power, munition }, true), path: V3[] = [];
        for (let step = trace.step(); step; step = trace.step()) if (trace.steps % 3 === 1 || step.hit || step.expired) path.push(step.to);
        return { impact: trace.impact, path, flightTicks: trace.steps };
      },
      trace: (yaw, pitch, power, munition, launchTick) => this.trace(id, { yaw, pitch, power, munition }, false, launchTick),
      phaseTime: this.state.phaseTime, impacts: knowledge?.impacts ?? this.ownImpacts[id].map(impact => ({ tick: impact.tick, position: [...impact.position] as V3 })),
    };
    return this.options.wrapObservation ? this.options.wrapObservation(observation, id) : observation;
  }

  private meteredWorldView: BotObservation['world'] | null = null;
  /** radius, raycast, surface and isSolid of the committed world; each ray costs one trace step. */
  private meteredWorld(): BotObservation['world'] {
    const world = this.world;
    return this.meteredWorldView ??= Object.freeze({
      get radius() { return world.radius; },
      raycast: (origin: V3, direction: V3, maxDistance: number) => { this.meterCharge(1, true); return world.raycast(origin, direction, maxDistance); },
      surface: (direction: V3) => { this.meterCharge(1, true); return world.surface(direction); },
      isSolid: (point: V3) => world.isSolid(point),
    });
  }

  /** An incremental trace of a shell from this tank on the live integrator (terrain and extensions only, never a
   * tank). Each step costs one trace step (the launch guard one more); a spent budget pauses it until the next tick
   * unless `unmetered` (predict()) lets it finish and records the overdraft. `launchTick` (default: now, at most a
   * minute ahead) is the tick the brain plans to fire at: the shell flies through that tick's wind timeline. */
  private trace(id: PlayerId, aim: AimCandidate, unmetered: boolean, launchTick?: number): BallisticTrace {
    const projectile = this.makeProjectile(id, false, aim);
    let done = false, impact: V3 | null = null, steps = 0;
    if (launchTick !== undefined && Number.isSafeInteger(launchTick) && launchTick > this.state.tick)
      projectile.launchTick = Math.min(launchTick, this.state.tick + MAX_TRACE_LEAD_TICKS);
    const flight = flightOf(projectile);
    const close = () => { done = true; this.nativeBallistics?.release(flight); this.traceCleanup.delete(close); };
    if (this.nativeBallistics) this.traceCleanup.add(close);
    return {
      get done() { return done; }, get impact() { return impact; }, get steps() { return steps; },
      step: () => {
        if (done) return null;
        if (!this.meterCharge(flight.age === 0 ? 2 : 1, unmetered)) return null;
        const from = flight.position, result = this.advance(flight, projectile, false, undefined, this.world);
        steps++;
        if (result.hit) { close(); impact = [...result.hit.point]; return { from, to: impact, hit: true, expired: false }; }
        if (result.expired) close();
        return { from, to: flight.position, hit: false, expired: result.expired };
      },
    };
  }
}

/** Replays a checkpoint v2 on a fresh world, one tick per advance step. The caller pumps it: synchronously in tests,
 * or across frames in the session, where a stall waits for the terrain (compat: the serial carve; W1-TER: the
 * preparer) exactly as live play does. Commands apply at the tick boundary they were logged at. */
export class MatchReplay {
  private readonly native?: import('./native-journal').NativeReplay;
  readonly simulation: GameSimulation;
  readonly checkpoint: MatchCheckpointV2;
  private cursor = 0;
  private drive: DriveInput = NO_DRIVE;
  private applied = -1;
  constructor(world: WorldQuery, checkpoint: MatchCheckpointV2 | unknown, extensions: readonly SimExtension[] = []) {
    this.checkpoint = validateMatchCheckpoint(checkpoint);
    this.simulation = new GameSimulation(world, this.checkpoint.setup, extensions);
    this.native = this.simulation.residentReplay(this.checkpoint);
  }
  get done(): boolean { return this.native?.done ?? (this.simulation.state.tick >= this.checkpoint.tick && this.applied === this.checkpoint.tick); }
  /** Advance up to `maxTicks` ticks. 'stalled' = the simulation waits on terrain (pump the host, then call again). */
  advance(maxTicks = Infinity): 'done' | 'stalled' | 'progress' {
    if (this.native) return this.native.advance(maxTicks);
    const simulation = this.simulation;
    for (let ticks = 0; ticks < maxTicks; ticks++) {
      const tick = simulation.state.tick;
      if (this.applied !== tick) {
        // At a boundary the edits due there commit before any logged command applies (command() refuses input while stalled).
        simulation.step(0);
        if (simulation.stalledOn) return 'stalled';
        const commands = this.checkpoint.commands;
        while (this.cursor < commands.length && commands[this.cursor].tick === tick) {
          const { tank, c } = commands[this.cursor++];
          if (c.k === 'drive') this.drive = { throttle: c.throttle, steer: c.steer };
          else if (!simulation.command(tank, c)) throw new Error(`Replay diverged: command ${this.cursor - 1} (${c.k}) was refused at tick ${tick}`);
        }
        this.applied = tick;
      }
      if (tick >= this.checkpoint.tick) return 'done';
      simulation.step(FIXED_DT, this.drive);
      if (simulation.state.tick === tick) return simulation.state.phase === 'finished' ? this.finished() : 'stalled';
    }
    return 'progress';
  }
  /** After 'done': whether the replay reproduced the saved state hash. */
  verified(): boolean { return this.native?.verified() ?? (this.simulation.matchHash() === this.checkpoint.hash); }
  private finished(): 'done' { throw new Error(`Replay diverged: the match finished at tick ${this.simulation.state.tick}, before the checkpoint tick ${this.checkpoint.tick}`); }
}
