/**
 * Browser capture harness: drive the real game in Chromium with hardware WebGPU and
 * save PNG screenshots plus console/page-error logs, so changes can be inspected visually.
 *
 *   npx tsx scripts/capture.ts --url "/play.html?mode=drive&seed=7"
 *   npx tsx scripts/capture.ts --url "/play.html?mode=drive&seed=7" --keys "shot:ready,hold:KeyW:2000,shot:moved,press:Space,wait:1500,shot:fired"
 *   npx tsx scripts/capture.ts --url /play.html --url /effects.html --size 1920x1080 --out artifacts/screens/run1
 *   npx tsx scripts/capture.ts --plan plan.json          (array of jobs: { url, name?, wait?, settle?, keys?, shots?, interval?, css?, hideUi?, size?, timeout?, probe?, frames? },
 *                                                         or { "jobs": [...], "budget"?: "budgets/x.json", "out"?: "artifacts/screens/x", "name"?: "x" })
 *   npx tsx scripts/capture.ts --plan smoke              (shorthand for scripts/capture-plans/smoke.json)
 *   npx tsx scripts/capture.ts --gpu                     (print the WebGPU adapter Chromium gets and exit)
 *
 * Server: starts an in-process Vite dev server on a free 127.0.0.1 port (HMR and file watching off, so
 * concurrent edits cannot reload the page mid-capture), unless --base http://127.0.0.1:5173 reuses one.
 * Worktree-safe: the optimizer cache is <checkout>/.vite-capture (never shared between worktrees) and the real path
 * of a junctioned node_modules is allowed in server.fs, so worktrees get no 403s.
 * Browser: Playwright's Chromium (%LOCALAPPDATA%/ms-playwright/chromium-*), --headless=new by default; this
 * gets the NVIDIA hardware adapter on this machine. --headed opens a window instead. --chrome <exe> overrides.
 *
 * Options (one job from flags; --url may repeat, sharing the other flags):
 *   --url <path|url>     page to open (relative paths resolve against the server; Git Bash rewrites a leading '/',
 *                        which is repaired automatically, or use MSYS_NO_PATHCONV=1 / 'play.html' without the slash)
 *   --name <prefix>      file prefix (default: derived from the URL)
 *   --out <dir>          output directory (default: the plan's "out", else artifacts/screens)
 *   --size WxH           viewport in CSS px (default 1280x720); --dpr <n> device scale (default 1)
 *   --touch              a touch phone context (hasTouch, isMobile) for the tap/swipe/pinch/stick steps
 *   --wait <cond>        readiness: auto | game | effects | canvas | load | selector:<css> | js:<expr> | <ms>
 *                        auto = game for play.html (window.__tmtGame.ready), effects for effects.html, else canvas
 *   --timeout <ms>       readiness timeout (default 180000)
 *   --settle <ms>        delay after ready before the steps (default 2500)
 *   --keys <steps>       comma-separated steps (a plan file takes an array instead):
 *                          shot[:label]            screenshot (no shot in the steps and no --shots => 'final' is appended)
 *                          wait:<ms> | <ms>        sleep
 *                          hold:<Key>[+<Key>]:<ms> hold keys together (e.g. hold:KeyW+KeyD:1500)
 *                          press:<Key> | down:<Key> | up:<Key>   (Playwright key names: KeyW, Space, ArrowLeft...)
 *                          click:<css>             click an element
 *                          hover:<css> | move:<x>:<y> move the real mouse to an element/viewport point
 *                          drag:x1:y1:x2:y2[:steps] mouse drag (values <= 1 are viewport fractions)
 *                          wheel:<dy>[:<count>]    scroll wheel at the viewport centre, repeated count times
 *                                                  (play.html clamps each event to 400 px: wheel:-400:3 = closest zoom)
 *                        touch steps (need --touch; real CDP touch points, so the page sees pointerType 'touch'):
 *                          tap:<x>:<y> | tap:<css> one-finger tap at a point or an element's centre (css may contain ":")
 *                          swipe:x1:y1:x2:y2[:steps[:holdMs]]   one-finger drag (holdMs: rest before lifting)
 *                          pinch:cx:cy:from:to[:steps]          two fingers about a centre, spread from -> to px apart
 *                          stick:x:y:dx:dy:ms[:css]             hold a thumb at x,y moved by dx,dy for ms; with css, a
 *                                                  second finger taps that element meanwhile (multi-touch)
 *                          waitfor:<js expr>       poll until truthy (timeout = --timeout)
 *                          eval:<js expr>          run an expression; result stored in the log (plan files only if it has commas)
 *                          eval@<label>:<js expr>  the same, stored with a label so budgets can address it: jobs.<job>.evals.<label>.result
 *                          reload                  reload in the same browser context (IndexedDB and caches survive) and wait
 *                                                  for readiness again: timings.reloadReadyMs / reloadPageMs (reload2..., ...)
 *                        default steps: shot:ready
 *   --shots <n> --interval <ms>   append n extra shots spaced by interval (labels shot-01...)
 *   --hide-ui            hide the HUD overlays (play.html shell/toast/world labels, effects chrome) for clean scene shots
 *   --css <css>          inject extra CSS
 *   --probe <js expr>    expression evaluated at every shot and stored in the log (default: game/effects telemetry)
 *   --strict             exit 1 on page errors or console errors too (always exits 1 if a page never becomes ready)
 *   --arg <chromeFlag>   extra Chromium flag (repeatable)
 *   --perf               take the machine-wide GPU lock %TEMP%/tmt-gpu.lock first (waits up to 10 min; breaks locks older
 *                        than 15 min or whose process is gone; released on exit), so perf numbers never overlap
 *   --gpu-timings        add --enable-webgpu-developer-features (unquantised timestamps) and store
 *                        window.__tmtGame.performance.gpu (or the engine sandbox telemetry's gpu) with every shot
 *   --frames <n>         after each shot, sample the page telemetry every requestAnimationFrame for n frames and store
 *                        p50/p95/max of the frame time and of every numeric telemetry field (shot.frames)
 *   --repeat <n> [--min] run the jobs n times (logs <name>.r2.json...); with --min, <name>.json and the run document hold the
 *                        best of n for every numeric metric, including eval@ results (the minimum; the maximum for
 *                        fps-like keys)
 *   --budget <file|none> evaluate the run with scripts/check-capture.ts (default: the plan's "budget"); exit 1 on a FAIL
 *
 * Output per job: <out>/<name>-<label>.png and <out>/<name>.json (adapter, timings, shots with telemetry,
 * console messages, page errors, failed requests, HTTP errors). Per run: <out>/<run>.capture.json, the document
 * check-capture reads (run = the plan name, else "capture"). A summary is printed to stdout as JSON.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateBudget, failed as budgetFailed, formatTable, loadBudget } from './check-capture';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface Job {
  url: string; name?: string; wait?: string; settle?: number; keys?: string | string[]; shots?: number; interval?: number;
  css?: string; hideUi?: boolean; size?: string; dpr?: number; timeout?: number; probe?: string; frames?: number; touch?: boolean;
}
interface PlanFile { jobs: Job[]; budget?: string; out?: string; name?: string }
interface Options {
  jobs: Job[]; out: string; base?: string; headed: boolean; chrome?: string; strict: boolean; gpuOnly: boolean; args: string[];
  perf: boolean; gpuTimings: boolean; repeat: number; min: boolean; budget?: string; run: string; planFile?: string;
}

/** Old plans are a bare array of jobs; new plans are { jobs, budget?, out?, name? }. */
export function readPlanFile(file: string): PlanFile {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Job[] | PlanFile;
  const plan = Array.isArray(parsed) ? { jobs: parsed } : parsed;
  if (!Array.isArray(plan.jobs)) throw new Error(`${file}: a plan is an array of jobs or { "jobs": [...] }`);
  return plan;
}
function resolvePlanPath(spec: string): string {
  if (existsSync(resolve(spec))) return resolve(spec);
  const named = join(root, 'scripts', 'capture-plans', spec.endsWith('.json') ? spec : `${spec}.json`);
  if (existsSync(named)) return named;
  throw new Error(`plan not found: ${spec}`);
}

