/** Real tank/track water-contact check on desktop Chromium/WebGPU; not a performance or mobile benchmark.
 * node --import tsx scripts/verify-track-wake.ts [--seed 7] [--out artifacts/startup-audio/water-wake]
 * Uses the actual Engine playground placement button and keyboard driving. It records each box's centre-ray
 * immersion, not a claim that every point on the full body is dry. Screenshots require visual review for spray.
 */
import { chromium, type Browser } from 'playwright-core';
import { createServer } from 'vite';
import { existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const flags = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) flags.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const seed = Number(flags.get('seed') ?? 7);
const out = resolve(flags.get('out') ?? join(root, 'artifacts/startup-audio/water-wake'));
mkdirSync(out, { recursive: true });
const store = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
const chrome = process.env.TMT_CHROME ?? (existsSync(store) ? readdirSync(store) : [])
  .filter(d => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
  .map(d => join(store, d, 'chrome-win64', 'chrome.exe')).find(existsSync);
if (!chrome) throw new Error('Set TMT_CHROME to a Chromium executable with hardware WebGPU.');
const server = await createServer({ root, logLevel: 'warn', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await server.listen();
const port = (server.httpServer!.address() as { port: number }).port;
let browser: Browser | undefined;
const errors: string[] = [];
const result: any = { seed, errors, measurement: 'Functional desktop WebGPU proof; no performance measurements.',
  scope: 'Visual liquid response only. No tank buoyancy, chassis drag or lava damage.',
  roles: ['body', 'leftTrack', 'rightTrack'],
  contactScope: 'Radial ray through each box centre, using the rendered kit dimensions. This does not survey the entire body footprint.' };
try {
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu'] });
  result.browser = browser.version();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/favicon.ico', r => r.fulfill({ status: 204 }));
  await page.addInitScript('globalThis.__name = value => value;');
  await page.goto(`http://127.0.0.1:${port}/?mode=dev&seed=${seed}&residentCheck&off=veil,mist,liquidVeil`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => { const w = window as any; return w.__tmtGame?.ready && w.__tmtFluids?.stats()?.ready; }, undefined, { timeout: 180000 });
  await page.waitForTimeout(2500);
  result.candidates = await page.evaluate(async () => {
    const w = window as any, F = w.__tmtFluids, shores = F.shorePoints(128, 'water'), all = [];
    for (let i = 0; i < shores.length; i += 64) {
      const points = shores.slice(i, i + 64), probes = await F.probe(points);
      for (let j = 0; j < probes.length; j++) if (probes[j].water > .04 && probes[j].water < .2) all.push({ point: points[j], ...probes[j] });
    }
    if (!all.length) {
      // The recipe shoreline can differ from the fine live bed: search both sides of nearby columns.
      for (const point of shores.slice(0, 24)) {
        const up = point.map((v: number) => v / Math.hypot(...point));
        let side = Math.abs(up[1]) < .99 ? [up[2], 0, -up[0]] : [0, -up[2], up[1]];
        const length = Math.hypot(...side); side = side.map(v => v / length);
        const fore = [up[1] * side[2] - up[2] * side[1], up[2] * side[0] - up[0] * side[2], up[0] * side[1] - up[1] * side[0]];
        const points = [];
        for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) points.push(point.map((v: number, k: number) => v + .3 * (a * side[k] + b * fore[k])));
        const probes = await F.probe(points);
        for (let j = 0; j < probes.length; j++) if (probes[j].water > .06 && probes[j].water < .18) all.push({ point: points[j], ...probes[j] });
        if (all.length > 20) break;
      }
    }
    all.sort((a, b) => Math.abs(a.water - .12) - Math.abs(b.water - .12));
    w.__wakeCandidates = all;
    return all.slice(0, 20);
  });
  const inspect = () => page.evaluate(async () => {
    const w = window as any, state = w.__tmtGame.snapshot, observed = w.__tmtVisuals.tank();
    // Match the tank the actual dev controls drive, rather than assuming tank id zero or snapshot array order.
    const distance = (tank: any) => Math.hypot(...tank.position.map((v: number, i: number) => v - observed[i]));
    const tank = [...state.tanks].sort((a: any, b: any) => distance(a) - distance(b))[0];
    const { tankFluidBoxes } = await import('/src/game/presentation/fluid-presenter.ts' as string);
    const { composeTRS, transformPoint } = await import('/src/game/presentation/tank-view.ts' as string);
    const matrix = composeTRS(tank.position, tank.rotation);
    const axes = [[matrix[0], matrix[1], matrix[2]], [matrix[4], matrix[5], matrix[6]], [matrix[8], matrix[9], matrix[10]]];
    // tankFluidBoxes's documented API order: body, driver-left (+X), driver-right (-X). Give every output a name.
    const roles = ['body', 'leftTrack', 'rightTrack'];
    const local = tankFluidBoxes(tank);
    if (local.length !== roles.length) throw new Error('Update the named roles when the presenter box contract changes.');
    const boxes = local.map((box: any, index: number) => {
      const centre = transformPoint(matrix, box.center), radius = Math.hypot(...centre), direction = centre.map((v: number) => v / radius);
      // The radial ray passes through the box centre. Its first slab intersection sets the half span;
      // projecting every corner onto this ray would overestimate immersion when a tank is tilted.
      const span = Math.min(...box.half.map((half: number, k: number) => half / Math.max(1e-9, Math.abs(axes[k].reduce((sum: number, x: number, i: number) => sum + x * direction[i], 0)))));
      return { role: roles[index], centre, bottom: radius - span, top: radius + span };
    });
    const water = await w.__tmtFluids.probe(boxes.map((box: any) => box.centre));
    return { tankId: tank.id, tick: state.tick, position: tank.position, velocity: tank.velocity,
      boxes: boxes.map((box: any, i: number) => ({ ...box, ...water[i], immersion: Math.max(0, Math.min(box.top, water[i].surface) - Math.max(box.bottom, water[i].ground)) })), fluid: w.__tmtFluids.stats() };
  });
  result.attempts = [];
  const body = (sample: any) => sample.boxes.find((box: any) => box.role === 'body');
  const tracks = (sample: any) => sample.boxes.filter((box: any) => box.role !== 'body');
  for (let attempt = 0; attempt < Math.min(12, result.candidates.length); attempt++) {
    await page.evaluate((index: number) => {
      const w = window as any, candidate = w.__wakeCandidates[index], length = Math.hypot(...candidate.point);
      w.__tmtFluids.lookAt(candidate.point.map((v: number) => v / length * candidate.ground), 5, 3);
    }, attempt);
    await page.waitForTimeout(150);
    await page.locator('.dev-place-tank').click();
    await page.waitForTimeout(1500);
    const before = await inspect();
    result.attempts.push({ attempt, before });
    if (body(before).immersion > .01 || tracks(before).every((box: any) => box.immersion < .01)) continue;
    result.chosen = attempt; result.before = before;
    await page.locator('.dev-follow').click(); await page.waitForTimeout(200);
    await page.screenshot({ path: join(out, 'track-wake-before.png') });
    await page.keyboard.down('KeyW');
    try {
      await page.waitForTimeout(800); result.driving = await inspect();
      await page.screenshot({ path: join(out, 'track-wake-driving.png') });
      await page.waitForTimeout(800);
    } finally { await page.keyboard.up('KeyW'); }
    result.after = await inspect();
    await page.screenshot({ path: join(out, 'track-wake-after.png') });
    break;
  }
  result.pipeline = await page.evaluate(() => { const p = (window as any).__tmtGame.performance; return { compileErrors: p.compileErrors, validationErrors: p.validationErrors, visuals: p.visuals }; });
  if (!result.before) throw new Error('No verified tracks-only centre-ray placement found.');
  result.travel = Math.hypot(...result.driving.position.map((v: number, i: number) => v - result.before.position[i]));
  result.checks = { actualTravel: result.travel > .1, bodyCentreRayDry: body(result.driving).immersion <= .01,
    trackContact: tracks(result.driving).some((box: any) => box.immersion > .01),
    trackWaterMoving: tracks(result.driving).some((box: any) => box.immersion > .01 && Math.hypot(...box.velocity) > .05),
    pipelineClean: result.pipeline.compileErrors === 0 && result.pipeline.validationErrors === 0 };
  if (Object.values(result.checks).some(pass => !pass)) throw new Error('A tracks-only driving check failed; inspect the saved probes and screenshots.');
} catch (error) { result.failure = String(error); console.error(error); }
finally {
  writeFileSync(join(out, 'track-wake-proof.json'), JSON.stringify(result, null, 2));
  await browser?.close(); await server.close();
}
console.log(JSON.stringify({ out, checks: result.checks, errors, failure: result.failure }));
if (result.failure || errors.length) process.exitCode = 1;
