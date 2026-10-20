/**
 * The four remaining world sets. Each shares the TMT motif and the drum/guitar language but has its own key, metre,
 * tempo and textures:
 *   dune   Amber Reach   F minor/phrygian, abrasive: a 7/8 exploration, grinding semitone riffs, anvils and chains
 *   frost  Frostmere     C# minor, cold precision: tight single-note picking, FM bells, fractured glitch textures
 *   forge  Cinder Forge  A minor drop-A, furnace-heavy: crushing half-time slams, double-kick bursts, steam and pipes
 *   halo   Shattered Halo D minor with tritone planing, unstable electronic momentum: arps, 3+3+2 accents, glitches
 */
import { Track, seq } from '../sequencer';
import { AMPS } from '../instruments/guitar';
import { machinePulse, riser, renderPluck, renderPad, drone, glitchSeq, renderSawLead, renderBell, impact } from '../instruments/synth';
import { noteHz } from '../dsp/core';
import { STEMS, bars, motif, bassLine } from './shared';

const bellsOf = (t: Track, notation: string, bar: number, vel = 0.8, oct = 1) => t.riff(notation, { bar, vel }).map(e => ({ at: e.at, gate: e.gate, freq: e.freq * oct, vel: e.vel }));
const synthOf = (t: Track, notation: string, bar: number, vel = 0.8) => t.riff(notation, { bar, vel }).map(e => ({ at: e.at, gate: e.gate, freq: e.freq, vel: e.vel, accent: e.vel > 0.95 }));