function parseArgs(argv: string[]): Options {
  const flags = new Map<string, string[]>();
  const booleans = new Set(['headed', 'strict', 'gpu', 'hide-ui', 'help', 'perf', 'gpu-timings', 'min', 'touch']);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    let [key, value] = token.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (value === undefined) value = booleans.has(key) ? 'true' : argv[++i];
    if (value === undefined) throw new Error(`Missing value for --${key}`);
    flags.set(key, [...flags.get(key) ?? [], value]);
  }
  if (flags.has('help')) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]); process.exit(0); }
  const one = (key: string) => flags.get(key)?.at(-1);
  const num = (key: string) => one(key) === undefined ? undefined : Number(one(key));
  const shared: Omit<Job, 'url'> = {
    name: one('name'), wait: one('wait'), settle: num('settle'), keys: one('keys'), shots: num('shots'), interval: num('interval'),
    css: one('css'), hideUi: one('hide-ui') === 'true', size: one('size'), dpr: num('dpr'), timeout: num('timeout'), probe: one('probe'), frames: num('frames'), touch: one('touch') === 'true',
  };
  const defined = Object.fromEntries(Object.entries(shared).filter(([, v]) => v !== undefined && v !== false));
  let jobs: Job[] = (flags.get('url') ?? []).map((url, index, all) => ({ ...defined, url, name: shared.name && all.length > 1 ? `${shared.name}-${index + 1}` : shared.name }));
  const planSpec = one('plan');
  let plan: PlanFile | undefined, planFile: string | undefined;
  if (planSpec) {
    planFile = resolvePlanPath(planSpec);
    plan = readPlanFile(planFile);
    // Flags fill in what a plan job leaves out; the plan's own fields win.
    jobs = [...jobs, ...plan.jobs.map(job => ({ ...defined, ...job }))];
  }
  const gpuOnly = one('gpu') === 'true';
  if (!jobs.length && !gpuOnly) jobs = [{ ...defined, url: '/' }];
  const repeat = num('repeat') ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error('--repeat must be a positive integer');
  if (shared.frames !== undefined && !(Number.isInteger(shared.frames) && shared.frames > 0)) throw new Error('--frames must be a positive integer');
  const budget = one('budget') ?? plan?.budget;
  return {
    jobs, gpuOnly, out: resolve(root, one('out') ?? plan?.out ?? 'artifacts/screens'), base: one('base')?.replace(/\/$/, ''),
    headed: one('headed') === 'true', chrome: one('chrome'), strict: one('strict') === 'true', args: flags.get('arg') ?? [],
    perf: one('perf') === 'true', gpuTimings: one('gpu-timings') === 'true', repeat, min: one('min') === 'true',
    budget: budget && budget !== 'none' ? budget : undefined,
    run: plan?.name ?? (planFile ? basename(planFile).replace(/\.json$/, '') : 'capture'), planFile,
  };
}

