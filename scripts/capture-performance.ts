/**
 * Real-time performance capture of the production game: ordinary rAF pacing, real dt and real input, no benchmark
 * pacing. It complements scripts/capture-planetary-lighting.ts, whose fixed-step driver isolates GPU pass cost.
 * See docs/performance-pass.md.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/capture-performance.ts --base http://127.0.0.1:5191/ --environment exclusive --out <new directory>
 *     --plan <file>        scenes (default scripts/capture-plans/performance-realtime.json)   --scenes a,b   --repeats 3
 *     --uncapped           no vsync and no frame-rate limit (throughput; the default keeps Chromium's display cadence)
 *     --api-stats          WebGPU call statistics (uploads, resource and pipeline creation, readback latency)
 *     --trace              CPU profile and thread/GC summary of the recorded window (use an unminified build for names)
 *     --alloc              sampled allocation sites of the main thread
 *     --video              record the window (the screencast costs frames: such a run is visual evidence, not timing)
 *     --shot-every <s>     screenshots during the window (they stall the page: visual evidence, not timing)
 *
 * Everything in the page is injected (scripts/performance-probe.ts): a preserved baseline bundle needs no changes.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { acquireGpuLock } from './capture';
import { installPerformanceProbe } from './performance-probe';
import { distribution, frameWindows, summarizeAllocations, summarizeRecording, summarizeTrace, type Recording } from './performance-metrics';
import type { CameraRig } from '../src/engine/contracts';
import { generatePlanetStructures } from '../src/game/terrain-structures';

/** A camera placed relative to the first tank or to the building nearest to it: `height` above, `back` along a tangent,
 * looking at the point `ahead` units further along that tangent. */
interface Anchor { on?: 'tank' | 'structure'; height: number; back: number; azimuth: number; ahead?: number }
type Step = { t: number; mark?: string } & (
  | { do: 'keydown' | 'keyup' | 'press'; key: string }
  | { do: 'blast'; radius: number; munition?: string; camera?: CameraRig; aim?: Anchor }
  | { do: 'orbit'; dx: number; dy: number; seconds: number }
  | { do: 'wheel'; deltaY: number }
  | { do: 'mark' });
interface Scene {
  name: string; seed: number; skyTime?: number; epoch?: number; tanks?: number; camera?: CameraRig; anchor?: Anchor; graphics?: Record<string, unknown>; off?: string[];
  /** The playground starts without fog of war; true restarts the match with the rule real matches use. */
  fog?: boolean;
  /** 'bot' boots a real practice duel (fog of war, turns, the AI opponent) instead of the playground; blasts need the playground. */
  mode?: 'dev' | 'bot';
  clouds?: { coverage?: number; density?: number }; settle?: number; warmSeconds?: number; seconds: number; timeline?: Step[];
}

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2), flag = (key: string) => args.includes(`--${key}`);
const value = (key: string, fallback: string) => flag(key) && args[args.indexOf(`--${key}`) + 1] ? args[args.indexOf(`--${key}`) + 1] : fallback;
const out = resolve(root, value('out', `artifacts/performance-pass/run-${Date.now()}`));
assert.ok(!existsSync(out), `Use a fresh output directory: ${out}`); mkdirSync(out, { recursive: true });
const width = Number(value('width', '1600')), height = Number(value('height', '1000')), repeats = Number(value('repeats', '1'));
for (const [key, v] of Object.entries({ width, height, repeats })) assert.ok(Number.isInteger(v) && v > 0, `${key} must be positive`);
const base = value('base', ''); assert.ok(base, 'Pass the --base URL of a served production build');
const uncapped = flag('uncapped'), apiStats = flag('api-stats'), trace = flag('trace'), alloc = flag('alloc'), video = flag('video');
const shotEvery = Number(value('shot-every', '0'));
/** A run with any of these attributes cost or shows the scenario; its frame times are not a result. */
const timing = !apiStats && !trace && !alloc && !video && !shotEvery;
const plan: Scene[] = JSON.parse(readFileSync(resolve(root, value('plan', 'scripts/capture-plans/performance-realtime.json')), 'utf8'));
const names = flag('scenes') ? value('scenes', '').split(',') : null;
const scenes = plan.filter(scene => !names || names.includes(scene.name)); assert.ok(scenes.length, 'No selected scenes');
const save = (name: string, data: unknown) => writeFileSync(join(out, name), JSON.stringify(data, null, 1));
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

