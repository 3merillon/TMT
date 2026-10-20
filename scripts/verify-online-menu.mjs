import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
const executablePath = [process.env.TMT_CHROME, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium'].find(p => p && existsSync(p));
const base = process.env.TMT_ONLINE_TEST_URL || 'http://127.0.0.1:5173', output = 'artifacts/online-menu';
const testSeed = process.env.TEST_SEED === undefined ? undefined : Number(process.env.TEST_SEED);
if (testSeed !== undefined) assert.ok(Number.isInteger(testSeed) && testSeed >= 0 && testSeed <= 0xffffffff, 'TEST_SEED must be an unsigned 32-bit integer');
const browser = await chromium.launch({ executablePath, headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu', '--disable-features=WebRtcHideLocalIpsWithMdns', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
const errors = [], warnings = [], expectedNetworkErrors = [], intentionallyOfflinePages = new WeakSet();
await mkdir(output, { recursive: true });
async function player(name, mobile = false) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1100, height: 850 }, isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', m => {
    if (m.type() === 'error' && !m.text().includes('403')) {
      if (intentionallyOfflinePages.has(page) && /ERR_INTERNET_DISCONNECTED|WebSocket.*closed/i.test(m.text())) expectedNetworkErrors.push(m.text());
      else errors.push(m.text());
    }
    if (m.type() === 'warning') warnings.push(m.text());
  });
  await page.goto(`${base}/?screen=${testSeed === undefined ? 'online' : 'title'}${mobile ? '&touch=1' : ''}`);
  if (testSeed !== undefined) {
    await page.locator('#title-skirmish').click();
    await page.locator('#skirmish-seed').fill(String(testSeed)); await page.locator('#skirmish-seed').press('Tab');
    await page.locator('#skirmish-back').click(); await page.locator('#title-online').click();
  }
  await page.locator('#online-name').waitFor({ timeout: 60000 });
  await page.evaluate(async () => { window.__onlineSession = (await import('/src/game/api/session.ts')).session; });
  await page.locator('#online-name').fill(name);
  assert.equal(await page.locator('#online-connect').count(), 0);
  assert.equal(await page.locator('input[type=password]').evaluateAll(inputs => inputs.every(input => input.form)), true);
  return { page, context };
}
async function create(page) {
  await page.locator('#online-open-create').click();
  await page.locator('#online-host-password').fill('menu test');
  await page.screenshot({ path: `${output}/create.png` });
  await page.locator('#online-create').click();
  await page.locator('#online-room-code').waitFor();
  assert.equal(await page.locator('#online-start').isDisabled(), true);
  assert.match(await page.locator('#online-action-hint').innerText(), /Waiting for 1 more player/);
  return page.locator('#online-room-code').innerText();
}
async function join(page, code) {
  await page.locator('#online-open-join').click();
  await page.locator('#online-code').fill(code);
  await page.locator('#online-join-password').fill('menu test');
  await page.locator('#online-join-password').press('Enter');
  await page.locator('#online-room-code').waitFor();
  assert.equal(await page.locator('#online-room-code').innerText(), code);
  assert.equal(new URL(page.url()).searchParams.has('online-join-password'), false);
}
async function worldProgress(page) {
  return page.evaluate(() => {
    const game = window.__onlineSession?.();
    if (!game) return null;
    const started = game.startupProgress.startedAt;
    return { ready: game.ready, tick: game.snapshot?.tick, seed: game.network?.room?.setup.seed,
      stage: game.startupProgress.stage, status: game.network?.status, screen: document.querySelector('#game')?.getAttribute('data-screen'),
      elapsedMs: Math.round(performance.now() - started), visibility: document.visibilityState,
      completedStages: performance.getEntriesByType('measure').filter(entry => entry.name.startsWith('tmt:') && entry.startTime >= started)
        .slice(-12).map(entry => ({ name: entry.name, durationMs: Math.round(entry.duration) })) };
  }).then(progress => ({ ...progress, workers: page.workers().length })).catch(() => null);
}
async function start(host, guest) {
  await host.waitForFunction(() => document.querySelector('#online-start')?.disabled === false);
  const bounds = await host.locator('#online-start').boundingBox();
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= (await host.evaluate(() => innerHeight)), 'Start stays in the visible footer');
  await guest.screenshot({ path: `${output}/mobile-lobby.png` });
  await host.screenshot({ path: `${output}/lobby.png` });
  await host.locator('#online-start').click();
  console.log('starting online world', await host.evaluate(() => ({ seed: window.__onlineSession().network?.room?.setup.seed })));
  const progress = setInterval(async () => console.log('world load', JSON.stringify(await Promise.all([host, guest].map(worldProgress)))), 10000);
  try { await Promise.all([host, guest].map(page => page.waitForFunction(() => window.__tmtGame?.ready && window.__tmtGame.tick > 5, {}, { timeout: 180000 }))); }
  finally { clearInterval(progress); }
}
try {
  const a = await player('Host'), b = await player('Friend', true);
  await a.page.screenshot({ path: `${output}/home.png` });
  await b.page.screenshot({ path: `${output}/mobile-home.png` });
  const code = await create(a.page);
  await b.page.locator('#online-open-join').click();
  await b.page.locator('#online-code').fill(code); await b.page.locator('#online-join-password').fill('wrong');
  await b.page.locator('#online-join-password').press('Enter');
  await b.page.getByRole('alert').filter({ hasText: 'Incorrect password' }).waitFor();
  assert.equal(await b.page.locator('#online-code').inputValue(), code);
  await b.page.locator('#online-back').click();
  await join(b.page, code); await start(a.page, b.page);
  console.log('PASS automatic connection, forms, private invitation, mobile lobby, and manual Start');
  await b.page.evaluate(() => { window.onlineRoutes = []; addEventListener('tmt:navigation', event => window.onlineRoutes.push(event.detail.screen)); });
  const beforeTemporaryDisconnect = await Promise.all([a.page, b.page].map(page => page.evaluate(() => {
    const s = window.__onlineSession(); return { host: s.network.host, epoch: s.network.room.epoch, tick: s.snapshot.tick };
  })));
  assert.equal(beforeTemporaryDisconnect[0].host, true);
  assert.equal(beforeTemporaryDisconnect[1].host, false);
  intentionallyOfflinePages.add(b.page);
  await b.context.setOffline(true);
  await a.page.waitForFunction(epoch => {
    const s = window.__onlineSession(); return s.network?.room?.epoch === epoch && !!s.network.room.reconnectUntil && s.network.room.paused;
  }, beforeTemporaryDisconnect[0].epoch, { timeout: 30000 });
  await b.context.setOffline(false);
  await b.page.waitForFunction(({ epoch, tick }) => {
    const s = window.__onlineSession(); return s.network?.room?.epoch === epoch && s.network?.active && !s.network.room.reconnectUntil
      && !s.network.room.paused && !s.network.host && s.ready && s.snapshot?.tick > tick;
  }, { epoch: beforeTemporaryDisconnect[1].epoch, tick: beforeTemporaryDisconnect[1].tick }, { timeout: 30000 });
  intentionallyOfflinePages.delete(b.page);
  await a.page.waitForFunction(({ epoch, tick }) => {
    const s = window.__onlineSession(); return s.network?.room?.epoch === epoch && s.network?.active && s.network.host
      && !s.network.room.reconnectUntil && !s.network.room.paused && s.ready && s.snapshot?.tick > tick;
  }, { epoch: beforeTemporaryDisconnect[0].epoch, tick: beforeTemporaryDisconnect[0].tick }, { timeout: 30000 });
  assert.equal(await b.page.evaluate(() => window.onlineRoutes.includes('loading')), false);
  console.log('PASS temporary signaling disconnect pauses 1v1 and resumes the same host/epoch/world');
  await a.context.close();
  await b.page.waitForFunction(() => document.querySelector('.online-presence')?.textContent.includes('Opponent disconnected'), {}, { timeout: 25000 });
  assert.equal(await b.page.evaluate(() => window.onlineRoutes.includes('loading')), false);
  console.log('PASS closed host waits without a world rebuild; checking the three-minute deadline');
  await b.page.locator('#results').waitFor({ timeout: 190000 });
  assert.match(await b.page.locator('#results').innerText(), /did not return/);
  assert.equal(await b.page.evaluate(() => window.onlineRoutes.includes('loading')), false);
  await b.page.screenshot({ path: `${output}/disconnected.png`, animations: 'disabled' });
  for (const action of ['#results-rematch', '#results-online']) {
    assert.equal(await b.page.locator(action).evaluate(button => {
      const bounds = button.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight && button.scrollWidth <= button.clientWidth;
    }), true, `${action} stays readable and within the mobile viewport`);
  }
  await b.page.locator('#results-online').click();
  await b.page.locator('#online-open-create').waitFor();
  const next = await create(b.page), c = await player('New opponent');
  await join(c.page, next); await start(b.page, c.page);
  await c.page.locator('.online-presence button').filter({ hasText: /^Server$/ }).click();
  await c.page.locator('#online-leave').click();
  await b.page.locator('#results').waitFor({ timeout: 10000 });
  assert.match(await b.page.locator('#results').innerText(), /opponent left/);
  assert.ok(!warnings.some(m => /Password field|powerPreference|device lost \(destroyed\)/.test(m)), warnings.join('\n'));
  assert.deepEqual(errors, []);
  await writeFile(`${output}/result.json`, JSON.stringify({ passed: true, temporaryDisconnectResume: true, temporaryDisconnectPreservedEpoch: beforeTemporaryDisconnect[0].epoch,
    testSeed, expectedNetworkErrors, closedHostTimeout: true, freshMatchAfterTimeout: true, explicitLeave: true, errors, warnings }, null, 2));
  console.log('PASS disconnect result, fresh match after timeout, immediate explicit-leave result, and clean console');
} catch (error) {
  const pages = browser.contexts().flatMap(context => context.pages()), progress = await Promise.all(pages.map(worldProgress));
  console.log('Browser diagnostics', JSON.stringify({ errors, warnings, progress }));
  await writeFile(`${output}/result.json`, JSON.stringify({ passed: false, testSeed, error: error.message, errors, warnings, progress }, null, 2));
  for (const [i, page] of pages.entries()) await page.screenshot({ path: `${output}/failure-${i}.png` }).catch(() => {});
  throw error;
} finally { await browser.close(); }
