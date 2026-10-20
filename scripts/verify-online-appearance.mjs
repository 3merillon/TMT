/** Two real browser contexts, public lobby flow, compressed paint exchange and a refreshed guest. Requires dev:online-test. */
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

const base = process.env.TMT_ONLINE_TEST_URL || 'http://127.0.0.1:5174';
const output = 'artifacts/online-appearance';
const executablePath = [process.env.TMT_CHROME, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium'].find(value => value && existsSync(value));
const browser = await chromium.launch({ executablePath, headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu',
  '--disable-features=WebRtcHideLocalIpsWithMdns', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
const errors = [], pages = [];
await mkdir(output, { recursive: true });
async function player(name, color) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 850 } }), page = await context.newPage(); pages.push(page);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${base}/?screen=title`);
  await page.locator('#title-skirmish').waitFor({ timeout: 60000 });
  const fixture = await page.evaluate(async ({ color }) => {
    const { activeKit, browserStorage, readProgress, saveProgress, withAppearance } = await import('/src/game/meta/profile.ts');
    const { equippedAppearance } = await import('/src/game/meta/cosmetics.ts');
    const { PaintSession, DEFAULT_BRUSH } = await import('/src/game/workshop/paint.ts');
    const { componentPaintGeometry, chartTexel } = await import('/src/game/presentation/paint-geometry.ts');
    const { encodeAppearance } = await import('/src/game/online/appearance.ts');
    const storage = browserStorage(), profile = readProgress(storage), kit = activeKit(profile);
    const component = componentPaintGeometry(kit).find(value => value.slot === 'hull' && value.lod === 0);
    const chart = component?.charts.find(value => value.width > 8 && value.height > 8);
    if (!chart) throw Error('No paintable hull chart for browser fixture.');
    const hit = chartTexel(chart, Math.floor(chart.width / 2), Math.floor(chart.height / 2));
    const paint = new PaintSession(equippedAppearance(profile.cosmetics), kit); paint.begin();
    if (!paint.dab({ slot: component.slot, partId: component.partId, group: component.group, position: hit.point, normal: hit.normal },
      { ...DEFAULT_BRUSH, color, radius: .2 })) throw Error('Browser fixture did not paint the hull.');
    paint.end();
    if (!saveProgress(withAppearance(profile, paint.value), storage)) throw Error('Could not persist browser paint fixture.');
    const encoded = await encodeAppearance(paint.value);
    return { id: encoded.id, tiles: paint.value.paintTextures.reduce((sum, layer) => sum + layer.tiles.length, 0), rawBytes: encoded.rawBytes, wireBytes: encoded.data.length };
  }, { color });
  assert.ok(fixture.tiles > 0); await page.reload();
  await page.locator('#title-skirmish').click(); await page.locator('#skirmish-seed').fill('7'); await page.locator('#skirmish-seed').press('Tab');
  await page.locator('#skirmish-back').click(); await page.locator('#title-online').click();
  await page.locator('#online-name').fill(name);
  await page.evaluate(async () => { window.__paintSession = (await import('/src/game/api/session.ts')).session; });
  return { page, context, fixture };
}
async function diagnostics(page) { return page.evaluate(() => ({ seat: window.__paintSession().network?.seat, paint: window.__paintSession().network?.appearanceDiagnostics() })); }
async function waitPaint(page) {
  await page.waitForFunction(() => {
    const diagnostics = window.__paintSession?.().network?.appearanceDiagnostics();
    return diagnostics?.seats.length === 2 && diagnostics.seats.every(seat => seat.loaded) && diagnostics.pending === 0;
  }, {}, { timeout: 30000 });
}
try {
  const host = await player('Paint host', '#df4030'), guest = await player('Paint guest', '#30a8df');
  await host.page.locator('#online-open-create').click(); await host.page.locator('#online-create').click();
  await host.page.locator('#online-room-code').waitFor(); const code = await host.page.locator('#online-room-code').innerText();
  await guest.page.locator('#online-open-join').click(); await guest.page.locator('#online-code').fill(code); await guest.page.locator('#online-code').press('Enter');
  await guest.page.locator('#online-room-code').waitFor();
  await host.page.waitForFunction(() => document.querySelector('#online-start')?.disabled === false);
  console.log('Starting the shared world with two saved painted profiles');
  await host.page.locator('#online-start').click();
  await Promise.all([host.page, guest.page].map(page => page.waitForFunction(() => window.__tmtGame?.ready && window.__tmtGame.tick > 5, {}, { timeout: 180000 })));
  await Promise.all([host.page, guest.page].map(waitPaint));
  const before = await Promise.all([host.page, guest.page].map(diagnostics));
  assert.equal(before[0].seat, 0); assert.equal(before[1].seat, 1);
  for (const report of before) {
    assert.equal(report.paint.seats.find(seat => seat.seat === 0).id, host.fixture.id);
    assert.equal(report.paint.seats.find(seat => seat.seat === 1).id, guest.fixture.id);
    assert.ok(report.paint.receivedBytes > 0); assert.equal(report.paint.error, '');
  }
  for (const [index, player] of [host, guest].entries()) {
    const actual = await player.page.evaluate(() => {
      const game = window.__paintSession();
      return [0, 1].map(id => ({ id, layers: game.view.devControls().vehicleAppearance(id)?.paintTextures?.length ?? 0 }));
    });
    assert.ok(actual.every(value => value.layers > 0), `Rendered paint reaches both seat surfaces in browser ${index}`);
    await player.page.screenshot({ path: `${output}/player-${index}.png` });
  }
  // A refreshed browser has an empty session cache; the surviving host supplies the previously verified assets.
  console.log('Both rendered seat appearances matched; refreshing the guest');
  await guest.page.reload();
  await guest.page.evaluate(async () => { window.__paintSession = (await import('/src/game/api/session.ts')).session; });
  await waitPaint(guest.page);
  const restored = await diagnostics(guest.page);
  assert.equal(restored.seat, 1);
  assert.equal(restored.paint.seats.find(seat => seat.seat === 0).id, host.fixture.id);
  assert.equal(restored.paint.seats.find(seat => seat.seat === 1).id, guest.fixture.id);
  assert.ok(restored.paint.receivedBytes > 0);
  assert.deepEqual(errors, []);
  await writeFile(`${output}/result.json`, JSON.stringify({ passed: true, fixtures: [host.fixture, guest.fixture], before, restored, errors }, null, 2));
  console.log('PASS compressed guest-seat paint, host relay, rendered surfaces, and refreshed-guest transfer');
} catch (error) {
  await writeFile(`${output}/failure.json`, JSON.stringify({ errors, message: String(error), players: await Promise.all(pages.map(page => diagnostics(page).catch(() => null))) }, null, 2));
  for (const [index, page] of pages.entries()) await page.screenshot({ path: `${output}/failure-${index}.png` }).catch(() => {});
  throw error;
} finally { await browser.close(); }
