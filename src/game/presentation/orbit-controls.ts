/**
 * Planet orbit controls (replaces three's OrbitControls in the overview): a damped orbit around a target with a RADIAL up
 * (normalize(target); world +Y for a target at the planet centre). Drag rotates (azimuth around up, elevation clamped
 * short of the pole), the wheel zooms within [minDistance, maxDistance], no pan. Damping is time-based (the three default
 * 0.09 per 60 Hz frame), so the feel is frame-rate independent.
 */
import type { V3 } from '../contracts';
import { add, clamp, cross, dot, mul, sub } from '../math';
import { CameraPose, cameraUnit } from './camera-pose';

export class PlanetOrbitControls {
  readonly target: V3 = [0, 0, 0];
  enabled = true;
  minDistance = 4;
  maxDistance = 70;
  /** Fraction of the angular velocity removed per 1/60 s. */
  damping = 0.09;
  rotateSpeed = 0.005;
  private azimuth = 0;
  private elevation = 0.6;
  private distance = 40;
  private vAzimuth = 0;
  private vElevation = 0;
  private zoomScale = 1;
  private up: V3 = [0, 1, 0];
  private east: V3 = [1, 0, 0];
  private north: V3 = [0, 0, -1];
  private pointers = new Map<number, { x: number; y: number }>();
  private readonly listeners: [string, EventListener, AddEventListenerOptions | boolean | undefined][] = [];

  constructor(private readonly element?: HTMLElement) {
    if (!element) return;
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions | boolean) => {
      element.addEventListener(type, fn as EventListener, options);
      this.listeners.push([type, fn as EventListener, options]);
    };
    on('pointerdown', e => {
      if (!this.enabled || e.defaultPrevented || (e.pointerType === 'mouse' && e.button !== 2)) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      element.setPointerCapture?.(e.pointerId);
    });
    on('pointermove', e => {
      const prev = this.pointers.get(e.pointerId);
      if (!prev || !this.enabled) return;
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
      prev.x = e.clientX; prev.y = e.clientY;
      if (this.pointers.size > 1) return;
      this.rotateBy(dx, dy);
    });
    const end = (e: PointerEvent) => { if (this.pointers.delete(e.pointerId) && element.hasPointerCapture?.(e.pointerId)) element.releasePointerCapture(e.pointerId); };
    on('pointerup', end); on('pointercancel', end);
    on('wheel', e => {
      if (!this.enabled || e.defaultPrevented || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      this.zoomBy(e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1));
    }, { passive: false });
  }

  private frame(): void {
    const l = Math.sqrt(dot(this.target, this.target));
    this.up = l > 1e-3 ? mul(this.target, 1 / l) : [0, 1, 0];
    const ref: V3 = Math.abs(this.up[1]) < 0.95 ? [0, 1, 0] : [0, 0, -1];
    this.east = cameraUnit(cross(ref, this.up));
    this.north = cameraUnit(cross(this.up, this.east));
  }

  /** A drag of (dx, dy) CSS px: the same damped rotation a pointer drag gives (touch gestures call it directly). */
  rotateBy(dx: number, dy: number): void {
    if (!this.enabled || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.vAzimuth -= dx * this.rotateSpeed;
    this.vElevation += dy * this.rotateSpeed;
  }
  /** Zoom by wheel pixels (positive = out), clamped per call like one wheel event. */
  zoomBy(pixels: number): void {
    if (!this.enabled || !Number.isFinite(pixels)) return;
    this.zoomScale *= Math.exp(clamp(pixels, -400, 400) * 0.0015);
  }

  /** Start orbiting `target` from the camera's current position (no momentum). */
  reset(camera: CameraPose, target: V3): void {
    this.target[0] = target[0]; this.target[1] = target[1]; this.target[2] = target[2];
    this.frame();
    const offset = sub(camera.position, this.target);
    this.distance = clamp(Math.sqrt(dot(offset, offset)) || this.distance, this.minDistance, this.maxDistance);
    const direction = cameraUnit(offset);
    this.elevation = Math.asin(clamp(dot(direction, this.up), -1, 1));
    this.azimuth = Math.atan2(dot(direction, this.north), dot(direction, this.east));
    this.vAzimuth = this.vElevation = 0;
    this.zoomScale = 1;
    this.pointers.clear();
  }

  /** Advance damping and write the camera (position, radial up, look at the target). */
  update(camera: CameraPose, dt: number): void {
    const frames = clamp(dt, 0, 0.1) * 60;
    const keep = Math.pow(1 - this.damping, frames);
    // Apply the part of the pending drag that decays this frame: the total rotation equals the drag (three's damping).
    const applied = 1 - keep;
    this.azimuth += this.vAzimuth * applied;
    this.elevation = clamp(this.elevation + this.vElevation * applied, -Math.PI * 0.47, Math.PI * 0.47);
    this.vAzimuth *= keep; this.vElevation *= keep;
    this.distance = clamp(this.distance * Math.pow(this.zoomScale, applied), this.minDistance, this.maxDistance);
    this.zoomScale = Math.pow(this.zoomScale, keep);
    this.frame();
    const ce = Math.cos(this.elevation);
    const dir = add(add(mul(this.east, Math.cos(this.azimuth) * ce), mul(this.north, Math.sin(this.azimuth) * ce)), mul(this.up, Math.sin(this.elevation)));
    camera.position = add(this.target, mul(dir, this.distance));
    camera.up = [...this.up];
    camera.lookAt(this.target);
    camera.updateWorld();
  }

  get orbitDistance(): number { return this.distance; }

  dispose(): void {
    if (this.element) for (const [type, fn, options] of this.listeners) this.element.removeEventListener(type, fn, options);
    this.listeners.length = 0;
    this.pointers.clear();
  }
}
