/** Whole startup measurement on real Chromium/WebGPU. Throttling/viewport emulation is NOT mobile hardware.
 * node --import tsx scripts/benchmark-browser-startup.ts --root . --label after --repeat 2 --throttle 1
 * Add --production true after building <root>/dist. Each seed/repeat gets an empty browser context (cold page cache).
 *   --base <url>     measure a build that is already served (a preserved bundle) instead of starting a server
 *   --out <dir>      output directory (default artifacts/startup-audio)      --width / --height   viewport
 *   --frames <n>     also record the first n frames rendered after the session reports ready (0 = off, the default)
 *   --api-stats      with --frames: WebGPU call counts per frame (an attribution run, not a timing)
 *   --trace          with --frames: CPU functions of frame 0, frame 1 and frames 2-30 (attribution; use an unminified build)
 *
 * --frames uses the injected real-time probe of scripts/capture-performance.ts (scripts/performance-probe.ts), so a
 * preserved bundle needs no changes: the page is opened with ?renderbench and the probe replaces the batch gate before
 * the match is ready, which leaves the ordinary rAF loop, real dt and the product's default settings. Frame 0 is the
 * first frame the loop renders. Nothing heavy is read from the page until the recorded window is over: `settledMs` of
 * such a run is therefore never earlier than the end of the window.
 */
import { chromium } from 'playwright-core';
import { createServer, preview } from 'vite';
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cpus } from 'node:os';
import { acquireGpuLock } from './capture';
import { installPerformanceProbe } from './performance-probe';
import { cadence, frameIntervals, summarizeTrace, type Recording } from './performance-metrics';

const flags = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) flags.set(process.argv[i].slice(2), process.argv[i + 1]?.startsWith('--') ? 'true' : process.argv[i + 1] ?? 'true');
const root = resolve(flags.get('root') ?? '.'), label = flags.get('label') ?? 'current';
const repeats = Number(flags.get('repeat') ?? 2), throttle = Number(flags.get('throttle') ?? 1);
const workers = flags.has('workers') ? Number(flags.get('workers')) : undefined;
if (workers !== undefined && (!Number.isInteger(workers) || workers < 1 || workers > 8)) throw new Error('--workers must be 1..8');
const seeds = (flags.get('seeds') ?? '4,5,6,7').split(',').map(Number), production = flags.get('production') === 'true';
const frames = Number(flags.get('frames') ?? 0), apiStats = flags.has('api-stats'), trace = flags.has('trace'), served = flags.get('base');
const viewport = throttle > 1 ? { width: 390, height: 844 } : { width: Number(flags.get('width') ?? 1280), height: Number(flags.get('height') ?? 720) };
const out = resolve(flags.get('out') ?? 'artifacts/startup-audio'); mkdirSync(out, { recursive: true });
const browserStore = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
const chrome = process.env.TMT_CHROME ?? readdirSync(browserStore).filter(d => /^chromium-\d+$/.test(d))
  .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
  .map(d => join(browserStore, d, 'chrome-win64', 'chrome.exe')).find(existsSync);
if (!chrome) throw new Error('Set TMT_CHROME to an installed Chromium executable.');
console.log(`Starting ${label} production=${production} root=${root}${served ? ` base=${served}` : ''}`);
const unlock = await acquireGpuLock();
const server = served ? undefined : production ? await preview({ root, logLevel: 'warn', build: { outDir: flags.get('dist') ?? 'dist' }, preview: { host: '127.0.0.1', port: 0, open: false } })
  : await createServer({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn', cacheDir: join(root, '.vite-startup-bench'),
    server: { host: '127.0.0.1', port: 0, open: false, hmr: false, watch: null, fs: { allow: [root, realpathSync(join(root, 'node_modules'))] } } });
if (server && 'listen' in server) await server.listen();
const base = served?.replace(/\/$/, '') ?? `http://127.0.0.1:${(server!.httpServer!.address() as { port: number }).port}`;
console.log(`Serving ${base}`);
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist',
  '--enable-gpu', '--enable-webgpu-developer-features', '--enable-precise-memory-info', '--disable-background-timer-throttling'] });
const results: unknown[] = [];
console.log(`Browser ${browser.version()}`);

