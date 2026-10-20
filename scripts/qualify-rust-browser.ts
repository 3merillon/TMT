/** One browser/GPU qualification at a time under the existing machine-wide GPU lock. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { build } from 'esbuild';
import { acquireGpuLock } from './capture';

const [wasmFile, outputFile, mode = 'fixture'] = process.argv.slice(2); assert.ok(wasmFile && outputFile, 'Pass WASM and external report path');
const source = await build({ entryPoints: ['scripts/rust-browser-check.ts'], bundle: true, write: false, format: 'iife', globalName: 'check', platform: 'browser', plugins: [{ name: 'raw-wgsl', setup(build) { build.onResolve({ filter: /\.wgsl\?raw$/ }, args => ({ path: resolve(args.resolveDir, args.path.replace(/\?raw$/, '')), namespace: 'shader' })); build.onLoad({ filter: /.*/, namespace: 'shader' }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'text' })); } }] });
const worker = await build({ entryPoints: ['src/gpu/terrain/rust-core-worker.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
const files = new Map<string, Uint8Array | string>([['/', '<!doctype html><title>TMT resident Rust qualification</title>'], ['/check.js', source.outputFiles[0].contents], ['/worker.js', worker.outputFiles[0].contents], ['/core.wasm', readFileSync(wasmFile)]]);
const server = createServer((req, res) => { const data = files.get(req.url ?? ''); res.writeHead(data ? 200 : 404, { 'Content-Type': req.url === '/' ? 'text/html' : req.url?.endsWith('.js') ? 'text/javascript' : 'application/octet-stream', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }); res.end(data); });
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const store = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright'), chrome = process.env.TMT_CHROME ?? readdirSync(store).filter(d => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])).map(d => join(store, d, 'chrome-win64', 'chrome.exe')).find(existsSync);
const unlock = await acquireGpuLock(); let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-webgpu-developer-features', '--disable-background-timer-throttling'] });
  const page = await browser.newPage(); page.on('pageerror', error => console.error(error.message)); await page.goto(base); await page.addScriptTag({ url: `${base}/check.js` });
  const result = await page.evaluate(mode => (window as any).check.run(mode, 7, 8), mode);
  const report = { scope: 'Hardware WebGPU qualification with actual browser workers, direct numeric Rust GPU inputs and existing CPU query BVH. Excludes game renderer, physics and simulation. Timings are diagnostic, not an A/B performance claim.', browser: browser.version(), ...result }; writeFileSync(outputFile, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { await browser?.close(); server.close(); unlock(); }
