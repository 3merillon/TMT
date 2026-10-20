/** Game camera pose. Rendering projection remains owned by engine/frame/camera. */
import { invert, transformPoint } from '../../engine/frame/camera';
import type { Q4, V3 } from '../contracts';
import { composeTransform, cross, multiplyRotations, rotationFromMatrix, sub } from '../math';

/** Camera normalization follows sqrt-of-squares, including a defined zero vector. */
export function cameraUnit(v: V3): V3 {
  const inverse = 1 / (Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1);
  return [v[0] * inverse, v[1] * inverse, v[2] * inverse];
}

export class CameraPose {
  position: V3 = [0, 0, 0];
  up: V3 = [0, 1, 0];
  rotation: Q4 = [0, 0, 0, 1];
  zoom = 1;
  /** Full image size, sub-view offset and sub-view size, in the same units. */
  viewOffset?: readonly [number, number, number, number, number, number];
  readonly worldMatrix = new Float64Array(16);
  readonly viewMatrix = new Float64Array(16);
  readonly projectionMatrix = new Float64Array(16);
  readonly inverseProjectionMatrix = new Float64Array(16);

  constructor(public fov = 50, public aspect = 1, public near = .1, public far = 2000) {
    this.updateProjection();
    this.updateWorld();
  }

  lookAt(target: V3): void {
    let z = sub(this.position, target);
    if (z[0] * z[0] + z[1] * z[1] + z[2] * z[2] === 0) z[2] = 1;
    z = cameraUnit(z);
    let x = cross(this.up, z);
    if (x[0] * x[0] + x[1] * x[1] + x[2] * x[2] === 0) {
      // Retain a stable frame when the requested up and view axes coincide.
      if (Math.abs(this.up[2]) === 1) z[0] += .0001; else z[2] += .0001;
      z = cameraUnit(z);
      x = cross(this.up, z);
    }
    x = cameraUnit(x);
    const y = cross(z, x), m = this.worldMatrix;
    m[0] = x[0]; m[1] = x[1]; m[2] = x[2];
    m[4] = y[0]; m[5] = y[1]; m[6] = y[2];
    m[8] = z[0]; m[9] = z[1]; m[10] = z[2];
    this.rotation = rotationFromMatrix(m);
  }

  /** Postmultiplication rotates around the camera's own axes (screen shake). */
  rotateLocal(axis: V3, angle: number): void {
    const half = angle / 2, s = Math.sin(half);
    this.rotation = multiplyRotations(this.rotation, [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)]);
  }

  updateWorld(): void {
    composeTransform(this.worldMatrix, this.position, this.rotation, [1, 1, 1]);
    invert(this.worldMatrix, this.viewMatrix);
  }

  /** Finite OpenGL-depth projection for independent label/clearance diagnostics. */
  updateProjection(): void {
    if (this.viewOffset) this.aspect = this.viewOffset[0] / this.viewOffset[1];
    let top = this.near * Math.tan(Math.PI / 180 * .5 * this.fov) / this.zoom;
    let height = 2 * top, width = this.aspect * height, left = -.5 * width;
    if (this.viewOffset) {
      const [fullWidth, fullHeight, x, y, viewWidth, viewHeight] = this.viewOffset;
      left += x * width / fullWidth; top -= y * height / fullHeight;
      width *= viewWidth / fullWidth; height *= viewHeight / fullHeight;
    }
    const right = left + width, bottom = top - height, m = this.projectionMatrix;
    m.fill(0);
    m[0] = 2 * this.near / (right - left); m[5] = 2 * this.near / (top - bottom);
    m[8] = (right + left) / (right - left); m[9] = (top + bottom) / (top - bottom);
    m[10] = -(this.far + this.near) / (this.far - this.near); m[11] = -1;
    m[14] = -2 * this.far * this.near / (this.far - this.near);
    invert(m, this.inverseProjectionMatrix);
  }

  project(point: V3): V3 {
    const v = transformPoint(this.viewMatrix, point);
    const p = transformPoint(this.projectionMatrix, v);
    return [p[0] / p[3], p[1] / p[3], p[2] / p[3]];
  }
}
