import type { FluidsFacet } from '../../src/engine/passes/fluids/fluids';

/** Exercise the actual lava layer: ambient movement, blast response, and moving hulls without creating water. */
export async function lavaRegression(f: FluidsFacet, target: number[]) {
  const r = Math.hypot(...target), up = target.map(v => v / r);
  const tangent = [up[2], 0, -up[0]];
  const t = Math.hypot(...tangent); tangent.forEach((v, i) => { tangent[i] = v / t; });
  const across = [up[1] * tangent[2] - up[2] * tangent[1], up[2] * tangent[0] - up[0] * tangent[2], up[0] * tangent[1] - up[1] * tangent[0]];
  const points = Array.from({ length: 64 }, (_, i) => target.map((v, k) => v + tangent[k] * ((i % 8 - 3.5) * 0.2) + across[k] * ((Math.floor(i / 8) - 3.5) * 0.2)));
  const before = await f.probe(points);
  if (!before.some(v => v.lava > 0.1)) throw new Error('Fixture must start in a lava pool');
  const speed = (samples: typeof before) => Math.max(...samples.map(v => Math.hypot(...v.velocity)));
  f.impulse(target.map((v, k) => v - up[k] * 0.1), 1.5);
  await new Promise(resolve => setTimeout(resolve, 220));
  const blast = await f.probe(points);
  const blastChange = Math.max(...blast.map((v, i) => Math.abs(v.lava - before[i].lava)));
  if (blastChange < 0.005 || speed(blast) < 0.02) throw new Error(`Lava did not respond to blast: depth change ${blastChange}, speed ${speed(blast)}`);
  await new Promise(resolve => setTimeout(resolve, 2500));
  const preHull = await f.probe(points);
  const from = target.map((v, k) => v - up[k] * 0.12 - tangent[k] * 0.5);
  const to = from.map((v, k) => v + tangent[k]);
  f.testHull(from, to, 0.6);
  try {
    await new Promise(resolve => setTimeout(resolve, 1800));
    const hull = await f.probe(points);
    const water = Math.max(...hull.map(v => v.water));
    const priorWater = Math.max(...preHull.map(v => v.water));
    if (water > priorWater + 0.004) throw new Error(`Lava hull manufactured water: ${priorWater} -> ${water}`);
    if ([...blast, ...hull].some(v => !Number.isFinite(v.lava) || !Number.isFinite(v.surface) || v.lava < 0)) throw new Error('Invalid lava state');
    const broken = Math.max(...hull.map(v => v.foam));
    if (broken < 0.08) throw new Error(`Moving hull did not break lava crust: ${broken}`);
    return { ambientSpeed: speed(before), blastSpeed: speed(blast), blastDepthChange: blastChange, hullSpeed: speed(hull), brokenCrust: broken, water,
      temperature: Math.max(...hull.map(v => v.temperature)) };
  } finally { f.testHull(null); }
}

export async function lavaEdge(f: FluidsFacet) {
  const points = f.shorePoints(512, 'lava');
  const samples = (await Promise.all(Array.from({ length: Math.ceil(points.length / 64) }, (_, i) => f.probe(points.slice(i * 64, i * 64 + 64))))).flat();
  const candidates: { index: number; rank: number }[] = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s.lava < 0.025 || s.lava > 0.2 || s.water > 0.004) continue;
    const rank = Math.abs(s.lava - 0.08) + (1 - points[i][1] / Math.hypot(...points[i])) * 0.1;
    candidates.push({ index: i, rank });
  }
  candidates.sort((a, b) => a.rank - b.rank);
  let best = -1, score = Infinity;
  for (const candidate of candidates.slice(0, 32)) {
    const p = points[candidate.index], r = Math.hypot(...p), up = p.map(v => v / r);
    const tangent = [up[2], 0, -up[0]], tr = Math.hypot(...tangent);
    tangent.forEach((v, k) => { tangent[k] = v / Math.max(tr, 0.0001); });
    const across = [up[1] * tangent[2] - up[2] * tangent[1], up[2] * tangent[0] - up[0] * tangent[2], up[0] * tangent[1] - up[1] * tangent[0]];
    const ring = await f.probe([tangent, across].flatMap(axis => [-1, 1].map(sign => p.map((v, k) => v + axis[k] * sign * 0.7))));
    const bed = samples[candidate.index].ground - samples[candidate.index].lava;
    const slope = Math.max(...ring.map(s => Math.abs(s.ground - s.lava - bed)));
    const rank = candidate.rank + slope;
    if (rank < score) { score = rank; best = candidate.index; }
  }
  if (best < 0) throw new Error('No thin lava margin for the driving fixture');
  return points[best].map(v => v / Math.hypot(...points[best]) * samples[best].surface);
}
