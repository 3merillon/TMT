/** Real-browser workshop audio lifecycle qualification and original-score WAV audition. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import { defaultProfile, PROFILE_KEY } from '../../src/game/meta/profile';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..'), out = join(root, 'artifacts/workshop-audio');
const results: { name: string; detail?: unknown }[] = [], errors: string[] = [];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const record = (name: string, detail?: unknown) => { results.push({ name, detail }); console.log(`[audio] PASS ${name}`); };
let browser: Browser | undefined, context: BrowserContext | undefined, vite: ViteDevServer | undefined, page: Page;
const state = () => page.evaluate<any>('window.__tmtWorkshop.snapshot().audio');
const gameAudio = () => page.evaluate<any>(`import('/src/game/app/hooks.ts').then(m=>m.collectTelemetry().audio)`);
async function enter() {
  await page.locator('#title-workshop').click();
  await page.waitForFunction('window.__tmtWorkshop?.ready && !document.querySelector(".ws-loading")', undefined, { timeout: 90000 });
  await page.waitForFunction('window.__tmtWorkshop.snapshot().audio.state === "running"'); await sleep(1900);
}
async function audition(name: string, mode: 'mix' | 'music' | 'sfx' | 'skirmish', seconds: number) {
  const result = await page.evaluate<any>(`(async()=>{
    const module=await import('/src/game/workshop/audio.ts'), seconds=${seconds};
    const context=new OfflineAudioContext(2, Math.ceil(seconds*44100),44100);
    ${mode === 'skirmish' ? "const {ElectroMusic}=await import('/src/audio/electro-music.ts');const bus=context.createGain();bus.gain.value=.8*.65*.65;bus.connect(context.destination);" : ''}
    const audio=${mode === 'mix' ? 'module.scheduleWorkshopAudioPreview(context,seconds)' : mode === 'skirmish' ? "new ElectroMusic(context,bus,{mode:'skirmish',offline:true})" : `new module.WorkshopAudio({master:.8,music:${mode === 'music' ? '.65' : '0'},sfx:${mode === 'sfx' ? '.8' : '0'}},{context,offline:true})`};
    ${mode === 'mix' || mode === 'skirmish' ? '' : 'audio.unlock();'}
    ${mode === 'skirmish' ? 'audio.setIntensity(.1);audio.scheduleUntil(20);audio.setIntensity(.8);audio.scheduleUntil(seconds);' : ''}
    ${mode === 'music' ? 'audio.scheduleMusic(seconds);' : ''}
    ${mode === 'sfx' ? `audio.setMotion({lift:.6,arm:.4,trolley:.2});audio.update();['servo','release','clamp','ratchet','seat','steam'].forEach((kind,i)=>audio.play(kind,[-1,1,0],1+i*1.25));` : ''}
    const buffer=await context.startRendering(), channels=[buffer.getChannelData(0),buffer.getChannelData(1)];
    let peak=0,energy=0,clipped=0,nonfinite=0;const bins=[];
    for(let start=0;start<buffer.length;start+=44100){let energy=0;for(let i=start;i<Math.min(buffer.length,start+44100);i++)for(const c of channels)energy+=c[i]*c[i];bins.push(Math.sqrt(energy/(Math.min(44100,buffer.length-start)*2)));}
    const bytes=new Uint8Array(44+buffer.length*4),view=new DataView(bytes.buffer);
    const tag=(offset,text)=>{for(let i=0;i<text.length;i++)bytes[offset+i]=text.charCodeAt(i);};
    tag(0,'RIFF');view.setUint32(4,bytes.length-8,true);tag(8,'WAVE');tag(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,2,true);view.setUint32(24,44100,true);view.setUint32(28,44100*4,true);view.setUint16(32,4,true);view.setUint16(34,16,true);tag(36,'data');view.setUint32(40,bytes.length-44,true);
    for(let i=0;i<buffer.length;i++)for(let c=0;c<2;c++){const sample=channels[c][i];if(!Number.isFinite(sample))nonfinite++;peak=Math.max(peak,Math.abs(sample));energy+=sample*sample;if(Math.abs(sample)>=1)clipped++;view.setInt16(44+(i*2+c)*2,Math.round(Math.max(-1,Math.min(1,sample))*32767),true);}
    const diagnostic=audio.snapshot();audio.dispose();let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    return{encoded:btoa(binary),seconds,peak,rms:Math.sqrt(energy/(buffer.length*2)),clipped,nonfinite,secondRms:bins,diagnostic,disposed:audio.snapshot()};
  })()`);
  writeFileSync(join(out, `${name}.wav`), Buffer.from(result.encoded, 'base64')); delete result.encoded;
  assert.equal(result.nonfinite, 0); assert.equal(result.clipped, 0); assert.ok(result.peak > .015 && result.peak < .9); assert.ok(result.rms > .002);
  assert.equal(result.disposed.nodes, 0); record(`${mode} offline audition is finite, audible and unclipped`, result);
}
async function main() {
  mkdirSync(out, { recursive: true });
  try {
    vite = await createServer({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn', clearScreen: false, cacheDir: join(root, '.vite-capture/workshop-audio'), server: { host: '127.0.0.1', port: 0, hmr: false, watch: null, open: false } });
    await vite.listen();
    const store = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
    const executablePath = process.env.TMT_CHROME ?? readdirSync(store).filter(n => /^chromium-\d+$/.test(n)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])).map(n => join(store, n, 'chrome-win64/chrome.exe')).find(existsSync);
    assert.ok(executablePath);
    browser = await chromium.launch({ executablePath, headless: true, ignoreDefaultArgs: ['--headless'], args: ['--headless=new', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu', '--force-color-profile=srgb', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
    context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    await context.route(/\/favicon\.ico(\?|$)/, route => route.fulfill({ status: 204, body: '' }));
    const profile = defaultProfile(); profile.loadouts[0].kit = { hull: 'skiff', runningGear: 'scout', turret: 'dome', weapon: 'mortar', utility: 'antenna' };
    await context.addInitScript(({ key, initial }) => localStorage.setItem(key, initial), { key: PROFILE_KEY, initial: JSON.stringify(profile) });
    page = await context.newPage();
    page.on('pageerror', e => errors.push(e.stack ?? e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); page.on('response', r => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
    await page.goto(`${vite.resolvedUrls!.local[0]}play.html`, { waitUntil: 'domcontentloaded' }); await enter();
    const initial = await state(), global = await gameAudio(); assert.equal(initial.musicNotes, 0); assert.equal(initial.musicOwner, 'application'); assert.ok(global.music.notes >= 8); assert.equal(initial.lastError, null); assert.equal(global.workshopSuppressed, false); assert.equal(global.state, 'running'); record('entry click unlocks spatial machines while the application score continues', { initial, global });
    const up = page.locator('#workshop-lift-up'), box = await up.boundingBox(); assert.ok(box); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await sleep(650);
    const moving = await state(); assert.ok(moving.motion.lift > .4); await page.mouse.up(); await sleep(180); assert.equal((await state()).motion.lift, 0); record('physical lift button drives continuous hydraulic sound and release stops it', moving);
    await page.evaluate(`(()=>{const e=window.__tmtWorkshop.engine;window.__audioOriginalFrame=e.frame.bind(e);e.frame=f=>window.__audioOriginalFrame({...f,camera:{position:[2.65,1.55,4.5],target:[2.22,1.12,2.45],up:[0,1,0],fovY:38*Math.PI/180}});document.querySelector('.ws-overlay').style.visibility='hidden';})()`);
    await sleep(700); await up.hover(); await sleep(300); await page.screenshot({ path: join(out, 'physical-up-backlit-hover.png') });
    await page.evaluate(`window.__tmtWorkshop.engine.frame=window.__audioOriginalFrame;document.querySelector('.ws-overlay').style.visibility='visible'`); await sleep(300);
    await page.locator('#workshop-open-components').click(); await page.locator('#workshop-slot-weapon').click(); await page.locator('#workshop-part-cannon').click();
    const beforeCues = (await state()).cues; await page.locator('#workshop-install').click();
    const motionSamples = []; for (let i = 0; i < 24; i++) { await sleep(95); motionSamples.push(await state()); }
    await page.waitForFunction('!window.__tmtWorkshop.busy'); assert.ok(motionSamples.some(s => s.motion.arm > .05)); assert.ok(motionSamples.some(s => s.motion.trolley > .05)); assert.ok((await state()).cues >= beforeCues + 3); record('installation drives arm and trolley loops with localized stage cues', { maxArm: Math.max(...motionSamples.map(s => s.motion.arm)), maxTrolley: Math.max(...motionSamples.map(s => s.motion.trolley)), cues: (await state()).cues - beforeCues });
    await page.evaluate(`(()=>{const p=JSON.parse(localStorage.getItem('${PROFILE_KEY}'));window.dispatchEvent(new CustomEvent('tmt:settings',{detail:{...p.settings,audio:{...p.settings.audio,master:1,music:0,sfx:.7}}}));})()`); await sleep(150);
    const muted = await state(), mutedNotes = (await gameAudio()).music.notes; await sleep(500); assert.equal((await gameAudio()).music.notes, mutedNotes); assert.deepEqual(muted.levels, { master: 1, music: 0, sfx: .7 });
    await page.evaluate(`(()=>{const p=JSON.parse(localStorage.getItem('${PROFILE_KEY}'));window.dispatchEvent(new CustomEvent('tmt:settings',{detail:{...p.settings,audio:{...p.settings.audio,master:1,music:.6,sfx:0}}}));})()`); await sleep(650); assert.ok((await gameAudio()).music.notes > mutedNotes); assert.deepEqual((await state()).levels, { master: 1, music: .6, sfx: 0 }); record('existing master, music and SFX settings act independently');
    await page.evaluate(`(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));})()`); await sleep(150); assert.equal((await state()).state, 'suspended'); assert.equal((await gameAudio()).state, 'suspended'); const paused = (await gameAudio()).music.notes; await sleep(300); assert.equal((await gameAudio()).music.notes, paused);
    await page.evaluate(`(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));})()`); await sleep(400); assert.equal((await state()).state, 'running'); assert.equal((await gameAudio()).state, 'running'); record('background visibility suspends both contexts and resumes the same score');
    await page.evaluate(`window.__audioStream=window.__tmtWorkshop.captureAudio()`); const trackCount = await page.evaluate<number>('window.__audioStream.getAudioTracks().length'); assert.equal(trackCount, 1);
    await page.locator('#workshop-back').click(); await sleep(400); let disposed = await state(); assert.equal(disposed.nodes, 0); assert.equal(disposed.voices, 0); assert.equal(disposed.state, 'disposed'); assert.equal((await gameAudio()).workshopSuppressed, false); assert.equal((await gameAudio()).state, 'running'); assert.equal(await page.evaluate('window.__audioStream.getAudioTracks()[0].readyState'), 'ended'); record('exit stops recording track and releases all workshop audio nodes', disposed);
    for (let cycle = 0; cycle < 2; cycle++) { const before = (await gameAudio()).music.step; await enter(); assert.equal((await gameAudio()).workshopSuppressed, false); assert.ok((await gameAudio()).music.step > before); await page.locator('#workshop-back').click(); await sleep(250); disposed = await state(); assert.equal(disposed.nodes, 0); assert.equal(disposed.voices, 0); assert.equal((await gameAudio()).workshopOwners, 0); } record('three complete workshop visits release machinery and preserve one music clock');
    await audition('workshop-electro-and-machinery', 'mix', 45); await audition('workshop-copper-circuit', 'music', 45); await audition('workshop-machine-cues-damped', 'sfx', 10); await audition('skirmish-copper-circuit', 'skirmish', 45);
    assert.deepEqual(errors, []); record('browser audio, rendering and network error log is clean');
  } catch (error) { process.exitCode = 1; errors.push(String(error)); console.error(error); if (page!) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {}); }
  finally { writeFileSync(join(out, 'verification.json'), JSON.stringify({ createdAt: new Date().toISOString(), results, errors }, null, 2)); console.log(JSON.stringify({ passed: results.length, errors: errors.length, out })); await context?.close(); await browser?.close(); await vite?.close(); }
}
await main();
