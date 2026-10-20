/**
 * The finale, the endings, the workshop groove and the stingers.
 *   finale-escape   B minor, 184 BPM: relentless thrash as the core's terrain collapses behind the player
 *   finale-choice   B minor / D major ambiguity, 70 BPM: sparse pads, motif fragments on bells, a heartbeat sub
 *   ending-rewind   D major, 96 BPM: the motif turned major, big guitars, crash swells, resolved (the Orrery lives on)
 *   ending-release  B minor settling into D major, 72 BPM: clean guitar motif, pads, wind; the worlds slow to a stop
 *   workshop        B minor, 96 BPM swung half-time groove: crunch chug, snarling bass, lathe pulses, muted motif
 *   stingers        victory, defeat, mission-start, checkpoint (a/b/c), boss-phase, boss-defeated, escalation, undermined,
 *                   near-miss, kill-streak, objective, ending-rewind, ending-release
 */
import { Track, seq } from '../sequencer';
import { AMPS } from '../instruments/guitar';
import { machinePulse, riser, renderPluck, renderPad, drone, glitchSeq, renderSawLead, renderBell, impact } from '../instruments/synth';
import { noteHz } from '../dsp/core';
import { STEMS, bars, motif, bassLine } from './shared';

const bellsOf = (t: Track, notation: string, bar: number, vel = 0.8, oct = 1) => t.riff(notation, { bar, vel }).map(e => ({ at: e.at, gate: e.gate, freq: e.freq * oct, vel: e.vel }));
const synthOf = (t: Track, notation: string, bar: number, vel = 0.8) => t.riff(notation, { bar, vel }).map(e => ({ at: e.at, gate: e.gate, freq: e.freq, vel: e.vel, accent: e.vel > 0.95 }));
const up8 = (s: string) => s.replace(/(\d)o/g, (_, d) => `${Number(d) + 1}o`);

