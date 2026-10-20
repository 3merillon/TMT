/** Cartesian workshop camera; deliberately independent of the game's radial planet controls. */
import type { CameraRig, Vec3 } from '../../engine';
import type { SlotId } from '../kit';

export type WorkshopView = 'hero' | 'front' | 'side' | 'rear' | 'top';
export interface WorkshopOrbit { yaw: number; pitch: number; distance: number; target: Vec3; fovDegrees?: number }
export const HERO: WorkshopOrbit = { yaw: -.42, pitch: .25, distance: 8.2, target: [0, 1.45, 0], fovDegrees: 43 };
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const norm = (p: Vec3): Vec3 => { const l = Math.hypot(...p) || 1; return p.map(v => v / l) as Vec3; };
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const copyOrbit = (o: WorkshopOrbit): WorkshopOrbit => ({ ...o, target: [...o.target] });

export type WorkshopCameraCollision = (origin: Vec3, direction: Vec3, distance: number) => number | null;
export function workshopCamera(o: WorkshopOrbit, collision?: WorkshopCameraCollision): CameraRig {
  const horizontal = Math.cos(o.pitch) * o.distance;
  // Keep every orbit inside the architecture, including low and rear inspection views.
  const boom: Vec3 = [Math.sin(o.yaw) * horizontal, Math.sin(o.pitch) * o.distance, Math.cos(o.yaw) * horizontal];
  const lower = [-4.5, .42, -6.1], upper = [4.5, 6.6, 7.1];
  let fraction = 1;
  for (let i = 0; i < 3; i++) if (Math.abs(boom[i]) > 1e-8)
    fraction = Math.min(fraction, Math.max(0, ((boom[i] > 0 ? upper[i] : lower[i]) - o.target[i]) / boom[i]));
  const position = o.target.map((v, i) => v + boom[i] * fraction) as Vec3;
  // Shorten the boom as one vector, preserving the user's angle at room limits.
  const insideVault = (f: number) => {
    const x = o.target[0] + boom[0] * f, y = o.target[1] + boom[1] * f;
    return y <= 3 + 4.2 * Math.sqrt(Math.max(0, 1 - (x / 7) ** 2));
  };
  if (!insideVault(fraction)) {
    let low = 0, high = fraction;
    for (let i = 0; i < 10; i++) { const middle = (low + high) / 2; if (insideVault(middle)) low = middle; else high = middle; }
    for (let i = 0; i < 3; i++) position[i] = o.target[i] + boom[i] * low;
  }
  if (collision) {
    const delta = position.map((v, i) => v - o.target[i]) as Vec3, distance = Math.hypot(...delta), direction = norm(delta);
    const right = norm(cross(direction, [0, 1, 0])), up = cross(right, direction);
    // Sweep a small camera volume, not just its centre: pipes near the lens must
    // not cover the whole tank while the centre ray still happens to be clear.
    let safe = distance;
    for (const [x, y] of [[0, 0], [-.32, 0], [.32, 0], [0, -.32], [0, .32]]) {
      const start = Math.min(1.25, distance);
      const origin = o.target.map((v, i) => v + direction[i] * start + right[i] * x + up[i] * y) as Vec3;
      const hit = collision(origin, direction, distance - start + .35);
      if (hit !== null) safe = Math.min(safe, Math.max(1.3, start + hit - .35));
    }
    for (let i = 0; i < 3; i++) position[i] = o.target[i] + direction[i] * safe;
  }
  const requestedFov = clamp(o.fovDegrees ?? 43, 35, 64) * Math.PI / 180;
  const actualDistance = Math.hypot(...position.map((v, i) => v - o.target[i]));
  // Preserve useful framing when architecture shortens a zoomed-out boom (especially
  // the installed tank plus trolley comparison), without moving through the obstacle.
  const fovY = Math.min(64 * Math.PI / 180, 2 * Math.atan(Math.tan(requestedFov / 2) * Math.max(1, o.distance / Math.max(.1, actualDistance))));
  return { position, target: [...o.target], up: [0, 1, 0], fovY };
}
export function inspectionView(view: WorkshopView): WorkshopOrbit {
  const o = copyOrbit(HERO);
  if (view === 'front') { o.yaw = 0; o.pitch = .17; o.distance = 6.2; }
  if (view === 'rear') { o.yaw = Math.PI; o.pitch = .24; o.distance = 6.5; }
  if (view === 'side') { o.yaw = Math.PI / 2; o.pitch = .17; o.distance = 6.2; }
  if (view === 'top') { o.yaw = .05; o.pitch = 1.39; o.distance = 5.2; }
  return o;
}
export function categoryView(slot: SlotId, center: Vec3): WorkshopOrbit {
  // The rear hoist hangs directly across the accessory sightline. The open front-left service angle
  // clears both that hook and the positive-X gantry columns, including when the user zooms in.
  const views: Record<SlotId, [number, number, number]> = { hull: [-.5, .34, 6.4], runningGear: [-1.23, .13, 5.6], turret: [-.5, .43, 5.7], weapon: [-.32, .25, 5.6], utility: [-.42, .4, 4.2] };
  const [yaw, pitch, distance] = views[slot];
  return { yaw, pitch, distance, target: slot === 'utility' ? [...center] : [center[0] * .5, Math.max(.95, center[1]), center[2] * .5] };
}

