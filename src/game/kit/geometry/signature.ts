import type { Shape } from './shapes';
import type { Convex } from './convex';

// Exact serialized geometry is interned rather than hashed: a cache hit cannot
// merge different collision pieces. Shared Shape objects pay this cost once.
const cached = new WeakMap<Shape, number>();
const interned = new Map<string, number>();
const pieces = new WeakMap<Convex, number>(), pieceKeys = new Map<string, number>();

export function collisionPieceId(c: Convex): number {
  const found = pieces.get(c);
  if (found !== undefined) return found;
  const key = JSON.stringify([c.tag, c.cosmetic ?? false, Array.from(c.pts), Array.from(c.nrm), Array.from(c.edg), Array.from(c.box)]);
  let id = pieceKeys.get(key);
  if (id === undefined) { id = pieceKeys.size; pieceKeys.set(key, id); }
  pieces.set(c, id);
  return id;
}

export function collisionShapeId(shape: Shape): number {
  const found = cached.get(shape);
  if (found !== undefined) return found;
  const key = shape.hulls.map(collisionPieceId).join(',');
  let id = interned.get(key);
  if (id === undefined) { id = interned.size; interned.set(key, id); }
  cached.set(shape, id);
  return id;
}

/** Stable equality of the actual collision pieces, independent of cosmetic material or part id. */
export function collisionShapesKey(shapes: readonly Shape[]): string {
  return shapes.map(collisionShapeId).join(',');
}
