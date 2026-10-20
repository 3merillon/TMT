/** Real hardware-WebGPU qualification. Run with node node_modules/tsx/dist/cli.mjs scripts/capture-projectile-effects.ts.
 * --smoke runs one launch; --full includes all rounds, cameras, tiers, water and repeated blasts.
 * --driving-only checks guide motion; --controls-only checks right-drag aiming, driving, wheel zoom and the real servo worklet.
 * Add --motion-only for uninterrupted video and --visual-only to skip the separate performance context.
 * Videos/frame sequences are visual evidence; timed samples exclude screenshot/video overhead. */
import { chromium, type Page } from 'playwright-core';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { acquireGpuLock } from './capture';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, process.env.TMT_FX_OUT ?? 'artifacts/projectile-effects');
const full = process.argv.includes('--full');
const perfOnly = process.argv.includes('--perf-only');
const motionOnly = process.argv.includes('--motion-only');
const drivingOnly = process.argv.includes('--driving-only');
const controlsOnly = process.argv.includes('--controls-only');
const filter = process.argv.find(arg => arg.startsWith('--filter='))?.slice(9);
mkdirSync(out, { recursive: true });
const release = await acquireGpuLock();
const server = await createServer({ root, configFile: resolve(root, 'vite.config.ts'), logLevel: 'warn',
  cacheDir: resolve(root, '.vite-capture'), server: { host: '127.0.0.1', port: 0, hmr: false, watch: null, open: false } });