function findChrome(explicit?: string): string {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  if (process.env.TMT_CHROME) candidates.push(process.env.TMT_CHROME);
  const store = process.env.PLAYWRIGHT_BROWSERS_PATH ?? (process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
    : process.platform === 'darwin' ? join(process.env.HOME ?? '', 'Library/Caches/ms-playwright') : join(process.env.HOME ?? '', '.cache/ms-playwright'));
  if (existsSync(store)) {
    // Prefer the revision playwright-core 1.61 expects (1228), then the newest installed.
    const revisions = readdirSync(store).filter(dir => /^chromium-\d+$/.test(dir)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    revisions.sort((a, b) => Number(b === 'chromium-1228') - Number(a === 'chromium-1228'));
    for (const dir of revisions) candidates.push(join(store, dir, 'chrome-win64', 'chrome.exe'), join(store, dir, 'chrome-linux', 'chrome'),
      join(store, dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'));
  }
  const found = candidates.find(path => existsSync(path));
  if (!found) throw new Error(`No Chromium found. Pass --chrome <path> or set TMT_CHROME. Looked in: ${store}`);
  return found;
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => resolvePort(port)); });
  });
}

async function startVite(): Promise<{ server: ViteDevServer; base: string }> {
  const port = await freePort();
  // Worktrees junction node_modules to the main checkout; Vite resolves the real path, so allow it
  // explicitly and keep the optimizer cache inside this checkout (never shared between worktrees).
  const modulesRealPath = realpathSync(join(root, 'node_modules'));
  const server = await createServer({
    root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn', clearScreen: false,
    cacheDir: join(root, '.vite-capture'),
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null, open: false, fs: { allow: [root, modulesRealPath] } },
  });
  await server.listen();
  return { server, base: `http://127.0.0.1:${port}` };
}

async function launch(options: Options): Promise<Browser> {
  const args = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu', '--force-color-profile=srgb',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', ...options.args];
  // Without developer features Chromium quantises timestamp queries to 100 µs.
  if (options.gpuTimings) args.push('--enable-webgpu-developer-features');
  if (!options.headed) args.unshift('--headless=new');
  return chromium.launch({ executablePath: findChrome(options.chrome), headless: !options.headed, args, ignoreDefaultArgs: ['--headless'], timeout: 60000 });
}

// ---- GPU lock (--perf) --------------------------------------------------------------------------------------------
export const GPU_LOCK = join(tmpdir(), 'tmt-gpu.lock');
// Several agents can queue behind one GPU: TMT_GPU_LOCK_WAIT_MS lengthens the wait without changing the default.
const LOCK_WAIT_MS = Number(process.env.TMT_GPU_LOCK_WAIT_MS) || 10 * 60_000, LOCK_STALE_MS = 15 * 60_000;
function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
/**
 * Remove a lock judged stale without ever removing a fresh one. Two waiters can judge the same lock stale; if the first
 * breaks it and takes a new lock before the second acts, a plain unlink by the second would delete the first's fresh lock
 * and both would run. So the lock is renamed to a unique name first (only one waiter can win that), and if the renamed
 * file is not the one judged stale it is linked back (link never overwrites a third waiter's newer lock).
 */
export function breakStaleLock(lockFile: string, judged: string | undefined): 'broken' | 'restored' | 'lost' | 'gone' {
  const claimed = `${lockFile}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.stale`;
  try { renameSync(lockFile, claimed); } catch { return 'gone'; /* another waiter broke it first */ }
  let text: string | undefined;
  try { text = readFileSync(claimed, 'utf8'); } catch { /* unreadable: treat as the stale one */ }
  let outcome: 'broken' | 'restored' | 'lost' = 'broken';
  if (judged !== undefined && text !== undefined && text !== judged) {
    try { linkSync(claimed, lockFile); outcome = 'restored'; } catch { outcome = 'lost'; }
  }
  try { unlinkSync(claimed); } catch { /* already gone */ }
  return outcome;
}

/** Take the machine-wide GPU lock; resolves to its release function. */
export async function acquireGpuLock(lockFile = GPU_LOCK, waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS): Promise<() => void> {
  const deadline = Date.now() + waitMs;
  let announced = false;
  for (;;) {
    try {
      const fd = openSync(lockFile, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, root, since: new Date().toISOString() }));
      closeSync(fd);
      // Keep the lock fresh on long runs so nobody breaks it as stale.
      const heartbeat = setInterval(() => { try { const now = new Date(); utimesSync(lockFile, now, now); } catch { /* released */ } }, 60_000);
      heartbeat.unref();
      let released = false;
      const release = () => {
        if (released) return;
        released = true; clearInterval(heartbeat);
        try { if (JSON.parse(readFileSync(lockFile, 'utf8')).pid === process.pid) unlinkSync(lockFile); } catch { /* already gone */ }
      };
      process.once('exit', release);
      return release;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let owner: { pid?: number; root?: string; since?: string } | undefined, age = 0, text: string | undefined;
    try { age = Date.now() - statSync(lockFile).mtimeMs; text = readFileSync(lockFile, 'utf8'); owner = JSON.parse(text); }
    catch { if (!existsSync(lockFile)) continue; /* being written: judge by age only */ }
    if (age > staleMs || (owner && !pidAlive(owner.pid))) {
      const outcome = breakStaleLock(lockFile, text);
      if (outcome === 'broken') console.error(`[capture] broke stale GPU lock ${lockFile} (pid ${owner?.pid ?? '?'}, age ${Math.round(age / 1000)} s)`);
      if (outcome === 'lost') console.error(`[capture] warning: renamed a fresh GPU lock while breaking a stale one and could not restore it (a newer lock exists)`);
      continue;
    }
    if (Date.now() > deadline) throw new Error(`GPU lock ${lockFile} is held by pid ${owner?.pid ?? '?'} (${owner?.root ?? '?'}) for more than ${Math.round(waitMs / 60000)} min`);
    if (!announced) { console.error(`[capture] waiting for the GPU lock ${lockFile} (held by pid ${owner?.pid ?? '?'} in ${owner?.root ?? '?'} since ${owner?.since ?? '?'})`); announced = true; }
    await sleep(1000);
  }
}

