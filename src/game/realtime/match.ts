/** Realtime match (docs/architecture.md). Every tank drives at once on the solver chassis, main guns fire on
 * reload with any number of shells in flight, an automatic coax engages close enemies without cutting terrain, and an
 * optional script (a campaign mission) spawns units and decides the result. It reuses the turn simulation's shared
 * rules: the ballistic integrator, crater profiles, terrain transactions, armour and line-of-sight. Deterministic at
 * the fixed 60 Hz tick: seeded streams, no clocks. Unlike the turn rules, a terrain edit that is not prepared by its
 * commit tick never stalls the match: realtime driving must not freeze whenever something explodes. The crater shows
 * at once (the view's pending cut) and the collision terrain commits when the edit is ready, in impact order. */
import { projectileWater, type ProjectileWater } from '../rules/projectile-water';
import type { Contact, DriveInput, GameEvent, GameSnapshot, ImpactEvent, PlayerId, ProjectileState, TankState, TerrainHit, TerrainQueryBounds,
  TerrainUpdate, TrajectoryPrediction, V3, WorldQuery, TankComponent } from '../contracts';
import type { CutRequest, TerrainTicket } from '../../gpu/terrain/transactions';
import type { AudioCue } from '../audio-cues';
import type { Difficulty, KitLoadoutIds, MatchRules, MatchSetup } from '../api/match';
import type { PlayerCommand } from '../api/session';
import type { MatchRuntime, RuntimeStall } from '../api/runtime';
import type { SimInterpolation, TankPose } from '../api/extensions';
import { add, clamp, distance, dot, frame, holdPlanetBearing, length, mul, normalize, rotate, rotation, segmentSphere, sub, wrapAngle } from '../math';
import { assembleKit, kitLoadoutToLegacy, validateKitLoadout, type KitAssembly } from '../kit';
import { kitTrunnionPivot } from '../kit/assembly';
import { ROOT_SURFACE_LIFT, SIGHT_TARGET } from '../kit/dimensions';
import { munitionSpeed, munitionStats, validMunition, windFactor, type MunitionId } from '../munitions';
import { craterProfile } from '../rules/crater';
import { materialCrater, type CraterShell } from '../rules/material-craters';
import { advanceFlight, FIXED_DT, flightStats, type BallisticEnv, type Flight } from '../rules/ballistics';
import { invalidAimTarget, solveAimTarget, TANK_TARGET_RADIUS, type AimSelection, type AimTargetAim, type AimTargetCollider, type AimTargetResult } from '../rules/aim-target';
import { armorResponse } from '../rules/armor';
import { ammoBlock, initialAmmo, spendAmmo } from '../rules/ammo';
import { snapshotHash } from '../rules/hash';
import { sampleWind, type WindState } from '../../world/weather';
import { sampleTrackTerrain, type TrackTerrainSample } from '../tread-contact';
import { AIM_SOLVES_PER_TICK, BRAIN_TRACE_STEPS, COAX, DECISION_INTERVAL_TICKS, DIFFICULTY, INCOMING_RADIUS, LAST_KNOWN_SECONDS, MAX_REALTIME_UNITS, WRECK_LIFETIME_TICKS, reloadTicks, SELF_DAMAGE } from './rules';
import { RealtimeCore } from './core';
import { SEARCHLIGHT_MOUNT, CAMPAIGN_COAX } from './fixtures';
import { RING_FRAME } from '../kit/sockets';
import { componentPoint, validComponents, validComponentState } from './components';
import { damagedDrive, damageVehicle, repairVehicle, validMachinery, weaponOperational, MODULE_DISABLED } from '../rules/vehicle-damage';
import { crewBuild, type CrewBuild } from '../campaign/loadout';
import { createRealtimeBrain, HOLD, type BrainOrder, type BrainView, type KnownEnemy, type RealtimeBrain, type RealtimeBrainId } from './brains';
import { spawnPose } from '../rules/setup';

const MAX_TICKS_PER_STEP = 8;
const NO_DRIVE: DriveInput = Object.freeze({ throttle: 0, steer: 0 });
/** Radar charge regained per second (one charge per 20 s), the realtime scan's reach and the charge cap (a scan costs
 * rules.radarCost charges). */
const SCAN_REGEN = 1 / 20, SCAN_RANGE = 26, MAX_SCAN_CHARGE = 3;

/** A unit a script (or the setup) puts on the planet. `spawn.up` is the surface direction; heading as in rotation(). */
export interface RealtimeUnitSpec {
  team: number;
  loadout: KitLoadoutIds;
  spawn: { up: V3; heading: number };
  /** null or absent: a human tank (only the player). */
  brain?: RealtimeBrainId | null;
  name?: string;
  maxHealth?: number;
  /** Script grouping ("targets", "wave-1", …). */
  group?: string;
  difficulty?: Difficulty;
  /** Never drives (targets, emplacements, the Spire). */
  immobile?: boolean;
  /** No main gun: the coax is its only weapon (Rustlings). */
  coaxOnly?: boolean;
  /** Never fires anything (range targets). */
  unarmed?: boolean;
  /** Patrol route and fallback goals, as surface directions. */
  waypoints?: readonly V3[];
  /** Damage this unit's weapons deal, as a fraction (practice shells). */
  damageScale?: number;
  /** Always visible to every enemy team (a spotter has marked it). */
  revealed?: boolean;
  /** Armoured plate the coax ignores (range targets that teach the main gun). */
  coaxProof?: boolean;
  /** Repair nearby allies per second; never itself. */
  supportRepair?: number;
  motionKind?: TankState['motionKind'];
  visualKind?: TankState['visualKind'];
  /** Light weapons and rockets never carve terrain. */
  noCrater?: boolean;
  altitude?: number;
  components?: readonly TankComponent[];
  driveScale?: number;
  /** Main-gun reload multiple (a forgiving line tank reloads slower than its kit). */
  reloadScale?: number;
  searchlight?: { height: number; range: number; angle: number; sweep: number; period: number };
}

/** Presentation and campaign events that are not part of the turn contract. */
export type RealtimeEvent =
  | { type: 'tracer'; owner: PlayerId; from: V3; to: V3; victim: PlayerId | null }
  /** An audio cue for the score/effects (src/game/audio-cues.ts); presentation only. */
  | { type: 'audio'; cue: AudioCue }
  | { type: 'spawn'; tank: PlayerId }
  | { type: 'say'; speaker: string; text: string; seconds: number }
  | { type: 'objective'; id: string; text: string; state: 'active' | 'done' | 'failed' }
  | { type: 'hint'; text: string | null }
  | { type: 'banner'; title: string; subtitle?: string }
  /** The current objective's place on the planet (null clears it). */
  | { type: 'marker'; point: V3 | null; tank?: PlayerId; component?: string; label?: string }
  | { type: 'mission'; status: 'won' | 'failed'; reason?: string };

export interface UnitStats { shots: number; hits: number; kills: number; damageTaken: number; lastHitTick: number }

/** What a script can do and read; everything it does is a deterministic function of the tick. */
export interface ScriptApi {
  readonly crew: CrewBuild;
  readonly tick: number;
  readonly time: number;
  readonly state: GameSnapshot;
  readonly world: WorldQuery;
  /** The human tank. */
  readonly player: PlayerId;
  readonly players?: readonly PlayerId[];
  spawn(spec: RealtimeUnitSpec): PlayerId | null;
  /** Units of a group (dead ones included, in spawn order). */
  group(name: string): TankState[];
  stats(tank: PlayerId): Readonly<UnitStats>;
  /** Impact points of shells fired by `tank`, oldest first (bounded). */
  impactsOf(tank: PlayerId): readonly V3[];
  damage(tank: PlayerId, amount: number, cause?: string): void;
  heal(tank: PlayerId, amount: number): void;
  order(tank: PlayerId, goal: V3 | null): void;
  orderOf(tank: PlayerId): V3 | null | undefined;
  setRevealed(tank: PlayerId, revealed: boolean): void;
  /** Fire a shell from `tank` at a surface point now (a scripted salvo); false when it cannot. */
  fireAt(tank: PlayerId, target: V3, lob?: boolean): boolean;
  emit(event: RealtimeEvent): void;
  /** End the match: `team` wins (null: nobody). */
  finish(team: number | null, reason?: string): void;
}

export interface RealtimeScript {
  start(api: ScriptApi): void;
  tick(api: ScriptApi): void;
  /** Sees every match event after the tick that produced it. */
  onEvent?(api: ScriptApi, event: GameEvent): void;
  checkpoint?(): unknown;
  restore?(api: ScriptApi, data: unknown): void;
  command?(api: ScriptApi, tank: number, command: PlayerCommand): boolean;
  /** A restored unit's spec with the script's current tuning (a save keeps its units, not their old balance). */
  migrateUnit?(spec: RealtimeUnitSpec): RealtimeUnitSpec;
}

export interface RealtimeCheckpoint {
  /** Online recovery includes live shells; campaign autosaves still require a settled beat. */
  online?: { ultimatePending: { kind: NonNullable<CrewBuild['ultimate']>; point: V3; at: number } | null; ending: { team: number | null; reason?: string } | null; seats?: number[] };
  repairKits: number; ultimateUsed: boolean;
  state: GameSnapshot; nextShot: number; nextGeneration: number; nextEnemySalvo: number;
  units: { spec: RealtimeUnitSpec; ready: number; coaxReady: number; heat: number; overheated: boolean; order: BrainOrder; revealed: boolean; stats: UnitStats; impacts: V3[]; random: number; commanded?: V3 | null }[];
  core: ReturnType<RealtimeCore['snapshot']>; archived: [string, TankState[]][]; script: unknown;
  sightings: [number, [PlayerId, TeamSighting][]][];
  incoming: { tank: PlayerId; impactTick: number; predicted: V3; at: number }[];
}

export interface RealtimeReplica {
  state: GameSnapshot;
  units: { spec: RealtimeUnitSpec; ready: number; heat: number; overheated: boolean }[];
  repairKits: number; ultimateUsed: boolean;
}

