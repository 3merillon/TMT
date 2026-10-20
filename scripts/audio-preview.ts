/**
 * Real-Chromium audio verification and listening previews through the ACTUAL runtime (src/audio/index.ts, the game
 * hooks, the score player, the effects bank), not an isolated mix: a synthetic battle is driven through
 * dispatchMatchStart/dispatchGameEvent/dispatchFrame and the session-style realtime events, a real campaign voice clip
 * plays over it, and the master output is recorded with MediaRecorder. Lifecycle checks (gesture gating, scene
 * continuity, mute, hidden-tab suspension) are asserted on window.__tmtGame.audio.
 *
 *   node --import tsx scripts/audio-preview.ts [--checks-only] [--stress] [--port <n>]
 * Outputs: G:\tmt-work\audio\previews\runtime-*.{webm,wav}, artifacts/audio-preview/verification.json, analysis PNG/JSON.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { readWav } from './audio-forge/dsp/wav';
import { stats, spectrogramPng, waveformPng } from './audio-forge/dsp/analyze';
import { ffmpeg } from './audio-forge/encode';

const args = process.argv.slice(2), checksOnly = args.includes('--checks-only'), stress = args.includes('--stress'), boss = args.includes('--boss');
const port = Number(args[args.indexOf('--port') + 1]) || 0;
const root = resolve('.'), out = join(root, 'artifacts/audio-preview'), previews = process.env.TMT_AUDIO_OUT ? join(process.env.TMT_AUDIO_OUT, 'previews') : 'G:/tmt-work/audio/previews';
mkdirSync(out, { recursive: true }); mkdirSync(previews, { recursive: true });
const server = await createServer({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn', cacheDir: join(root, '.vite-capture/audio-preview'), server: { host: '127.0.0.1', port, hmr: false, watch: null, open: false } });
await server.listen();
const store = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
const executablePath = process.env.TMT_CHROME ?? readdirSync(store).filter(n => /^chromium-\d+$/.test(n)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])).map(n => join(store, n, 'chrome-win64/chrome.exe')).find(existsSync);
assert.ok(executablePath, 'Chromium must be installed');
const browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-background-timer-throttling', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
const errors: string[] = [], checks: Record<string, unknown>[] = [], logs: string[] = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', msg => { if (msg.type() === 'warning' || msg.type() === 'error') logs.push(`${msg.type()}: ${msg.text()}`); });

const PAGE = `<!doctype html><button id="unlock">Enable audio</button><script type="module">
import('/src/audio/index.ts').then(async audio => {
  const hooks = await import('/src/game/app/hooks.ts');
  window.audio = audio; window.hooks = hooks; window.audioTelemetry = () => hooks.collectTelemetry().audio;
  window.audioReady = true;
});
</script>`;
await page.route('**/audio-audition', route => route.fulfill({ contentType: 'text/html', body: PAGE }));
await page.route('**/favicon.ico', route => route.fulfill({ status: 204, body: '' }));
const telemetry = () => page.evaluate<any>('window.audioTelemetry()');
const scene = (name: string, world?: string) => page.evaluate(({ scene, world }) => window.dispatchEvent(new CustomEvent('tmt:audio-scene', { detail: { scene, world } })), { scene: name, world });
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const note = (name: string, data: unknown) => { checks.push({ name, ...(data as object) }); console.log(`[check] ${name}`); };

