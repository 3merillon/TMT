/** Small perspective projection used only by the title's tactical illustration. */
export interface Point3 { x: number; y: number; z: number }
export interface Point2 { x: number; y: number; scale: number }
export const GLOBE_RADIUS = 144;
export const CAMERA_DISTANCE = 900;
export const TAU = Math.PI * 2;
/** Ease through the near/far boundary over a band proportional to the object's radius. */
export function depthOpacity(depth: number, radius: number, rearOpacity = .55): number {
  const t = Math.max(0, Math.min(1, .5 + depth / (radius * .4)));
  return rearOpacity + (1 - rearOpacity) * t * t * (3 - 2 * t);
}
/** The leader retracts completely before its label disappears. */
export function tagReveal(time: number, acquireAt: number, releaseAt: number, duration = .7) {
  const ease = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };
  return { line: ease((time - acquireAt) / duration) * (1 - ease((time - releaseAt) / duration)),
    text: ease((time - acquireAt - duration) / .3) * (1 - ease((time - releaseAt - duration) / .6)) };
}

export function rotateView(p: Point3, yaw: number, pitch: number, roll = 0): Point3 {
  const x = p.x * Math.cos(yaw) + p.z * Math.sin(yaw);
  const z = p.z * Math.cos(yaw) - p.x * Math.sin(yaw);
  const y = p.y * Math.cos(pitch) - z * Math.sin(pitch);
  return { x: x * Math.cos(roll) - y * Math.sin(roll), y: x * Math.sin(roll) + y * Math.cos(roll), z: p.y * Math.sin(pitch) + z * Math.cos(pitch) };
}
export function project(p: Point3, distance = CAMERA_DISTANCE): Point2 {
  const scale = CAMERA_DISTANCE / (distance - p.z);
  return { x: p.x * scale, y: p.y * scale, scale };
}
export function inverseView(p: Point3, yaw: number, pitch: number, roll: number): Point3 {
  return rotateView(rotateView(rotateView(p, 0, 0, -roll), 0, -pitch), -yaw, 0);
}
export function cameraPose(t: number) {
  return { yaw: .25 + t * .018 + .62 * Math.sin(t / 23), pitch: -.28 + .65 * Math.sin(t / 29),
    roll: .05 + .4 * Math.sin(t / 31), distance: 900 - 280 * Math.sin(t / 25 + .5),
    panX: 20 * Math.sin(t / 19), panY: 14 * Math.cos(t / 27) };
}
export function globeScreenRadius(distance: number): number {
  return CAMERA_DISTANCE * GLOBE_RADIUS / Math.sqrt(distance ** 2 - GLOBE_RADIUS ** 2);
}
export function spherePoint(latitude: number, longitude: number): Point3 {
  return { x: GLOBE_RADIUS * Math.cos(latitude) * Math.sin(longitude), y: GLOBE_RADIUS * Math.sin(latitude), z: GLOBE_RADIUS * Math.cos(latitude) * Math.cos(longitude) };
}
export function orbitPoint(radius: number, tilt: number, bank: number, angle: number): Point3 {
  const x = Math.cos(angle) * radius, y = Math.sin(angle) * radius * Math.cos(tilt), z = Math.sin(angle) * radius * Math.sin(tilt);
  return { x: x * Math.cos(bank) - y * Math.sin(bank), y: x * Math.sin(bank) + y * Math.cos(bank), z };
}
/** Split paths at their actual depth; a rear arc never draws across the solid globe. */
export function projectedPath(points: Point3[], visible: (p: Point3) => boolean, distance = CAMERA_DISTANCE): string {
  let open = false, result = '', previous: Point3 | undefined;
  const append = (p: Point3, move: boolean) => {
    const q = project(p, distance);
    result += `${move ? 'M' : 'L'}${q.x.toFixed(2)},${q.y.toFixed(2)}`;
  };
  for (const p of points) {
    const show = visible(p);
    if (previous && visible(previous) !== show) {
      // Interpolate the depth boundary so front and back segments meet without a gap.
      let a = previous, b = p;
      for (let i = 0; i < 12; i++) {
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
        if (visible(mid) === visible(previous)) a = mid; else b = mid;
      }
      append({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 }, show);
      open = show;
    }
    if (show) { append(p, !open); open = true; } else open = false;
    previous = p;
  }
  return result;
}
/** A ring laid onto the curved surface, rather than an ellipse pasted over the picture. */
export function surfaceRing(normal: Point3, angularRadius: number, start = 0, sweep = TAU): Point3[] {
  const n = { x: normal.x / GLOBE_RADIUS, y: normal.y / GLOBE_RADIUS, z: normal.z / GLOBE_RADIUS };
  const length = Math.hypot(n.x, n.z);
  const u = length < 1e-8 ? { x: 1, y: 0, z: 0 } : { x: n.z / length, y: 0, z: -n.x / length };
  const v = { x: n.y * u.z, y: n.z * u.x - n.x * u.z, z: -n.y * u.x };
  return Array.from({ length: 65 }, (_, i) => {
    const a = start + i / 64 * sweep, c = Math.cos(angularRadius), s = Math.sin(angularRadius);
    return { x: GLOBE_RADIUS * (n.x * c + (u.x * Math.cos(a) + v.x * Math.sin(a)) * s),
      y: GLOBE_RADIUS * (n.y * c + v.y * Math.sin(a) * s),
      z: GLOBE_RADIUS * (n.z * c + (u.z * Math.cos(a) + v.z * Math.sin(a)) * s) };
  });
}