interface Unit {
  readonly spec: RealtimeUnitSpec;
  readonly brain: RealtimeBrain | null;
  readonly kit: KitAssembly;
  readonly reload: number;
  readonly rng: RandomStream;
  ready: number;
  coaxReady: number;
  heat: number;
  overheated: boolean;
  order: BrainOrder;
  revealed: boolean;
  stats: UnitStats;
  impacts: V3[];
  commanded?: V3 | null;
}
interface Shell { projectile: ProjectileState; flight: Flight }
interface PendingCommit { readonly ticket: TerrainTicket; readonly commitTick: number; readonly cuts: readonly CutRequest[] }
/** An edit still not prepared this long after its commit tick is dropped (terrain-failed) instead of waiting forever. */
const COMMIT_GIVE_UP_TICKS = 600;
interface TeamSighting { position: V3; velocity: V3; time: number; visible: boolean }

const flightOf = (p: ProjectileState): Flight => ({ position: p.position, vx: p.velocity[0], vy: p.velocity[1], vz: p.velocity[2], age: p.age, launchTick: p.launchTick });
const cutBounds = (cut: CutRequest): TerrainQueryBounds => ({ min: cut.center.map(v => v - cut.radius) as V3, max: cut.center.map(v => v + cut.radius) as V3 });
const cleanDrive = (drive: DriveInput): DriveInput => ({ throttle: Number.isFinite(drive.throttle) ? clamp(drive.throttle, -1, 1) : 0, steer: Number.isFinite(drive.steer) ? clamp(drive.steer, -1, 1) : 0 });
/** mulberry32 over a seed. */
interface RandomStream { (): number; state: number }
function stream(seed: number): RandomStream {
  const random: RandomStream = () => {
    random.state = (random.state + 0x6d2b79f5) >>> 0;
    let t = random.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  random.state = seed >>> 0; return random;
}

export class RealtimeMatch implements MatchRuntime {
  private readonly isReplica: boolean;
  private readonly humanDrive = new Map<number, DriveInput>();
  private onlineSeats: number[] | null = null;
  readonly state: GameSnapshot;
  readonly setup: MatchSetup;
  readonly rules: Readonly<MatchRules>;
  readonly driveTest = false;
  readonly gravity: number;
  /** The human tank (setup.tanks[0]). */
  readonly player: PlayerId = 0;
  private readonly units: Unit[] = [];
  private readonly core = new RealtimeCore();
  readonly crew: CrewBuild;
  private repairKits = 0;
  private ultimateUsed = false;
  private ultimatePending: { kind: NonNullable<CrewBuild['ultimate']>; point: V3; at: number } | null = null;
  private readonly nativeBallistics?: import('../native-ballistics').NativeBallistics;
  private readonly archived = new Map<string, TankState[]>();
  private nextGeneration = 1;
  private nextEnemySalvo = 0;
  private readonly shells: Shell[] = [];
  private readonly sightings = new Map<number, Map<PlayerId, TeamSighting>>();
  private readonly treadCache: { version: number; pose: string; sample: TrackTerrainSample }[] = [];
  private readonly difficulty: Difficulty;
  private readonly script: RealtimeScript | null;
  private readonly api: ScriptApi;
  private commits: PendingCommit[] = [];
  private stall: RuntimeStall | null = null;
  private stallFrames = 0;
  private terrainUpdates: TerrainUpdate[] = [];
  private pending: GameEvent[] = [];
  private realtime: RealtimeEvent[] = [];
  private incoming: { tank: PlayerId; impactTick: number; predicted: V3; at: number }[] = [];
  private accumulator = 0;
  private nextShot = 1;
  private previousPoses: TankPose[] | null = null;
  private solvesLeft = AIM_SOLVES_PER_TICK;
  private decisions = 0;
  private water?: ProjectileWater;
  private stillAir: BallisticEnv | null = null;
  private windCache: WindState | null = null;
  private readonly windSeed: number;

  constructor(private readonly world: WorldQuery, setup: MatchSetup, options: { script?: RealtimeScript | null; units?: readonly RealtimeUnitSpec[]; checkpoint?: RealtimeCheckpoint; replica?: boolean } = {}) {
    this.isReplica = options.replica === true;
    if (setup.rules.turnModel !== 'realtime') throw new Error(`RealtimeMatch needs rules.turnModel 'realtime', got '${setup.rules.turnModel}'`);
    this.setup = setup;
    this.crew = crewBuild(setup.crew); this.repairKits = this.crew.gadgets.includes('repair-kit') ? 2 : 0;
    this.rules = Object.freeze({ ...setup.rules, ammo: Object.freeze({ ...setup.rules.ammo }) });
    this.gravity = 9.81 * this.rules.gravityScale;
    this.nativeBallistics = world.createBallistics?.(setup, this.gravity);
    this.windSeed = (setup.environment?.weatherSeed ?? setup.seed) >>> 0;
    this.difficulty = setup.tanks[0]?.difficulty ?? 'normal';
    this.state = { tick: 0, time: 0, phase: 'aim', active: 0, turn: 1, phaseTime: 0, tanks: [], projectiles: [], contacts: [], winner: null,
      fog: this.rules.fog, observations: [], wind: null };
    this.script = options.script ?? null;
    const match = this;
    this.api = {
      crew: this.crew,
      get tick() { return match.state.tick; }, get time() { return match.state.time; }, get state() { return match.state; }, get world() { return match.world; },
      get player() { return setup.online?.kind === 'coop' ? (match.onlineSeats ?? setup.online.seats).find(id => match.state.tanks[id]?.health > 0 && !match.state.tanks[id]?.retired) ?? match.player : match.player; },
      get players() { return match.onlineSeats ?? setup.online?.seats ?? [match.player]; },
      spawn: spec => this.spawn(spec),
      group: name => [...(this.archived.get(name) ?? []), ...this.state.tanks.filter(tank => this.units[tank.id].spec.group === name)],
      stats: tank => this.units[tank].stats,
      impactsOf: tank => this.units[tank]?.impacts ?? [],
      damage: (id, amount, cause = 'hazard') => {
        const tank = this.state.tanks[id]; if (!tank || tank.health <= 0 || !Number.isFinite(amount) || amount <= 0) return;
        const damage = Math.min(tank.health, amount);
        if (tank.components) tank.health = this.core.damageComponents(tank, tank.position, damage, 0, -2);
        else tank.health -= damage;
        this.units[id].stats.damageTaken += damage; this.units[id].stats.lastHitTick = this.state.tick;
        if (tank.health <= 0) this.kill(tank, null, cause, true);
      },
      heal: (id, amount) => {
        const tank = this.state.tanks[id]; if (!(tank?.health > 0 && Number.isFinite(amount) && amount > 0)) return;
        if (tank.components) {
          for (const c of tank.components) if (c.health > 0) { const repaired = Math.min(amount, c.maxHealth - c.health); c.health += repaired; amount -= repaired; }
          tank.health = tank.components.reduce((sum, c) => sum + c.health, 0);
        } else {
          tank.health = Math.min(tank.maxHealth ?? tank.health, tank.health + amount); repairVehicle(tank, amount);
          if (tank.motionKind !== 'air' && this.units[id].spec.motionKind === 'air' && (tank.machinery?.engine ?? 1) > MODULE_DISABLED) {
            this.world.removeTank?.(id); tank.motionKind = 'air';
          }
        }
      },
      order: (id, goal) => { if (this.units[id]) this.units[id].commanded = goal; },
      orderOf: id => { const goal = this.units[id]?.commanded; return goal ? [...goal] : goal; },
      setRevealed: (tank, revealed) => { const unit = this.units[tank]; if (unit) unit.revealed = revealed; },
      fireAt: (tank, target, lob = false) => this.scriptedShot(tank, target, lob),
      emit: event => { this.realtime.push(event); },
      finish: (team, reason) => this.finish(team, reason),
    };
    if (options.checkpoint) {
      const saved = structuredClone(options.checkpoint);
      if (this.script?.migrateUnit) for (const u of saved.units) u.spec = this.script.migrateUnit(u.spec);
      if (saved.state.tanks.length !== saved.units.length || saved.state.tanks.some((tank, i) => !validComponentState(tank, saved.units[i].spec.components) || !validMachinery(tank.machinery))) throw new Error('Invalid checkpoint component state');
      for (const u of saved.units) this.spawn(u.spec);
      Object.assign(this.state, saved.state);
      saved.units.forEach((u, i) => { Object.assign(this.units[i], u); this.units[i].rng.state = u.random; });
      this.nextShot = saved.nextShot; this.nextGeneration = saved.nextGeneration; this.nextEnemySalvo = saved.nextEnemySalvo;
      this.repairKits = saved.repairKits; this.ultimateUsed = saved.ultimateUsed;
      this.core.restore(saved.core); for (const [name, group] of saved.archived) this.archived.set(name, group);
      for (const [team, contacts] of saved.sightings) this.sightings.set(team, new Map(contacts));
      this.incoming = saved.incoming;
      if (saved.online) {
        this.ultimatePending = saved.online.ultimatePending; this.ending = saved.online.ending;
        this.onlineSeats = saved.online.seats ?? null;
        for (const projectile of this.state.projectiles) this.shells.push({ projectile, flight: flightOf(projectile) });
      }
      this.script?.restore?.(this.api, saved.script);
      for (const tank of this.state.tanks) if (tank.retired) world.removeTank?.(tank.id);
      world.configureLiquids?.(this.state.tanks.map(t => t.position));
      this.water = this.rules.projectileWater ? projectileWater(world.liquidBasins?.()) : undefined;
      this.nativeBallistics?.configureWater(this.water);
      this.spawnEvents.length = 0; return;
    }
    // The player first (it is setup.tanks[0]), then any initial units.
    const poses = setup.tanks.map((spawn, index) => {
      if (spawn.spawn !== 'auto') return spawn.spawn;
      const pose = spawnPose(world, setup, index);
      return { up: normalize(pose.position), heading: pose.heading };
    });
    for (const [index, spawn] of setup.tanks.entries()) {
      const human = index === 0 || setup.online?.seats.includes(index);
      const brain = spawn.brain === 'tosser' || spawn.brain === 'vex' ? spawn.brain : 'rusty';
      // A local bot searches an opposing starting area when it has no contact. This is a fixed map goal,
      // never the hidden opponent's live position, and uses the existing realtime core's waypoint fallback.
      const waypoints = setup.mode === 'skirmish' && !human ? poses.filter((_, i) => setup.tanks[i].team !== spawn.team).map(pose => pose.up) : undefined;
      this.spawn({ team: spawn.team, loadout: spawn.loadout, spawn: poses[index], brain: human ? null : brain, name: spawn.name,
        maxHealth: spawn.maxHealth, difficulty: spawn.difficulty, ...(waypoints ? { waypoints } : {}) });
    }
    for (const spec of options.units ?? []) this.spawn(spec);
    this.state.wind = this.windAt(0);
    this.updateSight();
    if (!options.replica) this.script?.start(this.api);
    world.configureLiquids?.(this.state.tanks.map(t => t.position));
    this.water = this.rules.projectileWater ? projectileWater(world.liquidBasins?.()) : undefined;
    this.nativeBallistics?.configureWater(this.water);
    this.realtime.push(...this.spawnEvents.splice(0));
  }

  // ---- MatchRuntime ---------------------------------------------------------------------------------------------------

  get stalledOn(): RuntimeStall | null { return this.stall; }
  /** Only capture a quiet transaction boundary: no half-applied terrain or flights. */
  checkpoint(online = false): RealtimeCheckpoint | null {
    if (this.commits.length || (!online && (this.shells.length || this.ultimatePending || this.decided))) return null;
    return structuredClone({ state: this.state, nextShot: this.nextShot, nextGeneration: this.nextGeneration, nextEnemySalvo: this.nextEnemySalvo,
      core: this.core.snapshot(), archived: [...this.archived], script: this.script?.checkpoint?.(),
      sightings: [...this.sightings].map(([team, contacts]) => [team, [...contacts]]), incoming: this.incoming, repairKits: this.repairKits, ultimateUsed: this.ultimateUsed,
      ...(online ? { online: { ultimatePending: this.ultimatePending, ending: this.ending, ...(this.onlineSeats ? { seats: this.onlineSeats } : {}) } } : {}),
      units: this.units.map(u => ({ spec: u.spec, ready: u.ready, coaxReady: u.coaxReady, heat: u.heat, overheated: u.overheated, order: u.order,
        revealed: u.revealed, stats: u.stats, impacts: u.impacts, random: u.rng.state, ...(u.commanded !== undefined ? { commanded: u.commanded } : {}) })) });
  }
  /** Presentation replicas never run NPC decisions, weapons, damage or mission scripts. */
  replica(): RealtimeReplica {
    return structuredClone({ state: this.state, units: this.units.map(u => ({ spec: u.spec, ready: u.ready, heat: u.heat, overheated: u.overheated })),
      repairKits: this.repairKits, ultimateUsed: this.ultimateUsed });
  }
  applyReplica(value: RealtimeReplica): void {
    // Replica slots follow authoritative generations; local retired slots must never choose a different spawn id.
    for (let i = 0; i < value.units.length; i++) {
      if (!this.units[i] || this.state.tanks[i].generation !== value.state.tanks[i].generation) {
        this.spawn(value.units[i].spec, i);
      }
    }
    Object.assign(this.state, structuredClone(value.state));
    value.units.forEach((u, i) => { this.units[i].ready = u.ready; this.units[i].heat = u.heat; this.units[i].overheated = u.overheated; });
    this.repairKits = value.repairKits; this.ultimateUsed = value.ultimateUsed;
    this.previousPoses = this.poses(); this.solvesLeft = AIM_SOLVES_PER_TICK;
    this.pending = []; this.realtime = []; this.spawnEvents.length = 0;
  }
  predictReplica(seat: number, drive: DriveInput): void {
    if (this.state.phase === 'finished' || !(this.state.tanks[seat]?.health > 0)) return;
    const others = this.state.tanks.map(t => t.id === seat ? null : structuredClone(t));
    const inputs = this.state.tanks.map(t => t.id === seat ? cleanDrive(drive) : NO_DRIVE);
    this.world.stepTanks?.(this.state.tanks.filter(t => !t.retired && t.motionKind !== 'air' && t.motionKind !== 'swarm'), inputs, FIXED_DT);
    others.forEach((tank, i) => { if (tank) Object.assign(this.state.tanks[i], tank); });
    this.solvesLeft = AIM_SOLVES_PER_TICK;
  }
  configureOnlineSeats(peers: readonly { seat: number; name: string }[]): void {
    const seats = this.setup.online?.seats; if (!seats) return;
    for (const id of seats) {
      const peer = peers.find(p => p.seat === id), tank = this.state.tanks[id];
      if (!peer && tank.health > 0) { tank.health = 0; tank.retired = true; this.world.removeTank?.(id); this.humanDrive.delete(id); }
      else if (this.setup.online?.kind === 'coop') {
        if (peer && this.onlineSeats && !this.onlineSeats.includes(id)) {
          const ally = this.state.tanks.find(t => t.id !== id && t.team === tank.team && t.health > 0 && seats.includes(t.id));
          const spawn = ally ? { up: normalize(add(normalize(ally.position), mul(frame(normalize(ally.position), ally.heading).right, .14))), heading: ally.heading } : this.units[id].spec.spawn;
          this.spawn({ ...this.units[id].spec, spawn, name: peer.name }, id);
        }
      }
      if (peer) { this.state.tanks[id].name = peer.name; this.units[id].spec.name = peer.name; }
    }
    this.onlineSeats = peers.map(p => p.seat);
  }
  /** The match has a result (fixed steps may end it mid-loop). */
  get finished(): boolean { return this.state.phase === 'finished'; }
  get terrainPending(): boolean { return this.commits.length > 0; }
  get stalledFrames(): number { return this.stallFrames; }
  brainOf(tank: PlayerId): string | null { return this.units[tank]?.spec.brain ?? null; }
  /** The realtime unit spec of a tank (HUD names, groups). */
  unitSpec(tank: PlayerId): Readonly<RealtimeUnitSpec> | undefined { return this.units[tank]?.spec; }
  /** Seconds until a tank's main gun is ready (0 = ready) and its reload length. */
  reloadOf(tank: PlayerId): { remaining: number; total: number } {
    const unit = this.units[tank];
    return unit ? { remaining: Math.max(0, unit.ready - this.state.tick) * FIXED_DT, total: unit.reload * FIXED_DT } : { remaining: 0, total: 0 };
  }
  /** Coax heat in [0, 1] and whether it is cooling down from an overheat. */
  coaxOf(tank: PlayerId): { heat: number; overheated: boolean } { const unit = this.units[tank]; return { heat: unit?.heat ?? 0, overheated: unit?.overheated ?? false }; }
  abilities() { return { repairKits: this.repairKits, repairCost: this.crew.commander >= 5 ? .75 : 1,
    ultimate: this.crew.ultimate, used: this.ultimateUsed, charging: this.ultimatePending !== null }; }
  drainTerrainUpdates(): TerrainUpdate[] { return this.terrainUpdates.splice(0); }
  /** Presentation and campaign events since the last call. */
  drainRealtimeEvents(): RealtimeEvent[] { return this.realtime.splice(0); }
  pendingSerialCuts(): readonly CutRequest[] { return []; }
  completeLegacyCarve(): void {}
  aiTelemetry() { return { peakStepsPerTick: 0, budget: AIM_SOLVES_PER_TICK, decisions: this.decisions, lastDecisionTicks: 0 }; }
  timeline(): PlayerId[] { return []; }
  commandLog(): readonly unknown[] { return []; }
  dispose(): void {
    for (const commit of this.commits) this.world.transactions?.cancel(commit.ticket);
    this.nativeBallistics?.dispose();
    this.commits.length = 0; this.shells.length = 0;
  }
  /** Gameplay-state hash; the terrain/solver has its own checkpoint and verification. */
  matchHash(): string {
    return snapshotHash({ state: this.state, nextShot: this.nextShot, nextGeneration: this.nextGeneration, nextEnemySalvo: this.nextEnemySalvo,
      repairKits: this.repairKits, ultimateUsed: this.ultimateUsed, ultimatePending: this.ultimatePending,
      core: this.core.snapshot(), sightings: [...this.sightings].map(([team, contacts]) => [team, [...contacts]]), incoming: this.incoming,
      archived: [...this.archived], script: this.script?.checkpoint?.(),
      units: this.units.map(u => ({ spec: u.spec, ready: u.ready, coaxReady: u.coaxReady, heat: u.heat, overheated: u.overheated, order: u.order,
        revealed: u.revealed, stats: u.stats, impacts: u.impacts, random: u.rng.state, commanded: u.commanded ?? null })) });
  }

  interpolation(): SimInterpolation {
    const curr = this.poses();
    const running = !this.stall && this.state.phase !== 'finished' && this.previousPoses?.length === curr.length;
    return { alpha: running ? Math.min(1, this.accumulator / FIXED_DT) : 1, prev: running ? this.previousPoses! : curr, curr };
  }

  canFire(tank: PlayerId): boolean {
    const t = this.state.tanks[tank], unit = this.units[tank];
    const weaponDisabled = t?.components?.some(c => c.kind === 'weapon') && !t.components.some(c => c.kind === 'weapon' && c.health > 0);
    return !!t && !!unit && weaponOperational(t) && !weaponDisabled && !this.decided && !this.stall && !(tank === this.player && this.ultimatePending) && t.health > 0 && !unit.spec.coaxOnly && !unit.spec.unarmed
      && this.state.tick >= unit.ready && ammoBlock(t, t.munition ?? 'explosive', false) === null;
  }

  command(tank: PlayerId, c: PlayerCommand): boolean {
    // Prediction may change local aim presentation, never weapons, damage or mission state.
    if (this.isReplica && c.k !== 'aim' && c.k !== 'munition') return false;
    if (this.stall || this.decided || this.units[tank]?.brain) return false;
    const t = this.state.tanks[tank];
    if (!t || t.health <= 0) return false;
    switch (c.k) {
      case 'drive': this.humanDrive.set(tank, cleanDrive(c)); return true;
      case 'aim': return this.aim(t, c.yaw, c.pitch, c.power);
      case 'fire': return this.canFire(tank) && this.launch(tank);
      case 'munition': {
        if (!validMunition(c.id) || ammoBlock(t, c.id, false) === 'empty') return false;
        t.munition = c.id; return true;
      }
      case 'scan': return this.scan(tank);
      case 'utility': {
        if (this.script?.command?.(this.api, tank, c)) return true;
        if (c.id === 'headlights') { t.headlights = t.headlights === false; return true; }
        if (c.id === 'repair' && (t.health < (t.maxHealth ?? t.health) || t.machinery && Object.values(t.machinery).some(v => typeof v === 'number' && v < 1))) {
          const cost = this.crew.commander >= 5 ? .75 : 1, kit = this.repairKits > 0;
          if (!kit && t.charge < cost) return false;
          if (kit) this.repairKits--; else t.charge -= cost;
          this.api.heal(tank, (t.maxHealth ?? 100) * ((kit ? .4 : .3) + (this.crew.driver >= 2 ? .1 : 0))); return true;
        }
        if (c.id === 'ultimate') return this.beginUltimate(t);
        if (c.id === 'squad-follow' || c.id === 'squad-hold' || c.id === 'squad-rally') {
          for (const ally of this.state.tanks) if (ally.team === t.team && ally.id !== tank && ally.health > 0 && this.units[ally.id].spec.brain === 'ally')
            this.units[ally.id].commanded = c.id === 'squad-follow' ? undefined : c.id === 'squad-hold' ? null : [...t.position];
          return true;
        }
        return false;
      }
      default: return false;
    }
  }

  step(dt: number, drive: DriveInput = NO_DRIVE): GameEvent[] {
    if (this.isReplica) return [];
    if (this.state.phase === 'finished') { this.accumulator = 0; return this.pending.splice(0); }
    if (Number.isFinite(dt) && dt > 0) this.accumulator += Math.min(dt, FIXED_DT * MAX_TICKS_PER_STEP);
    const input = cleanDrive(drive);
    let steps = 0;
    for (;;) {
      if (!this.resolveCommits()) { this.accumulator = 0; this.stallFrames++; break; }
      this.settleEnding();
      if (this.finished) { this.accumulator = 0; break; }
      if (!(this.accumulator + 1e-10 >= FIXED_DT && steps++ < MAX_TICKS_PER_STEP)) break;
      this.accumulator = Math.max(0, this.accumulator - FIXED_DT);
      this.fixedStep(input);
    }
    return this.pending.splice(0);
  }

  previewPrediction(tank: PlayerId, full = true, collider?: AimTargetCollider): TrajectoryPrediction {
    const t = this.state.tanks[tank];
    if (!t) return { points: [], hit: false };
    const projectile = this.makeProjectile(t, -1), flight = flightOf(projectile), points: V3[] = [[...projectile.position]];
    const limit = full ? Math.ceil(this.rules.projectileAge / FIXED_DT) : 21;
    try {
    for (let step = 0; step < limit; step++) {
      const from = flight.position, hit = this.advance(flight, projectile);
      if (collider) {
        const delta = sub(flight.position, from), extent = length(delta);
        const at = extent > 1e-10 ? segmentSphere(from, mul(delta, 1 / extent), extent, collider.center, collider.radius) : null;
        if (at !== null && (!hit || at < hit.distance)) { points.push(add(from, mul(delta, at / extent))); return { points, hit: true, hitTarget: true }; }
      }
      if (hit) { points.push([...hit.point]); return { points, hit: true }; }
      if (step % 3 === 2) points.push(flight.position);
      if (this.expired(flight)) break;
    }
    return { points, hit: false };
    } finally { this.nativeBallistics?.release(flight); }
  }

  solveAimTarget(tank: PlayerId, selection: V3 | AimSelection, previous?: AimTargetAim): AimTargetResult {
    const target = Array.isArray(selection) ? selection : selection.point, collider = Array.isArray(selection) ? undefined : selection.object?.collider;
    const t = this.state.tanks[tank];
    if (!t || t.health <= 0) return invalidAimTarget(target);
    return this.solve(t, target, previous, collider, Math.ceil(this.rules.projectileAge / FIXED_DT), this.world.footprintSurface ?? this.world);
  }

  // ---- units ------------------------------------------------------------------------------------------------------------

  private readonly spawnEvents: RealtimeEvent[] = [];
  private spawn(spec: RealtimeUnitSpec, slot?: number): PlayerId | null {
    const recycled = slot !== undefined ? this.state.tanks[slot] : this.state.tanks.find(t => t.retired && !this.setup.online?.seats.includes(t.id) && !this.shells.some(s => s.projectile.owner === t.id));
    if (!recycled && this.state.tanks.length >= MAX_REALTIME_UNITS) return null;
    const ids = validateKitLoadout(spec.loadout), kit = assembleKit(ids), id = slot ?? recycled?.id ?? this.state.tanks.length;
    if (recycled) {
      const group = this.units[id].spec.group;
      if (group) { const list = this.archived.get(group) ?? []; list.push(structuredClone(recycled)); this.archived.set(group, list); }
      for (const known of this.sightings.values()) known.delete(id);
      this.core.forget(id);
    }
    const up = normalize(spec.spawn.up), surface = this.world.surface(up);
    const position = add(surface?.point ?? mul(up, this.world.radius), mul(up, ROOT_SURFACE_LIFT));
    if (spec.components !== undefined && (!validComponents(spec.components) || spec.components.some(c => c.health <= 0))) throw new Error('Invalid vehicle damage component');
    const lamp = spec.searchlight;
    if (lamp && (!Object.values(lamp).every(Number.isFinite) || lamp.height <= 0 || lamp.height > 20 || lamp.range <= 0 || lamp.range > 64
      || lamp.angle <= 0 || lamp.angle >= Math.PI / 2 || lamp.period < .1 || lamp.sweep < 0 || lamp.sweep > Math.PI)) throw new Error('Invalid searchlight');
    const components = spec.components?.map(c => ({ ...c, offset: [...c.offset] as V3 }));
    const health = components ? components.reduce((sum, c) => sum + c.health, 0) : (spec.maxHealth ?? kit.stats.hp) * (id === this.player && this.crew.driver >= 1 ? 1.15 : 1);
    const tank: TankState = {
      id, generation: this.nextGeneration++, visualKind: spec.visualKind, motionKind: spec.motionKind ?? 'chassis', position, rotation: rotation(up, spec.spawn.heading), velocity: [0, 0, 0], heading: spec.spawn.heading, turretYaw: 0, barrelPitch: 0.35, power: 0.55,
      health, ...(components ? { components } : {}), charge: 1, movement: kit.stats.fuel, recoil: 0, suspension: [0.5, 0.5, 0.5, 0.5], trackPhase: 0,
      trackPhases: [0, 0], trackSpeeds: [0, 0], trackGroundSpeeds: [0, 0], trackSlip: [0, 0], trackContact: [0, 0], yawVelocity: 0,
      wheelSuspension: Array(8).fill(0.5), treadContacts: Array(18).fill(-0.5), treadTerrain: [[], []],
      loadout: kitLoadoutToLegacy(ids), kit: { ...spec.loadout }, team: spec.team, readyAt: 0, maxHealth: health,
      ...(spec.name !== undefined ? { name: spec.name } : {}), ammo: initialAmmo(this.rules),
    };
    const brain = spec.brain ? createRealtimeBrain(spec.brain) : null;
    const reloadScale = (id === this.player ? (this.crew.gunner >= 1 ? .9 : 1) * (this.crew.gunner >= 5 ? .85 : 1) * (this.crew.gadgets.includes('lucky-cog') ? .92 : 1) : spec.team === this.state.tanks[this.player]?.team && this.crew.commander >= 2 ? .8 : 1)
      * clamp(spec.reloadScale ?? 1, 0.25, 4);
    this.units[id] = { spec: { ...spec }, brain, kit, reload: Math.ceil(reloadTicks(kit) * reloadScale), rng: stream((this.setup.seed ^ Math.imul(id + 1, 0x9e3779b1)) >>> 0),
      ready: this.state.tick, coaxReady: this.state.tick, heat: 0, overheated: false, order: HOLD, revealed: !!spec.revealed,
      stats: { shots: 0, hits: 0, kills: 0, damageTaken: 0, lastHitTick: -1 }, impacts: [] };
    this.state.tanks[id] = tank;
    this.state.contacts[id] = null;
    if (recycled) { for (const row of this.state.observations!) row[id] = null; }
    else for (const row of this.state.observations!) row.push(null);
    this.state.observations![id] = this.state.tanks.map(() => null);
    if (recycled && tank.motionKind === 'chassis') this.world.relocateTank?.(tank);
    this.spawnEvents.push({ type: 'spawn', tank: id });
    return id;
  }

  private poses(): TankPose[] {
    return this.state.tanks.map(t => ({ position: [...t.position], rotation: [...t.rotation], turretYaw: t.turretYaw, barrelPitch: t.barrelPitch }));
  }

  private aim(tank: TankState, yaw: number, pitch: number, power: number): boolean {
    if (![yaw, pitch, power].every(Number.isFinite)) return false;
    tank.turretYaw = wrapAngle(yaw);
    const limits = this.units[tank.id].kit.pitchLimits(tank.turretYaw);
    tank.barrelPitch = clamp(pitch, limits.min, limits.max);
    tank.power = clamp(power, 0, 1);
    return true;
  }

  private scan(tank: PlayerId): boolean {
    const scanner = this.state.tanks[tank];
    if (scanner.charge < this.rules.radarCost) return false;
    scanner.charge -= this.rules.radarCost;
    const known = this.teamSightings(scanner.team ?? -1);
    for (const enemy of this.state.tanks) {
      if (enemy.team === scanner.team || enemy.health <= 0 || distance(enemy.position, scanner.position) > SCAN_RANGE) continue;
      const seen = known.get(enemy.id);
      if (!seen?.visible) known.set(enemy.id, { position: [...enemy.position], velocity: [0, 0, 0], time: this.state.time, visible: false });
    }
    this.publishObservations();
    this.pending.push({ type: 'scan', tank, position: [...scanner.position] });
    return true;
  }

  // ---- the tick -------------------------------------------------------------------------------------------------------

  private fixedStep(drive: DriveInput): void {
    this.previousPoses = this.poses();
    this.state.tick++; this.state.time = this.state.tick * FIXED_DT; this.state.phaseTime += FIXED_DT;
    this.solvesLeft = AIM_SOLVES_PER_TICK;
    if (this.rules.wind) this.state.wind = this.windAt(this.state.tick);
    const tanks = this.state.tanks, before = this.previousPoses;
    const inputs: DriveInput[] = tanks.map(tank => this.inputOf(tank, drive));
    if (this.world.stepTanks) this.world.stepTanks(tanks.filter(t => !t.retired && t.motionKind !== 'swarm' && t.motionKind !== 'air'), inputs, FIXED_DT);
    else this.world.fixedStep?.();
    for (const tank of tanks) {
      if (tank.retired) continue;
      if (tank.health <= 0 && tank.destroyedAt !== undefined && this.state.tick - tank.destroyedAt >= WRECK_LIFETIME_TICKS && tank.id !== this.player) {
        tank.retired = true; this.world.removeTank?.(tank.id); continue;
      }
      if (tank.motionKind === 'swarm' || tank.motionKind === 'air') this.stepLightweight(tank, inputs[tank.id]);
      // Keep each turret's aim fixed on the planet while its hull turns and tilts underneath.
      if (tank.health > 0) tank.turretYaw = holdPlanetBearing(before[tank.id], tank, tank.turretYaw);
      if (tank.motionKind !== 'air' && (tank.motionKind !== 'swarm' || this.state.tick % 6 === tank.id % 6)) {
        const profile = this.treadProfile(tank);
        tank.treadContacts = [...profile.heights]; tank.treadTerrain = profile.terrain;
      }
      tank.charge = Math.min(MAX_SCAN_CHARGE, tank.charge + SCAN_REGEN * FIXED_DT * (tank.id === this.player && this.crew.driver >= 5 ? 1.5 : 1));
      if (this.crew.commander >= 4 && tank.id !== this.player && tank.team === tanks[this.player].team && distance(tank.position, tanks[this.player].position) < 5) this.api.heal(tank.id, FIXED_DT);
      const supportRepair = this.units[tank.id].spec.supportRepair ?? 0;
      if (supportRepair > 0 && tank.health > 0) for (const ally of tanks) {
        if (ally.id !== tank.id && ally.team === tank.team && ally.health > 0 && distance(ally.position, tank.position) < 6) this.api.heal(ally.id, supportRepair * FIXED_DT);
      }
      if (length(tank.position) < this.world.radius * 0.25 && tank.health > 0) this.kill(tank, null, 'fall');
    }
    if (!this.ending) {
      this.stepUltimate();
      this.stepShells();
      this.think();
      this.stepCoax();
    }
    if (this.state.tick % 6 === 0) this.updateSight();
    this.stepSearchlights();
    this.flushIncoming();
    if (!this.ending) this.script ? this.script.tick(this.api) : this.defaultResult();
    this.settleEnding();
    this.realtime.push(...this.spawnEvents.splice(0));
    if (this.script?.onEvent) for (const event of this.pending) this.script.onEvent(this.api, event);
  }

  private inputOf(tank: TankState, drive: DriveInput): DriveInput {
    const unit = this.units[tank.id];
    if (tank.health <= 0 || unit.spec.immobile || this.decided) return NO_DRIVE;
    const command = !unit.brain ? this.humanDrive.get(tank.id) ?? (tank.id === this.state.active ? drive : NO_DRIVE)
      : this.core.steer(tank, unit.commanded !== undefined ? unit.commanded : unit.order.goal, unit.commanded !== undefined ? false : unit.order.reverse);
    const input = damagedDrive(tank, { throttle: command.throttle * clamp(unit.spec.driveScale ?? 1, 0, 1), steer: command.steer });
    const drives = tank.components?.filter(c => c.kind === 'drive');
    if (!drives?.length) return input;
    const working = drives.filter(c => c.health > 0).length;
    return working ? { throttle: input.throttle * (.2 + .8 * working / drives.length), steer: input.steer } : NO_DRIVE;
  }

  private stepSearchlights(): void {
    const player = this.state.tanks[this.player]; let exposure = 0, active = false;
    for (const tower of this.state.tanks) {
      const light = this.units[tower.id].spec.searchlight; if (!light) continue;
      active = true;
      if (tower.health <= 0 || (tower.machinery?.engine ?? 1) <= MODULE_DISABLED || !weaponOperational(tower)) { tower.searchlight = undefined; continue; }
      const yaw = Math.sin(this.state.time * Math.PI * 2 / light.period + tower.id) * light.sweep;
      tower.turretYaw = yaw;
      const pitch = SEARCHLIGHT_MOUNT.pitch;
      const direction = rotate([Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)], tower.rotation);
      const origin = add(add(tower.position, rotate([0, light.height, 0], tower.rotation)), mul(direction, SEARCHLIGHT_MOUNT.lens));
      tower.searchlight = { origin, direction, range: light.range, angle: light.angle };
      if (this.state.tick % 6 !== 0) continue;
      const target = add(player.position, mul(normalize(player.position), .2));
      const strength = this.core.exposure(origin, direction, target, light.range, light.angle, player.headlights !== false);
      if (strength > 0 && !this.blocked(origin, normalize(sub(target, origin)), distance(origin, target))) exposure = Math.max(exposure, strength);
    }
    if (active && this.state.tick % 6 === 0) player.detection = clamp((player.detection ?? 0) + (exposure || -.3) * .1, 0, 1);
  }

  private stepLightweight(tank: TankState, input: DriveInput): void {
    if (tank.health <= 0) return;
    const unit = this.units[tank.id], air = tank.motionKind === 'air';
    const up = normalize(tank.position);
    tank.heading = wrapAngle(tank.heading - input.steer * 2.1 * FIXED_DT);
    const forward = rotate([0, 0, 1], rotation(up, tank.heading));
    const speed = (air ? 4.5 : unit.kit.stats.speed) * input.throttle;
    const targetRadius = length(this.world.surface(up)?.point ?? mul(up, this.world.radius)) + (air ? unit.spec.altitude ?? 3.5 : ROOT_SURFACE_LIFT);
    const proposed = this.core.move(tank, forward, speed, targetRadius, this.gravity, this.state.tanks);
    const delta = sub(proposed, tank.position), extent = length(delta);
    const blocked = extent > 0 ? this.world.sweepSphere?.(tank.position, normalize(delta), extent, 0.3) : null;
    const candidate = add(tank.position, blocked != null ? mul(normalize(delta), Math.max(0, blocked - 0.03)) : delta);
    const next = normalize(candidate), ground = this.world.surface(next)?.point;
    if (!ground) return;
    const target = add(ground, mul(next, air ? unit.spec.altitude ?? 3.5 : ROOT_SURFACE_LIFT));
    // Lift/hover response is acceleration-limited; do not teleport the craft to a new height.
    const position = air ? candidate : target;
    tank.velocity = mul(sub(position, tank.position), 1 / FIXED_DT); tank.position = position;
    const transported = normalize(sub(forward, mul(next, dot(forward, next)))), axes = frame(next, 0);
    tank.heading = Math.atan2(dot(transported, axes.right), dot(transported, axes.forward));
    tank.rotation = rotation(next, tank.heading);
    tank.trackSpeeds = [speed, speed]; tank.trackPhases = tank.trackPhases.map(p => p + speed * FIXED_DT) as [number, number];
  }

  private beginUltimate(tank: TankState): boolean {
    const kind = this.crew.ultimate;
    if (!kind || this.ultimateUsed || tank.charge < 3 || !this.canFire(tank.id)) return false;
    let point = [...tank.position] as V3;
    if (kind === 'lance') {
      const visible = this.state.tanks.filter(t => t.team !== tank.team && t.health > 0 && this.teamSightings(tank.team ?? 0).get(t.id)?.visible)
        .sort((a, b) => distance(tank.position, a.position) - distance(tank.position, b.position));
      if (!visible.length) return false;
      point = [...visible[0].position];
    }
    this.ultimateUsed = true; tank.charge -= 3;
    this.ultimatePending = { kind, point, at: this.state.tick + 180 };
    this.realtime.push({ type: 'banner', title: kind === 'nuclear' ? 'NUCLEAR SHELL · 3 SECONDS' : kind === 'hammer' ? 'FORGE HAMMER · 3 SECONDS' : 'ORBITAL LANCE · 3 SECONDS', subtitle: kind === 'nuclear' ? 'Hold your aim. Keep clear of the impact.' : 'Strike position locked. Clear the marked area.' });
    if (kind !== 'nuclear') this.pending.push({ type: 'incoming', tank: tank.id, predicted: point, impactTick: this.ultimatePending.at });
    return true;
  }

  private stepUltimate(): void {
    const strike = this.ultimatePending;
    if (!strike || this.state.tick < strike.at) return;
    this.ultimatePending = null;
    const own = this.state.tanks[this.player]; if (own.health <= 0) return;
    if (strike.kind === 'nuclear') {
      const previous = own.munition; own.munition = 'nuclear'; own.ammo ??= {}; own.ammo.nuclear = 1; own.charge += 3;
      this.launch(this.player); own.munition = previous; return;
    }
    const up = normalize(strike.point), point = strike.kind === 'hammer' ? this.surfacePoint(up) : strike.point;
    if (strike.kind === 'hammer') {
      const projectile = { ...this.makeProjectile(own, this.nextShot++), munition: 'heavy' as const, position: point };
      this.impact({ projectile, flight: flightOf(projectile) }, projectile, { point, normal: up, distance: 0, material: 1 }, null);
    } else {
      for (const enemy of this.state.tanks) if (enemy.team !== own.team && enemy.health > 0) {
        const d = distance(enemy.position, point); if (d > 4) continue;
        this.api.damage(enemy.id, 180 * (1 - d / 4), 'orbital-lance');
        if (enemy.health <= 0) this.units[this.player].stats.kills++;
      }
      this.realtime.push({ type: 'tracer', owner: this.player, from: add(point, mul(up, 12)), to: point, victim: null });
      this.pending.push({ type: 'impact', position: point, normal: up, radius: 2, owner: this.player, munition: 'incendiary', noCrater: true });
    }
  }

  /** Versus matches eliminate teams; an unscripted campaign ends when the player or every enemy is down. */
  private defaultResult(): void {
    if (this.setup.online || this.setup.mode === 'skirmish') {
      const alive = new Set(this.state.tanks.filter(t => t.health > 0).map(t => t.team));
      if (alive.size <= 1) this.finish(alive.size ? [...alive][0] ?? null : null);
      return;
    }
    const player = this.state.tanks[this.player], enemies = this.state.tanks.filter(t => t.team !== player.team);
    if (player.health <= 0) { this.finish(enemies.find(t => t.health > 0)?.team ?? null, 'destroyed'); return; }
    if (enemies.length && !enemies.some(t => t.health > 0)) this.finish(player.team ?? 0);
  }

  /** Decide the result. Shells still in flight are dropped; the match keeps ticking (no input, brains or script)
   * until the terrain edits already due have committed, so the last crater lands before the result. */
  private finish(team: number | null, reason?: string): void {
    if (this.ending || this.finished) return;
    this.ending = { team, ...(reason ? { reason } : {}) };
    for (const shell of this.shells) this.nativeBallistics?.release(shell.flight);
    this.shells.length = 0; this.state.projectiles = []; this.incoming.length = 0;
    this.settleEnding();
  }
  private ending: { team: number | null; reason?: string } | null = null;
  private settleEnding(): void {
    if (!this.ending || this.commits.length || this.finished) return;
    const { team, reason } = this.ending;
    this.state.phase = 'finished';
    this.state.winnerTeam = team;
    this.state.winner = team === null ? null : this.state.tanks.find(t => t.team === team && t.health > 0)?.id ?? null;
    const won = team !== null && team === this.state.tanks[this.player].team;
    this.realtime.push({ type: 'mission', status: won ? 'won' : 'failed', ...(reason ? { reason } : {}) });
    this.pending.push({ type: 'finish', winner: this.state.winner, team });
  }
  /** A result is decided (the match may still be committing its last terrain edits). */
  get decided(): boolean { return this.ending !== null || this.finished; }

  // ---- brains -----------------------------------------------------------------------------------------------------------

  private think(): void {
    const list = this.state.tanks, start = Math.floor(this.state.tick / DECISION_INTERVAL_TICKS) % list.length;
    for (let i = 0; i < list.length; i++) {
      const tank = list[(start + i) % list.length];
      const unit = this.units[tank.id];
      if (!unit.brain || tank.health <= 0) continue;
      if ((this.state.tick + tank.id) % DECISION_INTERVAL_TICKS === 0) {
        unit.order = this.core.decide(unit.spec.brain!, this.brainView(tank, unit));
        this.decisions++;
        if (unit.order.aim) this.aim(tank, unit.order.aim.yaw, unit.order.aim.pitch, unit.order.aim.power);
        if (unit.order.fire && this.canFire(tank.id)) {
          const enemy = tank.team !== this.state.tanks[this.player].team;
          if (!enemy || unit.spec.noCrater || this.state.tick >= this.nextEnemySalvo) {
            this.launch(tank.id);
            if (enemy && !unit.spec.noCrater) this.nextEnemySalvo = this.state.tick + (unit.spec.brain === 'tosser' ? 120 : 40);
          }
        }
      }
      // Face the turret toward the order's point (the coax engages inside its arc) unless a fresh aim holds it.
      const face = unit.order.face;
      if (face && !unit.order.aim) {
        const delta = sub(face, tank.position);
        const desired = Math.atan2(dot(delta, rotate([1, 0, 0], tank.rotation)), dot(delta, rotate([0, 0, 1], tank.rotation)));
        tank.turretYaw = wrapAngle(tank.turretYaw + clamp(wrapAngle(desired - tank.turretYaw), -2.4 * FIXED_DT, 2.4 * FIXED_DT));
      }
    }
  }

  private brainView(tank: TankState, unit: Unit): BrainView {
    const known = this.teamSightings(tank.team ?? -1), enemies: KnownEnemy[] = [];
    for (const [id, seen] of known) {
      const enemy = this.state.tanks[id];
      if (enemy.health <= 0) continue;
      const age = seen.visible ? 0 : this.state.time - seen.time;
      const friendly = tank.team === this.state.tanks[this.player].team;
      const memory = friendly ? LAST_KNOWN_SECONDS * (this.crew.commander >= 1 ? 1.5 : 1) + (this.crew.gadgets.includes('mags-compass') ? 3 : 0) : LAST_KNOWN_SECONDS;
      if (age > memory) continue;
      enemies.push({ id, position: seen.visible ? [...enemy.position] : [...seen.position], visible: seen.visible, velocity: seen.visible ? seen.velocity : [0, 0, 0], age });
    }
    enemies.sort((a, b) => distance(a.position, tank.position) - distance(b.position, tank.position) || a.id - b.id);
    const leader = this.state.tanks[this.player], match = this;
    return {
      tick: this.state.tick, self: tank, radius: this.world.radius, enemies,
      leader: leader && leader.health > 0 && leader.team === tank.team && leader.id !== tank.id ? leader : null,
      reloadReady: this.canFire(tank.id), waypoints: (unit.spec.waypoints ?? []).map(up => this.surfacePoint(up)),
      tuning: DIFFICULTY[unit.spec.difficulty ?? this.difficulty], random: unit.rng,
      solve(target: V3, lob: boolean) {
        if (match.solvesLeft <= 0) return null;
        match.solvesLeft--;
        const bearing = Math.atan2(dot(sub(target, tank.position), rotate([1, 0, 0], tank.rotation)), dot(sub(target, tank.position), rotate([0, 0, 1], tank.rotation)));
        const result = match.solve(tank, target, lob ? { yaw: bearing, pitch: 1.1, power: 0.6 } : undefined, undefined, BRAIN_TRACE_STEPS, match.world);
        return result.aim && (result.status === 'ready' || result.error < 2.5) ? result.aim : null;
      },
    };
  }

  private surfacePoint(up: V3): V3 { const direction = normalize(up); return this.world.surface(direction)?.point ?? mul(direction, this.world.radius); }

  // ---- main gun ---------------------------------------------------------------------------------------------------------

  private launch(id: PlayerId, aimOverride?: AimTargetAim): boolean {
    const tank = this.state.tanks[id], unit = this.units[id];
    if (!weaponOperational(tank)) return false;
    if (aimOverride) this.aim(tank, aimOverride.yaw, aimOverride.pitch, aimOverride.power);
    const munition = tank.munition ?? 'explosive';
    spendAmmo(tank, munition, false);
    const projectile = this.makeProjectile(tank, this.nextShot++);
    unit.ready = this.state.tick + unit.reload;
    unit.stats.shots++;
    tank.recoil = unit.kit.stats.recoil;
    tank.velocity = sub(tank.velocity, mul(normalize(projectile.velocity), unit.kit.stats.recoil * 5 / unit.kit.stats.mass));
    const shell: Shell = { projectile, flight: flightOf(projectile) };
    this.shells.push(shell);
    this.state.projectiles = this.shells.map(s => s.projectile);
    const weapon = unit.kit.loadout.weapon;
    this.pending.push({ type: 'shot', player: id, launch: {
      id: projectile.id, tick: this.state.tick, munition, weapon: weapon === 'rail' ? 'rail' : weapon === 'cannon' ? 'cannon' : 'mortar',
      power: tank.power, position: [...projectile.position], direction: normalize(projectile.velocity), up: normalize(projectile.position),
    } });
    this.pretrace(shell);
    return true;
  }

  /** A scripted shot at a surface point (instructor salvos). Uses the unit's gun, reload and the normal shell path. */
  private scriptedShot(id: PlayerId, target: V3, lob: boolean): boolean {
    const tank = this.state.tanks[id];
    if (!tank || tank.health <= 0 || this.decided) return false;
    const bearing = Math.atan2(dot(sub(target, tank.position), rotate([1, 0, 0], tank.rotation)), dot(sub(target, tank.position), rotate([0, 0, 1], tank.rotation)));
    const result = this.solve(tank, target, lob ? { yaw: bearing, pitch: 1.1, power: 0.6 } : undefined, undefined, Math.ceil(this.rules.projectileAge / FIXED_DT), this.world);
    if (!result.aim) return false;
    return this.launch(id, result.aim);
  }

  private makeProjectile(tank: TankState, id: number): ProjectileState {
    const socket = this.muzzleFor(tank), kit = this.units[tank.id].kit;
    return { id, owner: tank.id, position: socket.position, velocity: mul(socket.direction, munitionSpeed(kit, tank.power, tank.munition)), age: 0,
      munition: tank.munition ?? 'explosive', launchTick: this.state.tick, origin: [...socket.position], peakAltitude: length(socket.position) - this.world.radius };
  }

  private muzzleFor(tank: Pick<TankState, 'id' | 'position' | 'rotation' | 'turretYaw' | 'barrelPitch'>): { position: V3; direction: V3 } {
    const up = rotate([0, 1, 0], tank.rotation);
    const forward = rotate([Math.sin(tank.turretYaw), 0, Math.cos(tank.turretYaw)], tank.rotation);
    const direction = normalize(add(mul(forward, Math.cos(tank.barrelPitch)), mul(up, Math.sin(tank.barrelPitch))));
    const kit = this.units[tank.id].kit, trunnion = kitTrunnionPivot(kit);
    const pivot = add(add(tank.position, rotate(trunnion.axisPoint, tank.rotation)), mul(forward, trunnion.forward));
    return { position: add(pivot, mul(direction, kit.weapon.barrelLength)), direction };
  }

  private ballistics(owner: PlayerId, munition: MunitionId | undefined): BallisticEnv {
    if (!this.rules.wind) return this.stillAir ??= { gravity: this.gravity, wind: null, windFactor: 0, water: this.water };
    return { gravity: this.gravity, water: this.water, wind: tick => this.windAt(tick)!, windFactor: windFactor(this.units[owner].kit, munition) };
  }
  private windAt(tick: number): WindState | null {
    if (!this.rules.wind) return null;
    if (this.windCache?.tick !== tick) this.windCache = sampleWind(this.windSeed, tick, this.rules.wind);
    return this.windCache;
  }
  private expired(flight: Flight): boolean { return flight.age + 1e-9 >= this.rules.projectileAge || length(flight.position) > this.world.radius * 5; }

  /** One integration step of a flight against the terrain only (previews, pre-traces and aim traces). */
  private advance(flight: Flight, launch: ProjectileState, world: WorldQuery = this.world): TerrainHit | null {
    const from = flight.position;
    if (flight.age === 0) {
      const direction = normalize([flight.vx, flight.vy, flight.vz]), barrel = this.units[launch.owner].kit.weapon.barrelLength;
      const blocked = world.raycast(sub(from, mul(direction, barrel)), direction, barrel);
      if (blocked) return blocked;
    }
    if (this.nativeBallistics) {
      const query = world.ballisticQuery?.();
      const result = this.nativeBallistics.advance(flight, this.units[launch.owner].kit.weapon.barrelLength, this.rules.wind ? windFactor(this.units[launch.owner].kit, launch.munition) : 0, query);
      if (query) return result.hit;
    } else advanceFlight(flight, this.ballistics(launch.owner, launch.munition));
    const delta = sub(flight.position, from), extent = length(delta);
    return extent > 1e-10 ? world.raycast(from, mul(delta, 1 / extent), extent) : null;
  }

  /** Bounded aim solve on the shared integrator (player ground aim, brains, scripted salvos). */
  private solve(tank: TankState, target: V3, previous: AimTargetAim | undefined, collider: AimTargetCollider | undefined, maxSteps: number, world: WorldQuery): AimTargetResult {
    const kit = this.units[tank.id].kit;
    return solveAimTarget({ position: tank.position, rotation: tank.rotation, gravity: this.gravity, collider,
      speed: power => munitionSpeed(kit, power, tank.munition), limits: yaw => kit.pitchLimits(yaw),
      muzzle: aim => this.muzzleFor({ ...tank, turretYaw: aim.yaw, barrelPitch: aim.pitch }).position,
      trace: (aim, budget) => {
        const projectile = this.makeProjectile({ ...tank, turretYaw: aim.yaw, barrelPitch: aim.pitch, power: aim.power }, -1), flight = flightOf(projectile);
        const limit = Math.min(budget, maxSteps);
        let nearest = projectile.position, nearestDistance = collider ? distance(nearest, target) : Infinity, contact: V3 | null = null;
        try {
        for (let step = 0; step < limit; step++) {
          const from = flight.position, hit = this.advance(flight, projectile, world);
          if (collider) {
            const delta = sub(hit?.point ?? flight.position, from), squared = dot(delta, delta);
            const at = squared > 1e-10 ? clamp(dot(sub(target, from), delta) / squared, 0, 1) : 0, point = add(from, mul(delta, at));
            if (distance(point, target) < nearestDistance) { nearest = point; nearestDistance = distance(point, target); }
            if (!contact && squared > 1e-10) {
              const extent = Math.sqrt(squared), direction = mul(delta, 1 / extent), t = segmentSphere(from, direction, extent, collider.center, collider.radius);
              if (t !== null) contact = add(from, mul(direction, t));
            }
          }
          if (hit) return { point: contact ?? hit.point, hit: true, hitTarget: contact !== null, nearest, steps: step + 1 };
          if (this.expired(flight)) return { point: contact ?? flight.position, hit: contact !== null, hitTarget: contact !== null, nearest, steps: step + 1 };
        }
        return { point: contact ?? flight.position, hit: contact !== null, hitTarget: contact !== null, nearest, steps: limit };
        } finally { this.nativeBallistics?.release(flight); }
      },
    }, target, previous);
  }

  /** At launch: trace the shell on the committed terrain (no tanks) to warn the tanks it is predicted to land near. A tank
   * that moves away is not hit. No crater is prepared speculatively: the resident preparer works one edit at a time, and
   * a later shell landing first would queue behind an earlier one that has not landed yet. */
  private pretrace(shell: Shell): void {
    const projectile = shell.projectile, flight = flightOf(projectile);
    try {
    for (let step = 0; step < Math.ceil(this.rules.projectileAge / FIXED_DT) + 1; step++) {
      const hit = this.advance(flight, projectile);
      if (hit) {
        const impactTick = this.state.tick + 1 + step;
        const owner = this.state.tanks[projectile.owner], lead = Math.round(DIFFICULTY[this.difficulty].ringLeadSeconds / FIXED_DT);
        for (const tank of this.state.tanks) {
          if (tank.health <= 0 || tank.team === owner.team || distance(tank.position, hit.point) > INCOMING_RADIUS) continue;
          this.incoming.push({ tank: tank.id, impactTick, predicted: [...hit.point], at: Math.max(this.state.tick, impactTick - lead) });
        }
        return;
      }
      if (this.expired(flight)) return;
    }
    } finally { this.nativeBallistics?.release(flight); }
  }

  private flushIncoming(): void {
    if (!this.incoming.length) return;
    const due = this.incoming.filter(entry => entry.at <= this.state.tick);
    if (!due.length) return;
    this.incoming = this.incoming.filter(entry => entry.at > this.state.tick);
    for (const entry of due) this.pending.push({ type: 'incoming', tank: entry.tank, impactTick: entry.impactTick, predicted: entry.predicted });
  }

  private stepShells(): void {
    if (!this.shells.length) return;
    const survivors: Shell[] = [];
    for (const shell of this.shells) {
      const projectile = shell.projectile, flight = shell.flight;
      // A shell fired during this tick takes its first step in the next one.
      if ((projectile.launchTick ?? 0) >= this.state.tick) { survivors.push(shell); continue; }
      const from = flight.position, age = flight.age;
      let hit = this.advance(flight, projectile), victim: PlayerId | null = null, component = -1;
      const delta = sub(flight.position, from), extent = length(delta);
      if (extent > 1e-10) {
        const direction = mul(delta, 1 / extent);
        const collider = this.core.sweep(from, direction, Math.min(extent, hit?.distance ?? extent), this.state.tanks, age < .3 ? projectile.owner : null);
        if (collider) {
          const tank = this.state.tanks[collider.tank], center = collider.component < 0 ? tank.position : componentPoint(tank, tank.components![collider.component]);
          const point = add(from, mul(direction, collider.distance));
          hit = { point, normal: normalize(sub(point, center)), distance: collider.distance, material: 0 }; victim = tank.id; component = collider.component;
        }
      }
      const next: ProjectileState = { ...projectile, position: flight.position, velocity: [flight.vx, flight.vy, flight.vz], age: flight.age,
        peakAltitude: Math.max(projectile.peakAltitude ?? -Infinity, length(flight.position) - this.world.radius) };
      shell.projectile = next;
      if (hit) { this.impact(shell, next, hit, victim, component); this.nativeBallistics?.release(flight); continue; }
      if (this.expired(flight)) { this.nativeBallistics?.release(flight); continue; }
      survivors.push(shell);
    }
    this.shells.length = 0; this.shells.push(...survivors);
    this.state.projectiles = this.shells.map(s => s.projectile);
  }

  private crater(tick: number, projectile: ProjectileState, hit: TerrainHit): CutRequest {
    const radius = munitionStats(this.units[projectile.owner].kit, projectile.munition).radius;
    const profile: { center: V3; radius: number; shells?: CraterShell[] } = this.world.materialCraters ? materialCrater(hit.point, hit.normal, radius, projectile.munition) : craterProfile(hit.point, hit.normal, radius);
    return { id: `${tick}:${projectile.id}:0`, center: profile.center, radius: profile.radius, ...(profile.shells ? { shells: profile.shells } : {}) };
  }

  private impact(shell: Shell, projectile: ProjectileState, hit: TerrainHit, direct: PlayerId | null, component = -1): void {
    const owner = this.units[projectile.owner], shooter = this.state.tanks[projectile.owner];
    const stats = munitionStats(owner.kit, projectile.munition), scale = owner.spec.damageScale ?? 1;
    const hits: NonNullable<ImpactEvent['hits']> = [], kills: TankState[] = [];
    for (const tank of this.state.tanks) {
      const exposureRaw = direct === tank.id ? 1 : clamp(1 - distance(hit.point, tank.position) / (stats.radius * 1.65 + TANK_TARGET_RADIUS), 0, 1);
      if (exposureRaw <= 0) continue;
      let exposure = exposureRaw;
      const start = add(hit.point, mul(hit.normal, 0.08));
      if (direct !== tank.id && this.blocked(start, normalize(sub(tank.position, start)), Math.max(0, distance(start, tank.position) - TANK_TARGET_RADIUS))) exposure *= 0.35;
      const kit = this.units[tank.id].kit;
      const spared = !this.rules.friendlyFire && tank.team === shooter.team && tank.id !== shooter.id;
      const before = tank.health;
      const protection = armorResponse(tank, kit, { point: hit.point, direct: direct === tank.id, weapon: owner.kit.loadout.weapon, munition: projectile.munition ?? 'explosive' });
      if (!spared && before > 0) {
        // Your own blast still hurts, at half strength: close fights stay risky without being suicidal.
        const self = tank.id === shooter.id ? SELF_DAMAGE * (tank.id === this.player && this.crew.driver >= 3 ? .5 : 1) : 1;
        const outgoing = projectile.owner === this.player && this.crew.gunner >= 3 ? 1.1 : 1;
        const incoming = tank.id === this.player ? (this.crew.driver >= 4 ? .85 : 1) * (this.crew.gadgets.includes('branns-rivets') && protection.section === 'front' ? .85 : 1) : 1;
        const damage = Math.max(1, Math.round(stats.damage * scale * self * exposure * protection.multiplier * outgoing * incoming));
        tank.health = tank.components ? this.core.damageComponents(tank, hit.point, stats.damage * scale * outgoing * self, stats.radius, direct === tank.id ? component : -1)
          : Math.max(0, tank.health - damage);
        damageVehicle(tank, hit.point, before - tank.health, direct === tank.id);
        if (tank.motionKind === 'air' && (tank.machinery?.engine ?? 1) <= MODULE_DISABLED) tank.motionKind = 'chassis';
        if (protection.reactiveSpent) tank.reactiveArmor = ((tank.reactiveArmor ?? 0) | protection.reactiveSpent) & 15;
        this.units[tank.id].stats.damageTaken += before - tank.health; this.units[tank.id].stats.lastHitTick = this.state.tick;
        if (tank.team !== shooter.team) owner.stats.hits++;
      }
      tank.velocity = add(tank.velocity, mul(normalize(sub(tank.position, hit.point)), exposure * 25 / kit.stats.mass));
      hits.push({ tank: tank.id, damage: before - tank.health, exposure, direct: direct === tank.id, lethal: before > 0 && tank.health === 0,
        armorSection: protection.section, ...(!spared && protection.reactiveSpent ? { reactiveSpent: protection.reactiveSpent } : {}) });
      if (before > 0 && tank.health === 0) kills.push(tank);
    }
    const tick = this.state.tick, cut = this.crater(tick, projectile, hit), transactions = this.world.transactions;
    let commitTick = tick;
    if (transactions && !owner.spec.noCrater) {
      commitTick = tick + this.rules.commitWindowTicks;
      const ticket = transactions.prepare([cut], commitTick);
      transactions.freezeBodies(cutBounds(cut), commitTick);
      this.commits.push({ ticket, commitTick, cuts: [cut] });
      this.commits.sort((a, b) => a.commitTick - b.commitTick);
    }
    owner.impacts.push([...hit.point]); if (owner.impacts.length > 8) owner.impacts.shift();
    const flight = flightStats(projectile.origin ?? projectile.position, hit.point, Math.round(projectile.age / FIXED_DT) + 1,
      Math.max(projectile.peakAltitude ?? -Infinity, length(hit.point) - this.world.radius), this.world.radius);
    this.pending.push({ type: 'impact', position: [...hit.point], normal: [...hit.normal], radius: stats.radius, owner: projectile.owner,
      munition: projectile.munition ?? 'explosive', commitTick, ...(owner.spec.noCrater ? { noCrater: true } : { cut }), hits, flight });
    for (const tank of kills) this.kill(tank, projectile.owner, direct === tank.id ? 'direct' : 'blast', true);
  }

  /** `already`: health is 0 already (the impact applied it). */
  private kill(tank: TankState, by: PlayerId | null, cause: string, already = false): void {
    if (!already) { if (tank.health <= 0) return; tank.health = 0; }
    if (by !== null && this.state.tanks[by].team !== tank.team) this.units[by].stats.kills++;
    tank.destroyedAt = this.state.tick;
    tank.motionKind = 'chassis';
    tank.trackSpeeds = [0, 0];
    this.pending.push({ type: 'kill', tank: tank.id, by, cause });
  }

  // ---- coax ---------------------------------------------------------------------------------------------------------

  private stepCoax(): void {
    if (this.rules.autoCoax === false) return;
    for (const tank of this.state.tanks) {
      const unit = this.units[tank.id];
      unit.heat = Math.max(0, unit.heat - COAX.cooling * FIXED_DT);
      if (unit.overheated && unit.heat <= COAX.resume) unit.overheated = false;
      if (tank.health <= 0 || !weaponOperational(tank) || unit.spec.unarmed || unit.overheated || this.state.tick < unit.coaxReady) continue;
      const target = this.coaxTarget(tank, unit);
      if (!target) continue;
      const from = this.coaxOrigin(tank), to = add(target.position, mul(normalize(target.position), 0.45));
      unit.coaxReady = this.state.tick + COAX.intervalTicks;
      unit.heat += COAX.heatPerRound * (tank.id === this.player && this.crew.gunner >= 2 ? .8 : 1);
      if (unit.heat >= 1) unit.overheated = true;
      const kit = this.units[target.id].kit, before = target.health, scale = unit.spec.damageScale ?? 1;
      target.health = Math.max(0, target.health - Math.max(1, Math.round(COAX.damage * scale * (1 - kit.stats.mitigation * 0.5) * (tank.id === this.player && this.crew.gunner >= 4 ? 1.5 : 1) * (target.id === this.player && this.crew.driver >= 4 ? .85 : 1))));
      damageVehicle(target, to, (before - target.health) * .3, true);
      this.units[target.id].stats.damageTaken += before - target.health; this.units[target.id].stats.lastHitTick = this.state.tick;
      this.realtime.push({ type: 'tracer', owner: tank.id, from, to, victim: target.id });
      if (before > 0 && target.health === 0) this.kill(target, tank.id, 'coax', true);
    }
  }

  private coaxOrigin(tank: TankState): V3 {
    const socket = tank.visualKind === 'rustling' || tank.visualKind === 'spire' ? CAMPAIGN_COAX[tank.visualKind] : null;
    const local: V3 = socket ? [RING_FRAME[0] + Math.sin(tank.turretYaw) * socket.forward,
      RING_FRAME[1] + socket.height, RING_FRAME[2] + Math.cos(tank.turretYaw) * socket.forward] : [0, .55, .25];
    return add(tank.position, rotate(local, tank.rotation));
  }

  /** The nearest enemy this tank's team sees, within range and the turret's arc, with a clear line. */
  private coaxTarget(tank: TankState, unit: Unit): TankState | null {
    const known = this.teamSightings(tank.team ?? -1), forward = rotate([Math.sin(tank.turretYaw), 0, Math.cos(tank.turretYaw)], tank.rotation);
    const origin = this.coaxOrigin(tank);
    let best: TankState | null = null, bestRange = Infinity;
    for (const enemy of this.state.tanks) {
      if (enemy.team === tank.team || enemy.health <= 0 || this.units[enemy.id].spec.coaxProof || !known.get(enemy.id)?.visible) continue;
      const delta = sub(enemy.position, origin), range = length(delta);
      if (range > COAX.range || range >= bestRange) continue;
      const along = dot(delta, forward) / Math.max(range, 1e-9);
      if (!unit.spec.coaxOnly && along < Math.cos(COAX.arc)) continue;
      const aimPoint = add(enemy.position, mul(normalize(enemy.position), 0.45)), line = sub(aimPoint, origin), extent = length(line);
      if (this.blocked(origin, mul(line, 1 / extent), Math.max(0, extent - TANK_TARGET_RADIUS))) continue;
      best = enemy; bestRange = range;
    }
    return best;
  }

  // ---- sight ----------------------------------------------------------------------------------------------------------

  private teamSightings(team: number): Map<PlayerId, TeamSighting> {
    let known = this.sightings.get(team);
    if (!known) this.sightings.set(team, known = new Map());
    return known;
  }

  /** Team line of sight from each living member's kit sensor to a few points on each enemy; allies share sightings. */
  private updateSight(): void {
    const teams = new Set(this.state.tanks.map(t => t.team ?? -1));
    for (const team of teams) {
      const known = this.teamSightings(team);
      const sensors = this.state.tanks.filter(t => t.team === team && t.health > 0).map(t => add(t.position, rotate(this.units[t.id].kit.frames.sensor.position, t.rotation)));
      for (const enemy of this.state.tanks) {
        if (enemy.team === team) continue;
        const visible = enemy.health > 0 && sensors.length > 0 && (!this.rules.fog || this.units[enemy.id].revealed || this.sees(sensors, enemy));
        if (visible) {
          const last = known.get(enemy.id), dt = last ? this.state.time - last.time : 0;
          const raw = last?.visible && dt > 0 ? mul(sub(enemy.position, last.position), 1 / dt) : [0, 0, 0] as V3;
          const velocity = length(raw) > 12 ? [0, 0, 0] as V3 : raw;
          known.set(enemy.id, { position: [...enemy.position], velocity, time: this.state.time, visible: true });
        }
        else { const seen = known.get(enemy.id); if (seen) seen.visible = false; }
      }
    }
    this.publishObservations();
  }

  private sees(sensors: readonly V3[], target: TankState): boolean {
    const points = [target.position, add(target.position, rotate([...SIGHT_TARGET] as V3, target.rotation)), add(target.position, mul(normalize(target.position), 0.6))];
    for (const origin of sensors) for (const point of points) {
      const extent = distance(origin, point);
      if (extent >= this.world.radius * 1.65) continue;
      if (!this.blocked(origin, normalize(sub(point, origin)), Math.max(0, extent - 0.12))) return true;
    }
    return false;
  }

  private blocked(origin: V3, direction: V3, maxDistance: number): boolean {
    const world = this.world as WorldQuery & { blocked?(origin: V3, direction: V3, maxDistance: number): boolean };
    return typeof world.blocked === 'function' ? world.blocked(origin, direction, maxDistance) : !!world.raycast(origin, direction, maxDistance);
  }

  /** Every tank's observation row from its team's sightings, plus its primary contact (what the view reads). */
  private publishObservations(): void {
    const rows = this.state.observations!;
    for (const observer of this.state.tanks) {
      const known = this.teamSightings(observer.team ?? -1), row = rows[observer.id];
      let best: Contact | null = null, bestRange = Infinity;
      for (const target of this.state.tanks) {
        if (target.team === observer.team) { row[target.id] = null; continue; }
        const seen = known.get(target.id);
        const contact: Contact | null = seen && target.health > 0 ? { position: [...(seen.visible ? target.position : seen.position)], observedAt: seen.time, source: seen.visible ? 'sight' : 'scan', visible: seen.visible } : null;
        row[target.id] = contact;
        if (!contact) continue;
        const range = distance(contact.position, observer.position);
        if (!best || (contact.visible && !best.visible) || (contact.visible === best.visible && (contact.visible ? range < bestRange : contact.observedAt > best.observedAt))) { best = contact; bestRange = range; }
      }
      this.state.contacts[observer.id] = best;
    }
  }

  // ---- terrain ----------------------------------------------------------------------------------------------------------

  /** Commit every due edit that is prepared, in impact order; an unprepared one waits (later ones wait behind it) without
   * stalling the match. Always true: kept for the runtime's stall contract. */
  private resolveCommits(): boolean {
    const transactions = this.world.transactions;
    while (transactions && this.commits.length && this.commits[0].commitTick <= this.state.tick) {
      const commit = this.commits[0], result = transactions.commitReady(commit.ticket, commit.commitTick);
      if (result.status === 'not-ready') {
        if (this.state.tick - commit.commitTick < COMMIT_GIVE_UP_TICKS) break;
        transactions.cancel(commit.ticket); this.commits.shift();
        this.pending.push({ type: 'terrain-failed', code: 'timeout', message: `Terrain edit ${commit.cuts.map(c => c.id).join(', ')} was not prepared in time` });
        continue;
      }
      this.commits.shift();
      if (result.status === 'committed') {
        if (result.update) this.terrainUpdates.push(result.update);
        this.pending.push({ type: 'terrain-commit', cutIds: commit.cuts.map(cut => cut.id), version: result.update?.version ?? this.world.version });
        this.treadCache.length = 0;
      } else this.pending.push({ type: 'terrain-failed', code: result.code, message: result.message });
    }
    this.stall = null;
    return true;
  }

  private treadProfile(tank: TankState): TrackTerrainSample {
    const key = `${tank.position.join(',')}|${tank.rotation.join(',')}|${this.units[tank.id].kit.loadout.runningGear}`, cached = this.treadCache[tank.id];
    if (cached && cached.version === this.world.version && cached.pose === key) return cached.sample;
    const sample = sampleTrackTerrain(this.world, tank.position, tank.rotation, this.units[tank.id].kit);
    this.treadCache[tank.id] = { version: this.world.version, pose: key, sample };
    return sample;
  }
}
