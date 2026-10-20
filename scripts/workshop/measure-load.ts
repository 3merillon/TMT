/**
 * Workshop entry time on a production build: Workshop click to the first rendered frames, and every byte it fetched.
 * node node_modules/tsx/dist/cli.mjs scripts/workshop/measure-load.ts [--dist DIR] [--mbps 20] [--rtt 40] [--cpu 4] [--runs 3] [--warm] [--idle MS] [--shot FILE]
 * --mbps/--rtt throttle the network, --cpu slows the page's main thread (Chrome DevTools emulation), --warm keeps the HTTP
 * cache between runs, and --idle waits on the title before the click (default 500 ms, while the planet renderer still
 * warms up; longer waits let the title's prefetch finish). Builds into .verify-dist unless --dist names an existing
 * build. Uses TMT_CHROME, or the installed Chrome/Edge, with an isolated profile.
 */
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { build, preview } from 'vite';
import { defaultProfile, PROFILE_KEY } from '../../src/game/meta/profile';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const arg = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const runs = Number(arg('--runs') ?? 3), mbps = Number(arg('--mbps') ?? 0), rtt = Number(arg('--rtt') ?? 0), cpu = Number(arg('--cpu') ?? 1);
let dist = arg('--dist') ? resolve(arg('--dist')!) : undefined;
if (!dist) {
  dist = join(root, '.verify-dist');
  await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: dist, emptyOutDir: true } });
}
const server = await preview({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir: dist }, preview: { host: '127.0.0.1', port: 0, open: false } });
const base = server.resolvedUrls!.local[0].replace(/\/$/, '');
const executablePath = process.env.TMT_CHROME ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const browser = await chromium.launch({ executablePath, headless: false, ignoreDefaultArgs: ['--headless'], args: ['--headless=new', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu'] });
const results: object[] = [];
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await context.addInitScript(({ key, initial }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, initial); }, { key: PROFILE_KEY, initial: JSON.stringify(defaultProfile()) });
  for (let run = 0; run < runs; run++) {
    const page = await context.newPage(), cdp = await context.newCDPSession(page), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    cdp.on('Network.responseReceived', event => { if (event.response.status >= 400) errors.push(`${event.response.status} ${event.response.url}`); });
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await cdp.send('Network.enable');
    if (!args.includes('--warm')) await cdp.send('Network.clearBrowserCache');
    if (mbps || rtt) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: rtt, downloadThroughput: mbps ? mbps * 125000 : -1, uploadThroughput: -1 });
    await page.goto(`${base}/play.html`, { waitUntil: 'load' });
    await page.locator('#title-workshop').waitFor();
    await page.waitForTimeout(Number(arg('--idle') ?? 500));
    if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
    const marks = await page.evaluate(() => { performance.clearResourceTimings(); performance.setResourceTimingBufferSize(1000); return performance.now(); });
    await page.locator('#title-workshop').click();
    await page.waitForFunction('window.__tmtWorkshop?.ready && !document.querySelector(".ws-loading")', undefined, { timeout: 300000, polling: 16 });
    // A string keeps tsx's helper injection out of the page.
    const result = await page.evaluate<Record<string, number>>(`(() => {
      const start = ${marks}, entries = performance.getEntriesByType('resource');
      const workshop = entries.filter(e => e.name.includes('/workshop/'));
      const sum = list => list.reduce((n, e) => n + (e.encodedBodySize || e.transferSize), 0);
      return { readyMs: Math.round(performance.now() - start), workshopFiles: workshop.length, workshopBytes: sum(workshop), allBytes: sum(entries),
        lastWorkshopFetchMs: Math.round(Math.max(0, ...workshop.map(e => e.responseEnd - start))), ...window.__tmtWorkshop.resourceCounts, phases: (globalThis.__wsT ?? []).map(([k, t], i, a) => k + ':' + Math.round(t - (i ? a[i - 1][1] : start))).join(' ') };
    })()`);
    const pipelines = await page.evaluate(`(() => { const p = window.__tmtWorkshop.engine.services.ctx.pipelines; return { ...p.stats(), slowest: p.compileTimes().slice(0, 5) }; })()`);
    Object.assign(result, { pipelines });
    if (args.includes('--reenter')) {
      // Leave and reopen in the same page: what the browser's own shader cache saves on a second visit.
      await page.locator('#workshop-back').first().click();
      await page.locator('#title-workshop').waitFor();
      await page.waitForTimeout(1000);
      const again = await page.evaluate(() => performance.now());
      await page.locator('#title-workshop').click();
      await page.waitForFunction('window.__tmtWorkshop?.ready && !document.querySelector(".ws-loading")', undefined, { timeout: 300000, polling: 16 });
      Object.assign(result, { reenterReadyMs: Math.round(await page.evaluate(() => performance.now()) - again),
        reenterPipelines: await page.evaluate(`window.__tmtWorkshop.engine.services.ctx.pipelines.stats()`) });
    }
    if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    if (arg('--shot') && run === runs - 1) { await page.waitForTimeout(2500); await page.screenshot({ path: resolve(arg('--shot')!) }); }
    results.push({ run, ...result, errors });
    console.log(JSON.stringify({ run, ...result, errors }));
    await page.close();
  }
} finally { await browser.close(); await server.close(); }
const ready = results.map(r => (r as { readyMs: number }).readyMs).sort((a, b) => a - b);
console.log(JSON.stringify({ mbps, rtt, cpu, medianReadyMs: ready[Math.floor(ready.length / 2)] }));
