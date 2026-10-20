/**
 * One basin solve using src/world/basins.ts, run in the basin worker or inline where workers are unavailable:
 * - `recipe`: levels from the planet kind's recipe (a new planet, or new points that must stay dry);
 * - `volume`: every basin keeps its volume on a changed bed (craters, pending or committed), so the water a crater takes
 *   comes out of the basin it opens into.
 */
import { BASIN_RECIPES, resolveBasins, solveBasins, type Basin, type DryPoint, type PlanetKindName } from '../../../world/basins';

export interface BasinJob {
  id: number;
  mode: 'recipe' | 'volume';
  /** The bed on the label grid (6·n² radii). */
  bed: Float32Array;
  n: number;
  kind: PlanetKindName;
  maxLevel: number;
  dry: DryPoint[];
  /** The solution the volume solve starts from. */
  prev: { labels: Uint8Array; basins: Basin[]; seaLevel: number | null } | null;
  /** Ledger volumes per basin (index = id − 1); the previous solution's when absent. */
  volumes: number[] | null;
  /** Highest level per basin (its recipe level): a volume solve never floods above it. */
  caps: number[] | null;
}
export interface BasinJobResult {
  id: number;
  mode: 'recipe' | 'volume';
  labels: Uint8Array;
  basins: Basin[];
  seaLevel: number | null;
  ms: number;
  bed: Float32Array;
}

export function runBasinJob(job: BasinJob): BasinJobResult {
  const t0 = performance.now();
  const s = job.mode === 'volume' && job.prev
    ? resolveBasins(job.bed, job.n, { n: job.n, ...job.prev }, job.volumes ?? undefined, job.caps ?? undefined)
    : solveBasins(job.bed, job.n, BASIN_RECIPES[job.kind] ?? BASIN_RECIPES.temperate, { maxLevel: job.maxLevel, dry: job.dry });
  return { id: job.id, mode: job.mode, labels: s.labels, basins: [...s.basins], seaLevel: s.seaLevel, ms: performance.now() - t0, bed: job.bed };
}
