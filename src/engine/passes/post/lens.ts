/** Equidistant fisheye in a diagonal-normalised image plane. Same mapping as the final composite.
 * The corner stays inside the rendered image; aspect correction keeps a circular lens on portrait screens. */
export function lensPoint(point: readonly [number, number], size: readonly [number, number], strength: number, toScene: boolean): [number, number] {
  const [width, height] = size;
  const k = Math.min(0.6, Math.abs(strength)) * 2;
  if (k < 0.0001 || width <= 0 || height <= 0) return [point[0], point[1]];
  const diagonal = Math.hypot(width, height), x = (2 * point[0] - width) / diagonal, y = (2 * point[1] - height) / diagonal;
  const radius = Math.hypot(x, y);
  if (radius < 0.000001) return [point[0], point[1]];
  const mapped = strength < 0
    ? toScene ? Math.atan(k * radius) / k : Math.tan(k * radius) / k
    : toScene ? Math.tan(k * radius) / Math.tan(k) : Math.atan(radius * Math.tan(k)) / k;
  return [(x * mapped / radius * diagonal + width) / 2, (y * mapped / radius * diagonal + height) / 2];
}
export const lensToScene = (point: readonly [number, number], size: readonly [number, number], strength: number) => lensPoint(point, size, strength, true);
export const sceneToLens = (point: readonly [number, number], size: readonly [number, number], strength: number) => lensPoint(point, size, strength, false);
/** Negative distortion widens the actual perspective render, so the inverse lens reveals extra scenery. */
export function lensFovY(base: number, strength: number): number {
  return 2 * Math.atan(Math.tan(base / 2) * (1 + Math.max(0, Math.min(0.6, -strength)) * 2));
}
