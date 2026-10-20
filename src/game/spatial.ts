/** Exact dyadic addresses; world-space floating point is used only after camera-relative subtraction. */
import type { V3 } from './contracts';

export const MAX_DYADIC_DEPTH = 128;
export interface DyadicCell { readonly depth: number; readonly x: bigint; readonly y: bigint; readonly z: bigint }
export interface DyadicAnchor { readonly cell: DyadicCell; readonly offset: V3 }
export type CellAxis = 'x' | 'y' | 'z';
const axes: readonly CellAxis[] = ['x', 'y', 'z'];

export function dyadicCell(depth: number, x: bigint, y: bigint, z: bigint): DyadicCell {
  if (!Number.isInteger(depth) || depth < 0 || depth > MAX_DYADIC_DEPTH) throw new Error(`Dyadic depth must be between 0 and ${MAX_DYADIC_DEPTH}.`);
  const limit = 2n ** BigInt(depth);
  if ([x, y, z].some(v => typeof v !== 'bigint' || v < 0n || v >= limit)) throw new Error('Dyadic coordinates are outside their root domain.');
  return Object.freeze({ depth, x, y, z });
}

export function cellKey(cell: DyadicCell): string {
  dyadicCell(cell.depth, cell.x, cell.y, cell.z);
  return `${cell.depth}/${cell.x}/${cell.y}/${cell.z}`;
}

export function parseCellKey(key: string): DyadicCell {
  if (typeof key !== 'string' || key.length > 128 || !/^(0|[1-9]\d*)\/(0|[1-9]\d*)\/(0|[1-9]\d*)\/(0|[1-9]\d*)$/.test(key)) throw new Error('Invalid dyadic cell key.');
  const [depth, x, y, z] = key.split('/');
  return dyadicCell(Number(depth), BigInt(x), BigInt(y), BigInt(z));
}

export function parentCell(cell: DyadicCell): DyadicCell | null {
  dyadicCell(cell.depth, cell.x, cell.y, cell.z);
  return cell.depth ? dyadicCell(cell.depth - 1, cell.x / 2n, cell.y / 2n, cell.z / 2n) : null;
}

export function childCells(cell: DyadicCell): DyadicCell[] {
  dyadicCell(cell.depth, cell.x, cell.y, cell.z);
  if (cell.depth === MAX_DYADIC_DEPTH) throw new Error('Maximum dyadic depth reached.');
  const children: DyadicCell[] = [];
  for (let z = 0n; z < 2n; z++) for (let y = 0n; y < 2n; y++) for (let x = 0n; x < 2n; x++) {
    children.push(dyadicCell(cell.depth + 1, cell.x * 2n + x, cell.y * 2n + y, cell.z * 2n + z));
  }
  return children;
}

export function neighborCell(cell: DyadicCell, axis: CellAxis, direction: -1 | 1): DyadicCell | null {
  dyadicCell(cell.depth, cell.x, cell.y, cell.z);
  if (!axes.includes(axis) || (direction !== -1 && direction !== 1)) throw new Error('Invalid dyadic neighbor direction.');
  const coordinate = cell[axis] + BigInt(direction), limit = 2n ** BigInt(cell.depth);
  if (coordinate < 0n || coordinate >= limit) return null;
  return dyadicCell(cell.depth, axis === 'x' ? coordinate : cell.x, axis === 'y' ? coordinate : cell.y, axis === 'z' ? coordinate : cell.z);
}

export function cellContains(ancestor: DyadicCell, descendant: DyadicCell): boolean {
  dyadicCell(ancestor.depth, ancestor.x, ancestor.y, ancestor.z);
  dyadicCell(descendant.depth, descendant.x, descendant.y, descendant.z);
  if (ancestor.depth > descendant.depth) return false;
  const divisor = 2n ** BigInt(descendant.depth - ancestor.depth);
  return axes.every(axis => descendant[axis] / divisor === ancestor[axis]);
}

/** Camera offsets are fractions of its anchor cell; no astronomical world position is constructed. */
export function relativeCellBounds(cell: DyadicCell, camera: DyadicAnchor, rootSpan: number): { min: V3; max: V3; size: number } {
  dyadicCell(cell.depth, cell.x, cell.y, cell.z);
  dyadicCell(camera.cell.depth, camera.cell.x, camera.cell.y, camera.cell.z);
  if (!(rootSpan > 0) || !Number.isFinite(rootSpan) || camera.offset.length !== 3 || camera.offset.some(v => !Number.isFinite(v) || v < 0 || v >= 1)) throw new Error('Invalid camera anchor or root span.');
  const depth = Math.max(cell.depth, camera.cell.depth);
  const cellScale = 2n ** BigInt(depth - cell.depth), cameraScale = 2n ** BigInt(depth - camera.cell.depth);
  const step = rootSpan * 2 ** -depth, cameraSize = rootSpan * 2 ** -camera.cell.depth, size = rootSpan * 2 ** -cell.depth;
  if (!step || !Number.isFinite(size)) throw new Error('Relative cell scale is outside floating-point range.');
  const min = axes.map((axis, i) => Number(cell[axis] * cellScale - camera.cell[axis] * cameraScale) * step - camera.offset[i] * cameraSize) as V3;
  if (!min.every(Number.isFinite)) throw new Error('Relative cell position is outside floating-point range.');
  return { min, max: min.map(v => v + size) as V3, size };
}

/** A bounded face-neighbor relation for testing future 2:1 selections; does not select or mesh LODs. */
export function cellsShareFace(a: DyadicCell, b: DyadicCell): boolean {
  dyadicCell(a.depth, a.x, a.y, a.z); dyadicCell(b.depth, b.x, b.y, b.z);
  const depth = Math.max(a.depth, b.depth), sa = 2n ** BigInt(depth - a.depth), sb = 2n ** BigInt(depth - b.depth);
  let boundaries = 0;
  for (const axis of axes) {
    const alo = a[axis] * sa, ahi = alo + sa, blo = b[axis] * sb, bhi = blo + sb;
    if (ahi === blo || bhi === alo) boundaries++;
    else if (ahi <= blo || bhi <= alo) return false;
  }
  return boundaries === 1;
}

export function assertTwoToOneFaces(cells: readonly DyadicCell[], maximumCells = 4096): void {
  if (!Number.isInteger(maximumCells) || maximumCells < 1 || maximumCells > 4096 || cells.length > maximumCells) throw new Error('LOD contract audit exceeds its cell budget.');
  for (const cell of cells) dyadicCell(cell.depth, cell.x, cell.y, cell.z);
  for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
    if (cellContains(cells[i], cells[j]) || cellContains(cells[j], cells[i])) throw new Error('LOD cells overlap.');
    if (Math.abs(cells[i].depth - cells[j].depth) > 1 && cellsShareFace(cells[i], cells[j])) throw new Error('LOD face neighbors violate the 2:1 contract.');
  }
}
