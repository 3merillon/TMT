/**
 * Camera: hand-built reversed-Z INFINITE perspective for WebGPU clip space (z ∈ [0, 1]), plan §4.4.
 *
 *   clip.z = near, clip.w = −z_view  ⇒  depth = near / distance: 1 at the near plane, → 0 at infinity.
 *   Column-major: proj[2][2] = 0, proj[3][2] = near, proj[2][3] = −1, proj[3][3] = 0.
 *
 * Also: three.js-style `setViewOffset` shift (CameraRig.viewOffset = [fullWidth, fullHeight, offsetX, offsetY] in CSS px,
 * the sub-view being the canvas), Halton(2,3) sub-pixel jitter (16 samples at native; off unless enabled, e.g. by a TAA module),
 * previous unjittered view-projection, snap detection (eye jump > 3 u) and CSS-pixel project/unproject.
 * Matrices are computed in f64 and stored as Float32Array (column-major).
 */
import type { CameraRig, Vec3 } from '../contracts';

export const CAMERA_NEAR = 0.08;
export const SNAP_DISTANCE = 3;
export const JITTER_SAMPLES = 16;

export type Mat4 = Float64Array | Float32Array | number[];

export function halton(index: number, base: number): number {
  let f = 1, r = 0, i = index;
  while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
  return r;
}

/**
 * Jitter phases before the sequence repeats. A temporal upscaler needs every DISPLAY pixel covered by samples, so below
 * native the count follows FSR 2's 8 × (display / internal)²; it never drops under the native 16.
 */
export function jitterPhaseCount(displayWidth: number, internalWidth: number): number {
  const ratio = displayWidth / Math.max(1, internalWidth);
  return Math.max(JITTER_SAMPLES, Math.round(8 * ratio * ratio));
}

/** Sub-pixel jitter in PIXELS, centred on 0, for frame `frameIndex` (cycles over `phases`). */
export function jitterPixels(frameIndex: number, phases = JITTER_SAMPLES): [number, number] {
  const i = (frameIndex % phases) + 1;
  return [halton(i, 2) - 0.5, halton(i, 3) - 0.5];
}

export function multiply(a: Mat4, b: Mat4, out: Float64Array = new Float64Array(16)): Float64Array {
  const r = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let row = 0; row < 4; row++) {
      r[c * 4 + row] = a[row] * b[c * 4] + a[4 + row] * b[c * 4 + 1] + a[8 + row] * b[c * 4 + 2] + a[12 + row] * b[c * 4 + 3];
    }
  }
  out.set(r);
  return out;
}

export function invert(m: Mat4, out: Float64Array = new Float64Array(16)): Float64Array {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = Array.from(m);
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) { out.fill(0); return out; }
  const d = 1 / det;
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d; out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d; out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d; out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d; out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d; out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d; out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d; out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d; out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
  return out;
}

export function transformPoint(m: Mat4, p: readonly number[]): [number, number, number, number] {
  const x = p[0], y = p[1], z = p[2];
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14], m[3] * x + m[7] * y + m[11] * z + m[15]];
}

/** Right-handed look-at view matrix (world → view; the camera looks down −Z). */
export function lookAt(eye: readonly number[], target: readonly number[], up: readonly number[], out: Float64Array = new Float64Array(16)): Float64Array {
  let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz);
  if (l < 1e-9) { // up parallel to the view direction: pick any perpendicular
    const alt = Math.abs(zy) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    xx = alt[1] * zz - alt[2] * zy; xy = alt[2] * zx - alt[0] * zz; xz = alt[0] * zy - alt[1] * zx;
    l = Math.hypot(xx, xy, xz);
  }
  xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  out[15] = 1;
  return out;
}

export interface ProjectionParams {
  fovY: number; near: number;
  /** CSS size of the view (the canvas). */
  width: number; height: number;
  viewOffset?: readonly [number, number, number, number];
  /** Extra NDC shift (TAA jitter). */
  jitterNdc?: readonly [number, number];
}

/** Reversed-Z infinite perspective with three.js setViewOffset semantics. */
export function reversedInfinitePerspective(p: ProjectionParams, out: Float64Array = new Float64Array(16)): Float64Array {
  const aspect = p.width / Math.max(p.height, 1e-9);
  let top = p.near * Math.tan(p.fovY / 2);
  let height = 2 * top;
  let width = aspect * height;
  let left = -0.5 * width;
  if (p.viewOffset) {
    const [fullW, fullH, offX, offY] = p.viewOffset;
    left += offX * width / fullW;
    top -= offY * height / fullH;
    width *= p.width / fullW;
    height *= p.height / fullH;
  }
  const right = left + width, bottom = top - height;
  out.fill(0);
  out[0] = 2 * p.near / (right - left);
  out[5] = 2 * p.near / (top - bottom);
  out[8] = (right + left) / (right - left) - (p.jitterNdc?.[0] ?? 0);
  out[9] = (top + bottom) / (top - bottom) - (p.jitterNdc?.[1] ?? 0);
  out[10] = 0;       // proj[2][2]
  out[11] = -1;      // proj[2][3]: clip.w = −z_view
  out[14] = p.near;  // proj[3][2]: clip.z = near
  out[15] = 0;
  return out;
}

