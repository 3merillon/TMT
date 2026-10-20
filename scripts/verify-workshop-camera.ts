/** Real UI regression for installed/candidate framing and accessory visibility. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import { defaultProfile, PROFILE_KEY } from '../src/game/meta/profile';
import { graphicsPreset } from '../src/game/meta/settings';

const root = resolve('.'), out = join(root, 'artifacts/tank-designs/camera');
const errors: string[] = [], checks: unknown[] = [];
let browser: Browser | undefined, vite: ViteDevServer | undefined;
mkdirSync(out, { recursive: true });
try {
  vite = await createServer({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn', cacheDir: join(root, '.vite-capture/workshop-camera'), server: { host: '127.0.0.1', port: 0, open: false, hmr: false, watch: null } }); await vite.listen();
  const store = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  const executablePath = process.env.TMT_CHROME ?? readdirSync(store).filter(n => /^chromium-\d+$/.test(n)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])).map(n => join(store, n, 'chrome-win64/chrome.exe')).find(existsSync);
  assert.ok(executablePath);
  browser = await chromium.launch({ executablePath, headless: true, ignoreDefaultArgs: ['--headless'], args: ['--headless=new', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu', '--force-color-profile=srgb', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  await context.route(/\/favicon\.ico/, r => r.fulfill({ status: 204, body: '' }));
  const profile = defaultProfile(); profile.settings.graphics = graphicsPreset('low');
  await context.addInitScript(({ key, value }) => { if (!localStorage.getItem(key)) localStorage.setItem(key, value); }, { key: PROFILE_KEY, value: JSON.stringify(profile) });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.stack ?? e.message)); page.on('console', e => { if (e.type() === 'error') errors.push(e.text()); });
  const settle = () => page.waitForTimeout(1000);
  const camera = () => page.evaluate('window.__tmtWorkshop.camera') as Promise<{ position: number[]; target: number[] }>;
  const yaw = (c: { position: number[]; target: number[] }) => Math.atan2(c.position[0] - c.target[0], c.position[2] - c.target[2]);
  const shot = async (name: string) => { await page.mouse.move(1530, 40); await page.screenshot({ path: join(out, `${name}.png`) }); };
  const close = async () => { const button = page.locator('.ws-panel-head .ws-close').first(); if (await button.isVisible()) await button.click(); await settle(); };
  const utility = async () => { if (!await page.locator('#workshop-slot-utility').isVisible()) await page.locator('#workshop-open-components').click(); await page.locator('#workshop-slot-utility').click(); await settle(); };
  await page.goto(`${vite.resolvedUrls!.local[0]}play.html`, { waitUntil: 'domcontentloaded' }); await page.locator('#title-workshop').click();
  await page.waitForFunction('window.__tmtWorkshop?.ready && !document.querySelector(".ws-loading")', undefined, { timeout: 120000 }); await settle();
  assert.equal(await page.evaluate('window.__tmtWorkshop.engine.services.settings.renderScale'), .5);
  await page.locator('#workshop-open-options').click(); await page.locator('#workshop-quick-install').check(); await close();
  await utility(); const focused = await camera(); assert.ok(Math.abs(yaw(focused) + .42) < .015);
  await page.locator('#workshop-part-radar').click(); await settle(); const preview = await camera(); assert.ok(Math.abs(yaw(preview) - yaw(focused)) < .015); assert.ok(preview.target[0] < -2);
  await shot('candidate-radar-consistent-angle');
  await page.locator('#workshop-part-periscope').click(); await settle(); const next = await camera(); assert.ok(Math.abs(yaw(next) - yaw(preview)) < .015);
  await close(); const dismissed = await camera(); assert.ok(Math.abs(dismissed.target[0]) < .01 && Math.abs(dismissed.target[2]) < .01);
  await page.getByRole('button', { name: 'Discard', exact: true }).click(); await settle(); const discarded = await camera(); assert.ok(Math.abs(discarded.target[0]) < .01 && Math.abs(discarded.target[2]) < .01);
  await shot('dismissed-preview-centered'); checks.push({ name: 'candidate changes retain service angle; drawer close and discard center installed tank', focused, preview, next, dismissed, discarded });
  await utility(); await page.locator('#workshop-part-radar').click(); await page.locator('#workshop-install').click();
  await page.waitForFunction('window.__tmtWorkshop.kit.utility==="radar" && !window.__tmtWorkshop.busy'); await settle(); const installed = await camera(); assert.ok(Math.abs(installed.target[0]) < 1 && Math.abs(yaw(installed) + .42) < .02);
  await shot('radar-installed-focused'); await utility();
  await page.mouse.move(850, 580); await page.mouse.wheel(0, -1000); await settle();
  const visible = await page.evaluate(() => { const p = window.__tmtWorkshop!, point = p.components.utility; let hits = 0; for (let dy = -36; dy <= 36; dy += 12) for (let dx = -36; dx <= 36; dx += 12) if (p.paintTarget(point.x + dx, point.y + dy)?.slot === 'utility') hits++; return { point, hits, camera: p.camera }; });
  assert.ok(visible.point.visible); assert.ok(visible.hits >= 2, 'Accessory must expose real unoccluded paintable triangles at close zoom');
  await shot('radar-close-unoccluded'); checks.push({ name: 'installed radar and close inspection avoid real room/mechanism occlusion', installed, visible });
  await close(); const done = await camera(); assert.ok(Math.abs(done.target[0]) < .01 && Math.abs(done.target[2]) < .01);
  await page.locator('#workshop-view-front').click(); await settle(); await page.mouse.move(850, 580); await page.mouse.wheel(0, -250); await settle(); const manual = await camera();
  await page.locator('#workshop-open-options').click(); await close(); const afterOptions = await camera(); assert.ok(Math.hypot(...manual.position.map((v, i) => v - afterOptions.position[i])) < .02, 'Closing unrelated options preserves manual framing');
  checks.push({ name: 'finished preview centers tank; unrelated panel preserves manual view', done, manual, afterOptions });
  for (const tier of ['high', 'low']) {
    await page.evaluate(`import('/src/game/meta/settings.ts').then(m=>m.dispatchSettings({...m.currentSettings(),graphics:m.graphicsPreset('${tier}')}))`);
    await settle();
    const quality = await page.evaluate(() => { const w = window.__tmtWorkshop!, s = w.engine.services, room = s.scene.get('interior')!, l = s.scene.get('lighting')!;
      return { renderScale: s.settings.renderScale, shadows: l.toggles.localShadows, ao: l.ao, fog: room.fogDensity, rays: room.fan?.strength, engine: w.engine.telemetry() }; });
    assert.equal(quality.renderScale, tier === 'low' ? .5 : 1); assert.equal(quality.shadows, tier === 'high'); assert.equal(quality.ao, tier === 'high');
    if (tier === 'low') { assert.equal(quality.fog, 0); assert.equal(quality.rays, 0); }
    assert.equal(quality.engine.validationErrors, 0); checks.push({ name: `live ${tier} workshop graphics`, quality });
    await shot(`graphics-${tier}`);
  }
  await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate('window.__tmtWorkshop.setView("hero")'); await settle();
  await page.screenshot({ path: join(out, 'mobile-low.png') });
  checks.push({ name: 'phone layout with Low settings', camera: await camera() });
  const shaders = await page.evaluate('window.__tmtWorkshop.shaderCheck()') as { ok: boolean }; assert.ok(shaders.ok); assert.deepEqual(errors, []);
} catch (error) { errors.push(error instanceof Error ? error.stack ?? error.message : String(error)); console.error(errors.at(-1)); process.exitCode = 1; }
finally { writeFileSync(join(out, 'report.json'), JSON.stringify({ checks, errors }, null, 2)); await browser?.close(); await vite?.close(); console.log(JSON.stringify({ checks: checks.length, errors: errors.length, out })); }