interface AdapterInfo { available: boolean; vendor?: string; architecture?: string; device?: string; description?: string; fallback?: boolean; features?: string[]; error?: string }
async function adapterInfo(context: BrowserContext, base: string): Promise<AdapterInfo> {
  const page = await context.newPage();
  const probeUrl = `${base}/__capture_gpu_probe`;
  // WebGPU needs a secure context; serve a blank page on the app origin without touching the app.
  await page.route(probeUrl, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>gpu</title>' }));
  try {
    await page.goto(probeUrl);
    return await page.evaluate(`(async () => {
      if (!navigator.gpu) return { available: false, error: 'navigator.gpu missing' };
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return { available: false, error: 'requestAdapter returned null' };
      const info = adapter.info ?? {};
      return { available: true, vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description,
        fallback: adapter.isFallbackAdapter ?? info.isFallbackAdapter ?? false, features: [...adapter.features].sort() };
    })()`) as AdapterInfo;
  } catch (error) { return { available: false, error: String(error) }; }
  finally { await page.close(); }
}

const WAIT_PRESETS: Record<string, { ready: string; fail?: string }> = {
  game: {
    ready: `(() => { const g = window.__tmtGame; return !!(g && g.ready); })()`,
    fail: `(() => { const l = document.querySelector('#loading.error'); return l ? (document.querySelector('#loading-title')?.textContent + ' ' + document.querySelector('#loading-copy')?.textContent) : ''; })()`,
  },
  effects: {
    ready: `(() => { const b = document.querySelector('#ignite'); return !!(b && !b.disabled && document.querySelector('canvas')); })()`,
    fail: `(() => { const s = document.querySelector('#status[data-error="true"]'); return s ? s.textContent : ''; })()`,
  },
  canvas: { ready: `(() => { const c = document.querySelector('canvas'); return !!(c && c.width > 0 && c.height > 0); })()` },
  load: { ready: `document.readyState === 'complete'` },
};
function resolveWait(wait: string | undefined, url: string): { ready: string; fail?: string; sleep?: number; label: string } {
  let spec = wait ?? 'auto';
  // The game is the root app: '/', '/?mode=drive', 'index.html' and the legacy 'play.html' redirect all wait for the game.
  const path = url.replace(/^https?:\/\/[^/]+/, '').split(/[?#]/)[0];
  if (spec === 'auto') spec = /(^\/?$)|(^\/?index\.html$)|play\.html/.test(path) ? 'game' : /effects\.html/.test(path) ? 'effects' : 'canvas';
  if (/^\d+$/.test(spec)) return { ready: 'true', sleep: Number(spec), label: `${spec}ms` };
  if (WAIT_PRESETS[spec]) return { ...WAIT_PRESETS[spec], label: spec };
  if (spec.startsWith('selector:')) return { ready: `!!document.querySelector(${JSON.stringify(spec.slice(9))})`, label: spec };
  if (spec.startsWith('js:')) return { ready: spec.slice(3), label: spec };
  throw new Error(`Unknown --wait condition: ${spec}`);
}

const DEFAULT_PROBE = `(() => {
  const out = {};
  const g = window.__tmtGame;
  if (g) {
    const { snapshot, ...rest } = g;
    out.game = { ...rest, tanks: snapshot?.tanks?.map(t => ({ position: t.position, velocity: t.velocity, heading: t.heading, health: t.health,
      turretYaw: t.turretYaw, barrelPitch: t.barrelPitch, loadout: t.loadout })) };
  }
  const text = {};
  for (const id of ['perf', 'terrain-perf', 'phase-tag', 'toast', 'status', 'metrics']) { const e = document.getElementById(id); if (e && e.textContent) text[id] = e.textContent; }
  out.text = text;
  return out;
})()`;
const GPU_PROBE = `(() => { try { const g = window.__tmtGame; if (g && g.performance && g.performance.gpu !== undefined) return g.performance.gpu;
  const s = window.__tmtEngineSandbox; const t = s && typeof s.telemetry === 'function' ? s.telemetry() : undefined; return t ? t.gpu : undefined; } catch (e) { return { error: String(e) }; } })()`;
/** Samples requestAnimationFrame deltas plus the page telemetry for n frames. */
const FRAMES_PROBE = `(async (n) => {
  const read = () => { try { const g = window.__tmtGame; if (g && g.performance) return g.performance;
    const s = window.__tmtEngineSandbox; if (s && typeof s.telemetry === 'function') return s.telemetry(); } catch (e) { return undefined; } return undefined; };
  const frame = () => new Promise(r => requestAnimationFrame(r));
  const dts = [], samples = [];
  let last = await frame();
  for (let i = 0; i < n; i++) { const t = await frame(); dts.push(t - last); last = t; samples.push(read()); }
  return { dts, samples };
})`;
const HIDE_UI_CSS = '.game-shell, .toast, .finish-card, .world-label, main.chrome, .dev-panel { visibility: hidden !important; }';

const sleep = (ms: number) => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const slug = (text: string) => text.replace(/^https?:\/\/[^/]+/, '').replace(/\.html/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'page';

async function poll(page: Page, expression: string, timeout: number, fail?: string): Promise<{ ok: boolean; reason?: string }> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (fail) { const failure = await page.evaluate(fail); if (failure) return { ok: false, reason: String(failure) }; }
      if (await page.evaluate(expression)) return { ok: true };
    } catch { /* The page may be navigating (e.g. Vite dependency re-optimization reloads); keep polling. */ }
    await sleep(250);
  }
  return { ok: false, reason: `timed out after ${timeout} ms` };
}

interface Stats { p50: number; p95: number; max: number; mean: number }
export interface FrameStats { count: number; frameMs: Stats; metrics: Record<string, Stats> }
export function stats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1], mean: sorted.reduce((sum, v) => sum + v, 0) / sorted.length };
}
/** Flatten numeric leaves (objects only, depth <= 4) into dotted keys. */
export function numericLeaves(value: unknown, prefix = '', out: Record<string, number> = {}, depth = 0): Record<string, number> {
  if (typeof value === 'number' && Number.isFinite(value)) { if (prefix) out[prefix] = value; }
  else if (value && typeof value === 'object' && !Array.isArray(value) && depth < 4)
    for (const [key, child] of Object.entries(value)) numericLeaves(child, prefix ? `${prefix}.${key}` : key, out, depth + 1);
  return out;
}
export function frameStats(dts: number[], samples: unknown[]): FrameStats | undefined {
  if (!dts.length) return undefined;
  const series = new Map<string, number[]>();
  for (const sample of samples) for (const [key, value] of Object.entries(numericLeaves(sample))) series.set(key, [...series.get(key) ?? [], value]);
  return { count: dts.length, frameMs: stats(dts), metrics: Object.fromEntries([...series].map(([key, values]) => [key, stats(values)])) };
}

