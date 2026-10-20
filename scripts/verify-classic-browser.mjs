import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

const executablePath = [process.env.TMT_CHROME, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(path => path && existsSync(path));
if (!executablePath) throw new Error('Set TMT_CHROME to a Chromium browser with WebGPU support.');
const base = process.env.TMT_BROWSER_TEST_URL ?? process.env.TMT_ONLINE_TEST_URL ?? 'http://127.0.0.1:5174';
const output = 'artifacts/online/classic-smoke';
const browser = await chromium.launch({ executablePath, headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 850 } }), errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error' && !message.text().includes('403')) errors.push(message.text()); });
await mkdir(output, { recursive: true });

async function start(opponents) {
  await page.goto(base);
  await page.locator('#title-skirmish').click();
  await page.locator(`#skirmish-opponents [data-value="${opponents}"]`).click();
  await page.locator('#skirmish-tanks [data-value="2"]').click();
  await page.screenshot({ path: `${output}/${opponents}-setup.png` });
  await page.locator('#skirmish-start').click();
  await page.waitForFunction(() => window.__tmtGame?.ready && window.__tmtGame.tick > 5, {}, { timeout: 180000 });
  await page.evaluate(async () => {
    window.__classic = (await import('/src/game/api/session.ts')).session();
    window.__classicShots = []; window.__classicTurns = [];
    window.__classic.on('event', event => {
      if (event.type === 'shot') window.__classicShots.push({ player: event.player, tick: window.__classic.snapshot?.tick });
      if (event.type === 'turn') window.__classicTurns.push({ player: event.player, turn: window.__classic.snapshot?.turn, tick: window.__classic.snapshot?.tick });
    });
  });
  return page.evaluate(() => ({ turn: window.__classic.snapshot.turn, active: window.__classic.snapshot.active,
    phase: window.__classic.snapshot.phase, tick: window.__classic.snapshot.tick }));
}

try {
  const soloStart = await start('ai');
  assert.deepEqual({ active: soloStart.active, phase: soloStart.phase }, { active: 0, phase: 'aim' }, 'human starts in aim phase');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__classicShots.some(event => event.player === 0), {}, { timeout: 30000 });
  await page.waitForFunction(() => window.__classicShots.some(event => event.player === 1)
    && window.__classic.snapshot.turn >= 2 && window.__classic.snapshot.active === 0, {}, { timeout: 150000 });
  const solo = await page.evaluate(() => ({ shots: window.__classicShots, turns: window.__classicTurns,
    turn: window.__classic.snapshot.turn, active: window.__classic.snapshot.active, phase: window.__classic.snapshot.phase }));
  assert.ok(solo.shots.some(event => event.player === 0) && solo.shots.some(event => event.player === 1), 'human and AI each fire');
  assert.ok(solo.turns.some(event => event.player === 1), 'turn advances to the AI');
  await page.screenshot({ path: `${output}/solo-ai-after-ai-shot.png` });

  await page.keyboard.press('Escape');
  await page.locator('#pause-leave').click();
  await page.locator('#skirmish').waitFor();
  await page.locator('#skirmish-back').click();
  await page.locator('#title-skirmish').waitFor();

  const localStart = await start('local');
  assert.deepEqual({ active: localStart.active, phase: localStart.phase }, { active: 0, phase: 'aim' }, 'first local player starts in aim phase');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__classicShots.some(event => event.player === 0)
    && window.__classic.snapshot.active === 1 && window.__classic.snapshot.phase === 'aim', {}, { timeout: 90000 });
  await page.waitForFunction(() => !document.querySelector('#fire')?.disabled, {}, { timeout: 30000 });
  const secondPlayer = await page.evaluate(() => ({ turn: window.__classic.snapshot.turn, active: window.__classic.snapshot.active,
    phase: window.__classic.snapshot.phase, fireDisabled: document.querySelector('#fire')?.disabled }));
  assert.equal(secondPlayer.active, 1);
  assert.equal(secondPlayer.phase, 'aim');
  assert.equal(secondPlayer.fireDisabled, false);
  await page.locator('#fire').click();
  await page.waitForFunction(() => window.__classicShots.some(event => event.player === 1), {}, { timeout: 30000 });
  const passAndPlay = await page.evaluate(() => ({ shots: window.__classicShots, turns: window.__classicTurns,
    turn: window.__classic.snapshot.turn, active: window.__classic.snapshot.active, phase: window.__classic.snapshot.phase }));
  assert.ok(passAndPlay.shots.some(event => event.player === 0) && passAndPlay.shots.some(event => event.player === 1), 'both local players fire');
  await page.screenshot({ path: `${output}/same-screen-p2-fired.png` });
  assert.deepEqual(errors, []);
  const result = { passed: true, solo: { start: soloStart, afterAiShot: solo }, passAndPlay: { start: localStart, secondPlayerReady: secondPlayer, afterSecondShot: passAndPlay }, errors };
  await writeFile(`${output}/result.json`, JSON.stringify(result, null, 2));
  console.log('Classic browser smoke passed', JSON.stringify(result));
} catch (error) {
  console.error(error);
  console.error('Browser errors', JSON.stringify(errors));
  for (const [index, openPage] of browser.contexts().flatMap(context => context.pages()).entries()) {
    await openPage.screenshot({ path: `${output}/failure-${index}.png` }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  await browser.close();
}
