/**
 * Temporal upscaler evaluation (src/engine/passes/post/tsr.ts) in the real game, fixed-step like
 * scripts/capture-planetary-lighting.ts: one deterministic timeline (camera path, optional blast) rendered at native and
 * at each render scale, in a fresh page each, with canvas-only screenshots (the DOM HUD is display resolution in every
 * arm), the upscaler's debug views, and the temporal instability of a still view: per-pixel luma spread over consecutive
 * frames, which is what shimmer and crawl are.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/tsr-eval.ts --base http://127.0.0.1:5211/ --out <new dir>
 *     [--arms a=http://127.0.0.1:5211/;b=http://127.0.0.1:5261/] [--plan scripts/capture-plans/tsr-eval.json] [--scenes a,b]
 *     [--scales 1,0.77,0.67,0.5] [--views motion,disocclusion,locks,age,reactive] [--tune sharpness=0.5] [--off taa] [--warmup 240]
 * Writes <scene>-<scale>-<frame>.png (and -<view>- for debug views), a report.json with every shot compared against the
 * native one (identical, mean difference, PSNR, SSIM, changed shares) and the stability figures, and amplified
 * difference images under diff/.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { acquireGpuLock } from './capture';
import { compareImages } from './compare-captures';
import { decodePng, encodePng, type RgbaImage } from './image-metrics';
import type { CameraRig } from '../src/engine/contracts';

interface Scene {
  name: string; seed: number; skyTime: number; epoch: number; tanks?: number; clouds?: { coverage?: number; density?: number };
  camera: CameraRig; frames: number; shots: number[];
  /** lerp: position and target move linearly to `to`; orbit: the eye turns `angle` radians round the target about `up`. */
  path?: { kind: 'lerp'; to: CameraRig } | { kind: 'orbit'; angle: number };
  blast?: { frame: number; radius: number; munition?: string; camera?: CameraRig };
  /** Consecutive frames for the instability figure: after a still timeline, or the last ones of a slow (creeping) path. */
  stability?: number;
}

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2), flag = (key: string) => args.includes(`--${key}`);
const value = (key: string, fallback: string) => flag(key) && args[args.indexOf(`--${key}`) + 1] ? args[args.indexOf(`--${key}`) + 1] : fallback;
const out = resolve(root, value('out', `artifacts/perf/tsr-eval-${Date.now()}`));
assert.ok(!existsSync(out), `Use a fresh output directory: ${out}`); mkdirSync(join(out, 'diff'), { recursive: true });
/** --base URL, or --arms label=URL|lever=v,lever=v|scale,scale|scene,scene;label=URL to render the same timelines from
 * several served builds or upscaler levers (each at its own scales, by default --scales, and optionally on some scenes
 * only) under one GPU lock. */
interface Arm { label: string; url: string; tune: Record<string, number>; scales?: number[]; scenes?: string[] }
const levers = (spec: string) => Object.fromEntries(spec.split(',').filter(Boolean).map(kv => { const [k, v] = kv.split('='); return [k, Number(v)]; }));
const base = value('base', '');
const arms: Arm[] = flag('arms') ? value('arms', '').split(';').map(a => {
  const [head, spec = '', only = '', where = ''] = a.split('|');
  return { label: head.slice(0, head.indexOf('=')), url: head.slice(head.indexOf('=') + 1), tune: levers(spec), scales: only ? only.split(',').map(Number) : undefined,
    scenes: where ? where.split(',') : undefined };
}) : [{ label: '', url: base, tune: {} }];
assert.ok(arms.every(a => a.url), 'Pass the --base URL of a served production build (or --arms)');
const plan: Scene[] = JSON.parse(readFileSync(resolve(root, value('plan', 'scripts/capture-plans/tsr-eval.json')), 'utf8'));
const names = flag('scenes') ? value('scenes', '').split(',') : null;
const scenes = plan.filter(s => !names || names.includes(s.name)); assert.ok(scenes.length, 'No selected scenes');
const scales = value('scales', '1,0.77,0.67,0.5').split(',').map(Number);
const views = flag('views') ? value('views', '').split(',') : [];
/** Debug views are rendered for the first arm only, at this scale, for these scenes (all by default). */
const viewScale = Number(value('view-scale', '0.67'));
const viewScenes = flag('view-scenes') ? value('view-scenes', '').split(',') : null;
const warmup = Number(value('warmup', '240'));
/** Upscaler levers to try (TsrControls fields), e.g. --tune sharpness=0.5,reactiveGain=2. */
const tune = levers(value('tune', ''));
/** Effects switched off for an attribution arm (render-bench `off` names, e.g. taa). */
const off = value('off', '').split(',').filter(Boolean);
const width = 1600, height = 1000;
const report: Record<string, unknown>[] = [], errors: string[] = [];
const save = () => writeFileSync(join(out, 'report.json'), JSON.stringify({ arms, scales, views, warmup, tune, off, report, errors }, null, 1));

