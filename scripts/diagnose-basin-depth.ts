/** Read-only recipe diagnosis on the analytic planet radius. This is not a GPU/SDF readback or settled simulation. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createPlanetSampler, PLANET_TYPES } from '../src/game/planet-field';
import { BASIN_RECIPES, MAX_SEA_LEVEL, solveBasins, type BasinRecipe, type BasinSolution } from '../src/world/basins';
import { cellDir, cubeGrid } from '../src/world/cube-grid';

const n = Number(process.argv[2] ?? 128), seeds = [0, 7, 13, 27, 63, 0xffffffff], grid = cubeGrid(n), nn = n * n;
const thresholds = [.03, .1, .3, .6, 1], results: unknown[] = [];
function metrics(bed: Float32Array, solution: BasinSolution) {
  const groups = solution.basins.map(b => ({ id: b.id, kind: b.kind, material: b.material, level: b.level, area: b.area, volume: b.volume, meanDepth: b.volume / b.area, maxDepth: b.level - b.floor,
    shallowArea: thresholds.map(depth => ({ depth, area: 0, fraction: 0 })), coverage: 0, cells: b.cells }));
  for (let c = 0; c < bed.length; c++) {
    const id = solution.labels[c]; if (!id) continue; const basin = groups[id - 1], solidAngle = grid.area[c % nn], area = solidAngle * basin.level ** 2, depth = basin.level - bed[c];
    basin.coverage += solidAngle / (4 * Math.PI); for (const threshold of basin.shallowArea) if (depth < threshold.depth) threshold.area += area;
  }
  for (const basin of groups) for (const threshold of basin.shallowArea) threshold.fraction = threshold.area / basin.area;
  return { seaLevel: solution.seaLevel, seaCapActive: solution.seaLevel === MAX_SEA_LEVEL, basins: groups,
    totalCoverage: groups.reduce((s, b) => s + b.coverage, 0), totalArea: groups.reduce((s, b) => s + b.area, 0), totalVolume: groups.reduce((s, b) => s + b.volume, 0) };
}
for (const seed of seeds) for (const kind of PLANET_TYPES) {
  const sample = createPlanetSampler(seed, true, kind), bed = Float32Array.from({ length: grid.cells }, (_, c) => sample(cellDir(n, c)).radius), recipe = BASIN_RECIPES[kind];
  const scenarios: { name: string; recipe: BasinRecipe }[] = [{ name: 'current', recipe }];
  if (recipe.sea) {
    if (kind === 'volcanic') scenarios.push({ name: 'coverage-0.16', recipe: { ...recipe, sea: { ...recipe.sea, coverage: .16 } } });
    scenarios.push({ name: 'coverage-plus-0.10', recipe: { ...recipe, sea: { ...recipe.sea, coverage: recipe.sea.coverage + .1 } } });
    scenarios.push({ name: 'coverage-0.50', recipe: { ...recipe, sea: { ...recipe.sea, coverage: .5 } } });
  }
  if (recipe.lakes) scenarios.push({ name: 'lake-fill-0.85', recipe: { ...recipe, lakes: recipe.lakes.map(l => ({ ...l, fill: .85 })) } });
  const row = { seed, kind, minBed: Math.min(...bed), maxBed: Math.max(...bed), scenarios: scenarios.map(s => ({ name: s.name, ...metrics(bed, solveBasins(bed, n, s.recipe)) })) };
  results.push(row); console.log(JSON.stringify(row));
}
mkdirSync('artifacts/basin-depth-diagnostic', { recursive: true });
writeFileSync('artifacts/basin-depth-diagnostic/result.json', JSON.stringify({ method: 'Analytic spherical v3 planet radius sampled at production basin-grid cell directions; f32 bed; production solveBasins; no structures, SDF error, tank dry-point caps or time evolution. Additional dry-point caps can only lower levels.', n, seeds, thresholds, maxSeaLevel: MAX_SEA_LEVEL, results }, null, 2) + '\n');
