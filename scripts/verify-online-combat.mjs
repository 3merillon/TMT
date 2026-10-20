/** Real local browsers and WebRTC. Drives the public menus and gameplay commands; never edits match state. */
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

const executablePath = [process.env.TMT_CHROME, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium'].find(p => p && existsSync(p));
if (!executablePath) throw new Error('Set TMT_CHROME to Chromium with WebGPU.');
const mode = process.env.TEST_MODE || 'realtime', count = Number(process.env.TEST_PLAYERS || 2), relay = process.env.TEST_RELAY === '1';
assert.ok(['realtime', 'artillery'].includes(mode)); assert.ok([2, 3].includes(count));
const base = process.env.TMT_ONLINE_TEST_URL || 'http://127.0.0.1:5174', output = `artifacts/online-combat/${mode}-${count}${relay ? '-relay' : ''}`;
// The issuer returns short-lived credentials only to this process. They are never logged or persisted.
let relayServers;
if (relay && process.env.TMT_TEST_TURN_ISSUER) {
  const issuer = process.env.TMT_TEST_TURN_ISSUER.replace(/\/$/, ''), response = await fetch(`${issuer}/api/online/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'TURN validation', protocol: 1, build: 'turn-validation' }),
  });
  if (!response.ok) throw new Error(`TURN credential issuer returned HTTP ${response.status}.`);
  const admission = await response.json(); relayServers = admission.iceServers;
  if (!Array.isArray(relayServers) || !relayServers.some(server => (Array.isArray(server.urls) ? server.urls : [server.urls]).some(url => /^turns?:/i.test(url)))) throw new Error('TURN credential issuer has no usable relay.');
}
await mkdir(output, { recursive: true });
const browsers = [], pages = [], errors = [], shots = [];
const args = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu', '--disable-features=WebRtcHideLocalIpsWithMdns',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const summary = page => page.evaluate(() => {
  const s = window.combatSession(), state = s.snapshot;
  return { phase: state?.phase, tick: state?.tick, winner: state?.winner, health: state?.tanks.map(t => t.health), tanks: state?.tanks.map(t => ({ id: t.id, health: t.health, position: t.position })),
    projectiles: state?.projectiles.map(p => ({ id: p.id, owner: p.owner })), edits: window.__tmtGame?.resident?.history.length,
    epoch: s.network?.room?.epoch, active: s.network?.active, status: s.network?.status, error: s.network?.client().state.error, events: window.combatEvents };
});
async function ready(epoch = 1) {
  await Promise.all(pages.map(p => p.waitForFunction(epoch => { const s = window.combatSession(); return s.ready && s.snapshot?.tick > 5 && s.network?.active && s.network.room.epoch >= epoch; }, epoch, { timeout: 180000 })));
}
try {
  for (let i = 0; i < count; i++) {
    const browser = await chromium.launch({ executablePath, headless: true, args }); browsers.push(browser);
    const context = await browser.newContext({ viewport: { width: 1000, height: 720 } });
    if (relayServers) await context.route(/\/api\/online\/(session|config)$/, async route => {
      const response = await route.fetch(), data = await response.json();
      await route.fulfill({ response, json: { ...data, iceServers: relayServers } });
    });
    const page = await context.newPage(); pages.push(page);
    page.on('pageerror', error => errors.push({ player: i, message: error.message }));
    page.on('console', message => { if (message.type() === 'error') errors.push({ player: i, message: message.text().slice(0, 1000) }); });
    await page.goto(`${base}/play.html${relay ? '?relay=1' : ''}`, { waitUntil: 'domcontentloaded' });
    await page.locator('#title-online').waitFor({ timeout: 60000 });
    await page.evaluate(async () => {
      window.combatSession = (await import('/src/game/api/session.ts')).session;
      window.combatEvents = [];
      window.combatSession().on('event', event => { if (['shot', 'impact', 'kill', 'finish'].includes(event.type)) window.combatEvents.push(structuredClone(event)); });
    });
    if (!i) {
      await page.locator('#title-skirmish').click(); await page.locator('#skirmish-seed').fill('7'); await page.locator('#skirmish-seed').press('Tab');
      await page.locator('#skirmish-back').click();
    }
    await page.locator('#title-online').click(); await page.locator('#online-name').fill(`Combat ${i + 1}`);
  }
  const host = pages[0];
  await host.locator('#online-open-create').click(); await host.locator('#online-mode').selectOption(mode);
  await host.locator('#online-capacity').selectOption(String(count)); await host.locator('#online-host-password').fill('combat-check');
  await host.locator('#online-fog').uncheck(); await host.locator('#online-create').click();
  await host.locator('#online-room-code').waitFor(); const code = await host.locator('#online-room-code').innerText();
  for (const page of pages.slice(1)) {
    await page.locator('#online-open-join').click(); await page.locator('#online-code').fill(code);
    await page.locator('#online-join-password').fill('combat-check'); await page.locator('#online-join').click(); await page.locator('#online-room-code').waitFor();
  }
  await host.waitForFunction(() => document.querySelector('#online-start')?.disabled === false); await host.locator('#online-start').click();
  const progress = setInterval(async () => console.log('Loading', await Promise.all(pages.map(p => p.evaluate(() => ({ stage: window.combatSession().startupProgress.stage, status: window.combatSession().network?.status })).catch(() => null)))), 10000);
  try { await ready(); } finally { clearInterval(progress); }
  const transport = await Promise.all(pages.map(page => page.evaluate(async () => Promise.all([...window.combatSession().network.peers.values()].map(p => p.link.transportInfo())))));
  assert.equal(transport[0].length, count - 1, 'host has a transport to every guest');
  assert.ok(transport.slice(1).every(peers => peers.length === 1), 'every guest has one authoritative host transport');
  if (relay) assert.ok(transport.flat().every(p => p.local === 'relay'), 'every sending peer uses TURN');
  const initial = await summary(host);
  if (process.env.TEST_NETWORK === '1') await pages[1].evaluate(() => {
    const peer = window.combatSession().network.peers.values().next().value.link, send = peer.send.bind(peer); let drive = 0;
    window.restoreCombatNetwork = () => { peer.send = send; };
    peer.send = message => {
      if (message.kind === 'input') { if (message.command?.k === 'drive' && ++drive % 10 === 0) return; setTimeout(() => send(message), 120); }
      else send(message);
    };
  });
  await Promise.all(pages.map(p => p.keyboard.down('KeyW'))); await wait(1000); await Promise.all(pages.map(p => p.keyboard.up('KeyW'))); await wait(400);
  const moved = await summary(host);
  moved.tanks.forEach((tank, i) => assert.ok(Math.hypot(...tank.position.map((v, n) => v - initial.tanks[i].position[n])) > .3, `human ${i} moved concurrently`));
  const fired = await Promise.all(pages.map(page => page.evaluate(() => { const s = window.combatSession(); s.command(s.observer, { k: 'aim', yaw: .2, pitch: 1.3, power: .85 }); return s.command(s.observer, { k: 'fire' }); })));
  assert.ok(fired.every(Boolean));
  await Promise.all(pages.map(page => page.waitForFunction(count => new Set(window.combatEvents.filter(e => e.type === 'shot').map(e => e.player)).size >= count, count, { timeout: 20000 })));
  const launchTicks = (await summary(host)).events.filter(e => e.type === 'shot').slice(0, count).map(e => e.launch.tick);
  assert.ok(Math.max(...launchTicks) - Math.min(...launchTicks) < 30, 'all human shots overlap within half a simulation second');
  const reconciled = await Promise.all(pages.map(summary));
  for (const state of reconciled.slice(1)) for (let i = 0; i < count; i++) assert.ok(Math.hypot(...state.tanks[i].position.map((v, axis) => v - reconciled[0].tanks[i].position[axis])) < 2, 'remote and predicted movement converges after input release');
  console.log('PASS simultaneous movement and firing', { mode, count, transport });
  if (process.env.TEST_NETWORK === '1') { await wait(250); await pages[1].evaluate(() => window.restoreCombatNetwork()); }
  await wait(8500);
  for (let target = 1; target < count; target++) {
    for (let attempt = 0; attempt < 16; attempt++) {
      const before = await summary(host); if (!(before.health[target] > 0) || before.phase === 'finished') break;
      const result = await host.evaluate(target => {
        const s = window.combatSession(), tank = s.snapshot.tanks[target], shooter = s.observer;
        const point = [...tank.position], aimTarget = { point, object: { id: `tank:${target}`, kind: 'tank', collider: { shape: 'sphere', center: point, radius: .7 } } };
        let result, munition;
        // Artillery starts farther apart: its slower demolition round can be out of range while HE reaches.
        for (const id of ['heavy', 'explosive']) {
          s.command(shooter, { k: 'munition', id });
          const candidate = s.solveAimTarget(shooter, aimTarget);
          if (!result || candidate.error < result.error) { result = candidate; munition = id; }
          if (candidate.status === 'ready') { result = candidate; munition = id; break; }
        }
        s.command(shooter, { k: 'munition', id: munition });
        const accepted = result.aim && s.command(shooter, { k: 'aim', ...result.aim }) && s.command(shooter, { k: 'fire' });
        return { target, munition, status: result.status, error: result.error, aim: result.aim, accepted, tick: s.snapshot.tick, health: tank.health };
      }, target);
      shots.push(result); console.log('Shot', result);
      await wait(6500);
    }
    const state = await summary(host); assert.equal(state.health[target], 0, `target ${target} was destroyed by real projectiles`);
  }
  await Promise.all(pages.map(page => page.locator('#results').waitFor({ timeout: 30000 })));
  await wait(1200); const results = await Promise.all(pages.map(summary));
  for (const result of results) { assert.equal(result.phase, 'finished'); assert.equal(result.winner, 0); assert.deepEqual(result.health, results[0].health); assert.equal(result.edits, results[0].edits); }
  assert.ok(results[0].edits > initial.edits, 'projectile impacts changed terrain');
  assert.ok(results.every(result => result.events.some(e => e.type === 'impact') && result.events.some(e => e.type === 'kill') && result.events.filter(e => e.type === 'finish').length === 1), 'impacts, deaths, and one final outcome reached every player');
  for (let i = 0; i < pages.length; i++) await pages[i].screenshot({ path: `${output}/results-${i}.png` });
  console.log('PASS identical damage, destruction and winner on every browser');
  await host.locator('#results-rematch').click(); await host.locator('#online-start').waitFor();
  await host.waitForFunction(() => document.querySelector('#online-start')?.disabled === false); await host.locator('#online-start').click(); await ready(2);
  assert.ok((await summary(host)).health.every(h => h > 0), 'rematch has new living tanks');
  assert.deepEqual(errors, []);
  await writeFile(`${output}/result.json`, JSON.stringify({ passed: true, category: 'local independent browser processes / local Cloudflare / real WebRTC', mode, players: count, relay, transport,
    networkSimulation: process.env.TEST_NETWORK === '1' ? 'Guest input sends delayed 120 ms; every tenth drive update dropped at the application layer during movement and simultaneous fire' : null,
    relayCredentials: relayServers ? 'Ephemeral public issuer; local room membership; credentials kept only in memory' : relay ? 'Local deployment configuration' : null,
    setup: 'Public create/join UI, default seed-7 mode presets and loadouts; fog disabled through public UI', simultaneous: true, shots, results, rematch: true, errors }, null, 2));
  console.log('PASS playable rematch', { mode, count });
} catch (error) {
  console.error(error);
  const diagnostics = await Promise.all(pages.map(summary).map(p => p.catch(() => null))); console.error(JSON.stringify({ errors, diagnostics }));
  for (const [i, page] of pages.entries()) await page.screenshot({ path: `${output}/failure-${i}.png` }).catch(() => {});
  await writeFile(`${output}/failure.json`, JSON.stringify({ mode, count, errors, diagnostics, shots }, null, 2)); process.exitCode = 1;
} finally {
  for (const page of pages) await page.evaluate(() => window.combatSession?.().network?.client().leave()).catch(() => {});
  await Promise.all(browsers.map(browser => browser.close()));
}
