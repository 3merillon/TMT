import type { Camera } from '../../engine/frame/camera';
import type { GameSnapshot, V3, WorldQuery } from '../contracts';
import type { SimInterpolation } from '../api/extensions';
import { rotate, segmentSphere } from '../math';
import { TANK_TARGET_RADIUS, type AimSelection, type AimTargetCollider } from '../rules/aim-target';
import { setData, setHidden, setStyle } from './dom-writes';
import { renderedPose } from './tank-view';
import { placeTrajectoryLabel, type ScreenRect } from './trajectory-readout';
import { activeComponents, componentPoint } from '../realtime/components';

export interface RequestedAimTarget {
  point: V3;
  status: 'solving' | 'reachable' | 'blocked' | 'out-of-range';
  /** Distance between the requested point and the best predicted impact, in world metres. */
  error: number;
  /** The explicitly selected visible object's contact geometry, also used by the actual trajectory preview. */
  collider?: AimTargetCollider;
  objectId?: string;
}

export type AimTargetProxy = NonNullable<AimSelection['object']>;
type PickCamera = Pick<Camera, 'eye' | 'unproject' | 'cssWidth' | 'cssHeight'>;
type PickWorld = Pick<WorldQuery, 'radius' | 'raycast'> & Partial<Pick<WorldQuery, 'version' | 'footprintSurface'>>;
type ResolveWorld = Pick<WorldQuery, 'version' | 'surface' | 'footprintSurface'>;
const copyProxy = (proxy: AimTargetProxy): AimTargetProxy => ({ ...proxy, collider: { ...proxy.collider, center: [...proxy.collider.center] },
  ...(proxy.rotation ? { rotation: [...proxy.rotation] } : {}) });
const validProxy = (proxy: AimTargetProxy): boolean => proxy.collider.shape === 'sphere' && proxy.collider.radius > 0
  && Number.isFinite(proxy.collider.radius) && proxy.collider.center.every(Number.isFinite);

/** Only this observer's currently revealed, living targets are eligible. The self tank cannot steal ground picks.
 * Physics interception and cursor picking share the same sphere radius, placed at the rendered chassis pose. */
export function visibleTankAimProxies(state: GameSnapshot, observer: number, visible: (tank: GameSnapshot['tanks'][number]) => boolean,
  interpolation?: SimInterpolation): AimTargetProxy[] {
  return state.tanks.filter(tank => tank.id !== observer && tank.health > 0 && visible(tank)).flatMap(tank => {
    const pose = renderedPose(state, tank, interpolation);
    const hull: AimTargetProxy = { id: `tank:${tank.id}`, kind: 'tank', rotation: pose.rotation,
      collider: { shape: 'sphere', center: pose.position, radius: TANK_TARGET_RADIUS } };
    return [hull, ...activeComponents(tank).map(c => ({ id: `component:${tank.id}:${c.id}`, kind: 'tank' as const, rotation: pose.rotation,
      collider: { shape: 'sphere' as const, center: componentPoint(pose, c), radius: c.radius } }))];
  });
}

/** Start with the nearest revealed enemy, then wrap through the living enemies by distance. Never targets allies,
 * last-known contacts, or individual components; the whole tank remains the tracking anchor. */
export function cycleVisibleTankAimTarget(state: GameSnapshot, observer: number, visible: (tank: GameSnapshot['tanks'][number]) => boolean,
  currentId?: string, interpolation?: SimInterpolation): AimSelection | null {
  const own = state.tanks.find(tank => tank.id === observer);
  if (!own || own.health <= 0) return null;
  const enemies = visibleTankAimProxies(state, observer, tank => visible(tank) && (own.team === undefined || tank.team !== own.team), interpolation)
    .filter(proxy => proxy.id.startsWith('tank:'));
  const distance = (proxy: AimTargetProxy) => Math.hypot(...proxy.collider.center.map((v, i) => v - own.position[i]));
  enemies.sort((a, b) => distance(a) - distance(b) || Number(a.id.slice(5)) - Number(b.id.slice(5)));
  if (!enemies.length) return null;
  const current = enemies.findIndex(proxy => proxy.id === currentId || currentId?.startsWith(`component:${proxy.id.slice(5)}:`));
  const object = copyProxy(enemies[(current + 1) % enemies.length]);
  const above = rotate([0, object.collider.radius * 0.5, 0], object.rotation ?? [0, 0, 0, 1]);
  return { point: object.collider.center.map((v, i) => v + above[i]) as V3, object };
}

