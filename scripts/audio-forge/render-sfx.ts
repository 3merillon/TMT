/**
 * Renders the effects palette: per-sound WAV masters (G:\tmt-work\audio\sfx), TWO packed mono Opus sprite banks for the
 * runtime (public/audio/sfx/bank.ogg = core: UI, loops, impacts, small mechanics; bank-heavy.ogg = weapons, explosions,
 * destruction; both decoded at start; src/audio/sfx-manifest.json), the effects reels (v1 reel and the weapons reel v2),
 * and analysis.
 *
 *   node --import tsx scripts/audio-forge/render-sfx.ts [--reel-only] [--no-encode]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SR, type Mono, mono, addInto } from './dsp/core';
import { writeWav } from './dsp/wav';
import { spectrogramPng, waveformPng, stats } from './dsp/analyze';
import { encodeOpus, ffmpegVersion } from './encode';
import * as D from './sfx/designs';
import * as V2 from './sfx/designs-v2';
import { UI, uiSeed } from './sfx/ui';

const args = new Set(process.argv.slice(2));
const OUT = process.env.TMT_AUDIO_OUT ?? 'G:/tmt-work/audio';
const SHIP = join(process.cwd(), 'public/audio/sfx');
const MANIFEST = join(process.cwd(), 'src/audio/sfx-manifest.json');
mkdirSync(join(OUT, 'sfx'), { recursive: true }); mkdirSync(join(OUT, 'analysis'), { recursive: true }); mkdirSync(SHIP, { recursive: true });

interface Sprite { id: string; bank: number; variants: { offset: number; seconds: number }[]; loop?: boolean }
type Entry = { id: string; bank: 0 | 1; loop?: boolean; takes: Mono[] };
const seedOf = (id: string, k: number) => { let h = 2166136261; for (const c of `${id}#${k}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const takes = (bank: 0 | 1, id: string, count: number, make: (seed: number, k: number) => Mono, loop = false): Entry => ({ id, bank, loop, takes: Array.from({ length: count }, (_, k) => make(seedOf(id, k), k)) });
const core = (id: string, count: number, make: (seed: number, k: number) => Mono, loop = false) => takes(0, id, count, make, loop);
const heavy = (id: string, count: number, make: (seed: number, k: number) => Mono, loop = false) => takes(1, id, count, make, loop);
const MATERIALS: V2.Material[] = ['soil', 'rock', 'concrete', 'metal'];

const entries: Entry[] = [
  // ---- heavy bank: weapons (near 6, mid 3, far 2 where it matters), explosions by material, destruction ---------------------
  heavy('cannon', 6, s => V2.cannonReport(s, 'near')), heavy('cannon-mid', 3, s => V2.cannonReport(s, 'mid')), heavy('cannon-far', 2, s => V2.cannonReport(s, 'far')),
  heavy('mortar', 4, s => V2.mortarReport(s, 'near')), heavy('mortar-mid', 2, s => V2.mortarReport(s, 'mid')), heavy('mortar-far', 1, s => V2.mortarReport(s, 'far')),
  heavy('rail', 3, s => V2.railReport(s, 'near')), heavy('rail-mid', 2, s => V2.railReport(s, 'mid')), heavy('rail-far', 1, s => V2.railReport(s, 'far')),
  heavy('autocannon', 4, s => V2.autocannonReport(s, 'near')), heavy('autocannon-mid', 2, s => V2.autocannonReport(s, 'mid')),
  heavy('arc', 3, s => V2.arcReport(s, 'near')), heavy('arc-mid', 1, s => V2.arcReport(s, 'mid')), heavy('arc-crackle', 2, s => V2.arcCrackle(s)),
  heavy('forge-mortar', 2, s => D.forgeMortarFire(s)), heavy('forge-mortar-far', 1, s => D.forgeMortarFire(s, true)),
  heavy('he-small', 2, s => V2.explosionMaterial(s, 'he', 0.25, 'soil')),
  ...MATERIALS.map(m => heavy(`he-${m}`, 2, s => V2.explosionMaterial(s, 'he', 0.5, m))),
  heavy('he', 2, s => V2.explosionMaterial(s, 'he', 0.5, 'soil')),
  heavy('he-large', 2, (s, k) => V2.explosionMaterial(s, 'he', 0.8, k ? 'rock' : 'soil')),
  heavy('heavy', 2, (s, k) => V2.explosionMaterial(s, 'heavy', 0.9, k ? 'rock' : 'soil')), heavy('incendiary', 1, s => V2.explosionMaterial(s, 'incendiary', 0.5, 'soil')), heavy('nuclear', 1, s => V2.explosionMaterial(s, 'nuclear', 1, 'rock')),
  heavy('he-far', 2, s => V2.explosionMaterial(s, 'he', 0.5, 'soil', true)), heavy('heavy-far', 1, s => V2.explosionMaterial(s, 'heavy', 0.9, 'rock', true)),
  heavy('destruction', 2, s => D.destructionBurst(s)), heavy('destruction-big', 1, s => D.destructionBurst(s, true)),
  heavy('wreck-pops', 2, s => V2.wreckPops(s)), heavy('turret-ring', 2, s => V2.turretRing(s)),
  // ---- core bank: machine guns, snaps, ricochets by material, reloads, armour, loops, UI ---------------------------------------
  core('coax', 4, s => D.coaxShot(s)), core('coax-burst', 4, s => D.coaxBurst(s)), core('coax-loop', 3, s => V2.coaxLoop(s), true), core('coax-tail', 3, s => V2.coaxTail(s)),
  core('snap', 4, s => V2.snap(s)),
  core('reload', 3, s => D.reloadClunk(s)), core('reload-heavy', 2, s => D.reloadClunk(s, 0.72)),
  core('ricochet', 5, s => D.ricochet(s)), ...(['rock', 'concrete', 'soil', 'water'] as V2.Material[]).map(m => core(`ric-${m}`, 2, s => V2.ricochetMaterial(s, m))),
  core('penetrate', 4, s => D.penetrate(s)), core('penetrate-heavy', 2, s => D.penetrate(s, true)),
  core('shield-hit', 2, s => D.shieldHit(s)), core('emp', 1, s => D.empZap(s)), core('ear-ring', 1, s => V2.earRing(s)),
  core('wreck-fire', 1, s => D.wreckFireLoop(s), true), core('metal-creak', 3, s => D.metalCreak(s)),
  core('rubble', 2, s => D.rubbleSettle(s, 0.5)), core('rubble-large', 1, s => D.rubbleSettle(s, 1)),
  core('thump', 4, s => D.suspensionThump(s, 0.5)), core('thump-hard', 3, s => D.suspensionThump(s, 1)), core('landing', 2, s => D.treadLanding(s)),
  core('rotor', 1, s => D.rotorLoop(s), true), core('hover', 1, s => D.hoverLoop(s), true), core('swarm', 1, s => D.swarmLoop(s), true),
  core('crawler', 1, s => D.crawlerLoop(s), true), core('spire', 1, s => D.spireLoop(s), true), core('searchlight', 1, s => D.searchlightLoop(s), true), core('shield', 1, s => D.shieldLoop(s), true),
  ...Object.keys(UI).map(name => core(`ui-${name}`, 1, () => UI[name](uiSeed(name)))),
];

// ---- pack --------------------------------------------------------------------------------------------------------------
const GAP = Math.round(0.06 * SR);
const BANK_FILES = ['bank.ogg', 'bank-heavy.ogg'];
const banks = [0, 1].map(b => {
  const mine = entries.filter(e => e.bank === b);
  let total = 0; for (const e of mine) for (const t of e.takes) total += t.length + GAP;
  return { file: BANK_FILES[b], buf: mono(total + GAP), cursor: GAP / 2, entries: mine, bytes: 0 };
});
const sprites: Sprite[] = [];
for (const e of entries) {
  const bank = banks[e.bank];
  const s: Sprite = { id: e.id, bank: e.bank, variants: [], ...(e.loop ? { loop: true } : {}) };
  for (const t of e.takes) {
    addInto(bank.buf, t, bank.cursor);
    s.variants.push({ offset: Math.round(bank.cursor / SR * 1e5) / 1e5, seconds: Math.round(t.length / SR * 1e5) / 1e5 });
    bank.cursor += t.length + GAP;
  }
  sprites.push(s);
  if (!args.has('--reel-only')) writeWav(join(OUT, 'sfx', `${e.id}.wav`), e.takes.length === 1 ? e.takes[0] : e.takes.reduce((acc, t) => { const o = mono(acc.length + t.length + GAP); addInto(o, acc, 0); addInto(o, t, acc.length + GAP); return o; }));
}
for (const bank of banks) {
  let peak = 0; for (let i = 0; i < bank.buf.length; i++) peak = Math.max(peak, Math.abs(bank.buf[i]));
  const wav = join(OUT, 'sfx', bank.file.replace('.ogg', '.wav'));
  writeWav(wav, bank.buf);
  if (!args.has('--no-encode') && !args.has('--reel-only')) bank.bytes = encodeOpus(wav, join(SHIP, bank.file), 64, { mono: true });
  console.log(`${bank.file}: ${bank.entries.length} sprites, ${bank.entries.reduce((a, e) => a + e.takes.length, 0)} takes, ${(bank.buf.length / SR).toFixed(1)} s, peak ${peak.toFixed(3)}, opus ${(bank.bytes / 1024).toFixed(0)} KB`);
}
writeFileSync(MANIFEST, JSON.stringify({
  version: 2, file: banks[0].file, sampleRate: SR, seconds: banks[0].buf.length / SR, samples: banks[0].buf.length, bytes: banks[0].bytes,
  banks: banks.map(b => ({ file: b.file, seconds: b.buf.length / SR, samples: b.buf.length, bytes: b.bytes })),
  encoder: ffmpegVersion(), generated: new Date().toISOString(), sprites: Object.fromEntries(sprites.map(s => [s.id, s])),
}, null, 1));

// ---- reels -----------------------------------------------------------------------------------------------------------------
const take = (id: string, k = 0) => { const e = entries.find(e => e.id === id)!; return e.takes[k % e.takes.length]; };
function reel(name: string, seconds: number, place: (put: (id: string, at: number, gain?: number, k?: number) => void) => void): Mono {
  const buf = mono(Math.round(seconds * SR));
  place((id, at, gain = 1, k = 0) => addInto(buf, take(id, k), Math.round(at * SR), gain));
  let rp = 0; for (let i = 0; i < buf.length; i++) rp = Math.max(rp, Math.abs(buf[i])); for (let i = 0; i < buf.length; i++) buf[i] *= 0.9 / rp;
  const wav = join(OUT, 'previews', `${name}.wav`);
  writeWav(wav, [buf, buf], { bits: 16 });
  if (!args.has('--no-encode')) encodeOpus(wav, join(OUT, 'previews', `${name}.ogg`), 128);
  console.log(`${name} ${seconds} s -> ${wav}`);
  return buf;
}
// The v1 reel (a tank fires, the shell lands, armour hits, a wreck, fire, creaks) on the new sprites.
const reel1 = reel('sfx-reel', 26, put => {
  put('cannon', 0.5); put('reload', 2.1, 0.5); put('he', 2.0, 0.9);
  put('cannon', 4.5, 1, 1); put('reload', 6.1, 0.5, 1); put('ricochet', 5.4, 0.8); put('he-small', 5.4, 0.6);
  put('coax-burst', 7.0, 0.7); put('coax-burst', 7.6, 0.7, 1); put('ricochet', 7.2, 0.5, 2); put('ricochet', 7.9, 0.5, 3);
  put('mortar', 9.0); put('penetrate', 10.6, 0.9); put('he', 10.6, 0.8, 1);
  put('rail', 12.4); put('penetrate-heavy', 13.3, 1); put('destruction', 13.35, 1);
  const fire = take('wreck-fire', 0); for (let k = 0; k < 3; k++) put('wreck-fire', 14.2 + k * fire.length / SR, 0.55);
  put('metal-creak', 16.0, 0.6); put('metal-creak', 18.5, 0.5, 1); put('rubble', 15.0, 0.5);
  put('cannon-far', 20.5, 0.8); put('he-far', 21.4, 0.9); put('metal-creak', 22.5, 0.4, 2);
  put('ui-objectiveDone', 24.0, 0.6);
});
// The weapons reel v2: every weapon near / mid / far, MG sustained fire with its tail, snaps, ricochets by material,
// explosions by material, a multi-stage wreck, the ear ring.
const reel2 = reel('weapons-reel-v2', 58, put => {
  let t = 0.5;
  for (const w of ['cannon', 'mortar', 'rail', 'autocannon', 'arc']) {
    put(w, t); put(`${w}-mid`, t + 2.2, 0.9); if (['cannon', 'mortar', 'rail'].includes(w)) put(`${w}-far`, t + 4.4, 0.85);
    t += 6.8;
  }
  put('forge-mortar', t); put('forge-mortar-far', t + 2.2, 0.85); t += 4.6;
  // MG: the loop sustained for 2.2 s then the tail; snaps passing the listener.
  const loop = take('coax-loop', 0); for (let k = 0; k * loop.length / SR < 2.2; k++) put('coax-loop', t + k * loop.length / SR, 0.8); put('coax-tail', t + 2.25, 0.8);
  put('snap', t + 0.6, 0.9); put('snap', t + 1.1, 0.9, 1); put('snap', t + 1.7, 0.9, 2); t += 4.2;
  for (const m of ['ricochet', 'ric-rock', 'ric-concrete', 'ric-soil', 'ric-water']) { put(m, t, 0.9); put(m, t + 0.45, 0.8, 1); t += 1.1; }
  t += 0.4;
  for (const m of ['he-soil', 'he-rock', 'he-concrete', 'he-metal']) { put(m, t); t += 3.2; }
  put('heavy', t); put('ear-ring', t + 0.05, 0.5); t += 3.6;
  put('destruction', t); put('turret-ring', t + 0.5, 0.8); put('wreck-pops', t + 1.1, 0.7); t += 6;
  put('arc-crackle', t, 0.8);
});
await spectrogramPng(join(OUT, 'analysis', 'sfx-reel-spectrogram.png'), [reel1, reel1]);
await waveformPng(join(OUT, 'analysis', 'sfx-reel-waveform.png'), [reel1, reel1]);
await spectrogramPng(join(OUT, 'analysis', 'weapons-reel-v2-spectrogram.png'), [reel2, reel2]);
const report: Record<string, unknown> = { reel: stats([reel1, reel1]), weaponsReelV2: stats([reel2, reel2]) };
for (const e of entries) report[e.id] = e.takes.map(t => { const s = stats([t, t]); return { seconds: s.seconds, lufs: s.integratedLufs, peak: s.truePeakDb, crest: s.crestDb, bands: s.bands }; });
writeFileSync(join(OUT, 'analysis', 'sfx.json'), JSON.stringify(report, null, 1));
console.log(`banks: ${banks.map(b => `${b.file} ${(b.buf.length / SR).toFixed(1)} s`).join(', ')}`);
