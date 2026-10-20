/** Actual WebGPU/UI acceptance. Fresh isolated profile; no runtime state injection.
 * node node_modules/tsx/dist/cli.mjs scripts/verify-tank-customization.ts [--base URL] [--out artifacts/tank-designs/customization] [--captures-only]
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import { defaultProfile, PROFILE_KEY, type ProgressProfile } from '../src/game/meta/profile';
import { KIT_PART_IDS, KIT_SLOTS, type SlotId } from '../src/game/kit';
import { buildStats } from '../src/game/ui/workshop-model';
import type { KitLoadoutIds } from '../src/game/api/match';
import type { TankAppearance } from '../src/game/meta/cosmetics';
import { SPECIAL_DESIGNS } from '../src/game/meta/special-designs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), args = process.argv.slice(2);
const arg = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const out = resolve(root, arg('--out') ?? 'artifacts/tank-designs/customization');
const results: { name: string; detail?: unknown }[] = [], errors: string[] = [], captures: string[] = [];
let browser: Browser | undefined, context: BrowserContext | undefined, vite: ViteDevServer | undefined, page: Page | undefined;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const record = (name: string, detail?: unknown) => { results.push({ name, detail }); console.log(`[customization] PASS ${name}`); };
const saved = () => page!.evaluate(key => JSON.parse(localStorage.getItem(key)!) as ProgressProfile, PROFILE_KEY);
const shot = async (name: string) => { await page!.mouse.move(1510, 35); await sleep(120); await page!.screenshot({ path: join(out, `${name}.png`) }); captures.push(`${name}.png`); };
const marks = () => page!.evaluate<number>('window.__tmtWorkshop.appearance?.paintTextures?.reduce((n, layer) => n + layer.tiles.length, 0) ?? 0');
const paintedTiles = (appearance: TankAppearance | undefined) => appearance?.paintTextures?.reduce((n, layer) => n + layer.tiles.length, 0) ?? 0;
async function ready() { await page!.waitForFunction('window.__tmtWorkshop?.ready && !document.querySelector(".ws-loading")', undefined, { timeout: 120000 }); await sleep(600); }
async function openWorkshop() { await page!.locator('#title-workshop').click(); await ready(); }
async function components(slot: SlotId) {
  if (!await page!.locator('#workshop-slot-hull').isVisible()) await page!.locator('#workshop-open-components').click();
  await page!.locator(`#workshop-slot-${slot}`).click();
}
async function install(slot: SlotId, id: string) {
  const current = await page!.evaluate<KitLoadoutIds>('window.__tmtWorkshop.kit'); if (current[slot] === id) return;
  await components(slot); const button = page!.locator(`#workshop-part-${id}`); assert.equal(await button.isEnabled(), true, `${slot}/${id} supported`);
  await button.click(); await page!.locator('#workshop-install').click();
  await page!.waitForFunction(({ slot, id }) => (window as unknown as { __tmtWorkshop: { kit: KitLoadoutIds; busy: boolean } }).__tmtWorkshop.kit[slot] === id && !(window as unknown as { __tmtWorkshop: { busy: boolean } }).__tmtWorkshop.busy, { slot, id }, { timeout: 15000 });
}
async function closePanel() { const close = page!.locator('.ws-panel-head .ws-close').first(); if (await close.isVisible()) await close.click(); }
async function target(): Promise<{ x: number; y: number }> {
  const point = await page!.evaluate(() => {
    const probe = (window as unknown as { __tmtWorkshop: { paintTarget(x: number, y: number): { slot: string } | null } }).__tmtWorkshop;
    const canvas = document.querySelector('#workshop-viewport canvas');
    const candidates: { x: number; y: number; score: number }[] = [];
    for (let y = 180; y < innerHeight - 150; y += 18) for (let x = 350; x < innerWidth - 265; x += 18) candidates.push({ x, y, score: Math.hypot(x - innerWidth / 2, y - innerHeight * .55) });
    for (const p of candidates.sort((a, b) => a.score - b.score)) if (document.elementFromPoint(p.x, p.y) === canvas && probe.paintTarget(p.x, p.y)?.slot === 'hull') return { x: p.x, y: p.y };
    return null;
  });
  assert.ok(point, 'A visible unoccluded paintable hull surface must exist'); return point;
}
async function dabStroke() {
  const p = await target(); await page!.mouse.move(p.x, p.y); await page!.mouse.down();
  await page!.mouse.move(p.x + 30, p.y - 6, { steps: 12 }); await page!.mouse.up(); await sleep(180);
}
async function verifyUnlimitedPaint() {
  const before = await saved();
  await page!.locator('#workshop-open-paint').click(); await page!.locator('#workshop-paint-reset').click();
  await page!.locator('#workshop-view-front').click(); await sleep(800);
  await page!.locator('#workshop-brush-color').fill('#ff0000'); await page!.locator('#workshop-brush-color').dispatchEvent('input');
  const p = await target(); await page!.mouse.click(p.x, p.y); await sleep(350);
  const first = await marks(); assert.ok(first > 0, 'A real pointer click paints texture texels');
  await page!.locator('#workshop-paint-undo').click(); assert.equal(await marks(), 0);
  await page!.locator('#workshop-paint-redo').click(); assert.equal(await marks(), first);
  const settleFrames = async () => { const start = await page!.evaluate<number>('window.__tmtWorkshop.frames'); await page!.waitForFunction(start => (window as unknown as { __tmtWorkshop: { frames: number } }).__tmtWorkshop.frames >= start + 10, start); };
  const frameSample = () => page!.evaluate<{ draws: number; vram: { total: number } }>('window.__tmtWorkshop.resourceCounts');
  await settleFrames(); const beforeRepeat = await frameSample();
  for (let i = 0; i < 309; i++) await page!.mouse.click(p.x, p.y);
  const beforeLast = await page!.evaluate<TankAppearance>('window.__tmtWorkshop.appearance');
  await page!.locator('#workshop-brush-color').fill('#00ff00'); await page!.locator('#workshop-brush-color').dispatchEvent('input');
  await page!.mouse.click(p.x, p.y); await settleFrames();
  const afterLast = await page!.evaluate<TankAppearance>('window.__tmtWorkshop.appearance');
  assert.notDeepEqual(afterLast.paintTextures, beforeLast.paintTextures, 'A different color after 310 gestures changes existing texels');
  assert.equal(await marks(), first, 'Repeated strokes do not grow the texture tile count');
  assert.equal(afterLast.paint?.length ?? 0, 0, 'No player dabs remain in the shader mark stream');
  assert.doesNotMatch(await page!.locator('.ws-paint-panel').innerText(), /192|Design limit/);
  await shot('unlimited-paint-after-310-gestures');
  await page!.locator('#workshop-paint-save').click(); let painted = await saved();
  assert.deepEqual(painted.cosmetics.appearance, afterLast); assert.deepEqual(painted.loadouts, before.loadouts); assert.deepEqual(painted.stats, before.stats);
  await settleFrames(); const afterRepeat = await frameSample();
  assert.equal(afterRepeat.draws, beforeRepeat.draws);
  record('unlimited pointer painting, fixed tile/draw count and bounded gesture undo', { gestures: 311, tiles: first, profileBytes: JSON.stringify(painted).length, beforeRepeat, afterRepeat });
  await page!.locator('#workshop-open-paint').click(); await page!.locator('#workshop-paint-reset').click(); assert.equal(await marks(), 0);
  await page!.locator('#workshop-paint-cancel').click(); await page!.locator('#workshop-paint-discard').click(); await sleep(150); assert.equal(await marks(), first);
  await page!.reload({ waitUntil: 'domcontentloaded' }); if (await page!.locator('#title-workshop').isVisible()) await openWorkshop(); else await ready(); assert.deepEqual(await saved(), painted); assert.equal(await marks(), first);
  await shot('unlimited-paint-reloaded'); record('texture survives reset/cancel and complete browser reload');
  await page!.locator('#workshop-open-paint').click(); await page!.locator('#workshop-paint-reset').click();
  assert.match(await page!.locator('#workshop-paint-save-state').innerText(), /Unsaved changes/);
  for (const selector of ['#workshop-close-paint', '#workshop-paint-cancel', '#workshop-open-components', '#workshop-open-builds', '#workshop-open-options', '#workshop-back', '#workshop-test-drive', '#workshop-test-combat', '#workshop-sandbox']) {
    await page!.locator(selector).click(); await page!.locator('#workshop-paint-confirm').waitFor({ state: 'visible' });
    assert.equal(await page!.evaluate('document.activeElement.id'), 'workshop-paint-keep');
    await page!.locator('#workshop-paint-keep').click();
    assert.equal(await page!.locator('.ws-paint-panel').isVisible(), true); assert.deepEqual(await saved(), painted);
  }
  await page!.locator('#workshop-paint-save').focus(); await page!.keyboard.press('Escape');
  await page!.locator('#workshop-paint-confirm').waitFor({ state: 'visible' }); await shot('unsaved-paint-confirmation');
  await page!.keyboard.press('Escape'); assert.equal(await page!.locator('.ws-paint-panel').isVisible(), true);
  await page!.setViewportSize({ width: 390, height: 844 }); await page!.locator('#workshop-close-paint').click();
  await page!.locator('#workshop-paint-confirm').waitFor({ state: 'visible' }); await shot('unsaved-paint-mobile');
  assert.equal(await page!.locator('#workshop-paint-keep').isVisible(), true); await page!.locator('#workshop-paint-keep').click();
  await page!.setViewportSize({ width: 1600, height: 1000 });
  await page!.goBack(); await page!.locator('#workshop-paint-confirm').waitFor({ state: 'visible' });
  await page!.locator('#workshop-paint-keep').click(); await sleep(250);
  assert.match(page!.url(), /screen=workshop/); assert.deepEqual(await saved(), painted);
  await page!.locator('#workshop-paint-cancel').click(); await page!.locator('#workshop-paint-discard').click(); await sleep(150);
  assert.equal(await marks(), first); assert.deepEqual(await saved(), painted);
  record('unsaved changes guard close, Escape, component/build/options switches, Leave, both tests, Sandbox and browser Back; Keep preserves drawing, Discard restores save');

  await page!.locator('#workshop-open-paint').click(); await page!.locator('#workshop-paint-pattern').selectOption('stripe');
  await page!.locator('#workshop-close-paint').click(); await page!.locator('#workshop-paint-confirm-save').click();
  painted = await saved(); assert.equal(painted.cosmetics.appearance?.finish?.pattern, 'stripe');
  assert.equal(await page!.locator('.ws-paint-panel').count(), 0); record('Save from the exit dialog persists the design and completes the requested close; mobile dialog remains usable');
  await page!.locator('#workshop-test-drive').click();
  await page!.waitForFunction('window.__tmtGame?.ready && window.__tmtGame?.ui?.screen === "match"', undefined, { timeout: 240000 });
  assert.deepEqual(await page!.evaluate<TankAppearance>('window.__tmtGame.vehicleAppearance'), painted.cosmetics.appearance);
  await shot('unlimited-paint-gameplay');
  await page!.locator('#workshop-test-badge button').click(); await ready(); assert.deepEqual(await saved(), painted);
  record('saved custom texture reaches real gameplay and returns to workshop');
}
async function verifyPaintExit() {
  const before = await saved();
  await page!.setViewportSize({ width: 390, height: 844 });
  await page!.locator('#workshop-more').click(); await page!.locator('#workshop-open-paint').click();
  await page!.locator('#workshop-paint-pattern').selectOption('stripe');
  await page!.locator('#workshop-close-paint').click(); await page!.locator('#workshop-paint-confirm').waitFor({ state: 'visible' });
  assert.equal(await page!.evaluate('document.activeElement.id'), 'workshop-paint-keep');
  await shot('unsaved-paint-mobile'); await page!.locator('#workshop-paint-keep').click();
  assert.deepEqual(await saved(), before);
  record('390px mobile modal keeps all decisions visible and defaults to Keep painting');
  const nativePrompt = page!.waitForEvent('dialog');
  const reloading = page!.evaluate(() => location.reload()).catch(() => {});
  const prompt = await nativePrompt; assert.equal(prompt.type(), 'beforeunload'); await prompt.dismiss(); await reloading;
  assert.equal(await page!.locator('.ws-paint-panel').isVisible(), true); assert.deepEqual(await saved(), before);
  record('actual browser reload prompts and dismissal retains unsaved changes');
  await page!.locator('#workshop-close-paint').click(); await page!.locator('#workshop-paint-confirm-save').click();
  const after = await saved(); assert.equal(after.cosmetics.appearance?.finish?.pattern, 'stripe');
  assert.equal(await page!.locator('.ws-paint-panel').count(), 0);
  await page!.locator('#workshop-back').click(); await page!.locator('#title-workshop').waitFor({ state: 'visible' });
  await openWorkshop(); assert.deepEqual(await saved(), after);
  record('mobile Save-and-close persists before leaving and survives reopening workshop');
}
async function captureVideoStart() {
  await page!.evaluate(`(() => { const stream = document.querySelector('#workshop-viewport canvas').captureStream(24); const recorder = new MediaRecorder(stream, {mimeType:'video/webm;codecs=vp9', videoBitsPerSecond:5000000}); const chunks=[]; recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)}; window.__customizationVideo={recorder,stream,chunks}; recorder.start(100); })()`);
}
async function captureVideoEnd(name = 'paint-editor-demo') {
  const encoded = await page!.evaluate<string>(`new Promise(resolve=>{const {recorder,stream,chunks}=window.__customizationVideo; recorder.onstop=async()=>{const bytes=new Uint8Array(await new Blob(chunks,{type:'video/webm'}).arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));stream.getTracks().forEach(t=>t.stop());delete window.__customizationVideo;resolve(btoa(binary));};recorder.stop();})`);
  writeFileSync(join(out, `${name}.webm`), Buffer.from(encoded, 'base64')); captures.push(`${name}.webm`);
}
async function closeView(view: 'hero' | 'front' | 'side' | 'rear') {
  await closePanel(); await page!.locator(`#workshop-view-${view}`).click(); await sleep(650);
  await page!.mouse.move(800, 560); await page!.mouse.wheel(0, view === 'hero' ? -440 : -150); await sleep(650);
}
async function sideView() {
  await closeView('side'); await page!.mouse.move(450, 600); await page!.mouse.down({ button: 'right' }); await page!.mouse.move(948, 600, { steps: 20 }); await page!.mouse.up({ button: 'right' }); await sleep(550);
}
async function orbitVideoHalf() {
  await page!.mouse.move(1180, 620); await page!.mouse.down({ button: 'right' });
  for (let i = 1; i <= 20; i++) { await page!.mouse.move(1180 + Math.sin(i / 20 * Math.PI * 2) * 60, 620 + Math.sin(i / 20 * Math.PI) * 12); await sleep(250); }
  await page!.mouse.up({ button: 'right' });
}
async function beginDetail(slot: SlotId) {
  await components(slot); await sleep(650); await page!.locator('#workshop-presentation').click();
  // A real orbit gesture removes the selection outline while retaining the part focus.
  await page!.mouse.move(1100, 600); await page!.mouse.down({ button: 'right' }); await page!.mouse.move(1106, 600, { steps: 3 }); await page!.mouse.up({ button: 'right' });
  await page!.mouse.wheel(0, -1600); await sleep(850);
}
async function endDetail() { await page!.locator('#workshop-presentation').click(); await closePanel(); }
async function verifyHeadlights() {
  const before = await saved();
  for (const enabled of [true, false]) {
    const button = page!.locator('#workshop-lights');
    if ((await button.getAttribute('aria-pressed') === 'true') !== enabled) await button.click();
    const profile = await saved();
    assert.equal(profile.cosmetics.appearance?.lights ?? true, enabled);
    await page!.locator('#workshop-view-front').click(); await sleep(650);
    await page!.mouse.move(820, 600); await page!.mouse.wheel(0, -1800); await sleep(600); await shot(`headlights-workshop-${enabled ? 'on' : 'off'}`);
    await page!.locator('#workshop-test-drive').click();
    await page!.waitForFunction('window.__tmtGame?.ready && window.__tmtGame?.ui?.screen === "match"', undefined, { timeout: 240000 }); await sleep(1600);
    assert.equal(await page!.evaluate('window.__tmtGame.vehicleAppearance.lights ?? true'), enabled);
    // Use only the normal orbit/zoom controls and the existing visible render-dev
    // time slider. Simulation state and vehicle geometry remain untouched.
    await page!.mouse.move(1100, 570); await page!.mouse.down({ button: 'right' }); await page!.mouse.move(560, 505, { steps: 30 }); await page!.mouse.up({ button: 'right' }); await sleep(800);
    const setTime = async (fraction: number) => {
      const panel = page!.locator('.dev-panel'); if (!await panel.isVisible()) await page!.keyboard.press('Backquote');
      const seconds = await page!.evaluate<number>('window.__tmtGame.snapshot.time');
      await page!.locator('.dev-slider').evaluate((el, value) => { const input = el as HTMLInputElement; input.value = String(value); input.dispatchEvent(new Event('input', { bubbles: true })); }, Math.max(-.5, Math.min(.5, Math.round((fraction - seconds / 480) * 100) / 100)));
      await page!.keyboard.press('Backquote'); await sleep(1400);
    };
    const setDistance = async (distance: number) => {
      for (let i = 0; i < 5; i++) {
        const current = await page!.evaluate<number>('window.__tmtGame.camera.requestedDistance');
        if (Math.abs(current - distance) < .02) break;
        await page!.mouse.move(810, 570); await page!.mouse.wheel(0, Math.max(-400, Math.min(400, Math.log(distance / current) / .0015))); await sleep(200);
      }
      assert.ok(Math.abs(await page!.evaluate<number>('window.__tmtGame.camera.requestedDistance') - distance) < .02);
      await sleep(500);
    };
    // Follow distance survives returning to the workshop, so establish both
    // review distances explicitly through the same wheel gesture each time.
    await setDistance(17);
    await setTime(0); await shot(`headlights-game-${enabled ? 'on' : 'off'}-daylight-play-distance`);
    await setDistance(6);
    for (const [name, fraction] of [['daylight', 0], ['low-sun', .10], ['night', .5]] as const) {
      await setTime(fraction); await shot(`headlights-game-${enabled ? 'on' : 'off'}-${name}-close`);
      const state = await page!.evaluate('({appearance:window.__tmtGame.vehicleAppearance,camera:window.__tmtGame.camera,time:window.__tmtGame.snapshot.time})');
      record(`actual Drive test headlights ${enabled ? 'on' : 'off'} in ${name}`, state);
    }
    assert.deepEqual((await saved()).stats, before.stats); assert.deepEqual((await saved()).loadouts, before.loadouts);
    await page!.locator('#workshop-test-badge button').click(); await ready();
  }
  if (await page!.locator('#workshop-lights').getAttribute('aria-pressed') !== 'true') await page!.locator('#workshop-lights').click();
}
async function captureCrewAndBearings() {
  await page!.locator('#workshop-sandbox').click();
  await page!.locator('#workshop-open-options').click(); await page!.locator('#workshop-quick-install').check(); await closePanel();
  await page!.locator('#workshop-open-paint').click(); await page!.locator('#workshop-paint-preset').selectOption('0'); await page!.locator('#workshop-paint-reset').click(); await page!.locator('#workshop-paint-save').click();
  await install('runningGear', 'scout'); await install('weapon', 'cannon'); await install('turret', 'cradle'); await install('utility', 'radar');
  for (const hull of ['skiff', 'warden', 'aether_hull']) {
    if (arg('--crew-hull') && arg('--crew-hull') !== hull) continue;
    await install('hull', hull); await closeView('hero'); await shot(`crew-hatch-${hull}-quarter`);
    await sideView(); await shot(`crew-hatch-${hull}-side`);
  }
  record('compatible Cradle hulls retain a seated body hatch', { hulls: arg('--crew-hull') ? [arg('--crew-hull')] : ['skiff', 'warden', 'aether_hull'] });
  if (args.includes('--crew-only')) return;
  await install('hull', 'warden'); await install('utility', 'antenna');
  for (const turret of ['dome', 'aether_crown', 'wedge', 'forge_casemate', 'cradle']) {
    await install('turret', turret); await closeView('hero'); await shot(`bearing-${turret}-quarter`);
    await sideView(); await shot(`bearing-${turret}-side`);
    await beginDetail('turret'); await shot(`bearing-${turret}-close`); await endDetail();
  }
  record('five supported turret journals, centered Dome and distinct angular Crown captured through public controls');
}
async function captureTechnicalViews() {
  await page!.locator('#workshop-sandbox').click();
  await page!.locator('#workshop-open-options').click(); await page!.locator('#workshop-quick-install').check(); await closePanel();
  await page!.locator('#workshop-open-paint').click(); await page!.locator('#workshop-paint-preset').selectOption('0'); await page!.locator('#workshop-paint-reset').click(); await page!.locator('#workshop-paint-save').click();
  await install('turret', 'dome'); await install('weapon', 'cannon'); await install('runningGear', 'scout'); await install('utility', 'antenna');
  for (const hull of ['skiff', 'warden', 'bastion']) {
    await install('hull', hull); await closeView('hero'); await shot(`chassis-${hull}-same-equipment`);
    await sideView(); await shot(`chassis-${hull}-side`);
    await closeView('rear'); await shot(`chassis-${hull}-rear`);
  }
  record('three chassis with identical solid paint, Scout tracks, Dome, Cannon and antenna', { armor: 'Bastion includes its standard reactive package' });
  await closeView('front'); await page!.mouse.move(850, 600); await page!.mouse.wheel(0, -2000); await sleep(850);
  const closestCamera = await page!.evaluate<{ position: number[]; target: number[] }>('window.__tmtWorkshop.camera');
  assert.ok(Math.abs(Math.hypot(...closestCamera.position.map((v, i) => v - closestCamera.target[i])) - 2) < .025);
  await target(); await shot('closest-front-paint-inspection'); record('two-metre close inspection keeps a visible real hull paint surface');
  for (const utility of ['radar', 'point_defense']) {
    await install('utility', utility); await beginDetail('utility'); await shot(`accessory-${utility}-close`);
    await captureVideoStart(); await orbitVideoHalf(); await orbitVideoHalf(); await captureVideoEnd(`accessory-${utility}-motion`);
    await endDetail();
  }
  for (const runningGear of ['scout', 'grip', 'crawler']) {
    await install('runningGear', runningGear); await components('runningGear'); await closePanel(); await sleep(450);
    await page!.mouse.move(1100, 600); await page!.mouse.down({ button: 'right' }); await page!.mouse.move(1038, 600, { steps: 12 }); await page!.mouse.up({ button: 'right' }); await sleep(650); await shot(`running-gear-${runningGear}`);
  }
  await closeView('front'); await page!.locator('#workshop-lift-up').focus(); await page!.keyboard.down('Space'); await sleep(3650); await page!.keyboard.up('Space');
  await page!.mouse.move(1050, 640); await page!.mouse.down({ button: 'right' }); await page!.mouse.move(1010, 540, { steps: 12 }); await page!.mouse.up({ button: 'right' }); await sleep(400); await shot('bastion-underbody-raised');
  await page!.locator('#workshop-lift-down').focus(); await page!.keyboard.down('Space'); await sleep(3650); await page!.keyboard.up('Space');
  await closeView('hero'); await shot('solid-paint-relief-close');
  record('articulated accessories, all running gear and raised underbody captured through public workshop controls');
}
async function verifyFantasyDesigns() {
  // The default matched installation must visibly animate, even though it adapts two slots.
  await page!.locator('#workshop-sandbox').click();
  const beforeMatched = await saved(); await components('turret'); await page!.locator('#workshop-part-wedge').click(); await closePanel(); await page!.locator('#workshop-view-hero').click(); await sleep(650);
  await captureVideoStart(); await page!.locator('#workshop-install').click();
  await page!.waitForFunction('window.__tmtWorkshop.busy && window.__tmtWorkshop.progress > .15');
  assert.equal(await page!.evaluate('window.__tmtWorkshop.kit.turret'), 'dome'); assert.deepEqual(await saved(), beforeMatched);
  await shot('wedge-matched-install-midflight');
  await page!.waitForFunction('!window.__tmtWorkshop.busy && window.__tmtWorkshop.kit.turret === "wedge"');
  assert.equal(await page!.evaluate('window.__tmtWorkshop.kit.weapon'), 'cannon'); await captureVideoEnd('wedge-matched-install');
  assert.deepEqual(await saved(), beforeMatched); await page!.locator('#workshop-sandbox').click();
  record('default Wedge/Cannon matched assembly visibly animates before atomic completion');
  await page!.locator('#workshop-open-options').click(); await page!.locator('#workshop-quick-install').check(); await closePanel();
  const original = await saved();
  await components('turret'); await page!.locator('#workshop-part-aether_crown').click();
  assert.match(await page!.locator('#workshop-part-aether_crown').innerText(), /BLUEPRINT LOCKED/);
  assert.equal(await page!.locator('#workshop-install').isEnabled(), false);
  assert.equal(await page!.locator('#workshop-purchase').isEnabled(), true);
  await shot('blueprint-purchase'); await page!.locator('#workshop-purchase').click();
  const purchased = await saved(); assert.equal(purchased.scrap, original.scrap - 450); assert.ok(purchased.unlocks.includes('part:aether_crown')); assert.deepEqual(purchased.loadouts, original.loadouts);
  assert.equal(await page!.locator('#workshop-purchase').count(), 0); assert.match(await page!.locator('#workshop-install').innerText(), /Over budget/);
  await components('utility'); await page!.locator('#workshop-part-aether_vane').click(); await page!.locator('#workshop-purchase').click(); await page!.locator('#workshop-install').click();
  await page!.waitForFunction('window.__tmtWorkshop.kit.utility === "aether_vane" && !window.__tmtWorkshop.busy');
  const normal = await saved(); assert.equal(normal.scrap, original.scrap - 650); assert.equal(normal.loadouts[0].kit.utility, 'aether_vane');
  record('explicit blueprint purchase deducts scrap once, preserves builds until install, and respects normal fitting budget');
  await page!.locator('#workshop-sandbox').click();
  for (const design of SPECIAL_DESIGNS) {
    await closePanel(); await page!.locator('#workshop-open-builds').click(); await page!.locator(`#workshop-preset-${design.id}`).click();
    assert.deepEqual(await page!.evaluate('window.__tmtWorkshop.kit'), design.kit); assert.deepEqual(await saved(), normal);
    await closeView('hero'); await shot(`fantasy-${design.id}-quarter`); await sideView(); await shot(`fantasy-${design.id}-side`);
    await closeView('rear'); await shot(`fantasy-${design.id}-rear`);
    await beginDetail('weapon'); await shot(`barrel-${design.kit.weapon}-close`);
    await captureVideoStart(); await orbitVideoHalf(); await captureVideoEnd(`barrel-${design.kit.weapon}-energy`);
    await endDetail();
    await closePanel(); await page!.locator(design.id === 'aether' ? '#workshop-test-drive' : '#workshop-test-combat').click();
    await page!.waitForFunction('window.__tmtGame?.ready && window.__tmtGame?.ui?.screen === "match"', undefined, { timeout: 240000 });
    assert.deepEqual(await page!.evaluate('window.__tmtGame.snapshot.tanks[0].kit'), design.kit);
    assert.deepEqual(await page!.evaluate<TankAppearance>('window.__tmtGame.vehicleAppearance.finish.colors'), design.colors);
    await shot(`fantasy-${design.id}-match`); assert.deepEqual(await saved(), normal);
    await page!.locator('#workshop-test-badge button').click(); await ready(); assert.deepEqual(await saved(), normal);
    record(`${design.name} Sandbox preset and actual ${design.id === 'aether' ? 'Drive' : 'Combat'} test preserve progression`);
  }
  await install('hull', 'warden'); await install('turret', 'dome'); await install('weapon', 'rail');
  await beginDetail('weapon'); await shot('barrel-rail-close');
  await captureVideoStart(); await orbitVideoHalf(); await captureVideoEnd('barrel-rail-energy');
  await endDetail();
  for (const utility of ['antenna', 'whip_short', 'yagi', 'periscope', 'smoke', 'aether_vane', 'steam_sentinel']) {
    await install('utility', utility); await beginDetail('utility'); await shot(`refined-${utility}-close`); await endDetail();
  }
  await page!.locator('#workshop-sandbox').click(); assert.deepEqual(await saved(), normal); assert.deepEqual(await page!.evaluate('window.__tmtWorkshop.kit'), normal.loadouts[0].kit);
  record('refined accessories and three energy barrels captured; exiting Sandbox restores the purchased normal build');
}
async function verifyUtilityInstallation() {
  for (const id of KIT_PART_IDS.utility.filter(id => !['aether_vane', 'steam_sentinel'].includes(id))) {
    await install('utility', id); record(`normal animated utility ${id} installs`, await page!.evaluate('window.__tmtWorkshop.kit'));
  }
  await page!.locator('#workshop-sandbox').click();
  for (const design of SPECIAL_DESIGNS) {
    await closePanel(); await page!.locator('#workshop-open-builds').click(); await page!.locator(`#workshop-preset-${design.id}`).click(); await closePanel();
    if (design.id === 'furnace') { await closeView('rear'); await shot('furnace-rear-engine-current'); await closeView('hero'); await shot('furnace-quarter-current'); }
    for (const id of KIT_PART_IDS.utility) { await install('utility', id); record(`${design.id} animated utility ${id} installs`); }
  }
  await page!.locator('#workshop-open-options').click(); await page!.locator('#workshop-quick-install').check(); await closePanel();
  for (const id of KIT_PART_IDS.utility) { await install('utility', id); record(`quick utility ${id} installs`); }
  await shot('utilities-installed');
}

mkdirSync(out, { recursive: true });
try {
  let base = arg('--base');
  if (!base) { vite = await createServer({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn', cacheDir: join(root, '.vite-capture/customization'), server: { host: '127.0.0.1', port: 0, open: false, hmr: false, watch: null } }); await vite.listen(); base = vite.resolvedUrls!.local[0]; }
  const store = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  const installed = readdirSync(store).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  const executablePath = process.env.TMT_CHROME ?? installed.map(name => join(store, name, 'chrome-win64/chrome.exe')).find(existsSync);
  assert.ok(executablePath, 'Install Playwright Chromium or set TMT_CHROME');
  browser = await chromium.launch({ executablePath, headless: true, ignoreDefaultArgs: ['--headless'], args: ['--headless=new', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu', '--force-color-profile=srgb', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  await context.route(/\/favicon\.ico(\?|$)/, route => route.fulfill({ status: 204, body: '' }));
  const initialProfile = defaultProfile(); if (args.includes('--fantasy-only')) initialProfile.scrap = 2000;
  await context.addInitScript(({ key, value }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, value); }, { key: PROFILE_KEY, value: JSON.stringify(initialProfile) });
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.stack ?? error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${base!.replace(/\/$/, '')}/play.html${args.includes('--headlights-only') ? '?dev' : ''}`, { waitUntil: 'domcontentloaded' }); await openWorkshop();
  const shaders = await page.evaluate<{ ok: boolean }>('window.__tmtWorkshop.shaderCheck()'); assert.equal(shaders.ok, true); record('workshop shaders compile', shaders);
  if (args.includes('--headlights-only')) await verifyHeadlights();
  else if (args.includes('--paint-only')) await verifyUnlimitedPaint();
  else if (args.includes('--paint-exit-only')) await verifyPaintExit();
  else if (args.includes('--geometry-only')) await captureCrewAndBearings();
  else if (args.includes('--utility-only')) await verifyUtilityInstallation();
  else if (args.includes('--fantasy-only')) await verifyFantasyDesigns();
  else if (args.includes('--captures-only')) await captureTechnicalViews();
  else {
  await shot('workshop-before-paint'); await captureVideoStart();
  const before = await saved();
  await page.locator('#workshop-open-paint').click(); await page.locator('#workshop-paint-preset').selectOption('4');
  await page.locator('#workshop-brush-color').fill('#efb84a'); await page.locator('#workshop-brush-color').dispatchEvent('input');
  await page.locator('#workshop-view-front').click(); await sleep(1000); await dabStroke();
  const afterStroke = await marks(); assert.ok(afterStroke > 0, 'Actual pointer stroke paints texture tiles');
  await page.locator('#workshop-paint-undo').click(); assert.equal(await marks(), 0);
  await page.locator('#workshop-paint-redo').click(); assert.equal(await marks(), afterStroke);
  const p = await target(); await page.mouse.move(p.x, p.y); await page.mouse.down({ button: 'right' }); await page.mouse.move(p.x + 75, p.y + 18, { steps: 10 }); await page.mouse.up({ button: 'right' });
  assert.equal(await marks(), afterStroke, 'Right-drag camera cannot paint');
  await shot('surface-paint-editor'); await page.locator('#workshop-paint-save').click();
  const painted = await saved(); assert.equal(paintedTiles(painted.cosmetics.appearance), afterStroke); assert.deepEqual(painted.loadouts, before.loadouts); assert.deepEqual(painted.stats, before.stats);
  record('actual surface paint, undo/redo, camera isolation and cosmetic-only save', { textureTiles: afterStroke });
  await page.locator('#workshop-open-paint').click(); await page.locator('#workshop-paint-reset').click(); assert.equal(await marks(), 0); await page.locator('#workshop-paint-cancel').click(); await page.locator('#workshop-paint-discard').click(); await sleep(150); assert.equal(await marks(), afterStroke);
  assert.deepEqual(await saved(), painted); record('reset and cancellation restore saved design');
  await captureVideoEnd();
  await page.locator('#workshop-test-drive').click();
  await page.waitForFunction('window.__tmtGame?.ready && window.__tmtGame?.ui?.screen === "match" && window.__tmtGame?.vehicleAppearance', undefined, { timeout: 240000 });
  assert.deepEqual(await page.evaluate<TankAppearance>('window.__tmtGame.vehicleAppearance'), painted.cosmetics.appearance);
  await shot('fresh-saved-paint-in-match'); assert.deepEqual(await saved(), painted);
  await page.locator('#workshop-test-badge button').click(); await ready();
  record('fresh saved paint reaches actual match renderer without reloading or progression changes');
  await page.reload({ waitUntil: 'domcontentloaded' }); await openWorkshop(); assert.deepEqual(await saved(), painted); assert.equal(await marks(), afterStroke); record('saved design survives full reload');
  await page.locator('#workshop-lights').click(); assert.equal(await page.locator('#workshop-lights').getAttribute('aria-pressed'), 'false'); await shot('lamps-off'); await page.locator('#workshop-lights').click(); await sleep(300); await shot('lamps-on');
  record('vehicle light toggle persists and previews');
  const normal = await saved(); await page.locator('#workshop-sandbox').click();
  await page.locator('#workshop-open-options').click(); await page.locator('#workshop-quick-install').check(); await closePanel();
  await components('turret'); await page.locator('#workshop-part-wedge').click();
  assert.match(await page.locator('.ws-actionbar').innerText(), /Auto-fit.*Field cannon/);
  await shot('wedge-matched-assembly-preview'); await page.locator('#workshop-install').click();
  await page.waitForFunction('window.__tmtWorkshop.kit.turret === "wedge" && window.__tmtWorkshop.kit.weapon === "cannon"');
  assert.deepEqual(await saved(), normal); record('Warden Dome/Mortar automatically fits Wedge/Cannon with explicit paired preview and atomic sandbox installation');
  await install('turret', 'dome');
  await install('weapon', 'cannon'); await install('turret', 'dome'); await install('runningGear', 'scout'); await install('utility', 'antenna');
  await page.locator('#workshop-open-paint').click(); await page.locator('#workshop-paint-preset').selectOption('0'); await page.locator('#workshop-paint-reset').click(); await page.locator('#workshop-paint-save').click();
  for (const hull of ['skiff', 'warden', 'bastion']) {
    await install('hull', hull); await closeView('hero'); await shot(`chassis-${hull}-same-equipment`);
    await sideView(); await shot(`chassis-${hull}-side`);
    await closeView('rear'); await shot(`chassis-${hull}-rear`);
  }
  assert.equal(await page.evaluate('window.__tmtWorkshop.kit.armor'), 'reactive');
  record('selecting Bastion includes its reactive armor package by default');
  for (const slot of KIT_SLOTS) { await components(slot); for (const id of KIT_PART_IDS[slot]) assert.equal(await page.locator(`#workshop-part-${id}`).count(), 1); }
  record('every part remains visible in the existing five-slot catalogue');
  for (const id of KIT_PART_IDS.utility) {
    await install('utility', id); await closePanel();
    if (id === 'radar' || id === 'point_defense') { await components('utility'); await closePanel(); await page.mouse.move(800, 500); await page.mouse.wheel(0, -400); await sleep(650); }
    else await closeView('hero');
    await shot(`accessory-${id}`);
  }
  for (const id of KIT_PART_IDS.weapon) { await install('weapon', id); await closePanel(); await page.locator('#workshop-view-front').click(); await sleep(450); await shot(`muzzle-${id}`); }
  await install('runningGear', 'crawler'); await install('weapon', 'rail'); await install('utility', 'radar'); await components('hull');
  await page.locator('#workshop-reactive-armor').click(); assert.equal(await page.evaluate('window.__tmtWorkshop.kit.armor'), 'standard');
  await page.locator('#workshop-reactive-armor').click();
  await closeView('front'); await page.locator('#workshop-lift-up').focus(); await page.keyboard.down('Space'); await sleep(3650); await page.keyboard.up('Space');
  await page.mouse.move(1050, 640); await page.mouse.down({ button: 'right' }); await page.mouse.move(1010, 540, { steps: 12 }); await page.mouse.up({ button: 'right' }); await sleep(400); await shot('bastion-underbody-raised');
  await page.locator('#workshop-lift-down').focus(); await page.keyboard.down('Space'); await sleep(3650); await page.keyboard.up('Space');
  await closeView('hero'); await shot('solid-paint-relief-close');
  await captureVideoStart(); await orbitVideoHalf(); await install('utility', 'point_defense'); await closeView('hero'); await orbitVideoHalf(); await captureVideoEnd('accessory-motion-turntable'); await install('utility', 'radar');
  const sandboxKit = await page.evaluate<KitLoadoutIds>('window.__tmtWorkshop.kit'); assert.equal(sandboxKit.armor, 'reactive'); assert.ok(buildStats(sandboxKit)!.cost > 10);
  await closePanel(); await page.locator('#workshop-view-hero').click(); await sleep(850); await shot('sandbox-reactive-heavy'); assert.deepEqual(await saved(), normal);
  record('all accessories, weapons and reactive heavy armor preview above fitting budget without profile writes', sandboxKit);
  await page.locator('#workshop-open-paint').click(); await page.locator('#workshop-paint-preset').selectOption('6'); await page.locator('#workshop-paint-save').click();
  const sandboxAppearance = await page.evaluate<TankAppearance>('window.__tmtWorkshop.appearance');
  assert.notDeepEqual(sandboxAppearance.finish, normal.cosmetics.appearance?.finish); assert.deepEqual(await saved(), normal);
  await page.locator('#workshop-test-drive').click(); await page.waitForFunction('window.__tmtGame?.ready && window.__tmtGame?.ui?.screen === "match"', undefined, { timeout: 240000 });
  const used = await page.evaluate<KitLoadoutIds>('window.__tmtGame.snapshot.tanks[0].kit'); assert.deepEqual(used, sandboxKit);
  assert.deepEqual(await page.evaluate<TankAppearance>('window.__tmtGame.vehicleAppearance'), sandboxAppearance);
  await page.keyboard.down('w'); await sleep(700); await page.keyboard.up('w'); await shot('sandbox-driving'); assert.deepEqual(await saved(), normal);
  await page.locator('#workshop-test-badge button').click(); await ready(); assert.equal(await page.locator('#workshop-sandbox').getAttribute('aria-pressed'), 'true');
  await page.locator('#workshop-sandbox').click(); assert.deepEqual(await page.evaluate('window.__tmtWorkshop.kit'), normal.loadouts[normal.activeLoadout].kit); assert.deepEqual(await saved(), normal);
  record('unrestricted drive test uses the selected kit; return/exit restore normal profile exactly');
  }
  const finalShaders = await page.evaluate<{ ok: boolean }>('window.__tmtWorkshop.shaderCheck()'); assert.equal(finalShaders.ok, true); assert.deepEqual(errors, []); record('no browser or shader errors');
} catch (error) {
  process.exitCode = 1; errors.push(error instanceof Error ? error.stack ?? error.message : String(error)); console.error(errors.at(-1)); if (page) await shot('failure').catch(() => {});
} finally {
  const diagnostics = page ? await page.evaluate('window.__tmtWorkshop?.snapshot?.() ?? null').catch(() => null) : null;
  writeFileSync(join(out, 'verification.json'), JSON.stringify({ createdAt: new Date().toISOString(), results, errors, captures, diagnostics }, null, 2));
  await context?.close(); await browser?.close(); await vite?.close(); console.log(JSON.stringify({ passed: results.length, errors: errors.length, out }));
}