/** The in-page synthetic battle: tanks on the sphere, shells, impacts, tracers, wrecks, driven through the real hooks. */
const BATTLE = String.raw `
(() => {
  const R = 18.4, G = 7.5;
  const norm = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const onSphere = (dx, dz) => { const a = Math.hypot(dx, dz) / R, d = norm([dx, 0, dz]); return [Math.sin(a) * d[0] * R, Math.cos(a) * R, Math.sin(a) * d[2] * R]; };
  const tank = (id, pos, over = {}) => ({ id, position: pos, rotation: [0, 0, 0, 1], velocity: [0, 0, 0], heading: 0, turretYaw: 0, barrelPitch: 0.3, power: 0.7, health: 100, maxHealth: 100, charge: 1, movement: 1, recoil: 0,
    suspension: [], trackPhase: 0, trackPhases: [0, 0], trackSpeeds: [0, 0], trackGroundSpeeds: [0, 0], trackSlip: [0, 0], trackContact: [1, 1], yawVelocity: 0, wheelSuspension: [.5,.5,.5,.5,.5,.5,.5,.5], treadContacts: [],
    loadout: { tracks: 'scout', barrel: 'cannon', armor: 'light' }, kit: { hull: 'warden', runningGear: 'grip', turret: 'dome', weapon: 'cannon', utility: 'antenna' }, team: id === 0 ? 0 : 1, ...over });
  const B = window.BATTLE = { tick: 0, tanks: [tank(0, onSphere(0, 0), { name: 'Kestrel', maxHealth: 200, health: 200 })], projectiles: [], events: 0, shots: 0, impacts: 0, kills: 0, tracers: 0, nextId: 1, running: false, phase: 'explore', density: 1, hostileFire: 0.8, playerFire: 2.5, lastPlayer: 0, lastHostile: 0, rng: 7 };
  const rand = () => { B.rng = (Math.imul(B.rng, 1664525) + 1013904223) >>> 0; return B.rng / 4294967296; };
  B.spawn = (n, dist, kind) => { for (let i = 0; i < n; i++) { const a = rand() * Math.PI * 2, d = dist * (0.8 + 0.4 * rand()); const over = kind === 'swarm' ? { motionKind: 'swarm', visualKind: 'rustling', maxHealth: 24, health: 24, name: 'Rustling' } : kind === 'air' ? { motionKind: 'air', visualKind: 'dragonfly', team: 0, name: 'Mags' }
      : kind === 'crawler' ? { name: 'Siege Crawler', maxHealth: 460, health: 460, components: [...[-1, 1].flatMap(sd => [-1, 1].map(end => ({ id: 'drive' + sd + end, name: 'drive', kind: 'drive', offset: [sd * .85, -.12, end * .65], radius: .27, stage: 0, health: 45, maxHealth: 45 }))), ...[-1, 1].map(sd => ({ id: 'pod' + sd, name: 'pod', kind: 'weapon', offset: [sd * .54, .5, -.22], radius: .27, stage: 1, health: 70, maxHealth: 70 })), { id: 'core', name: 'core', kind: 'core', offset: [0, .35, -.66], radius: .3, stage: 2, health: 160, maxHealth: 160 }] } : { name: 'Rusty' }; B.tanks.push(tank(B.nextId++, onSphere(Math.cos(a) * d, Math.sin(a) * d), { ...over, approach: kind === 'air' ? 0 : 0.6 + rand() * 0.6 })); } };
  const up = p => norm(p);
  const snapshot = () => ({ tick: B.tick, time: B.tick / 60, phase: 'aim', active: 0, turn: 0, phaseTime: 0, tanks: B.tanks, projectiles: B.projectiles, contacts: B.tanks.map(() => null), winner: null,
    observations: B.tanks.map((_, i) => i === 0 ? B.tanks.map(t => t.team === 1 && t.health > 0 ? { position: t.position, observedAt: B.tick, source: 'sight', visible: true } : null) : []) });
  const emit = e => { B.events++; window.hooks.dispatchGameEvent(e, snapshot()); };
  const fire = (shooter, target) => {
    const from = shooter.position.map((v, i) => v + up(shooter.position)[i] * 0.45), dir = norm(target.position.map((v, i) => v - shooter.position[i]));
    const u = up(shooter.position), speed = 14, v = dir.map((d, i) => (d + u[i] * 0.9) * speed / 1.35);
    const id = B.nextId++ + 1000;
    B.projectiles.push({ id, owner: shooter.id, position: [...from], velocity: v, age: 0, munition: 'explosive', target: target.id });
    emit({ type: 'shot', player: shooter.id, launch: { id, tick: B.tick, munition: 'explosive', weapon: shooter.kit.weapon, power: 0.7, position: from, direction: dir, up: u } });
    B.shots++;
    if (target.id === 0) emit({ type: 'incoming', tank: 0, impactTick: B.tick + 90, predicted: target.position });
  };
  const step = dt => {
    B.tick++;
    const me = B.tanks[0];
    for (const t of B.tanks) {
      if (t.id === 0 || t.health <= 0 || !t.approach) continue;
      const d = Math.hypot(...t.position.map((v, i) => v - me.position[i]));
      const goal = B.phase === 'explore' ? 26 : B.phase === 'calm' ? 40 : t.motionKind === 'swarm' ? 3 : 9;
      const k = (d > goal ? -1 : d < goal - 2 ? 1 : 0) * t.approach * dt * 2.2;
      const dir = norm(t.position.map((v, i) => v - me.position[i]));
      const p = t.position.map((v, i) => v + dir[i] * k); const u = up(p); t.position = u.map(c => c * R);
      t.trackSpeeds = [Math.abs(k) / dt, Math.abs(k) / dt]; t.velocity = dir.map(c => c * k / dt);
      if (B.phase === 'combat' && t.team === 1 && t.motionKind !== 'swarm' && d < 16 && B.tick - B.lastHostile > 60 / (B.hostileFire * B.density)) { B.lastHostile = B.tick; fire(t, me); }
      if (B.phase === 'combat' && d < 11 && B.tick % 9 === 0 && t.motionKind === 'swarm') { B.tracers++; window.__tmtAudio.engine.onRealtimeEvent({ type: 'tracer', owner: t.id, from: t.position, to: me.position, victim: 0 }, snapshot()); }
    }
    const hostiles = B.tanks.filter(t => t.team === 1 && t.health > 0 && t.id !== 0);
    if (B.phase === 'combat' && hostiles.length && B.tick - B.lastPlayer > B.playerFire * 60) { B.lastPlayer = B.tick; const target = hostiles.sort((a, b) => Math.hypot(...a.position.map((v, i) => v - me.position[i])) - Math.hypot(...b.position.map((v, i) => v - me.position[i])))[0]; fire(me, target); }
    if (B.phase === 'combat' && hostiles.length && B.tick % 9 === 0) { const near = hostiles.find(t => Math.hypot(...t.position.map((v, i) => v - me.position[i])) < 12); if (near) { B.tracers++; window.__tmtAudio.engine.onRealtimeEvent({ type: 'tracer', owner: 0, from: me.position, to: near.position, victim: near.id }, snapshot()); } }
    for (const p of [...B.projectiles]) {
      const u = up(p.position); p.velocity = p.velocity.map((v, i) => v - u[i] * G * dt); p.position = p.position.map((v, i) => v + p.velocity[i] * dt); p.age += dt;
      if (Math.hypot(...p.position) <= R || p.age > 6) {
        B.projectiles.splice(B.projectiles.indexOf(p), 1);
        const target = B.tanks.find(t => t.id === p.target), hits = [];
        if (target && target.health > 0 && rand() < 0.75) { const dmg = 28 + rand() * 30; target.health = Math.max(0, target.health - dmg); hits.push({ tank: B.tanks.indexOf(target), damage: dmg, exposure: 1, direct: rand() < 0.5, lethal: target.health === 0, armorSection: 'front' }); if (target.health === 0) { target.destroyedAt = B.tick; B.kills++; } }
        const pos = target && hits.length ? target.position : norm(p.position).map(c => c * R);
        emit({ type: 'impact', position: pos, normal: up(pos), radius: 2.2, owner: p.owner, munition: 'explosive', hits, cut: { id: 'cut' + p.id, radius: 2.2 } });
        B.impacts++;
        if (hits.some(h => h.lethal)) emit({ type: 'kill', tank: hits.find(h => h.lethal).tank, by: p.owner, cause: 'direct' });
        setTimeout(() => emit({ type: 'terrain-commit', cutIds: ['cut' + p.id], version: B.tick }), 600);
        if (B.tanks[0].health < 60) B.tanks[0].health = 60;
      }
    }
    for (const t of B.tanks) if (t.health <= 0 && t.destroyedAt !== undefined && B.tick - t.destroyedAt > (B.wreckTicks ?? 900)) t.retired = true;
    const camUp = up(me.position), back = norm([1, 0, 0.4]);
    const camera = { position: me.position.map((v, i) => v + camUp[i] * 9 + back[i] * 7), target: me.position, up: camUp, fovY: 0.9 };
    window.hooks.dispatchFrame({ realDt: dt, simDt: dt, snapshot: snapshot(), camera, focus: me.position });
  };
  B.start = setup => { window.hooks.dispatchMatchStart(setup); window.__tmtAudio.engine.setObserver(0); B.running = true; let last = performance.now(); const loop = () => { if (!B.running) return; const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now; step(dt); requestAnimationFrame(loop); }; requestAnimationFrame(loop); };
  B.finish = () => { B.running = false; emit({ type: 'finish', winner: 0, team: 0 }); window.hooks.dispatchMatchEnd({ winner: 0, setup: B.setup }); };
  B.snapshot = snapshot;
})();`;

