/**
 * Real Chromium/WebGPU workshop acceptance pass and review captures.
 * Uses an isolated profile, never the player's browser data.
 * node node_modules/tsx/dist/cli.mjs scripts/workshop/verify.ts
 * Options: --base URL, --out DIR, --captures-only, --mechanics-only, --lift-only, --skip-game, --headed.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page, type Browser, type BrowserContext } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import { KIT_SLOTS, type SlotId } from '../../src/game/kit';
import { defaultProfile, PROFILE_KEY, type ProgressProfile } from '../../src/game/meta/profile';
import { buildStats, partCards } from '../../src/game/ui/workshop-model';
import type { KitLoadoutIds } from '../../src/game/api/match';
import { WORKSHOP_LIFT_MAX } from '../../src/game/workshop/dimensions';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const arg = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const out = resolve(root, arg('--out') ?? 'artifacts/workshop');
const results: { name: string; ok: boolean; detail?: unknown }[] = [];
const errors: { kind: string; message: string }[] = [];
const captures: string[] = [];
let browser: Browser | undefined, context: BrowserContext | undefined, vite: ViteDevServer | undefined, page: Page;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const profile = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)!) as ProgressProfile, PROFILE_KEY);
const activeKit = async () => { const p = await profile(); return p.loadouts[p.activeLoadout].kit; };
const diagnostic = () => page.evaluate('window.__tmtWorkshop?.snapshot?.() ?? null');
const record = (name: string, detail?: unknown) => { results.push({ name, ok: true, detail }); console.log(`[workshop] PASS ${name}`); };
const shot = async (name: string) => { await page.screenshot({ path: join(out, `${name}.png`), timeout: 60000 }); captures.push(`${name}.png`); };
const current = async () => JSON.stringify(await activeKit());

async function openWorkshop(): Promise<void> {
  await page.locator('#title-workshop').click();
  await page.waitForFunction('window.__tmtWorkshop?.ready && !document.querySelector(".ws-loading")', undefined, { timeout: 90000 });
  await sleep(2100);
}
async function choose(slot: SlotId, id: string): Promise<void> {
  await openPanel('components');
  await page.locator(`#workshop-slot-${slot}`).click();
  await page.locator(`#workshop-part-${id}`).click();
}
async function openPanel(panel: 'components' | 'builds' | 'paint' | 'options'): Promise<void> {
  const marker = { components: '#workshop-slot-hull', builds: '#workshop-build-0', paint: '#workshop-paint-preset', options: '#workshop-quick-install' }[panel];
  if (!await page.locator(marker).isVisible()) await page.locator(`#workshop-open-${panel}`).click();
}
async function quickSetting(quick: boolean): Promise<void> { await openPanel('options'); await page.locator('#workshop-quick-install').setChecked(quick); }
async function selectBuild(index: number): Promise<void> { await openPanel('builds'); await page.locator(`#workshop-build-${index}`).click(); }
async function install(slot: SlotId, id: string, quick = false): Promise<number> {
  await quickSetting(quick);
  await choose(slot, id);
  assert.equal(await page.locator('#workshop-install').isEnabled(), true, `${slot}/${id} should be installable`);
  const before = await current(), start = Date.now();
  await page.locator('#workshop-install').click();
  if (!quick && !(await profile()).settings.gameplay.reducedMotion && !await page.evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches')) {
    assert.equal(await current(), before, 'Installation may not save its preview before seating');
  }
  await page.waitForFunction(({ key, slot, id }) => {
    const p = JSON.parse(localStorage.getItem(key)!);
    return p.loadouts[p.activeLoadout].kit[slot] === id;
  }, { key: PROFILE_KEY, slot, id }, { timeout: 15000 });
  assert.equal(await page.locator(`#workshop-part-${id}`).getAttribute('aria-pressed'), 'true');
  const elapsed = Date.now() - start;
  record(`install ${slot}/${id}${quick ? ' (quick)' : ''}`, { elapsedMs: elapsed });
  return elapsed;
}
async function restoreMinimal(): Promise<void> {
  // The actual budget admits Skiff + Scout + Dome + Mortar + Antenna at 9/10.
  const minimal = { hull: 'skiff', runningGear: 'scout', turret: 'dome', weapon: 'mortar', utility: 'antenna' };
  for (const slot of ['utility', 'weapon', 'turret', 'runningGear', 'hull'] as SlotId[]) {
    if ((await activeKit())[slot] !== minimal[slot]) await install(slot, minimal[slot], true);
  }
}
async function startVideo(): Promise<void> {
  await page.evaluate(`(() => {
    const canvas = document.querySelector('#workshop-viewport canvas');
    const stream = canvas.captureStream(30);
    const audio = window.__tmtWorkshop.captureAudio();
    if (!audio || !audio.getAudioTracks().length) throw new Error('Workshop recording has no production audio track');
    audio.getAudioTracks().forEach(track => stream.addTrack(track));
    const chunks = [];
    const recorder = new MediaRecorder(stream, {mimeType:'video/webm;codecs=vp9,opus', videoBitsPerSecond:8000000, audioBitsPerSecond:128000});
    window.__workshopVideo = {recorder, stream, chunks};
    recorder.ondataavailable = event => { if(event.data.size) chunks.push(event.data); };
    recorder.start(100);
  })()`);
}
async function finishVideo(name: string): Promise<void> {
  const encoded = await page.evaluate<string>(`new Promise(resolve => {
    const {recorder, stream, chunks} = window.__workshopVideo;
    recorder.onstop = async () => {
      const buffer = new Uint8Array(await new Blob(chunks, {type:'video/webm'}).arrayBuffer());
      let binary = ''; for (let i=0; i<buffer.length; i+=8192) binary += String.fromCharCode(...buffer.subarray(i,i+8192));
      stream.getVideoTracks().forEach(t => t.stop()); delete window.__workshopVideo; resolve(btoa(binary));
    }; recorder.stop();
  })`);
  writeFileSync(join(out, `${name}.webm`), Buffer.from(encoded, 'base64'));
  captures.push(`${name}.webm`);
}
async function captureAnimation(slot: SlotId, id: string): Promise<void> {
  await quickSetting(false);
  await choose(slot, id); await sleep(800); await shot(`preview-${slot}`);
  await page.locator('#workshop-view-hero').click();
  await sleep(900);
  await startVideo();
  const start = Date.now();
  await page.locator('#workshop-install').click();
  if (await page.locator('#workshop-close-components').count()) await page.locator('#workshop-close-components').click();
  for (let n = 0; n < 8; n++) { await sleep(230); await shot(`installation-${slot}-${String(n).padStart(2, '0')}`); }
  await page.waitForFunction(({ key, slot, id }) => {
    const p = JSON.parse(localStorage.getItem(key)!); return p.loadouts[p.activeLoadout].kit[slot] === id;
  }, { key: PROFILE_KEY, slot, id }, { timeout: 15000 });
  await sleep(400);
  await finishVideo(`installation-${slot}`);
  record(`record ${slot} mechanical installation`, { elapsedMs: Date.now() - start });
}
async function verifyLift(): Promise<void> {
  if (await page.locator('#workshop-close-components').count()) await page.locator('#workshop-close-components').click();
  await page.locator('#workshop-view-hero').click(); await sleep(900);
  const saved = await current(), up = page.locator('#workshop-lift-up'), down = page.locator('#workshop-lift-down');
  const lift = () => page.evaluate<number>('window.__tmtWorkshop.liftHeight');
  const bounds = await up.boundingBox(); assert.ok(bounds);
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down(); await sleep(1500);
  await page.mouse.move(1450, 750); await page.mouse.up();
  const raised = await lift(); assert.ok(raised > .15 && raised < .55, `Held pointer raises lift: ${raised}`);
  await sleep(350); assert.ok(Math.abs(await lift() - raised) < .003, 'Release outside button stops captured pointer');
  await up.focus(); await page.keyboard.down('Space'); await sleep(450); await page.keyboard.up('Space');
  const keyboardRaised = await lift(); assert.ok(keyboardRaised > raised + .04);
  await shot('lift-raised');
  await up.focus(); await page.keyboard.down('Space'); await sleep(120); await page.evaluate('window.dispatchEvent(new Event("blur"))'); await page.keyboard.up('Space');
  const afterBlur = await lift(); await sleep(250); assert.ok(Math.abs(await lift() - afterBlur) < .003);
  assert.equal(await current(), saved, 'Manual lift is presentation only');
  // One actual held pointer must cross the former .65m stop and reach the shared full travel.
  const topBounds = await up.boundingBox(); assert.ok(topBounds);
  await page.mouse.move(topBounds.x + topBounds.width / 2, topBounds.y + topBounds.height / 2); await page.mouse.down();
  await page.waitForFunction(max => window.__tmtWorkshop!.liftHeight >= max - .001, WORKSHOP_LIFT_MAX, { timeout: 15000 });
  await page.mouse.up(); assert.ok(Math.abs(await lift() - WORKSHOP_LIFT_MAX) < .003);
  await page.mouse.down(); await page.mouse.up(); // A disabled upper button must not restart travel.
  await down.focus(); await page.keyboard.down('Space'); await sleep(1100); await page.keyboard.up('Space');
  const serviceHeight = await lift();
  record('one continuous real pointer hold crosses .65m and reaches the 1.20m upper stop');
  await install('weapon', 'cannon'); assert.ok(Math.abs(await lift() - serviceHeight) < .003, 'Installation restores user-selected height');
  await install('weapon', 'mortar', true); assert.ok(Math.abs(await lift() - serviceHeight) < .003);
  if (await page.locator('#workshop-close-components').count()) await page.locator('#workshop-close-components').click();
  await page.locator('#workshop-view-hero').click(); await sleep(850);
  await down.focus(); await page.keyboard.down('Enter'); await sleep(3500); await page.keyboard.up('Enter');
  assert.ok(await lift() < .003, 'Lift stops at lower limit');
  record('manual lift pointer/keyboard holds, release outside, blur stop, travel limits, service datum and height restoration');
}
async function captureManualLift(): Promise<void> {
  if (await page.locator('#workshop-close-components').count()) await page.locator('#workshop-close-components').click();
  await page.locator('#workshop-view-hero').click(); await sleep(700);
  await page.evaluate(`(() => {
    const engine = window.__tmtWorkshop.engine, original = engine.frame.bind(engine);
    window.__workshopRestoreFrame = () => { engine.frame = original; delete window.__workshopRestoreFrame; };
    engine.frame = frame => original({...frame, camera: {position:[-2.3,1.4,5.2], target:[-.45,1.0,-.25], up:[0,1,0], fovY:43*Math.PI/180}});
  })()`);
  await sleep(700); await startVideo();
  await page.evaluate('window.__tmtWorkshop.setLiftInput(1)');
  await page.waitForFunction(max => window.__tmtWorkshop!.liftHeight >= max - .001, WORKSHOP_LIFT_MAX, { timeout: 15000 });
  await page.evaluate('window.__tmtWorkshop.setLiftInput(0)'); await sleep(600); await shot('lift-maximum-low');
  await page.evaluate('window.__tmtWorkshop.setLiftInput(-1)');
  await page.waitForFunction('window.__tmtWorkshop.liftHeight <= .001', undefined, { timeout: 15000 });
  await page.evaluate('window.__tmtWorkshop.setLiftInput(0)'); await sleep(600); await shot('lift-lowered-low');
  await finishVideo('manual-lift');
  await page.evaluate('window.__workshopRestoreFrame()'); await sleep(600);
  record('record full manual lift travel with scissor rollers, screw drive and parked robot');
}
async function verifyCatalogue(): Promise<void> {
  const baseline = await activeKit();
  await openPanel('components');
  for (const slot of KIT_SLOTS) {
    await page.locator(`#workshop-slot-${slot}`).click();
    const cards = partCards(baseline, slot);
    for (const card of cards) {
      const node = page.locator(`#workshop-part-${card.id}`);
      assert.equal(await node.count(), 1);
      if (card.status === 'incompatible') {
        assert.equal(await node.isDisabled(), true, `${slot}/${card.id} socket mismatch must be disabled`);
      } else {
        await node.click();
        assert.equal(await current(), JSON.stringify(baseline), 'Preview must not mutate saved kit');
        if (card.status === 'over-budget') assert.equal(await page.locator('#workshop-install').isDisabled(), true);
        if (card.status === 'available') {
          assert.equal(await page.locator('#workshop-install').isEnabled(), true);
          assert.equal(await page.locator('.ws-stat-after').count(), 7);
        }
      }
    }
    await shot(`catalogue-${slot}`);
    record(`${slot} catalogue previews, costs, compatibility and saved-kit isolation`, cards.map(c => ({ id: c.id, status: c.status, cost: c.cost })));
  }
  if (await page.locator('#workshop-cancel').count()) await page.locator('#workshop-cancel').click();
}
async function verifyCameras(): Promise<void> {
  const cameras: Record<string, unknown> = {};
  for (const view of ['hero', 'front', 'side', 'rear', 'top']) {
    await page.locator(`#workshop-view-${view}`).click(); await sleep(1000);
    cameras[view] = await page.evaluate('window.__tmtWorkshop.camera');
    await shot(`room-${view}`);
  }
  assert.equal(new Set(Object.values(cameras).map(v => JSON.stringify(v))).size, 5, 'Preset inspection views should differ');
  await page.locator('#workshop-view-hero').click(); await sleep(1000);
  const viewport = page.locator('#workshop-viewport');
  await viewport.focus();
  const before = JSON.stringify(await page.evaluate('window.__tmtWorkshop.camera'));
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('+'); await sleep(500);
  assert.notEqual(JSON.stringify(await page.evaluate('window.__tmtWorkshop.camera')), before, 'Accessible keys move camera');
  await page.keyboard.press('r'); await sleep(800);
  const box = (await viewport.boundingBox())!;
  await page.mouse.move(box.x + box.width * .45, box.y + box.height * .48);
  await page.mouse.down(); await page.mouse.move(box.x + box.width * .56, box.y + box.height * .55, { steps: 12 }); await page.mouse.up();
  const orbit = JSON.stringify(await page.evaluate('window.__tmtWorkshop.camera'));
  await page.mouse.wheel(0, -260); await sleep(500);
  assert.notEqual(JSON.stringify(await page.evaluate('window.__tmtWorkshop.camera')), orbit, 'Wheel zoom changes camera');
  record('five presets, keyboard orbit/zoom/reset, pointer orbit and wheel zoom', cameras);
  await page.locator('#workshop-view-hero').click(); await sleep(800);
}
async function verifyMinimalAndMobile(): Promise<void> {
  assert.equal(await page.locator('.ws-catalog').count(), 0, 'Component catalogue is closed on entry');
  assert.equal(await page.locator('.ws-popup').count(), 0, 'Build, paint and options appear on demand');
  assert.equal(await page.locator('.ws-overall').isVisible(), true, 'Installed overall statistics remain available');
  assert.equal(await page.locator('.ws-header h1').innerText(), 'Workshop');
  const before = await current();
  await page.setViewportSize({ width: 390, height: 844 }); await sleep(600); await shot('mobile-room');
  await openPanel('components'); await sleep(500);
  const sheet = (await page.locator('.ws-catalog').boundingBox())!, viewport = (await page.locator('#workshop-viewport').boundingBox())!;
  assert.ok(sheet.height <= 844 * .45, `Mobile component sheet stays compact (${sheet.height}px)`);
  assert.ok(viewport.y + viewport.height <= sheet.y + 32, 'Camera canvas occupies the clear region above the mobile sheet');
  await shot('mobile-components');
  await page.locator('#workshop-part-skiff').click(); await sleep(400); await shot('mobile-preview');
  assert.equal(await current(), before, 'Mobile preview leaves installed build unchanged');
  await page.locator('#workshop-cancel').click(); await page.locator('#workshop-close-components').click();
  await openPanel('builds'); await page.keyboard.press('Escape');
  assert.equal(await page.locator('.ws-popup').count(), 0, 'Escape closes the open popup without leaving Workshop');
  assert.equal(await page.locator('#workshop').count(), 1, 'Escape from a popup must not navigate away from Workshop');
  await page.setViewportSize({ width: 1920, height: 1080 }); await sleep(500);
  record('minimal default UI, progressive popups, mobile bottom sheet and clear inspection viewport');
}
async function verifyPicking(): Promise<void> {
  // Search observed projected component regions; exact triangles decide the selection.
  const picked = new Set<string>();
  await openPanel('components');
  for (const view of ['front', 'side', 'rear', 'top']) {
    for (const slot of KIT_SLOTS) {
      if (picked.has(slot)) continue;
      await page.locator(`#workshop-slot-${slot === 'hull' ? 'weapon' : 'hull'}`).click();
      await page.locator(`#workshop-view-${view}`).click(); await sleep(800);
      const point = await page.evaluate<{ x: number; y: number; visible: boolean }>(`window.__tmtWorkshop.components.${slot}`);
      if (!point) continue;
      if (!point.visible || picked.has(slot)) continue;
      await page.mouse.move(point.x, point.y); await sleep(80); await page.mouse.click(point.x, point.y);
      if (await page.locator(`#workshop-slot-${slot}`).getAttribute('aria-pressed') === 'true') picked.add(slot);
    }
  }
  assert.ok(picked.size >= 3, `Direct selection should reach exposed components; observed ${[...picked]}`);
  record('direct 3D selection of exposed component surfaces', [...picked]);
}
async function verifyCancellation(): Promise<void> {
  await restoreMinimal();
  const before = await current();
  await quickSetting(false);
  await choose('weapon', 'cannon'); await page.locator('#workshop-install').click(); await sleep(350);
  await page.locator('#workshop-cancel').click(); await sleep(3200);
  assert.equal(await current(), before); assert.equal(await page.evaluate('window.__tmtWorkshop.busy'), false);
  record('cancel restores original assembly and never saves unfinished work');
  await choose('weapon', 'cannon'); await page.locator('#workshop-install').click(); await sleep(100);
  await choose('utility', 'radar'); await page.locator('#workshop-install').click(); await sleep(100);
  await choose('turret', 'cradle'); await page.locator('#workshop-install').click();
  await page.waitForFunction(`JSON.parse(localStorage.getItem('${PROFILE_KEY}')).loadouts[0].kit.turret === 'cradle'`, undefined, { timeout: 15000 });
  assert.equal((await activeKit()).weapon, 'mortar'); assert.equal((await activeKit()).utility, 'antenna');
  record('rapid superseding swaps commit only latest valid proposal');
  await restoreMinimal();
  await quickSetting(false);
  await choose('weapon', 'cannon'); await page.locator('#workshop-install').click(); await sleep(200);
  await selectBuild(1); await sleep(3200);
  let p = await profile(); assert.equal(p.activeLoadout, 1); assert.equal(p.loadouts[0].kit.weapon, 'mortar');
  assert.deepEqual(p.loadouts[1].kit, defaultProfile().loadouts[1].kit);
  record('switch builds cancels transaction and preserves both kits');
  await page.locator('#build-name').fill('Copper Finch'); await page.locator('#build-name').blur();
  await selectBuild(2); await page.locator('#build-name').fill('Iron Badger'); await page.locator('#build-name').blur();
  await selectBuild(0); await page.locator('#build-name').fill('Brass Wren'); await page.locator('#build-name').blur();
  await choose('weapon', 'cannon'); await page.locator('#workshop-install').click(); await sleep(200);
  await page.locator('#workshop-back').click(); await sleep(3200);
  assert.equal(await page.locator('#workshop-viewport canvas').count(), 0);
  assert.equal((await profile()).loadouts[0].kit.weapon, 'mortar');
  assert.equal(await page.evaluate('!window.__tmtWorkshop?.ready'), true);
  record('leave during installation disposes canvas and rejects stale completion');
  await openWorkshop();
}
async function verifyPersistenceAndMotion(): Promise<void> {
  await openPanel('options');
  await page.locator('#workshop-reduced-motion').check();
  const elapsed = await install('weapon', 'cannon');
  assert.ok(elapsed < 1500, `Reduced motion should complete promptly; took ${elapsed}ms`);
  const beforePaint = await current(); await openPanel('paint'); await page.locator('#workshop-paint-preset').selectOption('1'); await page.locator('#workshop-paint-save').click();
  assert.equal(await current(), beforePaint, 'Cosmetic finish must not change stats');
  assert.equal((await profile()).cosmetics.palette, 'ochre');
  await selectBuild(1);
  const saved = await profile();
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.locator('#title-workshop').waitFor(); await openWorkshop();
  assert.deepEqual(await profile(), saved);
  await openPanel('builds'); assert.equal(await page.locator('#workshop-build-1').getAttribute('aria-pressed'), 'true');
  await openPanel('options');
  assert.equal(await page.locator('#workshop-reduced-motion').isChecked(), true);
  assert.deepEqual(saved.loadouts.map(l => l.name), ['Brass Wren', 'Copper Finch', 'Iron Badger']);
  record('three names, distinct kits, active build, paint and motion persist after reload');
  await selectBuild(0); await openPanel('options');
  await page.locator('#workshop-reduced-motion').uncheck();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const systemElapsed = await install('weapon', 'mortar');
  assert.ok(systemElapsed < 1500, 'System reduced motion also skips mechanical sequence');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  record('system reduced-motion preference honored independently of saved checkbox');
}
async function verifyGameplay(): Promise<void> {
  // Slot 0 now has a visibly distinct Skiff kit, proving active selection reaches the match.
  const expected = await activeKit();
  await page.locator('#workshop-back').click(); await page.locator('#title-skirmish').click();
  await page.locator('#skirmish-seed').fill('7'); await page.locator('#skirmish-seed').blur(); await page.locator('#skirmish-start').click();
  await page.waitForFunction('window.__tmtGame?.ready && window.__tmtGame?.ui?.screen === "match"', undefined, { timeout: 180000 });
  const used = await page.evaluate<KitLoadoutIds>('window.__tmtGame.snapshot.tanks[0].kit');
  assert.deepEqual(used, expected);
  await shot('gameplay-active-build');
  record('transition into actual match preserves active player kit', { expected, used, stats: buildStats(expected) });
}
async function main(): Promise<void> {
  mkdirSync(out, { recursive: true });
  let base = arg('--base');
  try {
    if (!base) {
      vite = await createServer({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn', clearScreen: false,
        cacheDir: join(root, '.vite-capture/workshop'), server: { host: '127.0.0.1', port: 0, hmr: false, watch: null, open: false } });
      await vite.listen(); base = vite.resolvedUrls!.local[0];
    }
    const store = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
    const installed = readdirSync(store).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    const executablePath = process.env.TMT_CHROME ?? installed.map(name => join(store, name, 'chrome-win64/chrome.exe')).find(existsSync);
    assert.ok(executablePath, 'Install Playwright Chromium or set TMT_CHROME');
    browser = await chromium.launch({ executablePath, headless: !args.includes('--headed'), ignoreDefaultArgs: ['--headless'], args: [
      ...args.includes('--headed') ? [] : ['--headless=new'], '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu', '--force-color-profile=srgb',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
    context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    await context.route(/\/favicon\.ico(\?|$)/, route => route.fulfill({ status: 204, body: '' }));
    await context.addInitScript(({ key, initial }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, initial); }, { key: PROFILE_KEY, initial: JSON.stringify(defaultProfile()) });
    page = await context.newPage();
    page.on('pageerror', error => errors.push({ kind: 'pageerror', message: error.stack ?? error.message }));
    page.on('console', message => { if (message.type() === 'error') errors.push({ kind: 'console', message: message.text() }); });
    page.on('response', response => { if (response.status() >= 400) errors.push({ kind: 'http', message: `${response.status()} ${response.url()}` }); });
    await page.goto(`${base!.replace(/\/$/, '')}/play.html`, { waitUntil: 'domcontentloaded' });
    await openWorkshop();
    record('workshop initialized with real renderer', await diagnostic());
    const shaders = await page.evaluate<{ ok: boolean; errors: unknown[] }>('window.__tmtWorkshop.shaderCheck()');
    assert.equal(shaders.ok, true, JSON.stringify(shaders.errors));
    record('browser shader compilation', shaders);
    await shot('room-interface');
    if (args.includes('--lift-only')) { await captureManualLift(); return; }
    if (args.includes('--mechanics-only')) {
      await restoreMinimal();
      for (const slot of KIT_SLOTS) {
        const id = partCards(await activeKit(), slot).find(p => p.status === 'available')!.id;
        await captureAnimation(slot, id); await restoreMinimal();
      }
      assert.deepEqual(errors, [], 'Mechanical recordings must have no browser errors');
      record('all five mechanical recordings and quick restoration'); return;
    }
    await verifyCameras();
    await page.locator('#workshop-presentation').click();
    for (const view of ['hero', 'side', 'rear', 'top']) { await page.locator(`#workshop-view-${view}`).click(); await sleep(1000); await shot(`room-clean-${view}`); }
    await page.locator('#workshop-presentation').click();
    await verifyMinimalAndMobile();
    if (args.includes('--captures-only')) return;
    await verifyPicking();
    await verifyCatalogue();
    await install('hull', 'skiff');
    await verifyLift();
    await captureManualLift();
    await captureAnimation('weapon', 'cannon');
    await restoreMinimal();
    for (const slot of KIT_SLOTS) {
      const id = partCards(await activeKit(), slot).find(p => p.status === 'available')!.id;
      await captureAnimation(slot, id); await shot(`installed-${slot}`); await restoreMinimal();
    }
    await verifyCancellation(); await verifyPersistenceAndMotion();
    if (!args.includes('--skip-game')) await verifyGameplay();
    assert.deepEqual(errors, [], 'Browser should have no console, page or HTTP errors');
    record('browser error log is clean');
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    results.push({ name: 'acceptance', ok: false, detail: message }); console.error(message); process.exitCode = 1;
    if (page!) await shot('failure').catch(() => {});
  } finally {
    const report = { createdAt: new Date().toISOString(), results, errors, captures, diagnostics: page! ? await diagnostic().catch(() => null) : null };
    writeFileSync(join(out, 'verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, errors: errors.length, out }, null, 2));
    await context?.close(); await browser?.close(); await vite?.close();
  }
}
await main();