function cameraAt(scene: Scene, t: number): CameraRig {
  const from = scene.camera, path = scene.path;
  if (!path) return from;
  if (path.kind === 'lerp') {
    const mix = (a: readonly number[], b: readonly number[]) => a.map((v, i) => v + (b[i] - v) * t) as [number, number, number];
    return { ...from, position: mix(from.position, path.to.position), target: mix(from.target, path.to.target) };
  }
  const o = from.position.map((v, i) => v - from.target[i]), u = from.up, a = path.angle * t;
  const cross = [u[1] * o[2] - u[2] * o[1], u[2] * o[0] - u[0] * o[2], u[0] * o[1] - u[1] * o[0]];
  const dot = u[0] * o[0] + u[1] * o[1] + u[2] * o[2];
  return { ...from, position: o.map((v, i) => from.target[i] + v * Math.cos(a) + cross[i] * Math.sin(a) + u[i] * dot * (1 - Math.cos(a))) as [number, number, number] };
}

/** Per-pixel luma standard deviation over frames: mean over the image and the 99th percentile, plus a heat map. */
function instability(frames: RgbaImage[]) {
  const n = frames.length, px = frames[0].width * frames[0].height, sd = new Float32Array(px);
  for (let p = 0; p < px; p++) {
    let s = 0, s2 = 0;
    for (const f of frames) { const l = 0.2126 * f.data[p * 4] + 0.7152 * f.data[p * 4 + 1] + 0.0722 * f.data[p * 4 + 2]; s += l; s2 += l * l; }
    sd[p] = Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
  }
  const sorted = Float32Array.from(sd).sort();
  const heat = new Uint8Array(px * 4);
  for (let p = 0; p < px; p++) { const v = Math.min(255, sd[p] * 32); heat[p * 4] = v; heat[p * 4 + 1] = v * 0.5; heat[p * 4 + 3] = 255; }
  return { mean: sd.reduce((a, b) => a + b, 0) / px, p99: sorted[Math.floor(px * 0.99)], over2: sd.filter(v => v > 2).length / px,
    heat: { width: frames[0].width, height: frames[0].height, data: heat } as RgbaImage };
}

async function run(browser: Browser, arm: Arm, scene: Scene, scale: number, view: string): Promise<Record<string, RgbaImage>> {
  const base = arm.url;
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  await context.route(/\/favicon\.ico/, route => route.fulfill({ status: 204, body: '' }));
  const shots: Record<string, RgbaImage> = {};
  try {
    const page: Page = await context.newPage();
    page.on('pageerror', e => errors.push(`${scene.name}@${scale}: ${e.stack ?? e.message}`));
    page.on('console', e => { if (e.type() === 'error') errors.push(`${scene.name}@${scale}: ${e.text()}`); });
    const call = async<T = any>(method: string, ...parameters: unknown[]): Promise<T> =>
      page.evaluate(({ method, parameters }) => (window as any).__tmtRenderBench[method](...parameters), { method, parameters });
    await page.goto(new URL(`play.html?mode=dev&seed=${scene.seed}&renderbench`, base.endsWith('/') ? base : `${base}/`).href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).__tmtRenderBench?.ready, undefined, { timeout: 180000 });
    // Only the scene: the HUD is DOM at display resolution in every arm.
    await page.addStyleTag({ content: '*{visibility:hidden!important}canvas.game-canvas{visibility:visible!important}' });
    await call('step', 1);
    if (scene.tanks && scene.tanks > 2) {
      const initial = await call('state'), setup = structuredClone(initial.setup);
      const first = initial.game.snapshot.tanks[0], p = first.position as number[], length = Math.hypot(...p), up = p.map(v => v / length);
      let east = [up[2], 0, -up[0]]; if (Math.hypot(...east) < 1e-6) east = [1, 0, 0]; const el = Math.hypot(...east); east = east.map(v => v / el);
      const north = [up[1] * east[2] - up[2] * east[1], up[2] * east[0] - up[0] * east[2], up[0] * east[1] - up[1] * east[0]];
      setup.rules.fog = false; setup.tanks = Array.from({ length: scene.tanks }, (_, i) => {
        const direction = up.map((v, axis) => v + east[axis] * (i % 2) * .17 + north[axis] * Math.floor(i / 2) * .17), dl = Math.hypot(...direction);
        return { ...setup.tanks[0], team: i === scene.tanks! - 1 ? 1 : 0, name: `Spotlight ${i + 1}`, spawn: { up: direction.map(v => v / dl), heading: first.heading } };
      });
      await call('startMatch', setup); await call('step', 1);
    }
    await call('configure', { simulationScale: 1 }); await call('step', 120); await call('configure', { simulationScale: 0 });
    await call('configure', { camera: scene.camera, epoch: scene.epoch, skyTime: scene.skyTime, clouds: scene.clouds, off, tsr: { debugView: view, ...tune, ...arm.tune },
      graphics: { tier: 'high', renderScale: scale, grain: 0, miniature: 0, fisheye: 0, clouds: true, volumetrics: true, lensFlare: true, godRays: true } });
    // The upscaler builds on first need: how many frames (and how long) the TAA's upscale branch stands in.
    const started = Date.now();
    let building = 0;
    while (building < 600 && !(await call('state')).engine.gpu.passes.some((p: { name: string }) => p.name === 'tsr.accumulate') && scale < 1) { await call('step', 1); building++; }
    if (scale < 1) report.push({ scene: scene.name, arm: arm.label, scale, kind: 'first-use', frames: building, ms: Date.now() - started });
    await call('step', warmup);
    const upscaled = (await call('state')).engine.gpu.passes.some((p: { name: string; ms: number }) => p.name === 'tsr.accumulate' && p.ms > 0);
    assert.equal(upscaled, scale < 1, `${scene.name}@${scale}: upscaler ${upscaled ? 'ran' : 'did not run'}`);
    let settled = true;
    const grab = async (name: string) => { shots[name] = decodePng(await page.screenshot()); writeFileSync(join(out, `${name}.png`), encodePng(shots[name])); };
    const tag = `${scene.name}${arm.label ? `-${arm.label}` : ''}-${scale}${view === 'off' ? '' : `-${view}`}`;
    // On a path, the instability frames are its last ones: a creep slow enough that the picture barely moves shows the
    // flicker of the resolve itself.
    const frames: RgbaImage[] = [];
    for (let frame = 0; frame < scene.frames; frame++) {
      if (scene.blast?.frame === frame) {
        settled = false;
        // Terrain commits need rendering to continue while the asynchronous carve uploads.
        void call('blast', scene.blast.radius, scene.blast.munition, scene.blast.camera).then(() => { settled = true; }, e => { errors.push(String(e)); settled = true; });
      }
      if (scene.path) await call('configure', { camera: cameraAt(scene, frame / Math.max(1, scene.frames - 1)) });
      await call('step', 1);
      if (scene.shots.includes(frame)) await grab(`${tag}-${String(frame).padStart(4, '0')}`);
      if (scene.path && scene.stability && view === 'off' && frame >= scene.frames - scene.stability) frames.push(decodePng(await page.screenshot()));
    }
    for (let tail = 0; !settled && tail < 600; tail++) await call('step', 1);
    if (scene.stability && view === 'off') {
      for (let i = frames.length; i < scene.stability; i++) { await call('step', 1); frames.push(decodePng(await page.screenshot())); }
      const s = instability(frames);
      writeFileSync(join(out, `${tag}-instability.png`), encodePng(s.heat));
      report.push({ scene: scene.name, arm: arm.label, scale, kind: 'instability', frames: scene.stability, mean: s.mean, p99: s.p99, over2: s.over2 });
    }
    const state = await call('state');
    report.push({ scene: scene.name, arm: arm.label, scale, view, kind: 'state', display: state.engine.display, internal: state.engine.internal,
      passes: state.engine.gpu.passes.filter((p: { name: string }) => /^(taa|tsr)/.test(p.name)), validationErrors: state.engine.validationErrors, vram: state.engine.vram.byCategory });
  } finally { await context.close(); }
  return shots;
}

