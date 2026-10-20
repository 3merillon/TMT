/** Sequential CPU/worker/GPU probe under the shared GPU lock; all corpus and result data stay outside the repo. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { build } from 'esbuild';
import { acquireGpuLock } from './capture';

const [directory, wasmFile, outputFile] = process.argv.slice(2);
assert.ok(directory && wasmFile && outputFile, 'Pass capture directory, WASM file, output JSON');
const source = await build({ entryPoints: ['scripts/terrain-core-browser-probe.ts'], bundle: true, write: false, format: 'iife', globalName: 'probe', platform: 'browser' });
const files = new Map<string, Uint8Array | string>([['/', '<!doctype html><title>TMT terrain core probe</title>'], ['/probe.js', source.outputFiles[0].contents], ['/core.wasm', readFileSync(wasmFile)], ['/classify.wgsl', readFileSync('src/gpu/terrain/probe-classify.wgsl')]]);
files.set('/worker.js', `importScripts('/probe.js'); self.onmessage=async()=>{try{postMessage({calibration:probe.calibration(),result:await probe.cpuProbe()})}catch(e){postMessage({error:String(e)})}}`);
for (const name of ['manifest.json', 'samples.bin', 'vertices.bin', 'tasks.bin', 'intersections.bin', 'expected.bin']) files.set(`/${name}`, readFileSync(join(directory, name)));
const server = createServer((req, res) => { const data = files.get(req.url ?? ''); res.writeHead(data ? 200 : 404, { 'Content-Type': req.url === '/' ? 'text/html' : req.url?.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' }); res.end(data); });
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const store = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
const chrome = process.env.TMT_CHROME ?? readdirSync(store).filter(d => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])).map(d => join(store, d, 'chrome-win64', 'chrome.exe')).find(existsSync);
const unlock = await acquireGpuLock();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-webgpu-developer-features', '--disable-background-timer-throttling'] });
  const results: unknown[] = [];
  for (const throttle of [1, 4, 6]) {
    const page = await browser.newPage(), cdp = await page.context().newCDPSession(page);
    await page.goto(base); await page.addScriptTag({ url: `${base}/probe.js` });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    const result = await page.evaluate(async () => {
      const w = window as any, mainCalibration = w.probe.calibration();
      const worker = new Worker('/worker.js');
      const workerResult = await new Promise<any>((resolve, reject) => { worker.onmessage = e => resolve(e.data); worker.onerror = e => reject(new Error(e.message)); worker.postMessage(null); });
      worker.terminate();
      if (workerResult.error) throw new Error(workerResult.error);
      return { mainCalibration, worker: workerResult, main: await w.probe.cpuProbe(), gpu: await w.probe.gpuProbe() };
    });
    results.push({ throttle, ...result });
    writeFileSync(outputFile, JSON.stringify({ browser: browser.version(), wasmFile, scope: 'Sequential isolated stage probes; throttling calibration distinguishes main and worker behavior. Not phone hardware or full terrain timings.', results }, null, 2));
    console.log(JSON.stringify({ throttle, mainCalibration: result.mainCalibration, workerCalibration: result.worker.calibration, gpu: result.gpu }));
    await page.context().close();
  }
} finally { await browser?.close(); server.close(); unlock(); }
