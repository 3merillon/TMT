/** Headless hardware-WebGPU measurement. Coordinate exclusive GPU use; does not record video while timing.
 * node node_modules/tsx/dist/cli.mjs scripts/bench-tank-render.ts */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import { tankCombatFixture } from './bench/tank-combat-fixture';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), out = join(root, 'artifacts/tank-designs/render');
const quick = process.argv.includes('--quick');
const combatOnly = process.argv.includes('--combat-only');
const capturesOnly = process.argv.includes('--captures-only'), performanceOnly = process.argv.includes('--performance-only');
const scarStress = process.argv.includes('--scar-stress');
mkdirSync(out, { recursive: true });
const htmlPath = '/artifacts/tank-designs/render/bench.html';
writeFileSync(join(out, 'bench.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Tank render benchmark</title><style>html,body{margin:0;overflow:hidden}canvas{width:100vw;height:100vh;display:block}</style></head><body><canvas></canvas><script type="module" src="/scripts/bench/tank-render-page.ts"></script></body></html>');
const errors: string[] = [], results: unknown[] = [], comparisons: string[] = [];
const environment = { cpu: cpus()[0]?.model, logicalCpus: cpus().length, node: process.version, chromium: '' };
let vite: ViteDevServer | undefined, browser: Browser | undefined, page: Page | undefined;
const distribution = (values: number[]) => { values.sort((a, b) => a - b); return { median: values[Math.floor(values.length * .5)], p95: values[Math.floor(values.length * .95)], max: values.at(-1) }; };
try {
  vite = await createServer({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn', cacheDir: join(root, '.vite-capture/tank-render'), server: { host: '127.0.0.1', port: 0, open: false, hmr: false, watch: null } }); await vite.listen();
  const store = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  const executablePath = process.env.TMT_CHROME ?? readdirSync(store).filter(n => /^chromium-\d+$/.test(n)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])).map(n => join(store, n, 'chrome-win64/chrome.exe')).find(existsSync);
  assert.ok(executablePath);
  browser = await chromium.launch({ executablePath, headless: true, ignoreDefaultArgs: ['--headless'], args: ['--headless=new', '--enable-unsafe-webgpu', '--enable-webgpu-developer-features', '--ignore-gpu-blocklist', '--enable-gpu', '--force-color-profile=srgb', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  environment.chromium = browser.version();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  await context.route(/\/favicon\.ico/, route => route.fulfill({ status: 204, body: '' }));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.stack ?? e.message)); page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
  const base = vite.resolvedUrls!.local[0].replace(/\/$/, '');
  async function open(query: string) { await page!.goto(`${base}${htmlPath}?${query}`, { waitUntil: 'domcontentloaded' }); await page!.waitForFunction('window.__tankRender?.ready', undefined, { timeout: 120000 }); }
  const cases = combatOnly || capturesOnly ? [] : quick || scarStress ? [{ set: 'bastion', count: 1, paint: 1 }] : [
    ...[1, 4, 8].flatMap(count => [0, 1].map(paint => ({ set: 'bastion', count, paint }))),
    ...['aether', 'forge'].flatMap(set => [1, 4, 8].map(count => ({ set, count, paint: 0 }))),
  ];
  for (const { set, count, paint } of cases) {
    await open(`count=${count}&paint=${paint}&${set === 'bastion' ? 'reactive=1' : `set=${set}`}`);
    if (scarStress) {
      await page.evaluate('window.__tankRender.view("combat")');
      await page.evaluate('window.__tankRender.measure(30)');
      const fixture = tankCombatFixture();
      // Repeating one real emitted hit exercises the renderer's maximum overlapping crater cost.
      // One extra event verifies the existing production cap, rather than inserting private mark data.
      const scars: { damageMarks: number } = await page.evaluate(f => {
        const api = (window as any).__tankRender;
        for (let i = 0; i < 25; i++) api.combat(f);
        return { damageMarks: [...api.views.tanks.get(0).scars.values()].reduce((sum: number, marks: any) => sum + marks.length, 0) };
      }, fixture);
      assert.equal(scars.damageMarks, 24);
      await page.evaluate('window.__tankRender.measure(240)');
    }
    const measured: any = await page.evaluate('window.__tankRender.measure(300)');
    const shaders: { ok: boolean } = await page.evaluate('window.__tankRender.shaders()'); assert.equal(shaders.ok, true);
    const samples = measured.samples as any[];
    assert.equal(samples.length, 300); assert.ok(samples.every(s => s.engine.validationErrors === 0 && !s.engine.lost));
    assert.ok(samples.every(s => s.engine.gpu.timestamps), 'Hardware timestamp queries are required for this measurement');
    const gpuPasses = Object.entries(measured.capture.series).filter(([name]) => name.startsWith('gpu/')) as [string, (number | null)[]][];
    assert.ok(gpuPasses.some(([name, values]) => name === 'gpu/gbuffer.tanks' && values.some(v => v !== null && v > 0)), 'Tank raster pass must be timed');
    const gpuFrames = Array.from({ length: 300 }, (_, frame) => gpuPasses.reduce((sum, [, values]) => sum + (values[frame] ?? 0), 0)).filter(v => v > 0);
    assert.equal(measured.capture.pendingGpu, 0); assert.equal(measured.capture.droppedGpu, 0); assert.equal(measured.droppedDuringCapture, 0); assert.equal(gpuFrames.length, 300);
    const result = { set, count, playerPaintDabs: paint ? 192 : 0, damageMarks: scarStress ? 24 : 0, lights: count * 2, warmupFrames: 240, samples: 300, adapter: measured.adapter, tankViews: measured.tankViews,
      gpuMs: distribution(gpuFrames), cpuEncodeMs: distribution(measured.capture.series['cpu/encode']), cpuTankPoseMs: distribution(samples.map(s => s.viewCpuMs)), frameMs: distribution(samples.map(s => s.frameMs)),
      draws: distribution(samples.map(s => s.engine.draws)), triangles: distribution(samples.map(s => s.engine.triangles)), vramBytes: distribution(samples.map(s => s.engine.vram.total)), last: samples.at(-1).engine, capture: measured.capture, droppedDuringCapture: measured.droppedDuringCapture, shaders };
    results.push(result); console.log(JSON.stringify({ set, count, paint, gpu: result.gpuMs, cpu: result.cpuEncodeMs, pose: result.cpuTankPoseMs }));
    if (quick) { await page.evaluate('window.__tankRender.view("detail")'); await page.evaluate('window.__tankRender.measure(30)'); }
    await page.screenshot({ path: join(out, scarStress ? 'scar-stress.png' : quick ? 'smoke-pom.png' : set === 'bastion' ? `vehicles-${count}-paint-${paint}.png` : `vehicles-${set}-${count}.png`) });
  }
  for (const hull of combatOnly || performanceOnly || quick || scarStress || process.argv.includes('--skip-comparisons') ? [] : ['skiff', 'warden', 'bastion', 'aether', 'forge']) {
    await open(`${hull === 'aether' || hull === 'forge' ? `set=${hull}` : `hull=${hull}`}&count=1&comparison=1`);
    for (const view of ['quarter', 'front', 'side', 'rear', 'top', 'detail', 'tracks']) {
      await page.evaluate(name => (window as any).__tankRender.view(name), view); await page.evaluate('window.__tankRender.measure(30)');
      const name = `compare-${hull}-${view}.png`; await page.screenshot({ path: join(out, name) }); comparisons.push(name);
    }
  }
  if (!quick && !performanceOnly && !scarStress) {
    await open('hull=bastion&count=1&comparison=1&reactive=1');
    await page.evaluate('window.__tankRender.view("combat")'); await page.evaluate('window.__tankRender.measure(30)');
    await page.screenshot({ path: join(out, 'reactive-front-intact.png') });
    await page.evaluate('window.__tankRender.engine.services.settings.gbufferView="normal"'); await page.evaluate('window.__tankRender.measure(30)');
    await page.screenshot({ path: join(out, 'reactive-front-intact-normal.png') });
    await page.evaluate('window.__tankRender.engine.services.settings.gbufferView="none"');
    const fixture = tankCombatFixture();
    const rendered = await page.evaluate(f => (window as any).__tankRender.combat(f), fixture);
    assert.equal(rendered.reactiveArmor, 1); assert.ok(rendered.health < 170);
    await page.evaluate('window.__tankRender.measure(30)'); await page.screenshot({ path: join(out, 'reactive-front-spent.png') });
    await page.evaluate('window.__tankRender.engine.services.settings.gbufferView="normal"'); await page.evaluate('window.__tankRender.measure(30)');
    await page.screenshot({ path: join(out, 'reactive-front-spent-normal.png') });
    const combatShaders: { ok: boolean } = await page.evaluate('window.__tankRender.shaders()'); assert.equal(combatShaders.ok, true);
    writeFileSync(join(out, 'combat-state.json'), JSON.stringify({ fixture, rendered }, null, 2));
  }
  assert.deepEqual(errors, []);
} catch (error) { errors.push(error instanceof Error ? error.stack ?? error.message : String(error)); console.error(errors.at(-1)); process.exitCode = 1; }
finally { writeFileSync(join(out, scarStress ? 'benchmark-scar-stress.json' : combatOnly ? 'combat-report.json' : capturesOnly ? 'captures-report.json' : quick ? 'benchmark-smoke.json' : 'benchmark.json'), JSON.stringify({ environment, resolution: [1600, 1000], results, comparisons, errors }, null, 2)); await browser?.close(); await vite?.close(); console.log(JSON.stringify({ out, scenarios: results.length, errors: errors.length })); }