/** Undefined asks for the generic sphere fallback; null means the visible surface was missed. */
export type AimSurfacePick = (object: AimTargetProxy, eye: V3, direction: V3, limit: number) => number | null | undefined;
/** Explicit proxy list keeps future selectable objects extensible without querying secret simulation entities. */
export function pickAimSelection(camera: PickCamera, world: PickWorld, cssPoint: readonly [number, number], objects: readonly AimTargetProxy[] = [], surface?: AimSurfacePick): AimSelection | null {
  const [x, y] = cssPoint;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > camera.cssWidth || y > camera.cssHeight) return null;
  const direction: V3 = [...camera.unproject(x, y, 0).direction], eye: V3 = [...camera.eye];
  const reach = Math.max(120, Math.hypot(...eye) + world.radius * 3), terrain = world.raycast(eye, direction, reach);
  let nearest = terrain?.distance ?? reach;
  let result: AimSelection | null = terrain?.point.every(Number.isFinite) ? { point: [...terrain.point] } : null;
  const version = (world.footprintSurface ?? world).version, radial = result ? Math.hypot(...result.point) : 0;
  if (result && radial > 1e-8 && Number.isFinite(version)) result.terrain = {
    version: version!, direction: result.point.map(value => value / radial) as V3,
  };
  for (const object of objects) {
    const sphere = object.collider;
    if (!validProxy(object)) continue;
    const rendered = surface?.(object, eye, direction, nearest);
    const at = rendered === undefined ? segmentSphere(eye, direction, reach, sphere.center, sphere.radius) : rendered;
    if (at === null || !Number.isFinite(at) || at < 0 || at >= nearest - 1e-5) continue;
    nearest = at;
    result = { point: eye.map((value, i) => value + direction[i] * at) as V3, object: copyProxy(object) };
  }
  return result;
}

/** Retain a selected point after pointer release. A committed crater rebases its original planet bearing once;
 * moving debris and frame-to-frame ray noise cannot keep dragging the chosen ground point. */
export function resolveAimSelection(selection: AimSelection, objects: readonly AimTargetProxy[], world?: ResolveWorld): AimSelection | null {
  if (!selection.point.every(Number.isFinite)) return null;
  if (!selection.object) {
    const terrain = selection.terrain && { version: selection.terrain.version, direction: [...selection.terrain.direction] as V3 };
    if (!terrain) return { point: [...selection.point] };
    if (!terrain.direction.every(Number.isFinite) || Math.hypot(...terrain.direction) < 1e-8) return null;
    const fixed = world?.footprintSurface ?? world;
    if (!fixed || fixed.version === terrain.version) return { point: [...selection.point], terrain };
    const hit = fixed.surface(terrain.direction);
    // A through-hole can make a whole-planet ray report the opposite hemisphere. That is not the selected place.
    if (!hit || !hit.point.every(Number.isFinite) || hit.point.reduce((sum, value, i) => sum + value * terrain.direction[i], 0) <= 1e-8) return null;
    return { point: [...hit.point], terrain: { version: fixed.version, direction: terrain.direction } };
  }
  const current = objects.find(object => object.id === selection.object!.id && object.kind === selection.object!.kind);
  if (!current || !validProxy(current)) return null;
  const before = selection.object.collider, after = current.collider;
  const scale = after.radius / Math.max(1e-8, before.radius);
  let offset = selection.point.map((value, i) => (value - before.center[i]) * scale) as V3;
  if (selection.object.rotation && current.rotation) {
    const [x, y, z, w] = selection.object.rotation;
    offset = rotate(rotate(offset, [-x, -y, -z, w]), current.rotation);
  }
  return { point: offset.map((value, i) => after.center[i] + value) as V3, object: copyProxy(current) };
}

/** The last rendered camera owns projection, view offsets and TAA-independent rays. Pick only the terrain world;
 * the cursor cannot discover a hidden tank. A sky miss leaves aiming policy to the caller. */
export function pickTerrainAimPoint(camera: PickCamera, world: PickWorld, cssPoint: readonly [number, number]): V3 | null {
  return pickAimSelection(camera, world, cssPoint)?.point ?? null;
}