export class Camera {
  near = CAMERA_NEAR;
  readonly view = new Float32Array(16);
  readonly proj = new Float32Array(16);
  readonly projNoJitter = new Float32Array(16);
  readonly viewProj = new Float32Array(16);
  readonly invViewProj = new Float32Array(16);
  readonly viewProjNoJitter = new Float32Array(16);
  readonly prevViewProj = new Float32Array(16);
  readonly eye: Vec3 = [0, 0, 0];
  /** NDC offsets. */
  jitter: [number, number] = [0, 0];
  prevJitter: [number, number] = [0, 0];
  snap = true;
  fovY = 47 * Math.PI / 180;
  private cssSize: [number, number] = [1, 1];
  private hasPrev = false;
  private readonly v64 = new Float64Array(16);
  private readonly p64 = new Float64Array(16);
  private readonly pn64 = new Float64Array(16);
  private readonly vp64 = new Float64Array(16);
  private readonly vpn64 = new Float64Array(16);
  private readonly inv64 = new Float64Array(16);
  private readonly invNoJitter64 = new Float64Array(16);

  /**
   * @param cssSize view size in CSS px (projection aspect, viewOffset, project()).
   * @param internalSize render size in device px (jitter is one internal pixel).
   * @param displaySize output size in device px; a frame rendered below it gets the longer jitter cycle of `jitterPhaseCount`.
   */
  update(rig: CameraRig, cssSize: readonly [number, number], internalSize: readonly [number, number], jitterEnabled: boolean, frameIndex: number,
    displaySize: readonly [number, number] = internalSize): void {
    const [ex, ey, ez] = rig.position;
    const jumped = this.hasPrev && Math.hypot(ex - this.eye[0], ey - this.eye[1], ez - this.eye[2]) > SNAP_DISTANCE;
    this.snap = !this.hasPrev || jumped;
    // Previous frame (unjittered) before overwriting.
    if (this.hasPrev) this.prevViewProj.set(this.viewProjNoJitter);
    this.prevJitter = this.jitter;
    this.eye[0] = ex; this.eye[1] = ey; this.eye[2] = ez;
    this.fovY = rig.fovY;
    this.cssSize = [Math.max(1, cssSize[0]), Math.max(1, cssSize[1])];
    lookAt(rig.position, rig.target, rig.up, this.v64);
    let jitterNdc: [number, number] = [0, 0];
    if (jitterEnabled) {
      const [jx, jy] = jitterPixels(frameIndex, jitterPhaseCount(displaySize[0], internalSize[0]));
      jitterNdc = [2 * jx / Math.max(1, internalSize[0]), 2 * jy / Math.max(1, internalSize[1])];
    }
    this.jitter = jitterNdc;
    const params: ProjectionParams = { fovY: rig.fovY, near: this.near, width: this.cssSize[0], height: this.cssSize[1], viewOffset: rig.viewOffset };
    reversedInfinitePerspective(params, this.pn64);
    reversedInfinitePerspective({ ...params, jitterNdc }, this.p64);
    multiply(this.p64, this.v64, this.vp64);
    multiply(this.pn64, this.v64, this.vpn64);
    invert(this.vp64, this.inv64);
    invert(this.vpn64, this.invNoJitter64);
    this.view.set(this.v64); this.proj.set(this.p64); this.projNoJitter.set(this.pn64);
    this.viewProj.set(this.vp64); this.viewProjNoJitter.set(this.vpn64); this.invViewProj.set(this.inv64);
    if (!this.hasPrev || this.snap) this.prevViewProj.set(this.viewProjNoJitter);
    this.hasPrev = true;
  }

  /** CSS px of a world point (unjittered). */
  project(p: readonly number[]): { x: number; y: number; visible: boolean } {
    const c = transformPoint(this.vpn64, p);
    if (c[3] <= 1e-9) return { x: NaN, y: NaN, visible: false };
    const nx = c[0] / c[3], ny = c[1] / c[3];
    return { x: (nx * 0.5 + 0.5) * this.cssSize[0], y: (0.5 - ny * 0.5) * this.cssSize[1], visible: Math.abs(nx) <= 1 && Math.abs(ny) <= 1 };
  }

  /** World point at CSS px (x, y) and reversed-Z depth (0 < depth ≤ 1). depth 0 returns the unit ray direction instead. */
  unproject(x: number, y: number, depth: number): { point: Vec3 | null; direction: Vec3 } {
    const nx = x / this.cssSize[0] * 2 - 1, ny = 1 - y / this.cssSize[1] * 2;
    // The ray direction comes from the near-plane point (depth 1); depth 0 is at infinity (w = 0).
    const near = transformPoint(this.invNoJitter64, [nx, ny, 1]);
    const nearP: Vec3 = [near[0] / near[3], near[1] / near[3], near[2] / near[3]];
    let dx = nearP[0] - this.eye[0], dy = nearP[1] - this.eye[1], dz = nearP[2] - this.eye[2];
    const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
    if (!(depth > 0)) return { point: null, direction: [dx, dy, dz] };
    const h = transformPoint(this.invNoJitter64, [nx, ny, depth]);
    return { point: [h[0] / h[3], h[1] / h[3], h[2] / h[3]], direction: [dx, dy, dz] };
  }

  get cssWidth(): number { return this.cssSize[0]; }
  get cssHeight(): number { return this.cssSize[1]; }
}
