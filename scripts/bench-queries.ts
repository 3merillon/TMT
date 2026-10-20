/**
 * CPU terrain-query micro-benchmark (Node, no GPU, no workers): the seed-7 resident planet through the GeometryGate
 * helper, pristine and with collapsed structures, timing the queries the fixed-step simulation issues (segment and
 * line-of-sight rays, isSolid, surface, sphere sweeps, triangle boxes, the tread profile, one trajectory preview and
 * whole drive ticks). Every section also folds its results into a checksum, so two trees can be compared for
 * bit-identical answers as well as for speed.
 *
 *   node node_modules/tsx/dist/cli.mjs --expose-gc scripts/bench-queries.ts [--root <tree>] [--rounds 7] [--out file.json] [--only a,b]
 *   node node_modules/tsx/dist/cli.mjs scripts/bench-queries.ts --match <ticks> [--rubble] [--root <tree>]
 *
 * --root runs the same inputs against another checkout of src/ and tests/helpers (e.g. an export of the base commit),
 * for a before/after pair on one machine state. Bytes per call need --expose-gc (heap growth of a GC-free batch).
 * --match plays a bot-versus-bot match instead (see below).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// resident-terrain.ts reaches the GPU page shaders through Vite's `?raw` imports; outside Vite they load as text modules.
register(`data:text/javascript,${encodeURIComponent(`import { readFile } from 'node:fs/promises'; import { fileURLToPath } from 'node:url';
export async function load(url, context, next) {
  if (!/\\.wgsl(\\?|$)/.test(url)) return next(url, context);
  return { format: 'module', shortCircuit: true, source: 'export default ' + JSON.stringify(await readFile(fileURLToPath(url.split('?')[0]), 'utf8')) };
}`)}`);

type V3 = [number, number, number];
type Q4 = [number, number, number, number];
const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const root = resolve(here, flag('root') ?? '.'), rounds = Number(flag('rounds') ?? 7), only = flag('only')?.split(',');
const load = (path: string): Promise<any> => import(pathToFileURL(resolve(root, path)).href);
const [{ ResidentTerrain }, { residentPlanet }, { StructuralPhysics }, { FakeTerrainHost, GeometryGate }, { ResidentGameTerrain }, { GameSimulation, FIXED_DT },
  { sampleTrackTerrain }, { DEFAULT_LOADOUT }, { generatePlanetStructures }, math] = await Promise.all([
  load('src/gpu/terrain/service.ts'), load('src/gpu/terrain/planet.ts'), load('src/game/structural-physics.ts'), load('tests/helpers/geometry-gate.ts'),
  load('src/game/resident-terrain.ts'), load('src/game/simulation.ts'), load('src/game/tread-contact.ts'), load('src/game/modules.ts'),
  load('src/game/terrain-structures.ts'), load('src/game/math.ts')]);
const gc = (globalThis as { gc?: () => void }).gc;

/** mulberry32: the same inputs on every tree. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const unit = (rng: () => number): V3 => { const z = rng() * 2 - 1, a = rng() * Math.PI * 2, r = Math.sqrt(1 - z * z); return [r * Math.cos(a), z, r * Math.sin(a)]; };
const scale = (v: V3, s: number): V3 => [v[0] * s, v[1] * s, v[2] * s];
const plus = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** FNV-1a over the IEEE-754 bits of every number folded in. */
class Checksum {
  private hash = 0x811c9dc5; private readonly view = new DataView(new ArrayBuffer(8));
  add(value: number): void { this.view.setFloat64(0, value); for (let i = 0; i < 8; i++) this.hash = Math.imul(this.hash ^ this.view.getUint8(i), 0x01000193) >>> 0; }
  all(values: ArrayLike<number>): void { for (let i = 0; i < values.length; i++) this.add(values[i]); }
  get value(): string { return this.hash.toString(16).padStart(8, '0'); }
}
interface Row { name: string; world: string; calls: number; usPerCall: number; bestUs: number; bytesPerCall: number | null; checksum: string }
const rows: Row[] = [];
/** Median and best wall time per call over `rounds` runs of `calls` calls, bytes per call, and a result checksum. */
function section(name: string, world: string, calls: number, body: (index: number, sum: Checksum | null) => void): void {
  if (only && !only.includes(name)) return;
  const sum = new Checksum();
  for (let i = 0; i < calls; i++) body(i, sum);
  const times: number[] = [];
  for (let round = 0; round < rounds; round++) { const start = performance.now(); for (let i = 0; i < calls; i++) body(i, null); times.push((performance.now() - start) * 1000 / calls); }
  times.sort((a, b) => a - b);
  let bytes: number | null = null;
  if (gc) {
    // Heap growth over a batch small enough to stay inside the young generation (a collection would show as shrinkage).
    const samples: number[] = [], batch = Math.max(1, Math.min(calls, 200));
    for (let k = 0; k < 9; k++) { gc(); const before = process.memoryUsage().heapUsed; for (let i = 0; i < batch; i++) body(i, null); const grown = process.memoryUsage().heapUsed - before; if (grown >= 0) samples.push(grown / batch); }
    samples.sort((a, b) => a - b); bytes = samples.length ? Math.round(samples[samples.length >> 1]) : null;
  }
  const row = { name, world, calls, usPerCall: +times[times.length >> 1].toFixed(3), bestUs: +times[0].toFixed(3), bytesPerCall: bytes, checksum: sum.value };
  rows.push(row);
  console.log(`${world.padEnd(8)} ${name.padEnd(22)} ${String(row.usPerCall).padStart(10)} us  best ${String(row.bestUs).padStart(10)} us  ${String(bytes ?? '-').padStart(8)} B/call  ${row.checksum}`);
}