let browser: Browser | undefined;
const unlock = await acquireGpuLock();
try {
  const store = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  const executablePath = process.env.TMT_CHROME ?? readdirSync(store).filter(n => /^chromium-\d+$/.test(n)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    .map(n => join(store, n, 'chrome-win64/chrome.exe')).find(existsSync); assert.ok(executablePath, 'Set TMT_CHROME');
  browser = await chromium.launch({ executablePath, headless: true, ignoreDefaultArgs: ['--headless'], args: ['--headless=new', '--enable-unsafe-webgpu', '--enable-webgpu-developer-features',
    '--ignore-gpu-blocklist', '--enable-gpu', '--force-color-profile=srgb', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  for (const scene of scenes) {
    // The reference is the first arm's native frame of the same timeline.
    const native = new Map<string, RgbaImage>();
    for (const arm of arms.filter(a => !a.scenes || a.scenes.includes(scene.name))) for (const scale of arm.scales ?? scales) {
      const shots = await run(browser, arm, scene, scale, 'off');
      for (const [name, image] of Object.entries(shots)) {
        const frame = name.slice(name.lastIndexOf('-') + 1), reference = native.get(frame);
        if (!reference) { if (scale === 1) native.set(frame, image); continue; }
        const { diff, ...metrics } = compareImages(reference, image);
        writeFileSync(join(out, 'diff', `${name}.png`), encodePng(diff));
        report.push({ scene: scene.name, arm: arm.label, scale, kind: 'shot', name, ...metrics, psnr: Number.isFinite(metrics.psnr) ? metrics.psnr : null });
      }
      save();
      if (scale === viewScale && arm === arms[0] && (!viewScenes || viewScenes.includes(scene.name))) for (const view of views) { await run(browser, arm, scene, scale, view); save(); }
      console.log(JSON.stringify({ scene: scene.name, arm: arm.label, scale, shots: Object.keys(shots).length, errors: errors.length }));
    }
  }
} catch (error) { errors.push(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; }
finally { save(); await browser?.close(); unlock(); console.log(JSON.stringify({ out, errors })); }
