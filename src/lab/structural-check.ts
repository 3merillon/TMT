import { AmbientLight, Color, DirectionalLight, PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ResidentGpuPages } from '../gpu/terrain/gpu-pages';
import { ResidentTerrain } from '../gpu/terrain/service';
import { structuralFixture, type FixtureName } from '../gpu/terrain/fixtures';
import { StructuralPhysics } from '../game/structural-physics';
import { getResidentDevice } from './resident-render';
import { ThreeTerrainHost } from './three-terrain-host';
import { add, rotate, sub } from '../game/math';
import { replayResident, residentReplay } from '../game/resident-checkpoint';
import { residentPlanet } from '../gpu/terrain/planet';
import { ResidentPageWorkers } from '../gpu/terrain/page-workers';
import { generatePlanetStructures } from '../game/terrain-structures';
import { enduranceCut } from './resident-endurance';
import { createProceduralTerrainTextures } from './legacy/procedural-material';
import { createTerrainMaterialFromTextures, type TerrainMaterialHandle } from './legacy/terrain-material';

const canvas = document.querySelector<HTMLCanvasElement>('#view')!, status = document.querySelector<HTMLElement>('#status')!, results = document.querySelector<HTMLElement>('#results')!;
const selector = document.querySelector<HTMLSelectElement>('#fixture')!, cutButton = document.querySelector<HTMLButtonElement>('#cut')!, runButton = document.querySelector<HTMLButtonElement>('#run')!, rebuildButton = document.querySelector<HTMLButtonElement>('#rebuild')!;
const params = new URLSearchParams(location.search), name = (params.get('fixture') ?? 'two-supports') as FixtureName;
const planet = params.has('planet'), gameProfile = planet || params.has('gameProfile');
const profile = planet ? 'resident-f32-game-v2' : gameProfile ? 'resident-f32-game-v1' : 'resident-f32-v1';
if (gameProfile) document.querySelector('#profile')!.textContent = `${profile} · side-3 cells · side-6 bricks · fixed 60 Hz Rapier`;
if (!['two-supports', 'one-support', 'three-bricks', 'arch'].includes(name)) throw new Error('Unknown structural fixture'); selector.value = name;
selector.onchange = () => { location.search = `?fixture=${selector.value}`; };
const checks: { name: string; passed: boolean; detail: unknown }[] = [], errors: string[] = [];
let terrain: ResidentTerrain, renderer: WebGPURenderer, root: Scene, busy = false, cutIndex = 0, automated = false, ready = false;
let deviceInfo: unknown;
// Long animation frames (Chrome LoAF) with script attribution: which work produced a long frame during the run.
interface LongFrame { start: number; duration: number; blocking: number; render: number; style: number; scripts: { source: string; duration: number; invoker: string }[] }
const longFrames: LongFrame[] = [];
try { new PerformanceObserver(list => { for (const entry of list.getEntries() as unknown as { duration: number; blockingDuration: number; renderStart: number; styleAndLayoutStart: number; startTime: number; scripts: { sourceURL: string; sourceFunctionName: string; duration: number; invoker: string }[] }[]) {
  longFrames.push({ start: Math.round(entry.startTime), duration: Math.round(entry.duration), blocking: Math.round(entry.blockingDuration), render: Math.round(entry.startTime + entry.duration - entry.renderStart), style: Math.round(entry.styleAndLayoutStart ? entry.startTime + entry.duration - entry.styleAndLayoutStart : 0),
    scripts: entry.scripts.map(sc => ({ source: `${sc.sourceURL.split('/').pop()}:${sc.sourceFunctionName}`, duration: Math.round(sc.duration), invoker: sc.invoker })).sort((a, b) => b.duration - a.duration).slice(0, 4) });
  if (longFrames.length > 64) longFrames.splice(0, longFrames.length - 64); } }).observe({ type: 'long-animation-frame', buffered: true }); } catch {/* LoAF unsupported */}
/** The full report (every edit's metrics) is large: during an automated run only a compact line is written, so the
 * page's own reporting never lands in the frames it measures; the full JSON is written when the run ends. */