export interface ShotRecord { label: string; file: string; tMs: number; probe?: unknown; gpu?: unknown; frames?: FrameStats }
export interface JobResult {
  name: string; url: string; ok: boolean; reason?: string; size: string; wait: string; adapter?: AdapterInfo; chrome?: string;
  timings: Record<string, number | undefined>; shots: ShotRecord[]; evals: { step: string; label?: string; result: unknown }[];
  console: { tMs: number; type: string; text: string; location?: string }[]; pageErrors: { tMs: number; message: string; stack?: string }[];
  failedRequests: { url: string; failure?: string }[]; httpErrors: { url: string; status: number }[];
  repeat?: number; repeats?: { count: number; mode: 'min' | 'first' };
}

/** Git Bash (MSYS) rewrites a leading-slash argument such as /effects.html into C:/Program Files/Git/effects.html. */
function repairMsysPath(url: string): string {
  const mangled = /^[A-Za-z]:[\\/](?:.*[\\/])?Git[\\/](.*)$/i.exec(url);
  if (!mangled) return url;
  console.error(`[capture] repaired MSYS-rewritten URL ${url} -> /${mangled[1]} (set MSYS_NO_PATHCONV=1 or omit the leading slash)`);
  return `/${mangled[1].replace(/\\/g, '/')}`;
}