/** Serialised into the page. `frames` > 0 switches the ?renderbench hook to real time as soon as it exists and samples
 * the renderer once per rendered frame; the heavy window.__tmtGame getter is read only when that window is over. */
function startupBench(frames: number): void {
  const w = window as any, raf: typeof requestAnimationFrame = w.__startupRaf;
  const b = w.__startupBench = { frames: [] as number[], longTasks: [] as { start: number; duration: number }[], peakMainHeapBytes: 0, playableMs: 0, settledMs: 0,
    rendered: 0, states: [] as Record<string, number>[], driven: false, begin: 0, submits: [] as { at: number; done: number }[] };
  // Every queue submission and when the GPU finished it, warm-up frames before ready included.
  const queue = (globalThis as any).GPUQueue?.prototype;
  if (frames && queue) {
    const submit = queue.submit;
    queue.submit = function (this: any, ...args: unknown[]) {
      const result = submit.apply(this, args);
      if (b.rendered < frames) { const entry = { at: performance.now(), done: NaN }; b.submits.push(entry); this.onSubmittedWorkDone().then(() => { entry.done = performance.now(); }, () => {}); }
      return result;
    };
  }
  new PerformanceObserver(list => { for (const e of list.getEntries()) b.longTasks.push({ start: e.startTime, duration: e.duration }); }).observe({ type: 'longtask', buffered: true });
  let last = performance.now();
  const frame = (now: number) => {
    if (frames && !b.driven && w.__tmtRenderBench && w.__tmtPerf) {
      b.driven = true;
      w.__tmtPerf.realtime(true, 1); b.begin = w.__tmtPerf.begin();
      const driver = w.__tmtRenderBench, rendered = driver.afterFrame;
      driver.afterFrame = (ms: number) => {
        rendered(ms);
        if (b.rendered < frames) { const v = w.__tmtVisibility?.stats(); b.states.push({ ...v?.custom, sdfValid: v?.sdfValid ? 1 : 0, at: performance.now() }); }
        b.rendered++;
      };
    }
    if (!b.settledMs) {
      b.frames.push(now - last); last = now;
      b.peakMainHeapBytes = Math.max(b.peakMainHeapBytes, (performance as any).memory?.usedJSHeapSize ?? 0);
      if (frames) { if (w.__tmtRenderBench?.ready && !b.playableMs) b.playableMs = performance.now(); }
      if (!frames || b.rendered >= frames) {
        const g = w.__tmtGame;
        if (g?.ready && !b.playableMs) b.playableMs = performance.now();
        if (g?.ready && g.performance?.visuals?.liquidReady && g.performance?.planetPipeline === 'ready'
          && g.performance?.compileErrors === 0 && g.performance?.validationErrors === 0) b.settledMs = performance.now();
      }
    }
    raf(frame);
  };
  raf(frame);
}