await server.listen();
const base = server.resolvedUrls!.local[0];
const browser = await chromium.launch({ executablePath: process.env.TMT_CHROME ?? 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  headless: true, args: ['--headless=new', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu',
    '--enable-webgpu-developer-features', '--force-color-profile=srgb', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'], ignoreDefaultArgs: ['--headless'] });
const report: any = { date: new Date().toISOString(), browser: browser.version(), hardware: null, cases: [], errors: [] };

async function instrument(page: Page) {
  await page.evaluate(async () => {
    const w = window as any;
    const { session } = await import('/src/game/api/session.ts' as string);
    const { registerHooks } = await import('/src/game/app/hooks.ts' as string);
    w.fxSession = session();
    w.fx = { events: [], frames: [], followFlight: false, camera: 'normal', sample: false, scale: 1 };
    registerHooks('projectile-qualification', {
      timeScale: () => w.fx.scale,
      onEvent(e: any) { if (e.type === 'shot' || e.type === 'impact') w.fx.events.push({ at: performance.now(), event: structuredClone(e) }); },
      onFrame(f: any) {
        const x = w.fx;
        const p = f.snapshot?.projectiles[0];
        if (x.followFlight && p) w.__tmtFluids.lookAt(p.position, .4, x.camera === 'detail' ? 1.35 : 5, 1.15);
        if (x.sample && x.frames.length < 3000) {
          const perf = w.__tmtGame.performance;
          const fluids = w.__tmtFluids.stats(), engine = w.__tmtVisuals.telemetry();
          x.frames.push({ at: performance.now(), dt: f.realDt * 1000, gpu: perf.gpu, draws: perf.draws, triangles: perf.triangles,
            validationErrors: perf.validationErrors, compileErrors: perf.compileErrors, vram: perf.renderer?.vram, cpu: engine.cpu,
            heapBytes: (performance as any).memory?.usedJSHeapSize,
            muzzles: perf.muzzles, shells: perf.shells, fluids,
            shockwaves: w.__tmtVisuals.scene()?.get('shockwaves')?.stats(), projectile: p ? { age: p.age, position: p.position, velocity: p.velocity } : null });
        }
      },
    });
  });
}

async function ready(page: Page) {
  await page.waitForFunction(controls => {
    const w = window as any;
    return w.__tmtGame?.ready && (controls ? w.__tmtGame.performance?.visuals?.liquidReady : w.__tmtFluids?.stats()?.ready);
  }, controlsOnly, { timeout: 180000 });
  await page.waitForTimeout(1800);
}

async function shoot(page: Page, ammo: string, camera = 'normal', water = false) {
  await page.waitForFunction(() => (window as any).__tmtGame?.phase === 'aim', { timeout: 45000 });
  return page.evaluate(async ({ ammo, camera, water }) => {
    const w = window as any, g = w.fxSession;
    w.fx.events = []; w.fx.frames = []; w.fx.sample = true; w.fx.camera = camera; w.fx.followFlight = camera === 'detail';
    const t = g.snapshot.tanks[0];
    if (!g.command(0, { k: 'munition', id: ammo }) || !g.command(0, { k: 'aim', yaw: t.turretYaw, pitch: .95, power: .65 })) throw new Error('Aim rejected');
    let preview = g.preview(0, true), waterAtImpact = null;
    if (water) {
      const aims = [], points = [];
      for (const power of [.45, .65, .85]) for (let i = 0; i < 16; i++) {
        const aim = { k: 'aim', yaw: i * Math.PI / 8, pitch: .62, power };
        g.command(0, aim); const path = g.preview(0, true);
        aims.push(aim); points.push(path.at(-1));
      }
      const wet = await w.__tmtFluids.probe(points);
      const best = wet.map((p: any, i: number) => ({ i, depth: p.water })).filter((p: any) => p.depth > .25).sort((a: any, b: any) => b.depth - a.depth)[0];
      if (!best) throw new Error('No real water impact trajectory found');
      g.command(0, aims[best.i]); preview = g.preview(0, true); waterAtImpact = wet[best.i];
    }
    if (camera === 'normal') w.__tmtVisuals.follow();
    if (camera === 'impact' || camera === 'grazing') w.__tmtFluids.lookAt(preview.at(-1), camera === 'grazing' ? 1.1 : 5, 12, 1.2);
    if (!g.command(0, { k: 'fire' })) throw new Error('Fire rejected');
    const p = g.snapshot.projectiles[0];
    if (camera === 'muzzle') w.__tmtFluids.lookAt(p.position, .6, 2.5, 1.5);
    return { origin: p.position, velocity: p.velocity, preview, waterAtImpact, tank: structuredClone(t) };
  }, { ammo, camera, water });
}

async function sequence(page: Page, name: string, times: number[]) {
  const shots = []; const start = performance.now();
  for (const at of times) {
    await page.waitForTimeout(Math.max(0, at - (performance.now() - start)));
    const file = `${name}-${String(at).padStart(4, '0')}ms.png`;
    await page.screenshot({ path: resolve(out, file) });
    shots.push({ file, requestedMs: at, actualMs: performance.now() - start, telemetry: await page.evaluate(() => ({ game: (window as any).__tmtGame,
      fluids: (window as any).__tmtFluids.stats(), shockwaves: (window as any).__tmtVisuals.scene()?.get('shockwaves')?.stats() })) });
  }
  return shots;
}

function summary(frames: any[]) {
  const stats = (values: number[]) => { const v = values.filter(Number.isFinite).sort((a, b) => a - b); return { n: v.length,
    p50: v[Math.floor(v.length * .5)] ?? 0, p95: v[Math.floor(v.length * .95)] ?? 0, max: v.at(-1) ?? 0 }; };
  const passNames = [...new Set(frames.flatMap(f => f.gpu?.passes?.map((p: any) => p.name) ?? []))] as string[];
  return { frameMs: stats(frames.map(f => f.dt)), gpuMs: stats(frames.map(f => f.gpu?.total)), cpuEncodeMs: stats(frames.map(f => f.cpu?.encodeMs)), cpuFrameMs: stats(frames.map(f => f.cpu?.frameMs)),
    heapBytes: stats(frames.map(f => f.heapBytes)),
    passes: Object.fromEntries(passNames.map(name => [name, stats(frames.map(f => f.gpu?.passes?.find((p: any) => p.name === name)?.ms ?? 0))])),
    first: frames[0], last: frames.at(-1), maxValidationErrors: Math.max(0, ...frames.map(f => f.validationErrors)),
    maxCompileErrors: Math.max(0, ...frames.map(f => f.compileErrors)) };
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: resolve(out, 'video'), size: { width: 1440, height: 900 } } });
  const page = await context.newPage();
  await page.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
  await page.addInitScript('globalThis.__name = (fn, name) => fn;');
  if (controlsOnly) await page.addInitScript(() => {
    const w = window as any, Original = window.AudioWorkletNode;
    w.fxAudioNodes = [];
    w.AudioWorkletNode = class extends Original {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        if ((this.parameters as unknown as ReadonlyMap<string, AudioParam>).has('servo')) w.fxAudioNodes.push(this);
      }
    };
  });
  page.on('pageerror', e => report.errors.push({ type: 'pageerror', text: e.message }));
  page.on('console', e => { if (e.type() === 'error') report.errors.push({ type: 'console', text: e.text() }); });
  await page.goto(`${base}play.html?mode=${controlsOnly ? 'drive' : 'dev'}&seed=7&dev&engineDev`, { timeout: 180000 });
  await ready(page); await instrument(page);
  report.hardware = await page.evaluate(async () => { const a = await (navigator as any).gpu.requestAdapter(); return { ...a.info, vendor: a.info.vendor, architecture: a.info.architecture, fallback: a.info.isFallbackAdapter }; });
  await page.addStyleTag({ content: controlsOnly ? '.dev-panel { visibility:hidden !important }'
    : '.dev-panel,.game-shell,.tank-label,.world-label { visibility:hidden !important }' });
  const cases: { ammo: string; camera: string; weapon?: string; tier?: string; night?: boolean; water?: boolean; phone?: boolean }[] = full ? [
    ...['explosive', 'heavy', 'incendiary', 'nuclear'].flatMap(ammo => [{ ammo, camera: 'normal' }, { ammo, camera: 'detail' }, { ammo, camera: 'muzzle' }]),
    { ammo: 'heavy', camera: 'impact' }, { ammo: 'nuclear', camera: 'grazing' },
    { ammo: 'explosive', camera: 'muzzle', weapon: 'cannon' }, { ammo: 'incendiary', camera: 'muzzle', weapon: 'rail' },
    { ammo: 'nuclear', camera: 'impact', night: true }, { ammo: 'heavy', camera: 'muzzle', night: true },
    { ammo: 'explosive', camera: 'impact', water: true }, { ammo: 'nuclear', camera: 'grazing', water: true },
    { ammo: 'heavy', camera: 'normal', tier: 'low', phone: true }, { ammo: 'nuclear', camera: 'impact', tier: 'medium' },
  ] : [{ ammo: 'explosive', camera: 'normal' }];
  for (const c of perfOnly || drivingOnly || controlsOnly ? [] : cases) {
    const name = `${c.ammo}-${c.camera}${c.weapon ? `-${c.weapon}` : ''}${c.night ? '-night' : ''}${c.water ? '-water' : ''}${c.tier ? `-${c.tier}` : ''}`;
    if (filter && !name.includes(filter)) continue;
    console.log(`Capturing ${name}`);
    if (report.cases.length) {
      await page.evaluate(async ({ weapon, tier }) => {
        const w = window as any;
        const { currentSettings, dispatchSettings, updateSettings } = await import('/src/game/meta/settings.ts' as string);
        dispatchSettings(updateSettings(currentSettings(), { graphics: { tier } }));
        const setup = structuredClone(w.fxSession.setup); setup.tanks[0].loadout.weapon = weapon;
        await w.fxSession.startMatch(setup);
      }, { weapon: c.weapon ?? 'mortar', tier: c.tier ?? 'high' }); await ready(page);
    }
    await page.setViewportSize(c.phone ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    await page.evaluate(night => (window as any).__tmtVisuals.setDayOffset(night ? .45 : 0), !!c.night);
    if (c.water) {
      await page.evaluate(async () => { const w = window as any; if (!await w.__tmtVisuals.inspectWater(false, 'water')) throw new Error('No shoreline'); w.__tmtVisuals.placeTank(); });
      await page.waitForTimeout(800);
    }
    const shot = await shoot(page, c.ammo, c.camera, !!c.water);
    const shots = motionOnly ? [] : await sequence(page, name, [0, 50, 140, 320, 650, 1100, 1800, 2700, 4200, 5800]);
    if (motionOnly) await page.waitForTimeout(6500);
    const state = await page.evaluate(() => { const w = window as any; w.fx.sample = false; w.fx.followFlight = false; return w.fx; });
    report.cases.push({ ...c, shot, shots, events: state.events, sampledWithScreenshots: summary(state.frames) });
    writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
  }
  if (drivingOnly) {
    await page.evaluate(async () => {
      const w = window as any;
      const { registerHooks } = await import('/src/game/app/hooks.ts' as string);
      w.fx.drive = [];
      registerHooks('trajectory-qualification', { onFrame(f: any) {
        const p = w.__tmtGame.performance;
        w.fx.drive.push({ at: performance.now(), tick: f.snapshot.tick, dt: f.realDt, trajectory: p.trajectory,
          tank: f.snapshot.tanks[0].position, yaw: f.snapshot.tanks[0].turretYaw, camera: w.__tmtGame.camera, validationErrors: p.validationErrors });
      } });
    });
    await page.locator('#viewport').focus();
    await page.keyboard.down('KeyW'); await page.waitForTimeout(3000);
    await page.keyboard.down('KeyD'); await page.waitForTimeout(2500); await page.keyboard.up('KeyD');
    await page.waitForTimeout(1500); await page.keyboard.up('KeyW'); await page.waitForTimeout(1000);
    await page.keyboard.down('ArrowRight'); await page.waitForTimeout(500); await page.keyboard.up('ArrowRight');
    await page.waitForTimeout(1000);
    report.driving = await page.evaluate(() => (window as any).fx.drive);
    await page.screenshot({ path: resolve(out, 'driving-preview.png') });
  }
  if (controlsOnly) {
    // Real mouse/keyboard events through the UI; worklet params are observed without replacing the synth.
    await page.locator('#viewport').focus();
    await page.mouse.click(750, 420);
    await page.waitForFunction(() => (window as any).fxAudioNodes?.length === 4);
    const state = () => page.evaluate(() => {
      const w = window as any, t = w.fxSession.snapshot.tanks[0];
      return { yaw: t.turretYaw, pitch: t.barrelPitch, power: t.power, position: [...t.position],
        distance: w.__tmtGame.camera.requestedDistance, camera: [...w.__tmtGame.camera.position], audio: w.__tmtGame.audio,
        trajectory: w.__tmtGame.performance.trajectory, readout: w.__tmtGame.performance.trajectoryReadout,
        prediction: w.fxSession.previewPrediction(0, true) };
    });
    const before = await state();
    assert.ok(before.trajectory.points > 8 && before.trajectory.anchored, 'free drive shows the complete arc by default');
    assert.ok(before.prediction.hit, 'the initial preview ends in a real contact');
    assert.ok(before.readout.visible && before.readout.kind === 'landing', 'the initial landing range is readable');
    await page.screenshot({ path: resolve(out, 'aim-initial.png') });
    await page.keyboard.down('KeyQ'); await page.waitForTimeout(500); await page.keyboard.up('KeyQ');
    const q = await state();
    await page.keyboard.down('KeyE'); await page.waitForTimeout(500); await page.keyboard.up('KeyE');
    const e = await state();
    assert.ok(q.yaw > before.yaw + .1, 'Q turns the barrel left');
    assert.ok(e.yaw < q.yaw - .1, 'E turns the barrel right');
    assert.equal(q.power, before.power); assert.equal(e.power, before.power);
    await page.mouse.move(750, 420); await page.mouse.down({ button: 'right' });
    const grab = await state();
    assert.ok(Math.abs(grab.yaw - e.yaw) < .002 && Math.abs(grab.pitch - e.pitch) < .002, 'right-button grab never jumps the aim');
    await page.mouse.move(850, 350, { steps: 12 }); await page.waitForTimeout(150);
    const mouseAim = await state();
    assert.ok(mouseAim.yaw < e.yaw - .1, 'drag right turns the barrel right');
    assert.ok(mouseAim.pitch > e.pitch + .05, 'drag up raises the barrel');
    assert.equal(mouseAim.power, e.power);
    assert.ok(Math.hypot(...mouseAim.camera.map((v: number, i: number) => v - e.camera[i])) < .1, 'right aim never orbits the camera');
    await page.mouse.wheel(0, -120); await page.waitForTimeout(150);
    const heldWheel = await state();
    assert.ok(heldWheel.power > mouseAim.power, 'right-button wheel increases range');
    assert.ok(heldWheel.power - mouseAim.power < .025, 'range wheel is finer than the old six-percentage-point jump');
    assert.equal(heldWheel.distance, mouseAim.distance, 'right-button range wheel never zooms');
    await page.screenshot({ path: resolve(out, 'aim-range.png') });
    await page.mouse.wheel(0, 120); await page.waitForTimeout(150);
    const reversedWheel = await state();
    assert.ok(Math.abs(reversedWheel.power - mouseAim.power) < 1e-6, 'opposite wheel gesture restores the exact aim');
    await page.mouse.wheel(0, -120); await page.waitForTimeout(150);
    await page.mouse.up({ button: 'right' });
    await page.mouse.wheel(0, 120); await page.waitForTimeout(150);
    const zoom = await state();
    assert.ok(zoom.distance > heldWheel.distance, 'released wheel zooms without a modifier'); assert.equal(zoom.power, heldWheel.power);
    await page.evaluate(async () => {
      const w = window as any, { registerHooks } = await import('/src/game/app/hooks.ts' as string);
      w.fx.controlFrames = []; w.fx.controlPhase = 'drive';
      registerHooks('control-qualification', { onFrame(f: any) {
        w.fx.controlFrames.push({ at: performance.now(), phase: w.fx.controlPhase, tick: f.snapshot.tick,
          tank: [...f.snapshot.tanks[0].position], yaw: f.snapshot.tanks[0].turretYaw,
          servo: w.fxAudioNodes.map((n: any) => n.parameters.get('servo').value),
          trajectory: w.__tmtGame.performance.trajectory, validationErrors: w.__tmtGame.performance.validationErrors });
      } });
    });
    await page.waitForTimeout(600);
    await page.keyboard.down('KeyW'); await page.keyboard.down('KeyD'); await page.waitForTimeout(2500);
    await page.evaluate(() => (window as any).fx.controlPhase = 'drive-and-aim');
    await page.mouse.move(750, 420); await page.mouse.down({ button: 'right' });
    for (let i = 1; i <= 8; i++) { await page.mouse.move(750 + i * 12, 420 + i * 6); await page.waitForTimeout(100); }
    await page.mouse.up({ button: 'right' });
    await page.keyboard.up('KeyD'); await page.keyboard.up('KeyW');
    await page.evaluate(() => (window as any).fx.controlPhase = 'release'); await page.waitForTimeout(800);
    const after = await state();
    assert.ok(Math.hypot(...after.position.map((v: number, i: number) => v - zoom.position[i])) > 1, 'WASD still drives');
    await page.screenshot({ path: resolve(out, 'aim-driving.png') });
    await page.locator('.dev-slider').evaluate(slider => { (slider as HTMLInputElement).value = '.45'; slider.dispatchEvent(new Event('input')); });
    await page.waitForTimeout(500);
    await page.screenshot({ path: resolve(out, 'aim-night.png') });
    await page.locator('.dev-slider').evaluate(slider => { (slider as HTMLInputElement).value = '0'; slider.dispatchEvent(new Event('input')); });
    await page.keyboard.press('Escape'); const paused = await state();
    await page.mouse.wheel(0, -120); await page.waitForTimeout(100); const pausedWheel = await state();
    assert.equal(pausedWheel.power, paused.power, 'paused wheel never aims');
    await page.keyboard.press('Escape');
    const frames = await page.evaluate(() => (window as any).fx.controlFrames);
    const drive = frames.filter((f: any) => f.phase === 'drive' && f.at > frames[0].at + 800).map((f: any) => Math.max(...f.servo));
    const aim = frames.filter((f: any) => f.phase === 'drive-and-aim').map((f: any) => Math.max(...f.servo));
    const servo = { driveMax: Math.max(...drive), aimMax: Math.max(...aim), release: frames.at(-1).servo };
    assert.ok(servo.aimMax > 0.01, 'deliberate traverse still has motor sound');
    assert.ok(servo.driveMax < servo.aimMax * .25, 'driving stabilization stays quiet');
    await page.keyboard.press('Space'); await page.waitForTimeout(600);
    const shot = await page.evaluate(() => (window as any).fx.events.find((e: any) => e.event.type === 'shot'));
    assert.equal(shot?.event.launch?.power, after.power, 'Space fires the selected power');
    report.controls = { before, q, e, grab, mouseAim, heldWheel, reversedWheel, zoom, after, pausedWheel, servo, shot, frames };
    await page.screenshot({ path: resolve(out, 'controls.png') });
  }
  report.video = await page.video()?.path();
  await context.close();
  if (process.argv.includes('--visual-only')) {
    writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ out, cases: report.cases.length, errors: report.errors }, null, 2));
    if (report.errors.length) process.exitCode = 1;
  } else {
  // Separate context, no video or screenshots during measurements.
  const perfContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const perfPage = await perfContext.newPage();
  await perfPage.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
  await perfPage.addInitScript('globalThis.__name = (fn, name) => fn;');
  perfPage.on('pageerror', e => report.errors.push({ type: 'perf-pageerror', text: e.message }));
  perfPage.on('console', e => { if (e.type() === 'error') report.errors.push({ type: 'perf-console', text: e.text() }); });
  await perfPage.goto(`${base}play.html?mode=dev&seed=7&dev&engineDev`, { timeout: 180000 }); await ready(perfPage); await instrument(perfPage);
  report.performance = [];
  for (const tier of full ? ['high', 'medium', 'low'] : ['high']) {
    await perfPage.evaluate(tier => (window as any).__tmtFluids.setTier(tier), tier); await ready(perfPage);
    await perfPage.evaluate(() => { const w = window as any; w.fx.frames = []; w.fx.sample = true; });
    await perfPage.waitForTimeout(2500);
    const baseline = summary(await perfPage.evaluate(() => { const w = window as any; w.fx.sample = false; return w.fx.frames; }));
    await shoot(perfPage, full ? 'nuclear' : 'explosive');
    await perfPage.waitForTimeout(7000);
    const frames = await perfPage.evaluate(() => { const w = window as any; w.fx.sample = false; return w.fx.frames; });
    report.performance.push({ tier, idle: baseline, shot: summary(frames) });
    await perfPage.evaluate(() => (window as any).__tmtVisuals.scene().get('fluids').clearEffects());
    await perfPage.waitForTimeout(1000);
    writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
  }
  if (full) {
    // Repeated real shots exercise terrain, impacts, fluid eviction and instance/light retirement together.
    await perfPage.evaluate(() => (window as any).__tmtFluids.setTier('high')); await ready(perfPage);
    report.repeatedNuclear = [];
    for (let i = 0; i < 6; i++) {
      await shoot(perfPage, 'nuclear'); await perfPage.waitForTimeout(4000);
      const frames = await perfPage.evaluate(() => { const w = window as any; w.fx.sample = false; return w.fx.frames; });
      report.repeatedNuclear.push(summary(frames));
    }
    await perfPage.waitForTimeout(16000);
    report.naturalCleanup = await perfPage.evaluate(() => ({ game: (window as any).__tmtGame, fluids: (window as any).__tmtFluids.stats() }));
    // Replay a genuine mid-flight checkpoint, with no developer scene edits in its command log.
    await perfPage.evaluate(() => (window as any).fxSession.restart()); await ready(perfPage);
    await shoot(perfPage, 'nuclear'); await perfPage.waitForTimeout(120);
    report.restore = await perfPage.evaluate(async () => {
      const w = window as any; w.fx.scale = 0;
      const saved = await w.fxSession.saveCheckpoint();
      const before = w.__tmtGame.performance.muzzles.total;
      await w.fxSession.restoreCheckpoint(saved);
      const after = w.__tmtGame.performance.muzzles.total;
      w.fx.scale = 1;
      return { savedTick: saved.tick, savedHash: saved.hash, before, after, snapshot: w.__tmtGame.snapshot, fluids: w.__tmtFluids.stats() };
    });
    await perfPage.waitForTimeout(4000);
    report.restore.afterFlight = await perfPage.evaluate(() => ({ game: (window as any).__tmtGame, fluids: (window as any).__tmtFluids.stats() }));
    await perfPage.evaluate(() => (window as any).fxSession.restart()); await ready(perfPage);
    report.restartCleanup = await perfPage.evaluate(() => ({ game: (window as any).__tmtGame, fluids: (window as any).__tmtFluids.stats() }));
    await perfPage.evaluate(() => (window as any).fxSession.endMatch()); await perfPage.waitForTimeout(300);
    report.sceneCleanup = await perfPage.evaluate(() => ({ game: (window as any).__tmtGame, fluids: (window as any).__tmtFluids.stats() }));
    writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
  }
  await perfContext.close();
  writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, cases: report.cases.length, errors: report.errors, performance: report.performance?.map((p: any) => ({ tier: p.tier, idle: p.idle.gpuMs, shot: p.shot.gpuMs })) }, null, 2));
  if (report.errors.length || report.performance.some((p: any) => p.shot.maxValidationErrors || p.shot.maxCompileErrors)) process.exitCode = 1;
  }
} catch (error) {
  report.errors.push({ type: 'harness', text: String(error) });
  writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
  throw error;
} finally { await browser.close(); await server.close(); release(); }
