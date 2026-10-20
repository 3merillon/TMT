/** Untimed actual-game thermal/cloud/spotlight visual proof, with GPU-derived radiance readback. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import { acquireGpuLock } from './capture';
const args = process.argv.slice(2), root = resolve(import.meta.dirname, '..');
const out = resolve(root, args.includes('--out') ? args[args.indexOf('--out') + 1] : `artifacts/planetary-lighting/gas-lighting-${Date.now()}`);
assert.ok(!existsSync(out), 'Use a fresh output directory'); mkdirSync(out, { recursive: true });
const selected = args.includes('--scenes') ? args[args.indexOf('--scenes') + 1].split(',') : null;
const epoch = args.includes('--epoch') ? Number(args[args.indexOf('--epoch') + 1]) : 100;
const spotLift = args.includes('--spot-lift') ? Number(args[args.indexOf('--spot-lift') + 1]) : 0;
let server: ViteDevServer | undefined, browser: Browser | undefined; const errors: string[] = [], reports: unknown[] = [];
const save = (name: string, data: unknown) => writeFileSync(join(out, name), JSON.stringify(data, null, 2));
const unlock = await acquireGpuLock();
try {
  server = await createServer({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn', cacheDir: join(root, '.vite-capture/gas-lighting'), server: { host: '127.0.0.1', port: 0, open: false, hmr: false, watch: null } }); await server.listen();
  const store = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  const executablePath = process.env.TMT_CHROME ?? readdirSync(store).filter(n => /^chromium-\d+$/.test(n)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])).map(n => join(store, n, 'chrome-win64/chrome.exe')).find(existsSync); assert.ok(executablePath);
  browser = await chromium.launch({ executablePath, headless: true, ignoreDefaultArgs: ['--headless'], args: ['--headless=new', '--enable-unsafe-webgpu', '--enable-webgpu-developer-features', '--ignore-gpu-blocklist', '--enable-gpu', '--force-color-profile=srgb', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  const scenes = [
    { name: 'nuclear-night-cloud-local-on', munition: 'nuclear', night: true, local: true, ages: [3, 12, 60, 120, 240, 480, 860] },
    { name: 'nuclear-night-cloud-local-off', munition: 'nuclear', night: true, local: false, ages: [3, 12, 60, 120, 240, 480, 860] },
    { name: 'fireball-night', munition: 'explosive', night: true, local: true, ages: [3, 12, 60, 120, 240, 330, 375] },
    { name: 'fireball-day', munition: 'explosive', night: false, local: true, ages: [3, 12, 60, 120, 240, 330, 375] },
    { name: 'diagnostic-upward-mounted-spot-on', munition: null, night: true, local: true, ages: [60] },
    { name: 'diagnostic-upward-mounted-spot-off', munition: null, night: true, local: false, ages: [60] },
  ].filter(s => !selected || selected.includes(s.name)).map(s => ({ ...s, ages: args.includes('--short') ? s.ages.filter(frame => frame <= 240) : s.ages }));
  for (const scene of scenes) {
    const context: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    await context.route(/\/favicon\.ico/, r => r.fulfill({ status: 204, body: '' }));
    const page: Page = await context.newPage(); page.on('pageerror', e => errors.push(e.stack ?? e.message)); page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
    const base = server.resolvedUrls!.local[0].replace(/\/$/, '');
    await page.goto(`${base}/play.html?mode=dev&seed=7&renderbench`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('window.__tmtRenderBench?.ready', undefined, { timeout: 180000 });
    await page.addStyleTag({ content: '.game-shell,.toast,.finish-card,.world-label,.dev-panel,.tank-labels,.trajectory-readout,.aim-target-readout,.engine-fps{visibility:hidden!important}' });
    const call = async (method: string, ...parameters: unknown[]): Promise<any> => page.evaluate(({ method, parameters }) => (window as any).__tmtRenderBench[method](...parameters), { method, parameters });
    await call('configure', { simulationScale: 1 }); await call('step', 120); await call('configure', { simulationScale: 0 });
    const initial = await call('state'), p = initial.game.snapshot.tanks[0].position as number[], len = Math.hypot(...p), up = p.map(v => v / len);
    const initialElevation = up.reduce((sum, v, i) => sum + v * initial.sun.dirToward[i], 0);
    const midnight = (Math.PI - Math.acos(Math.max(-1, Math.min(1, initialElevation)))) * 480 / (2 * Math.PI);
    const side = [0, 0, 1], tangent = [up[1], -up[0], 0];
    const camera = { position: p.map((v, i) => v + up[i] * 18 - tangent[i] * Math.cos(.8) * 32 - side[i] * Math.sin(.8) * 32), target: p.map((v, i) => v + up[i] * 4), up, fovY: 47 * Math.PI / 180 };
    if (!scene.munition && spotLift > 0) { camera.position = p.map((v, i) => v + up[i] * 6 - tangent[i] * 8 - side[i] * 8); camera.target = p.map((v, i) => v + up[i] * 3.5); }
    const aimCamera = { position: p.map((v, i) => v + up[i] * 8), target: p, up: tangent, fovY: 47 * Math.PI / 180 };
    const off = ['autoExposure', ...(scene.local ? [] : ['cloudLocalLights'])];
    await call('configure', { camera, epoch, skyTime: scene.night ? midnight : midnight + 240, graphics: { tier: 'high', renderScale: 1, grain: 0, miniature: 0, fisheye: 0, clouds: true, volumetrics: true, lensFlare: true, godRays: true }, clouds: { coverage: 1.65, density: 1 }, off });
    await call('step', 90);
    const ready = await call('state'), sunDot = up.reduce((sum, v, i) => sum + v * ready.sun.dirToward[i], 0);
    assert.ok(scene.night ? sunDot < -.99 : sunDot > .99, 'Use actual local midnight/noon');
    const states: unknown[] = [];
    await page.screenshot({ path: join(out, `${scene.name}-before.png`) });
    if (scene.munition) {
      await page.evaluate(({ munition, aimCamera }) => { const w = window as any; w.__gasBlast = { settled: false, error: null };
        w.__tmtRenderBench.blast(3.5, munition, aimCamera).then(() => w.__gasBlast.settled = true, (e: unknown) => { w.__gasBlast.settled = true; w.__gasBlast.error = String(e); }); }, { munition: scene.munition, aimCamera });
    } else {
      // Explicit diagnostic: actual mounted location/color/intensity/range/owner, direction raised to cross the deck.
      // Normal vehicle orientation and production mount data are never changed.
      await page.evaluate('window.__name=(fn)=>fn');
      await page.evaluate(async (lift: number) => { const w = window as any, { Engine } = await import('/src/engine/engine.ts' as string); let engine: any;
        const frame = Engine.prototype.frame; Engine.prototype.frame = function (...args: any[]) { engine = this; return frame.apply(this, args); };
        try { await w.__tmtRenderBench.step(1); } finally { Engine.prototype.frame = frame; }
        const source = w.__tmtRenderBench.state().shadowLights.find((v: any) => v.light.type === 'spot').light;
        const length = Math.hypot(...source.position), direction = source.position.map((v: number) => v / length);
        const position = source.position.map((v: number, i: number) => v + direction[i] * lift);
        const handle = engine.services.scene.get('lightSystem').add({ ...source, position, direction }); w.__diagnosticSpot = { handle, original: source, lift, source: { ...source, position, direction } };
      }, spotLift);
    }
    let frame = 0;
    for (const target of scene.ages) {
      const samples = await call('step', target - frame); frame = target;
      assert.ok(samples.every((s: any) => !s.cameraInsideTerrain), 'Camera entered terrain');
      const state = await call('state'), lights = await call('readLights');
      assert.equal(state.engine.validationErrors, 0);
      const thermalIndices = new Set(state.shadowLights.filter((x: any) => x.light.type === 'point' && x.light.intensity === 0).map((x: any) => x.index));
      const thermal = lights.filter((x: any) => thermalIndices.has(x.index));
      if (scene.munition === 'nuclear' && [60, 120, 240].includes(frame)) assert.ok(thermal.some((x: any) => x.rgb[0] > 10), 'Hot simulated gas must sustain illumination beyond the initial flash');
      if (scene.munition === 'nuclear' && frame === 480) assert.ok(thermal.every((x: any) => x.rgb.every((v: number) => v === 0)), 'Cold nuclear smoke must stop emitting light');
      if (scene.munition && !args.includes('--short') && frame === scene.ages.at(-1)) assert.equal(thermal.length, 0, 'Expired domains must remove their light handles');
      const record = { frame, seconds: frame / 60, state, lights, thermal }; states.push(record);
      await page.screenshot({ path: join(out, `${scene.name}-${String(frame).padStart(4, '0')}.png`) });
      console.log(JSON.stringify({ scene: scene.name, frame, thermal: thermal.map((x: any) => ({ position: x.position, rgb: x.rgb, range: x.range })) }));
    }
    const shaders = await call('shaders'); assert.equal(shaders.ok, true);
    const action: any = scene.munition ? await page.evaluate('(window.__gasBlast)') : await page.evaluate('(window.__diagnosticSpot)');
    if (scene.munition) { assert.equal(action.error, null); assert.equal(action.settled, true); }
    const result = { scene, camera, aimCamera, states, action, shaders }; save(`${scene.name}.json`, result); reports.push({ name: scene.name, frames: scene.ages });
    assert.deepEqual(errors, []); await context.close();
  }
} catch (error) { errors.push(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1; }
finally { save('report.json', { purpose: 'Untimed actual-game diagnostic, not performance benchmark', resolution: [1280, 720], reports, errors }); await browser?.close(); await server?.close(); unlock(); console.log(JSON.stringify({ out, errors })); }