export function escape(): Track {
  const t = new Track({ id: 'finale-escape', title: 'Unwinding', bpm: 184, introBars: 2, loopBars: 32, tailBars: 2, seed: 7101, targetLufs: -12 });
  t.stem('drums', STEMS.drums(-2)); t.stem('bass', STEMS.bass(-5)); t.stem('guitars', STEMS.guitars(2)); t.stem('lead', STEMS.lead(-2)); t.stem('electro', STEMS.electro(1)); t.stem('escalation', STEMS.escalation(-6));
  const I = 2;
  const THRASH = 'B1m:1 B1m:1 B1m:1 B1m:1 >D2P:1 B1m:1 B1m:1 B1m:1 >C2P:1 B1m:1 B1m:1 B1m:1 >F2P:1 B1m:1 >E2P:1 >D2P:1';
  const THRASH_B = 'B1m:1 B1m:1 B1m:1 B1m:1 >D2P:1 B1m:1 B1m:1 B1m:1 >G2P:2 >F#2P:2 >F2P:2 >E2P:2';
  const CHASE = '>B1W:4 >D2W:4 >A1W:4 >G1W:4';
  const CHASE_B = '>B1W:4 >D2W:4 >F#2W:4 >F2W:2 >E2W:2';
  t.guitar('guitars', [
    ...t.riff(seq(THRASH, THRASH, THRASH, THRASH_B, THRASH, THRASH, THRASH, THRASH_B), { bar: I, vel: 0.95 }),
    ...t.riff(seq(CHASE, CHASE_B, CHASE, CHASE_B, CHASE, CHASE_B, CHASE, 'B1W:4 A1W:4 G1W:4 F#2W:2 B1x:1 B1x:1'), { bar: I + 8, vel: 1 }),
    ...t.riff(seq(THRASH, THRASH, THRASH, THRASH_B, THRASH, THRASH, THRASH, 'B1m:1 B1m:1 >D2P:2 >E2P:2 >F#2P:2 >G2P:2 >F#2P:2 >E2P:2 >D2P:2'), { bar: I + 16, vel: 0.95 }),
    ...t.riff(seq(CHASE, CHASE_B, CHASE, CHASE_B, CHASE, CHASE_B, CHASE, 'B1W:4 D2W:4 A1W:4 G1W:2 B1x:1 B1x:1'), { bar: I + 24, vel: 1 }),
  ], { amp: AMPS.rhythm });
  t.bass('bass', t.riff(bassLine(seq(THRASH, THRASH, THRASH, THRASH_B, THRASH, THRASH, THRASH, THRASH_B, CHASE, CHASE_B, CHASE, CHASE_B, CHASE, CHASE_B, CHASE, 'B1W:4 A1W:4 G1W:4 F#2W:2 B1x:1 B1x:1', THRASH, THRASH, THRASH, THRASH_B, THRASH, THRASH, THRASH, 'B1m:1 B1m:1 D2m:2 E2m:2 F#2m:2 G2m:2 F#2m:2 E2m:2 D2m:2', CHASE, CHASE_B, CHASE, CHASE_B, CHASE, CHASE_B, CHASE, 'B1W:4 D2W:4 A1W:4 G1W:2 B1x:1 B1x:1')), { bar: I, vel: 1 }), { drive: 3.8, sub: 0.35 });
  t.guitar('lead', [...t.riff(seq(motif('B3', 'fast'), motif('B3', 'fast'), motif('B3', 'high'), up8(motif('B3', 'answer'))), { bar: I + 8, vel: 0.95 }), ...t.riff(seq(motif('B3', 'high'), up8(motif('B3', 'answer')), motif('B3', 'high'), up8(motif('B3', 'answer'))), { bar: I + 24, vel: 1 })], { amp: AMPS.lead, lead: true });
  t.guitar('escalation', t.riff(seq(...Array(32).fill(THRASH)), { bar: I, vel: 0.85, transpose: 12 }), { amp: AMPS.lead, lead: true, gainDb: -6 });
  const A = { kick: 'xxxxxxxxxxxxxxxx', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.', crash: 'x...............' };
  const AF = { kick: 'xxxxxxxxxxxxxxxx', snare: '....X...X.X.X.XX', hat: 'x.x.x.x.x.x.....', china: '...............x' };
  const B = { kick: 'x.x.x.x.x.x.x.x.', snare: 'x.x.x.x.x.x.x.x.', crash: 'x.......x.......', ride: 'x.x.x.x.x.x.x.x.' };
  const BF = { kick: 'x.x.x.x.xxxxxxxx', snare: 'x.x.x.x.X.X.X.XX', crash: 'x.......x...x...', china: '............x...' };
  t.kit('drums', [...t.drums({ kick: '........xxxxxxxx', snare: '........X.X.X.X.', crash: '...............x' }, { bar: I - 1 }), ...bars(t, A, AF, I, 4), ...bars(t, A, AF, I + 4, 4), ...bars(t, B, BF, I + 8, 4), ...bars(t, B, BF, I + 12, 4), ...bars(t, A, AF, I + 16, 4), ...bars(t, A, AF, I + 20, 4), ...bars(t, B, BF, I + 24, 4), ...bars(t, B, BF, I + 28, 4)], { style: { kickClick: 1.35, drive: 0.45 } });
  const esk = { kick: 'xxxxxxxxxxxxxxxx', snare: 'x.x.x.x.x.x.x.x.', china: 'x...x...x...x...' };
  t.kit('escalation', bars(t, esk, esk, I, 32), { style: { kickClick: 1.3, drive: 0.5 }, gainDb: -5 });
  for (let k = 0; k < 4; k++) t.add('electro', riser(60 / t.bpm * 8, { seed: 201 + k, freqFrom: 62, freqTo: 494, noise: 0.8 }), -9, (k % 2 ? 0.3 : -0.3), t.at(I + k * 8));
  t.add('electro', machinePulse(t.at(I + 32) - t.at(I), { seed: 206, rate: t.bpm / 60 * 2, freq: 2400, q: 10, level: 0.4, duty: 0.08 }), -12, 0.4, t.at(I));
  t.add('electro', glitchSeq(t.at(I + 32) - t.at(I), { seed: 207, stepSamples: Math.round(t.stepSamples), density: 0.3, baseHz: 494 }), -11, -0.3, t.at(I));
  t.add('electro', renderSawLead(synthOf(t, 'B5o:4 F#5o:4 B5o:4 D6o:4 | ~F5o:8 ~B5o:8', I + 8, 0.8), t.length, { seed: 208, voices: 3, detune: 16, cutoff: 3800, resonance: 0.5, vibrato: 40 }), -13, 0.25);
  t.add('drums', impact({ seed: 209, seconds: 2.2, subHz: 38, ring: 165 }), -5, 0, t.at(I));
  return t;
}

export function choice(): Track {
  const t = new Track({ id: 'finale-choice', title: 'The Mainspring', bpm: 70, introBars: 1, loopBars: 16, tailBars: 2, seed: 7201, targetLufs: -18 });
  t.stem('atmo', STEMS.atmo(0)); t.stem('lead', STEMS.lead(-4)); t.stem('drums', STEMS.drums(-8));
  const I = 1;
  t.add('atmo', renderPad([['B2', 0], ['D3', 4], ['G2', 8], ['F#2', 12]].map(([n, b]) => ({ at: t.at(I + (b as number)), gate: t.barSamples * 4, freq: noteHz(n as string), vel: 0.6 })), t.length, { seed: 211, attack: 2.5, release: 3, cutoff: 1800 }), -8);
  t.add('atmo', drone(t.length, { seed: 212, freq: noteHz('B0'), cutoff: 120, wobble: 0.3, level: 0.4 }), -12);
  t.add('atmo', machinePulse(t.length, { seed: 213, rate: t.bpm / 60 / 4, freq: 60, q: 1.5, level: 0.7, duty: 0.3 }), -10, 0);
  t.add('lead', renderBell(bellsOf(t, seq('B3o:4 B3o:4 D4o:4 C#4o:4 | B3o:8 -:8', '-:16', 'F#3o:8 E3o:4 F#3o:4 | ~G3o:8 F#3o:8', '-:16'), I, 0.7, 2), t.length, { seed: 214, ratio: 2.0, index: 1.4, decay: 2.2 }), -7, -0.2);
  t.add('lead', renderBell(bellsOf(t, seq('-:16', 'B3o:4 B3o:4 D#4o:4 C#4o:4 | B3o:8 -:8', '-:16', 'F#3o:8 E3o:4 F#3o:4 | ~G#3o:8 F#3o:8'), I + 8, 0.7, 2), t.length, { seed: 215, ratio: 3.5, index: 1.8, decay: 2.2 }), -8, 0.2);
  t.guitar('lead', t.riff(seq(motif('B3'), motif('B3', 'answer')), { bar: I + 12, vel: 0.6, gateScale: 1 }), { amp: AMPS.clean, lead: true, gainDb: -6 });
  t.kit('drums', bars(t, { kick: 'x.......x.......', click: '....x.......x...' }, { kick: 'x.......x.......', click: '....x.......x...' }, I, 16), { style: { kickClick: 0.6, drive: 0.1 }, gainDb: -6 });
  return t;
}

export function endingRewind(): Track {
  const t = new Track({ id: 'ending-rewind', title: 'Rewind (The Orrery Turns Again)', bpm: 96, introBars: 2, loopBars: 32, tailBars: 2, seed: 7301, targetLufs: -13.5 });
  t.stem('drums', STEMS.drums(-3)); t.stem('bass', STEMS.bass(-5)); t.stem('guitars', STEMS.guitars(1)); t.stem('lead', STEMS.lead(-2)); t.stem('atmo', STEMS.atmo(-2));
  const I = 2;
  const MAJOR = '>D2W:8 >A1W:8 | >B1W:8 >G1W:8';
  const MAJOR_B = '>D2W:8 >A1W:8 | >G1W:8 >A1W:4 D2x:2 -:2';
  const DRIVE = 'D2m:2 D2m:1 D2m:1 >D2P:2 D2m:1 D2m:1 >F#2P:2 >G2P:2 >A2P:2 >G2P:2';
  t.guitar('guitars', [...t.riff(seq(MAJOR, MAJOR, MAJOR, MAJOR_B), { bar: I, vel: 0.9 }), ...t.riff(seq(DRIVE, DRIVE, DRIVE, 'D2m:2 D2m:1 D2m:1 >B1M:2 D2m:1 D2m:1 >G2P:2 >A2P:2 >B2P:2 >A2P:2', DRIVE, DRIVE, DRIVE, 'D2m:2 D2m:1 D2m:1 >G2P:2 >A2P:2 >B2P:2 >C#3P:2 >B2P:2 >A2P:2'), { bar: I + 8 }), ...t.riff(seq(MAJOR, MAJOR, MAJOR, MAJOR_B, MAJOR, MAJOR, MAJOR, MAJOR_B), { bar: I + 16, vel: 1 })], { amp: AMPS.rhythm });
  t.bass('bass', t.riff(seq('D2o:8 A1o:8 | B1o:8 G1o:8', 'D2o:8 A1o:8 | B1o:8 G1o:8', 'D2o:8 A1o:8 | B1o:8 G1o:8', 'D2o:8 A1o:8 | G1o:8 A1o:4 D2x:2 -:2', bassLine(seq(DRIVE, DRIVE, DRIVE, 'D2m:2 D2m:1 D2m:1 >B1M:2 D2m:1 D2m:1 >G2P:2 >A2P:2 >B2P:2 >A2P:2', DRIVE, DRIVE, DRIVE, 'D2m:2 D2m:1 D2m:1 >G2P:2 >A2P:2 >B2P:2 >C#3P:2 >B2P:2 >A2P:2')), 'D2o:8 A1o:8 | B1o:8 G1o:8', 'D2o:8 A1o:8 | B1o:8 G1o:8', 'D2o:8 A1o:8 | B1o:8 G1o:8', 'D2o:8 A1o:8 | G1o:8 A1o:4 D2x:2 -:2', 'D2o:8 A1o:8 | B1o:8 G1o:8', 'D2o:8 A1o:8 | B1o:8 G1o:8', 'D2o:8 A1o:8 | B1o:8 G1o:8', 'D2o:8 A1o:8 | G1o:8 A1o:4 D2x:2 -:2'), { bar: I, vel: 0.95 }), { drive: 3, sub: 0.45 });
  const major = motif('B3', 'major'), answerMajor = motif('B3', 'answer').replace(/F#4/g, 'F#4').replace(/C#4/g, 'C#4');
  t.guitar('lead', [...t.riff(seq(major, answerMajor, major, answerMajor), { bar: I, vel: 0.9 }), ...t.riff(seq(up8(major), up8(answerMajor), up8(major), up8(answerMajor), up8(major), up8(answerMajor), up8(major), up8(answerMajor)), { bar: I + 16, vel: 1 })], { amp: AMPS.lead, lead: true });
  t.guitar('lead', t.riff(seq(up8(major), up8(answerMajor), up8(major), up8(answerMajor)), { bar: I + 24, vel: 0.8, transpose: -5 }), { amp: AMPS.lead, lead: true, gainDb: -7 });
  const A = { kick: 'x.......x.x.....', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.', crash: 'x...............' };
  const AF = { kick: 'x.......x.x...x.', snare: '....X.......X.xx', hat: 'x.x.x.x.x.x.....', tomLo: '..............x.', crash: '...............x' };
  const B = { kick: 'x...x...x.x.x...', snare: '....X.......X...', ride: 'x.x.x.x.x.x.x.x.', crash: 'x.......x.......' };
  const BF = { kick: 'x...x...x.x.xxxx', snare: '....X...X...X.XX', ride: 'x.x.x.x.x.x.....', crash: 'x.......x...x...' };
  t.kit('drums', [...bars(t, A, AF, I, 8), ...bars(t, B, BF, I + 8, 8), ...bars(t, B, BF, I + 16, 8), ...bars(t, B, BF, I + 24, 8)], { style: { kickClick: 1.1, drive: 0.35 } });
  t.add('atmo', renderPad([['D3', 0], ['A2', 2], ['B2', 4], ['G2', 6]].flatMap(([n, b]) => [0, 8, 16, 24].map(k => ({ at: t.at(I + (b as number) + k), gate: t.barSamples * 2, freq: noteHz(n as string), vel: 0.65 }))), t.length, { seed: 221, attack: 0.8, release: 1.5, cutoff: 2800 }), -9);
  t.add('atmo', machinePulse(t.length, { seed: 222, rate: t.bpm / 60, freq: 2600, q: 10, level: 0.3, duty: 0.08 }), -16, 0.4);
  t.add('drums', impact({ seed: 223, seconds: 2.4, subHz: 36, ring: 147 }), -7, 0, t.at(I));
  return t;
}

export function endingRelease(): Track {
  const t = new Track({ id: 'ending-release', title: 'Release (Sail for the Lantern)', bpm: 72, introBars: 1, loopBars: 24, tailBars: 2, seed: 7401, targetLufs: -17 });
  t.stem('atmo', STEMS.atmo(0)); t.stem('lead', STEMS.lead(-3)); t.stem('guitars', STEMS.guitars(-6)); t.stem('drums', STEMS.drums(-9));
  const I = 1;
  t.add('atmo', renderPad([['B2', 0], ['G2', 4], ['D3', 8], ['A2', 12], ['B2', 16], ['G2', 18], ['D3', 20], ['A2', 22]].map(([n, b]) => ({ at: t.at(I + (b as number)), gate: t.barSamples * 3.5, freq: noteHz(n as string), vel: 0.6 })), t.length, { seed: 231, attack: 2.2, release: 3, cutoff: 2200 }), -8);
  t.add('atmo', drone(t.length, { seed: 232, freq: noteHz('B0'), cutoff: 110, wobble: 0.2, level: 0.35 }), -13);
  t.add('atmo', machinePulse(t.length, { seed: 233, rate: t.bpm / 60 / 8, freq: 3200, q: 14, level: 0.2, duty: 0.04 }), -18, 0.4);
  t.guitar('guitars', t.riff(seq('B2o:4 D3o:4 F#3o:4 B3o:4', 'G2o:4 B2o:4 D3o:4 G3o:4', 'D3o:4 F#3o:4 A3o:4 D4o:4', 'A2o:4 C#3o:4 E3o:4 A3o:4', 'B2o:4 D3o:4 F#3o:4 B3o:4', 'G2o:4 B2o:4 D3o:4 G3o:4', 'D3o:4 F#3o:4 A3o:4 D4o:4', 'A2o:4 C#3o:4 E3o:4 A3o:4', 'B2o:4 D3o:4 F#3o:4 B3o:4', 'G2o:4 B2o:4 D3o:4 G3o:4', 'D3o:4 F#3o:4 A3o:4 D4o:4', 'A2o:4 C#3o:4 E3o:4 A3o:4', 'B2o:4 D3o:4 F#3o:4 B3o:4', 'G2o:4 B2o:4 D3o:4 G3o:4', 'D3o:4 F#3o:4 A3o:4 D4o:4', 'A2o:4 C#3o:4 E3o:4 A3o:4', 'B2o:4 D3o:4 F#3o:4 B3o:4', 'G2o:4 B2o:4 D3o:4 G3o:4', 'D3o:4 F#3o:4 A3o:4 D4o:4', 'A2o:4 C#3o:4 E3o:4 A3o:4', 'B2o:4 D3o:4 F#3o:4 B3o:4', 'G2o:4 B2o:4 D3o:4 G3o:4', 'D3o:4 F#3o:4 A3o:4 D4o:4', 'A2o:4 C#3o:4 E3o:4 D3o:4'), { bar: I, vel: 0.55, gateScale: 1.6 }), { amp: AMPS.clean, spread: 0.6 });
  t.guitar('lead', [...t.riff(seq(motif('B3'), motif('B3', 'answer')), { bar: I + 4, vel: 0.6, gateScale: 1.2 }), ...t.riff(seq(motif('B3', 'major'), motif('B3', 'answer')), { bar: I + 12, vel: 0.65, gateScale: 1.2 }), ...t.riff(seq(up8(motif('B3', 'major')), up8(motif('B3', 'answer'))), { bar: I + 20, vel: 0.6, gateScale: 1.2 })], { amp: AMPS.clean, lead: true, gainDb: -3 });
  t.add('lead', renderBell(bellsOf(t, seq(motif('B3', 'major'), motif('B3', 'answer')), I + 16, 0.5, 2), t.length, { seed: 234, ratio: 2.0, index: 1.2, decay: 2.6 }), -10, 0.2);
  t.kit('drums', bars(t, { kick: 'x...............', click: '........x.......' }, { kick: 'x...............', click: '........x.......' }, I + 8, 16), { style: { kickClick: 0.5, drive: 0.05 }, gainDb: -6 });
  return t;
}

export function workshop(): Track {
  const t = new Track({ id: 'workshop', title: 'Copper Lathe', bpm: 96, introBars: 2, loopBars: 32, tailBars: 2, seed: 7501, targetLufs: -14.5 });
  t.stem('drums', STEMS.drums(-3)); t.stem('bass', STEMS.bass(-4)); t.stem('guitars', STEMS.guitars(-1)); t.stem('lead', STEMS.lead(-3)); t.stem('machines', STEMS.electro(0, 0));
  const I = 2;
  const FUNK = 'B1m:1 -:1 B1m:1 B1x:1 -:1 B1m:1 -:1 >D2P:2 -:1 B1m:1 B1x:1 >C2m:1 -:1 B1m:1 -:1';
  const FUNK_B = 'B1m:1 -:1 B1m:1 B1x:1 -:1 B1m:1 -:1 >F#2P:2 -:1 >E2P:2 >D2P:2 B1x:1 -:1';
  const CHORDS = '>B1W:6 -:2 >D2W:4 >A1W:4 | >G1W:6 -:2 >A1W:4 B1x:2 -:2';
  t.guitar('guitars', [...t.riff(seq(FUNK, FUNK, FUNK, FUNK_B, FUNK, FUNK, FUNK, FUNK_B), { bar: I, vel: 0.8 }), ...t.riff(seq(CHORDS, CHORDS, CHORDS, CHORDS), { bar: I + 16, vel: 0.85 }), ...t.riff(seq(FUNK, FUNK_B, FUNK, FUNK_B, FUNK, FUNK, FUNK, FUNK_B), { bar: I + 24, vel: 0.8 })], { amp: AMPS.crunch });
  const bassFunk = 'B1o:2 -:1 B1o:1 -:1 B1o:1 -:1 D2o:1 -:1 B1o:2 -:1 A1o:1 -:1 B1o:1 -:1';
  const bassFunkB = 'B1o:2 -:1 B1o:1 -:1 B1o:1 -:1 F#2o:1 -:1 E2o:2 -:1 D2o:1 -:1 C#2o:1 -:1';
  t.bass('bass', t.riff(seq(bassFunk, bassFunk, bassFunk, bassFunkB, bassFunk, bassFunk, bassFunk, bassFunkB, 'B1o:6 -:2 D2o:4 A1o:4 | G1o:6 -:2 A1o:4 B1o:2 -:2', 'B1o:6 -:2 D2o:4 A1o:4 | G1o:6 -:2 A1o:4 B1o:2 -:2', 'B1o:6 -:2 D2o:4 A1o:4 | G1o:6 -:2 A1o:4 B1o:2 -:2', 'B1o:6 -:2 D2o:4 A1o:4 | G1o:6 -:2 A1o:4 B1o:2 -:2', bassFunk, bassFunkB, bassFunk, bassFunkB, bassFunk, bassFunk, bassFunk, bassFunkB), { bar: I, vel: 0.9 }), { drive: 3, sub: 0.5 });
  const snarl = synthOf(t, seq(...Array(8).fill('B1:1 -:3 B1:1 -:1 D2:1 -:1 B1:1 -:3 A1:1 -:1 B1:1 -:1')), I + 8, 0.85);
  t.snarl('machines', snarl, { gainDb: -8, resonance: 0.55, drive: 2.2, bits: 9, downsample: 2 });
  const A = { kick: 'x.....x...x.....', snare: '....X.......X...', hat: 'x.xxx.xxx.xxx.xx', rim: '......x.......x.' };
  const AF = { kick: 'x.....x...x...x.', snare: '....X.......X.xx', hat: 'x.xxx.xxx.xxx...', tomLo: '..............x.' };
  const B = { kick: 'x...x.x...x.....', snare: '....X.......X...', ride: 'x.x.x.x.x.x.x.x.', crash: 'x...............', clap: '....x.......x...' };
  const BF = { kick: 'x...x.x...x.x.x.', snare: '....X.....X.X.xx', ride: 'x.x.x.x.x.x.....', tomHi: '............x...' };
  t.kit('drums', [...bars(t, A, AF, I, 8, { swing: 0.35 }), ...bars(t, A, AF, I + 8, 8, { swing: 0.35 }), ...bars(t, B, BF, I + 16, 8, { swing: 0.35 }), ...bars(t, A, AF, I + 24, 8, { swing: 0.35 })], { style: { kickClick: 1, drive: 0.35 } });
  t.add('lead', renderPluck(bellsOf(t, seq(motif('B3'), motif('B3', 'answer')), I + 8, 0.7, 2), t.length, { seed: 241, cutoff: 3400, crush: 9, width: 0.3, decay: 0.3 }), -7, -0.2);
  t.guitar('lead', t.riff(seq(motif('B3'), motif('B3', 'answer')), { bar: I + 20, vel: 0.75 }), { amp: AMPS.lead, lead: true, gainDb: -5 });
  t.add('machines', machinePulse(t.length, { seed: 242, rate: t.bpm / 60 * 2, freq: 1700, q: 9, level: 0.4, duty: 0.1 }), -13, 0.4);
  t.add('machines', machinePulse(t.length, { seed: 243, rate: t.bpm / 60 / 2, freq: 260, q: 5, level: 0.6, duty: 0.3 }), -12, -0.4);
  t.add('machines', glitchSeq(t.length, { seed: 244, stepSamples: Math.round(t.stepSamples * 2), density: 0.1, baseHz: 247 }), -16, 0.2);
  t.add('machines', drone(t.length, { seed: 245, freq: noteHz('B1'), cutoff: 240, wobble: 0.5, level: 0.4 }), -12);
  return t;
}

// ---- Stingers (one-shots: intro bars only, no loop) ------------------------------------------------------------------------
function stinger(id: string, title: string, bpm: number, bars_: number, seed: number, build: (t: Track) => void): Track {
  const t = new Track({ id, title, bpm, introBars: bars_, loopBars: 0, tailBars: 0, seed, targetLufs: -13, kind: 'stinger' });
  t.stem('all', { layer: 0, hp: 30, reverb: { spec: { seconds: 1.6, damp: 4000, preDelayMs: 15, size: 1.2 }, mixDb: -16 } });
  build(t);
  return t;
}
export function stingers(): Record<string, () => Track> {
  const up8m = (s: string) => up8(s);
  return {
    'stinger-victory': () => stinger('stinger-victory', 'Victory', 108, 3, 8101, t => {
      t.guitar('all', t.riff('>B1W:4 >D2W:4 >A1W:4 >G1W:4 | >D2W:16', { bar: 0, vel: 1 }), { amp: AMPS.rhythm });
      t.guitar('all', t.riff(seq(up8m(motif('B3', 'major')), 'D5o:16'), { bar: 0, vel: 1 }), { amp: AMPS.lead, lead: true, gainDb: -2 });
      t.kit('all', [...t.drums({ kick: 'x...x...x...x...', snare: '....X.......X...', crash: 'x...............' }, { bar: 0 }), ...t.drums({ kick: 'x...x...x.xxxxxx', snare: '....X...X.X.X.XX', crash: 'x.......x.......' }, { bar: 1 }), ...t.drums({ kick: 'x...............', crash: 'x...............', china: 'x...............' }, { bar: 2 })], { style: { kickClick: 1.2, drive: 0.4 } });
      t.add('all', impact({ seed: 8102, seconds: 2.4, subHz: 40, ring: 147 }), -6, 0, t.at(2));
    }),
    'stinger-defeat': () => stinger('stinger-defeat', 'Defeat', 84, 3, 8201, t => {
      t.guitar('all', t.riff('>B1W:8 >Bb1W:8 | >A1W:8 >Ab1W:8 | >G1W:16', { bar: 0, vel: 1 }), { amp: AMPS.rhythm });
      t.guitar('all', t.riff('B3o:4 B3o:4 D4o:4 C4o:4 | B3o:4 -:4 A3o:4 Ab3o:4 | ~G3o:16', { bar: 0, vel: 0.9 }), { amp: AMPS.lead, lead: true, gainDb: -2 });
      t.kit('all', [...t.drums({ slam: 'x.......x.......', kick: 'x.......x.......', crash: 'x...............' }, { bar: 0 }), ...t.drums({ slam: 'x.......x.......', kick: 'x.......x.......', china: '........x.......' }, { bar: 1 }), ...t.drums({ slam: 'x...............', crash: 'x...............' }, { bar: 2 })], { style: { kickTune: 0.9, drive: 0.5 } });
      t.add('all', impact({ seed: 8202, seconds: 3, subHz: 30, ring: 98 }), -4, 0, t.at(2));
    }),
    'stinger-mission-start': () => stinger('stinger-mission-start', 'Mission start', 120, 2, 8301, t => {
      t.add('all', riser(60 / t.bpm * 4, { seed: 8302, freqFrom: 62, freqTo: 247, noise: 0.7 }), -8, 0, 0);
      t.guitar('all', t.riff('-:16 | >B1W:4 >D2W:4 >A1W:4 B1x:2 -:2', { bar: 0, vel: 1 }), { amp: AMPS.rhythm });
      t.kit('all', [...t.drums({ kick: '............x.x.', snare: '............X.X.' }, { bar: 0 }), ...t.drums({ kick: 'x...x...x.......', snare: '....X.......X...', crash: 'x...............', china: '........x.......' }, { bar: 1 })], { style: { kickClick: 1.2, drive: 0.4 } });
      t.add('all', impact({ seed: 8303, seconds: 1.8, subHz: 42, ring: 165 }), -8, 0, t.at(1));
    }),
    'stinger-checkpoint': () => stinger('stinger-checkpoint', 'Checkpoint', 120, 1, 8401, t => {
      t.add('all', renderBell(bellsOf(t, 'B4o:2 F#5o:2 B5o:12', 0, 0.8, 1), t.length, { seed: 8402, ratio: 2.0, index: 1.4, decay: 1.4 }), -6);
      t.add('all', machinePulse(Math.round(t.barSamples * 0.5), { seed: 8403, rate: 12, freq: 1800, q: 10, level: 0.4, duty: 0.1 }), -14, 0.2);
    }),
    'stinger-boss-phase': () => stinger('stinger-boss-phase', 'Boss phase', 132, 2, 8501, t => {
      t.add('all', riser(60 / t.bpm * 4, { seed: 8502, freqFrom: 44, freqTo: 175, noise: 0.95 }), -7, 0, 0);
      t.kit('all', [...t.drums({ kick: '............xxxx', snare: '............X.X.' }, { bar: 0 }), ...t.drums({ slam: 'x...............', kick: 'x...............', china: 'x...............', crash: 'x...............', anvil: 'x.......x.......' }, { bar: 1 })], { style: { kickTune: 0.95, drive: 0.5 } });
      t.guitar('all', t.riff('-:16 | >F2W:8 >Gb2W:4 >F2W:4', { bar: 0, vel: 1 }), { amp: AMPS.rhythm });
      t.add('all', impact({ seed: 8503, seconds: 2.4, subHz: 34, ring: 175 }), -4, 0, t.at(1));
    }),
    'stinger-escalation': () => stinger('stinger-escalation', 'Fleet away', 148, 2, 8601, t => {
      t.add('all', renderSawLead(synthOf(t, 'E4o:4 G4o:4 B4o:8 | E5o:16', 0, 0.9), t.length, { seed: 8602, voices: 7, detune: 9, cutoff: 2400, resonance: 0.2, drive: 1.2 }), -8);
      t.kit('all', [...t.drums({ kick: 'x...x...x...x.x.', snare: '....X.......X.XX', crash: 'x...............' }, { bar: 0 }), ...t.drums({ kick: 'x...............', crash: 'x...............', china: 'x...............' }, { bar: 1 })], { style: { kickClick: 1.2, drive: 0.4 } });
      t.guitar('all', t.riff('>E2W:8 >G2W:8 | >B2W:16', { bar: 0, vel: 1 }), { amp: AMPS.rhythm, gainDb: -2 });
    }),
    'stinger-undermined': () => stinger('stinger-undermined', 'Undermined', 100, 2, 8701, t => {
      t.add('all', impact({ seed: 8702, seconds: 3, subHz: 28, ring: 110 }), -3, 0, 0);
      t.kit('all', [...t.drums({ slam: 'x.......x.......', kick: 'x.......x.......', china: 'x...............', chain: '....x.......x...', pipe: '......x.........' }, { bar: 0 }), ...t.drums({ slam: 'x...............', crash: 'x...............' }, { bar: 1 })], { style: { kickTune: 0.9, drive: 0.5 } });
      t.guitar('all', t.riff('>B1W:8 >F2W:8 | >E2W:16', { bar: 0, vel: 1 }), { amp: AMPS.rhythm, gainDb: -1 });
    }),
    // ---- Cues the runtime added on 2026-10-17, written in the first delivery's language -----------------------------------------
    /** A hostile shell within three units: a snare roll and a riser into one stab. */
    'stinger-near-miss': () => stinger('stinger-near-miss', 'Near miss', 160, 1, 8801, t => {
      t.add('all', riser(60 / t.bpm * 2, { seed: 8802, freqFrom: 123, freqTo: 494, noise: 0.9 }), -8, 0, 0);
      t.kit('all', t.drums({ snare: 'oooooooooooooooooxxxxxxxxXXXXXXX', kick: 'x...x...x...x...x...x...x...x...', crash: '...............................x' }, { bar: 0, res: 32 }), { style: { kickClick: 1.2, drive: 0.45 }, gainDb: -2 });
      t.guitar('all', t.riff('-:14 >F2P:2', { bar: 0, vel: 1 }), { amp: AMPS.rhythm, gainDb: -4 });
    }),
    /** Three kills in ten seconds: a two-bar riff on the theme's riff cells, a harmonic, a crash. */
    'stinger-kill-streak': () => stinger('stinger-kill-streak', 'Kill streak', 160, 2, 8901, t => {
      t.guitar('all', t.riff('>B1M:1 B1m:1 >D2P:1 B1m:1 >F2P:1 B1m:1 >E2P:1 >D2P:1 >B1M:2 >C2P:2 >B2h:4 | >B1P:16', { bar: 0, vel: 1 }), { amp: AMPS.rhythm });
      t.bass('all', t.riff('B1m:1 B1m:1 D2m:1 B1m:1 F2m:1 B1m:1 E2m:1 D2m:1 B1m:2 C2m:2 B1o:4 | B1o:16', { bar: 0, vel: 1 }), { drive: 3.8, sub: 0.4 });
      t.kit('all', [...t.drums({ kick: 'x.x.x.x.x.x.x.x.', snare: '.x.x.x.x.x.x.x.x', china: 'x...x...x...x...' }, { bar: 0 }), ...t.drums({ kick: 'x...............', crash: 'x...............', china: 'x...............' }, { bar: 1 })], { style: { kickClick: 1.3, drive: 0.5 } });
      t.add('all', impact({ seed: 8902, seconds: 2, subHz: 40, ring: 165 }), -7, 0, t.at(1));
    }),
    /** Objective complete while the score plays: a bell figure with a bass lick and a resolving chord (replaces the UI chime). */
    'stinger-objective': () => stinger('stinger-objective', 'Objective complete', 120, 2, 9001, t => {
      t.add('all', renderBell(bellsOf(t, 'B4o:2 D5o:2 F#5o:2 B5o:10 | D6o:16', 0, 0.8, 1), t.length, { seed: 9002, ratio: 2.0, index: 1.5, decay: 1.6 }), -7);
      t.bass('all', t.riff('B1o:1 B2o:1 B1x:1 D2o:1 F#2o:1 B1x:1 A2o:1 B2o:1 -:8', { bar: 0, vel: 0.95 }), { drive: 3, sub: 0.4, gainDb: -3 });
      t.guitar('all', t.riff('-:8 >B1W:4 >D2W:4 | >A1W:16', { bar: 0, vel: 0.9 }), { amp: AMPS.rhythm, gainDb: -4 });
      t.kit('all', [...t.drums({ kick: '........x...x...', snare: '............X...', crash: '........x.......' }, { bar: 0 }), ...t.drums({ kick: 'x...............', crash: 'x...............' }, { bar: 1 })], { style: { kickClick: 1.1, drive: 0.35 }, gainDb: -2 });
    }),
    /** Checkpoint variants, so repeated saves do not repeat one bell. */
    'stinger-checkpoint-b': () => stinger('stinger-checkpoint-b', 'Checkpoint B', 120, 1, 8411, t => {
      t.add('all', renderBell(bellsOf(t, 'B4o:2 D5o:2 F#5o:2 B5o:10', 0, 0.8, 1), t.length, { seed: 8412, ratio: 3.5, index: 1.4, decay: 1.4 }), -6);
      t.add('all', machinePulse(Math.round(t.barSamples * 0.5), { seed: 8413, rate: 12, freq: 1800, q: 10, level: 0.4, duty: 0.1 }), -14, 0.2);
    }),
    'stinger-checkpoint-c': () => stinger('stinger-checkpoint-c', 'Checkpoint C', 120, 1, 8421, t => {
      t.add('all', renderBell(bellsOf(t, 'F#5o:2 B4o:2 D5o:2 F#5o:10', 0, 0.8, 1), t.length, { seed: 8422, ratio: 2.0, index: 1.4, decay: 1.4 }), -6);
      t.add('all', machinePulse(Math.round(t.barSamples * 0.5), { seed: 8423, rate: 12, freq: 1800, q: 10, level: 0.4, duty: 0.1 }), -14, 0.2);
    }),
    /** A boss falls: the hook chords, the motif an octave up, a long power chord and a slam. */
    'stinger-boss-defeated': () => stinger('stinger-boss-defeated', 'Boss defeated', 120, 3, 8511, t => {
      t.guitar('all', t.riff('>B1W:4 >D2W:4 >A1W:4 >G1W:4 | >B1W:8 >B1P:8 | -:16', { bar: 0, vel: 1 }), { amp: AMPS.rhythm });
      t.guitar('all', t.riff(seq(up8(motif('B3')), 'B5o:16'), { bar: 0, vel: 1 }), { amp: AMPS.lead, lead: true, gainDb: -3 });
      t.bass('all', t.riff('B1o:4 D2o:4 A1o:4 G1o:4 | B1o:16 | -:16', { bar: 0, vel: 1 }), { drive: 3.6, sub: 0.4 });
      t.kit('all', [...t.drums({ kick: 'x...x...x...x...', snare: '....X.......X...', crash: 'x...............', china: '........x.......' }, { bar: 0 }), ...t.drums({ kick: 'x.......x.xxxxxx', snare: '....X...X.X.X.XX', crash: 'x.......x.......' }, { bar: 1 }), ...t.drums({ slam: 'x...............', crash: 'x...............', china: 'x...............' }, { bar: 2 })], { style: { kickClick: 1.2, drive: 0.45 } });
      t.add('all', impact({ seed: 8512, seconds: 3, subHz: 34, ring: 123 }), -4, 0, t.at(2));
    }),
    /** The endings' final hits: the Rewind resolves in D major with the big guitars; the Release settles on a clean chord. */
    'stinger-ending-rewind': () => stinger('stinger-ending-rewind', 'Rewind: the final hit', 96, 3, 9101, t => {
      t.guitar('all', t.riff('>D2W:8 >A1W:8 | >B1W:8 >G1W:8 | >D2W:16', { bar: 0, vel: 1 }), { amp: AMPS.rhythm });
      t.guitar('all', t.riff(seq(up8(motif('B3', 'major')), 'D5o:16'), { bar: 0, vel: 1 }), { amp: AMPS.lead, lead: true, gainDb: -2 });
      t.bass('all', t.riff('D2o:8 A1o:8 | B1o:8 G1o:8 | D2o:16', { bar: 0, vel: 1 }), { drive: 3, sub: 0.45 });
      t.kit('all', [...t.drums({ kick: 'x...x...x...x...', snare: '....X.......X...', crash: 'x...............' }, { bar: 0 }), ...t.drums({ kick: 'x...x...x.xxxxxx', snare: '....X...X.X.X.XX', crash: 'x.......x.......' }, { bar: 1 }), ...t.drums({ kick: 'x...............', crash: 'x...............' }, { bar: 2 })], { style: { kickClick: 1.1, drive: 0.35 } });
      t.add('all', impact({ seed: 9102, seconds: 2.6, subHz: 40, ring: 147 }), -6, 0, t.at(2));
    }),
    'stinger-ending-release': () => stinger('stinger-ending-release', 'Release: the final hit', 72, 3, 9201, t => {
      t.guitar('all', t.riff('B2o:4 D3o:4 F#3o:4 B3o:4 | G2o:4 B2o:4 D3o:4 G3o:4 | D3o:16', { bar: 0, vel: 0.6, gateScale: 1.5 }), { amp: AMPS.clean, spread: 0.6 });
      t.add('all', renderPad([['B2', 0], ['G2', 1], ['D3', 2]].map(([n, b]) => ({ at: t.at(b as number), gate: t.barSamples, freq: noteHz(n as string), vel: 0.55 })), t.length, { seed: 9203, attack: 0.6, release: 2.5, cutoff: 2000 }), -10);
      t.add('all', renderBell(bellsOf(t, seq(motif('B3', 'major'), 'D5o:16'), 0, 0.5, 2), t.length, { seed: 9202, ratio: 2.0, index: 1.2, decay: 2.6 }), -9, 0.2);
      t.kit('all', t.drums({ kick: 'x...............', click: '........x.......' }, { bar: 2 }), { style: { kickClick: 0.5, drive: 0.05 }, gainDb: -6 });
    }),
  };
}
