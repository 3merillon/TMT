/** GameView facade (plan §5.2): presentation consumes committed terrain and permitted contacts, never owns gameplay.
 *
 * The game renders on the raw-WebGPU engine (src/engine); follow and orbit controls supply a camera pose that becomes
 * an engine CameraRig. The public API is the pre-takeover
 * one, so app/* and ui/* are unchanged:
 *   constructor(host) · initialize() · setTerrainDetail · setWorld · setVehicleDebug · setTerrain · reset · focus ·
 *   update(state, observer, dt, preview, fullPreview, interp?) · burst · radar · render · telemetry · dispose ·
 *   cameraTelemetry · terrainHost · onGameEvent · setPendingCuts · worldToScreen · addCameraConstraint · cameraRig ·
 *   onDeviceLost
 * Engine: `Engine.create({ modules: [...RENDER_MODULES, ...sceneModules] })` (W1-ENG-LOOK's shadows/sky/post arrive through
 * RENDER_MODULES); the planet comes from the seed (`planetType`) with the per-seed normal WGSL as the scene facet
 * `terrainPlanetWGSL`. Presenters (presentation/presenters.ts) are iterated for onGameEvent, onUpdate and frameInput.
 */
import { runningGearPoser, setNativeGear } from './kit/pose';
import { CameraPose, cameraUnit } from './presentation/camera-pose';
import type { Engine, CameraRig, FrameInput } from '../engine';
import type { OverlayRing, SceneModules } from '../engine/scene';
import type { TerrainRenderHost } from '../gpu/terrain/render-host';
import type { SimInterpolation } from './api/extensions';
import type { Contact, GameEvent, GameSnapshot, PlayerId, TankState, TerrainUpdate, TrajectoryPrediction, V3, WorldQuery } from './contracts';
import { MUNITIONS, type MunitionId } from './munitions';
import { craterProfile } from './rules/crater';
import { TankFollowCamera, keepOverviewOutsideTerrain, type CameraConstraint } from './follow-camera';
import { ImpactFlashes } from './presentation/impact-flash';
import { Tracers } from './presentation/tracers';
import { VehicleDamage } from './presentation/vehicle-damage';
import { HitFeedback } from './presentation/hit-feedback';
import { add, cross, distance, dot, mul, normalize, sub } from './math';
import type { RealtimeEvent } from './realtime/match';
import type { TerrainDebris } from './presentation/debris';
import { TankLabels } from './presentation/labels';
import { PlanetOrbitControls } from './presentation/orbit-controls';
import { PRESENTERS, type Presenter, type ViewServices } from './presentation/presenters';
import { ShellViews } from './presentation/shells';
import type { createProjectileTrails } from './presentation/projectile-trails';
import { loadProjectileAssets } from './presentation/projectile-models';
import { MuzzleEffects } from './presentation/muzzle-effects';
import { ShotEvents } from './presentation/shot-events';
import { TrajectoryPreview, trajectoryPreviewAllowed, trajectoryPreviewKeys } from './presentation/trajectory-preview';
import { TrajectoryReadout, trajectoryTarget, trajectoryTargetOccluded, type TrajectoryTarget } from './presentation/trajectory-readout';
import { AimTargetReadout, cycleVisibleTankAimTarget, pickAimSelection, resolveAimSelection, visibleTankAimProxies, type AimTargetProxy, type RequestedAimTarget } from './presentation/aim-target';
import type { AimSelection } from './rules/aim-target';
export type { RequestedAimTarget } from './presentation/aim-target';
import type { ShockwaveFacet } from '../engine/passes/shockwaves/shockwaves';
import { composeTRS, renderedPose, TankViews, transformPoint } from './presentation/tank-view';
import { assembleKit, tankKit } from './kit';
import { TerrainPresentation } from './presentation/terrain-module';
import { currentSettings, SETTINGS_EVENT, type GraphicsSettings, type ProgressSettings } from './meta/settings';
import { applyGraphicsSettings, engineGraphicsSettings, PROTECTED_GRAPHICS_TIER } from './presentation/graphics-settings';
import { lensFovY, lensToScene, sceneToLens } from '../engine/passes/post/lens';
import { hash32, SUN_ILLUMINANCE } from '../world/sun';
export { TankFollowCamera } from './follow-camera';
export type { CameraConstraint } from './follow-camera';

/** Game events plus the radar pulse of an accepted scan, which has no GameEvent variant in contract v1 (CC-004). */
export type ViewEvent = GameEvent | { type: 'radar'; tank: number; position: V3 };
/** A cut announced at impact and not yet committed (drawn by the engine's pending-crater modifier). */
export interface PendingCut { readonly center: V3; readonly radius: number; readonly t0: number }
/** 'parallax' turns the terrain POM on; 'normal' keeps the normal maps only (Low/Medium tier behaviour). */
export type TerrainDetail = 'normal' | 'parallax';
/** W1-GAME's additive N-tank fields, optional until that merge (identical to its contracts.ts declarations):
 * per observer id × target id what the observer knows, and each tank's team. */
type NTankSnapshot = GameSnapshot & { observations?: readonly (readonly (Contact | null)[] | null | undefined)[] };
type TeamTank = TankState & { team?: number };

const DEVICE_PIXEL_RATIO_CAP = 1.5;
const FOV_DEGREES = 47;
const RING_STYLE = {
  marker: { radius: 0.64, width: 0.09, color: [1.0, 0.77, 0.55] as V3, alpha: 0.75 },
  scan: { width: 0.08, color: [0.71, 0.94, 0.76] as V3, alpha: 0.55, duration: 2, speed: 12 },
  /** Realtime incoming shell: a red ring closing on the predicted landing point, reaching it at impact. */
  incoming: { width: 0.12, color: [1.0, 0.26, 0.18] as V3, alpha: 0.9, from: 2.8, to: 0.9 },
} as const;

/** Sun elevation over the observed tank at match start (degrees). */
const MATCH_SUN_ELEVATION = 40;
/**
 * The match sun (plan §4.11, W1-ENG-LOOK's CC note "a game that drives the sun overrides the facet"): 40° above the
 * observed tank's spawn, on a per-seed azimuth, fixed for the match. The engine's per-planet default puts some spawns at
 * the terminator (seed 7: dusk and a night sky over the first shot), while the diorama look wants the battle on the day
 * side under the backdrop sky. Presentation only (I6, I11): the sun never reaches the simulation.
 */