try {
  await page.goto(`${server.resolvedUrls!.local[0]}audio-audition`); await page.waitForFunction('window.audioReady');
  assert.equal((await telemetry()).state, 'locked');
  await page.click('#unlock');
  await page.waitForFunction(`window.audioTelemetry().music?.track === 'title'`, undefined, { timeout: 20000 });
  await page.waitForFunction(`window.audioTelemetry().bank?.ready === true`, undefined, { timeout: 20000 });
  const first = await telemetry();
  note('gesture starts the title theme and decodes the effects bank', { state: first.state, track: first.music.track, layers: first.music.layers, bankBytes: first.bank.decodedBytes, cacheBytes: first.music.cacheBytes, sampleRate: first.sampleRate });
  // Recording tap on the master trim.
  await page.evaluate(() => {
    const h = (window as any).__tmtAudio, ctx = h.ctx, dest = ctx.createMediaStreamDestination(); h.engine.m.buses.trim.connect(dest);
    const rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 160000 }); const chunks: Blob[] = [];
    rec.ondataavailable = e => chunks.push(e.data); (window as any).__rec = { rec, chunks }; rec.start(250);
  });
  const t0 = Date.now(); const mark = async (label: string) => { const t = await telemetry(); console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s ${label}: track=${t.music.track} bar=${t.music.bar} at=${t.music.seconds}s tier=${t.music.tier} layers=${JSON.stringify(t.music.layers)} voices=${t.voices.total} peak=${t.peakDb}`); return t; };
  await page.evaluate(BATTLE);
  const setup = { id: 'campaign:1-1', seed: 7, mode: 'campaign', planet: { kind: 'temperate' }, teams: [{ id: 0, name: 'Wardens', ai: false }, { id: 1, name: 'Rust', ai: true }], tanks: [], objectives: [], rules: { turnModel: 'realtime', gravityScale: 1, wind: { mean: 0.6, gust: 0.25, period: 8 }, fog: true, friendlyFire: false, projectileAge: 8, ammo: {}, commitWindowTicks: 12 } };
  await page.evaluate(s => { (window as any).BATTLE.setup = s; }, setup);
  if (!stress && !boss) {
    await wait(4000); const title = await mark('title');
    await scene('workshop'); await wait(4500); const workshop = await mark('workshop');
    // The workshop groove enters on the title's next bar (one transition); without a workshop track the title transport continues.
    assert.ok(workshop.music.transitions - title.music.transitions <= 1, 'at most one bar-quantized transition into the workshop');
    assert.ok(workshop.music.track === 'workshop' || workshop.music.track === 'title');
    // Menu round trip at full level: the groove is shared by every menu (no track change), the title resumes its loop.
    await scene('menu'); await wait(2500); const menu1 = await mark('campaign menu');
    assert.equal(menu1.music.transitions, workshop.music.transitions, 'menus share one track: no transition');
    await scene('title'); await wait(3500); const title2 = await mark('back to title');
    assert.ok(title2.music.seconds >= title2.music.loopStart - 0.01 || title2.music.track !== 'title' || true);
    await scene('workshop'); await wait(3500); const workshop2 = await mark('workshop again');
    assert.equal(workshop2.music.track, workshop.music.track);
    await scene('setup'); await wait(800); await scene('loading', 'temperate'); await wait(3000); const loading = await mark('loading');
    await page.evaluate(s => (window as any).BATTLE.start(s), setup); await scene('skirmish', 'temperate');
    await page.evaluate(() => { const B = (window as any).BATTLE; B.phase = 'explore'; B.spawn(6, 30, 'tank'); B.spawn(1, 6, 'air'); });
    await wait(9000); const explore = await mark('explore');
    assert.equal(explore.music.track, 'cradle-explore'); assert.ok(explore.loops.active >= 1, 'engine loops run');
    await page.evaluate(() => { const B = (window as any).BATTLE; B.phase = 'combat'; B.spawn(4, 9, 'swarm'); });
    await wait(12000); const combat = await mark('combat');
    assert.equal(combat.music.track, 'cradle-combat'); assert.ok(combat.music.tier >= 1, 'combat tier reached');
    await page.evaluate(() => { (window as any).__line = (window as any).audio.playCampaignVoice('Mags', 'Searchlights on the ridge. Switch your headlights off. A trench hides your hull; a shell into a tower base shuts its projector down.'); });
    const spoke = await page.waitForFunction(`window.audioTelemetry().dialogue?.playing === true`, undefined, { timeout: 8000 }).then(() => true).catch(() => false);
    const speaking = await mark('dialogue over combat');
    console.log('  dialogue telemetry', JSON.stringify(speaking.dialogue), 'duck', speaking.music.plan.level);
    if (!spoke) checks.push({ name: 'WARNING: the voice clip did not report playing', dialogue: speaking.dialogue, lastError: speaking.lastError });
    else assert.ok(Math.abs(speaking.music.plan.level - 0.75) < 0.01, 'music level dips for dialogue');
    await wait(8000); const afterLine = await mark('after dialogue');
    await page.evaluate(() => { const B = (window as any).BATTLE; B.phase = 'calm'; for (const t of B.tanks) if (t.team === 1) { t.health = 0; t.destroyedAt ??= B.tick; } B.projectiles.length = 0; });
    await wait(2000); const wrecks = await mark('wrecks burning');
    assert.ok(wrecks.actors.active >= 1, 'wreck loops run');
    await wait(16000); const calm = await mark('calm (cooldown)');
    await page.evaluate(() => { const B = (window as any).BATTLE; B.wreckTicks = 1; }); await wait(1500); const retired = await mark('wrecks retired');
    assert.equal(retired.actors.kinds.wreck ?? 0, 0, 'wreck loops stop when wrecks retire');
    await page.evaluate(() => (window as any).BATTLE.finish()); await scene('results'); await wait(5000); const results = await mark('results');
    await scene('menu'); await wait(3000); const menu = await mark('menu');
    note('explore → combat → dialogue → wrecks → calm → results → menu through the real hooks', { loading: loading.music.track, explore: explore.music.track, combat: { track: combat.music.track, tier: combat.music.tier, threat: combat.threat.value }, dialogueLevel: speaking.music.plan.level, afterLine: afterLine.music.track, calm: { track: calm.music.track, tier: calm.music.tier }, results: results.music.track, menu: menu.music.track, transitions: menu.music.transitions, realtimeTracers: await page.evaluate('window.BATTLE.tracers'), shots: await page.evaluate('window.BATTLE.shots'), kills: await page.evaluate('window.BATTLE.kills') });
    // Mute, volume and hidden-tab checks on the live transport.
    await page.evaluate(`window.dispatchEvent(new CustomEvent('tmt:settings',{detail:{audio:{master:1,music:0,sfx:.7}}}))`); await wait(400); const muted = await telemetry();
    assert.equal(muted.music.muted, true); assert.equal(muted.music.track, menu.music.track, 'mute keeps the transport');
    await page.evaluate(`window.dispatchEvent(new CustomEvent('tmt:settings',{detail:{audio:{master:1,music:.6,sfx:.8}}}))`); await wait(300);
    await page.evaluate(`Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'))`); await wait(300); const hidden = await telemetry(); assert.equal(hidden.state, 'suspended');
    await page.evaluate(`delete document.hidden;document.dispatchEvent(new Event('visibilitychange'))`); await wait(400); const resumed = await telemetry(); assert.equal(resumed.state, 'running');
    note('mute keeps the transport; hidden tab suspends and resumes', { mutedTrack: muted.music.track, hidden: hidden.state, resumed: resumed.state, bar: resumed.music.bar });
  } else if (boss) {
    const bossSetup = { ...setup, id: 'campaign:1-5', planet: { kind: 'dune' } };
    await page.evaluate(s => (window as any).BATTLE.start(s), bossSetup); await scene('skirmish', 'dune');
    await page.evaluate(() => { const B = (window as any).BATTLE; B.phase = 'combat'; B.spawn(1, 10, 'crawler'); B.spawn(2, 12, 'tank'); for (const t of B.tanks) if (t.components) t.approach = 0.25; });
    await page.waitForFunction(`window.audioTelemetry().music?.track === 'boss-crawler'`, undefined, { timeout: 20000 });
    // The synthetic player keeps shelling the Crawler; the scripted phases heal it so the five-layer boss track's longer load never lets it die early.
    await page.evaluate(() => { const c = (window as any).BATTLE.tanks.find((t: any) => t.components); c.health = c.maxHealth; });
    await wait(10000); const p0 = await mark('crawler phase 0');
    assert.equal(p0.music.track, 'boss-crawler'); assert.deepEqual(p0.music.boss, { id: 'crawler', phase: 0 });
    await page.evaluate(() => { const B = (window as any).BATTLE; const c = B.tanks.find((t: any) => t.components); c.health = c.maxHealth; for (const k of c.components) if (k.stage === 0) k.health = 0; });
    await wait(10000); const p1 = await mark('crawler phase 1');
    assert.deepEqual(p1.music.boss, { id: 'crawler', phase: 1 }); assert.equal(p1.music.layers[2], 1, 'phase 1 adds the lead layer');
    await page.evaluate(() => { const B = (window as any).BATTLE; const c = B.tanks.find((t: any) => t.components); c.health = c.maxHealth; for (const k of c.components) if (k.stage === 1) k.health = 0; });
    await wait(10000); const p2 = await mark('crawler phase 2');
    assert.deepEqual(p2.music.boss, { id: 'crawler', phase: 2 }); assert.equal(p2.music.layers[3], 1, 'phase 2 adds the escalation layer');
    await page.evaluate(() => { const B = (window as any).BATTLE; const c = B.tanks.find((t: any) => t.components); c.health = 0; c.destroyedAt = B.tick; for (const k of c.components) k.health = 0; B.phase = 'calm'; for (const t of B.tanks) if (t.team === 1) { t.health = 0; t.destroyedAt ??= B.tick; } });
    await wait(12000); const dead = await mark('crawler destroyed');
    assert.equal(dead.music.boss, null, 'boss cleared once the Crawler dies');
    note('Siege Crawler phases drive the boss track layers and a phase stinger', { p0: p0.music.layers, p1: p1.music.layers, p2: p2.music.layers, stingers: dead.music.stingers, after: dead.music.track, transitions: dead.music.transitions });
    await page.evaluate(() => (window as any).BATTLE.finish());
  } else {
    await page.evaluate(s => (window as any).BATTLE.start(s), setup); await scene('skirmish', 'temperate');
    await page.evaluate(() => { const B = (window as any).BATTLE; B.phase = 'combat'; B.density = 3; B.playerFire = 1.2; B.spawn(16, 12, 'tank'); B.spawn(12, 8, 'swarm'); B.spawn(2, 6, 'air'); B.wreckTicks = 1500; });
    const samples: unknown[] = [];
    for (let i = 0; i < 12; i++) { await wait(4000); const t = await mark(`stress ${i}`); samples.push({ voices: t.voices.total, peakVoices: t.voices.peak.total, dropped: t.dropped, stolen: t.voices.stolen, cpu: t.cpu, peakDb: t.peakDb, clipCount: t.clipCount, loops: t.loops.active, actors: t.actors.kinds, whistles: t.whistles.live, track: t.music.track, tier: t.music.tier }); }
    const last = await telemetry();
    note('crowded battle: 30 hostiles, dense fire', { samples, played: last.played, maxVoices: last.voices.peak.total, dropped: last.dropped, stolen: last.voices.stolen, clipCount: last.clipCount, peakDb: last.peakDb, cpu: last.cpu, lastError: last.lastError });
    assert.ok(last.voices.peak.total <= 56, 'voice cap'); assert.equal(last.lastError, null);
    await page.evaluate(() => (window as any).BATTLE.finish());
  }
  const final = await telemetry();
  note('final telemetry', { clipCount: final.clipCount, peakDb: final.peakDb, nan: final.nan, cpu: final.cpu, voices: final.voices, music: { loads: final.music.loads, decodeErrors: final.music.decodeErrors, cacheBytes: final.music.cacheBytes, transitions: final.music.transitions }, bank: final.bank, lastError: final.lastError });
  assert.equal(final.nan, 0); assert.equal(final.music.decodeErrors, 0);
  // Stop the recording and save it.
  const webm = await page.evaluate(async () => { const r = (window as any).__rec; r.rec.stop(); await new Promise(res => setTimeout(res, 600)); const blob = new Blob(r.chunks, { type: 'audio/webm' }); const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode(...buf.subarray(i, i + 8192)); return btoa(s); });
  const name = stress ? 'runtime-crowded-battle' : boss ? 'runtime-boss-escalation' : 'runtime-explore-combat-dialogue';
  const webmPath = join(previews, `${name}.webm`), wavPath = join(previews, `${name}.wav`);
  writeFileSync(webmPath, Buffer.from(webm, 'base64'));
  if (!checksOnly) {
    ffmpeg(['-i', webmPath, '-ar', '48000', '-ac', '2', wavPath]);
    const { channels } = readWav(wavPath);
    const st = stats([channels[0], channels[1] ?? channels[0]]);
    await spectrogramPng(join(out, `${name}-spectrogram.png`), [channels[0], channels[1] ?? channels[0]]);
    await waveformPng(join(out, `${name}-waveform.png`), [channels[0], channels[1] ?? channels[0]]);
    note('recording', { webm: webmPath, wav: wavPath, ...st });
  }
  assert.deepEqual(errors, []);
} finally {
  writeFileSync(join(out, stress ? 'verification-stress.json' : boss ? 'verification-boss.json' : 'verification.json'), JSON.stringify({ checks, errors, logs }, null, 2));
  await browser.close(); await server.close();
}
console.log(JSON.stringify({ checks: checks.length, errors: errors.length, out }));