// ---- Dune --------------------------------------------------------------------------------------------------------------
export function duneExplore(): Track {
  // 7/8 at 104 BPM: 14 sixteenth steps per bar.
  const t = new Track({ id: 'dune-explore', title: 'Rim Wind', bpm: 104, beatsPerBar: 3.5, introBars: 2, loopBars: 32, tailBars: 2, seed: 5201, targetLufs: -16 });
  t.stem('atmo', STEMS.atmo(-1)); t.stem('drums', STEMS.drums(-6)); t.stem('bass', STEMS.bass(-8)); t.stem('guitars', STEMS.guitars(-4)); t.stem('lead', STEMS.lead(-5));
  const I = 2;
  const GRIND = 'F2m:2 F2m:1 Gb2m:1 F2m:2 -:2 F2m:1 F2m:1 >Ab2m:2 F2x:1 F2x:1 -:1';            // 14
  const GRIND_B = 'F2m:2 F2m:1 Gb2m:1 F2m:2 -:2 >Db2m:2 >C2m:2 F2x:1 F2x:1';                 // 14
  const STAB = '>F2P:4 -:3 >Gb2P:3 -:4 | >F2P:4 -:3 >Eb2P:3 >Db2P:4';                        // 2 bars
  t.guitar('guitars', [...t.riff(seq(GRIND, GRIND, GRIND, GRIND_B, GRIND, GRIND, GRIND, GRIND_B), { bar: I, vel: 0.8 }), ...t.riff(seq(STAB, STAB, STAB, STAB), { bar: I + 16, vel: 0.85 }), ...t.riff(seq(GRIND, GRIND_B, GRIND, GRIND_B, GRIND, GRIND, GRIND, GRIND_B), { bar: I + 24, vel: 0.8 })], { amp: AMPS.crunch });
  t.bass('bass', t.riff(seq(bassLine(seq(GRIND, GRIND, GRIND, GRIND_B, GRIND, GRIND, GRIND, GRIND_B)), 'F2o:7 Gb2o:7 | F2o:7 Eb2o:3 Db2o:4 | F2o:7 Gb2o:7 | F2o:7 Eb2o:3 Db2o:4 | F2o:7 Gb2o:7 | F2o:7 Eb2o:3 Db2o:4 | F2o:7 Gb2o:7 | F2o:7 Eb2o:3 Db2o:4', bassLine(seq(GRIND, GRIND_B, GRIND, GRIND_B, GRIND, GRIND, GRIND, GRIND_B))), { bar: I, vel: 0.85 }), { drive: 3, sub: 0.4 });
  const A = { kick: 'x......x..x...', rim: '....x......x..', hat: 'x.x.x.x.x.x.x.', chain: '......x.......' };
  const AF = { kick: 'x......x..x.x.', rim: '....x......x..', hat: 'x.x.x.x.x.x...', anvil: '............x.' };
  const B = { kick: 'x...x..x..x...', snare: '....x......x..', hat: 'x.x.x.x.x.x.x.', anvil: 'x.............' };
  const BF = { kick: 'x...x..x..xxx.', snare: '....x......x.x', hat: 'x.x.x.x.x.....', tomLo: '............x.' };
  t.kit('drums', [...bars(t, A, AF, I, 8), ...bars(t, A, AF, I + 8, 8), ...bars(t, B, BF, I + 16, 8), ...bars(t, A, AF, I + 24, 8)], { style: { kickClick: 0.9, drive: 0.3 } });
  // Phrygian motif fragments on a dark pluck; a sand-noise bed and a slow metallic pulse.
  const frag = 'F4o:2 Gb4o:2 F4o:2 -:2 Eb4o:2 F4o:2 -:2 | Db4o:4 C4o:2 F4o:4 -:4';
  t.add('lead', renderPluck(bellsOf(t, seq(frag, frag), I + 4, 0.7, 2), t.length, { seed: 61, cutoff: 3000, crush: 9, width: 0.2, decay: 0.4 }), -6, -0.2);
  t.add('lead', renderPluck(bellsOf(t, seq(frag, frag), I + 20, 0.75, 2), t.length, { seed: 62, cutoff: 3400, crush: 9, width: 0.2, decay: 0.4 }), -6, 0.2);
  t.guitar('lead', t.riff(seq(motif('F4'), motif('F4', 'answer')), { bar: I + 26, vel: 0.8 }), { amp: AMPS.lead, lead: true, gainDb: -5 });
  t.add('atmo', drone(t.length, { seed: 63, freq: noteHz('F1'), cutoff: 180, wobble: 0.7, level: 0.45 }), -10);
  t.add('atmo', machinePulse(t.length, { seed: 64, rate: t.bpm / 60 / 3.5, freq: 2400, q: 10, level: 0.35, duty: 0.08 }), -14, 0.4);
  t.add('atmo', riser(60 / t.bpm * 7, { seed: 65, freqFrom: 44, freqTo: 180, noise: 0.95 }), -12, -0.3, t.at(I + 14));
  return t;
}
export function duneCombat(): Track {
  const t = new Track({ id: 'dune-combat', title: 'Sandstorm Teeth', bpm: 146, introBars: 2, loopBars: 32, tailBars: 2, seed: 5202, targetLufs: -12.5 });
  t.stem('drums', STEMS.drums(-2)); t.stem('bass', STEMS.bass(-5)); t.stem('guitars', STEMS.guitars(2)); t.stem('lead', STEMS.lead(-2)); t.stem('electro', STEMS.electro(1)); t.stem('escalation', STEMS.escalation(-7));
  const I = 2;
  const GRIND = 'F2m:1 F2m:1 Gb2m:1 F2m:1 F2m:2 >Ab2P:2 F2m:1 F2m:1 Gb2m:1 F2m:1 >Eb2P:2 F2x:1 F2x:1';
  const GRIND_B = 'F2m:1 F2m:1 Gb2m:1 F2m:1 F2m:2 >Db2P:2 F2m:1 F2m:1 >C2P:2 >Db2P:2 >Eb2P:2';
  const TREM = 'F2m:1 F2m:1 F2m:1 F2m:1 Gb2m:1 Gb2m:1 Gb2m:1 Gb2m:1 F2m:1 F2m:1 F2m:1 F2m:1 Eb2m:1 Eb2m:1 Db2m:1 Db2m:1';
  const STOPS = '>F2M:2 -:2 >Gb2M:2 -:2 >F2M:1 F2x:1 -:2 >Ab2P:2 >Gb2P:2';
  const STOPS_B = '>F2M:2 -:2 >Gb2M:2 -:2 >Eb2P:2 >Db2P:2 >C2P:2 >Db2P:2';
  const HOOK = '>F2W:8 >Db2W:8 | >Eb2W:8 >Gb2W:4 >F2W:4';
  t.guitar('guitars', [
    ...t.riff(seq(GRIND, GRIND, GRIND, GRIND_B, GRIND, GRIND, GRIND, GRIND_B), { bar: I }),
    ...t.riff(seq(TREM, TREM, GRIND, GRIND_B, TREM, TREM, GRIND, GRIND_B), { bar: I + 8, vel: 0.9 }),
    ...t.riff(seq(STOPS, STOPS, STOPS, STOPS_B), { bar: I + 16, vel: 1 }),
    ...t.riff(seq(GRIND, GRIND_B, GRIND, GRIND_B, TREM, TREM, GRIND, 'F2m:1 F2m:1 >Gb2P:2 >Ab2P:2 >Bb2P:2 >B2P:2 >Bb2P:2 >Ab2P:2 >Gb2P:2'), { bar: I + 20 }),
    ...t.riff(seq(HOOK, HOOK.replace('>F2W:4', '>F2W:2 F2x:1 F2x:1')), { bar: I + 28, vel: 1 }),
  ], { amp: AMPS.rhythm });
  t.guitar('escalation', t.riff(seq(...Array(32).fill(TREM)), { bar: I, vel: 0.85, transpose: 12 }), { amp: AMPS.lead, lead: true, gainDb: -6 });
  t.bass('bass', [
    ...t.riff(bassLine(seq(GRIND, GRIND, GRIND, GRIND_B, GRIND, GRIND, GRIND, GRIND_B, TREM, TREM, GRIND, GRIND_B, TREM, TREM, GRIND, GRIND_B, STOPS, STOPS, STOPS, STOPS_B, GRIND, GRIND_B, GRIND, GRIND_B, TREM, TREM, GRIND, 'F2m:1 F2m:1 Gb2m:2 Ab2m:2 Bb2m:2 B2m:2 Bb2m:2 Ab2m:2 Gb2m:2')), { bar: I, vel: 0.95 }),
    ...t.riff('F2o:8 Db2o:8 | Eb2o:8 Gb2o:4 F2o:4 | F2o:8 Db2o:8 | Eb2o:8 Gb2o:4 F2o:2 F2x:1 F2x:1', { bar: I + 28, vel: 1 }),
  ], { drive: 3.8, sub: 0.35 });
  t.guitar('lead', [...t.riff(seq(motif('F4'), motif('F4', 'answer').replace(/C#4/g, 'C4'), motif('F4', 'fast'), motif('F4', 'high')), { bar: I + 8, vel: 0.95 }), ...t.riff(seq(motif('F4', 'high'), motif('F4', 'answer').replace(/C#4/g, 'C4').replace(/(\d)o/g, (_, d) => `${Number(d) + 1}o`)), { bar: I + 28, vel: 1 })], { amp: AMPS.lead, lead: true });
  const A = { kick: 'x..x..x.x..x..x.', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.', anvil: 'x...............' };
  const AF = { kick: 'x..x..x.x..x.xxx', snare: '....X.......X.X.', hat: 'x.x.x.x.x.x.....', chain: '..........x.....', china: '..............x.' };
  const B = { kick: 'x.x.x.x.x.x.x.x.', snare: '....X.......X...', ride: 'x.x.x.x.x.x.x.x.', crash: 'x...............' };
  const BF = { kick: 'x.x.x.x.xxxxxxxx', snare: '....X...X.X.X.XX', ride: 'x.x.x.x.........', china: '............x...' };
  const C = { slam: 'x...........x...', kick: 'x...x...x...x...', snare: '........X.......', hatOpen: 'x...x...x...x...', anvil: 'x.......x.......' };
  const CF = { slam: 'x...........x...', kick: 'x...x...x...xxxx', snare: '........X...X.X.', hatOpen: 'x...x...x.......', crash: '............x...' };
  const K = { kick: 'x...x.x.x...x.x.', snare: '....X.......X...', crash: 'x...............', ride: 'x.x.x.x.x.x.x.x.', anvil: 'x.......x.......' };
  const KF = { kick: 'x..xx..xx..xx.xx', snare: '....X...X...X.XX', crash: 'x.......x.......', china: '..............x.' };
  t.kit('drums', [...t.drums({ kick: '........x.x.x.x.', snare: '........X...X...', tomLo: '............x.x.', crash: '...............x' }, { bar: I - 1 }), ...bars(t, A, AF, I, 4), ...bars(t, A, AF, I + 4, 4), ...bars(t, B, BF, I + 8, 4), ...bars(t, B, BF, I + 12, 4), ...bars(t, C, CF, I + 16, 4), ...bars(t, A, AF, I + 20, 4), ...bars(t, B, BF, I + 24, 4), ...bars(t, K, KF, I + 28, 4)], { style: { kickClick: 1.2, drive: 0.45 } });
  const esk = { kick: 'xxxxxxxxxxxxxxxx', china: 'x.......x.......' };
  t.kit('escalation', [...bars(t, esk, { ...esk, snare: 'x.x.x.x.x.x.x.x.' }, I, 16), ...bars(t, esk, { ...esk, snare: 'x.x.x.x.x.x.x.x.' }, I + 20, 12)], { style: { kickClick: 1.3, drive: 0.5 }, gainDb: -4 });
  t.add('electro', machinePulse(t.at(I + 8) - t.at(I), { seed: 71, rate: t.bpm / 60 * 2, freq: 3100, q: 11, level: 0.4, duty: 0.08 }), -9, 0.4, t.at(I));
  const snarl = synthOf(t, seq(...Array(8).fill('F1:2 F1:1 Gb1:1 -:2 F1:2 -:2 Ab1:2 Gb1:2 F1:2')), I + 8, 0.9);
  t.snarl('electro', snarl, { gainDb: -4, resonance: 0.65, drive: 3, bits: 8, downsample: 3 });
  t.add('electro', glitchSeq(t.at(I + 20) - t.at(I + 16), { seed: 72, stepSamples: Math.round(t.stepSamples), density: 0.55, baseHz: 349 }), -8, -0.3, t.at(I + 16));
  t.add('electro', riser(60 / t.bpm * 4, { seed: 73, freqFrom: 87, freqTo: 350, noise: 0.9 }), -9, 0, t.at(I + 27));
  t.add('electro', riser(60 / t.bpm * 8, { seed: 74, freqFrom: 87, freqTo: 350, noise: 0.9 }), -8, 0, 0);
  t.add('electro', drone(t.at(I), { seed: 75, freq: noteHz('F1'), cutoff: 320, wobble: 0.6, level: 0.5 }), -8);
  return t;
}

// ---- Frost -------------------------------------------------------------------------------------------------------------
export function frostExplore(): Track {
  const t = new Track({ id: 'frost-explore', title: 'Observatory Glass', bpm: 92, introBars: 2, loopBars: 32, tailBars: 2, seed: 5301, targetLufs: -17 });
  t.stem('atmo', STEMS.atmo(0)); t.stem('drums', STEMS.drums(-7)); t.stem('bass', STEMS.bass(-9)); t.stem('guitars', STEMS.guitars(-5)); t.stem('lead', STEMS.lead(-4));
  const I = 2;
  const PICK = 'C#2m:1 -:1 G#2m:1 -:1 C#2m:1 -:1 E2m:1 -:1 C#2m:1 -:1 D#2m:1 -:1 C#2m:1 -:1 B1m:1 -:1';
  const PICK_B = 'C#2m:1 -:1 G#2m:1 -:1 C#2m:1 -:1 E2m:1 -:1 A2m:1 -:1 G#2m:1 -:1 E2m:1 -:1 D#2m:1 -:1';
  const CHORD = '>C#2P:8 >A1P:8 | >E2P:8 >G#1P:6 C#2x:1 C#2x:1';
  t.guitar('guitars', [...t.riff(seq(PICK, PICK, PICK, PICK_B, PICK, PICK, PICK, PICK_B), { bar: I, vel: 0.7 }), ...t.riff(seq(CHORD, CHORD, CHORD, CHORD), { bar: I + 16, vel: 0.8 }), ...t.riff(seq(PICK, PICK_B, PICK, PICK_B, PICK, PICK, PICK, PICK_B), { bar: I + 24, vel: 0.75 })], { amp: AMPS.crunch });
  t.bass('bass', t.riff(seq('C#2o:8 -:8 | C#2o:4 -:4 B1o:4 -:4', 'C#2o:8 -:8 | C#2o:4 -:4 B1o:4 -:4', 'C#2o:8 -:8 | C#2o:4 -:4 B1o:4 -:4', 'C#2o:8 -:8 | C#2o:4 -:4 B1o:4 -:4', 'C#2o:8 A1o:8 | E2o:8 G#1o:8', 'C#2o:8 A1o:8 | E2o:8 G#1o:8', 'C#2o:8 A1o:8 | E2o:8 G#1o:8', 'C#2o:8 A1o:8 | E2o:8 G#1o:8', 'C#2o:8 -:8 | C#2o:4 -:4 B1o:4 -:4', 'C#2o:8 -:8 | C#2o:4 -:4 B1o:4 -:4', 'C#2o:8 -:8 | C#2o:4 -:4 B1o:4 -:4', 'C#2o:8 -:8 | C#2o:4 -:4 B1o:4 -:4'), { bar: I, vel: 0.8 }), { drive: 2.2, sub: 0.5 });
  const A = { kick: 'x.......x.......', rim: '....x.......x...', hat: 'x...x...x...x...', click: '..x...x...x...x.' };
  const AF = { kick: 'x.......x.....x.', rim: '....x.......x.x.', hat: 'x...x...x...x...', click: '..x...x...x...x.' };
  const B = { kick: 'x...x...x.x.....', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.', crash: 'x...............' };
  const BF = { kick: 'x...x...x.x.x.x.', snare: '....X.......X.xx', hat: 'x.x.x.x.x.x.....', tomHi: '............x...' };
  t.kit('drums', [...bars(t, A, AF, I, 8), ...bars(t, A, AF, I + 8, 8), ...bars(t, B, BF, I + 16, 8), ...bars(t, A, AF, I + 24, 8)], { style: { kickClick: 0.8, drive: 0.2, snareTune: 1.1 } });
  // FM bells carry the motif in C# minor with cold precision; a glassy pad; fractured glitch flecks.
  t.add('lead', renderBell(bellsOf(t, seq(motif('C#4'), motif('C#4', 'answer')), I + 4, 0.75, 2), t.length, { seed: 81, ratio: 3.5, index: 2.4, decay: 1.6 }), -6, -0.15);
  t.add('lead', renderBell(bellsOf(t, seq(motif('C#4'), motif('C#4', 'answer')), I + 20, 0.8, 2), t.length, { seed: 82, ratio: 2.0, index: 1.8, decay: 1.8 }), -6, 0.15);
  t.add('lead', renderBell(bellsOf(t, seq(motif('C#4', 'high'), motif('C#4', 'answer').replace(/(\d)o/g, (_, d) => `${Number(d) + 1}o`)), I + 28, 0.7, 1), t.length, { seed: 83, ratio: 3.5, index: 2.0, decay: 1.2 }), -8, 0);
  const pad = ['C#3', 'A2', 'E3', 'G#2'].flatMap((n, i) => [0, 1].map(k => ({ at: t.at(I + 16 + i * 2 + k * 8), gate: t.barSamples * 2, freq: noteHz(n), vel: 0.6 })));
  t.add('atmo', renderPad(pad, t.length, { seed: 84, attack: 1.2, release: 2, cutoff: 2600 }), -10);
  t.add('atmo', drone(t.length, { seed: 85, freq: noteHz('C#1'), cutoff: 160, wobble: 0.3, level: 0.4 }), -12);
  t.add('atmo', glitchSeq(t.length, { seed: 86, stepSamples: Math.round(t.stepSamples * 2), density: 0.12, baseHz: 1109 }), -16, 0.4);
  t.add('atmo', machinePulse(t.length, { seed: 87, rate: t.bpm / 60 / 2, freq: 4200, q: 14, level: 0.25, duty: 0.05 }), -16, -0.4);
  return t;
}
export function frostCombat(): Track {
  const t = new Track({ id: 'frost-combat', title: 'Calving Line', bpm: 170, introBars: 2, loopBars: 32, tailBars: 2, seed: 5302, targetLufs: -12.5 });
  t.stem('drums', STEMS.drums(-2)); t.stem('bass', STEMS.bass(-5)); t.stem('guitars', STEMS.guitars(2)); t.stem('lead', STEMS.lead(-2)); t.stem('electro', STEMS.electro(1)); t.stem('escalation', STEMS.escalation(-7));
  const I = 2;
  const PICK = 'C#2m:1 C#2m:1 G#2m:1 C#2m:1 C#2m:1 E2m:1 C#2m:1 C#2m:1 D#2m:1 C#2m:1 C#2m:1 B1m:1 C#2m:1 C#2m:1 >A2P:2';
  const PICK_B = 'C#2m:1 C#2m:1 G#2m:1 C#2m:1 C#2m:1 E2m:1 C#2m:1 C#2m:1 >F#2P:2 >E2P:2 >D#2P:2 >B1M:2';
  const OPEN = '>C#2P:4 >E2P:2 >F#2P:2 >C#2P:4 >B1M:2 >A1M:2';
  const OPEN_B = '>C#2P:4 >E2P:2 >F#2P:2 >G#2P:2 >F#2P:2 >E2P:2 >D#2P:2';
  const BREAK = '>C#2M:3 -:1 >C#2M:3 -:1 >A1M:2 -:2 C#2x:1 -:1 >E2P:2';
  const BREAK_B = '>C#2M:3 -:1 >C#2M:3 -:1 >G#1M:2 >A1M:2 >B1M:2 >C#2M:2';
  t.guitar('guitars', [
    ...t.riff(seq(PICK, PICK, PICK, PICK_B, PICK, PICK, PICK, PICK_B), { bar: I, vel: 0.92 }),
    ...t.riff(seq(OPEN, OPEN_B, OPEN, OPEN_B, OPEN, OPEN_B, OPEN, 'C#2P:4 B1M:4 A1M:4 G#1M:2 C#2x:1 C#2x:1'), { bar: I + 8, vel: 1 }),
    ...t.riff(seq(BREAK, BREAK, BREAK, BREAK_B), { bar: I + 16, vel: 1 }),
    ...t.riff(seq(PICK, PICK_B, PICK, PICK_B, PICK, PICK, PICK, 'C#2m:1 C#2m:1 >E2P:2 >F#2P:2 >G#2P:2 >A2P:2 >G#2P:2 >F#2P:2 >E2P:2'), { bar: I + 20 }),
    ...t.riff(seq(OPEN, OPEN_B, OPEN, 'C#2W:4 E2W:4 F#2W:4 G#2W:2 C#2x:1 C#2x:1'), { bar: I + 28, vel: 1 }),
  ], { amp: AMPS.rhythm });
  t.guitar('escalation', t.riff(seq(...Array(32).fill(PICK)), { bar: I, vel: 0.85, transpose: 12 }), { amp: AMPS.lead, lead: true, gainDb: -6 });
  t.bass('bass', [
    ...t.riff(bassLine(seq(PICK, PICK, PICK, PICK_B, PICK, PICK, PICK, PICK_B)), { bar: I, vel: 0.95 }),
    ...t.riff('C#2o:4 E2o:2 F#2o:2 C#2o:4 B1o:2 A1o:2 | C#2o:4 E2o:2 F#2o:2 G#2o:2 F#2o:2 E2o:2 D#2o:2 | C#2o:4 E2o:2 F#2o:2 C#2o:4 B1o:2 A1o:2 | C#2o:4 E2o:2 F#2o:2 G#2o:2 F#2o:2 E2o:2 D#2o:2 | C#2m:2 C#2m:2 E2o:2 F#2o:2 C#2m:2 C#2m:2 B1o:2 A1o:2 | C#2m:2 C#2m:2 E2o:2 F#2o:2 G#2o:2 F#2o:2 E2o:2 D#2o:2 | C#2o:4 E2o:2 F#2o:2 C#2o:4 B1o:2 A1o:2 | C#2o:4 B1o:4 A1o:4 G#1o:2 C#2x:1 C#2x:1', { bar: I + 8, vel: 1 }),
    ...t.riff(bassLine(seq(BREAK, BREAK, BREAK, BREAK_B, PICK, PICK_B, PICK, PICK_B, PICK, PICK, PICK, 'C#2m:1 C#2m:1 E2m:2 F#2m:2 G#2m:2 A2m:2 G#2m:2 F#2m:2 E2m:2')), { bar: I + 16, vel: 0.95 }),
    ...t.riff('C#2o:4 E2o:2 F#2o:2 C#2o:4 B1o:2 A1o:2 | C#2o:4 E2o:2 F#2o:2 G#2o:2 F#2o:2 E2o:2 D#2o:2 | C#2o:4 E2o:2 F#2o:2 C#2o:4 B1o:2 A1o:2 | C#2o:4 E2o:4 F#2o:4 G#2o:2 C#2x:1 C#2x:1', { bar: I + 28, vel: 1 }),
  ], { drive: 3.4, sub: 0.35 });
  t.add('lead', renderBell(bellsOf(t, seq(motif('C#4'), motif('C#4', 'answer')), I + 8, 0.9, 2), t.length, { seed: 91, ratio: 3.5, index: 2.6, decay: 0.9 }), -5, -0.2);
  t.guitar('lead', [...t.riff(seq(motif('C#4'), motif('C#4', 'answer')), { bar: I + 12, vel: 0.95 }), ...t.riff(seq(motif('C#4', 'fast'), motif('C#4', 'fast'), motif('C#4', 'high'), motif('C#4', 'answer').replace(/(\d)o/g, (_, d) => `${Number(d) + 1}o`)), { bar: I + 24, vel: 0.95 })], { amp: AMPS.lead, lead: true });
  const A = { kick: 'x.x.x.x.x.x.x.x.', snare: '....X.......X...', hat: 'xxxxxxxxxxxxxxxx', crash: 'x...............' };
  const AF = { kick: 'x.x.x.x.xxxxxxxx', snare: '....X.......X.XX', hat: 'xxxxxxxxxxxx....', tomHi: '............x...', tomLo: '.............x..', crash: '...............x' };
  const B = { kick: 'x...x...x.x.x...', snare: '....X.......X...', ride: 'x.x.x.x.x.x.x.x.', crash: 'x...............' };
  const BF = { kick: 'x...x...x.x.xxxx', snare: '....X.....X.X.XX', ride: 'x.x.x.x.x.x.....', china: '............x...' };
  const C = { slam: 'x...........x...', kick: 'x...x...x...x...', snare: '........X.......', hatOpen: 'x...x...x...x...', china: 'x...............' };
  const CF = { slam: 'x...........x...', kick: 'x...x...x...xxxx', snare: '........X...X.X.', hatOpen: 'x...x...x.......', crash: '............x...' };
  const K = { kick: 'x.x.x.x.x.x.x.x.', snare: '....X.......X...', crash: 'x...............', ride: 'x.x.x.x.x.x.x.x.' };
  const KF = { kick: 'x.x.x.x.xx.xx.xx', snare: '....X...X...X.XX', crash: 'x.......x.......', china: '..............x.' };
  t.kit('drums', [...t.drums({ kick: '........x.x.x.x.', snare: '........X...X...', tomLo: '............x.x.', crash: '...............x' }, { bar: I - 1 }), ...bars(t, A, AF, I, 4), ...bars(t, A, AF, I + 4, 4), ...bars(t, B, BF, I + 8, 4), ...bars(t, B, BF, I + 12, 4), ...bars(t, C, CF, I + 16, 4), ...bars(t, A, AF, I + 20, 4), ...bars(t, A, AF, I + 24, 4), ...bars(t, K, KF, I + 28, 4)], { style: { kickClick: 1.3, drive: 0.4, snareTune: 1.08 } });
  const esk = { kick: 'xxxxxxxxxxxxxxxx', china: 'x.......x.......' };
  t.kit('escalation', [...bars(t, esk, { ...esk, snare: 'x.x.x.x.x.x.x.x.' }, I, 16), ...bars(t, esk, { ...esk, snare: 'x.x.x.x.x.x.x.x.' }, I + 20, 12)], { style: { kickClick: 1.3, drive: 0.5 }, gainDb: -4 });
  const arp = Array.from({ length: 16 * 16 }, (_, i) => ({ at: t.at(I + 8) + Math.round(i * t.stepSamples), gate: Math.round(t.stepSamples * 0.5), freq: noteHz(['C#5', 'E5', 'G#5', 'B5', 'C#6', 'B5', 'G#5', 'E5'][i % 8]), vel: 0.6 + 0.4 * (i % 4 === 0 ? 1 : 0) }));
  t.add('electro', renderPluck(arp, t.length, { seed: 92, cutoff: 6000, crush: 9, width: 0.2, decay: 0.15 }), -13, 0.3);
  t.add('electro', glitchSeq(t.at(I + 20) - t.at(I + 16), { seed: 93, stepSamples: Math.round(t.stepSamples), density: 0.6, baseHz: 554 }), -8, -0.3, t.at(I + 16));
  t.add('electro', machinePulse(t.at(I + 8) - t.at(I), { seed: 94, rate: t.bpm / 60 * 2, freq: 5200, q: 12, level: 0.3, duty: 0.05 }), -12, 0.4, t.at(I));
  t.add('electro', riser(60 / t.bpm * 8, { seed: 95, freqFrom: 69, freqTo: 277, noise: 0.5 }), -8, 0, 0);
  t.add('electro', riser(60 / t.bpm * 4, { seed: 96, freqFrom: 69, freqTo: 277, noise: 0.6 }), -9, 0, t.at(I + 27));
  return t;
}

// ---- Forge -------------------------------------------------------------------------------------------------------------
export function forgeExplore(): Track {
  const t = new Track({ id: 'forge-explore', title: 'Slag Tide', bpm: 84, introBars: 2, loopBars: 32, tailBars: 2, seed: 5401, targetLufs: -16 });
  t.stem('atmo', STEMS.atmo(0)); t.stem('drums', STEMS.drums(-5)); t.stem('bass', STEMS.bass(-7)); t.stem('guitars', STEMS.guitars(-3)); t.stem('lead', STEMS.lead(-5));
  const I = 2;
  const CHUG = '>A1M:3 -:1 A1m:1 A1m:1 -:2 >A1M:2 -:2 >C2P:2 >B1M:2';
  const CHUG_B = '>A1M:3 -:1 A1m:1 A1m:1 -:2 >G1M:2 -:2 >F2P:2 >E2P:2';
  const HEAVY = '>A1W:8 >F2W:8 | >G2W:8 >E2W:6 A1x:1 A1x:1';
  t.guitar('guitars', [...t.riff(seq(CHUG, CHUG, CHUG, CHUG_B, CHUG, CHUG, CHUG, CHUG_B), { bar: I, vel: 0.85 }), ...t.riff(seq(HEAVY, HEAVY, HEAVY, HEAVY), { bar: I + 16, vel: 0.9 }), ...t.riff(seq(CHUG, CHUG_B, CHUG, CHUG_B, CHUG, CHUG, CHUG, CHUG_B), { bar: I + 24, vel: 0.85 })], { amp: AMPS.rhythm });
  t.bass('bass', t.riff(seq(bassLine(seq(CHUG, CHUG, CHUG, CHUG_B, CHUG, CHUG, CHUG, CHUG_B)), 'A1o:8 F2o:8 | G2o:8 E2o:6 A1x:1 A1x:1 | A1o:8 F2o:8 | G2o:8 E2o:6 A1x:1 A1x:1 | A1o:8 F2o:8 | G2o:8 E2o:6 A1x:1 A1x:1 | A1o:8 F2o:8 | G2o:8 E2o:6 A1x:1 A1x:1', bassLine(seq(CHUG, CHUG_B, CHUG, CHUG_B, CHUG, CHUG, CHUG, CHUG_B))), { bar: I, vel: 0.9 }), { drive: 4, sub: 0.45 });
  const A = { kick: 'x.......x.x.....', snare: '....X.......X...', hatOpen: 'x.......x.......', pipe: '......x.........' };
  const AF = { kick: 'x.......x.x...x.', snare: '....X.......X.X.', hatOpen: 'x.......x.......', slam: '............x...' };
  const B = { slam: 'x...............', kick: 'x...x...x.x.....', snare: '....X.......X...', crash: 'x...............', ride: 'x.x.x.x.x.x.x.x.', steam: '..........x.....' };
  const BF = { slam: 'x...............', kick: 'x...x...x.x.xxxx', snare: '....X.......X.X.', ride: 'x.x.x.x.x.x.....', china: '............x...' };
  t.kit('drums', [...bars(t, A, AF, I, 8), ...bars(t, A, AF, I + 8, 8), ...bars(t, B, BF, I + 16, 8), ...bars(t, A, AF, I + 24, 8)], { style: { kickTune: 0.95, kickClick: 1, drive: 0.5 } });
  t.guitar('lead', [...t.riff(seq(motif('A3'), motif('A3', 'answer')), { bar: I + 6, vel: 0.8 }), ...t.riff(seq(motif('A3'), motif('A3', 'answer')), { bar: I + 22, vel: 0.85 })], { amp: AMPS.lead, lead: true, gainDb: -4 });
  t.add('atmo', drone(t.length, { seed: 101, freq: noteHz('A0'), cutoff: 140, wobble: 0.8, level: 0.6 }), -8);
  t.add('atmo', machinePulse(t.length, { seed: 102, rate: t.bpm / 60 / 4, freq: 160, q: 4, level: 0.6, duty: 0.5 }), -10, -0.3);
  t.add('atmo', machinePulse(t.length, { seed: 103, rate: t.bpm / 60, freq: 1200, q: 8, level: 0.3, duty: 0.1 }), -16, 0.4);
  t.add('atmo', riser(60 / t.bpm * 4, { seed: 104, freqFrom: 55, freqTo: 220, noise: 0.95 }), -11, 0, t.at(I + 15));
  return t;
}
export function forgeCombat(): Track {
  const t = new Track({ id: 'forge-combat', title: 'Furnace Hammer', bpm: 136, introBars: 2, loopBars: 32, tailBars: 2, seed: 5402, targetLufs: -12.5 });
  t.stem('drums', STEMS.drums(-2)); t.stem('bass', STEMS.bass(-5)); t.stem('guitars', STEMS.guitars(2)); t.stem('lead', STEMS.lead(-2)); t.stem('electro', STEMS.electro(0)); t.stem('escalation', STEMS.escalation(-7));
  const I = 2;
  const SLAM = '>A1M:2 A1m:1 A1m:1 >A1M:2 A1m:1 A1m:1 >C2P:2 A1m:1 A1m:1 >G1M:2 A1m:1 A1m:1';
  const SLAM_B = '>A1M:2 A1m:1 A1m:1 >A1M:2 A1m:1 A1m:1 >F2P:2 >E2P:2 >D2P:2 >C2P:2';
  const HAMMER = '>A1M:4 -:2 >A1M:2 >C2P:4 >B1M:2 >A1M:2';
  const HAMMER_B = '>A1M:4 -:2 >A1M:2 >G1M:2 >A1M:2 >C2P:2 >D2P:2';
  const GALLOP = 'A1m:2 A1m:1 A1m:1 A1m:2 A1m:1 A1m:1 >C2P:2 A1m:1 A1m:1 >D2P:2 >C2P:2';
  const HOOK = '>A1W:8 >F2W:8 | >G2W:8 >E2W:4 >A1W:4';
  t.guitar('guitars', [
    ...t.riff(seq(SLAM, SLAM, SLAM, SLAM_B, SLAM, SLAM, SLAM, SLAM_B), { bar: I, vel: 0.95 }),
    ...t.riff(seq(HAMMER, HAMMER_B, HAMMER, HAMMER_B, HAMMER, HAMMER_B, HAMMER, 'A1M:4 G1M:4 F2P:4 E2P:2 A1x:1 A1x:1'), { bar: I + 8, vel: 1 }),
    ...t.riff(seq('>A1M:3 -:1 >A1M:3 -:1 >A1M:2 -:2 A1x:1 -:1 >C2P:2', '>A1M:3 -:1 >A1M:3 -:1 >A1M:2 -:2 A1x:1 -:1 >C2P:2', '>A1M:3 -:1 >A1M:3 -:1 >A1M:2 -:2 A1x:1 -:1 >C2P:2', '>A1M:3 -:1 >A1M:3 -:1 >G1M:2 >A1M:2 >C2P:2 >D2P:2'), { bar: I + 16, vel: 1 }),
    ...t.riff(seq(GALLOP, GALLOP, GALLOP, SLAM_B, GALLOP, GALLOP, GALLOP, 'A1m:2 A1m:1 A1m:1 >C2P:2 >D2P:2 >E2P:2 >F2P:2 >E2P:2 >D2P:2'), { bar: I + 20, vel: 0.95 }),
    ...t.riff(seq(HOOK, HOOK.replace('>A1W:4', '>A1W:2 A1x:1 A1x:1')), { bar: I + 28, vel: 1 }),
  ], { amp: AMPS.rhythm });
  t.guitar('escalation', t.riff(seq(...Array(32).fill(GALLOP.replace(/P/g, 'o').replace(/m/g, 'm'))), { bar: I, vel: 0.85, transpose: 12 }), { amp: AMPS.lead, lead: true, gainDb: -6 });
  t.bass('bass', [
    ...t.riff(bassLine(seq(SLAM, SLAM, SLAM, SLAM_B, SLAM, SLAM, SLAM, SLAM_B, HAMMER, HAMMER_B, HAMMER, HAMMER_B, HAMMER, HAMMER_B, HAMMER, 'A1m:4 G1m:4 F2m:4 E2m:2 A1x:1 A1x:1')), { bar: I, vel: 1 }),
    ...t.riff(bassLine(seq('>A1M:3 -:1 >A1M:3 -:1 >A1M:2 -:2 A1x:1 -:1 >C2P:2', '>A1M:3 -:1 >A1M:3 -:1 >A1M:2 -:2 A1x:1 -:1 >C2P:2', '>A1M:3 -:1 >A1M:3 -:1 >A1M:2 -:2 A1x:1 -:1 >C2P:2', '>A1M:3 -:1 >A1M:3 -:1 >G1M:2 >A1M:2 >C2P:2 >D2P:2', GALLOP, GALLOP, GALLOP, SLAM_B, GALLOP, GALLOP, GALLOP, 'A1m:2 A1m:1 A1m:1 C2m:2 D2m:2 E2m:2 F2m:2 E2m:2 D2m:2')), { bar: I + 16, vel: 1 }),
    ...t.riff('A1o:8 F2o:8 | G2o:8 E2o:4 A1o:4 | A1o:8 F2o:8 | G2o:8 E2o:4 A1o:2 A1x:1 A1x:1', { bar: I + 28, vel: 1 }),
  ], { drive: 4.2, sub: 0.4 });
  t.guitar('lead', [...t.riff(seq(motif('A3'), motif('A3', 'answer'), motif('A3'), motif('A3', 'answer')), { bar: I + 8, vel: 0.95 }), ...t.riff(seq(motif('A3', 'high'), motif('A3', 'answer').replace(/(\d)o/g, (_, d) => `${Number(d) + 1}o`)), { bar: I + 28, vel: 1 })], { amp: AMPS.lead, lead: true });
  const A = { kick: 'x..x..x.x..x..x.', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.', slam: 'x...............' };
  const AF = { kick: 'x..x..x.x..xxxxx', snare: '....X.......X.X.', hat: 'x.x.x.x.x.x.....', pipe: '..........x.....', china: '..............x.' };
  const B = { slam: 'x.......x.......', kick: 'x...x...x...x...', snare: '....X.......X...', hatOpen: 'x...x...x...x...', steam: '......x.........' };
  const BF = { slam: 'x.......x.......', kick: 'x...x...x...xxxx', snare: '....X...X...X.X.', hatOpen: 'x...x...x.......', crash: '............x...' };
  const C = { slam: 'x...........x...', kick: 'x...x...x...x...', snare: '........X.......', hatOpen: 'x...x...x...x...', pipe: 'x.......x.......' };
  const CF = { slam: 'x...........x...', kick: 'x...x...x...xxxx', snare: '........X...X.X.', hatOpen: 'x...x...x.......', crash: '............x...' };
  const D = { kick: 'x.xxx.xxx.xxx.xx', snare: '....X.......X...', ride: 'x.x.x.x.x.x.x.x.', crash: 'x...............' };
  const DF = { kick: 'x.xxx.xxxxxxxxxx', snare: '....X.....X.X.XX', ride: 'x.x.x.x.x.x.....', china: '..............x.' };
  const K = { kick: 'x...x.x.x...x.x.', snare: '....X.......X...', crash: 'x...............', ride: 'x.x.x.x.x.x.x.x.', slam: 'x.......x.......' };
  const KF = { kick: 'x..xx..xx..xx.xx', snare: '....X...X...X.XX', crash: 'x.......x.......', china: '..............x.' };
  t.kit('drums', [...t.drums({ slam: '........x...x...', kick: '........x.x.x.x.', snare: '........X...X...', crash: '...............x' }, { bar: I - 1 }), ...bars(t, A, AF, I, 4), ...bars(t, A, AF, I + 4, 4), ...bars(t, B, BF, I + 8, 4), ...bars(t, B, BF, I + 12, 4), ...bars(t, C, CF, I + 16, 4), ...bars(t, D, DF, I + 20, 4), ...bars(t, D, DF, I + 24, 4), ...bars(t, K, KF, I + 28, 4)], { style: { kickTune: 0.95, kickClick: 1.3, drive: 0.55 } });
  const esk = { kick: 'xxxxxxxxxxxxxxxx', china: 'x.......x.......' };
  t.kit('escalation', [...bars(t, esk, { ...esk, snare: 'x.x.x.x.x.x.x.x.' }, I, 16), ...bars(t, esk, { ...esk, snare: 'x.x.x.x.x.x.x.x.' }, I + 20, 12)], { style: { kickClick: 1.3, drive: 0.5 }, gainDb: -4 });
  t.add('electro', drone(t.at(I + 32) - t.at(I), { seed: 111, freq: noteHz('A0'), cutoff: 200, wobble: 0.9, level: 0.6 }), -10, 0, t.at(I));
  const snarl = synthOf(t, seq(...Array(8).fill('A0:2 -:2 A0:1 A0:1 -:2 C1:2 -:2 G0:2 A0:2')), I + 8, 0.9);
  t.snarl('electro', snarl, { gainDb: -5, resonance: 0.5, drive: 3.2, bits: 8, downsample: 3 });
  t.add('electro', machinePulse(t.at(I + 8) - t.at(I), { seed: 112, rate: t.bpm / 60 / 2, freq: 180, q: 4, level: 0.6, duty: 0.4 }), -9, -0.3, t.at(I));
  t.add('electro', riser(60 / t.bpm * 8, { seed: 113, freqFrom: 55, freqTo: 220, noise: 0.9 }), -8, 0, 0);
  t.add('electro', riser(60 / t.bpm * 4, { seed: 114, freqFrom: 55, freqTo: 220, noise: 0.9 }), -9, 0, t.at(I + 27));
  t.add('drums', impact({ seed: 115, seconds: 2.4, subHz: 34, ring: 140 }), -5, 0, t.at(I));
  return t;
}

// ---- Halo --------------------------------------------------------------------------------------------------------------
export function haloExplore(): Track {
  const t = new Track({ id: 'halo-explore', title: 'Driftstone Static', bpm: 128, introBars: 2, loopBars: 32, tailBars: 2, seed: 5501, targetLufs: -16 });
  t.stem('atmo', STEMS.atmo(0)); t.stem('drums', STEMS.drums(-6)); t.stem('bass', STEMS.bass(-8)); t.stem('guitars', STEMS.guitars(-5)); t.stem('lead', STEMS.lead(-4));
  const I = 2;
  // Broken-beat electronics: arps on a D minor / tritone set, guitars only as sparse clean stabs.
  const arpA = ['D4', 'F4', 'Ab4', 'A4', 'D5', 'A4', 'Ab4', 'F4'], arpB = ['D4', 'E4', 'Gb4', 'Ab4', 'Bb4', 'Ab4', 'Gb4', 'E4'];
  const arp = Array.from({ length: 32 * 16 }, (_, i) => { const bar = Math.floor(i / 16); const set = bar % 8 >= 4 ? arpB : arpA; const on = [0, 3, 6, 8, 11, 14].includes(i % 16) || (bar % 4 === 3 && i % 2 === 0); return on ? { at: t.at(I) + Math.round(i * t.stepSamples), gate: Math.round(t.stepSamples * 0.7), freq: noteHz(set[(i * 5) % 8]), vel: 0.55 + 0.35 * (i % 8 === 0 ? 1 : 0) } : null; }).filter((e): e is NonNullable<typeof e> => !!e);
  t.add('lead', renderPluck(arp, t.length, { seed: 121, cutoff: 4600, crush: 8, width: 0.25, decay: 0.25 }), -9, 0.25);
  t.add('lead', renderBell(bellsOf(t, seq(motif('D4'), motif('D4', 'answer')), I + 16, 0.7, 2), t.length, { seed: 122, ratio: 2.0, index: 1.6, decay: 1.4 }), -8, -0.2);
  const STAB = '>D2P:2 -:6 >Ab2P:2 -:6 | >D2P:2 -:6 >C2P:2 -:2 >Bb1M:2 -:2';
  t.guitar('guitars', [...t.riff(seq(STAB, STAB, STAB, STAB), { bar: I + 8, vel: 0.75 }), ...t.riff(seq(STAB, STAB, STAB, STAB), { bar: I + 24, vel: 0.8 })], { amp: AMPS.crunch });
  t.bass('bass', t.riff(seq(...Array(8).fill('D2m:2 -:1 D2m:1 -:2 Ab2m:2 -:2 D2m:1 -:1 C2m:2 -:2'), ...Array(8).fill('D2m:2 -:1 D2m:1 -:2 Gb2m:2 -:2 D2m:1 -:1 E2m:2 -:2'), ...Array(8).fill('D2m:2 -:1 D2m:1 -:2 Ab2m:2 -:2 D2m:1 -:1 C2m:2 -:2'), ...Array(8).fill('D2m:2 -:1 D2m:1 -:2 Gb2m:2 -:2 D2m:1 -:1 E2m:2 -:2')), { bar: I, vel: 0.8 }), { drive: 2.6, sub: 0.55 });
  const A = { kick: 'x..x....x.x.....', snare: '....X.......X...', hat: 'x.x.x.xx..x.x.x.', click: '..x..x..x..x..x.' };
  const AF = { kick: 'x..x....x.x...x.', snare: '....X.......X.X.', hat: 'x.x.x.xx..x.....', clap: '............x.x.' };
  const B = { kick: 'x..x..x...x..x..', snare: '....X.......X...', hat: 'xxxxxxxxxxxxxxxx', clap: '....x.......x...' };
  const BF = { kick: 'x..x..x...x.xxxx', snare: '....X.......X.XX', hat: 'xxxxxxxxxxxx....', crash: '...............x' };
  t.kit('drums', [...bars(t, A, AF, I, 8), ...bars(t, B, BF, I + 8, 8), ...bars(t, A, AF, I + 16, 8), ...bars(t, B, BF, I + 24, 8)], { style: { kickClick: 1.1, drive: 0.3, hatTune: 1.15 } });
  t.add('atmo', renderPad([['D3', 0], ['Ab2', 4], ['D3', 8], ['Gb2', 12], ['D3', 16], ['Ab2', 20], ['D3', 24], ['E2', 28]].map(([n, b]) => ({ at: t.at(I + (b as number)), gate: t.barSamples * 4, freq: noteHz(n as string), vel: 0.6 })), t.length, { seed: 123, attack: 1.5, release: 2.5, cutoff: 2000 }), -9);
  t.add('atmo', glitchSeq(t.length, { seed: 124, stepSamples: Math.round(t.stepSamples), density: 0.18, baseHz: 294 }), -13, 0.4);
  t.add('atmo', machinePulse(t.length, { seed: 125, rate: t.bpm / 60 * 1.5, freq: 3800, q: 12, level: 0.3, duty: 0.05 }), -15, -0.4);
  t.add('atmo', drone(t.length, { seed: 126, freq: noteHz('D1'), cutoff: 220, wobble: 0.9, level: 0.4 }), -12);
  return t;
}
export function haloCombat(): Track {
  const t = new Track({ id: 'halo-combat', title: 'Orbital Mechanics', bpm: 174, introBars: 2, loopBars: 32, tailBars: 2, seed: 5502, targetLufs: -12.5 });
  t.stem('drums', STEMS.drums(-2)); t.stem('bass', STEMS.bass(-5)); t.stem('guitars', STEMS.guitars(2)); t.stem('lead', STEMS.lead(-2)); t.stem('electro', STEMS.electro(2)); t.stem('escalation', STEMS.escalation(-7));
  const I = 2;
  // 3+3+2 accents: D D D | Ab Ab Ab | C C with 16th-note pulses.
  const PULSE = '>D2M:1 D2m:1 D2m:1 >Ab2P:1 D2m:1 D2m:1 >C2P:1 D2m:1 >D2M:1 D2m:1 D2m:1 >Gb2P:1 D2m:1 D2m:1 >E2P:1 D2m:1';
  const PULSE_B = '>D2M:1 D2m:1 D2m:1 >Ab2P:1 D2m:1 D2m:1 >C2P:1 D2m:1 >Bb1M:2 >C2P:2 >Db2P:2 >D2M:2';
  const PLANE = '>D2P:4 >E2P:4 >Gb2P:4 >Ab2P:4';
  const PLANE_B = '>D2P:4 >C2P:4 >Bb1M:4 >Ab1M:2 D2x:1 D2x:1';
  const BREAK = '>D2M:3 -:1 >D2M:3 -:1 >Ab2P:2 -:2 D2x:1 -:1 >C2P:2';
  const BREAK_B = '>D2M:3 -:1 >D2M:3 -:1 >Gb2P:2 >E2P:2 >D2M:2 >C2P:2';
  t.guitar('guitars', [
    ...t.riff(seq(PULSE, PULSE, PULSE, PULSE_B, PULSE, PULSE, PULSE, PULSE_B), { bar: I }),
    ...t.riff(seq(PLANE, PLANE_B, PLANE, PLANE_B, PLANE, PLANE_B, PLANE, 'D2P:4 Ab2P:4 Gb2P:4 E2P:2 D2x:1 D2x:1'), { bar: I + 8, vel: 1 }),
    ...t.riff(seq(BREAK, BREAK, BREAK, BREAK_B), { bar: I + 16, vel: 1 }),
    ...t.riff(seq(PULSE, PULSE_B, PULSE, PULSE_B, PULSE, PULSE, PULSE, 'D2m:1 D2m:1 >E2P:2 >Gb2P:2 >Ab2P:2 >Bb2P:2 >Ab2P:2 >Gb2P:2 >E2P:2'), { bar: I + 20 }),
    ...t.riff(seq('>D2W:8 >Ab2W:8 | >C2W:8 >Gb2W:4 >D2W:4', '>D2W:8 >Ab2W:8 | >C2W:8 >Gb2W:4 >D2W:2 D2x:1 D2x:1'), { bar: I + 28, vel: 1 }),
  ], { amp: AMPS.rhythm });
  t.guitar('escalation', t.riff(seq(...Array(32).fill(PULSE)), { bar: I, vel: 0.85, transpose: 12 }), { amp: AMPS.lead, lead: true, gainDb: -6 });
  t.bass('bass', [
    ...t.riff(bassLine(seq(PULSE, PULSE, PULSE, PULSE_B, PULSE, PULSE, PULSE, PULSE_B)), { bar: I, vel: 0.95 }),
    ...t.riff('D2o:4 E2o:4 Gb2o:4 Ab2o:4 | D2o:4 C2o:4 Bb1o:4 Ab1o:2 D2x:1 D2x:1 | D2o:4 E2o:4 Gb2o:4 Ab2o:4 | D2o:4 C2o:4 Bb1o:4 Ab1o:2 D2x:1 D2x:1 | D2m:2 D2m:2 E2o:4 Gb2o:4 Ab2o:4 | D2m:2 D2m:2 C2o:4 Bb1o:4 Ab1o:2 D2x:1 D2x:1 | D2o:4 E2o:4 Gb2o:4 Ab2o:4 | D2o:4 Ab2o:4 Gb2o:4 E2o:2 D2x:1 D2x:1', { bar: I + 8, vel: 1 }),
    ...t.riff(bassLine(seq(BREAK, BREAK, BREAK, BREAK_B, PULSE, PULSE_B, PULSE, PULSE_B, PULSE, PULSE, PULSE, 'D2m:1 D2m:1 E2m:2 Gb2m:2 Ab2m:2 Bb2m:2 Ab2m:2 Gb2m:2 E2m:2')), { bar: I + 16, vel: 0.95 }),
    ...t.riff('D2o:8 Ab2o:8 | C2o:8 Gb2o:4 D2o:4 | D2o:8 Ab2o:8 | C2o:8 Gb2o:4 D2o:2 D2x:1 D2x:1', { bar: I + 28, vel: 1 }),
  ], { drive: 3.6, sub: 0.35 });
  const tritoneMotif = motif('D4').replace(/G#3o:2 Eb4o:2/g, 'G#3o:2 Eb4o:2');
  t.guitar('lead', [...t.riff(seq(tritoneMotif, motif('D4', 'answer'), motif('D4', 'fast'), motif('D4', 'high')), { bar: I + 8, vel: 0.95 }), ...t.riff(seq(motif('D4', 'high'), motif('D4', 'answer').replace(/(\d)o/g, (_, d) => `${Number(d) + 1}o`)), { bar: I + 28, vel: 1 })], { amp: AMPS.lead, lead: true });
  const A = { kick: 'x..x..x.x..x..x.', snare: '...X..X...X..X..', hat: 'x.x.x.x.x.x.x.x.', crash: 'x...............' };
  const AF = { kick: 'x..x..x.x..x.xxx', snare: '...X..X...X.X.XX', hat: 'x.x.x.x.x.x.....', china: '..............x.' };
  const B = { kick: 'x.x.x.x.x.x.x.x.', snare: '....X.......X...', ride: 'x.x.x.x.x.x.x.x.', crash: 'x...............', clap: '....x.......x...' };
  const BF = { kick: 'x.x.x.x.xxxxxxxx', snare: '....X...X.X.X.XX', ride: 'x.x.x.x.........', china: '............x...' };
  const C = { slam: 'x...........x...', kick: 'x...x...x...x...', snare: '........X.......', hatOpen: 'x...x...x...x...', china: 'x...............' };
  const CF = { slam: 'x...........x...', kick: 'x...x...x...xxxx', snare: '........X...X.X.', hatOpen: 'x...x...x.......', crash: '............x...' };
  const K = { kick: 'x.x.x.x.x.x.x.x.', snare: '....X.......X...', crash: 'x...............', ride: 'x.x.x.x.x.x.x.x.' };
  const KF = { kick: 'x.x.x.x.xx.xx.xx', snare: '....X...X...X.XX', crash: 'x.......x.......', china: '..............x.' };
  t.kit('drums', [...t.drums({ kick: '........x.x.x.x.', snare: '........X...X...', clap: '............x.x.', crash: '...............x' }, { bar: I - 1 }), ...bars(t, A, AF, I, 4), ...bars(t, A, AF, I + 4, 4), ...bars(t, B, BF, I + 8, 4), ...bars(t, B, BF, I + 12, 4), ...bars(t, C, CF, I + 16, 4), ...bars(t, A, AF, I + 20, 4), ...bars(t, B, BF, I + 24, 4), ...bars(t, K, KF, I + 28, 4)], { style: { kickClick: 1.3, drive: 0.4, hatTune: 1.15 } });
  const esk = { kick: 'xxxxxxxxxxxxxxxx', china: 'x.......x.......' };
  t.kit('escalation', [...bars(t, esk, { ...esk, snare: 'x.x.x.x.x.x.x.x.' }, I, 16), ...bars(t, esk, { ...esk, snare: 'x.x.x.x.x.x.x.x.' }, I + 20, 12)], { style: { kickClick: 1.3, drive: 0.5 }, gainDb: -4 });
  const arpSet = ['D5', 'F5', 'Ab5', 'A5', 'D6', 'A5', 'Ab5', 'F5'];
  const arp = Array.from({ length: 32 * 16 }, (_, i) => ({ at: t.at(I) + Math.round(i * t.stepSamples), gate: Math.round(t.stepSamples * 0.55), freq: noteHz(arpSet[(i * 3) % 8]) * (Math.floor(i / 16) % 8 >= 4 ? 0.9439 : 1), vel: 0.55 + 0.45 * ([0, 3, 6, 8, 11, 14].includes(i % 16) ? 1 : 0) }));
  t.add('electro', renderPluck(arp, t.length, { seed: 131, cutoff: 5600, crush: 8, width: 0.22, decay: 0.16 }), -11, 0.3);
  const snarl = synthOf(t, seq(...Array(8).fill('D1:1 D1:1 -:1 Ab1:1 D1:1 -:1 C1:1 D1:1 D1:1 -:1 Gb1:2 -:1 E1:1 D1:2')), I + 8, 0.9);
  t.snarl('electro', snarl, { gainDb: -5, resonance: 0.7, drive: 2.8, bits: 7, downsample: 2 });
  t.add('electro', glitchSeq(t.at(I + 20) - t.at(I + 16), { seed: 132, stepSamples: Math.round(t.stepSamples / 2), density: 0.6, baseHz: 587 }), -7, -0.3, t.at(I + 16));
  t.add('electro', renderSawLead(synthOf(t, 'D5o:4 Ab5o:4 D5o:4 C5o:4 | ~Gb5o:8 ~D5o:8', I + 24, 0.8), t.length, { seed: 133, voices: 3, detune: 16, cutoff: 3600, resonance: 0.5, vibrato: 40, pulse: true }), -12, 0.25);
  t.add('electro', riser(60 / t.bpm * 8, { seed: 134, freqFrom: 73, freqTo: 294, noise: 0.5 }), -8, 0, 0);
  t.add('electro', riser(60 / t.bpm * 4, { seed: 135, freqFrom: 73, freqTo: 294, noise: 0.6 }), -9, 0, t.at(I + 27));
  return t;
}