try {
  for (let repeat = 0; repeat < repeats; repeat++) for (const seed of seeds) {
    const context = await browser.newContext({ viewport });
    // The app has no favicon asset; avoid an irrelevant Chromium automatic /favicon.ico 404.
    await context.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
    const page = await context.newPage(), errors: string[] = [];
    page.on('pageerror', e => { errors.push(e.message); console.error(e.message); });
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    // tsx preserves function names with __name; the page gets its tiny identity shim. The bench keeps the native rAF,
    // so its own bookkeeping is not charged to the frames the probe records.
    await page.addInitScript('globalThis.__name = (value) => value; window.__startupRaf = window.requestAnimationFrame.bind(window);');
    if (frames) await page.addInitScript(installPerformanceProbe, { capacity: frames + 64, apiStats });
    await page.addInitScript(startupBench, frames);
    try {
      console.log(`Loading seed ${seed}, repeat ${repeat}`);
      if (frames && trace) await browser.startTracing(page, { categories: ['-*', 'devtools.timeline', 'v8', 'disabled-by-default-v8.cpu_profiler', 'blink.user_timing', 'toplevel'] });
      await page.goto(`${base}/?mode=drive&seed=${seed}&${frames ? 'renderbench' : 'residentCheck'}${workers === undefined ? '' : `&residentCheck&residentWorkers=${workers}`}`, { waitUntil: 'domcontentloaded' });
      console.log(`DOM ready seed ${seed}`);
      let firstFrames: unknown;
      if (frames) {
        await page.waitForFunction(count => (window as any).__startupBench?.rendered >= count, frames, { timeout: 240000, polling: 250 });
        const recording: Recording = await page.evaluate(() => ({ ...(window as any).__tmtPerf.end(), begin: (window as any).__startupBench.begin }));
        const events = trace ? JSON.parse((await browser.stopTracing()).toString('utf8')).traceEvents : undefined;
        firstFrames = firstFrameRecord(recording, await page.evaluate(() => (window as any).__startupBench.states), events,
          await page.evaluate(() => (window as any).__startupBench.submits));
      }
      await page.waitForFunction(() => (window as any).__startupBench?.settledMs > 0, undefined, { timeout: 180000 });
      const result = await page.evaluate(() => {
        const w = window as any, b = w.__startupBench, g = w.__tmtGame;
        const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)] ?? 0;
        const tasks: number[] = b.longTasks.map((task: { duration: number }) => task.duration);
        return { firstPaintMs: performance.getEntriesByType('paint').find(p => p.name === 'first-contentful-paint')?.startTime,
          domReadyMs: (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).domContentLoadedEventEnd,
          playableMs: b.playableMs, settledMs: b.settledMs, fluidAndVisualTailMs: b.settledMs - b.playableMs,
          frameP95Ms: percentile(b.frames, .95), frameMaxMs: Math.max(...b.frames), longTaskCount: tasks.length,
          longTaskMaxMs: Math.max(0, ...tasks), longTaskTotalMs: tasks.reduce((a: number, v: number) => a + v, 0),
          // Long tasks that began once the match was playable: the ones a player can feel.
          longTasksAfterPlayable: b.longTasks.filter((task: { start: number }) => task.start >= b.playableMs).map((task: { start: number; duration: number }) => ({ at: Math.round(task.start - b.playableMs), ms: task.duration })),
          peakMainHeapBytes: b.peakMainHeapBytes, hardwareConcurrency: navigator.hardwareConcurrency,
          startup: g.startup, terrain: g.resident?.history[0]?.metrics,
          timeline: performance.getEntries().filter(e => e.name.startsWith('tmt:')).map(e => ({ name: e.name, start: e.startTime, ms: e.duration })),
          resources: performance.getEntriesByType('resource').map(e => { const r = e as PerformanceResourceTiming; return { name: r.name, start: r.startTime, ms: r.duration, transferBytes: r.transferSize }; }),
          audio: g.audio && { state: g.audio.state, unlocked: g.audio.unlocked, lastError: g.audio.lastError },
          rendering: { materialBakeMs: g.performance.materialBakeMs, materialBytes: g.performance.materialBytes,
            renderer: g.performance.renderer, fluidStartup: g.performance.fluidStartup, visuals: g.performance.visuals } };
      });
      results.push({ seed, repeat, ...result, firstFrames, errors });
      // A scene keeps evolving (waves, exposure and temporal filters); observe two more seconds at final settings.
      // settledMs is the initial shader+liquid readiness gate, not a claim that the fluids have reached equilibrium.
      await page.waitForTimeout(2000);
      await page.screenshot({ path: join(out, `${label}-seed${seed}-r${repeat}.png`) });
      const first = firstFrames as ReturnType<typeof firstFrameRecord> | undefined;
      console.log(JSON.stringify({ label, seed, repeat, playableMs: result.playableMs, settledMs: result.settledMs, topologyMs: result.terrain?.topologyMs,
        ...(first ? { firstFrames: first.windows, longTasksAfterPlayable: result.longTasksAfterPlayable } : {}), errors }));
    } catch (error) {
      const diagnostic = await page.evaluate(() => ({ title: document.title, text: document.body.innerText.slice(0, 1200), bench: (window as any).__startupBench, game: (window as any).__tmtGame })).catch(() => null);
      results.push({ seed, repeat, diagnostic, errors: [...errors, String(error)] }); console.error(`${label} seed ${seed}: ${String(error)}`);
      await page.screenshot({ path: join(out, `${label}-seed${seed}-failed.png`) }).catch(() => {});
    }
    await context.close();
    writeFileSync(join(out, `${label}.json`), JSON.stringify({ label, root, base: served ?? null, production, throttle, workers, viewport, frames, apiStats, cpu: cpus()[0]?.model,
      browser: browser.version(), measurement: throttle > 1 ? 'Desktop CPU throttling and narrow viewport; not a real phone; worker CPU throttling is browser dependent.' : 'Desktop hardware WebGPU',
      visualGate: 'settledMs means playable plus liquid ready, planet pipeline ready and zero compiler/validation errors. Screenshot follows another 2000 ms of rendering; dynamic fluid/temporal convergence has no completion event.',
      memoryScope: 'sampled main renderer JS heap only; excludes workers, WASM and GPU; terrain GPU metrics separate', results }, null, 2));
  }
} finally { await browser.close(); await server?.close(); unlock(); }
if (results.some(r => (r as { errors: string[] }).errors.length)) process.exitCode = 1;

