/**
 * Terrain resolve benchmark (serial CPU, Node): the resident terrain on seed 7 through the GeometryGate helper (no
 * GPU, no workers), timing startup phases and per-stage edit costs at each blast radius, then checking them against
 * the "bench" entries of budgets/terrain.json (20% tolerance). GPU and worker latency are browser-only (capture plan
 * scripts/capture-plans/terrain.json).
 *
 *   npx tsx scripts/bench-terrain.ts [--seed 7] [--edits 30] [--radii 2,2.6,3.5,4.8] [--out artifacts/bench/terrain.json]
 *                                    [--budget budgets/terrain.json | --no-budget] [--profile v1|v2] [--workers N]
 *
 * --workers N simulates the browser's worker path in-process: N replica arrangements with the browser partitioning
 * (brickWorker), packed/unpacked packets and the main-thread merge. Startup is then measured twice: cold
 * (replicas compile; "parallel" is the slowest replica) and warm (cached packets, as an IndexedDB hit).
 *
 * Output: a table per radius (p50/p95 of every stage), startup phases, flatness versus crater history, compactions
 * (inside edits: must be 0; idle maintenance separately), and a JSON document. Exit 1 when a budget check fails.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResidentTerrain, type AcceptedEdit } from '../src/gpu/terrain/service';
import { ResidentArrangement, type OwnershipMask, type TetRequest } from '../src/gpu/terrain/arrangement';
import { residentLattice } from '../src/gpu/terrain/lattice';
import { packPages, unpackPageSteps, type PackedResidentPages } from '../src/gpu/terrain/page-packet';
import { drainTerrainWork } from '../src/gpu/terrain/work-budget';
import type { CompiledRegionPage, SampleField } from '../src/gpu/terrain/contracts';
import { brickWorker, type ResidentPageCompiler } from '../src/gpu/terrain/page-workers';
import type { ResidentWorldInput } from '../src/gpu/terrain/fixtures';
import { residentPlanet } from '../src/gpu/terrain/planet';
import { StructuralPhysics } from '../src/game/structural-physics';
import { FakeTerrainHost, GeometryGate } from '../tests/helpers/geometry-gate';
import { normalize } from '../src/game/math';
import type { V3 } from '../src/game/contracts';
import { evaluateBudget, failed, formatTable, loadBudget, type BudgetFile } from './check-capture';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const seed = Number(flag('seed') ?? 7), editsPerRadius = Number(flag('edits') ?? 30);
const radii = (flag('radii') ?? '2,2.6,3.5,4.8').split(',').map(Number);
const out = resolve(root, flag('out') ?? 'artifacts/bench/terrain.json');
const budgetPath = args.includes('--no-budget') ? undefined : resolve(root, flag('budget') ?? 'budgets/terrain.json');
const profile = flag('profile') === 'v1' ? 'resident-f32-game-v1' : 'resident-f32-game-v2';
const workerCount = Number(flag('workers') ?? 0);
/** In-process stand-in for ResidentPageWorkers: same partitioning, field sync, packet round trip and merge. */
class SimulatedWorkers implements ResidentPageCompiler {
  metrics = { workerMs: [] as number[], packetBytes: 0, mergeMs: 0, cacheHits: 0, workers: 0 };
  private readonly replicas: { arrangement: ResidentArrangement; keys: SampleField[] }[];
  constructor(input: ResidentWorldInput, count: number, private readonly cache?: Map<number, PackedResidentPages>) {
    const lattice = residentLattice(input.bounds);
    this.replicas = Array.from({ length: count }, () => ({ arrangement: new ResidentArrangement(lattice, input.sources, 2048, true, true, true), keys: [] }));
    this.metrics.workers = count;
  }
  packets = new Map<number, PackedResidentPages>();
  async compile(arrangement: ResidentArrangement, requests: readonly TetRequest[], revision: number, masks: readonly OwnershipMask[]): Promise<CompiledRegionPage[]> {
    this.metrics = { workerMs: [], packetBytes: 0, mergeMs: 0, cacheHits: 0, workers: this.replicas.length };
    const keys = [...arrangement.fields], parts = this.replicas.map(() => [] as TetRequest[]);
    for (const request of requests) parts[brickWorker(request.brick, parts.length)].push(request);
    const pages = new Map<string, CompiledRegionPage>();
    for (let w = 0; w < parts.length; w++) {
      if (!parts[w].length) continue;
      const replica = this.replicas[w], start = performance.now();
      // As page-workers.ts: a fresh replica already holds the source fields; later ones sync the common prefix.
      const base = arrangement.boxFields.flat().reduce((max, field) => Math.max(max, field + 1), 0);
      let common = replica.keys.length ? 0 : base;
      if (replica.keys.length) while (common < keys.length && replica.keys[common] === keys[common]) common++;
      replica.arrangement.rollbackFields(common, arrangement.cutFields.filter(f => f < common).length);
      for (const field of arrangement.preparedFields(common)) replica.arrangement.appendPreparedField(field);
      replica.keys = keys;
      const whole = revision === 1 && parts[w].every(r => r.tets === null);
      let packet = whole ? this.cache?.get(w) : undefined;
      if (packet) this.metrics.cacheHits++;
      else { packet = structuredClone(packPages(replica.arrangement.compileTets(parts[w], revision, masks))); if (whole) this.packets.set(w, structuredClone(packet)); }
      this.metrics.workerMs.push(performance.now() - start); this.metrics.packetBytes += packet.words.byteLength + packet.values.byteLength;
      const merge = performance.now(), budget = revision === 1 ? 20 : 6;
      const unpacked = await drainTerrainWork(unpackPageSteps(packet), undefined, budget);
      for (const page of await drainTerrainWork(arrangement.acceptCompiledSteps(unpacked), undefined, budget)) pages.set(page.brick, page);
      this.metrics.mergeMs += performance.now() - merge;
    }
    return requests.map(r => pages.get(r.brick)!);
  }
  dispose(): void {}
}

