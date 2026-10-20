/**
 * Cosmetic debris on the real planet with one trimesh per collision page (the game) against one whole-surface trimesh
 * (the 29baad2 debris world), in lockstep through the same blasts and carves: tunnelling, slide distance, rest state and
 * sleep, then the cost of the terrain rebuild after a commit. Serial CPU/WASM in Node (GeometryGate stands in for the GPU).
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/check-debris-pages.ts [--seed 7] [--sites 6] [--out artifacts/perf/debris-pages.json]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import RAPIER from '@dimforge/rapier3d-compat';
import { ResidentTerrain } from '../src/gpu/terrain/service';
import { residentPlanet } from '../src/gpu/terrain/planet';
import { StructuralPhysics } from '../src/game/structural-physics';
import { generatePlanetStructures } from '../src/game/terrain-structures';
import { TERRAIN_RADIUS } from '../src/game/terrain-config';
import { TerrainDebris } from '../src/game/presentation/debris';
import { DebrisDynamics } from '../src/game/presentation/debris-dynamics';
import { InstanceTable } from '../src/engine/passes/gbuffer/part-mesh-data';
import type { Q4, V3, WorldQuery } from '../src/game/contracts';
import { FakeTerrainHost, GeometryGate } from '../tests/helpers/geometry-gate';

const args = process.argv.slice(2), option = (key: string, fallback: string) => args.includes(`--${key}`) ? args[args.indexOf(`--${key}`) + 1] : fallback;
const seed = Number(option('seed', '7')), siteCount = Number(option('sites', '6')), out = option('out', 'artifacts/perf/debris-pages.json');
await RAPIER.init();
const structures = generatePlanetStructures(seed, undefined, true), input = residentPlanet(seed, structures, 'resident-f32-game-v3');
const resident = new ResidentTerrain(input, new GeometryGate().pages, await StructuralPhysics.create(input.planetCenter), new FakeTerrainHost());
const built = performance.now();
await resident.initialize();
console.log(`planet ${seed}: ${resident.queries.fixed.chunks.size} pages, ${resident.triangles} triangles (${Math.round(performance.now() - built)} ms)`);
// ResidentGameTerrain's queries (src/game/resident-terrain.ts imports WGSL, which Node cannot load): footprintSurface
// with its pages, structural bodies as collision bodies.
const fixed = () => resident.queries.fixed;
const surfaceOf = (pages: boolean): WorldQuery => ({ radius: TERRAIN_RADIUS, get version() { return resident.epoch; }, raycast: (o, d, n) => fixed().raycast(o, d, n), surface: d => fixed().surface(d),
  isSolid: p => fixed().isSolid(p), queryTriangles: (b, m) => fixed().queryTriangles(b, m), visibilityTriangles: () => fixed().visibilityTriangles(), ...(pages ? { fixedChunks: () => fixed().chunks } : {}) });
const worldOf = (pages: boolean): WorldQuery => ({ radius: TERRAIN_RADIUS, get version() { return resident.epoch; }, footprintSurface: surfaceOf(pages),
  raycast: (o, d, n) => resident.queries.raycast(o, d, n), surface: d => resident.queries.surface(d), isSolid: p => resident.queries.isSolid(p), queryTriangles: (b, m) => resident.queries.queryTriangles(b, m),
  collisionBodies: () => [...resident.physics.bodies].map(([id, { body, candidate }]) => { const p = body.translation(), q = body.rotation();
    return { id, position: [p.x, p.y, p.z] as V3, rotation: [q.x, q.y, q.z, q.w] as Q4, shapes: candidate.colliders }; }) });
// The 29baad2 world is the same surface without its pages: the debris world cooks one whole-surface trimesh.
const game = worldOf(true), whole = worldOf(false), surface = game.footprintSurface!, wholeSurface = whole.footprintSurface!;

function scene() {
  const table = new InstanceTable();
  let meshes = 0;
  return { get: () => undefined, meshes: { create: () => ({ id: ++meshes }), destroy: () => {} },
    instances: { add: (m: { id: number }, i: never) => ({ id: table.add(m.id, i) }), set: (h: { id: number }, model: Float32Array) => table.set(h.id, model),
      remove: (h: { id: number }) => table.remove(h.id), setVisibility: (h: { id: number }, v: number) => table.setVisibility(h.id, v) } };
}
type Piece = { body: { position: V3; velocity: V3; sleeping: boolean; age: number }; positions: Float32Array; rotation: [number, number, number, number] };
const piecesOf = (debris: TerrainDebris) => (debris as unknown as { pieces: Piece[] }).pieces;
/** Lowest hull vertex height above the terrain straight below it (negative: inside), probed from 0.3 above it. */
function gap(p: Piece): number {
  const r = p.rotation, c = p.body.position;
  let low: V3 = c, lowest = Infinity;
  for (let i = 0; i < p.positions.length; i += 3) {
    const v = [p.positions[i], p.positions[i + 1], p.positions[i + 2]], t = [2 * (r[1] * v[2] - r[2] * v[1]), 2 * (r[2] * v[0] - r[0] * v[2]), 2 * (r[0] * v[1] - r[1] * v[0])];
    const w = [v[0] + r[3] * t[0] + r[1] * t[2] - r[2] * t[1], v[1] + r[3] * t[1] + r[2] * t[0] - r[0] * t[2], v[2] + r[3] * t[2] + r[0] * t[1] - r[1] * t[0]].map((x, k) => x + c[k]) as V3;
    const l = Math.hypot(...w); if (l < lowest) { lowest = l; low = w; }
  }
  const up = low.map(x => x / lowest) as V3, hit = surface.raycast(low.map((x, k) => x + up[k] * .3) as V3, up.map(x => -x) as V3, 1.3);
  return hit ? hit.distance - .3 : 1;
}
const stats = (values: number[]) => {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b), q = (f: number) => +s[Math.min(s.length - 1, Math.floor(f * s.length))].toFixed(4);
  return { n: s.length, mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(4), p10: q(.1), p50: q(.5), p90: q(.9), min: q(0), max: q(1) };
};
// Blast sites spread over the planet, aimed at open ground and at the structures.
const sites: { at: V3; radius: number }[] = [];
for (let i = 0; i < siteCount; i++) {
  const s = structures[i % Math.max(1, structures.length)];
  const direction: V3 = i % 2 && s ? s.center.map(v => v / Math.hypot(...s.center)) as V3 : [Math.cos(i * 2.4) * .6, .5 + .1 * i, Math.sin(i * 2.4) * .6];
  const l = Math.hypot(...direction), hit = surface.surface(direction.map(v => v / l) as V3)!;
  sites.push({ at: hit.point, radius: i % 3 === 2 ? 3.2 : 2.6 });
}
const variants = { pages: { debris: new TerrainDebris(scene() as never), world: game as WorldQuery }, whole: { debris: new TerrainDebris(scene() as never), world: whole } };
type Record = { commitMs: number[]; frameMs: number[]; deepest: number; below: number; belowSeam: number[]; samples: number; inside: number; travel: number[]; rest: number[]; asleep: number[]; drift: number[]; spawned: number };
const records: { [k in keyof typeof variants]: Record } = { pages: { commitMs: [], frameMs: [], deepest: Infinity, below: 0, belowSeam: [], samples: 0, inside: 0, travel: [], rest: [], asleep: [], drift: [], spawned: 0 },
  whole: { commitMs: [], frameMs: [], deepest: Infinity, below: 0, belowSeam: [], samples: 0, inside: 0, travel: [], rest: [], asleep: [], drift: [], spawned: 0 } };