export function matchSun(spawn: readonly number[], seed: number): [number, number, number] {
  const l = Math.hypot(spawn[0], spawn[1], spawn[2]);
  const up = l > 1e-6 ? [spawn[0] / l, spawn[1] / l, spawn[2] / l] : [0, 1, 0];
  const a = Math.abs(up[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const t0 = normalize3([a[1] * up[2] - a[2] * up[1], a[2] * up[0] - a[0] * up[2], a[0] * up[1] - a[1] * up[0]]);
  const t1 = [up[1] * t0[2] - up[2] * t0[1], up[2] * t0[0] - up[0] * t0[2], up[0] * t0[1] - up[1] * t0[0]];
  const azimuth = hash32((seed | 0) ^ 0x5d1a7c3b) / 4294967296 * Math.PI * 2;
  const e = MATCH_SUN_ELEVATION * Math.PI / 180, ca = Math.cos(azimuth), sa = Math.sin(azimuth);
  return normalize3([0, 1, 2].map(i => up[i] * Math.sin(e) + (t0[i] * ca + t1[i] * sa) * Math.cos(e)));
}
/** Seconds of simulation time per local day (one turn of the match sun). */
export const DAY_SECONDS = 480;
/** Local days per lunar cycle (full → new → full), and the tilt of the moon's path against the sun's. */
export const MOON_LUNATION_DAYS = 4;
const MOON_INCLINATION = 18 * Math.PI / 180;

/** Rotate the match sun through a local day using simulation time, so pause and replay preserve the lighting. */
export function sunAtTime(initial: readonly number[], spawn: readonly number[], seconds: number): [number, number, number] {
  return rotateAbout(initial, dayAxis(initial, spawn), seconds * Math.PI * 2 / DAY_SECONDS);
}
/**
 * The match moon (presentation only, like the sun): it crosses the sky with the sun's daily turn on a path tilted by
 * MOON_INCLINATION, lagging a little each day. It rises later every night and runs through its phases once every
 * MOON_LUNATION_DAYS, starting full, opposite the sun. The engine derives its phase and light from the two directions.
 */
export function moonAtTime(initialSun: readonly number[], spawn: readonly number[], seconds: number): [number, number, number] {
  // Tilting the axis about the initial sun keeps the opposite point, the starting full moon, on the moon's path.
  const axis = rotateAbout(dayAxis(initialSun, spawn), initialSun, MOON_INCLINATION);
  const start = [-initialSun[0], -initialSun[1], -initialSun[2]];
  return rotateAbout(start, axis, seconds * Math.PI * 2 / DAY_SECONDS * (1 - 1 / MOON_LUNATION_DAYS));
}
/** The sun's daily rotation axis: perpendicular to the spawn's up and the initial sun. */
function dayAxis(initial: readonly number[], spawn: readonly number[]): [number, number, number] {
  const up = normalize3(spawn);
  return normalize3([
    up[1] * initial[2] - up[2] * initial[1],
    up[2] * initial[0] - up[0] * initial[2],
    up[0] * initial[1] - up[1] * initial[0],
  ]);
}
/** Rodrigues rotation of v about the unit axis k by `angle`. */
function rotateAbout(v: readonly number[], k: readonly number[], angle: number): [number, number, number] {
  const c = Math.cos(angle), s = Math.sin(angle);
  const cross: [number, number, number] = [
    k[1] * v[2] - k[2] * v[1],
    k[2] * v[0] - k[0] * v[2],
    k[0] * v[1] - k[1] * v[0],
  ];
  const along = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  return normalize3([0, 1, 2].map(i => v[i] * c + cross[i] * s + k[i] * along * (1 - c)));
}
function normalize3(v: readonly number[]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function tankOf(state: GameSnapshot, id: number): TankState {
  return state.tanks.find(t => t.id === id) ?? state.tanks[id] ?? state.tanks[0];
}

export class GameView {
  /** Camera pose driven by follow/orbit controls; rendering projection belongs to the engine. */
  readonly camera = new CameraPose(FOV_DEGREES, 1, .08, 220);
  readonly canvas: HTMLCanvasElement;
  private engine?: Engine;
  private scene?: SceneModules;
  private tanks?: TankViews;
  private shells?: ShellViews;
  private projectileTrails?: Awaited<ReturnType<typeof createProjectileTrails>>;
  private flashes?: ImpactFlashes;
  private tracers?: Tracers;
  private vehicleDamage?: VehicleDamage;
  /** Realtime incoming telegraphs: where and when a hostile shell lands (sim seconds). */
  private incoming: { center: V3; impact: number; start: number }[] = [];
  private muzzles?: MuzzleEffects;
  private readonly shotEvents = new ShotEvents();
  private debris?: TerrainDebris;
  private terrain?: TerrainPresentation;
  private readonly labels: TankLabels;
  private readonly hitFeedback: HitFeedback;
  private readonly presenters: Presenter[] = [];
  private followCamera = new TankFollowCamera(this.camera);
  private readonly followTarget: V3 = [0, 13, 0];
  private readonly orbit: PlanetOrbitControls;
  private following = false;
  private followedPlayer: PlayerId = 0;
  private observer: PlayerId = 0;
  private orbitPointers = new Map<number, [number, number]>();
  private world?: WorldQuery;
  private lastAim = '';
  private previewPoints: V3[] = [];
  private readonly trajectory = new TrajectoryPreview();
  private readonly trajectoryReadout: TrajectoryReadout;
  private trajectoryTarget: TrajectoryTarget | null = null;
  private readonly aimTargetReadout: AimTargetReadout;
  private aimColliderKey = '';
  private readonly aimTargetProviders = new Set<() => readonly AimTargetProxy[]>();
  private scanAge = 100;
  private scanPosition: V3 = [0, 0, 0];
  private markerRing: OverlayRing | null = null;
  private frameTimes: number[] = [];
  private gpuTimes: number[] = [];
  private gpuSampleFrame = 0;
  private clock = 0;
  private lastFrameDt = 1 / 60;
  private disposed = false;
  private terrainDetail: TerrainDetail = 'parallax';
  private vehicleDebug = false;
  /** Dev override also limits visible targets when forcing fog in an otherwise fully revealed playground. */
  private devFog?: boolean;
  private devSightQuery?: (observer: PlayerId, target: PlayerId) => boolean;
  private readonly devSightCache = new Map<string, boolean>();
  private lastState?: GameSnapshot;
  private lastInterp?: SimInterpolation;
  private cameraConstraints: CameraConstraint[] = [];
  private presentationMilliseconds = 0;
  private firstTerrain = true;
  private cssSize: [number, number] = [1, 1];
  private dpr = 1;
  private viewOffset?: [number, number, number, number];
  private deviceLost?: () => void;
  private readonly resizeObserver: ResizeObserver;
  /** The match sun (presentation only): fixed at the first update of a match, over the observed tank; null between matches. */
  private matchSun: [number, number, number] | null = null;
  private sunSpawn: [number, number, number] | null = null;
  private terrainSeed = 7;
  /** Optional effects apply live; protected scene quality never follows the preset label. */
  private graphics: GraphicsSettings = currentSettings().graphics;
  private readonly onSettings = (event: Event): void => {
    const graphics = (event as CustomEvent<ProgressSettings>).detail?.graphics;
    if (!graphics) return;
    const changed = (Object.keys(graphics) as (keyof GraphicsSettings)[]).some(key => graphics[key] !== this.graphics[key]);
    this.graphics = graphics;
    if (this.engine && changed) {
      applyGraphicsSettings(this.engine.services, graphics);
      this.engine.services.scene.get('taa')?.invalidate();
    }
  };

  constructor(private host: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'game-canvas';
    host.append(this.canvas);
    this.labels = new TankLabels(host);
    this.hitFeedback = new HitFeedback(host);
    this.trajectoryReadout = new TrajectoryReadout(host);
    this.aimTargetReadout = new AimTargetReadout(host);
    this.camera.position = [-17, 33, 26];
    this.orbit = new PlanetOrbitControls(this.canvas);
    this.orbit.reset(this.camera, [0, 13, 0]);
    // Follow input owns its pointer capture; dragging never disables following.
    host.addEventListener('pointerdown', this.beginManualOrbit, true);
    host.addEventListener('pointermove', this.moveManualOrbit, true);
    host.addEventListener('pointerup', this.endManualOrbit, true);
    host.addEventListener('pointercancel', this.endManualOrbit, true);
    host.addEventListener('lostpointercapture', this.endManualOrbit, true);
    host.addEventListener('contextmenu', this.orbitContextMenu);
    host.addEventListener('wheel', this.zoomFollow, { capture: true, passive: false });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    window.addEventListener(SETTINGS_EVENT, this.onSettings);
  }

  async initialize(): Promise<void> {
    // Keep shader construction and physics descriptors off the title's synchronous import path.
    // The UI remains interactive while the existing renderer warm-up downloads and installs them.
    const { Engine, RENDER_MODULES, createSceneModules, LIGHTING_DEBUG_VIEWS, TerrainDebris, createProjectileTrails } = await import('./presentation/renderer');
    if (this.disposed) throw new Error('The game view was closed.');
    const dev = new URLSearchParams(location.search).has('engineDev');
    // The load broadcast fired before this view existed; read the latest settings instead of waiting for a change.
    this.graphics = currentSettings().graphics;
    this.terrainDetail = 'parallax';
    const scene = createSceneModules({ terrain: { detail: this.terrainDetail === 'parallax' } });
    // The shell models download beside pipeline compilation; a failure surfaces with the renderer's own.
    const projectiles = loadProjectileAssets();
    projectiles.catch(() => {});
    const engine = await Engine.create({
      canvas: this.canvas, tier: PROTECTED_GRAPHICS_TIER, dev, settings: engineGraphicsSettings(this.graphics),
      modules: [...RENDER_MODULES, ...scene.factories],
    });
    try { await projectiles; } catch (error) { engine.dispose(); throw error; }
    if (this.disposed) { engine.dispose(); throw new Error('The game view was closed.'); }
    this.engine = engine;
    // A committed edit's changed region (a crater, and any building it brought down) retires the boxes it touched.
    engine.services.events.on('terrainCommitted', e => this.retireShadowStructures(e.dirtyBounds.min, e.dirtyBounds.max));
    // ?lightView=ao|gi|fog|sdf-sun|shadow|direct|ambient shows one lighting term (docs/visibility-architecture.md).
    const lightView = new URLSearchParams(location.search).get('lightView');
    const lighting = engine.services.scene.get('lighting');
    if (lightView && lighting && (LIGHTING_DEBUG_VIEWS as string[]).includes(lightView)) lighting.view = lightView as typeof lighting.view;
    this.scene = scene;
    engine.onLost(() => this.deviceLost?.());
    engine.resize(this.cssSize[0], this.cssSize[1], this.dpr);
    const sc = engine.services.scene;
    applyGraphicsSettings(engine.services, this.graphics);
    this.tanks = new TankViews(sc, (mesh, transform, tint, velocity) => this.debris?.detach(mesh, transform, tint, velocity));
    this.shells = new ShellViews(sc);
    this.projectileTrails = await createProjectileTrails(engine.services, this.shells.trails);
    this.flashes = new ImpactFlashes(sc);
    this.tracers = new Tracers(sc);
    this.vehicleDamage = new VehicleDamage(sc);
    this.muzzles = new MuzzleEffects(sc);
    this.debris = new TerrainDebris(sc);
    this.terrain = new TerrainPresentation(engine);
    const services: ViewServices = {
      engine, scene: sc,
      worldToScreen: p => this.worldToScreen(p),
      camera: () => this.engineRig(),
      addCameraConstraint: fn => this.addCameraConstraint(fn),
      world: () => this.world,
      debrisWaterHulls: () => this.debris?.waterHulls() ?? [],
      observer: () => this.observer,
      addTrauma: amount => this.followCamera.addTrauma(amount),
    };
    for (const factory of PRESENTERS) {
      const presenter = factory();
      await presenter.install(services);
      this.presenters.push(presenter);
    }
    if (this.disposed) throw new Error('The game view was closed.');
  }

  setTerrainDetail(detail: TerrainDetail): void {
    this.terrainDetail = detail;
    this.scene?.terrain.setDetail(detail === 'parallax');
    this.gpuTimes.length = 0;
  }

  /** Resident terrain draws through this host (plan §5.1). Available after initialize(). */
  get terrainHost(): TerrainRenderHost {
    const host = this.scene?.terrain.host;
    if (!host) throw new Error('Terrain materials are not ready.');
    return host;
  }

  /** The current world's intact building boxes, handed to the lighting every frame (an identity check, no copy). */
  private shadowStructures: readonly import('../engine/passes/lighting/lighting').ShadowStructure[] = [];
  /**
   * A damaged building is shadowed like the terrain, from the distance field alone. The sun and moon traces snap the
   * field to a building's exact box where the two agree; once an edit has changed a building, the field near its old
   * walls (a crater floor, the ground it stood on) can agree with the vanished box by chance, and the shadows traced
   * its ghost (rings along the old footprint). Boxes whose world bounds meet [min, max] leave the snap list.
   */
  private retireShadowStructures(min: readonly number[], max: readonly number[]): void {
    const kept = this.shadowStructures.filter(b => {
      for (let a = 0; a < 3; a++) {
        const reach = b.axes ? b.axes.reduce((sum, axis, k) => sum + Math.abs(axis[a]) * b.halfSize[k], 0) : b.halfSize[a];
        if (b.center[a] + reach < min[a] - 0.05 || b.center[a] - reach > max[a] + 0.05) return true;
      }
      return false;
    });
    if (kept.length !== this.shadowStructures.length) this.shadowStructures = kept;
  }

  setWorld(world: WorldQuery): void {
    this.world = world; this.lastAim = '';
    // Running gear is posed by the world's engine when it has one (?rig=ts keeps it in TypeScript).
    const core = (world as { resident?: { physics?: { native?: { core?: import('../gpu/terrain/rust-core').RustTerrainCore } } } }).resident?.physics?.native?.core;
    setNativeGear(new URLSearchParams(location.search).get('rig') === 'ts' ? undefined : core?.rigs);
    // The buildings' exact boxes, for crisp sun and moon shadows (the renderer snaps its distance field to them).
    const structures = (world as { structures?: readonly { center: readonly number[]; halfSize: readonly number[]; axes?: readonly (readonly number[])[] }[] }).structures;
    this.shadowStructures = (structures ?? []).map(s => ({ center: [s.center[0], s.center[1], s.center[2]] as [number, number, number],
      halfSize: [s.halfSize[0], s.halfSize[1], s.halfSize[2]] as [number, number, number],
      ...(s.axes ? { axes: s.axes.map(a => [a[0], a[1], a[2]]) as [[number, number, number], [number, number, number], [number, number, number]] } : {}) }));
    this.trajectory.clear();
    this.trajectoryTarget = null; this.trajectoryReadout.hide();
    this.aimTargetReadout.set(null);
    this.aimColliderKey = '';
  }

  setVehicleDebug(enabled: boolean): void {
    this.vehicleDebug = enabled;
    if (!enabled) this.engine?.services.scene.get('debugLines')?.clear();
  }

  setTerrain(update: TerrainUpdate): void {
    if (!this.terrain) throw new Error('Terrain materials are not ready.');
    this.terrainSeed = update.seed ?? 7;
    void this.terrain.setSeed(this.terrainSeed, update.sphericalNoise, update.planetKind).catch(error => console.error('[view] planet switch failed', error));
    this.terrain.setTerrain(update, this.firstTerrain);
    this.firstTerrain = false;
    this.presentationMilliseconds = update.presentationMilliseconds ?? 0;
    this.lastAim = '';
  }

  /** Compile selected-world shaders alongside worker terrain preparation. */
  preparePlanet(seed: number, kind: import('./planet-field').PlanetType, spherical = true): Promise<void> {
    if (!this.terrain || !this.scene) return Promise.reject(new Error('Terrain materials are not ready.'));
    const prepared = this.terrain.setSeed(seed, spherical, kind);
    // setSeed publishes synchronously; capture this selection before the shared idle wait can yield to a newer start.
    const selected = this.scene.terrain.ready();
    return Promise.all([prepared, selected]).then(() => undefined);
  }

  /** Keep the three-frame destruction grace period advancing when no battlefield is rendered. */
  idle(): void { this.engine?.ctx.tick(); }

  reset(): void {
    this.applyGraphicsTier();
    this.matchSun = null;
    this.sunSpawn = null;
    this.world = undefined;
    this.following = false;
    this.releaseOrbitPointers();
    this.tanks?.clear();
    this.shells?.clear();
    this.flashes?.clear();
    this.tracers?.clear(); this.vehicleDamage?.clear();
    this.hitFeedback.clear();
    this.incoming = [];
    this.muzzles?.clear();
    this.shotEvents.clear();
    this.debris?.clear();
    for (const p of this.presenters) p.reset?.();
    this.engine?.services.scene.get('fluids')?.clearEffects();
    this.engine?.services.scene.get('clouds')?.reset();
    this.engine?.services.scene.get('fluids')?.resolve();
    this.terrain?.reset();
    this.engine?.services.scene.get('fogOfWar')?.clear();
    this.labels.clear();
    const scene = this.engine?.services.scene;
    scene?.get('overlays')?.setRibbon(null);
    scene?.get('overlays')?.setRings([]);
    scene?.get('debugLines')?.clear();
    this.markerRing = null;
    this.scanAge = 100;
    this.previewPoints = [];
    this.trajectory.clear();
    this.trajectoryTarget = null; this.trajectoryReadout.hide();
    this.aimTargetReadout.set(null);
    this.aimColliderKey = '';
    this.lastState = undefined;
    this.lastInterp = undefined;
    this.firstTerrain = true;
    this.lastAim = '';
  }

  /** Apply a profile at match load without tying protected detail to optional effects. */
  private applyGraphicsTier(): void {
    const engine = this.engine;
    if (!engine) return;
    engine.setTier(PROTECTED_GRAPHICS_TIER);
    applyGraphicsSettings(engine.services, this.graphics);
  }

  focus(state: GameSnapshot, observer: PlayerId, overview = false): void {
    // Match load: every tank's meshes at every LOD now, not at its first sighting or LOD switch.
    this.tanks?.prebuild(state);
    this.gpuTimes.length = 0;
    this.following = !overview;
    this.releaseOrbitPointers();
    this.followedPlayer = observer;
    this.observer = observer;
    if (overview) {
      this.camera.up = [0, 1, 0];
      this.camera.position = [-22, 35, 28];
      this.orbit.reset(this.camera, [0, 10, 0]);
    } else {
      this.followCamera.update(tankOf(state, observer), this.followTarget, 0, true, this.world);
    }
    this.orbit.enabled = !this.following;
  }

  private beginManualOrbit = (event: PointerEvent): void => {
    if (!this.following || event.target !== this.canvas) return;
    if (event.pointerType === 'mouse' && event.button !== 2) return;
    event.preventDefault(); event.stopPropagation();
    this.orbitPointers.set(event.pointerId, [event.clientX, event.clientY]);
    this.canvas.setPointerCapture(event.pointerId);
    this.host.focus({ preventScroll: true });
  };

  private moveManualOrbit = (event: PointerEvent): void => {
    const previous = this.orbitPointers.get(event.pointerId);
    if (!previous) return;
    event.preventDefault(); event.stopPropagation();
    const dx = event.clientX - previous[0], dy = event.clientY - previous[1];
    if (this.orbitPointers.size > 1) {
      const other = [...this.orbitPointers].find(([id]) => id !== event.pointerId)![1];
      const before = Math.sqrt((previous[0] - other[0]) ** 2 + (previous[1] - other[1]) ** 2);
      previous[0] = event.clientX; previous[1] = event.clientY;
      const after = Math.sqrt((previous[0] - other[0]) ** 2 + (previous[1] - other[1]) ** 2);
      if (before > 1 && after > 1) this.followCamera.zoom(Math.log(before / after) / .0015);
      this.followCamera.orbit(dx / this.orbitPointers.size, dy / this.orbitPointers.size);
    } else {
      this.followCamera.orbit(dx, dy);
      previous[0] = event.clientX; previous[1] = event.clientY;
    }
  };

  private endManualOrbit = (event: PointerEvent): void => {
    if (!this.orbitPointers.delete(event.pointerId)) return;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
  };

  private releaseOrbitPointers(): void {
    for (const id of this.orbitPointers.keys()) if (this.canvas.hasPointerCapture(id)) this.canvas.releasePointerCapture(id);
    this.orbitPointers.clear();
  }

  private orbitContextMenu = (event: MouseEvent): void => {
    if (event.target === this.canvas) event.preventDefault();
  };

  private zoomFollow = (event: WheelEvent): void => {
    if (!this.following || event.target !== this.canvas || event.defaultPrevented || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.host.clientHeight : 1);
    this.followCamera.zoom(pixels);
  };

  /** Touch gestures (ui/input/gestures.ts) drive the camera through these: an orbit drag in CSS px, a zoom in wheel pixels. */
  orbitCamera(dx: number, dy: number): void { if (this.following) this.followCamera.orbit(dx, dy); else this.orbit.rotateBy(dx, dy); }
  zoomCamera(pixels: number): void { if (!pixels) return; if (this.following) this.followCamera.zoom(pixels); else this.orbit.zoomBy(pixels); }
  /** The camera's right direction in world space (camera-relative driving reads screen directions with it). */
  cameraRight(): V3 { const m = this.camera.worldMatrix; return [m[0], m[1], m[2]]; }
  /** The camera follows the observer's tank (false in the planet overview). */
  isFollowing(): boolean { return this.following; }

  /** The observer's team mates (W1-GAME sets `team` on every tank; v1 snapshots have none, so nobody is an ally). */
  private allyOf(state: GameSnapshot, observer: number): (tank: TankState) => boolean {
    const team = (state.tanks.find(t => t.id === observer) as TeamTank | undefined)?.team;
    return tank => tank.id !== observer && team !== undefined && (tank as TeamTank).team === team;
  }

  /**
   * Observation rule: the observer, its team mates and every tank it currently sees. With W1-GAME's per-target
   * `observations` (N tanks, indexed by observer id × target id) the target's own entry decides; a v1 snapshot has only
   * the observer's primary contact, which then covers every other tank.
   */
  private visibleTo(state: GameSnapshot, observer: number): (tank: TankState) => boolean {
    const seen = (state as NTankSnapshot).observations?.[observer];
    const contact = state.contacts[observer];
    const ally = this.allyOf(state, observer);
    return tank => {
      if (tank.id === observer || ally(tank)) return true;
      if (!(seen ? Boolean(seen[tank.id]?.visible) : Boolean(contact?.visible))) return false;
      if (this.devFog !== true || state.fog !== false) return true;
      const key = `${observer}:${tank.id}`;
      if (!this.devSightCache.has(key)) this.devSightCache.set(key, this.devSightQuery?.(observer, tank.id) ?? false);
      return this.devSightCache.get(key)!;
    };
  }

  setDevSightQuery(query: (observer: PlayerId, target: PlayerId) => boolean): void { this.devSightQuery = query; this.devSightCache.clear(); }

  private pixelsPerUnitAt(p: V3): number {
    const d = Math.max(0.1, distance(this.camera.position, p));
    return this.cssSize[1] / (2 * Math.tan(FOV_DEGREES * Math.PI / 180 / 2) * d);
  }
  private readonly sensorFrame = new Float64Array(16);

  private sensorOrigins: V3[] = [];

  /**
   * Read-only visibility diagnostics for the validation gates (docs/visibility-architecture.md): the GPU soft visibility and SDF
   * values at world points, the simulation's exact line of sight, the current sensors and the build stats.
   */
  visibilityDebug() {
    const scene = () => this.engine?.services.scene;
    return {
      stats: () => ({ sdf: scene()?.get('sdf')?.stats() ?? null, sdfValid: !!scene()?.get('sdf')?.valid, fogActive: !!scene()?.get('fogOfWar')?.active,
        custom: this.engine?.telemetry().custom ?? {} }),
      probe: (points: { position: readonly number[]; normal?: readonly number[] }[]) => scene()?.get('fogOfWar')?.probe(points) ?? Promise.resolve([] as number[]),
      sdf: (points: readonly (readonly number[])[]) => scene()?.get('sdf')?.sample(points) ?? Promise.resolve([] as number[]),
      raycast: (origin: V3, direction: V3, maxDistance: number) => this.world?.raycast(origin, direction, maxDistance) ?? null,
      surface: (direction: V3) => this.world?.surface(direction) ?? null,
      pickAimTarget: (point: readonly [number, number]) => this.pickAimTarget(point)?.point ?? null,
      pickAimSelection: (point: readonly [number, number]) => this.pickAimTarget(point),
      aimPickStats: () => this.tanks?.aimPickStats() ?? null,
      aimTargets: () => this.aimTargetDiagnostics(),
      project: (point: V3) => this.worldToScreen(point),
      sensors: () => this.sensorOrigins.map(o => [...o] as V3),
      /** Benchmark: rebuild the SDF over a world box every frame for `frames` frames, then report the rolling pass costs. */
      benchmarkRebuild: async (min: V3, max: V3, frames = 120) => {
        const sdf = scene()?.get('sdf');
        if (!sdf) return null;
        for (let i = 0; i < frames; i++) { sdf.rebuildBox(min, max); await new Promise(r => requestAnimationFrame(r)); }
        const passes = this.engine?.telemetry().gpu.passes ?? [];
        return { stats: sdf.stats(), passes: Object.fromEntries(passes.filter(p => p.name.startsWith('sdf')).map(p => [p.name, p.ms])) };
      },
    };
  }

  /**
   * The ?dev panel's handles (app/dev-panel.ts): the engine's facets and settings (undefined until the renderer is up),
   * its telemetry, the time-of-day offset, and where the observed tank and the camera are.
   */
  /** Fluid probes: the basins of the initial fill, the sea level, the water's stats. */
  fluidsDebug() {
    const fluids = () => this.engine?.services.scene.get('fluids');
    return {
      stats: () => fluids()?.stats() ?? null,
      basins: () => (fluids()?.basins ?? []).map(b => ({ ...b })),
      seaLevel: () => fluids()?.seaLevel ?? null,
      resolve: () => fluids()?.resolve(),
      shorePoints: (count?: number, material?: 'water' | 'lava') => fluids()?.shorePoints(count, material) ?? [],
      /** Refill the water from the last basin solve. */
      refill: () => fluids()?.refill(),
      /** The last volumes read back from the water (u³; about twice a second). */
      volume: () => { const st = fluids()?.stats(); return st ? { water: st.water, lava: st.lava, openSea: st.openSea } : null; },
      /** Dev: drive a tank-sized hull (not drawn) from one world point to another at `speed` u/s (null removes it). */
      testHull: (from: V3 | null, to?: V3, speed = 2.5) => fluids()?.testHull(from, to, speed),
      /** Lava vents (volcanic planets): where, and whether each erupts now. */
      vents: () => fluids()?.vents() ?? [],
      /** Dev: switch the graphics tier live (the fluids reallocate and refill), for tier captures. */
      setTier: (tier: 'low' | 'medium' | 'high' | 'ultra') => this.engine?.setTier(tier),
      /** Dev: a blast in the water at a world point, without a crater. */
      pulse: (point: V3, radius = 2.25) => fluids()?.impulse(point, radius),
      /** The water at world points: depths, the ground and the surface radius (0 = dry). */
      probe: (points: V3[]) => fluids()?.probe(points) ?? Promise.resolve([]),
      /**
       * An impact at a world point, presented as the view presents one (flash, pending crater, liquids) without the
       * simulation: the crater stays pending for `hold` seconds and is never committed. Blast radius as the cannon's.
       */
      breach: (point: V3, radius = 2.25, hold = 8) => {
        const state = this.lastState;
        if (!state) return false;
        const r = Math.hypot(point[0], point[1], point[2]);
        const normal: V3 = [point[0] / r, point[1] / r, point[2] / r];
        this.onGameEvent({ type: 'impact', position: point, normal, radius, owner: 0 }, state);
        if (hold > 8) {
          const cut = craterProfile(point, normal, radius);
          this.terrain?.pending.add(`dev-breach:${this.clock.toFixed(3)}`, cut.center, cut.radius, this.clock + hold - 8);
        }
        return true;
      },
      /** Dev capture setups: orbit a world point from `height` above it and `back` along a tangent (leaves follow mode). */
      lookAt: (target: V3, height = 4, back = 5, azimuth = 0) => {
        const up = cameraUnit(target);
        let side = cross([0, 1, 0], up);
        if (dot(side, side) < 1e-6) side = [1, 0, 0];
        side = cameraUnit(side);
        const tangent = add(mul(cross(up, side), Math.cos(azimuth)), mul(side, Math.sin(azimuth)));
        this.following = false;
        this.orbit.minDistance = 0.05;
        this.camera.position = add(add(target, mul(up, height)), mul(tangent, -back));
        this.orbit.enabled = true;
        this.orbit.reset(this.camera, target);
      },
    };
  }

  devControls() {
    return {
      scene: () => this.engine?.services.scene,
      settings: () => this.engine?.services.settings,
      telemetry: () => this.engine?.telemetry(),
      compileStats: () => this.engine?.compileStats(),
      vehicleAppearance: (id = 0) => this.tanks?.appearanceSnapshot(id) ?? null,
      dayOffset: () => this.dayOffset,
      /** Fog of war shown regardless of the match rules (true), hidden (false), or as the rules say (undefined). */
      fog: () => this.devFog,
      setFog: (on: boolean | undefined) => { this.devFog = on; this.devSightCache.clear(); },
      setDayOffset: (fraction: number) => { this.dayOffset = Number.isFinite(fraction) ? fraction : 0; },
      seed: () => this.terrainSeed,
      camera: () => ({ eye: [...this.camera.position], target: [...(this.following ? this.followTarget : this.orbit.target)], following: this.following }),
      tank: () => this.lastState && this.observer !== undefined ? [...tankOf(this.lastState, this.observer).position] : null,
      pickAimTarget: (point: readonly [number, number]) => this.pickAimTarget(point)?.point ?? null,
      pickAimSelection: (point: readonly [number, number]) => this.pickAimTarget(point),
      aimPickStats: () => this.tanks?.aimPickStats() ?? null,
      aimTargets: () => this.aimTargetDiagnostics(),
      aimHit: () => {
        const target = this.following ? this.followTarget : this.orbit.target;
        const direction = cameraUnit(sub(target, this.camera.position));
        return this.world?.raycast(this.camera.position, direction, 120) ?? null;
      },
      overview: () => { if (this.lastState) this.focus(this.lastState, this.observer, true); },
      follow: () => { if (this.lastState) this.focus(this.lastState, this.observer); },
      inspectWater: async (underwater = false, material: 'auto' | 'water' | 'lava' = 'auto') => {
        const fluids = this.engine?.services.scene.get('fluids');
        if (!fluids?.stats().ready || !this.world) return false;
        let point: V3 | undefined, score = Infinity;
        // A low terrain point need not belong to a connected basin. Inspect the
        // live GPU water, rather than assuming everything below sea level is wet.
        const candidates: V3[] = Array.from({ length: 512 }, (_, i) => {
          const y = 1 - (i + 0.5) / 256, a = i * 2.399963229728653, r = Math.sqrt(1 - y * y);
          return [Math.cos(a) * r, y, Math.sin(a) * r];
        });
        const samples = (await Promise.all(Array.from({ length: 8 }, (_, i) => fluids.probe(candidates.slice(i * 64, i * 64 + 64))))).flat();
        const inspectLava = material === 'lava' || (material === 'auto' && !underwater && this.engine?.services.scene.get('planet')?.kind === 'volcanic');
        for (let i = 0; i < samples.length; i++) {
          const depth = inspectLava ? samples[i].lava : samples[i].water;
          if (depth < (underwater ? (inspectLava ? 0.25 : 1.0) : 0.12) || depth > (underwater ? 4.0 : 1.3)) continue;
          const rank = Math.abs(depth - (underwater ? (inspectLava ? 0.7 : 2.0) : 0.4)) + (1 - candidates[i][1]) * 0.8;
          if (rank < score) { score = rank; point = mul(candidates[i], samples[i].surface); }
        }
        if (!point) return false;
        const up = cameraUnit(point), tangent = cameraUnit(cross([1, 0, 0], up));
        this.following = false; this.orbit.enabled = true; this.releaseOrbitPointers();
        this.orbit.minDistance = underwater ? 0.05 : 4;
        this.camera.up = up; this.camera.position = add(add(point, mul(up, underwater ? (inspectLava ? -0.10 : -0.65) : 5)), mul(tangent, underwater ? (inspectLava ? 0.1 : 0.5) : 7));
        this.orbit.reset(this.camera, point); return true;
      },
      burst: (position: V3, radius = 2.5, munition: MunitionId = 'explosive') => {
        const normal = cameraUnit(position);
        this.engine?.services.scene.get('fluids')?.impulse(position, radius, normal, munition);
        this.burst(position, radius, normal, munition);
      },
    };
  }

  /** Explicit renderbench URL only: real-game qualification, without exposing these setters to normal play. */
  benchmarkControls() {
    if (!new URLSearchParams(location.search).has('renderbench')) throw new Error('Renderer qualification requires ?renderbench');
    return {
      engine: () => this.engine,
      setTime: (time: number, skyTime: number) => { this.clock = time; this.dayOffset = (skyTime - (this.lastState?.time ?? 0)) / DAY_SECONDS; },
      setCamera: (rig: CameraRig) => {
        this.following = false; this.orbit.enabled = false;
        this.camera.position = [...rig.position]; this.camera.up = [...rig.up];
        this.camera.fov = rig.fovY * 180 / Math.PI;
        this.orbit.minDistance = .05;
        this.orbit.reset(this.camera, [...rig.target]); this.camera.lookAt(this.orbit.target);
        this.camera.updateProjection(); this.camera.updateWorld();
      },
    };
  }

  /** Simulation seconds that drive the sun and moon, shifted by the time-of-day offset (?dayOffset=, the dev panel). */
  setCampaignTime(fraction: number | undefined): void { this.campaignDay = fraction; }
  private campaignDay: number | undefined;
  private skyTime(): number {
    if (this.campaignDay !== undefined) return this.campaignDay * DAY_SECONDS;
    return (this.lastState?.time ?? 0) + this.dayOffset * DAY_SECONDS;
  }
  /** Fraction of a local day added to the sun and moon (dev looks only; presentation, never the simulation). */
  private dayOffset = ((v: number) => Number.isFinite(v) ? v : 0)(Number(new URLSearchParams(location.search).get('dayOffset') ?? 0));

  /** A tank's rendered pose this frame (computed once per frame and shared: read it, never keep it). */
  private poseOf(state: GameSnapshot, tank: TankState, interp?: SimInterpolation) {
    return this.tanks ? this.tanks.pose(state, tank, interp) : renderedPose(state, tank, interp);
  }

  /** Pose used by the frame just rendered, for screen-space indicators attached to a moving unit. */
  renderedTankPose(id: number) {
    const state = this.lastState, tank = state?.tanks.find(t => t.id === id);
    return state && tank ? this.poseOf(state, tank, this.lastInterp) : null;
  }

  update(state: GameSnapshot, observer: PlayerId, dt: number, preview: () => V3[] | TrajectoryPrediction, fullPreview: boolean, interp?: SimInterpolation, freeDrive = false): void {
    this.devSightCache.clear();
    this.lastState = state;
    this.lastInterp = interp;
    this.observer = observer;
    this.tanks?.beginFrame(state, interp);
    const damage = this.hitFeedback.update(tankOf(state, observer), dt);
    if (damage > 0) this.followCamera.addTrauma(Math.min(.24, .09 + damage));
    if (this.following) {
      // Pass-and-play can change the observed tank; snap instead of cutting through the planet.
      this.followCamera.update(this.poseOf(state, tankOf(state, observer), interp), this.followTarget, dt, observer !== this.followedPlayer, this.world, this.cameraConstraints);
      this.followedPlayer = observer;
    } else {
      this.orbit.update(this.camera, dt);
      if (this.world) keepOverviewOutsideTerrain(this.camera, this.world);
      this.camera.lookAt(this.orbit.target);
      this.camera.updateWorld();
    }
    if (!this.engine || !this.tanks || !this.shells || !this.flashes || !this.terrain) return;
    if (!this.matchSun) {
      this.sunSpawn = [...tankOf(state, observer).position];
      this.matchSun = matchSun(this.sunSpawn, this.terrainSeed);
    }
    const visible = this.visibleTo(state, observer);
    const fog = this.engine.services.scene.get('fogOfWar');
    const fogEnabled = (this.devFog ?? state.fog !== false) && !!this.world;
    if (fogEnabled && fog && this.world) {
      const own = tankOf(state, observer);
      // The team's living sensors (the engine keeps the nearest few by tier); tanks are receivers, never occluders.
      const sources = [own, ...state.tanks.filter(t => t.id !== observer && own.team !== undefined && t.team === own.team)].filter(t => t.health > 0);
      const origins = sources.map(t => {
        const pose = this.poseOf(state, t, interp);
        const sensor = assembleKit(tankKit(t)).frames.sensor.position;
        return transformPoint(composeTRS(pose.position, pose.rotation, this.sensorFrame), sensor);
      });
      fog.set(origins, this.world);
      this.sensorOrigins = origins.map(o => [o[0], o[1], o[2]] as V3);
    } else { fog?.clear(); this.sensorOrigins = []; }
    const ally = this.allyOf(state, observer);
    this.tanks.update(state, dt, visible, p => this.pixelsPerUnitAt(p), interp,
      t => fogEnabled && t.id !== observer && !ally(t));
    const scene = this.engine.services.scene;
    if (this.vehicleDebug) scene.get('debugLines')?.set(this.tanks.debugSegments({ ...state, tanks: state.tanks.filter(t => t.id === observer) }));
    this.shells.update(state, observer, this.world, dt, interp);
    this.flashes.update(dt);
    this.tracers?.update(dt);
    this.vehicleDamage?.update(state, dt, visible);
    this.muzzles?.update(dt);
    const contact = state.contacts[observer];
    this.markerRing = contact && !contact.visible ? {
      center: [...contact.position] as V3, radius: RING_STYLE.marker.radius * (1 + Math.min(3, (state.time - contact.observedAt) * .04)),
      width: RING_STYLE.marker.width, color: RING_STYLE.marker.color, alpha: RING_STYLE.marker.alpha,
    } : null;
    this.scanAge += dt;
    const rings: OverlayRing[] = [];
    if (this.markerRing) rings.push(this.markerRing);
    if (this.incoming.length) {
      const style = RING_STYLE.incoming;
      this.incoming = this.incoming.filter(ring => state.time <= ring.impact + 0.15);
      for (const ring of this.incoming) {
        const t = Math.min(1, Math.max(0, (state.time - ring.start) / Math.max(1e-3, ring.impact - ring.start)));
        rings.push({ center: ring.center, radius: style.from + (style.to - style.from) * t, width: style.width, color: style.color, alpha: style.alpha * (0.55 + 0.45 * t) },
          { center: ring.center, radius: style.to * 0.35, width: style.width * 0.6, color: style.color, alpha: style.alpha * t });
      }
    }
    if (this.scanAge < RING_STYLE.scan.duration) {
      rings.push({ center: this.scanPosition, radius: .2 + this.scanAge * RING_STYLE.scan.speed, width: RING_STYLE.scan.width + this.scanAge * .05,
        color: RING_STYLE.scan.color, alpha: RING_STYLE.scan.alpha * (1 - this.scanAge / RING_STYLE.scan.duration) });
    }
    const own = tankOf(state, observer);
    const { identity: previewIdentity, refresh: previewRefresh } = trajectoryPreviewKeys(state, own, observer,
      this.world?.footprintSurface?.version ?? this.world?.version, fullPreview, this.world?.version);
    // Target motion refreshes prediction without resetting interpolation history on every rendered pose.
    const aimKey = `${previewRefresh}/${this.aimColliderKey}/${freeDrive}`;
    if (aimKey !== this.lastAim) {
      this.lastAim = aimKey;
      const prediction = own.health > 0 && trajectoryPreviewAllowed(state, observer, freeDrive) ? preview() : [];
      const points = Array.isArray(prediction) ? prediction : prediction.points;
      const hit = !Array.isArray(prediction) && prediction.hit;
      this.trajectory.set(points, state.tick, previewIdentity, fullPreview || points.length < 8);
      this.trajectoryTarget = trajectoryTarget(points, own.position, this.world?.radius, fullPreview, hit,
        !Array.isArray(prediction) && prediction.hitTarget === true);
    }
    this.previewPoints = this.trajectory.render(interp?.alpha ?? 1, this.tanks.muzzle(observer)?.position ?? null);
    scene.get('overlays')?.setRibbon(this.previewPoints.length > 1 ? this.previewPoints : null);
    if (this.trajectoryTarget?.kind === 'landing') {
      const center = this.trajectoryTarget.position;
      rings.push({ center, radius: .38, width: .12, color: [.006, .018, .014], alpha: .95 },
        { center, radius: .38, width: .055, color: [.55, 1, .82], alpha: .95 },
        { center, radius: .06, width: .04, color: [.8, 1, .92], alpha: .95 });
    }
    scene.get('overlays')?.setRings(rings);
    this.terrain.frame(this.tanks.trackStamps(state, visible), this.clock);
    if (this.world) this.debris?.update(this.world, dt, state.tanks);
    for (const p of this.presenters) { try { p.onUpdate?.(state, dt, interp); } catch (error) { console.error(`[view] presenter ${p.name} onUpdate failed`, error); } }
  }

  burst(position: V3, radius: number, normal: V3 = position, munition: MunitionId = 'explosive'): void {
    const scale = MUNITIONS[munition].effect === 'nuclear' ? 1.6 : 1;
    this.engine?.services.scene.get('grass')?.impact(position, radius * scale);
    this.engine?.services.scene.get('clouds')?.impact(position, radius, this.clock, MUNITIONS[munition].effect);
    this.flashes?.impact(position, normal, radius * scale, munition);
  }

  radar(position: V3): void {
    this.scanPosition = [...position] as V3;
    this.scanAge = 0;
  }

  /** The camera the engine renders this frame (shake included), as a CameraRig. */
  private engineRig(): CameraRig {
    const e = this.camera.worldMatrix;
    const p = this.camera.position;
    return {
      position: [...p], target: [p[0] - e[8], p[1] - e[9], p[2] - e[10]], up: [e[4], e[5], e[6]],
      fovY: lensFovY(this.camera.fov * Math.PI / 180, this.graphics.fisheye), viewOffset: this.viewOffset,
    };
  }

  render(frameMs: number): void {
    if (this.disposed || !this.engine) return;
    const engine = this.engine;
    if (frameMs > 0 && frameMs < 1000) { this.frameTimes.push(frameMs); if (this.frameTimes.length > 180) this.frameTimes.shift(); }
    const dt = Math.min(.1, Math.max(0, frameMs / 1000));
    this.lastFrameDt = dt;
    this.clock += dt;
    const focus = this.following ? this.followCamera.focus : this.orbit.target;
    const input: FrameInput = {
      time: this.clock, dt, camera: this.engineRig(),
      ...(this.matchSun && this.sunSpawn ? {
        sun: { dirToward: sunAtTime(this.matchSun, this.sunSpawn, this.skyTime()), illuminance: SUN_ILLUMINANCE },
        moon: { dirToward: moonAtTime(this.matchSun, this.sunSpawn, this.skyTime()) },
      } : {}),
      ...(this.lastState?.wind ? { wind: { axis: [...this.lastState.wind.axis] as [number, number, number], bars: this.lastState.wind.bars } } : {}),
      focus: { world: [...focus], tilt: 0.5, distance: this.following ? this.followCamera.effectiveDistance : this.orbit.orbitDistance },
      pendingCuts: this.terrain?.pending.frameInput(this.clock) ?? [],
    };
    for (const p of this.presenters) { try { p.frameInput?.(input, this.lastState); } catch (error) { console.error(`[view] presenter ${p.name} frameInput failed`, error); } }
    const lighting = engine.services.scene.get('lighting');
    if (lighting && lighting.structures !== this.shadowStructures) lighting.structures = this.shadowStructures;
    engine.frame(input);
    const state = this.lastState;
    // The readouts lay out against the host and the HUD: read them before this frame's first DOM write, since a layout
    // read after a style write forces a synchronous layout. Labels never change the host's size (absolute children).
    const trajectoryTarget = state ? this.trajectoryTarget : null;
    const readouts = !!trajectoryTarget || this.aimTargetReadout.active;
    const width = readouts ? this.host.clientWidth : 0, height = readouts ? this.host.clientHeight : 0;
    if (readouts) this.trajectoryReadout.measureObstacles(width, height);
    // Labels use the projection of the frame just drawn, so they match worldToScreen exactly, and follow the same
    // interpolated pose as the tank meshes.
    if (state) {
      this.labels.update(state, this.observer, this.visibleTo(state, this.observer), p => this.worldToScreen(p), {
        positionOf: tank => this.poseOf(state, tank, this.lastInterp).position,
        allyOf: this.allyOf(state, this.observer),
        reference: p => this.referenceProjection(p),
      });
    } else this.labels.hideAll();
    const selectedId = /^(?:tank|component):(\d+)/.exec(this.aimTargetReadout.selectedObjectId ?? '');
    const selectedTank = selectedId && state?.tanks.find(tank => tank.id === Number(selectedId[1]));
    if (selectedId && (!selectedTank || selectedTank.health <= 0 || !this.visibleTo(state!, this.observer)(selectedTank))) this.aimTargetReadout.set(null);
    const bodyBounds = this.aimTargetReadout.active && selectedTank ? this.tanks?.screenBounds(selectedTank.id, p => this.worldToScreen(p)) : null;
    const requestedMarker = this.aimTargetReadout.markerObstacle(p => this.worldToScreen(p), bodyBounds);
    this.trajectoryReadout.update(trajectoryTarget, p => this.worldToScreen(p), width, height,
      trajectoryTargetOccluded(trajectoryTarget, this.camera.position, this.world), requestedMarker ? [requestedMarker] : []);
    if (this.aimTargetReadout.active) this.aimTargetReadout.update(p => this.worldToScreen(p), width, height, this.trajectoryReadout.targetObstacles(width, height),
      this.trajectoryReadout.hudObstacles(width, height), bodyBounds);
    if (++this.gpuSampleFrame % 10 === 0) {
      const gpu = engine.gpuTotal();
      if (gpu.timestamps && gpu.total > 0) { this.gpuTimes.push(gpu.total); if (this.gpuTimes.length > 120) this.gpuTimes.shift(); }
    }
  }

  telemetry(): { fps: number; p95: number; maxFrameMs: number; draws: number; triangles: number; gpuMs?: number; gpuP95?: number; gpuSamples: number;
    surfaceDetail: TerrainDetail; materialBakeMs: number; materialBytes: number; footprintCount: number; footprintBytes: number; presentationMilliseconds: number; runningGear: 'engine' | 'typescript';
    passes: { name: string; ms: number }[]; gpu: { total: number; passes: { name: string; ms: number }[] }; pagesDrawn: number; pagesTotal: number;
    tanks: number; shells: number; projectileTrails: { particles: number; emitters: number; capacity: number }; flashes: number; muzzles: { active: number; total: number }; lights: number; shadowLights: number; smc: Record<string, number>; validationErrors: number; compileErrors: number; pendingCuts: number;
    visuals: { grassSites: number; liquidReady: boolean; liquidSteps: number; gas: number; gasSteps: number; debris: number; debrisThread: 'worker' | 'main' | 'none' };
    fogCrossingNodes: number; fogCrossingOverflow: number;
    renderer: Pick<import('../engine/contracts').EngineTelemetry, 'tier' | 'vram' | 'compile'> | null;
    fluidStartup: { solveMs: number; solves: number; ready: boolean } | null;
    shockwaves: ReturnType<ShockwaveFacet['stats']> | null;
    trajectory: ReturnType<TrajectoryPreview['stats']>;
    trajectoryReadout: ReturnType<TrajectoryReadout['snapshot']>;
    aimTarget: ReturnType<AimTargetReadout['snapshot']>;
    planetPipeline: string; labels: ReturnType<TankLabels['snapshot']>; overlays: { ribbonPoints: number; rings: number; peakRings: number; route: 'overlay' | 'transparent'; consumed: boolean | null } | null } {
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const gpuSorted = [...this.gpuTimes].sort((a, b) => a - b);
    const average = this.frameTimes.reduce((sum, value) => sum + value, 0) / Math.max(1, this.frameTimes.length);
    const engine = this.engine?.telemetry();
    const terrain = this.scene?.terrain.stats();
    const smc = this.engine?.services.scene.get('surfaceMemory')?.stats();
    const overlays = this.engine?.services.scene.get('overlays')?.stats() ?? null;
    const passes = engine?.gpu.passes ?? [];
    return {
      fps: average ? 1000 / average : 0, p95: sorted[Math.floor(sorted.length * .95)] ?? 0, maxFrameMs: sorted.at(-1) ?? 0,
      draws: engine?.draws ?? 0, triangles: engine?.triangles ?? 0,
      gpuMs: engine?.gpu.timestamps ? engine.gpu.total : undefined, gpuP95: gpuSorted.length ? gpuSorted[Math.floor(gpuSorted.length * .95)] : undefined,
      gpuSamples: gpuSorted.length, surfaceDetail: this.terrainDetail,
      materialBakeMs: terrain?.bakeMs ?? 0, materialBytes: terrain?.bakeBytes ?? 0,
      footprintCount: smc?.stamps ?? 0, footprintBytes: smc?.bytes ?? 0,
      presentationMilliseconds: this.presentationMilliseconds, runningGear: runningGearPoser(),
      passes, gpu: { total: engine?.gpu.total ?? 0, passes }, pagesDrawn: terrain?.pagesDrawn ?? 0, pagesTotal: terrain?.pagesTotal ?? 0,
      tanks: this.tanks?.stats().visible ?? 0, shells: this.shells?.count ?? 0, flashes: this.flashes?.total ?? 0,
      projectileTrails: this.shells?.trails.snapshot() ?? { particles: 0, emitters: 0, capacity: 0 },
      muzzles: { active: this.muzzles?.active ?? 0, total: this.muzzles?.total ?? 0 },
      visuals: { grassSites: this.engine?.services.scene.get('grass')?.sites ?? 0,
        liquidReady: this.engine?.services.scene.get('fluids')?.stats().ready ?? false, liquidSteps: this.engine?.services.scene.get('fluids')?.stats().substeps ?? 0,
        gas: this.engine?.services.scene.get('fluids')?.stats().gasLive ?? 0, gasSteps: this.engine?.services.scene.get('fluids')?.stats().gasDrawn ?? 0, debris: this.debris?.active ?? 0, debrisThread: this.debris?.thread ?? 'none' },
      lights: this.engine?.services.scene.get('lightSystem')?.count ?? 0,
      shadowLights: this.engine?.services.scene.get('lightSystem')?.shadowCasters().length ?? 0,
      smc: smc ? { ...smc } : {}, validationErrors: engine?.validationErrors ?? 0, compileErrors: engine?.compile.errors ?? 0,
      renderer: engine ? { tier: engine.tier, vram: engine.vram, compile: engine.compile } : null,
      fluidStartup: (() => { const f = this.engine?.services.scene.get('fluids')?.stats(); return f ? { solveMs: f.solveMs, solves: f.solves, ready: f.ready } : null; })(),
      shockwaves: this.engine?.services.scene.get('shockwaves')?.stats() ?? null,
      trajectory: this.trajectory.stats(),
      trajectoryReadout: this.trajectoryReadout.snapshot(),
      aimTarget: this.aimTargetReadout.snapshot(),
      pendingCuts: this.terrain?.pending.size ?? 0, fogCrossingNodes: engine?.custom.fogCrossingNodes ?? 0,
      fogCrossingOverflow: engine?.custom.fogCrossingOverflow ?? 0,
      planetPipeline: terrain?.planetPipeline ?? 'none', labels: this.labels.snapshot(), overlays,
    };
  }

  private resize(): void {
    const width = Math.max(1, this.host.clientWidth), height = Math.max(1, this.host.clientHeight);
    this.cssSize = [width, height];
    this.dpr = Math.min(devicePixelRatio || 1, DEVICE_PIXEL_RATIO_CAP);
    this.camera.aspect = width / height;
    // The follow camera frames the tank at the centre on every screen shape: the mobile HUD keeps to the edges, so
    // the old portrait shift (26 % up, made for panels over the lower battlefield) is gone. The rig still accepts an offset.
    this.viewOffset = undefined;
    this.camera.updateProjection();
    this.engine?.resize(width, height, this.dpr);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.host.removeEventListener('pointerdown', this.beginManualOrbit, true);
    this.host.removeEventListener('pointermove', this.moveManualOrbit, true);
    this.host.removeEventListener('pointerup', this.endManualOrbit, true);
    this.host.removeEventListener('pointercancel', this.endManualOrbit, true);
    this.host.removeEventListener('lostpointercapture', this.endManualOrbit, true);
    this.host.removeEventListener('contextmenu', this.orbitContextMenu);
    this.host.removeEventListener('wheel', this.zoomFollow, true);
    this.resizeObserver.disconnect();
    window.removeEventListener(SETTINGS_EVENT, this.onSettings);
    this.orbit.dispose();
    this.reset();
    for (const p of this.presenters.splice(0).reverse()) { try { p.dispose?.(); } catch (error) { console.warn(`[view] presenter ${p.name} dispose failed`, error); } }
    this.tanks?.dispose(); this.shells?.dispose(); this.flashes?.dispose(); this.tracers?.dispose(); this.vehicleDamage?.dispose(); this.hitFeedback.dispose(); this.muzzles?.dispose(); this.debris?.dispose();
    this.projectileTrails?.dispose();
    this.engine?.dispose();
    this.engine = undefined;
    this.aimTargetProviders.clear();
    this.host.replaceChildren();
  }

  cameraTelemetry() {
    const target = this.following ? this.followTarget : this.orbit.target;
    return { following: this.following, position: [...this.camera.position], target: [...target], requestedDistance: this.followCamera.distance,
      effectiveDistance: this.followCamera.effectiveDistance, altitude: this.followCamera.altitude, trauma: this.followCamera.trauma,
      insideTerrain: this.world?.isSolid(this.camera.position),
      touchingTerrain: this.world?.sweepSphere?.(this.camera.position, [0, 1, 0], 0, .27) !== null && !!this.world?.sweepSphere };
  }

  /** Presentation of simulation events: impacts flash and announce their pending crater, commits retire it, scans pulse. */
  onGameEvent(event: ViewEvent, state: GameSnapshot): void {
    if (event.type === 'radar') { this.radar(event.position); return; }
    if (event.type === 'kill') {
      const tank = state.tanks.find(t => t.id === event.tank);
      if (tank && (tank.id === this.observer || this.visibleTo(state, this.observer)(tank))) this.burst(tank.position, 1.25, tank.position, 'incendiary');
    }
    if (event.type === 'impact') {
      // The pending crater is carved into the distance field at once: retire the boxes it reaches now, not at the commit.
      const cut = event.cut ?? { center: event.position, radius: event.radius };
      if (!event.noCrater) this.retireShadowStructures(cut.center.map(v => v - cut.radius), cut.center.map(v => v + cut.radius));
      this.tanks?.impact(event);
      if (this.world && !event.noCrater) this.debris?.impact(event, this.world);
      this.burst(event.position, event.radius, event.normal, event.munition);
      if (!event.noCrater) this.terrain?.impact(event, this.clock);
      const d = distance(this.camera.position, event.position);
      this.followCamera.addTrauma(0.55 * Math.max(0, 1 - d / Math.max(1, event.radius * 9)));
    } else if (event.type === 'incoming') {
      // The observer's own team is warned; the ring closes on the predicted point and reaches it at impact.
      const own = tankOf(state, this.observer), warned = state.tanks.find(t => t.id === event.tank);
      if (warned && (warned.id === own.id || (own.team !== undefined && warned.team === own.team)) && !this.incoming.some(r => r.impact === event.impactTick / 60 && r.center.every((v, i) => Math.abs(v - event.predicted[i]) < 0.5)))
        this.incoming.push({ center: [...event.predicted] as V3, impact: event.impactTick / 60, start: state.time });
    } else if (event.type === 'terrain-commit') {
      this.debris?.commit(event.cutIds);
      this.terrain?.commit(event.cutIds);
    } else if (event.type === 'terrain-failed') {
      this.debris?.cancel();
      this.terrain?.pending.clear(); // the announced crater never happened: the old world stays
    } else if (event.type === 'shot') {
      if (!this.shotEvents.accept(event)) return;
      this.tanks?.fire(event.player);
      const shooter = state.tanks.find(t => t.id === event.player);
      // Hidden launchers remain hidden; their audible bearing still goes through the audio hook.
      if (shooter && (event.player === this.observer || this.visibleTo(state, this.observer)(shooter))) {
        const launch = event.launch;
        if (launch) this.muzzles?.fire({ ...launch, seed: launch.id });
        // Legacy event producers have no captured identity. Do not guess it from a later weapon selection.
      }
    }
    for (const p of this.presenters) { try { p.onGameEvent?.(event, state); } catch (error) { console.error(`[view] presenter ${p.name} onGameEvent failed`, error); } }
  }

  /** Realtime presentation events (coax tracers). A hidden shooter's rounds show only where they land on something
   * the observer can see. */
  onRealtimeEvent(event: RealtimeEvent, state: GameSnapshot): void {
    if (event.type !== 'tracer' || !this.tracers) return;
    const visible = this.visibleTo(state, this.observer), shooter = state.tanks.find(t => t.id === event.owner), victim = event.victim === null ? null : state.tanks.find(t => t.id === event.victim);
    const normal = normalize(sub(event.from, event.to));
    if (shooter && (shooter.id === this.observer || visible(shooter))) this.tracers.fire(event.from, event.to, normal);
    else if (victim && (victim.id === this.observer || visible(victim))) this.tracers.fire(event.to, event.to, normal);
  }

  /** Replace the pending (uncommitted) craters explicitly; the view also derives them from impact events. */
  setPendingCuts(cuts: readonly PendingCut[]): void {
    this.terrain?.replace(cuts.map(c => ({ center: [...c.center] as V3, radius: c.radius, t0: c.t0 })));
  }

  /** CSS-pixel position in the viewport, projected exactly like the tank labels (the last drawn frame); null when off screen. */
  worldToScreen(point: V3): [number, number] | null {
    if (!this.engine?.lastFrame) return null;
    const p = this.engine.project(point);
    if (!p.visible) return null;
    const screen = sceneToLens([p.x, p.y], this.cssSize, this.graphics.fisheye);
    return screen[0] >= 0 && screen[0] <= this.cssSize[0] && screen[1] >= 0 && screen[1] <= this.cssSize[1] ? screen : null;
  }

  /** CSS coordinates relative to the canvas, matched to the last rendered camera (including narrow-screen offsets). */
  pickAimTarget(cssPoint: readonly [number, number]): AimSelection | null {
    if (!this.engine?.lastFrame || !this.world) return null;
    this.tanks?.beginAimPick();
    return pickAimSelection(this.engine.camera, this.world, lensToScene(cssPoint, this.cssSize, this.graphics.fisheye), this.aimTargetProxies(),
      (object, eye, direction, limit) => object.kind === 'tank' && object.id.startsWith('tank:')
        ? this.tanks?.pickSurface(Number(object.id.slice(5)), eye, direction, limit) ?? null : undefined);
  }

  resolveAimTarget(selection: AimSelection): AimSelection | null {
    if (this.disposed || !this.world) return null;
    return resolveAimSelection(selection, this.aimTargetProxies(), this.world);
  }

  nextAimTarget(currentId?: string): AimSelection | null {
    const state = this.lastState;
    return state ? cycleVisibleTankAimTarget(state, this.observer, this.visibleTo(state, this.observer), currentId, this.lastInterp) : null;
  }

  /** Future visible objects can expose the same target proxy as tanks. Providers must omit hidden/removed objects. */
  addAimTargetProvider(provider: () => readonly AimTargetProxy[]): () => void {
    this.aimTargetProviders.add(provider);
    return () => { this.aimTargetProviders.delete(provider); };
  }

  private aimTargetProxies(): AimTargetProxy[] {
    const state = this.lastState;
    const tanks = state ? visibleTankAimProxies(state, this.observer, this.visibleTo(state, this.observer), this.lastInterp) : [];
    for (const provider of this.aimTargetProviders) tanks.push(...provider());
    return tanks;
  }

  private aimTargetDiagnostics() {
    return this.aimTargetProxies().map(object => ({ ...object, screen: this.worldToScreen(object.collider.center) }));
  }

  /** Requested cursor destination; the actual ballistic endpoint remains owned by the trajectory prediction. */
  setAimTarget(target: RequestedAimTarget | null): void {
    this.aimTargetReadout.set(target);
    const collider = target?.collider;
    this.aimColliderKey = collider ? `${collider.shape}/${collider.center.map(value => value.toFixed(3)).join(',')}/${collider.radius}` : '';
  }

  /** The camera pose's finite projection (CSS px): an independent check of engine.project for the label
   * telemetry. Null with a view offset (narrow screens), which only the engine rig applies. */
  private referenceProjection(point: V3): [number, number] | null {
    if (this.viewOffset || this.graphics.fisheye < 0) return null;
    const v = this.camera.project(point);
    if (!(v[2] >= -1 && v[2] <= 1)) return null;
    return sceneToLens([(v[0] + 1) / 2 * this.cssSize[0], (1 - v[1]) / 2 * this.cssSize[1]], this.cssSize, this.graphics.fisheye);
  }

  /** Constraints run in registration order on the follow-camera position every frame; the camera then re-aims at its target. */
  addCameraConstraint(constraint: CameraConstraint): () => void {
    this.cameraConstraints.push(constraint);
    return () => { const index = this.cameraConstraints.indexOf(constraint); if (index >= 0) this.cameraConstraints.splice(index, 1); };
  }

  /** The base camera for hooks, audio and capture overrides; the lens widens its FOV only in engineRig. */
  cameraRig(): { position: V3; target: V3; up: V3; fovY: number } {
    const target = this.following ? this.followTarget : this.orbit.target;
    return { position: [...this.camera.position], target: [...target], up: [...this.camera.up],
      fovY: this.camera.fov * Math.PI / 180 };
  }

  /** The graphics device was lost; the page must reload to recover. */
  onDeviceLost(callback: () => void): void { this.deviceLost = callback; }

  /** Frame interval of the last render (seconds). */
  get frameDt(): number { return this.lastFrameDt; }
}
