/** Real Chromium/WebGPU UI integration evidence, isolated profile. Not a performance benchmark.
 * node --import tsx scripts/verify-startup-ui.ts
 * Optional --base URL (existing dev server), --out DIR, --seed N, --summary FILE.
 * --summarize-only verification.json --summary FILE compacts existing evidence without launching a browser.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import { defaultProfile, PROFILE_KEY } from '../src/game/meta/profile';

const args = process.argv.slice(2), arg = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const root = resolve('.'), out = resolve(arg('--out') ?? 'artifacts/startup-ui'), seed = Number(arg('--seed') ?? 7);
function saveSummary(report: any, source: string) {
  const destination = arg('--summary'); if (!destination) return;
  const music = (m: any) => m && ({ scene: m.scene, arrangement: m.arrangement, step: m.step, notes: m.notes, voices: m.voices, transitions: m.transitions, muted: m.muted });
  const state = (d: any) => ({ ready: d.ready, screen: d.ui?.screen, seed: d.terrain?.seed, kind: d.resident?.kind, terrainVersion: d.terrainVersion, tick: d.tick, historyLength: d.resident?.history?.length, lifecycle: d.lifecycle,
    gpu: d.performance && { validationErrors: d.performance.validationErrors, compileErrors: d.performance.compileErrors, planetPipeline: d.performance.planetPipeline, liquidReady: d.performance.visuals?.liquidReady },
    audio: d.audio && { state: d.audio.state, scene: d.audio.scene, music: music(d.audio.music), soundscape: d.audio.soundscape, lastError: d.audio.lastError } });
  const detail = (d: any): unknown => d.performance ? state(d) : d.restored ? { tick: d.tick, hash: d.hash, kind: d.kind, restored: state(d.restored) } : d.workshop ? { workshop: d.workshop, motion: d.motion, audio: state(d).audio } : d.muted ? { muted: music(d.muted), effectsMuted: music(d.effectsMuted), volumes: d.volumes, masterMuted: music(d.masterMuted) } : d.hidden ? { hidden: music(d.hidden), resumed: music(d.resumed) } : d;
  const artifactRoot = relative(root, dirname(source)).replaceAll('\\', '/');
  const compact = { format: 'tmt-startup-ui-v1', capturedAt: report.capturedAt, seed: report.seed, measurement: report.measurement, passed: report.checks.length, errors: report.errors,
    methods: { startupFailure: 'Injected once after real terrain initialization; checks allocated-world cleanup and recovery.', cancellation: 'Initialize promise gate on a real allocated terrain; the second canceled request is released after its replacement starts.', shot: 'Actual HUD elevation/power inputs and Fire button, then terrain version/history and audio event assertions.', checkpoint: 'Session save/restore API after that shot; restore verifies the command replay hash.', visibility: 'Synthetic visibilitychange with a temporary document.hidden override.', limits: 'Functional desktop checks; no performance, physical phone, audio listening, or fluid gameplay-coupling claim.' },
    checks: report.checks.map((c: any) => ({ name: c.name, detail: detail(c.detail) })), warnings: [...new Set(report.warnings)], raw: `${artifactRoot}/verification.json`, checkpoint: `${artifactRoot}/checkpoint-after-shot.json`, screenshots: report.screenshots.map((s: string) => `${artifactRoot}/${s}`) };
  mkdirSync(dirname(resolve(destination)), { recursive: true }); writeFileSync(destination, JSON.stringify(compact, null, 2) + '\n');
}
if (arg('--summarize-only')) { const source = resolve(arg('--summarize-only')!); saveSummary(JSON.parse(readFileSync(source, 'utf8')), source); process.exit(0); }
mkdirSync(out, { recursive: true });
const checks: { name: string; detail?: unknown }[] = [], screenshots: string[] = [], errors: { kind: string; message: string }[] = [], warnings: string[] = [];
let browser: Browser | undefined, context: BrowserContext | undefined, server: ViteDevServer | undefined, page: Page;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const record = (name: string, detail?: unknown) => { checks.push({ name, detail }); console.log(`[startup-ui] PASS ${name}`); };
const shot = async (name: string) => { await page.screenshot({ path: join(out, `${name}.png`), timeout: 60000 }); screenshots.push(`${name}.png`); };
const telemetry = () => page.evaluate<any>(`(()=>{const g=window.__tmtGame;return {ready:g.ready,ui:g.ui,terrain:g.terrain,startup:g.startup,phase:g.phase,tick:g.tick,terrainVersion:g.terrainVersion,audio:g.audio,
  resident:g.resident?{kind:g.resident.kind,profile:g.resident.profile,epoch:g.resident.epoch,failure:g.resident.failure,oracle:g.resident.oracle,history:g.resident.history.map(h=>({epoch:h.epoch,cut:h.cut,metrics:h.metrics}))}:null,
  performance:{validationErrors:g.performance.validationErrors,compileErrors:g.performance.compileErrors,planetPipeline:g.performance.planetPipeline,renderer:g.performance.renderer,visuals:g.performance.visuals},
  snapshot:g.snapshot?{tick:g.snapshot.tick,phase:g.snapshot.phase,tanks:g.snapshot.tanks.map(t=>({position:t.position,health:t.health,kit:t.kit})),projectiles:g.snapshot.projectiles.length}:null,lifecycle:window.__startupLifecycle};})()`);
const audio = () => page.evaluate<any>('window.__tmtGame.audio');
const waitScreen = (screen: string) => page.waitForFunction(screen => (window as any).__tmtGame?.ui?.screen === screen, screen, { timeout: 180000 });
async function range(selector: string, value: number) { await page.locator(selector).evaluate((element, value) => { (element as HTMLInputElement).value = String(value); element.dispatchEvent(new Event('input', { bubbles: true })); }, value); }
async function choose(kind: string, value = seed) {
  await page.locator('#skirmish-seed').fill(String(value)); await page.locator('#skirmish-seed').press('Tab');
  await page.locator('#skirmish-planet').selectOption(kind);
  await page.locator('#skirmish-opponents [data-value="local"]').click();
  for (const id of ['rule-fog', 'rule-friendlyFire']) if (await page.locator(`#${id}`).isChecked()) await page.locator(`label:has(#${id})`).click();
}
async function start(kind: string, value = seed, afterClick?: () => Promise<void>) {
  const before = await audio(); await choose(kind, value); await page.locator('#skirmish-start').click();
  await afterClick?.();
  await page.waitForFunction(`window.__tmtGame?.ready && window.__tmtGame.ui.screen==='match'`, undefined, { timeout: 180000 });
  await page.waitForFunction(`window.__tmtGame.performance.planetPipeline==='ready' && window.__tmtGame.performance.visuals.liquidReady`, undefined, { timeout: 90000 });
  await page.waitForFunction(kind => (window as any).__tmtGame.audio.music.arrangement === kind, kind, { timeout: 15000 });
  const current = await telemetry(), setup = await page.evaluate<any>(`import('/src/game/api/session.ts').then(m=>m.session().setup)`);
  assert.equal(setup.seed, value); assert.equal(setup.planet.kind, kind); assert.equal(current.terrain.planetKind, kind); assert.equal(current.resident.kind, kind); assert.equal(current.audio.soundscape.world, kind);
  assert.equal(current.performance.validationErrors, 0); assert.equal(current.performance.compileErrors, 0); assert.ok(current.audio.music.step > before.music.step); assert.equal(current.audio.lastError, null); assert.ok(current.audio.music.voices <= 16);
  assert.equal(current.lifecycle.created - current.lifecycle.disposed, 1); return current;
}
async function menu() {
  await page.locator('#pause-open').click(); await page.locator('#pause-forfeit').click(); await waitScreen('results'); await page.locator('#results-menu').click(); await waitScreen('title'); await sleep(250);
  const value = await telemetry(); assert.equal(value.ready, false); assert.equal(value.resident, null); assert.equal(value.lifecycle.created, value.lifecycle.disposed); return value;
}

try {
  let base = arg('--base');
  if (!base) { server = await createServer({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn', cacheDir: join(root, '.vite-capture/startup-ui'), server: { host: '127.0.0.1', port: 0, hmr: false, watch: null, open: false } }); await server.listen(); base = server.resolvedUrls!.local[0]; }
  const store = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  const executablePath = process.env.TMT_CHROME ?? readdirSync(store).filter(n => /^chromium-\d+$/.test(n)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])).map(n => join(store, n, 'chrome-win64/chrome.exe')).find(existsSync);
  assert.ok(executablePath, 'Installed Chromium required');
  browser = await chromium.launch({ executablePath, headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-webgpu-developer-features', '--enable-precise-memory-info', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
  context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const profile = defaultProfile(); profile.loadouts[0].kit = { hull: 'skiff', runningGear: 'scout', turret: 'dome', weapon: 'mortar', utility: 'antenna' }; profile.settings.gameplay.cinematics = false;
  await context.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: PROFILE_KEY, value: JSON.stringify(profile) });
  await context.route('**/favicon.ico', route => route.fulfill({ status: 204, body: '' })); page = await context.newPage();
  page.on('pageerror', error => errors.push({ kind: 'pageerror', message: String(error) }));
  page.on('console', message => { if (message.type() === 'error') errors.push({ kind: 'console', message: message.text() }); else if (message.type() === 'warning') warnings.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) errors.push({ kind: 'http', message: `${response.status()} ${response.url()}` }); });
  await page.goto(`${base.replace(/\/$/, '')}/play.html`, { waitUntil: 'domcontentloaded' }); await waitScreen('title');
  assert.equal((await audio()).state, 'locked');
  // Observe ownership, and expose controlled failure/gate points only in this isolated test page.
  await page.evaluate(`(async()=>{const {ResidentGameTerrain}=await import('/src/game/resident-terrain.ts');const create=ResidentGameTerrain.create,initialize=ResidentGameTerrain.prototype.initialize,dispose=ResidentGameTerrain.prototype.dispose;const disposed=new WeakSet();
    window.__startupLifecycle={created:0,disposed:0,initialized:0,failOnce:false,gateEntered:false};
    ResidentGameTerrain.create=async function(...args){const world=await create.apply(this,args);window.__startupLifecycle.created++;return world;};
    ResidentGameTerrain.prototype.dispose=function(){if(!disposed.has(this)){disposed.add(this);window.__startupLifecycle.disposed++;}return dispose.call(this);};
    ResidentGameTerrain.prototype.initialize=async function(){const l=window.__startupLifecycle;l.initialized++;if(window.__startupGate){const gate=window.__startupGate;window.__startupGate=null;l.gateEntered=true;await gate;}const result=await initialize.call(this);if(l.failOnce){l.failOnce=false;throw new Error('Injected verification failure after terrain initialization');}return result;};
  })()`);
  await page.locator('#title-workshop').click(); await page.waitForFunction(`window.__tmtWorkshop?.ready && !document.querySelector('.ws-loading')`, undefined, { timeout: 180000 });
  await page.waitForFunction('window.__tmtGame.audio.music.notes>8');
  const workshop = await page.evaluate<any>('window.__tmtWorkshop.snapshot()'), workshopAudio = await audio(); assert.equal(workshop.audio.musicOwner, 'application'); assert.equal(workshop.audio.musicNotes, 0); assert.equal(workshopAudio.state, 'running'); assert.equal(workshopAudio.workshopSuppressed, false);
  await shot('01-workshop-shared-music');
  const lift = await page.locator('#workshop-lift-up').boundingBox(); assert.ok(lift); await page.mouse.move(lift.x + lift.width / 2, lift.y + lift.height / 2); await page.mouse.down(); await sleep(450); const motion = await page.evaluate<any>('window.__tmtWorkshop.snapshot().audio.motion'); await page.mouse.up(); assert.ok(motion.lift > .1);
  await page.locator('#workshop-back').click(); await waitScreen('title'); await page.locator('#title-skirmish').click(); await waitScreen('skirmish'); assert.ok((await audio()).music.step > workshopAudio.music.step); record('workshop machinery and shared music survive workshop to setup', { workshop: workshop.audio, motion, audio: await audio() });

  await choose('temperate'); await page.evaluate('window.__startupLifecycle.failOnce=true'); await page.locator('#skirmish-start').click();
  await page.locator('#skirmish-error').waitFor({ state: 'visible', timeout: 180000 }); const failed = await telemetry(); assert.equal(failed.ready, false); assert.equal(failed.resident, null); assert.equal(failed.lifecycle.created, failed.lifecycle.disposed); assert.equal(await page.locator('#skirmish-seed').inputValue(), String(seed));
  await shot('02-recoverable-initialization-failure'); record('injected late initialization failure unwinds resources and preserves setup', failed);
  const temperate = await start('temperate'); await shot('03-temperate-same-seed'); record('retry starts identical seed with selected temperate world', temperate);

  const beforeShot = temperate.terrainVersion; await range('#elevation', 55); await range('#power', 25); await page.locator('#fire').click();
  await page.waitForFunction(version => (window as any).__tmtGame.terrainVersion > version, beforeShot, { timeout: 90000 });
  await page.waitForFunction(`!window.__tmtGame.stall && window.__tmtGame.snapshot.projectiles.length===0`, undefined, { timeout: 90000 });
  const destroyed = await telemetry(); assert.ok(destroyed.resident.history.length > 1); assert.ok((destroyed.audio.events.impact ?? 0) > 0); assert.ok((destroyed.audio.events['terrain-commit'] ?? 0) > 0); assert.equal(destroyed.resident.failure, null); await shot('04-real-shot-terrain-destruction'); record('real HUD shot commits terrain destruction and gameplay sound', destroyed);
  await page.locator('#pause-open').click(); await waitScreen('pause');
  const checkpoint = await page.evaluate<any>(`import('/src/game/api/session.ts').then(async m=>{window.__savedStartupCheckpoint=await m.session().saveCheckpoint();return window.__savedStartupCheckpoint;})`);
  writeFileSync(join(out, 'checkpoint-after-shot.json'), JSON.stringify(checkpoint)); assert.equal(checkpoint.terrain.kind, 'temperate');
  await page.evaluate(`import('/src/game/api/session.ts').then(async m=>{const s=m.session();await s.restoreCheckpoint(window.__savedStartupCheckpoint);s.setPaused(true);})`);
  const restored = await telemetry(); assert.equal(restored.ready, true); assert.equal(restored.snapshot.tick, checkpoint.tick); assert.equal(restored.resident.kind, 'temperate'); assert.equal(restored.terrain.planetKind, 'temperate'); record('checkpoint restore verifies replay after real destruction and preserves kind', { tick: checkpoint.tick, hash: checkpoint.hash, kind: checkpoint.terrain.kind, restored });
  await page.locator('#pause-resume').click();

  await page.locator('#pause-open').click(); await page.locator('#pause-settings').click(); await page.getByRole('tab', { name: 'Audio', exact: true }).click(); await range('#set-music', 0); await sleep(450); const muted = await audio(); await sleep(500); assert.equal((await audio()).music.notes, muted.music.notes);
  await range('#set-sfx', 0); await range('#set-music', .6); await sleep(500); const effectsMuted = await audio(); assert.ok(effectsMuted.music.notes > muted.music.notes); assert.equal(effectsMuted.volumes.sfx, 0); assert.equal(effectsMuted.music.scene, 'pause');
  await range('#set-master', 0); await sleep(450); const masterMuted = await audio(); await sleep(350); assert.equal((await audio()).music.notes, masterMuted.music.notes); await range('#set-master', .8); await range('#set-sfx', .9);
  await shot('05-audio-settings-during-pause'); await page.locator('#settings-back').click(); await page.locator('#pause-resume').click(); record('real settings controls isolate music effects master and pause mix', { muted: muted.music, effectsMuted: effectsMuted.music, volumes: effectsMuted.volumes, masterMuted: masterMuted.music });
  await page.evaluate(`Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));`); await sleep(200); const hidden = await audio(); assert.equal(hidden.state, 'suspended'); await sleep(300); assert.equal((await audio()).music.notes, hidden.music.notes);
  await page.evaluate(`delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));`); await sleep(450); assert.equal((await audio()).state, 'running'); record('hidden tab suspension resumes existing score', { hidden: hidden.music, resumed: (await audio()).music });
  const preRestart = await audio(); await page.locator('#pause-open').click(); await page.locator('#pause-restart').click(); await page.waitForFunction(`window.__tmtGame.ready && window.__tmtGame.ui.screen==='match'`, undefined, { timeout: 180000 });
  assert.ok((await audio()).music.step >= preRestart.music.step); assert.equal((await telemetry()).lifecycle.created - (await telemetry()).lifecycle.disposed, 1); record('repeated match start preserves score and leaves one live terrain', await telemetry()); await menu();

  for (const kind of ['glacial', 'dune', 'volcanic']) { await page.locator('#title-skirmish').click(); const result = await start(kind); await shot(`${kind}-same-seed`); record(`same seed honors selected ${kind} terrain materials and world audio`, result); await menu(); }

  // A gate ensures cancellation occurs with allocated resources, not before the request begins.
  for (const [index, kind] of ['glacial', 'dune'].entries()) {
    await page.locator('#title-skirmish').click(); await choose(kind, seed + 100 + index);
    await page.evaluate(`(()=>{window.__startupLifecycle.gateEntered=false;window.__startupGate=new Promise(resolve=>window.__releaseStartupGate=resolve);})()`);
    await page.locator('#skirmish-start').click(); await page.waitForFunction('window.__startupLifecycle.gateEntered', undefined, { timeout: 90000 });
    if (index === 0) await shot('09-loading-cancellable'); await page.locator('#loading-menu').click(); await waitScreen('title');
    // Keep the second old request pending until the replacement has started.
    if (index === 0) { await page.evaluate('window.__releaseStartupGate()'); await sleep(350); }
    const cancelled = await telemetry(); assert.equal(cancelled.ready, false); assert.equal(cancelled.resident, null); assert.equal(cancelled.lifecycle.created, cancelled.lifecycle.disposed); assert.equal(cancelled.audio.scene, 'title'); record(`cancel allocated ${kind} startup${index === 0 ? ' and ignore late result' : ' before starting replacement'}`, cancelled);
  }
  await page.locator('#title-skirmish').click(); const final = await start('volcanic', seed + 202, () => page.evaluate('window.__releaseStartupGate()')); await shot('10-latest-world-after-cancellations'); record('newest seed and kind win while cancelled initialization completes late', final); await menu();
  assert.deepEqual(errors, []); record('browser JavaScript HTTP GPU validation and shader errors absent', { warnings });
} catch (error) { errors.push({ kind: 'assertion', message: error instanceof Error ? error.stack ?? error.message : String(error) }); process.exitCode = 1; console.error(error); if (page!) await shot('failure').catch(() => {}); }
finally { const report = { capturedAt: new Date().toISOString(), seed, measurement: 'Desktop Chromium/WebGPU integration, no CPU throttle; not mobile hardware', checks, screenshots, errors, warnings }; writeFileSync(join(out, 'verification.json'), JSON.stringify(report, null, 2)); saveSummary(report, join(out, 'verification.json')); await context?.close(); await browser?.close(); await server?.close(); }
console.log(JSON.stringify({ checks: checks.length, errors: errors.length, out }));
