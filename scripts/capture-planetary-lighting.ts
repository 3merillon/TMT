/** Actual-game fixed-step capture and raw GPU/CPU measurement. See docs/planetary-lighting.md. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import { acquireGpuLock } from './capture';
import { summarizeCapture } from './planetary-lighting-metrics';
import type { CameraRig } from '../src/engine/contracts';
import type { MunitionId } from '../src/game/munitions';

interface Scene { name: string; seed: number; skyTime: number; epoch: number; camera?: CameraRig; endCamera?: CameraRig;
  anchor?: { height: number; back: number; azimuth: number }; endAzimuth?: number; frames?: number; off?: string[]; graphics?: Record<string, unknown>; tanks?: number;
  /** The playground starts without fog of war; true restarts the match with the rule real matches use. */
  fog?: boolean;
  clouds?: { coverage?: number; density?: number };
  blast?: { frame: number; radius: number; munition?: MunitionId; camera?: CameraRig };
  measureImpact?: { radius: number; munition?: MunitionId; camera?: CameraRig } }
const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2), flag = (key: string) => args.includes(`--${key}`), value = (key: string, fallback: string) => args[args.indexOf(`--${key}`) + 1] && flag(key) ? args[args.indexOf(`--${key}`) + 1] : fallback;
const visual = flag('visual') || flag('motion'), lifecycle = flag('lifecycle');
const videoEnabled = visual && (flag('video') || flag('motion'));
const out = resolve(root, value('out', `artifacts/planetary-lighting/run-${Date.now()}`));
assert.ok(!existsSync(out), `Use a fresh output directory: ${out}`); mkdirSync(out, { recursive: true });
const width = Number(value('width', '1600')), height = Number(value('height', '1000'));
const warmup = Number(value('warmup', '600')), frames = Number(value('frames', '600'));
for (const [key, v] of Object.entries({ width, height, warmup, frames })) assert.ok(Number.isInteger(v) && v > 0, `${key} must be positive`);
const save = (name: string, data: unknown) => writeFileSync(join(out, name), JSON.stringify(data, null, 2));
const getGit = (...params: string[]) => { try { return execFileSync('git', params, { cwd: root, encoding: 'utf8' }).trim(); } catch { return null; } };
const tracked = getGit('ls-files', 'src', 'scripts', 'vite.config.ts', 'package-lock.json')?.split('\n') ?? [];
save('source-state.json', { head: getGit('rev-parse', 'HEAD'), status: getGit('status', '--porcelain'), diff: getGit('diff', '--binary'),
  sha256: Object.fromEntries(tracked.filter(path => existsSync(join(root, path))).map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')])) });
const defaults: Scene[] = [
  { name: 'temperate-low-sun-close', seed: 7, skyTime: 42, epoch: 100, anchor: { height: 3, back: 7, azimuth: 3.14 } },
  { name: 'temperate-grazing', seed: 7, skyTime: 50, epoch: 200, anchor: { height: .9, back: 5, azimuth: 4.71 } },
  { name: 'temperate-overview', seed: 7, skyTime: 0, epoch: 300, anchor: { height: 26, back: 46, azimuth: .8 } },
  { name: 'glacial-day', seed: 6, skyTime: 0, epoch: 400, anchor: { height: 8, back: 17, azimuth: .8 } },
  { name: 'volcanic-day', seed: 4, skyTime: 0, epoch: 500, anchor: { height: 8, back: 17, azimuth: .8 } },
  { name: 'dune-day', seed: 5, skyTime: 0, epoch: 600, anchor: { height: 8, back: 17, azimuth: .8 } },
  { name: 'temperate-night-spots', seed: 7, skyTime: 180, epoch: 700, anchor: { height: 3, back: 7, azimuth: 3.14 }, tanks: 4 },
  { name: 'temperate-camera-motion', seed: 7, skyTime: 42, epoch: 800, anchor: { height: 3, back: 7, azimuth: 3.14 }, endAzimuth: 4.71 },
];
const requested: Scene[] = flag('profile') ? JSON.parse(readFileSync(resolve(value('profile', '')), 'utf8')) : defaults.filter(s => visual || s.endAzimuth === undefined);
const names = flag('scenes') ? value('scenes', '').split(',') : null;
const scenes = requested.filter(s => !names || names.includes(s.name)); assert.ok(scenes.length, 'No selected scenes');
assert.ok(visual || scenes.every(s => !s.endCamera && s.endAzimuth === undefined), 'Moving camera timing is not supported; use --visual for paths');
assert.ok(visual || scenes.every(s => !s.blast), 'Terrain mutation timing is not supported; use --visual for blasts');
for (const scene of scenes) if (scene.blast) {
  assert.ok(Number.isInteger(scene.blast.frame) && scene.blast.frame >= 0 && scene.blast.frame < (scene.frames ?? frames), 'Blast frame must occur within the scene');
  assert.ok(Number.isFinite(scene.blast.radius) && scene.blast.radius > 0, 'Blast radius must be positive');
}
for (const scene of scenes) for (const impact of [scene.blast, scene.measureImpact]) if (impact) {
  assert.ok(Number.isFinite(impact.radius) && impact.radius > 0, 'Impact radius must be positive');
  assert.ok(impact.munition === undefined || ['explosive', 'heavy', 'incendiary', 'nuclear'].includes(impact.munition), 'Unknown munition');
}
assert.ok(!visual || scenes.every(scene => !scene.measureImpact), 'measureImpact is a measured workload; use blast for visual actions');
const errors: string[] = [], results: unknown[] = [], resolved: Scene[] = [];
let browser: Browser | undefined, context: BrowserContext | undefined, server: ViteDevServer | undefined;
let gpuTelemetry: ChildProcess | undefined, gpuTelemetryCsv = '', gpuTelemetryError = '';
const unlock = await acquireGpuLock();
try {
  gpuTelemetry = spawn('nvidia-smi', ['--query-gpu=timestamp,index,name,driver_version,utilization.gpu,clocks.gr,temperature.gpu,power.draw,memory.used,memory.total,clocks.mem,pstate', '--format=csv', '--loop-ms=1000'], { windowsHide: true });
  gpuTelemetry.stdout?.on('data', data => { gpuTelemetryCsv += String(data); });
  gpuTelemetry.stderr?.on('data', data => { gpuTelemetryError += String(data); });
  gpuTelemetry.on('error', error => { gpuTelemetryError += error.message; });
  let base = value('base', '');
  if (!base) {
    assert.ok(visual || flag('allow-dev'), 'Measurements require a production --base URL; --allow-dev explicitly labels a diagnostic run');
    server = await createServer({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn', cacheDir: join(root, '.vite-capture/planetary-lighting'),
      server: { host: '127.0.0.1', port: 0, open: false, hmr: false, watch: null } }); await server.listen(); base = server.resolvedUrls!.local[0];
  }
  const store = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  const executablePath = process.env.TMT_CHROME ?? readdirSync(store).filter(n => /^chromium-\d+$/.test(n)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    .map(n => join(store, n, 'chrome-win64/chrome.exe')).find(existsSync); assert.ok(executablePath, 'Set TMT_CHROME');
  browser = await chromium.launch({ executablePath, headless: true, ignoreDefaultArgs: ['--headless'], args: ['--headless=new', '--enable-unsafe-webgpu', '--enable-webgpu-developer-features',
    '--ignore-gpu-blocklist', '--enable-gpu', '--force-color-profile=srgb', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  let servedSource: unknown = null;
  if (!server) {
    try { const response = await fetch(new URL('source-state.json', base.endsWith('/') ? base : `${base}/`)); if (response.ok) servedSource = await response.json(); } catch { /* A generic server may omit provenance; keep this explicit. */ }
  }
  const metadata = { date: new Date().toISOString(), base, environment: value('environment', 'unspecified'), production: !server && (servedSource as any)?.production === true,
    servedSource, serverKind: server ? 'vite-development' : servedSource ? 'preserved-bundle' : 'external-unverified', visual, lifecycle,
    width, height, dpr: 1, warmup, frames, queuePacing: { maxSubmittedFrames: 2, mechanism: 'GPUQueue.onSubmittedWorkDone' }, cpu: cpus()[0]?.model, node: process.version, browser: browser.version(), args,
    limits: ['Tracked GPU allocation bytes are not driver VRAM residency.', 'GPU total sums timestamped passes; it is not GPU frame completion time.',
      'Exclusive is an operator declaration; the GPU lock coordinates TMT harnesses, not unrelated applications.', 'Visual runs are untimed.'] };
  save('metadata.json', metadata);
  for (const scene of scenes) {
    context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1,
      ...(videoEnabled ? { recordVideo: { dir: out, size: { width, height } } } : {}) });
    await context.route(/\/favicon\.ico/, route => route.fulfill({ status: 204, body: '' }));
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.stack ?? e.message)); page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
    const call = async<T = any>(method: string, ...parameters: unknown[]): Promise<T> => {
      const result = await page.evaluate(({ method, parameters }) => (window as any).__tmtRenderBench[method](...parameters), { method, parameters });
      if (visual && method === 'step' && result.some((sample: any) => sample.cameraInsideTerrain)) {
        save(`${scene.name}-camera-failure.json`, { parameters, samples: result, state: await page.evaluate(() => (window as any).__tmtRenderBench.state()) });
        await page.screenshot({ path: join(out, `${scene.name}-invalid-camera.png`) });
        throw new Error(`${scene.name}: a visual frame camera entered terrain`);
      }
      return result;
    };
    const url = new URL(`play.html?mode=dev&seed=${scene.seed}&renderbench`, base.endsWith('/') ? base : `${base}/`);
    await page.goto(url.href, { waitUntil: 'domcontentloaded' }); await page.waitForFunction(() => (window as any).__tmtRenderBench?.ready, undefined, { timeout: 180000 });
    // Matched screenshots also drop the live FPS readout and the wall-clock toast: both differ between any two runs.
    await page.addStyleTag({ content: `.dev-panel,.tank-labels,.trajectory-readout,.aim-target-readout,.engine-fps${visual ? ',.telemetry,#toast' : ''}{display:none!important}` });
    await call('step', 1);
    if (scene.tanks && scene.tanks > 2) {
      const initial = await call('state'), setup = structuredClone(initial.setup);
      const first = initial.game.snapshot.tanks[0], p = first.position as number[], length = Math.hypot(...p), up = p.map(v => v / length);
      let east = [up[2], 0, -up[0]]; if (Math.hypot(...east) < 1e-6) east = [1, 0, 0]; const el = Math.hypot(...east); east = east.map(v => v / el);
      const north = [up[1] * east[2] - up[2] * east[1], up[2] * east[0] - up[0] * east[2], up[0] * east[1] - up[1] * east[0]];
      // Explicit nearby planet directions keep several real mounted headlamps in the camera workload. Match setup
      // rejects a single team, so the last tank belongs to the drive target's team; fog is off, so it is still drawn.
      setup.rules.fog = false; setup.tanks = Array.from({ length: scene.tanks }, (_, i) => {
        const direction = up.map((v, axis) => v + east[axis] * (i % 2) * .17 + north[axis] * Math.floor(i / 2) * .17), dl = Math.hypot(...direction);
        return { ...setup.tanks[0], team: i === scene.tanks! - 1 ? 1 : 0, name: `Spotlight ${i + 1}`, spawn: { up: direction.map(v => v / dl), heading: first.heading } };
      });
      await call('startMatch', setup); await call('step', 1);
    } else if (scene.fog) {
      const setup = structuredClone((await call('state')).setup); setup.rules.fog = true;
      await call('startMatch', setup); await call('step', 1);
    }
    await call('configure', { simulationScale: 1 }); await call('step', 120); await call('configure', { simulationScale: 0 });
    const initial = await call('state');
    const anchor = (azimuth: number): CameraRig => {
      const p = initial.game.snapshot.tanks[0].position as number[], len = Math.hypot(...p), up = p.map(v => v / len);
      let side = [up[2], 0, -up[0]]; if (Math.hypot(...side) < 1e-6) side = [1, 0, 0]; const sl = Math.hypot(...side); side = side.map(v => v / sl);
      const tangent = [up[1] * side[2] - up[2] * side[1], up[2] * side[0] - up[0] * side[2], up[0] * side[1] - up[1] * side[0]];
      const a = scene.anchor!;
      return { position: p.map((v, i) => v + up[i] * a.height - (tangent[i] * Math.cos(azimuth) + side[i] * Math.sin(azimuth)) * a.back) as [number, number, number],
        target: p as [number, number, number], up: up as [number, number, number], fovY: 47 * Math.PI / 180 };
    };
    const numeric = { ...scene, camera: scene.camera ?? anchor(scene.anchor!.azimuth), endCamera: scene.endCamera ?? (scene.endAzimuth !== undefined ? anchor(scene.endAzimuth) : undefined) };
    resolved.push(numeric); save('resolved-scenes.json', resolved);
    await call('configure', { camera: numeric.camera, epoch: scene.epoch, skyTime: scene.skyTime, graphics: { tier: 'high', renderScale: 1, grain: 0, miniature: 0, fisheye: 0, ...scene.graphics }, off: scene.off ?? [], clouds: scene.clouds });
    await call('step', warmup);
    const count = scene.frames ?? frames;
    if (visual) {
      const states: unknown[] = [await call('state')];
      let blastJob: Promise<void> | undefined, blastSettled = false, blastError: unknown, blastBefore: any;
      await page.screenshot({ path: join(out, `${scene.name}-start.png`) });
      for (let frame = 0; frame < count; frame++) {
        if (scene.blast?.frame === frame) {
          blastBefore = await call('state');
          // Terrain commits need rendering to continue while the asynchronous carve uploads.
          blastJob = call('blast', scene.blast.radius, scene.blast.munition, scene.blast.camera).then(() => { blastSettled = true; }, error => { blastError = error; blastSettled = true; });
        }
        if (numeric.endCamera) {
          const t = frame / Math.max(1, count - 1), from = numeric.camera, to = numeric.endCamera;
          await call('configure', { camera: { ...from, position: from.position.map((v, i) => v + (to.position[i] - v) * t), target: from.target.map((v, i) => v + (to.target[i] - v) * t) } });
        }
        await call('step', 1);
        if ((!videoEnabled || flag('shot-every')) && frame % Number(value('shot-every', '30')) === 0) { await page.screenshot({ path: join(out, `${scene.name}-${String(frame).padStart(4, '0')}.png`) }); states.push(await call('state')); }
      }
      if (blastJob) {
        let commitTailFrames = 0;
        while (!blastSettled && commitTailFrames < 600) { await call('step', 1); commitTailFrames++; }
        assert.ok(blastSettled, 'Terrain blast did not settle within 600 extra rendered frames');
        await blastJob; if (blastError) throw blastError;
        const blastAfter = await call('state');
        save(`${scene.name}-blast.json`, { request: scene.blast, commitTailFrames, before: blastBefore, after: blastAfter });
        assert.ok(blastAfter.game.terrainVersion > blastBefore.game.terrainVersion, 'Terrain blast did not commit');
      }
      await page.screenshot({ path: join(out, `${scene.name}-end.png`) }); states.push(await call('state'));
      if (flag('motion')) await motionChecks(page, call, scene.name);
      const shaders = await call('shaders'); assert.equal(shaders.ok, true);
      if (lifecycle) await lifecycleChecks(page, call, scene.name);
      save(`${scene.name}.json`, { scene: numeric, states, shaders, errors });
    } else {
      assert.ok(!numeric.endCamera, 'Moving camera timing requires a fixed-frame in-page path; use --visual for this scene');
      const scale = Number(scene.graphics?.renderScale ?? 1);
      const measured = await call('measure', count, scene.measureImpact), summary = summarizeCapture(measured, count, {
        display: [width, height], internal: [Math.round(width * scale), Math.round(height * scale)], tier: String(scene.graphics?.tier ?? 'high'),
      });
      save(`${scene.name}.json`, { scene: numeric, ...measured, summary }); results.push({ scene: scene.name, ...summary }); save('summary.json', results);
      assert.ok(summary.valid, summary.failures.join(', ')); console.log(JSON.stringify({ scene: scene.name, gpu: summary.gpuMs, cpu: summary.encodeCpuMs, bytes: summary.trackedGpuBytes }));
      if (scene.measureImpact) {
        assert.ok(measured.action?.settled && !measured.action.error, 'Measured real terrain blast did not complete');
        assert.ok(measured.action.terrainVersionAfter > measured.action.terrainVersionBefore, 'Measured blast did not commit terrain');
      }
    }
    const video = page.video(); await context.close(); context = undefined;
    if (video) await video.saveAs(join(out, `${scene.name}.webm`));
    assert.deepEqual(errors, [], 'Browser errors make this run invalid');
  }
} catch (error) { errors.push(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; }
finally {
  save('errors.json', errors); await context?.close(); await browser?.close(); await server?.close();
  gpuTelemetry?.kill(); writeFileSync(join(out, 'gpu-telemetry.csv'), gpuTelemetryCsv);
  save('gpu-telemetry-status.json', { available: gpuTelemetryCsv.length > 0, error: gpuTelemetryError || null, note: 'Read-only 1 Hz nvidia-smi device totals include other applications; not per-process resource accounting.' });
  unlock(); console.log(JSON.stringify({ out, scenes: resolved.length, errors }));
}

async function lifecycleChecks(page: Page, call: (method: string, ...parameters: unknown[]) => Promise<any>, name: string) {
  const checks: { phase: string; state: any }[] = [];
  const record = async (phase: string, tier: string, display = [width, height], scale = 1) => {
    const state = await call('state'); checks.push({ phase, state }); save(`${name}-lifecycle.json`, { checks });
    assert.equal(state.engine.tier, tier, `${phase}: tier`);
    assert.deepEqual(state.engine.display, display, `${phase}: display size`);
    assert.deepEqual(state.engine.internal, display.map(v => Math.round(v * scale)), `${phase}: render scale`);
    for (const name of ['cloudRaw', 'cloudMeta', 'cloudColor', 'volumetricHaze', 'volumetricDistance']) {
      const size = state.renderTargets[name], divisor = name.startsWith('cloud') ? 1 : 4;
      assert.deepEqual([size?.width, size?.height], state.engine.internal.map((v: number) => Math.max(1, Math.ceil(v / divisor))), `${phase}: ${name} size`);
    }
    const flowTier: Record<string, [number, number]> = { low: [24, 4], medium: [32, 8], high: [48, 8], ultra: [48, 12] };
    const [flowN, flowSlots] = flowTier[tier], custom = state.engine.custom;
    assert.equal(custom.gasCloudFlowResolution, flowN, `${phase}: gas flow resolution`);
    assert.equal(custom.gasCloudFlowSlots, flowSlots, `${phase}: gas flow slots`);
    assert.equal(custom.gasCloudFlowBytes, 2 * flowN ** 3 * flowSlots * 8 + 784, `${phase}: gas flow allocation`);
    assert.ok(!state.engine.lost && state.engine.validationErrors === 0 && state.engine.compile.errors === 0 && state.engine.compile.pending === 0, `${phase}: renderer error`);
    return state;
  };
  await call('configure', { graphics: { tier: 'high', renderScale: 1 } }); await call('step', 60);
  const original = await record('baseline', 'high');
  await call('configure', { graphics: { clouds: false, volumetrics: false, lensFlare: false, godRays: false } }); await call('step', 60);
  const off = await record('effects-off', 'high');
  assert.equal(off.features.clouds.enabled, false); assert.equal(off.features.volumetrics.enabled, false);
  assert.equal(off.features.post.flare, false); assert.equal(off.features.post.godRays, false);
  await page.screenshot({ path: join(out, `${name}-effects-off.png`) });
  await call('configure', { graphics: { clouds: true, volumetrics: true, lensFlare: true, godRays: true }, off: [] }); await call('step', 60);
  const on = await record('effects-on', 'high');
  assert.equal(on.features.clouds.enabled, true); assert.equal(on.features.volumetrics.enabled, true);
  assert.equal(on.features.post.flare, true); assert.equal(on.features.post.godRays, true);
  for (const tier of ['low', 'medium', 'high', 'ultra']) {
    await call('configure', { graphics: { tier, renderScale: .75 } }); await call('step', 60); await record(`tier-${tier}`, tier, [width, height], .75);
  }
  await page.setViewportSize({ width: 1024, height: 768 }); await call('step', 60); await record('resize-small', 'ultra', [1024, 768], .75);
  await page.setViewportSize({ width, height }); await call('configure', { graphics: { tier: 'high', renderScale: 1 } }); await call('step', 90);
  const restored = await record('resize-restored', 'high');
  // Render-graph and feature allocations must return to their original size after deferred retirement.
  const stableCategories = ['screen', 'cloud', 'volumetrics', 'optics', 'fluids'];
  // TMT_LIFECYCLE_CONTINUE=1 records a failed allocation check and carries on, so one run also reports the later checks
  // (a diagnosis: the run still fails at the end).
  const soft = process.env.TMT_LIFECYCLE_CONTINUE === '1', softFailures: string[] = [];
  const check = (run: () => void) => { if (!soft) return run(); try { run(); } catch (error) { softFailures.push(error instanceof Error ? error.message : String(error)); } };
  const assertStable = (state: any, phase: string) => { for (const category of stableCategories)
    check(() => assert.equal(state.engine.vram.byCategory[category], original.engine.vram.byCategory[category], `${phase}: retained ${category} allocations`)); };
  assertStable(restored, 'resize-restored');
  const scene = await call('state'), camera = structuredClone(scene.camera); camera.position = camera.position.map((v: number) => v * 1.5);
  await call('configure', { camera }); await call('step', 1); await record('camera-jump', 'high'); await call('configure', { camera: scene.camera }); await call('step', 60);
  for (let cycle = 1; cycle <= 2; cycle++) {
    await call('endMatch'); await call('startMatch', scene.setup); await call('step', 1);
    const first = await record(`scene-reentry-first-frame-${cycle}`, 'high');
    assert.equal(first.engine.custom.cloudsShockwaves, 0, 'Scene reentry retained cloud shockwaves');
    await call('step', 179);
    const restarted = await record(`scene-reentry-${cycle}`, 'high'); assertStable(restarted, `scene-reentry-${cycle}`);
    assert.equal(restarted.lightCount, original.lightCount, 'Scene reentry retained or lost mounted lights');
  }
  const shaders = await call('shaders'); assert.equal(shaders.ok, true);
  const disposal = await call('disposeRenderer');
  const released = () => assert.equal(disposal.after.total, 0, 'Renderer teardown retained tracked GPU resources');
  if (soft) check(released);
  save(`${name}-lifecycle.json`, { checks, stableCategories, shaders, disposal, softFailures });
  if (!soft) released();
  assert.deepEqual(softFailures, [], 'Lifecycle checks failed');
}

async function motionChecks(page: Page, call: (method: string, ...parameters: unknown[]) => Promise<any>, name: string) {
  const states: { phase: string; state: any }[] = [], record = async (phase: string) => {
    const state = await call('state'); states.push({ phase, state }); save(`${name}-motion.json`, states);
    await page.screenshot({ path: join(out, `${name}-${phase}.png`) }); return state;
  };
  const opening = await call('state'), rig = opening.camera;
  await call('configure', { camera: { ...rig, position: rig.position.map((v: number, i: number) => rig.target[i] + (v - rig.target[i]) * 1.6) } });
  await call('step', 30);
  const initial = await record('before-drive');
  await call('configure', { simulationScale: 1 });
  await page.keyboard.down('KeyW'); await call('step', 90);
  await page.keyboard.down('KeyD'); await call('step', 45);
  await page.keyboard.up('KeyW'); await page.keyboard.up('KeyD'); await call('step', 60);
  const moved = await record('after-drive'), position = (s: any) => s.game.snapshot.tanks[0].position as number[];
  assert.ok(Math.hypot(...position(moved).map((v, i) => v - position(initial)[i])) > .5, 'Real WASD drive did not move the tank');
  await page.keyboard.press('Space'); await call('step', 600); const fired = await record('after-fire');
  assert.ok((fired.eventCounts.shot ?? 0) > (moved.eventCounts.shot ?? 0), 'Real Space input did not fire a shot');
  const before = await call('state');
  // Carve uploads advance on real renderer frames; do not deadlock a paused benchmark while waiting for a commit.
  await Promise.all([call('blast', 2.25), call('step', 360)]);
  const crater = await record('after-crater');
  assert.ok(crater.game.terrainVersion > before.game.terrainVersion, 'Terrain blast did not commit');
  await call('configure', { simulationScale: 0 });
  const oldCamera = crater.camera, target = oldCamera.target, up = oldCamera.up;
  const offset = oldCamera.position.map((v: number, i: number) => v - target[i]);
  const angle = .7, cross = [up[1] * offset[2] - up[2] * offset[1], up[2] * offset[0] - up[0] * offset[2], up[0] * offset[1] - up[1] * offset[0]];
  const dot = up.reduce((sum: number, v: number, i: number) => sum + v * offset[i], 0);
  for (let frame = 1; frame <= 90; frame++) {
    const a = angle * frame / 90;
    await call('configure', { camera: { ...oldCamera, position: offset.map((v: number, i: number) => target[i] + v * Math.cos(a) + cross[i] * Math.sin(a) + up[i] * dot * (1 - Math.cos(a))) } });
    await call('step', 1);
  }
  await record('crater-orbit');
}