async function world(profile: string) {
  const structures = generatePlanetStructures(7, undefined, profile === 'resident-f32-game-v3'), input = residentPlanet(7, structures, profile);
  const physics = await StructuralPhysics.create(input.planetCenter), resident = new ResidentTerrain(input, new GeometryGate().pages, physics, new FakeTerrainHost());
  const game = ResidentGameTerrain.adopt(resident, 7, structures, profile);
  await game.initialize();
  return { game, resident, physics, structures };
}
function queries(label: string, game: any): void {
  const rng = random(0xbeef), N = 4000;
  const segments = Array.from({ length: N }, () => { const up = unit(rng); return { origin: scale(up, 17.2 + rng() * 5), direction: unit(rng), length: 0.08 + rng() * 0.6 }; });
  const sights = Array.from({ length: N }, () => { const a = scale(unit(rng), 18.4 + rng() * 2), b = scale(unit(rng), 18.4 + rng() * 2); const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]; return { origin: a, direction: d, length: Math.min(29.7, Math.hypot(...d)) }; });
  const points = Array.from({ length: N }, () => scale(unit(rng), 15 + rng() * 6));
  const directions = Array.from({ length: N }, () => unit(rng));
  const sweeps = Array.from({ length: N }, () => { const up = unit(rng); return { origin: scale(up, 18.6 + rng()), direction: plus(up, scale(unit(rng), 0.7)), length: 4 + rng() * 13 }; });
  const boxes = Array.from({ length: N }, () => { const c = scale(unit(rng), 17.8 + rng() * 1.2), h: V3 = [0.5 + rng(), 0.5 + rng(), 0.5 + rng()]; return { min: [c[0] - h[0], c[1] - h[1], c[2] - h[2]] as V3, max: plus(c, h) }; });
  const poses = Array.from({ length: N }, () => { const up = unit(rng), surface = game.surface(up); return { position: plus(surface?.point ?? scale(up, 18), scale(up, 0.5)), rotation: math.rotation(up, rng() * 6.283) as Q4 }; });
    const fold = (sum: Checksum | null, hit: any) => { if (!sum) return; if (!hit) { sum.add(-1); return; } sum.all(hit.point); sum.all(hit.normal); sum.add(hit.distance); sum.add(hit.material); };
  section('raycast-segment', label, N, (i, sum) => { const q = segments[i]; fold(sum, game.raycast(q.origin, q.direction, q.length)); });
  section('raycast-sight', label, N, (i, sum) => { const q = sights[i]; fold(sum, game.raycast(q.origin, q.direction, q.length)); });
  if (typeof game.blocked === 'function') section('blocked-sight', label, N, (i, sum) => { const q = sights[i], blocked = game.blocked(q.origin, q.direction, q.length); sum?.add(blocked ? 1 : 0); });
  section('isSolid', label, N, (i, sum) => { const solid = game.isSolid(points[i]); sum?.add(solid ? 1 : 0); });
  section('surface', label, N, (i, sum) => { fold(sum, game.surface(directions[i])); });
  section('sweepSphere', label, N, (i, sum) => { const q = sweeps[i], at = game.sweepSphere(q.origin, q.direction, q.length, 0.28); sum?.add(at ?? -1); });
  section('queryTriangles', label, N, (i, sum) => {
    const result = game.queryTriangles(boxes[i], 512);
    if (sum) { sum.add(result.triangles.length); sum.add(result.overflow ? 1 : 0); for (const t of result.triangles) { sum.all(t.a); sum.all(t.b); sum.all(t.c); sum.all(t.normal); sum.add(t.material); } }
  });
  section('sampleTrackTerrain', label, N, (i, sum) => {
    const sample = sampleTrackTerrain(game, poses[i].position, poses[i].rotation, DEFAULT_LOADOUT);
    if (sum) { sum.all(sample.heights); for (const side of sample.terrain) for (const point of side) sum.all(point); sum.add(sample.bands ? sample.bands[0].length + sample.bands[1].length : -1); }
  });
}
function simulation(label: string, game: any): void {
  const sim = new GameSimulation(game, { driveTest: true, seed: 7 });
  // A second match on the same world starts from its own spawn poses, not where the last chassis stopped.
  for (const spawned of sim.state.tanks) game.relocateTank(spawned);
  for (let i = 0; i < 180; i++) sim.step(FIXED_DT);
  const tank = sim.state.tanks[0];
  let flip = 0;
  section('preview-full', label, 60, (_, sum) => {
    sim.aim(0, tank.turretYaw, 0.75, 0.55 + (flip++ % 2) * 0.01);
    const prediction = sim.previewPrediction(0, true);
    if (sum) { sum.add(prediction.points.length); sum.add(prediction.hit ? 1 : 0); for (const point of prediction.points) sum.all(point); }
  });
  section('preview-cached', label, 2000, (_, sum) => { const prediction = sim.previewPrediction(0, true); sum?.add(prediction.points.length); });
  section('sightPoints', label, 2000, (_, sum) => { const points = sim.sightPoints(sim.state.tanks[1]); if (sum) for (const point of points) sum.all(point); });
  // Whole fixed ticks: a parked pair, then tank 0 driving a figure (throttle with alternating steer).
  section('tick-parked', label, 600, () => { sim.step(FIXED_DT); });
  let tick = 0;
  section('tick-driving', label, 600, () => { const t = tick++; sim.step(FIXED_DT, { throttle: 1, steer: Math.floor(t / 90) % 3 - 1 }); });
  console.log(`${label.padEnd(8)} match hash after ${sim.state.tick} ticks: ${sim.matchHash()}`);
  rows.push({ name: 'match-hash', world: label, calls: sim.state.tick, usPerCall: 0, bestUs: 0, bytesPerCall: null, checksum: sim.matchHash() });
}

