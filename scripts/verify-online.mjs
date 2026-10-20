import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
const executablePath = [process.env.TMT_CHROME, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p => p && existsSync(p));
if (!executablePath) throw new Error('Set TMT_CHROME to a Chromium browser with WebGPU support.');
const mode = process.env.TEST_MODE || 'realtime', count = Number(process.env.TEST_PLAYERS || 2);
assert.ok(['duel', 'artillery', 'realtime', 'coop'].includes(mode)); assert.ok(count === 2 || count === 3);
const output = `artifacts/online/${mode}-${count}`;
const base = process.env.TMT_ONLINE_TEST_URL || 'http://127.0.0.1:5173';
const launchOptions = { executablePath, headless: true,
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu', '--disable-features=WebRtcHideLocalIpsWithMdns', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] };
const browser = await chromium.launch(launchOptions), browsers = [browser];
const pages = [], errors = [], expectedNetworkErrors = [], disconnected = new Set(), stateRequests = [];
let mobileTouchResult = null;
await mkdir(output, { recursive: true });
async function qualifyTitle(page, device) {
  await page.locator('.title-footer').waitFor();
  const expected = {
    'title-donate': 'https://buy.stripe.com/3cIcN77Lg7xv2g68sQdnW00',
    'title-creator': 'https://x.com/3merillon',
    'title-website': 'https://3merillon.com',
  };
  for (const [id, href] of Object.entries(expected)) assert.equal(await page.locator(`#${id}`).getAttribute('href'), href, `${id} destination`);
  await page.screenshot({ path: `${output}/title-${device}-top.png` });
  // Scroll to the final footer link; earlier links can already be partly visible
  // at the lower edge on a phone and therefore won't necessarily scroll.
  await page.locator('#title-website').scrollIntoViewIfNeeded();
  const footer = await page.locator('.title-footer').boundingBox();
  const lastLink = await page.locator('#title-website').boundingBox();
  assert.ok(footer && lastLink && lastLink.y >= 0 && lastLink.y + lastLink.height <= await page.evaluate(() => innerHeight), `${device} footer remains reachable and its final link is visible when scrolled`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    && document.querySelector('.screens')?.scrollWidth <= document.querySelector('.screens')?.clientWidth), true, `${device} title has no horizontal overflow`);
  await page.screenshot({ path: `${output}/title-${device}-footer.png` });
  if (device === 'desktop') {
    await page.locator('#title-engine-dev').focus(); await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'title-donate', 'keyboard tab reaches the Donate link');
    assert.notEqual(await page.locator('#title-donate').evaluate(a => getComputedStyle(a).outlineStyle), 'none', 'keyboard focus has a visible outline');
    const href = expected['title-donate'];
    const popupPromise = page.waitForEvent('popup');
    const requestPromise = page.context().waitForEvent('request', request => request.isNavigationRequest() && request.url() === href);
    await page.locator('#title-donate').click();
    const [popup, request] = await Promise.all([popupPromise, requestPromise]);
    assert.equal(request.url(), href, 'Donate opens the direct Stripe link in a new tab');
    await popup.close();
  }
  await page.locator('#title-online').scrollIntoViewIfNeeded();
}
try {
  for (let i = 0; i < count; i++) {
    const instance = i > 0 && (count === 3 || process.env.TEST_SEPARATE_BROWSERS) ? await chromium.launch(launchOptions) : browser;
    if (instance !== browser) browsers.push(instance);
    const context = await instance.newContext({ viewport: i === 1 ? { width: 390, height: 844 } : { width: 1100, height: 800 }, hasTouch: i === 1, isMobile: i === 1 });
    const page = await context.newPage(); pages.push(page);
    stateRequests[i] = 0;
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/online/state') stateRequests[i]++; });
    page.on('pageerror', error => errors.push({ player: i, message: error.message }));
    page.on('response', async response => {
      if (response.status() >= 400 && response.url().includes('/api/online/')) {
        const path = new URL(response.url()).pathname;
        console.log('API rejection', { player: i, path, status: response.status(), response: await response.text().catch(() => '') });
      }
    });
    page.on('console', message => { if (message.type() === 'error') { const error = { player: i, console: message.text().slice(0, 1000) }; if (disconnected.has(i) && message.text().includes('net::ERR_INTERNET_DISCONNECTED')) expectedNetworkErrors.push(error); else errors.push(error); } });
    await page.goto(`${base}/play.html${i === 1 ? '?touch=1' : ''}`, { waitUntil: 'domcontentloaded' });
    await page.locator('#title-online').waitFor({ timeout: 60000 });
    await qualifyTitle(page, i === 1 ? 'mobile' : 'desktop');
    if (i === 0) {
      await page.locator('#title-skirmish').click();
      await page.locator('#skirmish-seed').fill('7'); await page.locator('#skirmish-seed').press('Tab');
      await page.evaluate(() => { window.seedNode = document.querySelector('#skirmish-seed'); });
      await page.locator('#skirmish-tanks [data-value="4"]').click();
      await page.locator('#skirmish-teams [data-value="2v2"]').click();
      assert.equal(await page.evaluate(() => document.querySelector('#skirmish-seed') === window.seedNode), true, 'setup buttons retain the existing menu DOM');
      assert.equal(await page.locator('#skirmish-seed').inputValue(), '7');
      await page.locator('#skirmish-tanks [data-value="2"]').click();
      await page.locator('#skirmish-back').click();
    }
    await page.evaluate(async () => { window.__onlineSession = (await import('/src/game/api/session.ts')).session; });
    await page.locator('#title-online').click();
    await page.locator('#online-name').fill(`Test ${i + 1}`);
  }
  console.log('browser menus ready; actions connect automatically');
  const host = pages[0];
  await host.locator('#online-quick').click();
  const queueStatus = /Finding (?:turn-based artillery|realtime artillery|realtime PvP)/;
  await host.waitForFunction(() => /Finding (?:turn-based artillery|realtime artillery|realtime PvP)/.test(document.querySelector('.online-presence')?.textContent ?? ''));
  const queuedRoom = await host.locator('#online-room-code').innerText();
  for (const menu of ['Settings', 'Workshop']) {
    await host.locator('#online .card-actions').getByRole('button', { name: menu, exact: true }).click();
    await host.waitForFunction(name => document.querySelector('#game')?.getAttribute('data-screen') === name, menu.toLowerCase());
    await host.waitForTimeout(1200);
    assert.match(await host.locator('.online-presence').innerText(), queueStatus);
    await host.locator('.online-presence button').filter({ hasText: /^Server$/ }).click();
    assert.equal(await host.locator('#online-room-code').innerText(), queuedRoom);
  }
  await host.locator('#online-leave').click();
  await host.locator('#online-open-create').waitFor();
  console.log('seamless setup and queue across Settings and Workshop passed');
  await host.locator('#online-open-create').click();
  await host.locator('#online-mode').selectOption(mode);
  await host.locator('#online-capacity').selectOption(String(count));
  await host.locator('#online-host-password').fill('test gate');
  await host.locator('#online-visibility').selectOption('friends');
  await host.locator('#online-create').click();
  await host.locator('.online-room h3').waitFor();
  const code = await host.locator('#online-room-code').innerText();
  for (const page of pages.slice(1)) {
    await page.locator('#online-open-join').click();
    await page.locator('#online-code').fill(code);
    await page.locator('#online-join-password').fill('test gate');
    await page.locator('#online-join').click();
    await page.locator('.online-room h3').waitFor();
  }
  await host.waitForFunction(() => !document.querySelector('#online-start')?.disabled);
  console.log('password room filled', code);
  await host.locator('#online-start').click();
  const progress = setInterval(async () => console.log('progress', await Promise.all(pages.map(page => page.evaluate(async () => { const s = (await import('/src/game/api/session.ts')).session(); return { ready:s.ready,tick:s.snapshot?.tick,startup:s.startupProgress.stage,network:s.network?.status, error:s.network?.client().state.error, connections:s.network?.peers.size }; }).catch(() => null)))), 10000);
  try { await Promise.all(pages.map(page => page.waitForFunction(() => window.__tmtGame?.ready && window.__tmtGame?.tick > 5, { }, { timeout: 180000 }))); } finally { clearInterval(progress); }
  console.log('all worlds ready');
  if (process.env.TEST_BACKEND?.includes('cloudflare')) {
    await Promise.all(pages.map(page => page.waitForFunction(() => window.__onlineSession().network?.client().channel?.connected)));
    const before = [...stateRequests]; await host.waitForTimeout(4500);
    assert.deepEqual(stateRequests, before, 'stable Cloudflare matches use socket heartbeats instead of HTTP polling');
    console.log('all room sockets active; stable match has no HTTP state polling');
  }
  const positions = await Promise.all(pages.map(page => page.evaluate(() => window.__tmtGame.snapshot.tanks.map(t => t.position))));
  console.log('initial positions', JSON.stringify(positions));
  if (mode === 'duel') {
    await pages[1].evaluate(async () => { const s = (await import('/src/game/api/session.ts')).session(); s.command(1, { k: 'drive', throttle: 1, steer: 0 }); });
    await pages[1].keyboard.down('KeyW'); await pages[1].waitForTimeout(1100); await pages[1].keyboard.up('KeyW');
  } else {
    await Promise.all(pages.map(page => page.keyboard.down('KeyW')));
    await pages[0].waitForTimeout(1100);
    await Promise.all(pages.map(page => page.keyboard.up('KeyW')));
  }
  const after = await Promise.all(pages.map(page => page.evaluate(() => ({ tick: window.__tmtGame.tick, tanks: window.__tmtGame.snapshot.tanks.map(t => ({ id: t.id, health: t.health, position: t.position })) }))));
  console.log('replication after driving', JSON.stringify(after));
  if (mode !== 'duel') for (let seat = 0; seat < count; seat++) {
    assert.ok(Math.hypot(...after[0].tanks[seat].position.map((v,i) => v - positions[0][seat][i])) > .5, `seat ${seat} moves on the host world`);
  }
  // Dragging the roster changes the camera without opening it; a tap opens it exactly once.
  const mobile = pages[1], cdp = await mobile.context().newCDPSession(mobile), box = await mobile.locator('#roster').boundingBox();
  const camera = await mobile.evaluate(() => JSON.stringify(window.__tmtGame.camera));
  await cdp.send('Input.dispatchTouchEvent', { type:'touchStart', touchPoints:[{x:box.x+20,y:box.y+15,id:1}] });
  for (let n=1;n<=6;n++) await cdp.send('Input.dispatchTouchEvent', { type:'touchMove', touchPoints:[{x:box.x+20+n*10,y:box.y+15+n*5,id:1}] });
  await cdp.send('Input.dispatchTouchEvent', { type:'touchEnd', touchPoints:[] });
  await mobile.waitForTimeout(150);
  assert.notEqual(await mobile.evaluate(() => JSON.stringify(window.__tmtGame.camera)), camera);
  await mobile.locator('#roster').tap();
  assert.equal(await mobile.locator('#match-info').isVisible(), true);
  await mobile.locator('#roster').tap();
  // Record authoritative and replicated shot events so simultaneous modes prove every human can fire.
  await host.evaluate(async () => {
    const s = (await import('/src/game/api/session.ts')).session(); window.__onlineShots = [];
    s.on('event', event => { if (event?.type === 'shot') window.__onlineShots.push(event); });
  });
  const beforeTerrain = await host.evaluate(() => window.__tmtGame.resident.history.length);
  if (mode === 'duel') {
    const fired = await host.evaluate(async () => { const s = (await import('/src/game/api/session.ts')).session(); s.command(s.observer,{k:'aim',yaw:1.3,pitch:.25,power:.35}); return s.command(s.observer,{k:'fire'}); });
    assert.equal(fired, true);
  } else {
    const fireResults = await Promise.all(pages.map((page, seat) => page.evaluate(async seat => {
      const s = (await import('/src/game/api/session.ts')).session(); s.command(s.observer, { k:'aim', yaw:1.3 + seat * .04, pitch:.25, power:.35 });
      return { seat: s.observer, fired: s.command(s.observer, { k:'fire' }) };
    }, seat)));
    assert.ok(fireResults.every(result => result.fired), `all seats fired: ${JSON.stringify(fireResults)}`);
    await host.waitForFunction(seats => {
      const players = new Set(window.__onlineShots.map(event => event.player)); return seats.every(seat => players.has(seat));
    }, Array.from({ length: count }, (_, seat) => seat), { timeout:30000 });
    console.log('host received shot events from every human seat', await host.evaluate(() => window.__onlineShots.map(event => event.player)));
  }
  await Promise.all(pages.map(page => page.waitForFunction(n => window.__tmtGame.resident.history.length > n, beforeTerrain, { timeout:30000 })));
  console.log('authoritative projectile and terrain edit replicated');
  if (mode !== 'duel') {
    // Exercise touch drive and aim together, then activate Fire with an actual touch after the reload completes.
    await mobile.waitForFunction(() => {
      const s = window.__onlineSession(), button = document.querySelector('#fire');
      return !!s.canFire?.(s.observer) && !!button && !button.disabled;
    }, {}, { timeout:90000 });
    const [stick, canvas, fire] = await Promise.all(['#stick-base', '#viewport canvas', '#fire'].map(selector => mobile.locator(selector).boundingBox()));
    assert.ok(stick && canvas && fire, 'mobile joystick, battlefield and Fire button are visible');
    assert.equal(await mobile.locator('#fire').isDisabled(), false, 'the mobile Fire button is ready after reload');
    // Find an actual raycastable world point, then project that hit back to the
    // battlefield so the second finger cannot accidentally tap sky or an overlay.
    const touchAim = await mobile.evaluate(() => {
      const s = window.__onlineSession(), canvas = document.querySelector('#viewport canvas'), rect = canvas.getBoundingClientRect();
      for (const [fx, fy] of [[.7,.58],[.3,.58],[.5,.68],[.72,.42],[.28,.42],[.5,.5],[.4,.75],[.6,.75]]) {
        const selection = s.view.pickAimTarget([rect.width * fx, rect.height * fy]);
        if (!selection?.point) continue;
        const projected = s.view.worldToScreen(selection.point);
        if (!projected) continue;
        const recheck = s.view.pickAimTarget(projected);
        if (recheck?.point) return { x: rect.left + projected[0], y: rect.top + projected[1], point: selection.point, object: selection.object?.id ?? null };
      }
      return null;
    });
    assert.ok(touchAim, 'a visible, raycastable ground or tank point is available for touch aim');
    const beforeTouch = await mobile.evaluate(() => { const s = window.__onlineSession(); const t = s.snapshot.tanks[s.observer]; return { position: [...t.position], yaw: t.turretYaw, pitch: t.barrelPitch }; });
    const beforeTouchShots = await host.evaluate(() => window.__onlineShots.length);
    const stickPoint = { x: stick.x + stick.width / 2, y: stick.y + stick.height / 2, id: 21 };
    const drivePoint = { ...stickPoint, y: stickPoint.y - Math.min(52, stick.height * .38) };
    const aimPoint = { x: touchAim.x, y: touchAim.y, id: 22 };
    await mobile.evaluate(() => {
      window.__touchTestEvents = [];
      for (const type of ['touchstart','touchend','pointerdown','pointermove','pointerup','pointercancel','click']) window.addEventListener(type, event => {
        window.__touchTestEvents.push({ type, target: event.target?.id || event.target?.tagName, pointerType: event.pointerType, pointerId: event.pointerId,
          x: event.clientX, y: event.clientY, activeTouches: event.touches?.length, trusted: event.isTrusted });
      }, true);
    });
    await mobile.screenshot({ path: `${output}/mobile-touch-before.png` });
    console.log('touch aim hit', JSON.stringify(touchAim));
    await cdp.send('Input.dispatchTouchEvent', { type:'touchStart', touchPoints:[stickPoint] });
    await cdp.send('Input.dispatchTouchEvent', { type:'touchMove', touchPoints:[drivePoint] });
    await cdp.send('Input.dispatchTouchEvent', { type:'touchStart', touchPoints:[drivePoint, aimPoint] });
    // TouchEnd lists the points to release (the remaining point stays active).
    // Releasing the aim finger alone keeps the joystick held throughout.
    await cdp.send('Input.dispatchTouchEvent', { type:'touchEnd', touchPoints:[aimPoint] });
    await mobile.screenshot({ path: `${output}/mobile-touch-after-aim.png` });
    console.log('touch input events after aim tap', JSON.stringify(await mobile.evaluate(() => window.__touchTestEvents)));
    await mobile.waitForFunction(before => {
      const s = window.__onlineSession(), t = s.snapshot.tanks[s.observer];
      return Math.abs(t.turretYaw - before.yaw) + Math.abs(t.barrelPitch - before.pitch) > .01;
    }, beforeTouch, { timeout:10000 });
    // Let the first aim resolve, then tap the battlefield and Fire immediately
    // with another finger while the joystick remains held. This catches a
    // cross-finger ghost-click filter suppressing the Fire button activation.
    await cdp.send('Input.dispatchTouchEvent', { type:'touchStart', touchPoints:[drivePoint, { ...aimPoint, id:24 }] });
    await cdp.send('Input.dispatchTouchEvent', { type:'touchEnd', touchPoints:[{ ...aimPoint, id:24 }] });
    const aimTapEndedAt = Date.now();
    const firePoint = { x: fire.x + fire.width / 2, y: fire.y + fire.height / 2, id: 23 };
    await cdp.send('Input.dispatchTouchEvent', { type:'touchStart', touchPoints:[drivePoint, firePoint] });
    await cdp.send('Input.dispatchTouchEvent', { type:'touchEnd', touchPoints:[firePoint] });
    const aimToFireMs = Date.now() - aimTapEndedAt;
    assert.ok(aimToFireMs < 500, `second-finger Fire tap follows battlefield aim in ${aimToFireMs}ms`);
    await cdp.send('Input.dispatchTouchEvent', { type:'touchEnd', touchPoints:[] });
    await host.waitForFunction(({ seat, count }) => window.__onlineShots.slice(count).some(event => event.player === seat), { seat:1, count:beforeTouchShots }, { timeout:30000 });
    const afterTouch = await mobile.evaluate(() => { const s = window.__onlineSession(); const t = s.snapshot.tanks[s.observer]; return { position: [...t.position], yaw: t.turretYaw, pitch: t.barrelPitch }; });
    assert.ok(Math.hypot(...afterTouch.position.map((value, axis) => value - beforeTouch.position[axis])) > .1, 'held touch joystick drives the mobile tank while aiming');
    mobileTouchResult = { before: beforeTouch, after: afterTouch, aimToFireMs,
      aimTouchEndWithStickHeld: await mobile.evaluate(() => window.__touchTestEvents.some(event => event.type === 'touchend' && event.target === 'CANVAS' && event.activeTouches === 1)),
      firePointerUp: await mobile.evaluate(() => window.__touchTestEvents.some(event => event.type === 'pointerup' && event.target === 'fire')) };
    console.log('mobile touch joystick, scene aim and Fire button passed', JSON.stringify({ beforeTouch, afterTouch, aimToFireMs }));
  }
  await mobile.mouse.move(0,400);
  await pages[1].screenshot({ path: `${output}/mobile.png` });
  // A real chat round-trip, unread badge, and default filtering.
  await host.locator('#chat-tab').click(); await host.getByRole('textbox', { name: 'Chat message' }).fill('hello f.u.c.k friend');
  await host.locator('.chat-form').getByRole('button', { name: 'Send' }).click();
  await pages[1].waitForFunction(() => document.querySelector('#chat-tab')?.classList.contains('unread'));
  await pages[1].locator('#chat-tab').tap();
  assert.equal(await pages[1].locator('#chat-panel').isVisible(), true);
  assert.match(await pages[1].locator('.chat-log').innerText(), /•/);
  assert.doesNotMatch(await pages[1].locator('.chat-log').innerText(), /f\.u\.c\.k/);
  console.log('chat and unread passed');
  await host.locator('.online-presence button').filter({ hasText: /^Server$/ }).click();
  await host.locator('#online-transfer').click();
  await host.waitForTimeout(2000);
  console.log('transfer status', await host.locator('.online-presence').innerText());
  await Promise.all(pages.map(page => page.waitForFunction(() => { const s = window.__onlineSession(); return s.network?.room?.epoch >= 2 && s.network?.active && s.ready && s.snapshot?.tick > 20; }, {}, { timeout: 180000 })));
  await host.waitForTimeout(1000);
  const authority = await Promise.all(pages.map(page => page.evaluate(async () => { const s = (await import('/src/game/api/session.ts')).session(); return { host: s.network.host, seat: s.observer, tick: s.snapshot.tick, epoch: s.network.room.epoch }; })));
  assert.equal(authority.filter(a => a.host).length, 1); assert.equal(authority[0].host, false);
  console.log('host transfer', JSON.stringify(authority));
  if (process.env.TEST_DISCONNECT) {
    const disconnectedPlayer = authority.findIndex(a => a.host), survivor = (disconnectedPlayer + 1) % pages.length;
    const priorEpoch = authority[disconnectedPlayer].epoch;
    const priorHost = authority[disconnectedPlayer].host;
    await pages[disconnectedPlayer].waitForTimeout(2500);
    disconnected.add(disconnectedPlayer); await pages[disconnectedPlayer].context().setOffline(true);
    const reconnectOnly = count === 2 && mode !== 'coop';
    if (reconnectOnly) {
      await pages[survivor].waitForFunction(epoch => {
        const s = window.__onlineSession(); return s.network?.room?.epoch === epoch && !!s.network.room.reconnectUntil && s.network.room.paused;
      }, priorEpoch, { timeout:90000 });
    } else {
      await pages[survivor].waitForFunction(epoch => {
        const s = window.__onlineSession(); return s.network?.room?.epoch > epoch && s.network?.active && s.ready && s.snapshot?.tick > 20;
      }, priorEpoch, { timeout:90000 });
    }
    await pages[disconnectedPlayer].context().setOffline(false);
    await pages[disconnectedPlayer].waitForFunction(({ epoch, reconnectOnly, priorHost }) => {
      const s = window.__onlineSession(); return s.network?.room?.epoch >= (reconnectOnly ? epoch : epoch + 1)
        && s.network?.host === (reconnectOnly ? priorHost : false) && s.network?.active && !s.network.room.reconnectUntil && !s.network.room.paused && s.ready && s.snapshot?.tick > 20;
    }, { epoch: priorEpoch, reconnectOnly, priorHost }, { timeout:90000 });
    disconnected.delete(disconnectedPlayer);
    console.log(reconnectOnly
      ? '1v1 reconnect pause and reserved-seat resume passed without host election'
      : 'network partition, automatic host election and reserved-seat reconnection passed');
  }
  if (process.env.TEST_RELOAD) {
    const owner = (await Promise.all(pages.map(p => p.evaluate(() => window.__onlineSession().network.host)))).findIndex(Boolean);
    const before = await pages[owner].evaluate(() => ({ epoch: window.__onlineSession().network.room.epoch, tick: window.__onlineSession().snapshot.tick }));
    await pages[owner].waitForTimeout(3500);
    await pages[owner].goto(`${base}/play.html?screen=online`);
    await pages[owner].locator('#online').waitFor({ timeout:60000, state: 'attached' });
    await pages[owner].evaluate(async () => { window.__onlineSession = (await import('/src/game/api/session.ts')).session; });
    await Promise.all(pages.map(p => p.waitForFunction(before => { const s = window.__onlineSession(); return s.network?.room?.epoch > before.epoch && s.network?.active && s.ready && s.snapshot?.tick >= before.tick - 180; }, before, { timeout:180000 })));
    assert.equal(await pages[owner].evaluate(() => window.__onlineSession().network.host), false);
    console.log('host page reload transfers authority and rejoins the existing world');
  }
  assert.deepEqual(errors, []);
  const backendHealth = await host.evaluate(async healthUrl => {
    const response = await fetch(healthUrl), body = await response.json();
    return { httpStatus: response.status, ...body };
  }, new URL('/api/online/health', base).href);
  await writeFile(`${output}/result.json`, JSON.stringify({ mode, players: count, backend: backendHealth.deployment ?? 'unknown', backendHealth, disconnect: !!process.env.TEST_DISCONNECT,
    disconnectPolicy: process.env.TEST_DISCONNECT ? count === 2 && mode !== 'coop' ? 'reconnect-pause' : 'host-election' : null,
    reload: !!process.env.TEST_RELOAD, after, authority, mobileTouch: mobileTouchResult, errors, expectedNetworkErrors }, null, 2));
} catch (error) {
  console.error(error);
  console.error('page errors', JSON.stringify(errors));
  for (let i = 0; i < pages.length; i++) {
    console.error('page', i, await pages[i].evaluate(() => { const s = window.__onlineSession?.(); return { text: document.body.innerText.slice(-5000),
      state: window.__tmtGame && { ready: window.__tmtGame.ready, tick: window.__tmtGame.tick, startup: s?.startupProgress, ui: window.__tmtGame.ui },
      network: s?.network && { active: s.network.active, status: s.network.status, epoch: s.network.room?.epoch, host: s.network.host,
        failed: s.network.failed, loading: s.network.loading, transferring: s.network.transferring, error: s.network.client().state.error } }; }).catch(() => null));
    await pages[i].screenshot({ path: `${output}/failure-${i}.png` }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  for (const page of pages) await page.evaluate(() => window.__onlineSession?.().network?.client().leave()).catch(() => {});
  await Promise.all(browsers.map(b => b.close()));
}
