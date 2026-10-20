// @contract v1 — docs/architecture.md#contracts-and-invariants
/** Shared game boundary: canonical simulation data is independent of rendering quality. */
import type { MunitionId } from './munitions';
import type { CutRequest, TerrainTransactions } from '../gpu/terrain/transactions';
import type { KitLoadoutIds } from './api/match';
import type { WindState } from '../world/weather';
export type V3 = [number, number, number];
export type Q4 = [number, number, number, number];
/** Read-only shot prediction for presentation; a flight limit must never masquerade as a landing point. */
export interface TrajectoryPrediction { points: V3[]; hit: boolean; /** Explicit selected object contact, not a terrain landing. */ hitTarget?: boolean }
/** A tank index into GameSnapshot.tanks (W1-GAME widened it from `0 | 1`; N tanks per match). */
export type PlayerId = number;
export interface TerrainHit { point: V3; normal: V3; distance: number; material: number }
export interface TerrainQueryBounds { min: V3; max: V3 }
export interface TerrainTriangle { a: V3; b: V3; c: V3; normal: V3; material: number }
export interface TerrainTriangleQuery { triangles: TerrainTriangle[]; overflow: boolean }
export interface WorldQuery {
  /** Canonical standing liquids: shared by all tanks and the initial visual fill. */
  configureLiquids?(spawns: readonly V3[]): void;
  liquidBasins?(): import('../world/basins').BasinSolution | undefined;
  /** Engine v4: a resident match lifecycle sharing the terrain/physics instance. */
  createMatchLifecycle?(setup: import('./api/match').MatchSetup, state: GameSnapshot): import('./native-match').NativeMatch | undefined;
  createBallistics?(setup: import('./api/match').MatchSetup, gravity: number): import('./native-ballistics').NativeBallistics | undefined;
  createCombat?(setup: import('./api/match').MatchSetup, state: GameSnapshot, kit: (tank: TankState) => import('./kit').KitAssembly): import('./native-combat').NativeCombat | undefined;
  ballisticQuery?(): import('./native-ballistics').BallisticQuery | undefined;
  /** A composed (kind 2) lease whose ray and surface results are exactly this world's
   * raycast()/surface(): resident bot controllers may then serve their own queries. */
  botQuery?(): import('./native-ballistics').BallisticQuery | undefined;
  /** rust-engine-v22: impacts cut each source material by its own shell (rules/material-craters.ts). */
  readonly materialCraters?: boolean;
  /** Cosmetic shards keep their presentation clock and cannot feed forces into
   * gameplay. The native engine supplies this world in its existing WASM instance. */
  createPresentationPhysics?(): import('@dimforge/rapier3d-compat').World | undefined;
  /** The engine module for a presentation world in a worker (native worlds only). */
  presentationEngine?(): WebAssembly.Module | undefined;
  readonly radius: number;
  readonly version: number;
  raycast(origin: V3, direction: V3, maxDistance: number): TerrainHit | null;
  surface(direction: V3): TerrainHit | null;
  isSolid(point: V3): boolean;
  /** Distance travelled by a swept sphere, including edge/corner clearance. */
  sweepSphere?(origin: V3, direction: V3, maxDistance: number, radius: number): number | null;
  /** Stable query adapter for stationary pigment. Moving supports do not retain world-space marks. */
  readonly footprintSurface?: WorldQuery;
  /** Committed-triangle broad phase. Overflow means the bounded result is incomplete. */
  queryTriangles?(bounds: TerrainQueryBounds, maxTriangles?: number): TerrainTriangleQuery;
  /** Complete committed terrain surface for visibility volume construction. */
  visibilityTriangles?(): Iterable<TerrainTriangle>;
  /** The same committed surface as its collision pages; a page a commit left unchanged keeps its mesh object. */
  fixedChunks?(): ReadonlyMap<string, { readonly mesh: Pick<TerrainChunk, 'positions' | 'indices'> }>;
  /** Read-only occupied shapes for cosmetic rigid bodies mirroring moving supports. */
  collisionBodies?(): readonly { id: number; position: V3; rotation: Q4;
    shapes: readonly { vertices: Float32Array; indices: Uint32Array; offset?: V3 }[] }[];
  /** Advance persistent world bodies at the same fixed boundary as gameplay. */
  fixedStep?(): void;
  /** Optional solver chassis: owns tank and structural dynamics in one world. */
  stepTanks?(tanks: TankState[], inputs: readonly DriveInput[], dt: number): void;
  /** Realtime lifecycle: retire a wreck's solver body, or reset a recycled slot. */
  removeTank?(id: PlayerId): void;
  relocateTank?(tank: TankState): void;
  /** Non-blocking terrain edits (plan §5.1); implemented by W1-TER. */
  readonly transactions?: TerrainTransactions;
}
export interface TerrainChunk {
  id: string;
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  /** Occupied material per triangle, retained on newly exposed cut faces. */
  materials: Uint16Array;
  /** Per-vertex analytic source: xyz sphere center, w = 1 planet / 2 inward sphere / 0 plane. */
  sources?: Float32Array;
}
export interface TerrainUpdate {
  version: number;
  chunks: TerrainChunk[];
  removed: string[];
  milliseconds: number;
  triangles: number;
  rebuilt: number;
  /** Resident geometry has no CPU render chunks; these committed bounds retire its old pigment. */
  footprintBounds?: TerrainQueryBounds[];
  /** Topology revision of footprintSurface, independent of moving-body query revisions. */
  footprintVersion?: number;
  seed?: number;
  /** Effective world recipe, shared by terrain, shaders, fluids and vegetation. Absent in legacy updates. */
  planetKind?: import('./planet-field').PlanetType;
  /** Profile v3: continuous sphere-domain terrain; older checkpoints retain their field. */
  sphericalNoise?: boolean;
  /** Full coarse cover used to atomically retire a visual LOD after a content edit. */
  visualReset?: TerrainChunk[];
  /** Worker-prepared triangulation of the same committed planar surface. */
  renderChunks?: TerrainChunk[];
  presentationMilliseconds?: number;
  /** Transient pieces of the removed solid. Never enter canonical terrain/checkpoints. */
  debris?: TerrainFragment[];
  debrisOrigin?: V3;
  debrisRadius?: number;
}
export interface TerrainFragment { positions: Float32Array; colors: Float32Array; indices: Uint32Array; center: V3; radius: number; volume: number }
export interface TerrainService extends WorldQuery {
  initialize(): Promise<TerrainUpdate>;
  carve(center: V3, radius: number, fragments?: boolean, shells?: readonly import('../gpu/terrain/contracts').CutShell[]): Promise<TerrainUpdate>;
  /** Presentation only: never publishes a new collision or content revision. */
  refineView?(view: { position: V3; pixelsPerRadian: number }): Promise<TerrainUpdate>;
  dispose(): void;
}
export interface Loadout { tracks: 'scout' | 'grip'; barrel: 'mortar' | 'cannon' | 'rail'; armor: 'light' | 'heavy' }
/** Independently damageable machinery in the hull's local frame. Later stages stay armored until earlier ones fail. */
export interface TankComponent {
  id: string; name: string; kind: 'drive' | 'weapon' | 'core';
  offset: V3; radius: number; stage: number; health: number; maxHealth: number;
}
export interface TankState {
  /** Independent machinery integrity (0 broken, 1 intact). Old snapshots without it are intact. */
  machinery?: { leftTrack: number; rightTrack: number; engine: number; weapon: number; impact: V3 };
  id: PlayerId;
  /** Recycled actor slots have a new generation; presentation must discard the old wreck. */
  generation?: number;
  retired?: boolean;
  destroyedAt?: number;
  motionKind?: 'chassis' | 'swarm' | 'air';
  visualKind?: 'dragonfly' | 'rustling' | 'spire' | 'skimmer' | 'relay' | 'watchtower';
  headlights?: boolean;
  /** Searchlight exposure, 0..1. A full bar triggers the mission's alarm response. */
  detection?: number;
  searchlight?: { origin: V3; direction: V3; range: number; angle: number };
  /** World-facing shield; cosine -1 covers every direction. Environmental collapse bypasses it. */
  shield?: { direction: V3; cosine: number };
  /** EMP inhibits track input until this simulation tick; inertia and gravity still apply. */
  disabledUntil?: number;
  components?: TankComponent[];
  position: V3;
  rotation: Q4;
  velocity: V3;
  heading: number;
  turretYaw: number;
  barrelPitch: number;
  power: number;
  health: number;
  charge: number;
  movement: number;
  recoil: number;
  suspension: number[];
  trackPhase: number;
  /** Driver left (+local X), then right (-local X); cumulative belt travel in metres. */
  trackPhases: [number, number];
  /** Driven belt surface speed in metres per second; may differ from ground speed under slip. */
  trackSpeeds: [number, number];
  /** Resolved ground speed and driven-belt minus ground slip (metres/second), left/right. */
  trackGroundSpeeds: [number, number];
  trackSlip: [number, number];
  /** Supported normal-load fraction per track; unsupported tracks have zero traction. */
  trackContact: [number, number];
  /** Mathematical rotation about support-up in radians/second (driver-right is negative). */
  yawVelocity: number;
  /** Eight wheel compressions: left rear→front, then right rear→front; .5 is nominal. */
  wheelSuspension: number[];
  /** Width-aware terrain local-Y heights: nine rear→front stations per driver-left/right belt. */
  treadContacts: number[];
  /** Complete local terrain upper envelope per driver side; [z,y] points, max128. */
  treadTerrain?: [number, number][][];
  loadout: Loadout;
  munition?: MunitionId;
  /** Kit loadout; read it through tankKit(t) (W0-KIT), which falls back to the v1 loadout. */
  kit?: KitLoadoutIds;
  /** Team of this tank (MatchSetup.tanks[id].team); always set by the W1 simulation. */
  team?: number;
  /** Tempo timeline position in tempo units (rules/tempo.ts): the living tank with the lowest value acts next. */
  readyAt?: number;
  /** Health at spawn (kit hp or the setup's maxHealth override). */
  maxHealth?: number;
  /** Display name from the setup, when one was given. */
  name?: string;
  /** Rounds left of each limited munition (rules/ammo.ts); a missing entry is unlimited. Absent in drive tests. */
  ammo?: Partial<Record<MunitionId, number>>;
  /** Combat-only spent reactive hull sections: front 1, driver-left 2, driver-right 4, rear 8. Missing = intact. */
  reactiveArmor?: number;
}
export interface DriveInput { throttle: number; steer: number; selfRight?: boolean }
export interface ProjectileState { id: number; owner: PlayerId; position: V3; velocity: V3; age: number; munition?: MunitionId;
  /** Tick at which the shell was fired (its first step runs in launchTick + 1; the wind is sampled per step tick). */
  launchTick?: number;
  /** Muzzle position at launch, for flight statistics. */
  origin?: V3;
  /** Highest altitude above the planet radius so far. */
  peakAltitude?: number }
