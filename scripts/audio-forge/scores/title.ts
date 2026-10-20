/**
 * "Tiny Metal Tank" — the main theme. B minor, 108 BPM, 4-bar intro + 32-bar loop.
 * The TMT motif (B B D C B · A B | F#——— E F# G F#) is stated by the lead guitar over the chug riff, broken down at
 * half time, driven double-time, and returned as the big hook. Stems: drums, bass, guitars (layer 1), lead (layer 2),
 * machines (industrial electronics, layer 0).
 */
import { Track, rep, seq } from '../sequencer';
import { AMPS } from '../instruments/guitar';
import { machinePulse, riser, impact, renderPluck, renderPad, glitchSeq, drone } from '../instruments/synth';
import { SR, noteHz } from '../dsp/core';

/** The motif in riff notation (two bars, lead register). */
export const MOTIF = 'B3o:2 B3o:2 D4o:2 C4o:2 B3o:2 -:2 A3o:2 B3o:2 | ~F#3o:8 E3o:2 F#3o:2 G3o:2 F#3o:2';
export const MOTIF_HIGH = 'B4o:2 B4o:2 D5o:2 C5o:2 B4o:2 -:2 A4o:2 B4o:2 | ~F#4o:8 E4o:2 F#4o:2 G4o:2 F#4o:2';
/** The answer phrase (bars 3-4 of the hook). */
export const MOTIF_ANSWER = 'D4o:2 D4o:2 F#4o:2 E4o:2 D4o:2 -:2 C#4o:2 D4o:2 | ~B3o:6 A3o:2 G3o:2 F#3o:2 E3o:2 F#3o:2';

const RIFF_A = 'B1m:2 B1m:2 B1m:1 B1m:1 >D2P:2 B1m:2 B1m:2 >C2P:2 B1m:1 B1m:1';
const RIFF_A_END = 'B1m:2 B1m:2 B1m:1 B1m:1 >F2P:2 B1m:2 >E2P:2 >D2P:2 B1x:1 B1x:1';
const RIFF_B = 'B1m:1 B1m:1 B1m:2 >D2P:2 B1m:1 B1m:1 >G2P:2 B1m:2 >F#2P:2 B1m:1 B1m:1';
const RIFF_B_END = 'B1m:1 B1m:1 B1m:2 >D2P:2 B1m:1 B1m:1 >E2P:3 >D2P:3 C2x:1 B1x:1';
const BREAK = '>B1M:3 -:1 >B1M:3 -:1 >B1M:2 -:2 B1x:1 -:1 >D2P:2';
const BREAK_END = '>B1M:3 -:1 >B1M:3 -:1 >G2P:2 >F#2P:2 >F2P:2 >E2P:2';
const DRIVE = 'B1m:1 B1m:1 B1m:1 B1m:1 B1m:1 B1m:1 >D2P:1 B1m:1 B1m:1 B1m:1 B1m:1 B1m:1 >C2P:1 B1m:1 >A1M:1 B1m:1';
const DRIVE_END = 'B1m:1 B1m:1 B1m:1 B1m:1 >E2P:1 B1m:1 >D2P:1 B1m:1 >G2P:2 >F#2P:2 >E2P:2 >D2P:2';
const HOOK_CHORDS = '>B1W:8 >D2W:8 | >A1W:8 >G1W:8';
const HOOK_CHORDS_END = '>B1W:4 >D2W:4 >A1W:4 >G1W:4 | >F#2W:8 >F2W:4 B1x:2 -:2';