const quantile = (values: number[], q: number) => { if (!values.length) return 0; const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]; };
const round = (v: number) => Math.round(v * 100) / 100;
const t0 = performance.now();
const input = residentPlanet(seed, undefined, profile);
const inputMs = performance.now() - t0;
let physics = await StructuralPhysics.create(input.planetCenter);
const gate = new GeometryGate(), host = new FakeTerrainHost();
const document: Record<string, unknown> = { seed, profile, node: process.version, timestamp: new Date().toISOString(), editsPerRadius, radii, workers: workerCount };
if (workerCount > 0) {
  // Cold: the replicas compile (sequentially here; the browser runs them in parallel).
  const cold = new SimulatedWorkers(input, workerCount), coldTerrain = new ResidentTerrain(input, gate.pages, physics, host, cold);
  const started = performance.now(), edit = (await coldTerrain.initialize())!;
  const coldStartup = { totalMs: round(performance.now() - started), slowestWorkerMs: round(Math.max(...cold.metrics.workerMs)), mergeMs: round(cold.metrics.mergeMs), packetMB: round(cold.metrics.packetBytes / 1e6),
    stages: Object.fromEntries(Object.entries(edit.metrics.stageMs ?? {}).map(([k, v]) => [k, round(v)])) };
  console.log(`cold worker startup: ${JSON.stringify(coldStartup)}`);
  coldTerrain.dispose();
  physics = await StructuralPhysics.create(input.planetCenter);
  document.coldWorkerStartup = coldStartup;
  (globalThis as { __benchCache?: Map<number, PackedResidentPages> }).__benchCache = cold.packets;
}
const t1 = performance.now();
const compiler = workerCount > 0 ? new SimulatedWorkers(input, workerCount, (globalThis as { __benchCache?: Map<number, PackedResidentPages> }).__benchCache) : undefined;
const terrain = new ResidentTerrain(input, gate.pages, physics, host, compiler);
const constructMs = performance.now() - t1;
try {
  const t2 = performance.now();
  const init = (await terrain.initialize())!;
  const initializeMs = performance.now() - t2;
  const startup = { inputMs: round(inputMs), arrangementMs: round(constructMs), initializeMs: round(initializeMs), totalMs: round(performance.now() - t0),
    topologyMs: round(init.metrics.topologyMs), stages: Object.fromEntries(Object.entries(init.metrics.stageMs ?? {}).map(([k, v]) => [k, round(v)])),
    regions: init.metrics.regions, recipes: terrain.arrangement.vertices.length, triangles: terrain.triangles,
    ...(compiler ? { warm: true, mergeMs: round(compiler.metrics.mergeMs), cacheHits: compiler.metrics.cacheHits } : {}) };
  console.log(`startup: ${JSON.stringify(startup)}`);
  document.startup = startup;
  // Surface points on a golden-angle spiral: every edit lands on accepted terrain, spread over the planet, except a
  // polar cap kept pristine for the flatness probe.
  let shot = 0;
  const probeDirection: V3 = [0, -1, 0], probeCap = Math.cos(55 * Math.PI / 180);
  const surface = (direction: V3): V3 => terrain.queries.surface(direction)?.point ?? direction.map(v => v * 18) as V3;
  const target = (): V3 => {
    for (;;) {
      const i = shot++, z = 1 - 2 * ((i * 0.618033988749895) % 1), r = Math.sqrt(Math.max(0, 1 - z * z)), phi = i * 2.399963229728653;
      const direction = normalize([r * Math.cos(phi), z, r * Math.sin(phi)]);
      if (direction[0] * probeDirection[0] + direction[1] * probeDirection[1] + direction[2] * probeDirection[2] < probeCap) return surface(direction);
    }
  };
  // Flatness versus crater history: the same probe cut, prepared and aborted (the world is unchanged), before and
  // after every series; best of 7 after JIT warm-up. tests/terrain-scaling.test.ts asserts the same within 15%.
  const probe = { id: 'bench-probe', center: surface(probeDirection), radius: 2.6, repeat: 'impact' as const };
  const probeCost = async () => {
    const runs: number[] = [];
    for (let i = 0; i < 9; i++) { const start = performance.now(), staged = await terrain.prepare([probe]); runs.push(performance.now() - start); if (staged) terrain.abort(staged); }
    return Math.min(...runs.slice(2));
  };
  const probeBefore = await probeCost();
  const series: Record<string, unknown> = {}, all: AcceptedEdit[] = [];
  let compactionsInEdits = 0;
  for (const radius of radii) {
    const edits: AcceptedEdit[] = [], wall: number[] = [];
    for (let i = 0; i < editsPerRadius; i++) {
      const start = performance.now(), before = terrain.compactions;
      const edit = await terrain.cut({ id: `bench-${radius}-${i}`, center: target(), radius, repeat: 'impact' });
      wall.push(performance.now() - start);
      if (terrain.compactions !== before) compactionsInEdits++;
      if (edit) { edits.push(edit); all.push(edit); compactionsInEdits += edit.metrics.compactions ?? 0; }
    }
    const stageNames = [...new Set(edits.flatMap(e => Object.keys(e.metrics.stageMs ?? {})))];
    const stages = Object.fromEntries(stageNames.map(name => { const v = edits.map(e => e.metrics.stageMs?.[name] ?? 0); return [name, { p50: round(quantile(v, .5)), p95: round(quantile(v, .95)) }]; }));
    const commit = edits.map(e => e.metrics.enqueueToCommitMs);
    const entry = { edits: edits.length, p50Ms: round(quantile(commit, .5)), p95Ms: round(quantile(commit, .95)), maxMs: round(Math.max(0, ...commit)), wallP50Ms: round(quantile(wall, .5)),
      dirtyBricks: round(quantile(edits.map(e => e.metrics.dirtyBricks), .5)), dirtyTets: round(quantile(edits.map(e => e.metrics.dirtyTets ?? 0), .5)),
      ledgerMaxAbs: Math.max(0, ...edits.map(e => Math.abs(e.ledger.error))), seamUnpaired: Math.max(0, ...edits.map(e => e.seam.unpaired)), stages };
    series[`r${String(radius).replace(".", "_")}`] = entry;
    console.log(`\nr=${radius}: ${entry.edits} edits, enqueue->commit p50 ${entry.p50Ms} ms, p95 ${entry.p95Ms} ms, max ${entry.maxMs} ms; dirty bricks ${entry.dirtyBricks}, tets ${entry.dirtyTets}`);
    console.log(stageNames.map(name => `  ${name.padEnd(12)} p50 ${String(stages[name].p50).padStart(7)}  p95 ${String(stages[name].p95).padStart(7)}`).join('\n'));
  }
  document.series = series;
  const flatRadius = 2.6, probeAfter = await probeCost();
  const flatness = { radius: flatRadius, craters: terrain.history.length - 1, probeBeforeMs: round(probeBefore), probeAfterMs: round(probeAfter), ratio: round(probeAfter / Math.max(1e-9, probeBefore)) };
  console.log(`\nflatness (the same r=${flatRadius} probe before and after ${flatness.craters} craters): ${flatness.probeBeforeMs} ms -> ${flatness.probeAfterMs} ms, ratio ${flatness.ratio}`);
  document.flatness = flatness;
  const vertices = terrain.arrangement.vertices.length, maintenanceStart = performance.now(), compacted = await terrain.maintenance(1e9);
  const maintenance = { compactionsInEdits, due: terrain.compactionDue, compacted, maintenanceMs: round(performance.now() - maintenanceStart), recipesBefore: vertices, recipesAfter: terrain.arrangement.vertices.length, idleCompactions: terrain.compactions };
  console.log(`compactions inside edits: ${compactionsInEdits}; idle maintenance: ${JSON.stringify(maintenance)}`);
  document.maintenance = maintenance;
  if (compacted) {
    const after = await terrain.cut({ id: 'bench-after-compaction', center: target(), radius: flatRadius, repeat: 'impact' });
    document.afterCompaction = { enqueueToCommitMs: round(after?.metrics.enqueueToCommitMs ?? 0) };
    console.log(`first edit after compaction: ${round(after?.metrics.enqueueToCommitMs ?? 0)} ms`);
  }
  mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(document, null, 1));
  console.log(`\nwrote ${out}`);
  if (budgetPath) {
    const file = loadBudget(budgetPath) as BudgetFile & { bench?: BudgetFile['checks'] };
    if (!file.bench?.length) console.log(`${budgetPath}: no "bench" entries`);
    else {
      const results = evaluateBudget(document, { checks: file.bench, tolerance: 0.2 }, { tolerance: 0.2 });
      console.log(formatTable(results));
      if (failed(results)) process.exitCode = 1;
    }
  }
} finally { terrain.dispose(); }