export interface Contact { position: V3; observedAt: number; source: 'sight' | 'scan'; visible: boolean }
export type MatchPhase = 'aim' | 'resolving' | 'terrain' | 'finished';
export interface ImpactEvent {
  noCrater?: boolean; type: 'impact'; position: V3; normal: V3; radius: number; owner: PlayerId; munition?: MunitionId;
  hits?: { tank: number; damage: number; exposure: number; direct: boolean; lethal: boolean; braced?: 'perfect' | 'good';
    armorSection?: 'front' | 'left' | 'right' | 'rear' | 'roof'; /** Section bit consumed by this hit, if any. */ reactiveSpent?: number }[];
  commitTick?: number; cut?: CutRequest;
  flight?: { ticks: number; centralAngle: number; peakAltitude: number; distance: number; ricochets: number; skips: number } }
/** Presentation payload captured at acceptance, before recoil or another selection can change the tank.
 * Events are replay-derived, so this adds no fields to canonical state or saved hashes. */
export interface ShotLaunch {
  readonly id: number; readonly tick: number; readonly munition: MunitionId; readonly weapon: Loadout['barrel']; readonly power: number;
  readonly position: V3; readonly direction: V3; readonly up: V3;
}
export interface ShotEvent { type: 'shot'; player: PlayerId; launch?: ShotLaunch }
export type GameEvent = ImpactEvent | { type: 'turn'; player: PlayerId } | { type: 'finish'; winner: PlayerId | null; team?: number | null } | ShotEvent
  | { type: 'kill'; tank: number; by: number | null; cause: string } | { type: 'terrain-commit'; cutIds: string[]; version: number }
  | { type: 'terrain-failed'; code: string; message: string } | { type: 'incoming'; tank: number; impactTick: number; predicted: V3 }
  /** CC-004: an accepted radar scan by `tank`, pulsing from `position` (the scanner). */
  | { type: 'scan'; tank: number; position: V3 };
export interface GameSnapshot {
  /** Whether this match uses line-of-sight fog. Older snapshots default to enabled. */
  fog?: boolean;
  tick: number;
  time: number;
  phase: MatchPhase;
  active: PlayerId;
  turn: number;
  phaseTime: number;
  tanks: TankState[];
  projectiles: ProjectileState[];
  /** Per observer: its primary contact (the freshest enemy observation), the v1 field every view reads. */
  contacts: (Contact | null)[];
  winner: PlayerId | null;
  /** Per observer × target: what the observer knows of each enemy (null for itself, allies and never-seen enemies). */
  observations?: (Contact | null)[][];
  /** The winning team once the match is finished (null for mutual destruction). */
  winnerTeam?: number | null;
  /** The match wind at this tick (world/weather.ts), or null in still air. The engine's WindU reads the same state. */
  wind?: WindState | null;
  /** Set once the turn counter reaches rules.suddenDeathTurn: the hook sudden-death variants (W2+) act on. */
  suddenDeath?: boolean;
}
