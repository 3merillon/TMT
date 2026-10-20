/** Hardware WebGPU regression: mission-two wrecks, damage effects, markers and post-death settling.
 * Run: node node_modules/tsx/dist/cli.mjs scripts/capture-destruction-regression.ts */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { acquireGpuLock } from './capture';

const root = resolve(import.meta.dirname, '..'), out = resolve(root, 'artifacts/destruction-regression');
mkdirSync(out, { recursive: true });
const release = await acquireGpuLock();
const server = await createServer({ root, logLevel: 'warn', cacheDir: resolve(root, '.vite-capture'),
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null, open: false } });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.TMT_CHROME ?? 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  headless: true, args: ['--headless=new', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-webgpu-developer-features',
    '--force-color-profile=srgb', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  ignoreDefaultArgs: ['--headless'] });
const report: any = { errors: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  await page.addInitScript('globalThis.__name = (fn, name) => fn;');
  await page.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
  await page.goto(`${server.resolvedUrls!.local[0]}play.html?mode=dev&seed=7&dev&engineDev`, { timeout: 180000 });
  await page.waitForFunction(() => (window as any).__tmtGame?.ready, undefined, { timeout: 180000 });
  await page.evaluate(async () => {
    const w = window as any;
    const { session } = await import('/src/game/api/session.ts' as string);
    const { missionSetup, UNIT_KINDS } = await import('/src/game/campaign/mission.ts' as string);
    const { missionById } = await import('/src/game/campaign/catalog.ts' as string);
    const { normalize, add, mul, frame } = await import('/src/game/math.ts' as string);
    const g = w.wreckGame = session();
    await g.startMatch(missionSetup(missionById('p2'), UNIT_KINDS.rusty.loadout), undefined, true);
    // Isolate presentation from scripted waves and enemy gunfire, using real mission terrain and actors.
    w.savedScript = g.realtime.script; g.realtime.script = { tick() {} };
    for (const u of g.realtime.units) u.spec.unarmed = true;
    const own = g.snapshot.tanks[0], up = normalize(own.position), right = frame(up, own.heading).right;
    w.wreckIds = [];
    for (let i = 0; i < 3; i++) {
      const direction = normalize(add(own.position, mul(right, 2 + i * 1.8)));
      const id = g.realtime.api.spawn({ ...UNIT_KINDS.rustling, brain: 'dummy', unarmed: true, spawn: { up: direction, heading: own.heading } });
      const tank = g.snapshot.tanks[id];
      tank.position = add(tank.position, mul(direction, 2)); tank.motionKind = 'chassis'; g.world.relocateTank(tank);
      w.wreckIds.push(id);
    }
    w.wreckStart = w.wreckIds.map((id: number) => [...g.snapshot.tanks[id].position]);
    w.__tmtFluids.lookAt(g.snapshot.tanks[w.wreckIds[1]].position, 2.5, 7, .8);
  });
  await page.addStyleTag({ content: '.dev-panel,.ch-radio-overlay { visibility:hidden !important }' });
  await page.evaluate(() => { const w = window as any; for (const id of w.wreckIds) w.wreckGame.realtime.api.damage(id, 10000, 'regression'); });
  await page.waitForTimeout(6000);
  report.wrecks = await page.evaluate(() => {
    const w = window as any, g = w.wreckGame;
    return { tanks: w.wreckIds.map((id: number, i: number) => ({ id, health: g.snapshot.tanks[id].health,
      drop: Math.hypot(...w.wreckStart[i]) - Math.hypot(...g.snapshot.tanks[id].position), velocity: g.snapshot.tanks[id].velocity })),
      debris: { thread: g.view.debris.thread, failure: g.view.debris.channel?.failure ?? null,
        pieces: g.view.debris.pieces.map((p: any) => ({ position: p.body.position, age: p.body.age, velocity: p.body.velocity,
          underground: g.world.isSolid(p.body.position) })) } };
  });
  await page.evaluate(() => { const w = window as any; w.__tmtFluids.lookAt(w.wreckGame.snapshot.tanks[w.wreckIds[1]].position, 4, 5, .8); });
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(out, 'rustling-wrecks.png') });
  assert(report.wrecks.tanks.every((t: any) => t.health === 0 && t.drop > 1), 'Rustlings must fall after destruction');
  assert(!report.wrecks.debris.failure, 'Debris solver must remain healthy');
  assert(report.wrecks.debris.pieces.length > 0 && report.wrecks.debris.pieces.every((p: any) => p.age > 1), 'Detached pieces must keep simulating');
  assert(report.wrecks.debris.pieces.every((p: any) => !p.underground), 'Detached pieces must stay above terrain');

  report.markers = await page.evaluate(async () => {
    const w = window as any, g = w.wreckGame, target = [...g.snapshot.tanks[0].position], point = [...g.snapshot.tanks[w.wreckIds[0]].position];
    const radius = Math.hypot(...point), lifted = point.map((x: number) => x * (1 + 1.4 / radius));
    g.emit('realtime', { type: 'marker', point, label: 'LAST SEEN' });
    const marker = document.querySelector('.ch-marker') as HTMLElement, render = g.view.render.bind(g.view);
    const samples: any[] = [];
    g.view.render = (...args: any[]) => {
      render(...args);
      queueMicrotask(() => {
        const screen = g.view.worldToScreen(lifted), values = marker.style.transform.match(/-?[\d.]+/g)?.map(Number);
        if (screen && values) samples.push({ transform: marker.style.transform,
          error: Math.hypot(values[0] - Math.max(24, Math.min(innerWidth - 24, screen[0])), values[1] - Math.max(24, Math.min(innerHeight - 24, screen[1]))) });
      });
    };
    for (let i = 0; i < 90; i++) { w.__tmtFluids.lookAt(target, 2.5, 7, i * .015); await new Promise(requestAnimationFrame); }
    g.view.render = render;
    return { frames: samples.length, changes: new Set(samples.map(s => s.transform)).size, maxError: Math.max(...samples.map(s => s.error)) };
  });
  assert(report.markers.frames >= 80 && report.markers.changes > 50 && report.markers.maxError < .02, 'Marker must match every rendered projection');

  await page.evaluate(() => {
    const w = window as any, g = w.wreckGame, tank = g.snapshot.tanks[0];
    w.__tmtVisuals.follow();
    w.hitTimer = setInterval(() => {
      g.realtime.api.damage(0, .2, 'coax');
      const p = tank.position, r = Math.hypot(...p), hit = p.map((x: number) => x * (1 + .6 / r));
      g.view.onRealtimeEvent({ type: 'tracer', from: hit.map((x: number, i: number) => x + (i === 0 ? 3 : 0)), to: hit, owner: 1, victim: 0 }, g.snapshot);
    }, 75);
  });
  await page.waitForTimeout(800);
  report.damage = await page.evaluate(() => { const g = (window as any).wreckGame; return { opacity: Number((document.querySelector('.hit-feedback') as HTMLElement).style.opacity), tracers: g.view.tracers.active }; });
  await page.screenshot({ path: resolve(out, 'rapid-fire-feedback.png') });
  await page.evaluate(() => clearInterval((window as any).hitTimer));
  assert(report.damage.opacity > .1, 'Small rapid hits must remain noticeable');
  assert(report.damage.tracers > 0, 'Rapid fire must produce visible armor sparks');

  report.deathStart = await page.evaluate(async () => {
    const w = window as any, g = w.wreckGame, t = g.snapshot.tanks[0], radius = Math.hypot(...t.position);
    t.position = t.position.map((x: number) => x * (1 + 3 / radius)); t.velocity = [0, 0, 0]; g.world.relocateTank(t);
    w.__tmtFluids.lookAt(t.position, 2.5, 7, .8);
    g.realtime.api.damage(0, 10000, 'regression'); g.realtime.api.finish(1, 'destroyed');
    while (g.snapshot.phase !== 'finished') await new Promise(requestAnimationFrame);
    return { radius: Math.hypot(...t.position), tick: g.snapshot.tick, time: g.snapshot.time, winner: g.snapshot.winner, health: t.health };
  });
  await page.waitForTimeout(4000);
  report.deathEnd = await page.evaluate(() => {
    const g = (window as any).wreckGame, t = g.snapshot.tanks[0];
    return { radius: Math.hypot(...t.position), tick: g.snapshot.tick, time: g.snapshot.time, winner: g.snapshot.winner, health: t.health,
      paused: g.paused, phase: g.snapshot.phase, failure: g.view.debris.channel?.failure ?? null,
      validationErrors: (window as any).__tmtGame.performance.validationErrors, compileErrors: (window as any).__tmtGame.performance.compileErrors };
  });
  await page.screenshot({ path: resolve(out, 'player-wreck-after-death.png') });
  assert(report.deathStart.radius - report.deathEnd.radius > 1, 'Player wreck must fall behind results');
  for (const key of ['tick', 'time', 'winner', 'health']) assert.equal(report.deathEnd[key], report.deathStart[key], `${key} must remain final`);
  assert(report.deathEnd.paused && report.deathEnd.phase === 'finished');
  assert(!report.deathEnd.failure && !report.deathEnd.validationErrors && !report.deathEnd.compileErrors);
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify(report, null, 2));
} finally {
  writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close(); await server.close(); release();
}