async function runJob(browser: Browser, job: Job, options: Options, base: string, adapter: { value?: AdapterInfo }, usedNames: Set<string>, repeat = 1): Promise<JobResult> {
  job = { ...job, url: repairMsysPath(job.url) };
  const url = /^https?:/.test(job.url) ? job.url : `${base}${job.url.startsWith('/') ? '' : '/'}${job.url}`;
  let name = slug(job.name ?? job.url);
  for (let i = 2; usedNames.has(name); i++) name = `${slug(job.name ?? job.url)}-${i}`;
  usedNames.add(name);
  const [width, height] = (job.size ?? '1280x720').split('x').map(Number);
  if (!width || !height) throw new Error(`Bad --size ${job.size}; use WxH`);
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: job.dpr ?? 1, ...(job.touch ? { hasTouch: true, isMobile: true } : {}) });
  // Let captures verify the real favicon; only suppress requests in legacy checkouts without one.
  if (!existsSync(join(root, 'public/favicon.ico'))) await context.route(/\/favicon\.ico(\?|$)/, route => route.fulfill({ status: 204, body: '' }));
  adapter.value ??= await adapterInfo(context, new URL(url).origin);
  const page = await context.newPage();
  const started = Date.now();
  await page.bringToFront();
  const t = () => Date.now() - started;
  const result: JobResult = { name, url, ok: false, size: `${width}x${height}`, wait: '', adapter: adapter.value, chrome: browser.version(), timings: {}, shots: [], evals: [],
    console: [], pageErrors: [], failedRequests: [], httpErrors: [], ...(options.repeat > 1 ? { repeat } : {}) };
  page.on('console', message => {
    const location = message.location();
    result.console.push({ tMs: t(), type: message.type(), text: message.text().slice(0, 8000), location: location.url ? `${location.url.replace(base, '')}:${location.lineNumber}` : undefined });
  });
  page.on('pageerror', error => result.pageErrors.push({ tMs: t(), message: error.message, stack: error.stack?.slice(0, 4000) }));
  page.on('requestfailed', request => result.failedRequests.push({ url: request.url().replace(base, ''), failure: request.failure()?.errorText }));
  page.on('response', response => { if (response.status() >= 400) result.httpErrors.push({ url: response.url().replace(base, ''), status: response.status() }); });

  const outDir = options.out;
  mkdirSync(outDir, { recursive: true });
  const labels = new Set<string>();
  const probe = job.probe ?? DEFAULT_PROBE;
  const frames = job.frames;
  const shot = async (label: string) => {
    let unique = slug(label);
    for (let i = 2; labels.has(unique); i++) unique = `${slug(label)}-${i}`;
    labels.add(unique);
    const file = join(outDir, `${name}-${unique}.png`);
    const tMs = t();
    await page.screenshot({ path: file, type: 'png', timeout: 60000 });
    let probed: unknown;
    try { probed = await page.evaluate(probe); } catch (error) { probed = { error: String(error) }; }
    const record: ShotRecord = { label: unique, file: relative(root, file).replace(/\\/g, '/'), tMs, probe: probed };
    if (options.gpuTimings) { try { record.gpu = await page.evaluate(GPU_PROBE); } catch (error) { record.gpu = { error: String(error) }; } }
    if (frames) {
      try {
        const sampled = await page.evaluate(`${FRAMES_PROBE}(${frames})`) as { dts: number[]; samples: unknown[] };
        record.frames = frameStats(sampled.dts, sampled.samples);
      } catch (error) { console.error(`[capture] frame sampling failed on ${name}-${unique}: ${String(error)}`); }
    }
    result.shots.push(record);
  };

  const wait = resolveWait(job.wait, url);
  const waitReady = async (): Promise<{ ok: boolean; reason?: string }> => {
    if (job.css || job.hideUi) await page.addStyleTag({ content: `${job.hideUi ? HIDE_UI_CSS : ''}\n${job.css ?? ''}` });
    if (wait.sleep) await sleep(wait.sleep);
    const ready = await poll(page, wait.ready, job.timeout ?? 180000, wait.fail);
    // Styles injected before a Vite reload are lost; re-apply once the page is ready.
    if (ready.ok && (job.css || job.hideUi)) await page.addStyleTag({ content: `${job.hideUi ? HIDE_UI_CSS : ''}\n${job.css ?? ''}` });
    return ready;
  };
  try {
    result.wait = wait.label;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    result.timings.domContentLoadedMs = t();
    const ready = await waitReady();
    result.timings.readyMs = t();
    try { result.timings.readyPageMs = Math.round(await page.evaluate('performance.now()') as number); } catch { /* optional */ }
    if (!ready.ok) {
      result.reason = ready.reason;
      await shot('not-ready').catch(() => undefined);
      return result;
    }
    const settle = job.settle ?? 2500;
    await sleep(settle);
    result.timings.settleMs = settle;

    const steps = (Array.isArray(job.keys) ? job.keys : (job.keys ?? 'shot:ready').split(',')).map(step => step.trim()).filter(Boolean);
    if (!job.shots && !steps.some(step => step === 'shot' || step.startsWith('shot:'))) steps.push('shot:final');
    for (let i = 1; i <= (job.shots ?? 0); i++) { if (i > 1 || steps.length) steps.push(`wait:${job.interval ?? 1000}`); steps.push(`shot:shot-${String(i).padStart(2, '0')}`); }
    const fraction = (value: string, span: number) => { const n = Number(value); return n <= 1 ? n * span : n; };
    const touch = await touchDriver(context, page, job.touch === true);
    const stepsStarted = t();
    let reloads = 0;
    for (const step of steps) {
      const [head, ...rest] = step.split(':');
      const [kind, stepLabel] = head.split('@');
      const arg = rest.join(':');
      if (/^\d+$/.test(kind)) await sleep(Number(kind));
      else if (kind === 'shot') await shot(arg || `shot-${result.shots.length + 1}`);
      else if (kind === 'wait') await sleep(Number(arg));
      else if (kind === 'press') await page.keyboard.press(arg);
      else if (kind === 'down') await page.keyboard.down(arg);
      else if (kind === 'up') await page.keyboard.up(arg);
      else if (kind === 'hold') {
        const [keys, ms] = [rest.slice(0, -1).join(':'), Number(rest.at(-1))];
        const list = keys.split('+');
        for (const key of list) await page.keyboard.down(key);
        await sleep(ms);
        for (const key of list.reverse()) await page.keyboard.up(key);
      } else if (kind === 'click') await page.click(arg, { timeout: 10000 });
      else if (kind === 'hover') await page.hover(arg, { timeout: 10000 });
      else if (kind === 'move') await page.mouse.move(fraction(rest[0], width), fraction(rest[1], height));
      else if (kind === 'drag') {
        const [x1, y1, x2, y2, count] = rest;
        await page.mouse.move(fraction(x1, width), fraction(y1, height));
        await page.mouse.down();
        await page.mouse.move(fraction(x2, width), fraction(y2, height), { steps: Number(count ?? 20) });
        await page.mouse.up();
      } else if (kind === 'wheel') {
        await page.mouse.move(width / 2, height / 2);
        for (let i = 0; i < Number(rest[1] ?? 1); i++) { await page.mouse.wheel(0, Number(rest[0])); await sleep(50); }
      }
      else if (kind === 'tap' || kind === 'swipe' || kind === 'pinch' || kind === 'stick') await touch(kind, rest, width, height, fraction);
      else if (kind === 'waitfor') { const waited = await poll(page, arg, job.timeout ?? 180000); if (!waited.ok) throw new Error(`waitfor ${arg}: ${waited.reason}`); }
      else if (kind === 'eval') result.evals.push({ step, ...(stepLabel ? { label: stepLabel } : {}), result: await page.evaluate(arg) });
      else if (kind === 'reload') {
        // Same context: IndexedDB, HTTP cache and service state survive, so this measures a cached startup.
        const key = `reload${++reloads > 1 ? reloads : ''}`;
        const reloadStarted = t();
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        const again = await waitReady();
        result.timings[`${key}ReadyMs`] = t() - reloadStarted;
        try { result.timings[`${key}PageMs`] = Math.round(await page.evaluate('performance.now()') as number); } catch { /* optional */ }
        if (!again.ok) throw new Error(`${step}: page not ready again: ${again.reason}`);
      }
      else throw new Error(`Unknown step "${step}"`);
    }
    result.timings.stepsMs = t() - stepsStarted;
    result.ok = true;
  } catch (error) {
    result.reason = error instanceof Error ? error.message : String(error);
    await shot('error').catch(() => undefined);
  } finally {
    writeFileSync(join(outDir, `${name}${repeat > 1 ? `.r${repeat}` : ''}.json`), JSON.stringify(result, null, 2));
    await context.close();
  }
  return result;
}