const started = performance.now(), profile = flag('profile') ?? 'resident-f32-game-v3';
/** --match <ticks>: only a bot-versus-bot match on a fresh world (brain traces, fire-tick pre-traces, impacts, terrain
 * commits, collapses, line of sight). Its hash every 600 ticks is end-to-end determinism evidence across trees; the
 * time per tick counts the synchronous steps only, not the waits for an edit to be prepared. */
if (flag('match')) {
  const { practiceSetup } = await load('src/game/api/match.ts'), { game, physics, structures } = await world(profile), ticks = Number(flag('match'));
  // --rubble: collapse every tower first, so falling and resting bodies take part in every query of the match.
  if (args.includes('--rubble')) for (const structure of structures) if (structure.axes && structure.halfSize[1] >= 1.75)
    await game.carve(plus(structure.center, scale(structure.axes[1], 1.3 - structure.halfSize[1])), 2);
  const setup = practiceSetup({ seed: 7, mode: 'bot', player: DEFAULT_LOADOUT });
  setup.teams[0].ai = true; setup.tanks[0].brain = 'tosser';
  const sim = new GameSimulation(game, setup), events = new Map<string, number>();
  let busy = 0, stepped = 0, slowest = 0;
  while (sim.state.tick < ticks && sim.state.phase !== 'finished') {
    const tick = sim.state.tick, start = performance.now();
    for (const event of sim.step(FIXED_DT)) events.set(event.type, (events.get(event.type) ?? 0) + 1);
    const ms = performance.now() - start;
    if (sim.state.tick === tick) { await new Promise(resolve => setTimeout(resolve, 1)); continue; }
    busy += ms; stepped++; slowest = Math.max(slowest, ms);
    if (sim.state.tick % 600 === 0) console.log(`match tick ${sim.state.tick}: ${sim.matchHash()} (turn ${sim.state.turn}, ${physics.bodies.size} bodies)`);
  }
  console.log(`match end tick ${sim.state.tick} ${sim.state.phase}: ${sim.matchHash()} | ${(busy * 1000 / stepped).toFixed(1)} us per tick, slowest ${slowest.toFixed(1)} ms | ${JSON.stringify(Object.fromEntries(events))}`);
  game.dispose(); process.exit(0);
}
const pristine = await world(profile);
console.log(`[bench-queries] root ${root}\n[bench-queries] seed 7 ${profile}: ${pristine.resident.queries.fixed.chunks.size} chunks, ${pristine.resident.triangles} triangles, ${Math.round(performance.now() - started)} ms`);
queries('pristine', pristine.game); simulation('pristine', pristine.game);
// Collapse structures: cut the ground under the first few, then let the detached masses fall and come to rest.
const rubble = pristine, before = rubble.physics.bodies.size;
let cuts = 0;
for (const structure of rubble.structures) {
  // A minimum-radius blast at ground level through a tower leaves its top unsupported.
  if (rubble.physics.bodies.size >= 8 || cuts >= 16) break;
  if (!structure.axes || structure.halfSize[1] < 1.75) continue;
  await rubble.game.carve(plus(structure.center, scale(structure.axes[1], 1.3 - structure.halfSize[1])), 2); cuts++;
}
for (let i = 0; i < 600; i++) rubble.game.fixedStep();
console.log(`[bench-queries] ${cuts} cuts: ${before} -> ${rubble.physics.bodies.size} structural bodies, ${[...rubble.physics.bodies.values()].filter(b => !b.body.isSleeping()).length} awake, ${rubble.resident.queries.fixed.chunks.size} chunks`);
queries('rubble', rubble.game); simulation('rubble', rubble.game);
pristine.game.dispose();
const out = flag('out');
if (out) { mkdirSync(dirname(resolve(here, out)), { recursive: true }); writeFileSync(resolve(here, out), JSON.stringify({ root, profile, node: process.version, rounds, timestamp: new Date().toISOString(), rows }, null, 1) + '\n'); }