export function aimTargetStatusText(target: RequestedAimTarget): string {
  if (target.status === 'reachable') return '';
  if (target.status === 'solving') return 'Finding arc…';
  const label = target.collider ? 'No clear hit' : target.status === 'blocked' ? 'Blocked' : 'Out of range';
  return Number.isFinite(target.error) ? `${label} · ${Math.max(0, target.error).toFixed(1)} m miss` : label;
}

/** Requested destination has square brackets; the actual ballistic landing keeps its circular reticle and range.
 * Reachable targets do not add another label. Failed solutions identify the requested point without moving it. */
export class AimTargetReadout {
  private readonly marker: HTMLElement;
  private readonly label: HTMLElement;
  private target: RequestedAimTarget | null = null;
  private visible = false;
  private labelVisible = false;
  private screen: [number, number] | null = null;
  private bounds: ScreenRect | null = null;

  constructor(private readonly host: HTMLElement) {
    this.marker = document.createElement('div'); this.marker.className = 'requested-aim-target';
    this.label = document.createElement('div'); this.label.className = 'requested-aim-status';
    for (const element of [this.marker, this.label]) { element.setAttribute('aria-hidden', 'true'); element.hidden = true; host.append(element); }
  }

  set(target: RequestedAimTarget | null): void {
    this.target = target?.point.every(Number.isFinite) ? { ...target, point: [...target.point],
      ...(target.collider ? { collider: { ...target.collider, center: [...target.collider.center] } } : {}) } : null;
    if (!this.target) this.hide();
  }

  get active(): boolean { return this.target !== null; }
  get selectedObjectId(): string | undefined { return this.target?.objectId; }

  markerObstacle(project: (point: V3) => [number, number] | null, bodyBounds?: ScreenRect | null): ScreenRect | null {
    if (!this.target) return null;
    if (bodyBounds) return bodyBounds;
    const screen = this.target && project(this.target.point);
    return screen ? { x: screen[0] - 14, y: screen[1] - 14, width: 28, height: 28 } : null;
  }

  /** `width` × `height`: the host's client size, read before the frame's first DOM write. */
  update(project: (point: V3) => [number, number] | null, width: number, height: number, obstacles: readonly ScreenRect[], markerObstacles: readonly ScreenRect[] = obstacles, bodyBounds?: ScreenRect | null): void {
    if (!this.target) { this.hide(); return; }
    const screen = project(this.target.point);
    this.screen = screen;
    this.bounds = this.markerObstacle(project, bodyBounds);
    const covered = !bodyBounds && screen && markerObstacles.some(box => screen[0] >= box.x - 14 && screen[0] <= box.x + box.width + 14
      && screen[1] >= box.y - 14 && screen[1] <= box.y + box.height + 14);
    this.visible = !!this.bounds && !covered;
    setHidden(this.marker, !this.visible);
    setData(this.marker, 'status', this.target.status);
    setData(this.marker, 'kind', bodyBounds ? 'tank' : 'point');
    setData(this.marker, 'target', this.target.objectId ?? '');
    if (this.bounds) {
      setStyle(this.marker, 'transform', `translate(${this.bounds.x}px,${this.bounds.y}px)`);
      setStyle(this.marker, 'width', `${this.bounds.width}px`);
      setStyle(this.marker, 'height', `${this.bounds.height}px`);
    }
    const text = aimTargetStatusText(this.target);
    const box = text ? placeTrajectoryLabel(screen, width, height, bodyBounds ? [...obstacles, bodyBounds] : obstacles) : null;
    this.labelVisible = box !== null;
    setHidden(this.label, !box);
    if (box) {
      if (this.label.textContent !== text) this.label.textContent = text;
      setData(this.label, 'status', this.target.status);
      setStyle(this.label, 'transform', `translate(${box.x}px,${box.y}px)`);
    }
  }

  snapshot() {
    return { point: this.target ? [...this.target.point] : null, status: this.target?.status ?? null,
      objectId: this.target?.objectId ?? null, bounds: this.bounds && { ...this.bounds },
      error: this.target && Number.isFinite(this.target.error) ? this.target.error : null,
      collider: this.target?.collider ? { ...this.target.collider, center: [...this.target.collider.center] } : null,
      visible: this.visible, labelVisible: this.labelVisible, x: this.screen?.[0] ?? null, y: this.screen?.[1] ?? null };
  }

  private hide(): void { setHidden(this.marker, true); setHidden(this.label, true); this.visible = this.labelVisible = false; this.screen = null; this.bounds = null; }
}