/** Distance from a point to the nearest brick face (faces lie on multiples of 6). */
const seam = (x: V3) => Math.min(...x.map(v => Math.abs(v - 6 * Math.round(v / 6))));
// Cook the pages ahead, as the game does after match load, in 2 ms slices.
const prewarm = new DebrisDynamics(), slices: number[] = [];
for (let done = false; !done;) { const t = performance.now(); done = prewarm.syncTerrain(game, 2); slices.push(performance.now() - t); }
prewarm.dispose();
for (let i = 0; i < 2 * slices.length; i++) variants.pages.debris.update(game, 1 / 60);
for (const [index, site] of sites.entries()) {
  const id = `site-${index}`, l = Math.hypot(...site.at), normal = site.at.map(x => x / l) as V3;
  for (const v of Object.values(variants)) v.debris.impact({ type: 'impact', owner: 0, position: site.at, normal, radius: site.radius, cut: { id, center: site.at, radius: site.radius } } as never, v.world);
  await resident.cut({ id: `carve-${index}`, center: site.at, radius: site.radius, repeat: 'impact' });
  const starts = new Map<string, Map<object, V3>>(), middle = new Map<string, Map<object, V3>>();
  for (const [name, v] of Object.entries(variants)) {
    v.debris.commit([id]);
    const born = new Map(piecesOf(v.debris).filter(p => p.body.age === 0).map(p => [p.body, [...p.body.position] as V3]));
    const t = performance.now(); v.debris.update(v.world, 1 / 60); records[name as keyof typeof variants].commitMs.push(performance.now() - t);
    starts.set(name, born); records[name as keyof typeof variants].spawned += born.size;
  }
  for (let frame = 1; frame < 13 * 60; frame++) {
    resident.step();
    for (const [name, v] of Object.entries(variants)) {
      const record = records[name as keyof typeof variants], t = performance.now();
      v.debris.update(v.world, 1 / 60); record.frameMs.push(performance.now() - t);
      if (frame % 30 === 0) for (const p of piecesOf(v.debris)) if (p.body.age > .5) { const g = gap(p); record.samples++; if (g < -.05) { record.below++; record.belowSeam.push(seam(p.body.position)); } if (g < record.deepest) record.deepest = g; }
      if (frame === 6 * 60) middle.set(name, new Map(piecesOf(v.debris).map(p => [p.body, [...p.body.position] as V3])));
    }
  }
  for (const [name, v] of Object.entries(variants)) {
    // The shards this blast spawned that are still whole (a shattered one became new bodies).
    const record = records[name as keyof typeof variants], begin = starts.get(name)!, mid = middle.get(name)!, kept = piecesOf(v.debris).filter(p => begin.has(p.body));
    record.inside += kept.filter(p => surface.isSolid(p.body.position)).length;
    for (const p of kept) {
      const a = begin.get(p.body)!, b = p.body.position, m = mid.get(p.body) ?? b, rest = gap(p);
      record.travel.push(Math.hypot(...b.map((x, i) => x - a[i]))); record.rest.push(rest); record.drift.push(Math.hypot(...b.map((x, i) => x - m[i])));
      // Brick faces lie on multiples of 6: how far from a seam the deepest resting shards lie.
      if (rest < -.01) console.log(`  ${name}: shard resting ${rest.toFixed(4)} into the surface, ${seam(b).toFixed(2)} from the nearest brick face, ${p.body.sleeping ? 'asleep' : 'awake'}`);
    }
    record.asleep.push(kept.filter(p => p.body.sleeping).length / Math.max(1, kept.length));
  }
  console.log(`site ${index}: radius ${site.radius}, bricks rebuilt by the carve: ${resident.history.at(-1)?.metrics.dirtyBricks ?? '?'}`);
}
// The rebuild after one commit: everything (29baad2) against the changed pages only, on the same planet.
const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
const rebuild = (world: WorldQuery) => {
  const sim = new DebrisDynamics(); sim.syncTerrain(world);
  const before = new Map(resident.queries.fixed.chunks);
  return { sim, before };
};
const timings: { whole: number[]; pages: number[]; changedPages: number; changedTriangles: number } = { whole: [], pages: [], changedPages: 0, changedTriangles: 0 };
{
  const w = rebuild(whole), p = rebuild(game), target = surface.surface([.3, .8, -.52].map(v => v / Math.hypot(.3, .8, -.52)) as V3)!;
  const before = new Map(resident.queries.fixed.chunks);
  await resident.cut({ id: 'carve-timing', center: target.point, radius: 2.6, repeat: 'impact' });
  for (const [id, chunk] of resident.queries.fixed.chunks) if (before.get(id) !== chunk) { timings.changedPages++; timings.changedTriangles += chunk.mesh.indices.length / 3; }
  let t = performance.now(); w.sim.syncTerrain(whole); timings.whole.push(performance.now() - t);
  t = performance.now(); p.sim.syncTerrain(game); timings.pages.push(performance.now() - t);
  // Repeats of the same rebuild on fresh worlds for a median.
  for (let i = 0; i < 6; i++) {
    const fw = new DebrisDynamics(), fp = new DebrisDynamics();
    t = performance.now(); fw.syncTerrain(whole); timings.whole.push(performance.now() - t);
    const pages = resident.queries.fixed.chunks, changed = new Map([...pages].filter(([id, c]) => before.get(id) !== c));
    const partial: WorldQuery = { ...wholeSurface, version: -2, fixedChunks: () => changed };
    t = performance.now(); fp.syncTerrain(partial); timings.pages.push(performance.now() - t);
    fw.dispose(); fp.dispose();
  }
  w.sim.dispose(); p.sim.dispose();
}
const summary = Object.fromEntries(Object.entries(records).map(([name, r]) => [name, { spawned: r.spawned, commitFrameMs: r.commitMs.map(v => +v.toFixed(2)), frameMs: stats(r.frameMs),
  deepestGap: +r.deepest.toFixed(4), samplesDeeperThan5cm: `${r.below}/${r.samples}`, ...(r.belowSeam.length ? { deepSamplesFromBrickFace: stats(r.belowSeam) } : {}), centresInsideTerrain: r.inside, travel: stats(r.travel), restGap: stats(r.rest), asleepAt13s: r.asleep.map(v => +v.toFixed(3)), drift6to13s: stats(r.drift) }]));
const result = { seed, sites, prewarm: { slices: slices.length, maxSliceMs: +Math.max(...slices).toFixed(2), totalMs: +slices.reduce((a, b) => a + b, 0).toFixed(1) },
  rebuildAfterOneCrater: { changedPages: timings.changedPages, changedTriangles: timings.changedTriangles, wholeSurfaceMs: +median(timings.whole).toFixed(2), changedPagesMs: +median(timings.pages).toFixed(2) }, ...summary };
console.log(JSON.stringify(result, null, 1));
mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(result, null, 1));
for (const v of Object.values(variants)) v.debris.dispose();
resident.dispose();
