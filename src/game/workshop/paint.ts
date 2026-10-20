/** Transactional texture painting with bounded gesture history. Cosmetics never enter gameplay calculations. */
import { sanitizePaintDabs, type PaintDab, type TankAppearance } from '../meta/cosmetics';
import type { KitLoadoutIds } from '../api/match';
import { componentPaintGeometry, type ComponentPaintGeometry } from '../presentation/paint-geometry';
import { migratePaint, rasterPaintDab, unmatchedPaintTiles } from '../presentation/paint-raster';
export interface PaintBrush { color: string; radius: number; opacity: number; softness: number; eraser: boolean }
export const DEFAULT_BRUSH: PaintBrush = { color: '#d9cba8', radius: .12, opacity: 1, softness: .35, eraser: false };
export type PaintSurfaceHit = Pick<PaintDab, 'slot' | 'partId' | 'group' | 'position' | 'normal'>;
/** Compressed pixel strings compare by value without serializing profile snapshots. */
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = Object.keys(a), right = Object.keys(b);
  return left.length === right.length && left.every(key => equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
const comparable = (value: TankAppearance) => ({ ...value, paint: value.paint ?? [], paintTextures: value.paintTextures ?? [] });
const clone = (value: TankAppearance): TankAppearance => structuredClone(value);
export function retainedPaint(appearance: TankAppearance, kit: KitLoadoutIds): PaintDab[] {
  return (appearance.paint ?? []).filter(d => kit[d.slot] === d.partId);
}
/** One undo entry per gesture, including erasing, finish changes and reset. */
export class PaintSession {
  readonly original: TankAppearance;
  value: TankAppearance;
  private readonly baseline: TankAppearance;
  private undoStack: TankAppearance[] = [];
  private redoStack: TankAppearance[] = [];
  private gesture: TankAppearance | null = null;
  private readonly geometry: ComponentPaintGeometry[];
  constructor(appearance: TankAppearance, kit: KitLoadoutIds) {
    this.original = clone(appearance); this.geometry = componentPaintGeometry(kit); this.value = migratePaint(clone(appearance), kit, this.geometry); this.baseline = this.value;
  }
  get dirty(): boolean { return !equal(comparable(this.baseline), comparable(this.value)); }
  get archivedTiles(): number { return unmatchedPaintTiles(this.value, this.geometry) + (this.value.paint?.filter(dab => this.geometry.some(g => g.slot === dab.slot && g.partId === dab.partId)).length ?? 0); }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  begin(): void { if (!this.gesture) this.gesture = this.value; }
  end(): void { if (!this.gesture) return; const previous = this.gesture; this.gesture = null; if (previous === this.value) return; this.undoStack.push(previous); if (this.undoStack.length > 32) this.undoStack.shift(); this.redoStack = []; }
  change(value: TankAppearance): void { if (equal(comparable(this.value), comparable(value))) return; this.begin(); this.value = clone(value); this.end(); }
  dab(hit: PaintSurfaceHit, brush: PaintBrush): boolean {
    const dab = sanitizePaintDabs([{ ...hit, ...brush }])[0]; if (!dab) return false;
    const next = rasterPaintDab(this.value, this.geometry, dab, brush.eraser);
    if (next === this.value) return false; this.value = next; return true;
  }
  undo(): void { this.end(); const previous = this.undoStack.pop(); if (previous) { this.redoStack.push(clone(this.value)); this.value = previous; } }
  redo(): void { const next = this.redoStack.pop(); if (next) { this.undoStack.push(clone(this.value)); this.value = next; } }
  reset(): void { this.change({ ...this.value, paint: [], paintTextures: [] }); }
}