/** Preview framing remembers the installed view once, without turning the camera around on each candidate. */
export class WorkshopPreviewFraming {
  private saved: { installed: WorkshopOrbit; comparisonDistance: number } | null = null;
  get active(): boolean { return this.saved !== null; }
  begin(current: WorkshopOrbit, narrow: boolean): WorkshopOrbit {
    if (this.saved) return copyOrbit(current);
    const distance = Math.max(8.6, current.distance);
    this.saved = { installed: copyOrbit(current), comparisonDistance: distance };
    return { ...copyOrbit(current), target: [-2.2, 1.3, .5], distance, fovDegrees: narrow ? 53 : current.fovDegrees ?? 43 };
  }
  end(current: WorkshopOrbit): WorkshopOrbit {
    if (!this.saved) return copyOrbit(current);
    const { installed, comparisonDistance } = this.saved; this.saved = null;
    // Manual orbit/zoom during comparison remains useful after dismissal; only its framing offset is temporary.
    return { ...installed, yaw: current.yaw, pitch: current.pitch, distance: clamp(installed.distance * current.distance / comparisonDistance, 2, 11) };
  }
  forget(): void { this.saved = null; }
}

/** Leave the service angle under the user's control while returning the subject to the installed tank. */
export function centeredTankView(current: WorkshopOrbit, liftHeight = 0): WorkshopOrbit {
  return { ...copyOrbit(current), target: [HERO.target[0], HERO.target[1] + liftHeight, HERO.target[2]], distance: clamp(current.distance, 6.2, HERO.distance), fovDegrees: HERO.fovDegrees };
}
export function cameraRay(rig: CameraRig, x: number, y: number, width: number, height: number): { origin: Vec3; direction: Vec3 } {
  const f = norm(rig.target.map((v, i) => v - rig.position[i]) as Vec3), r = norm(cross(f, rig.up)), u = cross(r, f);
  const t = Math.tan(rig.fovY / 2), nx = (2 * x / width - 1) * t * width / height, ny = (1 - 2 * y / height) * t;
  return { origin: [...rig.position], direction: norm(f.map((v, i) => v + r[i] * nx + u[i] * ny) as Vec3) };
}
export function easeOrbit(from: WorkshopOrbit, to: WorkshopOrbit, amount: number): WorkshopOrbit {
  let yaw = to.yaw - from.yaw;
  yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
  return { yaw: from.yaw + yaw * amount, pitch: from.pitch + (to.pitch - from.pitch) * amount,
    distance: from.distance + (to.distance - from.distance) * amount, target: from.target.map((v, i) => v + (to.target[i] - v) * amount) as Vec3,
    fovDegrees: (from.fovDegrees ?? 43) + ((to.fovDegrees ?? 43) - (from.fovDegrees ?? 43)) * amount };
}
