/** Standing liquid levels used by gameplay and initial rendering. No GPU readback or visual quality inputs. */
import { BASIN_RECIPES, solveBasins, type Basin, type BasinSolution, type PlanetKindName } from '../world/basins';
import { cellDir, cellOfDir, cubeGrid } from '../world/cube-grid';
import type { V3, WorldQuery } from './contracts';

export const GAME_LIQUID_N = 128;
export const LIQUID_DRY_MARGIN = .35;
export interface LiquidSurface { level: number; material: 'water' | 'lava' }
export type LiquidQuery = (position: V3) => LiquidSurface | null;
export interface LiquidCheckpoint { labels: number[]; basins: Basin[]; seaLevel: number | null }

export class GameLiquids {
  private value?: BasinSolution;
  constructor(private readonly world: WorldQuery, private readonly kind: PlanetKindName) {}
  get solution(): BasinSolution | undefined { return this.value; }
  configure(spawns: readonly V3[]): void {
    if (this.value || !spawns.length) return;
    const n = GAME_LIQUID_N, bed = new Float32Array(6 * n * n);
    for (let c = 0; c < bed.length; c++) {
      const hit = this.world.surface(cellDir(n, c));
      bed[c] = hit ? Math.hypot(...hit.point) : 0;
    }
    const dry = spawns.map(p => ({ cell: cellOfDir(n, p), maxLevel: Math.hypot(...p) - LIQUID_DRY_MARGIN }));
    this.value = solveBasins(bed, n, BASIN_RECIPES[this.kind], { maxLevel: Math.min(...dry.map(d => d.maxLevel)), dry });
  }
  /** Resting surfaces ignore tiny waves and wakes, preventing frame-rate-dependent drive jitter. */
  readonly sample: LiquidQuery = p => {
    const s = this.value;
    if (!s) return null;
    const c = cellOfDir(s.n, p), label = s.labels[c];
    if (label) return s.basins[label - 1];
    // The fine terrain can put a shoreline between coarse cell centres. Extend only
    // from an adjacent wet cell; the vehicle's actual height rejects dry ground.
    const grid = cubeGrid(s.n);
    for (let i = 0; i < 4; i++) {
      const adjacent = s.labels[grid.neighbours[c * 4 + i]];
      if (adjacent) return s.basins[adjacent - 1];
    }
    return null;
  };
  checkpoint(): LiquidCheckpoint | undefined {
    return this.value && { labels: Array.from(this.value.labels), basins: structuredClone([...this.value.basins]), seaLevel: this.value.seaLevel };
  }
  restore(input: LiquidCheckpoint): void { this.value = { n: GAME_LIQUID_N, labels: Uint8Array.from(input.labels), basins: structuredClone(input.basins), seaLevel: input.seaLevel }; }
}

export function validateLiquidCheckpoint(c: LiquidCheckpoint): LiquidCheckpoint {
  if (!c || !Array.isArray(c.basins) || c.basins.length > 16 || !Array.isArray(c.labels) || c.labels.length !== 6 * GAME_LIQUID_N ** 2
    || !c.labels.every(v => Number.isInteger(v) && v >= 0 && v <= c.basins.length)
    || !(c.seaLevel === null || Number.isFinite(c.seaLevel) && c.seaLevel > 0 && c.seaLevel < 100)
    || c.basins.some((b, i) => !b || b.id !== i + 1 || !['water', 'lava'].includes(b.material) || !['sea', 'lake'].includes(b.kind)
      || ![b.level, b.floor, b.spill, b.cells, b.area, b.volume].every(v => Number.isFinite(v) && v >= 0) || b.level > 100)) throw new Error('Invalid checkpoint liquids');
  return structuredClone(c);
}