// ---- touch -------------------------------------------------------------------------------------------------------
type TouchPoint = { x: number; y: number; id: number };
/** Touch steps through CDP Input.dispatchTouchEvent: real touch points (pointerType 'touch'), several at once. */
async function touchDriver(context: BrowserContext, page: Page, enabled: boolean) {
  let cdp: Awaited<ReturnType<BrowserContext['newCDPSession']>> | undefined;
  const send = async (type: 'touchStart' | 'touchMove' | 'touchEnd', touchPoints: TouchPoint[]) => {
    cdp ??= await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  };
  const centre = async (selector: string) => {
    const box = await page.locator(selector).first().boundingBox({ timeout: 10000 });
    if (!box) throw new Error(`touch target not visible: ${selector}`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const glide = async (from: TouchPoint, to: { x: number; y: number }, steps: number, others: TouchPoint[] = []) => {
    for (let i = 1; i <= steps; i++) {
      await send('touchMove', [...others, { id: from.id, x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps }]);
      await sleep(16);
    }
  };
  return async (kind: string, rest: string[], width: number, height: number, fraction: (value: string, span: number) => number) => {
    if (!enabled) throw new Error(`${kind}: touch steps need --touch`);
    if (kind === 'tap') {
      const numeric = rest.length === 2 && rest.every(v => v.trim() !== '' && Number.isFinite(Number(v)));
      const at = numeric ? { x: fraction(rest[0], width), y: fraction(rest[1], height) } : await centre(rest.join(':'));
      await send('touchStart', [{ ...at, id: 1 }]); await sleep(60); await send('touchEnd', []);
    } else if (kind === 'swipe') {
      const [x1, y1, x2, y2, count, hold] = rest;
      const start = { x: fraction(x1, width), y: fraction(y1, height), id: 1 };
      await send('touchStart', [start]);
      await glide(start, { x: fraction(x2, width), y: fraction(y2, height) }, Number(count ?? 20));
      if (hold) await sleep(Number(hold));
      await send('touchEnd', []);
    } else if (kind === 'pinch') {
      const [cx, cy, from, to, count] = rest, x = fraction(cx, width), y = fraction(cy, height), steps = Number(count ?? 20);
      const at = (d: number): TouchPoint[] => [{ x: x - d / 2, y, id: 1 }, { x: x + d / 2, y, id: 2 }];
      await send('touchStart', at(Number(from)));
      for (let i = 1; i <= steps; i++) { await send('touchMove', at(Number(from) + (Number(to) - Number(from)) * i / steps)); await sleep(16); }
      await send('touchEnd', []);
    } else {
      const [x, y, dx, dy, ms, selector] = rest;
      const start = { x: fraction(x, width), y: fraction(y, height), id: 1 }, held = { id: 1, x: start.x + Number(dx), y: start.y + Number(dy) };
      await send('touchStart', [start]);
      await glide(start, held, 8);
      const begun = Date.now();
      if (selector) {
        await sleep(Math.max(0, Number(ms) / 2 - 100));
        const second = { ...await centre(selector), id: 2 };
        // CDP touchEnd lists the points to release, so lift only the button finger and keep driving.
        await send('touchStart', [held, second]); await sleep(80); await send('touchEnd', [second]);
      }
      // Keep the thumb alive with small moves (a real thumb is never perfectly still).
      for (let i = 0; Date.now() - begun < Number(ms); i++) { await send('touchMove', [{ ...held, x: held.x + (i % 2) * 0.5 }]); await sleep(100); }
      await send('touchEnd', []);
    }
  };
}

// ---- repeats and the run document --------------------------------------------------------------------------------
const PREFER_MAX = /fps|hz/i;
/** Best of n: numeric leaves take the minimum (the maximum when the dotted key path mentions fps/hz); everything else comes from the first run. */
export function bestOf(values: unknown[], key = ''): unknown {
  const present = values.filter(v => v !== undefined && v !== null);
  const first = present[0] ?? values[0];
  if (typeof first === 'number') {
    const numbers = present.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    return numbers.length ? (PREFER_MAX.test(key) ? Math.max(...numbers) : Math.min(...numbers)) : first;
  }
  if (Array.isArray(first) || !first || typeof first !== 'object') return first;
  const out: Record<string, unknown> = {};
  for (const child of Object.keys(first))
    out[child] = bestOf(present.map(v => typeof v === 'object' ? (v as Record<string, unknown>)[child] : undefined), key ? `${key}.${child}` : child);
  return out;
}
export function mergeRepeats(runs: JobResult[]): JobResult {
  const [first] = runs;
  const shots = first.shots.map(shot => {
    const same = runs.map(run => run.shots.find(s => s.label === shot.label)).filter((s): s is ShotRecord => !!s);
    const last = same[same.length - 1];
    return { ...shot, file: last.file, probe: bestOf(same.map(s => s.probe)), gpu: shot.gpu === undefined ? undefined : bestOf(same.map(s => s.gpu)),
      frames: shot.frames && bestOf(same.map(s => s.frames)) as FrameStats };
  });
  // eval@ results merge per step (the same job runs the same steps in order): terrain and drive budgets read them.
  const evals = first.evals.map((entry, index) => ({ ...entry,
    result: bestOf(runs.map(run => run.evals[index]).filter(other => other && other.step === entry.step).map(other => other.result)) }));
  return { ...first, ok: runs.every(run => run.ok), reason: runs.find(run => run.reason)?.reason, timings: bestOf(runs.map(run => run.timings)) as JobResult['timings'], shots,
    evals, repeat: undefined, repeats: { count: runs.length, mode: 'min' } };
}

function telemetryOf(probe: unknown): unknown {
  if (typeof probe === 'string') { try { return JSON.parse(probe); } catch { return probe; } }
  if (probe && typeof probe === 'object' && 'game' in probe) return (probe as { game: unknown }).game;
  return probe;
}
/** The document scripts/check-capture.ts evaluates: jobs by name and shots by "<job>-<label>" (the PNG basename). */
function captureDocument(results: JobResult[], options: Options, meta: Record<string, unknown>): Record<string, unknown> {
  const jobs: Record<string, unknown> = {}, shots: Record<string, unknown> = {};
  for (const r of results) {
    jobs[r.name] = { ok: r.ok, reason: r.reason, url: r.url.replace(/^https?:\/\/[^/]+/, ''), size: r.size, wait: r.wait, timings: r.timings,
      consoleErrors: r.console.filter(m => m.type === 'error').length, consoleWarnings: r.console.filter(m => m.type === 'warning').length,
      pageErrors: r.pageErrors.length, httpErrors: r.httpErrors.length, failedRequests: r.failedRequests.length, evals: r.evals,
      shots: r.shots.map(s => s.label), log: relative(root, join(options.out, `${r.name}.json`)).replace(/\\/g, '/'), repeats: r.repeats };
    for (const s of r.shots) {
      const probe = s.probe as { text?: unknown } | undefined;
      shots[`${r.name}-${s.label}`] = { job: r.name, label: s.label, file: s.file, tMs: s.tMs, telemetry: telemetryOf(s.probe),
        ...(probe && typeof probe === 'object' && 'text' in probe ? { text: probe.text } : {}), gpu: s.gpu, frames: s.frames };
    }
  }
  return { kind: 'tmt-capture', version: 1, run: options.run, plan: options.planFile && relative(root, options.planFile).replace(/\\/g, '/'),
    budget: options.budget, createdAt: new Date().toISOString(), repeat: options.repeat, min: options.min, ...meta, jobs, shots };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  let vite: ViteDevServer | undefined;
  let browser: Browser | undefined;
  let releaseLock: (() => void) | undefined;
  const cleanup = async () => { await browser?.close().catch(() => undefined); await vite?.close().catch(() => undefined); releaseLock?.(); };
  process.once('SIGINT', () => { void cleanup().then(() => process.exit(130)); });
  try {
    if (options.perf && !options.gpuOnly) releaseLock = await acquireGpuLock();
    browser = await launch(options);
    if (options.gpuOnly) {
      const context = await browser.newContext();
      console.log(JSON.stringify({ chrome: browser.version(), headless: !options.headed, adapter: await adapterInfo(context, 'http://127.0.0.1:9') }, null, 2));
      return;
    }
    let base = options.base;
    const serverStarted = Date.now();
    if (!base) { const started = await startVite(); vite = started.server; base = started.base; }
    const serverMs = Date.now() - serverStarted;
    const adapter: { value?: AdapterInfo } = {};
    const runs: JobResult[][] = [];
    for (let repeat = 1; repeat <= options.repeat; repeat++) {
      const usedNames = new Set<string>();
      const results: JobResult[] = [];
      for (const job of options.jobs) {
        const result = await runJob(browser, job, options, base, adapter, usedNames, repeat);
        results.push(result);
        console.error(`[capture] ${result.ok ? 'ok  ' : 'FAIL'} ${result.name}${options.repeat > 1 ? ` (run ${repeat}/${options.repeat})` : ''} ready=${result.timings.readyMs ?? '?'}ms shots=${result.shots.length}` +
          ` pageErrors=${result.pageErrors.length} consoleErrors=${result.console.filter(m => m.type === 'error').length}${result.reason ? ` reason=${result.reason}` : ''}`);
      }
      runs.push(results);
    }
    let results = runs[0];
    if (options.repeat > 1 && options.min) {
      results = results.map((result, index) => mergeRepeats(runs.map(run => run[index])));
      for (const merged of results) writeFileSync(join(options.out, `${merged.name}.json`), JSON.stringify(merged, null, 2));
    } else if (options.repeat > 1) results = results.map(result => ({ ...result, repeats: { count: options.repeat, mode: 'first' as const } }));
    const allResults = runs.flat();
    const hardware = !!adapter.value?.available && !adapter.value.fallback;
    const meta = { base, chrome: browser.version(), headless: !options.headed, adapter: adapter.value && { ...adapter.value, features: undefined }, hardwareAdapter: hardware,
      gpuTimings: options.gpuTimings, perfLock: options.perf, out: relative(root, options.out).replace(/\\/g, '/') };
    const documentFile = join(options.out, `${options.run}.capture.json`);
    const document = captureDocument(results, options, meta);
    writeFileSync(documentFile, JSON.stringify(document, null, 2));
    let budget: { file: string; failed: boolean; counts: Record<string, number> } | undefined;
    if (options.budget) {
      const checks = evaluateBudget(document, loadBudget(resolve(root, options.budget)));
      console.error(`[capture] budget ${options.budget}\n${formatTable(checks)}`);
      budget = { file: options.budget, failed: budgetFailed(checks), counts: checks.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.status]: (acc[c.status] ?? 0) + 1 }), {}) };
    }
    console.log(JSON.stringify({
      base, serverStartMs: vite ? serverMs : undefined, chrome: browser.version(), headless: !options.headed, adapter: adapter.value && { ...adapter.value, features: undefined }, hardwareAdapter: hardware,
      out: relative(root, options.out).replace(/\\/g, '/'), capture: relative(root, documentFile).replace(/\\/g, '/'), budget,
      jobs: results.map(r => ({ name: r.name, ok: r.ok, reason: r.reason, timings: r.timings, shots: r.shots.map(s => s.file), log: relative(root, join(options.out, `${r.name}.json`)).replace(/\\/g, '/'),
        pageErrors: r.pageErrors.map(e => e.message), consoleErrors: r.console.filter(m => m.type === 'error').map(m => m.text.slice(0, 300)),
        consoleWarnings: r.console.filter(m => m.type === 'warning').length, repeats: r.repeats })),
    }, null, 2));
    if (!hardware) console.error('[capture] WARNING: no hardware WebGPU adapter; try --headed');
    const failed = allResults.some(r => !r.ok) || options.strict && allResults.some(r => r.pageErrors.length || r.console.some(m => m.type === 'error')) || !!budget?.failed;
    process.exitCode = failed ? 1 : 0;
  } finally { await cleanup(); }
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main().catch(error => { console.error(error); process.exit(1); });
}
