/** Resident-world co-op recovery after real combat, using only ordinary autopilot commands. */
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const executablePath = [process.env.TMT_CHROME, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].find(p => p && existsSync(p));
assert.ok(executablePath, 'Set TMT_CHROME to Chromium with WebGPU support.');
const base = process.env.TMT_ONLINE_TEST_URL || 'http://127.0.0.1:5174', output = 'artifacts/online/coop-recovery';
const browsers = [], pages = [], errors = [], progress = [], observations = {};
await mkdir(output, { recursive: true });
async function player(index) {
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu',
    '--disable-features=WebRtcHideLocalIpsWithMdns', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  browsers.push(browser);
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 } }); pages.push(page);
  page.on('pageerror', error => errors.push({ player: index, message: error.message }));
  await page.goto(`${base}/play.html?autopilot=1`, { waitUntil: 'domcontentloaded' });
  await page.locator('#title-online').waitFor({ timeout: 60000 });
  await page.evaluate(async () => { window.__onlineSession = (await import('/src/game/api/session.ts')).session; });
  await page.locator('#title-online').click(); await page.locator('#online-name').fill(index ? `Recovery helper ${index}` : 'Campaign owner');
  return page;
}
async function read(page) {
  return page.evaluate(() => {
    const s = window.__onlineSession(), state = s.snapshot, n = s.network, m = s.mission, remote = s.remoteMission;
    const edits = world => world?.edits.map(e => e.cut?.id ?? e.cuts?.map(c => c.id));
    const summary = id => {
      const r = id && n?.recoveries.get(id), rt = r?.realtime;
      return r ? { id, tick: rt.state.tick, world: edits(r.terrain), script: rt.script,
        tanks: rt.state.tanks.map(t => ({ id: t.id, health: t.health, retired: t.retired, generation: t.generation })),
        projectiles: rt.state.projectiles, nextShot: rt.nextShot, nextGeneration: rt.nextGeneration, nextEnemySalvo: rt.nextEnemySalvo,
        ai: rt.core, random: rt.units.map(u => u.random) } : null;
    };
    return { ready: s.ready, setupId: s.setup?.id, tick: state?.tick, beat: m?.beatId ?? remote?.beat, phase: state?.phase,
      host: n?.host, epoch: n?.room?.epoch, active: n?.active, status: n?.status, members: n?.room?.peers.length, campaignOwnerSeat: s.setup?.online?.campaignOwnerSeat,
      world: s.world && edits(s.world.networkWorld(0, true)), objectives: m?.objectiveList() ?? remote?.objectives,
      tanks: state?.tanks.map(t => ({ id: t.id, health: t.health, retired: t.retired, generation: t.generation })),
      acknowledged: summary(n?.room?.ownCheckpoint), elected: summary(n?.room?.checkpoint),
      recoveries: n ? [...n.recoveries.keys()] : [] };
  });
}
async function wait(label, predicate, timeout = 180000) {
  const deadline = Date.now() + timeout; let lastLog = 0;
  for (;;) {
    const states = await Promise.all(pages.map(read));
    if (predicate(states)) return states;
    if (Date.now() - lastLog > 12000) {
      const compact = states.map(s => ({ tick: s.tick, beat: s.beat, phase: s.phase, host: s.host, epoch: s.epoch,
        status: s.status, world: s.world?.length, acknowledged: s.acknowledged?.id }));
      progress.push({ at: new Date().toISOString(), label, states: compact }); console.log(label, JSON.stringify(compact)); lastLog = Date.now();
    }
    assert.ok(Date.now() < deadline, `Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}
function includesPrefix(actual, expected, label) { assert.deepEqual(actual.slice(0, expected.length), expected, label); }
function preserved(states, before, epoch) {
  assert.equal(states.filter(s => s.host).length, 1, 'one simulation host after recovery');
  for (const state of states) {
    assert.equal(state.campaignOwnerSeat, 0, 'simulation transfer cannot transfer save ownership');
    assert.ok(state.epoch > epoch && state.tick >= before.tick, 'world continues at or after acknowledged recovery tick');
    includesPrefix(state.world, before.world, 'all peers retain acknowledged terrain destruction');
    for (const objective of before.script.objectives.filter(o => o.state === 'done')) {
      assert.ok(state.objectives.some(o => o.id === objective.id && o.state === 'done'), 'completed objective survives recovery');
    }
    for (const tank of before.tanks.filter(t => t.id >= 3 && t.health <= 0)) {
      const current = state.tanks[tank.id];
      assert.ok(current.generation !== tank.generation || current.health <= 0, 'destroyed NPC stays destroyed until legitimately recycled');
    }
  }
  const host = states.find(s => s.host);
  assert.ok(host.elected, 'elected host holds the exact checkpoint named by the service');
  assert.ok(host.elected.tick >= before.tick && host.elected.random.length > 3 && host.elected.ai.length > 0,
    'recovery includes NPC decisions and random-generator state');
}
try {
  const owner = await player(0), helper = await player(1), third = await player(2);
  await owner.locator('#online-open-create').click(); await owner.locator('#online-mode').selectOption('coop');
  await owner.locator('#online-capacity').selectOption('3'); await owner.locator('#online-mission').selectOption('p2');
  await owner.locator('#online-host-password').fill('coop recovery'); await owner.locator('#online-visibility').selectOption('friends');
  await owner.locator('#online-create').click(); await owner.locator('#online-room-code').waitFor();
  const code = await owner.locator('#online-room-code').innerText();
  for (const page of [helper, third]) {
    await page.locator('#online-open-join').click(); await page.locator('#online-code').fill(code);
    await page.locator('#online-join-password').fill('coop recovery'); await page.locator('#online-join').click();
    await page.locator('#online-room-code').waitFor();
  }
  await owner.waitForFunction(() => !document.querySelector('#online-start')?.disabled); await owner.locator('#online-start').click();
  await wait('three players fight the p2 swarm and modify terrain', states => states.every(s => s.ready && s.active) && states[0].world?.length > 0);
  const before = await read(owner);
  const acknowledged = await wait('all helpers acknowledge combat checkpoint', states => states.every(s => s.acknowledged?.tick >= before.tick
    && s.acknowledged.world.length >= before.world.length), 180000);
  const baseline = acknowledged.map(s => s.acknowledged).sort((a, b) => a.tick - b.tick)[0];
  observations.beforeTransfer = { baseline, states: acknowledged };
  await owner.locator('.online-presence button').filter({ hasText: /^Server$/ }).click();
  await owner.waitForFunction(() => !document.querySelector('#online-transfer')?.disabled); await owner.locator('#online-transfer').click();
  const transferred = await wait('manual transfer restores acknowledged modified world', states => states.every(s => s.ready && s.active
    && s.epoch > before.epoch && s.tick >= baseline.tick && s.world?.length >= baseline.world.length));
  preserved(transferred, baseline, before.epoch); observations.transferred = transferred;
  assert.equal(transferred[0].host, false, 'a helper now hosts the owner campaign');
  await pages[transferred.findIndex(s => s.host)].screenshot({ path: `${output}/transferred.png` });
  const next = await wait('replacement host publishes a newer complete combat checkpoint', states => states.every(s => s.acknowledged?.tick > baseline.tick + 120
    && s.acknowledged.world.length >= baseline.world.length), 180000);
  const beforeLoss = next.map(s => s.acknowledged).sort((a, b) => a.tick - b.tick)[0], currentHost = next.findIndex(s => s.host);
  const livePeers = pages.map((_, i) => i).filter(i => i !== currentHost);
  observations.beforeLoss = { baseline: beforeLoss, states: next };
  await pages[currentHost].context().setOffline(true);
  const recovered = await wait('unexpected host loss restores acknowledged combat world', states => livePeers.every(i => states[i].ready && states[i].active
    && states[i].epoch > next[i].epoch && states[i].tick >= beforeLoss.tick && states[i].world?.length >= beforeLoss.world.length), 150000);
  preserved(livePeers.map(i => recovered[i]), beforeLoss, next[0].epoch); observations.hostLoss = recovered;
  await pages[currentHost].context().setOffline(false);
  const reunited = await wait('old host returns to replacement authority and world', states => states.every(s => s.ready && s.active
    && s.epoch === recovered[livePeers[0]].epoch && s.tick >= beforeLoss.tick && s.world?.length >= beforeLoss.world.length));
  preserved(reunited, beforeLoss, next[0].epoch); observations.reunited = reunited;
  await owner.screenshot({ path: `${output}/recovered.png` });
  for (const page of [helper, third]) {
    await page.locator('.online-presence button').filter({ hasText: /^Server$/ }).click(); await page.locator('#online-leave').click();
  }
  const aloneAt = await read(owner);
  const solo = await wait('owner keeps playing after both helpers explicitly leave', states => states[0].ready && states[0].active
    && states[0].members === 1 && (states[0].tick > aloneAt.tick + 60 || states[0].phase === 'finished'), 60000);
  includesPrefix(solo[0].world, beforeLoss.world, 'one remaining human keeps the shared world');
  assert.ok(solo[0].host, 'remaining owner holds simulation authority'); observations.alone = solo[0];
  await owner.screenshot({ path: `${output}/one-human-continues.png` });
  assert.deepEqual(errors, []);
  await writeFile(`${output}/result.json`, JSON.stringify({ category: 'local real browser resident-world gameplay; no independent internet or TURN assertion', observations, errors, progress }, null, 2));
  console.log('PASS: modified terrain, completed objectives, destroyed NPCs, ticks, AI/random checkpoint state and campaign ownership survive manual transfer, unexpected host loss and reconnect; the last human continues after helpers leave.');
} catch (error) {
  console.error(error); process.exitCode = 1;
  const states = await Promise.all(pages.map(page => read(page).catch(e => ({ error: String(e) }))));
  console.error('failure states', JSON.stringify(states));
  await writeFile(`${output}/failure.json`, JSON.stringify({ error: String(error), states, observations, errors, progress }, null, 2));
  for (let i = 0; i < pages.length; i++) await pages[i].screenshot({ path: `${output}/failure-${i}.png` }).catch(() => {});
} finally {
  for (const page of pages) await page.evaluate(() => window.__onlineSession?.().network?.client().leave()).catch(() => {});
  await Promise.all(browsers.map(browser => browser.close()));
}