export function build(): Track {
  const t = new Track({ id: 'title', title: 'Tiny Metal Tank (Main Theme)', bpm: 108, introBars: 4, loopBars: 32, tailBars: 2, seed: 2026, targetLufs: -13 });
  t.stem('drums', { layer: 0, hp: 30, comp: { thresholdDb: -14, ratio: 3, attack: 0.012, release: 0.11, kneeDb: 6, makeupDb: 2 }, sat: 1.25, transient: [1.35, 0.95], reverb: { spec: { seconds: 0.9, damp: 5000, preDelayMs: 8, size: 0.7 }, mixDb: -20 }, gainDb: -2.5 });
  t.stem('bass', { layer: 0, hp: 32, lp: 7000, gainDb: -5 });
  t.stem('guitars', { layer: 1, hp: 80, eq: [['peaking', 250, 1.2, -1.5], ['peaking', 3000, 1, 1]], gainDb: 2 });
  t.stem('lead', { layer: 2, hp: 160, reverb: { spec: { seconds: 1.8, damp: 4200, preDelayMs: 25, size: 1.1 }, mixDb: -14 }, gainDb: -2 });
  t.stem('machines', { layer: 0, hp: 60, width: 1.3, reverb: { spec: { seconds: 1.4, damp: 3000, preDelayMs: 12 }, mixDb: -18 }, gainDb: 4 });
  const I = 4; // loop starts at bar 4
  // ---- intro: machine pulse, a riser and a slam into the riff; the motif whispered by a pluck synth ---------------------
  t.add('machines', machinePulse(t.at(I), { seed: 3, rate: t.bpm / 60 * 2, freq: 1900, q: 9, level: 0.5 }), -10, -0.3);
  t.add('machines', machinePulse(t.at(I), { seed: 4, rate: t.bpm / 60 / 2, freq: 310, q: 6, level: 0.7, duty: 0.3 }), -8, 0.35);
  t.add('machines', riser(60 / t.bpm * 8, { seed: 9, freqFrom: 55, freqTo: 220, noise: 0.7 }), -8, 0, t.at(2));
  t.add('machines', renderPluck(t.riff(MOTIF, { bar: 0, vel: 0.7 }).map(e => ({ at: e.at, gate: e.gate, freq: e.freq * 2, vel: e.vel })), t.at(I), { seed: 12, cutoff: 3200, crush: 9, width: 0.25, decay: 0.3 }), -9, 0.2);
  t.add('machines', renderPluck(t.riff(MOTIF, { bar: 2, vel: 0.8 }).map(e => ({ at: e.at, gate: e.gate, freq: e.freq * 2, vel: e.vel })), t.at(I), { seed: 13, cutoff: 4200, crush: 8, width: 0.3, decay: 0.3 }), -8, -0.2);
  t.add('drums', impact({ seed: 21, seconds: 2.2, subHz: 38, ring: 165 }), -6, 0, t.at(I));
  t.add('machines', drone(t.at(I), { seed: 31, freq: noteHz('B1'), cutoff: 260, wobble: 0.5, level: 0.5 }), -8);
  // ---- guitars ----------------------------------------------------------------------------------------------------------
  const g = [
    ...t.riff(seq(RIFF_A, RIFF_A, RIFF_A, RIFF_A_END, RIFF_A, RIFF_A, RIFF_A, RIFF_A_END), { bar: I + 0 }),
    ...t.riff(seq(RIFF_B, RIFF_B, RIFF_B, RIFF_B_END, RIFF_B, RIFF_B, RIFF_B, RIFF_B_END), { bar: I + 8 }),
    ...t.riff(seq(BREAK, BREAK, BREAK, BREAK_END), { bar: I + 16, vel: 1 }),
    ...t.riff(seq(DRIVE, DRIVE, DRIVE, DRIVE_END, DRIVE, DRIVE, DRIVE, DRIVE_END), { bar: I + 20, vel: 0.85 }),
    ...t.riff(seq(HOOK_CHORDS, HOOK_CHORDS_END), { bar: I + 28, vel: 1, gateScale: 0.98 }),
  ];
  t.guitar('guitars', g, { amp: AMPS.rhythm });
  // ---- bass: the riff roots with the same rhythm ---------------------------------------------------------------------------
  const bassOf = (notation: string) => notation.replace(/([A-G]#?\d)([MPWw])/g, '$1m').replace(/([A-G]#?)2([mx])/g, '$11$2');
  const b = [
    ...t.riff(seq(RIFF_A, RIFF_A, RIFF_A, RIFF_A_END, RIFF_A, RIFF_A, RIFF_A, RIFF_A_END).replace(/[PWMw]/g, 'm'), { bar: I + 0, vel: 0.95 }),
    ...t.riff(seq(RIFF_B, RIFF_B, RIFF_B, RIFF_B_END, RIFF_B, RIFF_B, RIFF_B, RIFF_B_END).replace(/[PWMw]/g, 'm'), { bar: I + 8, vel: 0.95 }),
    ...t.riff(seq(BREAK, BREAK, BREAK, BREAK_END).replace(/[PWMw]/g, 'o'), { bar: I + 16, vel: 1 }),
    ...t.riff(seq(DRIVE, DRIVE, DRIVE, DRIVE_END, DRIVE, DRIVE, DRIVE, DRIVE_END).replace(/[PWMw]/g, 'm'), { bar: I + 20, vel: 0.9 }),
    ...t.riff('B1o:8 D2o:8 | A1o:8 G1o:8 | B1o:4 D2o:4 A1o:4 G1o:4 | F#2o:8 F2o:4 B1x:2 -:2'.replace(/G1/g, 'G1').replace(/A1/g, 'A1'), { bar: I + 28, vel: 1 }),
  ];
  void bassOf;
  t.bass('bass', b, { drive: 3.2, sub: 0.35 });
  // ---- lead: the motif over the second riff, high in the drive, hook on the chords ------------------------------------------
  const lead = [
    ...t.riff(seq(MOTIF, MOTIF_ANSWER, MOTIF, MOTIF_ANSWER), { bar: I + 8, vel: 0.9 }),
    ...t.riff(seq(MOTIF_HIGH, MOTIF_ANSWER.replace(/(\d)o/g, (_, d) => `${Number(d) + 1}o`)), { bar: I + 24, vel: 0.95 }),
    ...t.riff(seq(MOTIF_HIGH, MOTIF_ANSWER.replace(/(\d)o/g, (_, d) => `${Number(d) + 1}o`)), { bar: I + 28, vel: 1 }),
  ];
  t.guitar('lead', lead, { amp: AMPS.lead, lead: true });
  // Harmony a third below the hook (bars 30-31 only).
  t.guitar('lead', t.riff(MOTIF_ANSWER.replace(/(\d)o/g, (_, d) => `${Number(d) + 1}o`), { bar: I + 30, vel: 0.8, transpose: -4 }), { amp: AMPS.lead, lead: true, gainDb: -6 });
  // ---- drums -------------------------------------------------------------------------------------------------------------
  const H = { kick: 'x..x..x...x.....', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.', china: 'x...............' };
  const HF = { kick: 'x..x..x...x.x...', snare: '....X.......X.xx', hat: 'x.x.x.x.x.x.....', tomHi: '............x...', tomLo: '..............x.' };
  const F = { kick: 'x.x.x.x.xx..x.x.', snare: '....X.......X...', hat: 'xxxxxxxxxxxxxxxx', crash: 'x...............' };
  const FF = { kick: 'x.x.x.x.xxxxx.x.', snare: '....X.....XX..XX', hat: 'xxxxxxxxxxxx....', tomMid: '............xx..', tomLo: '..............xx' };
  const B = { slam: 'x...........x...', kick: 'x...x...x...x...', snare: '........X.......', hatOpen: 'x...x...x...x...', china: 'x...........x...' };
  const BF = { slam: 'x...........x...', kick: 'x...x...x...xxxx', snare: '........X...X.X.', hatOpen: 'x...x...x.......', crash: '............x...' };
  const D = { kick: 'xxxxxxxxxxxxxxxx', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.', ride: 'x...x...x...x...' };
  const DF = { kick: 'xxxxxxxxxxxxxxxx', snare: '....X...X.X.X.XX', hat: 'x.x.x.x.x.x.....', crash: '..............x.' };
  const K = { kick: 'x...x...x...x...', snare: '....X.......X...', crash: 'x...............', ride: 'x.x.x.x.x.x.x.x.' };
  const KF = { kick: 'x..xx..xx..xx.x.', snare: '....X.......X.xx', crash: 'x...........x...', china: '..............x.' };
  const hits = [
    ...t.drums({ kick: '............x.x.', snare: '............X...', crash: '..............x.' }, { bar: I - 1 }),
    ...[0, 1, 2].flatMap(k => t.drums(H, { bar: I + k })), ...t.drums(HF, { bar: I + 3 }),
    ...[4, 5, 6].flatMap(k => t.drums(H, { bar: I + k })), ...t.drums(HF, { bar: I + 7 }),
    ...[8, 9, 10].flatMap(k => t.drums(F, { bar: I + k })), ...t.drums(FF, { bar: I + 11 }),
    ...[12, 13, 14].flatMap(k => t.drums(F, { bar: I + k })), ...t.drums(FF, { bar: I + 15 }),
    ...[16, 17, 18].flatMap(k => t.drums(B, { bar: I + k })), ...t.drums(BF, { bar: I + 19 }),
    ...[20, 21, 22].flatMap(k => t.drums(D, { bar: I + k })), ...t.drums(DF, { bar: I + 23 }),
    ...[24, 25, 26].flatMap(k => t.drums(D, { bar: I + k })), ...t.drums(DF, { bar: I + 27 }),
    ...[28, 29, 30].flatMap(k => t.drums(K, { bar: I + k })), ...t.drums(KF, { bar: I + 31 }),
  ];
  t.kit('drums', hits, { style: { kickClick: 1.1, drive: 0.35 } });
  // ---- machines across the loop: pulses under A/B, glitches in the breakdown, an arp in the drive, a pad under the hook ----
  const loopLen = t.at(I + 32) - t.at(I);
  t.add('machines', machinePulse(t.at(I + 16) - t.at(I), { seed: 5, rate: t.bpm / 60 * 2, freq: 2200, q: 10, level: 0.4 }), -14, 0.4, t.at(I));
  t.add('machines', glitchSeq(t.at(I + 20) - t.at(I + 16), { seed: 8, stepSamples: Math.round(t.stepSamples), density: 0.45, baseHz: 247 }), -12, -0.3, t.at(I + 16));
  const arpNotes = ['B3', 'D4', 'F#4', 'A4', 'B4', 'A4', 'F#4', 'D4'];
  const arp = Array.from({ length: 8 * 16 }, (_, i) => ({ at: t.at(I + 20) + Math.round(i * t.stepSamples), gate: Math.round(t.stepSamples * 0.6), freq: noteHz(arpNotes[i % 8]) * (i % 32 >= 24 ? 2 : 1), vel: 0.7 + 0.3 * (i % 4 === 0 ? 1 : 0) }));
  t.add('machines', renderPluck(arp, t.length, { seed: 15, cutoff: 5200, crush: 8, width: 0.22, decay: 0.2 }), -13, 0.3);
  const pad = [['B2', 0], ['D3', 2], ['A2', 4], ['G2', 6], ['B2', 8], ['D3', 9], ['A2', 10], ['G2', 11], ['F#2', 12], ['F2', 14]].map(([n, bar]) => ({ at: t.at(I + 28 + (bar as number) / 4), gate: Math.round(t.barSamples / 2), freq: noteHz(n as string), vel: 0.8 }));
  t.add('machines', renderPad(pad, t.length, { seed: 16, attack: 0.05, release: 0.4, cutoff: 2200 }), -12);
  void loopLen; void SR;
  return t;
}
