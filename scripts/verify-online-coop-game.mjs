/** Actual co-op gameplay on the resident world. Autopilots submit normal session commands;
 * no tank, mission, damage, world or outcome state is modified by this test. */
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const executablePath = [process.env.TMT_CHROME, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].find(p => p && existsSync(p));
assert.ok(executablePath, 'Set TMT_CHROME to Chromium with WebGPU support.');
const base = process.env.TMT_ONLINE_TEST_URL || 'http://127.0.0.1:5174', output = 'artifacts/online/coop-game';
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
  if (index) {
    await page.evaluate(async () => {
      const { defaultProfile, saveProgress } = await import('/src/game/meta/profile.ts');
      const profile = defaultProfile(); profile.stars['campaign:p3'] = 2; profile.unlocks.push('ending:release'); profile.xp = 12;
      saveProgress(profile, localStorage);
    });
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.locator('#title-online').waitFor({ timeout: 60000 });
  }
  await page.evaluate(async () => {
    window.__onlineSession = (await import('/src/game/api/session.ts')).session;
    window.__coopEvents = { shots: [0, 0, 0], impacts: 0, kills: 0 };
    window.__onlineSession().on('event', event => {
      if (event.type === 'shot' && event.player < 3) window.__coopEvents.shots[event.player]++;
      if (event.type === 'impact') window.__coopEvents.impacts++;
      if (event.type === 'kill') window.__coopEvents.kills++;
    });
  });
  await page.locator('#title-online').click(); await page.locator('#online-name').fill(index ? `Helper ${index}` : 'Campaign owner');
  return page;
}
async function read(page) {
  return page.evaluate(() => {
    const s = window.__onlineSession(), state = s.snapshot, m = s.mission, remote = s.remoteMission;
    return { ready: s.ready, setupId: s.setup?.id, screen: document.querySelector('#game')?.getAttribute('data-screen'), tick: state?.tick,
      beat: m?.beatId ?? remote?.beat, outcome: m?.outcome ?? (remote?.won ? 'won' : null), phase: state?.phase,
      winner: state?.winnerTeam, host: s.network?.host, epoch: s.network?.room?.epoch, active: s.network?.active, status: s.network?.status,
      campaignOwnerSeat: s.setup?.online?.campaignOwnerSeat,
      tanks: state?.tanks.map(t => ({ id: t.id, health: t.health, retired: t.retired, position: t.position, generation: t.generation })),
      world: s.world?.networkWorld(0, true).edits.map(e => e.cut?.id ?? e.cuts?.map(c => c.id)),
      objectives: m?.objectiveList() ?? remote?.objectives, profile: JSON.parse(localStorage.getItem('tmt.progress.v2') || '{}'),
      loading: s.startupProgress?.stage, events: window.__coopEvents };
  });
}
async function wait(label, predicate, timeout = 180000) {
  const deadline = Date.now() + timeout; let lastLog = 0;
  for (;;) {
    const states = await Promise.all(pages.map(read));
    if (predicate(states)) return states;
    if (Date.now() - lastLog > 12000) {
      const compact = states.map(s => ({ tick: s.tick, beat: s.beat, phase: s.phase, host: s.host, status: s.status, world: s.world?.length, loading: s.loading,
        health: s.tanks?.filter(t => t.id < 3).map(t => Math.ceil(t.health)) }));
      progress.push({ at: new Date().toISOString(), label, states: compact }); console.log(label, JSON.stringify(compact)); lastLog = Date.now();
    }
    assert.ok(Date.now() < deadline, `Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}
async function join(page, code) {
  await page.locator('#online-open-join').click(); await page.locator('#online-code').fill(code);
  await page.locator('#online-join-password').fill('coop test'); await page.locator('#online-join').click();
  // Joining a live mission immediately leaves the lobby for loading.
  await page.waitForFunction(code => window.__onlineSession().network?.room?.code === code || document.querySelector('#online-room-code')?.textContent === code,
    code, { timeout: 60000 });
}
async function ownedCheckpoint(page) {
  return page.evaluate(async () => {
    if (!(await indexedDB.databases()).some(db => db.name === 'iron-orrery-campaign')) return null;
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('iron-orrery-campaign', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      const saved = await new Promise((resolve, reject) => { const request = db.transaction('checkpoints').objectStore('checkpoints').get('owned-coop'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      return saved ? { beat: saved.checkpoint.beat, tick: saved.checkpoint.match.state.tick } : null;
    } finally { db.close(); }
  });
}
try {
  const owner = await player(0), helper = await player(1);
  await owner.locator('#online-open-create').click(); await owner.locator('#online-mode').selectOption('coop');
  await owner.locator('#online-capacity').selectOption('3'); await owner.locator('#online-mission').selectOption('p1');
  await owner.locator('#online-host-password').fill('coop test'); await owner.locator('#online-visibility').selectOption('friends');
  await owner.locator('#online-create').click(); await owner.locator('#online-room-code').waitFor();
  const code = await owner.locator('#online-room-code').innerText(); await join(helper, code);
  await owner.waitForFunction(() => !document.querySelector('#online-start')?.disabled); await owner.locator('#online-start').click();
  await wait('two players load and begin campaign', states => states.every(s => s.ready && s.tick > 10));
  await wait('players fire and modify the live world', states => states[0].world?.length > 0, 240000);
  observations.beforeJoin = await read(owner);
  observations.ownerCheckpoint = await ownedCheckpoint(owner);
  assert.ok(observations.ownerCheckpoint, 'owner keeps a durable co-op checkpoint during the mission');
  assert.equal(await ownedCheckpoint(helper), null, 'helper does not write another campaign checkpoint');
  const third = await player(2); await join(third, code);
  await wait('third player joins modified mission', states => states.every(s => s.ready && s.tick >= observations.beforeJoin.tick)
    && states[2].world?.length >= observations.beforeJoin.world.length, 180000);
  const late = await read(third);
  assert.deepEqual(late.world.slice(0, observations.beforeJoin.world.length), observations.beforeJoin.world, 'late join receives committed terrain history');
  assert.ok(late.tanks[2].health > 0 && !late.tanks[2].retired, 'late join controls its reserved human tank');
  observations.afterJoin = late; await third.screenshot({ path: `${output}/late-join.png` });
  const finished = await wait('three players complete First Light through ordinary commands', states => states.every(s => s.phase === 'finished'),
    Number(process.env.TMT_COOP_TIMEOUT_MS || 900000));
  assert.ok(finished.every(s => s.outcome === 'won' && s.winner === 0), 'all players agree on the campaign win');
  assert.deepEqual(finished[1].objectives, finished[0].objectives); assert.deepEqual(finished[2].objectives, finished[0].objectives);
  assert.ok(finished[0].profile.stars['campaign:p1'] > 0, 'owner campaign advances');
  assert.ok(finished[0].events.shots[0] > 0 && finished[0].events.shots[1] > 0, 'both initial humans fire authoritative shots');
  assert.ok(finished[0].events.impacts > 0 && finished[0].events.kills > 0, 'live projectiles resolve impacts and kills');
  for (const state of finished.slice(1)) {
    assert.deepEqual(state.profile.stars, { 'campaign:p3': 2 }, 'guest unrelated campaign is preserved');
    assert.deepEqual(state.profile.unlocks, ['ending:release'], 'guest unlocks remain their own');
    assert.ok(state.profile.xp > 12 && state.profile.mastery['reward:assist:p1'] > 0, 'guest receives assistance currency');
  }
  observations.finished = finished;
  await owner.locator('#results-online-next').waitFor({ timeout: 15000 });
  assert.equal(await owner.locator('.ch-radio').isVisible(), false, 'queued dialogue cannot cover result actions');
  await owner.screenshot({ path: `${output}/mission-complete.png` });
  await owner.locator('#results-online-next').click(); await owner.locator('#online-start').waitFor();
  await owner.waitForFunction(() => !document.querySelector('#online-start')?.disabled); await owner.locator('#online-start').click();
  await wait('next mission starts together', states => states.every(s => s.ready && s.tick > 10 && s.setupId === 'campaign:p2'), 180000);
  assert.ok(await owner.evaluate(() => window.__onlineSession().setup.id === 'campaign:p2'));
  observations.nextMission = await Promise.all(pages.map(read));
  const beforeTransfer = observations.nextMission[0].epoch;
  await owner.locator('.online-presence button').filter({ hasText: /^Server$/ }).click();
  await owner.waitForFunction(() => !document.querySelector('#online-transfer')?.disabled, {}, { timeout: 45000 });
  await owner.locator('#online-transfer').click();
  const transferred = await wait('manual co-op host transfer keeps campaign ownership', states => states.every(s => s.ready && s.active && s.epoch > beforeTransfer), 180000);
  assert.equal(transferred.filter(s => s.host).length, 1); assert.equal(transferred[0].host, false);
  assert.ok(transferred.every(s => s.campaignOwnerSeat === 0)); observations.transferred = transferred;
  const currentHost = transferred.findIndex(s => s.host), livePeers = pages.map((_, i) => i).filter(i => i !== currentHost);
  await pages[currentHost].context().setOffline(true);
  const recovered = await wait('unexpected co-op host loss elects one checkpoint holder', states => livePeers.every(i => states[i].ready && states[i].active && states[i].epoch > transferred[i].epoch), 150000);
  assert.equal(livePeers.filter(i => recovered[i].host).length, 1); observations.hostLoss = recovered;
  await pages[currentHost].context().setOffline(false);
  await wait('old host reconnects to current co-op authority', states => states.every(s => s.ready && s.active && s.epoch === recovered[livePeers[0]].epoch), 180000);
  await third.locator('.online-presence button').filter({ hasText: /^Server$/ }).click(); await third.locator('#online-leave').click();
  const tick = await owner.evaluate(() => window.__onlineSession().snapshot.tick);
  await owner.waitForFunction(tick => window.__onlineSession().snapshot.tick > tick + 30 || window.__onlineSession().snapshot.phase === 'finished', tick, { timeout: 30000 });
  await join(third, code);
  await wait('helper rejoins next mission without resetting it', states => states.every(s => s.ready && s.tick > tick), 180000);
  observations.rejoined = await Promise.all(pages.map(read));
  assert.deepEqual(errors, []);
  console.log('PASS: First Light co-op win, owner-only campaign progress, guest assistance, modified-world late join, next mission, manual transfer, unexpected host loss, reconnect, helper leave and rejoin.');
  await writeFile(`${output}/result.json`, JSON.stringify({ category: 'local real browser resident-world gameplay; no independent internet or TURN assertion', observations, errors, progress }, null, 2));
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
