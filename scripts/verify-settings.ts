/** Real-browser regression and GPU comparison: node --import tsx scripts/verify-settings.ts.
 * Uses a fresh browser profile; writes screenshots and measurements to artifacts/settings. */
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const root = resolve(import.meta.dirname, '..'), out = join(root, 'artifacts/settings');
mkdirSync(out, { recursive: true });
const server = await createServer({ root, logLevel: 'warn', cacheDir: join(root, '.vite-capture/settings'), server: { host: '127.0.0.1', port: 0, open: false, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.TMT_CHROME ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-webgpu-developer-features', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, hasTouch: true });
const errors: string[] = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const bench = <T = unknown>(code: string) => page.evaluate<T>(`(async () => { const b = window.__tmtRenderBench; ${code} })()`);
interface Measurement { engineTier: string; errors: number; compileErrors: number; averageGpuMs: number; graphics: { renderScale: number }; features: { clouds: { enabled: boolean }; volumetrics: { enabled: boolean } } }
const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('tmt.progress.v2')!).settings);
const slide = async (id: string, value: number) => {
  await page.locator(`#set-${id}`).evaluate((node, value) => { const input = node as HTMLInputElement; input.value = String(value); input.dispatchEvent(new Event('input', { bubbles: true })); }, value);
};
const checks: string[] = [], measurements: Record<string, unknown> = {};
const phoneOnly = process.argv.includes('--phone-only');
const devOnly = process.argv.includes('--dev-only');
try {
  if (!devOnly) {
  await page.goto(`${server.resolvedUrls!.local[0]}?mode=drive&seed=7&renderbench&engineDev`);
  await page.waitForFunction('window.__tmtGame?.ready', undefined, { timeout: 240000 });
  await bench('await b.step(20)');
  console.log('Ready; checking settings UI.');
  if (!phoneOnly) {
  await page.click('#pause-open'); await page.click('#pause-settings');
  await page.evaluate('window.settingsCard = document.querySelector("#settings")');
  await page.click('#set-tier [data-value="low"]');
  assert.equal((await saved()).graphics.renderScale, 0.5);
  assert.equal(await page.inputValue('#set-shadows'), '0');
  assert.equal(await page.inputValue('#set-cloudQuality'), '0');
  await page.click('#set-tier [data-value="high"]');
  assert.equal(await page.inputValue('#set-renderScale'), '1');
  assert.equal(await page.inputValue('#set-shadows'), '3');
  assert.equal(await page.inputValue('#set-miniature'), '0');
  await slide('fisheye', -0.4);
  assert.equal((await saved()).graphics.fisheye, -0.4);
  await page.click('#set-tier [data-value="high"]');
  await slide('shadows', 2);
  assert.equal(await page.getAttribute('#set-tier [data-value="custom"]', 'aria-checked'), 'true');
  assert.equal((await saved()).graphics.tier, 'custom');
  await page.click('#set-tier [data-value="high"]');
  assert.equal(await page.inputValue('#set-shadows'), '3');
  checks.push('Preset controls, manual Custom transition and reselection');
  await page.screenshot({ path: join(out, 'graphics.png') });
  await page.click('#settings-tab-audio');
  assert.equal(await page.evaluate('window.settingsCard === document.querySelector("#settings")'), true);
  await slide('music', 0.25);
  await page.click('#settings-tab-gameplay');
  await page.click('#settings-tab-audio');
  assert.equal(await page.inputValue('#set-music'), '0.25');
  await page.waitForTimeout(300); await page.screenshot({ path: join(out, 'audio.png') });
  checks.push('Same panel retained across tabs; current values retained');
  await page.click('#settings-tab-controls');
  await page.click('#bind-drive-fire-0'); await page.keyboard.press('KeyJ');
  assert.equal((await saved()).controls.bindings.drive.fire[0], 'KeyJ');
  await page.click('#bind-drive-driveForward-0'); await page.keyboard.press('KeyJ');
  assert.equal((await saved()).controls.bindings.drive.fire[0], 'KeyW');
  assert.equal((await saved()).controls.bindings.drive.driveForward[0], 'KeyJ');
  await page.click('#bind-drive-fire-0'); await page.keyboard.press('Escape');
  assert.equal(await page.locator('#settings').count(), 1);
  assert.equal((await saved()).controls.bindings.drive.fire[0], 'KeyW');
  await page.click('#bind-drive-fire-0'); await page.keyboard.press('KeyK');
  await page.screenshot({ path: join(out, 'keys.png') });
  checks.push('Key capture, conflict swap, Escape cancellation');
  await page.click('#settings-tab-profile'); await page.click('#profile-show');
  const exported = await page.inputValue('#profile-json');
  assert.equal(JSON.parse(exported).settings.controls.bindings.drive.fire[0], 'KeyK');
  await page.click('#settings-tab-audio'); await page.click('#settings-tab-profile');
  assert.equal(await page.inputValue('#profile-json'), exported);
  await page.fill('#profile-json', '{broken'); await page.click('#profile-import');
  assert.equal((await saved()).controls.bindings.drive.fire[0], 'KeyK');
  await page.fill('#profile-json', exported); await page.click('#profile-import');
  checks.push('Profile export, invalid import, valid import and draft retention');
  await page.reload(); await page.waitForFunction('window.__tmtGame?.ready', undefined, { timeout: 240000 });
  await bench('await b.step(20)');
  assert.equal((await saved()).controls.bindings.drive.fire[0], 'KeyK');
  assert.equal((await saved()).audio.music, 0.25);
  assert.equal(await page.locator('#fire kbd').textContent(), 'K');
  // Browser navigation restores the settings route on reload. Close it before scene captures.
  if (await page.locator('#settings-back').isVisible()) await page.click('#settings-back');
  if (await page.locator('#pause-resume').isVisible()) await page.click('#pause-resume');
  checks.push('Reload persistence and live HUD key hints');
  await page.locator('#viewport').focus();
  await page.keyboard.press('Tab');
  await page.waitForFunction('window.__tmtGame.aiming.selection?.object?.id === "tank:1"');
  for (const [key, munition] of [['Digit1', 'explosive'], ['Digit2', 'heavy'], ['Digit3', 'incendiary'], ['Digit4', 'nuclear']] as const) {
    await page.keyboard.press(key);
    assert.equal(await page.evaluate('window.__tmtGame.snapshot.tanks[0].munition'), munition);
  }
  await page.keyboard.press('Digit1'); await page.keyboard.press('Tab');
  assert.equal(await page.evaluate('window.__tmtGame.aiming.selection.object.id'), 'tank:1');
  assert.equal(await page.evaluate('window.__tmtGame.snapshot.projectiles.length'), 0);
  await bench('await b.step(3)');
  const frame = page.locator('.requested-aim-target[data-kind="tank"]');
  assert.equal(await frame.isVisible(), true);
  const framed = (await frame.boundingBox())!;
  assert.ok(framed.width > 28 && framed.height > 28, 'Selection must frame the full tank');
  await page.screenshot({ path: join(out, 'target-keyboard.png') });
  checks.push('Tab selects and tracks a visible tank; 1–4 select ammunition without firing');
  console.log('UI checks passed; comparing GPU presets.');
  await bench('await b.step(100)');
  for (const tier of ['low', 'medium', 'high', 'ultra']) {
    const result = await bench<Measurement>(`b.configure({ graphics: { tier: '${tier}' } }); await b.step(60); const sample = await b.step(75);
      return { graphics: b.state().graphics, features: b.state().features, engineTier: b.state().engine.tier,
        errors: b.state().engine.validationErrors, compileErrors: b.state().engine.compile.errors,
        averageGpuMs: sample.reduce((s, x) => s + x.engine.gpu.total, 0) / sample.length,
        passes: sample.at(-1).engine.gpu.passes, custom: b.state().engine.custom };`);
    measurements[tier] = result;
    assert.equal(result.engineTier, 'high'); assert.equal(result.errors, 0); assert.equal(result.compileErrors, 0);
    if (tier === 'high') assert.equal(result.graphics.renderScale, 1);
    assert.equal((result.graphics as { miniature?: number }).miniature, 0);
    if (tier === 'low') { assert.equal(result.features.clouds.enabled, false); assert.equal(result.features.volumetrics.enabled, false); }
    console.log(`${tier}: ${result.averageGpuMs.toFixed(2)} ms GPU`);
  }
  // Offset the camera around the tank so the aiming ribbon crosses the blur gradient, as in the reported artifact.
  await bench(`const rig = b.state().camera, d = rig.position.map((v, i) => v - rig.target[i]);
    const u = rig.up, cos = Math.cos(0.7), sin = Math.sin(0.7), dot = d.reduce((s, v, i) => s + v * u[i], 0);
    const cross = [u[1]*d[2]-u[2]*d[1], u[2]*d[0]-u[0]*d[2], u[0]*d[1]-u[1]*d[0]];
    b.configure({ camera: { ...rig, position: d.map((v, i) => rig.target[i] + v*cos + cross[i]*sin + u[i]*dot*(1-cos)) } });`);
  const hide = await page.addStyleTag({ content: '#hud, #toast, #dev-bar, .tank-labels, .trajectory-readout, .aim-target-readout { visibility: hidden !important; }' });
  for (const [name, fisheye, miniature] of [['lens-off', 0, 0], ['fisheye', 0.6, 0], ['inverse-fisheye', -0.6, 0], ['miniature', 0, 1]] as const) {
    await bench(`b.configure({ graphics: { tier: 'high', fisheye: ${fisheye}, miniature: ${miniature}, grain: 0 } }); await b.step(25);`);
    await page.screenshot({ path: join(out, `${name}.png`) });
  }
  const grainNoise: number[] = [];
  for (const grain of [0, 1]) {
    await bench(`b.configure({ epoch: 100, graphics: { tier: 'low', renderScale: 1, grain: ${grain} } }); await b.step(20);`);
    const path = join(out, `grain-${grain}.png`);
    await page.screenshot({ path });
    // Flat sky patch: grain changes adjacent-pixel contrast; the smooth sky gradient and dither remain at zero.
    const { data, info } = await sharp(path).extract({ left: 400, top: 60, width: 400, height: 120 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let contrast = 0;
    for (let y = 0; y < info.height; y++) for (let x = 1; x < info.width; x++) for (let c = 0; c < 3; c++) {
      const index = (y * info.width + x) * 3 + c;
      contrast += Math.abs(data[index] - data[index - 3]);
    }
    grainNoise.push(contrast / ((info.width - 1) * info.height * 3));
  }
  assert.ok(grainNoise[1] > grainNoise[0] * 3 + 1, `Film grain contrast did not increase: ${grainNoise}`);
  measurements.grainAdjacentPixelContrast = grainNoise;
  checks.push('Film grain produces measurable visible noise and switches off at zero');
  await bench(`b.configure({ graphics: { tier: 'high' } }); await b.step(10);`);
  await hide.evaluate(node => node.parentNode?.removeChild(node));
  checks.push('All presets preserve core tier; GPU validation and lens captures');
  }
  await page.click('#pause-open'); await page.click('#pause-settings');
  await page.setViewportSize({ width: 390, height: 844 });
  await bench('await b.step(2)');
  await page.click('#settings-tab-graphics'); await page.waitForTimeout(300);
  await page.screenshot({ path: join(out, 'phone-graphics.png') });
  const overflow = await page.evaluate(() => Array.from(document.querySelectorAll('body *')).flatMap(node => {
    const r = node.getBoundingClientRect();
    return r.width && r.right > innerWidth + 1 ? [{ tag: node.tagName, id: node.id, className: node.className, right: r.right, width: r.width }] : [];
  }));
  if (overflow.length) console.log('Overflow:', JSON.stringify(overflow));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.click('#settings-tab-controls'); await page.waitForTimeout(300); await page.screenshot({ path: join(out, 'phone-keys.png') });
  checks.push('Phone layout without horizontal overflow');
  await page.click('#settings-back'); await page.click('#pause-resume');
  await page.locator('#viewport').dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 101 });
  await bench('await b.step(3)');
  const target = page.locator('#target-cycle');
  await target.waitFor({ state: 'visible' });
  const box = (await target.boundingBox())!;
  assert.ok(box.width >= 44 && box.height >= 44 && box.x >= 0 && box.x + box.width <= 390);
  for (const selector of ['#scan', '#munition-cycle', '#fire', '#fine-aim-toggle', '#camera']) {
    const button = page.locator(selector);
    if (!await button.isVisible()) continue;
    const other = (await button.boundingBox())!;
    assert.ok(box.x + box.width <= other.x || other.x + other.width <= box.x || box.y + box.height <= other.y || other.y + other.height <= box.y, `Target overlaps ${selector}`);
  }
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForFunction('window.__tmtGame.aiming.selection?.object?.id === "tank:1"');
  await bench('await b.step(3)');
  await page.screenshot({ path: join(out, 'target-touch.png') });
  checks.push('Mobile target button selects a visible enemy and does not overlap other controls');
  }
  if (!phoneOnly) {
    console.log('Checking dev free roam ammunition UI and selected body framing.');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${server.resolvedUrls!.local[0]}?mode=dev&seed=7&engineDev`);
    await page.waitForFunction('window.__tmtGame?.ready && window.__tmtVisuals', undefined, { timeout: 240000 });
    console.log('Dev ready; checking keyboard and dropdown synchronization.');
    await page.locator('#viewport').focus();
    for (const [key, munition] of [['Digit2', 'heavy'], ['Digit3', 'incendiary'], ['Digit4', 'nuclear'], ['Digit1', 'explosive']] as const) {
      await page.keyboard.press(key);
      await page.waitForFunction(id => (window as any).__tmtGame.snapshot.tanks[0].munition === id
        && document.querySelector<HTMLSelectElement>('.dev-munition')?.value === id, munition);
    }
    await page.selectOption('.dev-munition', 'heavy');
    await page.waitForFunction('window.__tmtGame.snapshot.tanks[0].munition === "heavy"');
    await page.keyboard.press('Digit1');
    await page.waitForFunction('document.querySelector(".dev-munition").value === "explosive"');
    await page.locator('.dev-panel header').click();
    await page.locator('#viewport').focus(); await page.keyboard.press('Tab');
    const frame = page.locator('.requested-aim-target[data-kind="tank"]');
    await frame.waitFor({ state: 'visible' });
    assert.equal(await frame.getAttribute('data-target'), 'tank:1');
    const before = (await frame.boundingBox())!;
    assert.ok(before.width > 28 && before.height > 28);
    await page.screenshot({ path: join(out, 'dev-target-tab.png') });
    // Manual aiming clears tracking; selecting the rendered hull by mouse restores the same frame.
    await page.keyboard.down('ArrowLeft');
    await page.waitForFunction('!window.__tmtGame.aiming.selection');
    await page.keyboard.up('ArrowLeft');
    await frame.waitFor({ state: 'hidden' });
    const target = await page.evaluate('window.__tmtVisuals.aimTargets().find(t => t.id === "tank:1").screen') as [number, number];
    assert.ok(target);
    await page.mouse.click(target[0], target[1]);
    await frame.waitFor({ state: 'visible' });
    assert.match((await frame.getAttribute('data-target'))!, /^(tank:1|component:1:)/);
    await page.screenshot({ path: join(out, 'dev-target-click.png') });
    checks.push('Dev 1–4 and dropdown stay in sync; Tab and clicking share full-body white brackets');
    console.log('Dev ammunition and framing passed; checking fog contact loss.');
    const home = await page.evaluate('window.__tmtVisuals.tank()');
    await page.locator('.dev-panel header').click();
    await page.locator('.dev-fog').check();
    await page.waitForFunction('window.__tmtVisuals.aimTargets().some(t => t.id === "tank:1")');
    await page.locator('.dev-panel header').click();
    // Relocate the observer behind the planet while keeping the enemy selected; the debug toggle must use real sight.
    await page.evaluate('window.__tmtFluids.lookAt(window.__tmtGame.snapshot.tanks[1].position.map(v => -v), 5, 0)');
    await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await page.evaluate('window.__tmtVisuals.placeTank()');
    await page.waitForFunction('!window.__tmtGame.aiming.selection && window.__tmtVisuals.aimTargets().length === 0');
    await page.locator('#viewport').focus(); await page.keyboard.press('Tab');
    assert.equal(await page.evaluate('window.__tmtGame.aiming.selection'), null);
    await frame.waitFor({ state: 'hidden' });
    // Looking at the hidden enemy cannot reveal it or make clicking/Tab target it.
    await page.evaluate('window.__tmtFluids.lookAt(window.__tmtGame.snapshot.tanks[1].position, 5, 5)');
    await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const hiddenTarget = await page.evaluate('window.__tmtVisibility.project(window.__tmtGame.snapshot.tanks[1].position)') as [number, number];
    assert.ok(hiddenTarget); await page.mouse.click(...hiddenTarget);
    assert.equal(await page.evaluate('window.__tmtGame.aiming.selection?.object?.id ?? null'), null);
    await page.screenshot({ path: join(out, 'dev-fog-hidden-target.png') });
    await page.evaluate(home => (window as any).__tmtFluids.lookAt(home, 5, 0), home);
    await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await page.evaluate('window.__tmtVisuals.placeTank()');
    await page.waitForFunction('window.__tmtVisuals.aimTargets().some(t => t.id === "tank:1")');
    assert.equal(await page.evaluate('window.__tmtGame.aiming.selection?.object?.id ?? null'), null);
    await page.locator('#viewport').focus(); await page.keyboard.press('Tab');
    await page.waitForFunction('window.__tmtGame.aiming.selection?.object?.id === "tank:1"');
    checks.push('Forced dev fog drops lost contacts; hidden enemies reject Tab/clicks; restored contacts require fresh selection');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#viewport').dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 102 });
    await page.locator('#target-cycle').waitFor({ state: 'visible' });
    await page.locator('#munition-cycle').waitFor({ state: 'visible' });
    await page.screenshot({ path: join(out, 'dev-target-touch.png') });
    checks.push('Dev mobile target and ammunition controls remain accessible');
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, output: out }, null, 2));
} catch (error) {
  await page.screenshot({ path: join(out, 'verification-failure.png') }).catch(() => {});
  throw error;
} finally {
  writeFileSync(join(out, devOnly ? 'verification-dev.json' : phoneOnly ? 'verification-phone.json' : 'verification.json'), JSON.stringify({ checks, measurements, errors }, null, 2));
  writeFileSync(join(out, 'browser-errors.json'), JSON.stringify(errors, null, 2));
  await browser.close(); await server.close();
}