/** Machine state before a timed block: another GPU or CPU workload makes the block a different experiment. */
async function environment() {
  const cpuTimes = () => cpus().reduce((sum, cpu) => { const t = cpu.times; return { busy: sum.busy + t.user + t.sys + t.irq + t.nice, all: sum.all + t.user + t.sys + t.irq + t.nice + t.idle }; }, { busy: 0, all: 0 });
  const before = cpuTimes(); await sleep(1500); const after = cpuTimes();
  const smi = (...query: string[]) => { try { return execFileSync('nvidia-smi', query, { encoding: 'utf8', windowsHide: true }).trim(); } catch { return null; } };
  const gpu = smi('--query-gpu=utilization.gpu,memory.used,temperature.gpu,power.draw', '--format=csv,noheader,nounits')?.split(',').map(Number);
  return { cpuBusyPercent: Math.round((after.busy - before.busy) / (after.all - before.all) * 1000) / 10,
    gpuUtilizationPercent: gpu?.[0] ?? null, gpuMemoryUsedMiB: gpu?.[1] ?? null, gpuTemperatureC: gpu?.[2] ?? null, gpuPowerW: gpu?.[3] ?? null };
}

const resolved: Scene[] = [];
const errors: string[] = [], runs: { scene: string; repeat: number; file: string; valid: boolean; failures: string[]; summary: ReturnType<typeof summarizeRecording> }[] = [];
let browser: Browser | undefined, context: BrowserContext | undefined, gpuTelemetry: ChildProcess | undefined, gpuTelemetryCsv = '';
// What a run that dies with its page leaves behind: its console errors and the browser's own output
// (TMT_CHROME_ARGS="--enable-logging=stderr --v=0" adds the renderer's).
let current: { label: string; pageErrors: string[] } | undefined;
const browserLog: string[] = [];
const unlock = await acquireGpuLock();
try {
  const idle = await environment();
  const declared = value('environment', 'unspecified');
  // Idle limits: the desktop compositor alone stays far below these on the qualification host.
  const quiet = idle.cpuBusyPercent < 15 && (idle.gpuUtilizationPercent ?? 0) < 12;
  if (declared === 'exclusive') assert.ok(quiet, `The machine is not idle (${JSON.stringify(idle)}); stop other workloads or drop --environment exclusive`);
  gpuTelemetry = spawn('nvidia-smi', ['--query-gpu=timestamp,utilization.gpu,clocks.gr,temperature.gpu,power.draw,memory.used,clocks.mem,pstate', '--format=csv', '--loop-ms=1000'], { windowsHide: true });
  gpuTelemetry.stdout?.on('data', data => { gpuTelemetryCsv += String(data); }); gpuTelemetry.on('error', () => {});
  const store = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  const executablePath = process.env.TMT_CHROME ?? readdirSync(store).filter(n => /^chromium-\d+$/.test(n)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    .map(n => join(store, n, 'chrome-win64/chrome.exe')).find(existsSync); assert.ok(executablePath, 'Set TMT_CHROME');
  browser = await chromium.launch({ executablePath, headless: true, ignoreDefaultArgs: ['--headless'], args: ['--headless=new', '--enable-unsafe-webgpu', '--enable-webgpu-developer-features',
    '--ignore-gpu-blocklist', '--enable-gpu', '--force-color-profile=srgb', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--enable-precise-memory-info', ...(uncapped ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : []), ...(process.env.TMT_CHROME_ARGS ?? '').split(' ').filter(Boolean)],
    logger: { isEnabled: name => name === 'browser', log: (_name, _severity, message) => { browserLog.push(String(message)); if (browserLog.length > 5000) browserLog.shift(); } } });
  let servedSource: any = null;
  try { const response = await fetch(new URL('source-state.json', base.endsWith('/') ? base : `${base}/`)); if (response.ok) servedSource = await response.json(); } catch { /* an unverified server stays labelled as such */ }
  save('metadata.json', { date: new Date().toISOString(), base, environment: declared, idle, quietBeforeStart: quiet, production: servedSource?.production === true, profileBuild: servedSource?.profile === true,
    servedHead: servedSource?.head ?? null, servedDirty: servedSource ? servedSource.status !== '' : null, width, height, dpr: 1, repeats, uncapped, apiStats, trace, alloc, video, shotEvery, timing,
    cpu: cpus()[0]?.model, node: process.version, browser: browser.version(), args,
    limits: ['Real rAF pacing in headless Chromium: frame intervals follow the display cadence unless --uncapped.', 'Exclusive is an operator declaration checked only against idle CPU and GPU load at start.',
      '--trace, --alloc, --api-stats and --video add work: use them to attribute cost, not to report frame times.'] });
  for (let repeat = 1; repeat <= repeats; repeat++) for (const scene of scenes) {
    const label = `${scene.name}-r${repeat}`, failures: string[] = [], pageErrors: string[] = [];
    context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, ...(video ? { recordVideo: { dir: out, size: { width, height } } } : {}) });
    await context.route(/\/favicon\.ico/, route => route.fulfill({ status: 204, body: '' }));
    // tsx keeps function names with a helper that does not exist in the page.
    await context.addInitScript('globalThis.__name = globalThis.__name || (f => f);');
    await context.addInitScript(installPerformanceProbe, { capacity: 60000, apiStats });
    const page = await context.newPage();
    current = { label, pageErrors };
    page.on('pageerror', e => pageErrors.push(e.stack ?? e.message)); page.on('console', e => { if (e.type() === 'error') pageErrors.push(e.text()); });
    page.on('crash', () => pageErrors.push(`page crashed at ${new Date().toISOString()}`));
    const bench = <T = any>(method: string, ...parameters: unknown[]): Promise<T> =>
      page.evaluate(({ method, parameters }) => (window as any).__tmtPerf.bench[method](...parameters), { method, parameters });
    const perf = <T = any>(method: string, ...parameters: unknown[]): Promise<T> =>
      page.evaluate(({ method, parameters }) => (window as any).__tmtPerf[method](...parameters), { method, parameters });
    assert.ok(scene.mode !== 'bot' || !(scene.timeline ?? []).some(step => step.do === 'blast'), `${scene.name}: blasts need the playground`);
    await page.goto(new URL(`play.html?mode=${scene.mode ?? 'dev'}&seed=${scene.seed}&renderbench`, base.endsWith('/') ? base : `${base}/`).href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).__tmtRenderBench?.ready, undefined, { timeout: 180000 });
    await bench('step', 1);
    if (scene.tanks && scene.tanks > 2) await friendlyTanks(bench, scene.tanks);
    else if (scene.fog) {
      const setup = structuredClone((await bench('state')).setup); setup.rules.fog = true;
      await bench('startMatch', setup); await bench('step', 1);
    }
    // The paced driver settles the vehicle and applies the scene; real time starts from that reproducible state.
    await bench('configure', { simulationScale: 1 }); await bench('step', scene.settle ?? 120);
    // Anchors become numbers once, from the settled state, and are saved: a later arm can replay exactly these rigs.
    const settled = await bench('state'), rig = (anchor: Anchor) => anchoredRig(anchor, settled, scene.seed);
    const camera = scene.camera ?? (scene.anchor ? rig(scene.anchor) : undefined);
    const timeline = [...scene.timeline ?? []].sort((a, b) => a.t - b.t).map(step => step.do === 'blast' && step.aim && !step.camera ? { ...step, camera: rig(step.aim) } : step);
    if (repeat === 1) { resolved.push({ ...scene, ...(camera ? { camera } : {}), timeline }); save('resolved-scenes.json', resolved); }
    await bench('configure', { ...(camera ? { camera } : {}), epoch: scene.epoch ?? 100, ...(scene.skyTime !== undefined ? { skyTime: scene.skyTime } : {}),
      graphics: { tier: 'high', renderScale: 1, ...scene.graphics }, off: scene.off ?? [], clouds: scene.clouds });
    await bench('step', 60);
    await perf('realtime', true, 1);
    await sleep((scene.warmSeconds ?? 3) * 1000);
    const cdp = alloc ? await context.newCDPSession(page) : undefined;
    if (cdp) { await cdp.send('HeapProfiler.enable'); await cdp.send('HeapProfiler.startSampling', { samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true }); }
    if (trace) await browser.startTracing(page, { categories: ['-*', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8', 'disabled-by-default-v8.cpu_profiler', 'blink.user_timing', 'toplevel'] });
    const begin = await perf<number>('begin'), started = Date.now(), pending: Promise<unknown>[] = [];
    // Screenshots stall the page: a run that takes them is a visual record of the scenario, never a timing.
    const shots = shotEvery ? setInterval(() => { const at = ((Date.now() - started) / 1000).toFixed(1).padStart(5, '0');
      pending.push(page.screenshot({ path: join(out, `${label}-t${at}.png`) }).catch(() => {})); }, shotEvery * 1000) : undefined;
    for (const step of timeline) {
      await sleep(Math.max(0, started + step.t * 1000 - Date.now()));
      if (step.mark) await perf('mark', step.mark);
      if (step.do === 'keydown') await page.keyboard.down(step.key);
      else if (step.do === 'keyup') await page.keyboard.up(step.key);
      else if (step.do === 'press') await page.keyboard.press(step.key);
      else if (step.do === 'wheel') { await page.mouse.move(width / 2, height / 2); await page.mouse.wheel(0, step.deltaY); }
      else if (step.do === 'blast') pending.push(perf('blast', step.radius, step.munition, step.camera).catch(error => { failures.push(`blast failed: ${String(error).split('\n')[0]}`); }));
      else if (step.do === 'orbit') pending.push(orbit(page, step));
    }
    await sleep(Math.max(0, started + scene.seconds * 1000 - Date.now()));
    clearInterval(shots);
    const recording: Recording = { ...await perf('end'), begin };
    const traceBuffer = trace ? await browser.stopTracing() : undefined;
    const heapProfile = cdp ? (await cdp.send('HeapProfiler.stopSampling')).profile : undefined;
    await Promise.all(pending);
    await perf('realtime', false);
    const state = await bench('state'), shaders = await bench('shaders');
    await page.screenshot({ path: join(out, `${label}-end.png`) });
    const summary = summarizeRecording(recording);
    if (!recording.frames || summary.truncated) failures.push('no frames or truncated recording');
    if (state.engine.lost || state.engine.validationErrors || state.engine.compile.errors || !shaders.ok) failures.push('device, validation or shader error');
    if (pageErrors.length) failures.push('page errors');
    let traceSummary: unknown, allocations: unknown;
    if (traceBuffer) {
      writeFileSync(join(out, `${label}-trace.json`), traceBuffer);
      traceSummary = summarizeTrace(JSON.parse(traceBuffer.toString('utf8')).traceEvents, { name: 'tmt-perf-begin', now: begin, endNow: recording.end },
        frameWindows(recording, summary.worstFrames.slice(0, 6)));
    }
    if (heapProfile) allocations = summarizeAllocations(heapProfile as { head: unknown }, summary.seconds);
    save(`${label}.json`, { scene, repeat, failures, pageErrors, summary, trace: traceSummary, allocations, recording,
      state: { engine: state.engine, graphics: state.graphics, features: state.features, adapter: state.adapter, lightCount: state.lightCount, eventCounts: state.eventCounts, terrainVersion: state.game.terrainVersion } });
    runs.push({ scene: scene.name, repeat, file: `${label}.json`, valid: failures.length === 0, failures, summary });
    const pageVideo = page.video(); await context.close(); context = undefined;
    if (pageVideo) await pageVideo.saveAs(join(out, `${label}.webm`));
    errors.push(...failures.map(failure => `${label}: ${failure}`), ...pageErrors.map(error => `${label}: ${error}`));
    const c = summary.cadence;
    console.log(JSON.stringify({ run: label, fps: c && +c.fps.toFixed(1), p50: c?.p50, p95: c?.p95, p99: c?.p99, max: c?.max, over33: c?.hitches['over33.4ms'], over50: c?.hitches.over50ms,
      work95: summary.mainThreadFrameWorkMs?.p95, longTasks: summary.longTasks.count, failures }));
    save('summary.json', aggregate());
  }
} catch (error) {
  errors.push(error instanceof Error ? error.stack ?? error.message : String(error), ...(current?.pageErrors ?? []).map(e => `${current!.label}: ${e}`));
  process.exitCode = 1;
}
finally {
  if (errors.length) process.exitCode = 1;
  save('errors.json', errors); await context?.close().catch(() => {}); await browser?.close().catch(() => {});
  if (process.exitCode) save('browser-log.json', browserLog);
  gpuTelemetry?.kill(); writeFileSync(join(out, 'gpu-telemetry.csv'), gpuTelemetryCsv);
  unlock(); console.log(JSON.stringify({ out, runs: runs.length, errors }));
}

/** Per scene, the median over repeats of each headline number, with the individual runs beside it. */
function aggregate() {
  const median = (values: (number | null | undefined)[]) => distribution(values.filter((v): v is number => typeof v === 'number'))?.p50 ?? null;
  return [...new Set(runs.map(run => run.scene))].map(scene => {
    const group = runs.filter(run => run.scene === scene), pick = (read: (s: (typeof group)[number]['summary']) => number | null | undefined) => median(group.map(run => read(run.summary)));
    return { scene, repeats: group.length, valid: group.every(run => run.valid), files: group.map(run => run.file),
      fps: pick(s => s.cadence?.fps), frameMs: { p50: pick(s => s.cadence?.p50), p95: pick(s => s.cadence?.p95), p99: pick(s => s.cadence?.p99), max: pick(s => s.cadence?.max) },
      onePercentLowFps: pick(s => s.cadence?.onePercentLowFps), worstFrameMsPerRun: group.map(run => run.summary.cadence?.max ?? null),
      hitches: Object.fromEntries(Object.keys(group[0].summary.cadence?.hitches ?? {}).map(key => [key, pick(s => s.cadence?.hitches[key])])),
      stutters: pick(s => s.cadence?.stutters), excessMs: pick(s => s.cadence?.excessMs),
      mainThreadFrameWorkMs: { p50: pick(s => s.mainThreadFrameWorkMs?.p50), p95: pick(s => s.mainThreadFrameWorkMs?.p95), p99: pick(s => s.mainThreadFrameWorkMs?.p99), max: pick(s => s.mainThreadFrameWorkMs?.max) },
      gpuCompletionLatencyMs: { p50: pick(s => s.gpuCompletionLatencyMs?.p50), p95: pick(s => s.gpuCompletionLatencyMs?.p95), max: pick(s => s.gpuCompletionLatencyMs?.max) },
      longTasks: { count: pick(s => s.longTasks.count), totalMs: pick(s => s.longTasks.totalMs), maxMs: pick(s => s.longTasks.maxMs) },
      heap: { allocatedMBPerSecond: pick(s => s.heap?.allocatedMBPerSecond), collections: pick(s => s.heap?.collections), peakMB: pick(s => s.heap?.peakMB) } };
  });
}

/** The numeric rig of an anchor: the same construction as the fixed-step harness, around the tank or its nearest building. */
function anchoredRig(anchor: Anchor, state: any, seed: number): CameraRig {
  const tank = state.game.snapshot.tanks[0].position as number[];
  let p = tank;
  if (anchor.on === 'structure') {
    // The match generated these from its seed (src/gpu/terrain/planet.ts); the harness derives the same list.
    const structures = state.setup.structures ?? generatePlanetStructures(seed, undefined, !!state.game.terrain.sphericalNoise, state.game.terrain.planetKind);
    const distance = (s: { center: number[] }) => Math.hypot(...s.center.map((v, i) => v - tank[i]));
    p = [...structures].sort((a, b) => distance(a) - distance(b))[0].center;
  }
  const length = Math.hypot(...p), up = p.map(v => v / length);
  let side = [up[2], 0, -up[0]]; if (Math.hypot(...side) < 1e-6) side = [1, 0, 0]; const sl = Math.hypot(...side); side = side.map(v => v / sl);
  const tangent = [up[1] * side[2] - up[2] * side[1], up[2] * side[0] - up[0] * side[2], up[0] * side[1] - up[1] * side[0]];
  const along = tangent.map((v, i) => v * Math.cos(anchor.azimuth) + side[i] * Math.sin(anchor.azimuth));
  return { position: p.map((v, i) => v + up[i] * anchor.height - along[i] * anchor.back) as [number, number, number],
    target: p.map((v, i) => v + along[i] * (anchor.ahead ?? 0)) as [number, number, number], up: up as [number, number, number], fovY: 47 * Math.PI / 180 };
}

/** Several tanks around the first spawn with fog off: real mounted headlamps in view. A match needs two teams, so the
 * last tank is the drive target's. */
async function friendlyTanks(bench: (method: string, ...parameters: unknown[]) => Promise<any>, count: number) {
  const initial = await bench('state'), setup = structuredClone(initial.setup);
  const first = initial.game.snapshot.tanks[0], p = first.position as number[], length = Math.hypot(...p), up = p.map(v => v / length);
  let east = [up[2], 0, -up[0]]; if (Math.hypot(...east) < 1e-6) east = [1, 0, 0]; const el = Math.hypot(...east); east = east.map(v => v / el);
  const north = [up[1] * east[2] - up[2] * east[1], up[2] * east[0] - up[0] * east[2], up[0] * east[1] - up[1] * east[0]];
  setup.rules.fog = false; setup.tanks = Array.from({ length: count }, (_, i) => {
    const direction = up.map((v, axis) => v + east[axis] * (i % 2) * .17 + north[axis] * Math.floor(i / 2) * .17), dl = Math.hypot(...direction);
    return { ...setup.tanks[0], team: i === count - 1 ? 1 : 0, name: `Spotlight ${i + 1}`, spawn: { up: direction.map(v => v / dl), heading: first.heading } };
  });
  await bench('startMatch', setup); await bench('step', 1);
}

/** A real right-button drag: the camera orbits as it does for a player. */
async function orbit(page: Page, step: { dx: number; dy: number; seconds: number }) {
  const moves = Math.max(2, Math.round(step.seconds * 60)), x = width / 2 - step.dx / 2, y = height / 2 - step.dy / 2;
  await page.mouse.move(x, y); await page.mouse.down({ button: 'right' });
  for (let i = 1; i <= moves; i++) { await page.mouse.move(x + step.dx * i / moves, y + step.dy * i / moves); await sleep(step.seconds * 1000 / moves); }
  await page.mouse.up({ button: 'right' });
}