let compactReport = false;
function report() {
  if (compactReport) { const last = terrain?.history.at(-1)?.metrics; results.textContent = JSON.stringify({ checks: checks.length, failed: checks.filter(c => !c.passed).length, errors, epoch: terrain?.epoch, lastEditMs: last?.enqueueToCommitMs }); return; }
  results.textContent = JSON.stringify({ profile, rapier: '0.20.0', fixture: terrain?.fixture.name ?? name, browser: navigator.userAgent, device: deviceInfo, checks, errors, ...terrain?.snapshot(), longFrames: [...longFrames].sort((a, b) => b.duration - a.duration).slice(0, 12) }, null, 2);
}
function failure(error: unknown) { const message = error instanceof Error ? error.message : String(error); errors.push(message); compactReport = false; status.textContent = message; status.dataset.state = 'error'; report(); }
function check(name: string, passed: boolean, detail: unknown) { checks.push({ name, passed, detail }); report(); if (!passed) throw new Error(`Acceptance failed: ${name}`); }
function controls(enabled: boolean) { enabled &&= !automated; cutButton.disabled = !enabled || cutIndex >= terrain.fixture.cuts.length; runButton.disabled = !enabled; rebuildButton.disabled = !enabled; selector.disabled = !enabled; }
async function edit(action: () => Promise<unknown>) { busy = true; controls(false); try { await action(); report(); } finally { busy = false; controls(true); } }
async function cut() { await terrain.cut(terrain.fixture.cuts[cutIndex]); cutIndex++; status.textContent = `Committed cut ${cutIndex}; ${terrain.physics.bodies.size} persistent structural bodies.`; }
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
async function run() {
  automated = true; compactReport = true;
  try {
    if (planet) {
      const count = Number(params.get('shots') ?? 64); if (!Number.isInteger(count) || count < 1 || count > 512) throw new Error('Diagnostic shot count must be 1–512');
      for (let i = 0; i < count; i++) {
        status.textContent = `GPU endurance: impact ${i + 1} / ${count}`;
        await edit(() => terrain.cut(enduranceCut(terrain.queries, i)));
        check(`impact ${i + 1} committed`, terrain.history.filter(edit => edit.cut).length === i + 1, { epoch: terrain.epoch, vertices: terrain.arrangement.vertices.length, bodies: terrain.physics.bodies.size, metrics: terrain.history.at(-1)!.metrics });
        await frame();
      }
      // Let the last edit's frame watch (two frames after its commit) close: the summary includes it, and the
      // synchronous compaction test below stays out of it.
      await frame(); await frame();
      const impacts = terrain.history.filter(edit => edit.cut).map(edit => edit.metrics), sorted = impacts.map(m => m.enqueueToCommitMs).sort((a, b) => a - b);
      const summary = { impacts: impacts.length, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * .95) - 1)], maxMs: sorted.at(-1),
        readbacksMax: Math.max(...impacts.map(m => m.readbacks ?? 0)), submissionsMax: Math.max(...impacts.map(m => m.submissions)), compactionsInEdits: impacts.reduce((n, m) => n + (m.compactions ?? 0), 0),
        worstFrameMs: Math.max(0, ...terrain.frameLog), longestSliceMs: Math.max(0, ...impacts.map(m => m.longestSliceMs ?? 0)) };
      // r = 2.6 impacts: the plan §10.4 Gate-1 median (<= 90 ms) gates; p95 and the worst frame are reported.
      check('endurance edit latency (median enqueue->commit <= 90 ms, one readback, no compaction)', summary.medianMs <= 90 && summary.readbacksMax === 1 && summary.compactionsInEdits === 0, summary);
      const volume = terrain.history.at(-1)!.ledger.anchored, compactStart = performance.now(); terrain.compact(); const compactMs = performance.now() - compactStart; await edit(() => terrain.rebuild());
      check('post-endurance rebuild preserves surviving volume', Math.abs(terrain.history.at(-1)!.ledger.anchored - volume) < 1e-3, { ledger: terrain.history.at(-1)!.ledger, compactMs });
      status.textContent = `PASS: ${count} GPU terrain impacts (median ${summary.medianMs.toFixed(1)} ms), shared game materials and rebuild.`; compactReport = false; status.dataset.state = 'success'; report(); return;
    }
    check('initial fixture anchored', terrain.physics.bodies.size === 0, terrain.snapshot().staticRegions);
    while (cutIndex < terrain.fixture.cuts.length) { await edit(cut); if (cutIndex < terrain.fixture.cuts.length) check('first support cut stays attached', terrain.physics.bodies.size === 0, terrain.history.at(-1)?.ledger); }
    check('last support detaches surviving slab', terrain.physics.bodies.size === 1, terrain.history.at(-1)?.ledger);
    const body = [...terrain.physics.bodies.values()][0].body, initial = body.translation(), beforeTick = terrain.physics.tick;
    terrain.step(); check('first post-commit physics step falls radially', body.translation().y < initial.y && terrain.physics.tick === beforeTick + 1, { before: initial, after: body.translation() });
    const afterFirst = { ...body.translation() };
    // 12 simulated seconds, fixed 60 Hz, yielding periodically for drawing/input.
    for (let i = 1; i < 720; i++) { terrain.step(); if (i % 8 === 0) { report(); await frame(); } }
    const pose = body.translation(), q = body.rotation(), velocity = body.linvel();
    check('body persists after twelve seconds', terrain.physics.bodies.size === 1 && terrain.physics.snapshot()[0].age >= 12, terrain.physics.snapshot());
    check('body contacted terrain and rotated', terrain.physics.contacts > 0 && Math.hypot(q.x, q.y, q.z) > .001, { contacts: terrain.physics.contacts, rotation: q });
    check('body settled without falling through terrain', pose.y > 0 && Math.hypot(velocity.x, velocity.y, velocity.z) < .15, { pose, velocity, sleeping: body.isSleeping(), afterFirst });
    const epoch = terrain.epoch, bodyCount = terrain.physics.bodies.size, removed = terrain.history.reduce((s, h) => s + h.ledger.removed, 0);
    await edit(() => terrain.cut(terrain.fixture.cuts.at(-1)!));
    check('identical cut is idempotent', terrain.epoch === epoch && terrain.physics.bodies.size === bodyCount && terrain.history.reduce((s, h) => s + h.ledger.removed, 0) === removed, terrain.epoch);
    await edit(() => terrain.rebuild());
    check('rebuild never resurrects transferred regions', terrain.physics.bodies.size === bodyCount && ![...terrain.pages.values()].some(p => p.regions.some(r => r.source === 'slab')), terrain.snapshot().staticRegions);
    const beforeCancel = terrain.epoch, abort = new AbortController(); abort.abort();
    try { await terrain.rebuild(abort.signal); } catch {/* expected */}
    check('cancel retains complete accepted world', terrain.epoch === beforeCancel && terrain.physics.bodies.size === bodyCount, terrain.lastFailure);
    if (params.has('recut')) {
      const parent = [...terrain.physics.bodies.values()][0], p = parent.body.translation(), q = parent.body.rotation();
      const center = add([p.x, p.y, p.z], rotate(sub([0, 6.5, 0], parent.candidate.center), [q.x, q.y, q.z, q.w]));
      await edit(() => terrain.cut({ id: 'settled-body-recut', center, radius: 2.25 }));
      check('rotated body recut transfers surviving fragments', !terrain.physics.bodies.has(parent.candidate.id) && terrain.physics.bodies.size >= 1 && terrain.history.at(-1)!.ledger.removed > 0, terrain.history.at(-1)?.ledger);
      check('recut gameplay query sees the hole', !terrain.queries.isSolid(center), center);
      await edit(() => terrain.rebuild());
      check('recut rebuild cannot resurrect the old slab', ![...terrain.pages.values()].some(page => page.regions.some(r => r.source === 'slab')), terrain.physics.snapshot());
    }
    if (params.has('checkpoint')) await edit(async () => {
      const old = terrain, motions = old.physics.motions(), replay = residentReplay(old), ownership = JSON.stringify([...old.ownership]), tick = old.physics.tick;
      const scene = new Scene(), gpu = await ResidentGpuPages.create(getResidentDevice(renderer)), physics = await StructuralPhysics.create(old.fixture.planetCenter);
      const restored = new ResidentTerrain(old.fixture, gpu, physics, new ThreeTerrainHost(renderer, scene));
      try { await replayResident(restored, replay, motions, tick); } catch (error) { restored.dispose(); throw error; }
      root.add(scene); old.dispose(); terrain = restored;
      const actual = restored.physics.motions();
      const same = actual.every((m, i) => m.id === motions[i]?.id && m.sleeping === motions[i].sleeping && (['position', 'rotation', 'velocity', 'angularVelocity'] as const).every(key => m[key].every((v, a) => Math.abs(v - motions[i][key][a]) < 1e-5)));
      check('checkpoint restores body poses and exclusive ownership', same && JSON.stringify([...restored.ownership]) === ownership, { epoch: restored.epoch, bodies: restored.physics.snapshot() });
    });
    status.textContent = 'PASS: GPU resident geometry, support loss, ownership transfer, radial rigid-body contacts, persistence and replay.'; status.dataset.state = 'success'; report();
  } finally { automated = false; compactReport = false; report(); controls(true); }
}
async function start() {
  if (!navigator.gpu) throw new Error('WebGPU unavailable; this is not a hardware pass.');
  renderer = new WebGPURenderer({ canvas, antialias: true }); await renderer.init();
  const device = getResidentDevice(renderer), info = device.adapterInfo; deviceInfo = { adapter: { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description }, features: [...device.features], limits: { maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize } };
  device.addEventListener('uncapturederror', event => failure(`WebGPU validation: ${event.error.message}`));
  void device.lost.then(info => failure(`Device lost: ${info.message || info.reason}`));
  const scene = root = new Scene(); scene.background = new Color('#101923'); scene.add(new AmbientLight(0xffffff, 2)); const sun = new DirectionalLight(0xffffff, 3); sun.position.set(3, 12, 8); scene.add(sun);
  const camera = new PerspectiveCamera(48, 1, .03, 200); camera.position.set(17, 12, 21); const orbit = new OrbitControls(camera, canvas); orbit.target.set(0, 3, 0); orbit.update();
  const resize = () => { const w = canvas.clientWidth, h = canvas.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }; resize(); window.addEventListener('resize', resize);
  const fixture = planet ? residentPlanet(Number(params.get('planet'))) : structuralFixture(name), gpu = await ResidentGpuPages.create(device, planet ? 1048576 : 131072), physics = await StructuralPhysics.create(fixture.planetCenter);
  let material: TerrainMaterialHandle | undefined;
  if (planet) {
    const maps = await createProceduralTerrainTextures(renderer); material = createTerrainMaterialFromTextures(maps.albedo, maps.surface); material.setSeed(Number(params.get('planet')));
    camera.position.set(32, 30, 40); orbit.target.set(0, 0, 0); orbit.update();
  }
  if (gameProfile) fixture.localConstruction = true;
  const compiler = planet ? new ResidentPageWorkers(Number(params.get('planet')), generatePlanetStructures(Number(params.get('planet'))), 'resident-f32-game-v2', params.get('cache') === '1') : undefined;
  terrain = new ResidentTerrain(fixture, gpu, physics, new ThreeTerrainHost(renderer, scene, material?.material), compiler); await terrain.initialize(); ready = true;
  status.textContent = 'Ready. Geometry constructed and validated on the renderer GPUDevice.'; report(); controls(true);
  cutButton.onclick = () => void edit(cut).catch(failure); rebuildButton.onclick = () => void edit(() => terrain.rebuild()).catch(failure);
  // Acceptance starts from the authored fixture every time, including after a
  // completed automatic run or manual cuts. Reuse normal pagehide cleanup.
  runButton.onclick = () => { const url = new URL(location.href); url.searchParams.set('auto', '1'); location.replace(url); };
  let last = performance.now(), accumulator = 0;
  renderer.setAnimationLoop(() => { const now = performance.now(); accumulator = Math.min(.1, accumulator + (now - last) / 1000); last = now;
    if (ready && !busy && !automated) { while (accumulator >= 1 / 60) { terrain.step(); accumulator -= 1 / 60; } } else accumulator = 0;
    orbit.update(); renderer.render(scene, camera);
  });
  window.addEventListener('pagehide', () => { renderer.setAnimationLoop(null); terrain.dispose(); material?.dispose(); orbit.dispose(); renderer.dispose(); }, { once: true });
  // Optional ?settle=<ms>: let the first frames (material compiles, page uploads) finish before the automated edits.
  if (params.get('auto') === '1') { const settle = Number(params.get('settle') ?? 0); if (settle > 0) await new Promise(resolve => setTimeout(resolve, Math.min(settle, 60000))); await run(); }
}
void start().catch(failure);