/** The first frames after ready: every frame's interval, main-thread work and GPU completion latency, the cadence of
 * the whole window and of its thirds, and the frames at which a renderer gauge changed (a build or a solve landed). */
function firstFrameRecord(recording: Recording, states: Record<string, number>[], events?: Parameters<typeof summarizeTrace>[0], submits: { at: number; done: number }[] = []) {
  const f = recording.frame, intervals = frameIntervals(recording), round = (v: number) => Math.round(v * 10) / 10;
  const window = (from: number, to: number) => {
    const part = intervals.slice(from, to), c = cadence(part), work = f.work.slice(from, to + 1);
    return c && { frames: part.length, p50: round(c.p50), p95: round(c.p95), max: round(c.max), over25ms: c.hitches['over25ms'], over33ms: c.hitches['over33.4ms'], over50ms: c.hitches.over50ms,
      excessMs: round(c.excessMs), workMaxMs: round(Math.max(...work)), workSumMs: round(work.reduce((a, b) => a + b, 0)) };
  };
  const third = Math.floor(intervals.length / 3), changes: { frame: number; key: string; from: number; to: number }[] = [];
  for (let i = 1; i < states.length; i++) for (const key of Object.keys(states[i])) {
    if (key !== 'at' && states[i][key] !== states[i - 1][key] && !/^(pagesDrawn|smcDraws|shockwaves|gas|clouds|volumetrics)/.test(key)) changes.push({ frame: i, key, from: states[i - 1][key], to: states[i][key] });
  }
  return {
    readyAtMs: round(f.start[0]), windowMs: round(f.raf[f.raf.length - 1] - f.raf[0]),
    windows: { all: window(0, intervals.length), first: window(0, third), middle: window(third, 2 * third), last: window(2 * third, intervals.length) },
    intervalMs: intervals.map(round), workMs: f.work.map(round), gpuLatencyMs: f.gpuDone.map((done, i) => round(done - f.rendered[i])),
    longTasks: recording.longTasks.map(task => ({ at: round(task.start - f.start[0]), ms: task.duration })),
    longFrames: recording.longFrames.map(long => ({ at: round(long.start - f.start[0]), ms: round(long.duration), blocking: round(long.blocking),
      scripts: long.scripts.map(script => `${script.invoker} ${script.fn} ${round(script.duration)}`) })),
    firstState: states[0], changes,
    // Submissions from 1.5 s before the first frame: the warm-up's (or the load's) GPU backlog as the match appears.
    submits: submits.filter(entry => entry.at > f.start[0] - 1500).map(entry => ({ at: round(entry.at - f.start[0]), gpuMs: round(entry.done - entry.at) })),
    ...(events ? { functions: Object.fromEntries(([['frame0', 0, 0], ['frame1', 1, 1], ['frames2to30', 2, 30]] as const).map(([name, from, to]) => {
      const table = summarizeTrace(events, { name: 'tmt-perf-begin', now: recording.begin, endNow: recording.end }, [[f.start[from], f.start[Math.min(to, f.start.length - 1)] + f.work[Math.min(to, f.work.length - 1)]]], 60);
      return [name, 'error' in table ? table : table.worstFrameFunctions?.main];
    })) } : {}),
    ...(recording.apiStats ? { creates: f.creates, bindGroups: f.bindGroups, uploadKB: f.uploadBytes.map(bytes => Math.round(bytes / 1024)), apiMs: f.apiMs.map(round),
      compiles: recording.apiEvents.filter(event => event.kind !== 'mapAsync').map(event => ({ kind: event.kind, label: event.label, at: round(event.start - f.start[0]), ms: round(event.ms) })) } : {}),
  };
}
