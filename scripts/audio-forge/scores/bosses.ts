/**
 * Boss identities and the fleet-launch defence. Layers map to gameplay phases: 0 core (drums, bass, machines),
 * 1 the boss riff, 2 the motif/lead (phase 1), 3 escalation (phase 2 / final stage).
 *   Siege Crawler  F minor, 132 BPM: a lumbering march that circles the planet; phase 1 adds the phrygian motif, phase 2 double-kick + siren
 *   Leviathan      E minor, 120 BPM: surging half-time swells, periscope bells, rising/falling riffs
 *   Frost Titan    C# minor, 150 BPM: precise double-kick, ice bells, calving breakdown hits
 *   Rustcrown      B minor, 160 BPM: the TMT motif corrupted (b2 and tritone), a mirror duel; the core phase adds a choir-like pad
 *   Fleet launch   E minor → B minor, 148 BPM: a hold-out hymn that grows per launched fleet, the motif turning major at the last stage
 */
import { Track, seq } from '../sequencer';
import { AMPS } from '../instruments/guitar';
import { machinePulse, riser, renderPluck, renderPad, drone, glitchSeq, renderSawLead, renderBell, impact } from '../instruments/synth';
import { noteHz } from '../dsp/core';
import { STEMS, bars, motif, bassLine, transposeRiff } from './shared';

const bellsOf = (t: Track, notation: string, bar: number, vel = 0.8, oct = 1) => t.riff(notation, { bar, vel }).map(e => ({ at: e.at, gate: e.gate, freq: e.freq * oct, vel: e.vel }));
const synthOf = (t: Track, notation: string, bar: number, vel = 0.8) => t.riff(notation, { bar, vel }).map(e => ({ at: e.at, gate: e.gate, freq: e.freq, vel: e.vel, accent: e.vel > 0.95 }));
const up8 = (s: string) => s.replace(/(\d)o/g, (_, d) => `${Number(d) + 1}o`);

export function crawler(): Track {
  const t = new Track({ id: 'boss-crawler', title: 'The Siege Crawler', bpm: 132, introBars: 2, loopBars: 32, tailBars: 2, seed: 6101, targetLufs: -12.5 });
  t.stem('drums', STEMS.drums(-2)); t.stem('bass', STEMS.bass(-5)); t.stem('guitars', STEMS.guitars(2)); t.stem('lead', STEMS.lead(-2)); t.stem('electro', STEMS.electro(1, 0)); t.stem('escalation', STEMS.escalation(-6));
  const I = 2;
  const MARCH = '>F2M:2 F2m:2 >F2M:2 F2m:1 F2m:1 >Gb2P:2 F2m:2 >Eb2P:2 >Db2P:2';
  const MARCH_B = '>F2M:2 F2m:2 >F2M:2 F2m:1 F2m:1 >Ab2P:2 >Gb2P:2 >F2M:2 F2x:1 F2x:1';
  const HEAVY = '>F2W:6 >Gb2W:2 >F2W:4 >Db2W:4 | >F2W:6 >Gb2W:2 >Eb2W:4 >C2W:4';
  const STOMP = '>F2M:4 -:4 >Gb2M:4 -:4 | >F2M:4 -:4 >Eb2M:2 >Db2M:2 >C2M:4';
  t.guitar('guitars', [
    ...t.riff(seq(MARCH, MARCH, MARCH, MARCH_B, MARCH, MARCH, MARCH, MARCH_B), { bar: I, vel: 0.95 }),
    ...t.riff(seq(HEAVY, HEAVY, HEAVY, HEAVY), { bar: I + 8, vel: 1 }),
    ...t.riff(seq(STOMP, STOMP), { bar: I + 16, vel: 1 }),
    ...t.riff(seq(MARCH, MARCH_B, MARCH, MARCH_B, MARCH, MARCH, MARCH, 'F2m:1 F2m:1 >Gb2P:2 >Ab2P:2 >Bb2P:2 >B2P:2 >Bb2P:2 >Ab2P:2 >Gb2P:2'), { bar: I + 20 }),
    ...t.riff(seq(HEAVY, '>F2W:6 >Gb2W:2 >F2W:4 >Db2W:4 | >F2W:6 >Gb2W:2 >Eb2W:4 F2x:2 -:2'), { bar: I + 28, vel: 1 }),
  ], { amp: AMPS.rhythm });
  t.bass('bass', t.riff(bassLine(seq(MARCH, MARCH, MARCH, MARCH_B, MARCH, MARCH, MARCH, MARCH_B, HEAVY, HEAVY, HEAVY, HEAVY, STOMP, STOMP, MARCH, MARCH_B, MARCH, MARCH_B, MARCH, MARCH, MARCH, 'F2m:1 F2m:1 Gb2m:2 Ab2m:2 Bb2m:2 B2m:2 Bb2m:2 Ab2m:2 Gb2m:2', HEAVY, '>F2W:6 >Gb2W:2 >F2W:4 >Db2W:4 | >F2W:6 >Gb2W:2 >Eb2W:4 F2x:2 -:2')), { bar: I, vel: 1 }), { drive: 4, sub: 0.4 });
  const phrygian = (s: string) => s.replace(/Gb4/g, 'Gb4');
  t.guitar('lead', [...t.riff(seq(phrygian(motif('F4')), motif('F4', 'answer').replace(/C#4/g, 'C4'), motif('F4'), motif('F4', 'answer').replace(/C#4/g, 'C4')), { bar: I + 8, vel: 0.95 }), ...t.riff(seq(motif('F4', 'high'), up8(motif('F4', 'answer').replace(/C#4/g, 'C4'))), { bar: I + 28, vel: 1 })], { amp: AMPS.lead, lead: true });
  t.guitar('escalation', t.riff(seq(...Array(32).fill('F2m:1 F2m:1 F2m:1 F2m:1 Gb2m:1 Gb2m:1 F2m:1 F2m:1 F2m:1 F2m:1 Eb2m:1 Eb2m:1 Db2m:1 Db2m:1 C2m:1 C2m:1')), { bar: I, vel: 0.85, transpose: 12 }), { amp: AMPS.lead, lead: true, gainDb: -6 });
  const A = { kick: 'x...x...x...x...', snare: '....X.......X...', hatOpen: 'x...x...x...x...', anvil: 'x.......x.......', chain: '..x.......x.....' };
  const AF = { kick: 'x...x...x...x.x.', snare: '....X.......X.X.', hatOpen: 'x...x...x.......', tomLo: '............x...', china: '..............x.' };
  const B = { slam: 'x.......x.......', kick: 'x..x..x.x..x..x.', snare: '....X.......X...', ride: 'x.x.x.x.x.x.x.x.', crash: 'x...............' };
  const BF = { slam: 'x.......x.......', kick: 'x..x..x.x..xxxxx', snare: '....X...X...X.X.', ride: 'x.x.x.x.x.x.....', china: '............x...' };
  const C = { slam: 'x...............', kick: 'x.......x.......', snare: '........X.......', crash: 'x...............', anvil: '....x.......x...' };
  const CF = { slam: 'x...........x...', kick: 'x.......x...xxxx', snare: '........X...X.X.', crash: 'x...........x...', anvil: '....x...........' };
  t.kit('drums', [...t.drums({ slam: '........x...x...', kick: '........x.x.x.x.', snare: '........X...X...', crash: '...............x' }, { bar: I - 1 }), ...bars(t, A, AF, I, 4), ...bars(t, A, AF, I + 4, 4), ...bars(t, B, BF, I + 8, 4), ...bars(t, B, BF, I + 12, 4), ...bars(t, C, CF, I + 16, 4), ...bars(t, A, AF, I + 20, 4), ...bars(t, B, BF, I + 24, 4), ...bars(t, B, BF, I + 28, 4)], { style: { kickTune: 0.95, kickClick: 1.2, drive: 0.5 } });
  const esk = { kick: 'xxxxxxxxxxxxxxxx', china: 'x.......x.......' };
  t.kit('escalation', [...bars(t, esk, { ...esk, snare: 'x.x.x.x.x.x.x.x.' }, I, 32)], { style: { kickClick: 1.3, drive: 0.5 }, gainDb: -4 });
  t.add('escalation', renderSawLead(synthOf(t, seq(...Array(4).fill('F5o:8 Gb5o:8 | F5o:8 Eb5o:4 Db5o:4')), I + 16, 0.8), t.length, { seed: 141, voices: 3, detune: 18, cutoff: 3000, resonance: 0.5, vibrato: 50 }), -13, 0.3);
  t.add('electro', drone(t.at(I + 32) - t.at(I), { seed: 142, freq: noteHz('F1'), cutoff: 260, wobble: 0.8, level: 0.6 }), -9, 0, t.at(I));
  t.add('electro', machinePulse(t.at(I + 32) - t.at(I), { seed: 143, rate: t.bpm / 60 / 2, freq: 140, q: 3, level: 0.6, duty: 0.45 }), -8, -0.3, t.at(I));
  t.add('electro', machinePulse(t.at(I + 32) - t.at(I), { seed: 144, rate: t.bpm / 60 * 2, freq: 2800, q: 10, level: 0.35, duty: 0.08 }), -14, 0.4, t.at(I));
  t.add('electro', riser(60 / t.bpm * 8, { seed: 145, freqFrom: 44, freqTo: 175, noise: 0.9 }), -8, 0, 0);
  t.add('drums', impact({ seed: 146, seconds: 2.4, subHz: 36, ring: 150 }), -5, 0, t.at(I));
  return t;
}

export function leviathan(): Track {
  const t = new Track({ id: 'boss-leviathan', title: 'Leviathan Battery', bpm: 120, introBars: 2, loopBars: 32, tailBars: 2, seed: 6201, targetLufs: -12.5 });
  t.stem('drums', STEMS.drums(-2)); t.stem('bass', STEMS.bass(-5)); t.stem('guitars', STEMS.guitars(2)); t.stem('lead', STEMS.lead(-2)); t.stem('electro', STEMS.electro(1, 0)); t.stem('escalation', STEMS.escalation(-6));
  const I = 2;
  const SURGE = '>E2M:2 E2m:1 E2m:1 >E2M:2 E2m:1 E2m:1 >G2P:2 >A2P:2 >B2P:2 >A2P:2';
  const SURGE_B = '>E2M:2 E2m:1 E2m:1 >E2M:2 E2m:1 E2m:1 >C3P:2 >B2P:2 >A2P:2 >G2P:2';
  const DIVE = '>E2W:4 >D2W:4 >C2W:4 >B1W:4 | >E2W:4 >G2W:4 >A2W:4 >B2W:4';
  const STOP = '>E2M:3 -:1 >E2M:3 -:1 >C2P:2 -:2 E2x:1 -:1 >G2P:2';
  t.guitar('guitars', [
    ...t.riff(seq(SURGE, SURGE, SURGE, SURGE_B, SURGE, SURGE, SURGE, SURGE_B), { bar: I, vel: 0.95 }),
    ...t.riff(seq(DIVE, DIVE, DIVE, DIVE), { bar: I + 8, vel: 1 }),
    ...t.riff(seq(STOP, STOP, STOP, '>E2M:3 -:1 >E2M:3 -:1 >G2P:2 >A2P:2 >B2P:2 >C3P:2'), { bar: I + 16, vel: 1 }),
    ...t.riff(seq(SURGE, SURGE_B, SURGE, SURGE_B, DIVE, DIVE), { bar: I + 20 }),
    ...t.riff(seq(DIVE, '>E2W:4 >D2W:4 >C2W:4 >B1W:4 | >E2W:4 >G2W:4 >A2W:4 E2x:2 -:2'), { bar: I + 28, vel: 1 }),
  ], { amp: AMPS.rhythm });
  t.bass('bass', t.riff(bassLine(seq(SURGE, SURGE, SURGE, SURGE_B, SURGE, SURGE, SURGE, SURGE_B, DIVE, DIVE, DIVE, DIVE, STOP, STOP, STOP, '>E2M:3 -:1 >E2M:3 -:1 >G2P:2 >A2P:2 >B2P:2 >C3P:2', SURGE, SURGE_B, SURGE, SURGE_B, DIVE, DIVE, DIVE, '>E2W:4 >D2W:4 >C2W:4 >B1W:4 | >E2W:4 >G2W:4 >A2W:4 E2x:2 -:2')), { bar: I, vel: 1 }), { drive: 3.6, sub: 0.45 });
  t.add('lead', renderBell(bellsOf(t, seq(motif('E4'), motif('E4', 'answer')), I + 8, 0.85, 2), t.length, { seed: 151, ratio: 2.0, index: 1.8, decay: 1.5 }), -6, -0.2);
  t.guitar('lead', [...t.riff(seq(motif('E4'), motif('E4', 'answer')), { bar: I + 12, vel: 0.95 }), ...t.riff(seq(motif('E4', 'high'), up8(motif('E4', 'answer'))), { bar: I + 28, vel: 1 })], { amp: AMPS.lead, lead: true });
  t.guitar('escalation', t.riff(seq(...Array(32).fill('E2m:1 E2m:1 E2m:1 E2m:1 G2m:1 G2m:1 E2m:1 E2m:1 A2m:1 A2m:1 E2m:1 E2m:1 B2m:1 B2m:1 A2m:1 G2m:1')), { bar: I, vel: 0.85, transpose: 12 }), { amp: AMPS.lead, lead: true, gainDb: -6 });
  const A = { kick: 'x.....x.x.....x.', snare: '....X.......X...', hatOpen: 'x...x...x...x...', pipe: '......x.........' };
  const AF = { kick: 'x.....x.x.....xx', snare: '....X.......X.XX', hatOpen: 'x...x...x.......', tomLo: '............x...' };
  const B = { slam: 'x...............', kick: 'x...x...x.x.x...', snare: '....X.......X...', ride: 'x.x.x.x.x.x.x.x.', crash: 'x...............' };
  const BF = { slam: 'x...............', kick: 'x...x...x.x.xxxx', snare: '....X...X...X.X.', ride: 'x.x.x.x.x.x.....', china: '............x...' };
  const C = { slam: 'x...........x...', kick: 'x...x...x...x...', snare: '........X.......', hatOpen: 'x...x...x...x...', pipe: 'x.......x.......' };
  const CF = { slam: 'x...........x...', kick: 'x...x...x...xxxx', snare: '........X...X.X.', hatOpen: 'x...x...x.......', crash: '............x...' };
  t.kit('drums', [...t.drums({ slam: '........x...x...', kick: '........x.x.x.x.', snare: '........X...X...', crash: '...............x' }, { bar: I - 1 }), ...bars(t, A, AF, I, 4), ...bars(t, A, AF, I + 4, 4), ...bars(t, B, BF, I + 8, 4), ...bars(t, B, BF, I + 12, 4), ...bars(t, C, CF, I + 16, 4), ...bars(t, A, AF, I + 20, 4), ...bars(t, B, BF, I + 24, 4), ...bars(t, B, BF, I + 28, 4)], { style: { kickTune: 0.92, kickClick: 1.1, drive: 0.5 } });
  const esk = { kick: 'xxxxxxxxxxxxxxxx', china: 'x.......x.......' };
  t.kit('escalation', bars(t, esk, { ...esk, snare: 'x.x.x.x.x.x.x.x.' }, I, 32), { style: { kickClick: 1.3, drive: 0.5 }, gainDb: -4 });
  t.add('electro', drone(t.at(I + 32) - t.at(I), { seed: 152, freq: noteHz('E1'), cutoff: 180, wobble: 1.2, level: 0.6 }), -9, 0, t.at(I));
  t.add('electro', machinePulse(t.at(I + 32) - t.at(I), { seed: 153, rate: t.bpm / 60 / 4, freq: 90, q: 2, level: 0.7, duty: 0.6 }), -8, -0.2, t.at(I));
  t.add('electro', renderPad([['E2', 0], ['C2', 8], ['D2', 16], ['B1', 24]].map(([n, b]) => ({ at: t.at(I + (b as number)), gate: t.barSamples * 8, freq: noteHz(n as string) * 2, vel: 0.6 })), t.length, { seed: 154, attack: 1.2, release: 2, cutoff: 1600, dark: true }), -11);
  t.add('electro', riser(60 / t.bpm * 8, { seed: 155, freqFrom: 41, freqTo: 165, noise: 0.95 }), -8, 0, 0);
  t.add('drums', impact({ seed: 156, seconds: 2.6, subHz: 32, ring: 130 }), -5, 0, t.at(I));
  return t;
}

export function titan(): Track {
  const t = new Track({ id: 'boss-titan', title: 'The Frost Titan', bpm: 150, introBars: 2, loopBars: 32, tailBars: 2, seed: 6301, targetLufs: -12.5 });
  t.stem('drums', STEMS.drums(-2)); t.stem('bass', STEMS.bass(-5)); t.stem('guitars', STEMS.guitars(2)); t.stem('lead', STEMS.lead(-2)); t.stem('electro', STEMS.electro(1, 0)); t.stem('escalation', STEMS.escalation(-6));
  const I = 2;
  const PICK = 'C#2m:1 C#2m:1 G#2m:1 C#2m:1 C#2m:1 A2m:1 C#2m:1 C#2m:1 >E2P:2 >D#2P:2 >C#2M:2 >B1M:2';
  const PICK_B = 'C#2m:1 C#2m:1 G#2m:1 C#2m:1 C#2m:1 A2m:1 C#2m:1 C#2m:1 >F#2P:2 >E2P:2 >D#2P:2 >B1M:2';
  const CALVE = '>C#2W:6 -:2 >A1W:6 -:2 | >E2W:6 -:2 >G#1W:4 C#2x:1 C#2x:1 -:2';
  const BREAK = '>C#2M:3 -:1 >C#2M:3 -:1 >A1M:2 -:2 C#2x:1 -:1 >E2P:2';
  t.guitar('guitars', [
    ...t.riff(seq(PICK, PICK, PICK, PICK_B, PICK, PICK, PICK, PICK_B), { bar: I, vel: 0.92 }),
    ...t.riff(seq(CALVE, CALVE, CALVE, CALVE), { bar: I + 8, vel: 1 }),
    ...t.riff(seq(BREAK, BREAK, BREAK, '>C#2M:3 -:1 >C#2M:3 -:1 >G#1M:2 >A1M:2 >B1M:2 >C#2M:2'), { bar: I + 16, vel: 1 }),
    ...t.riff(seq(PICK, PICK_B, PICK, PICK_B, PICK, PICK, PICK, 'C#2m:1 C#2m:1 >E2P:2 >F#2P:2 >G#2P:2 >A2P:2 >G#2P:2 >F#2P:2 >E2P:2'), { bar: I + 20 }),
    ...t.riff(seq(CALVE, '>C#2W:6 -:2 >A1W:6 -:2 | >E2W:6 -:2 >G#1W:4 C#2x:2 -:2'), { bar: I + 28, vel: 1 }),
  ], { amp: AMPS.rhythm });
  t.bass('bass', t.riff(bassLine(seq(PICK, PICK, PICK, PICK_B, PICK, PICK, PICK, PICK_B, CALVE, CALVE, CALVE, CALVE, BREAK, BREAK, BREAK, '>C#2M:3 -:1 >C#2M:3 -:1 >G#1M:2 >A1M:2 >B1M:2 >C#2M:2', PICK, PICK_B, PICK, PICK_B, PICK, PICK, PICK, 'C#2m:1 C#2m:1 E2m:2 F#2m:2 G#2m:2 A2m:2 G#2m:2 F#2m:2 E2m:2', CALVE, '>C#2W:6 -:2 >A1W:6 -:2 | >E2W:6 -:2 >G#1W:4 C#2x:2 -:2')), { bar: I, vel: 1 }), { drive: 3.4, sub: 0.35 });
  t.add('lead', renderBell(bellsOf(t, seq(motif('C#4'), motif('C#4', 'answer')), I + 8, 0.9, 2), t.length, { seed: 161, ratio: 3.5, index: 2.6, decay: 1.2 }), -5, -0.2);
  t.guitar('lead', [...t.riff(seq(motif('C#4'), motif('C#4', 'answer')), { bar: I + 12, vel: 0.95 }), ...t.riff(seq(motif('C#4', 'high'), up8(motif('C#4', 'answer'))), { bar: I + 28, vel: 1 })], { amp: AMPS.lead, lead: true });
  t.guitar('escalation', t.riff(seq(...Array(32).fill(PICK)), { bar: I, vel: 0.85, transpose: 12 }), { amp: AMPS.lead, lead: true, gainDb: -6 });
  const A = { kick: 'x.x.x.x.x.x.x.x.', snare: '....X.......X...', hat: 'xxxxxxxxxxxxxxxx', crash: 'x...............', click: '..x...x...x...x.' };
  const AF = { kick: 'x.x.x.x.xxxxxxxx', snare: '....X.......X.XX', hat: 'xxxxxxxxxxxx....', tomHi: '............x...', crash: '...............x' };
  const B = { slam: 'x.......x.......', kick: 'x.......x.......', snare: '....X.......X...', crash: 'x.......x.......', anvil: '......x.......x.' };
  const BF = { slam: 'x.......x.......', kick: 'x.......x...xxxx', snare: '....X.......X.X.', crash: 'x.......x...x...', china: '............x...' };
  const C = { slam: 'x...........x...', kick: 'x...x...x...x...', snare: '........X.......', hatOpen: 'x...x...x...x...', anvil: 'x.......x.......' };
  const CF = { slam: 'x...........x...', kick: 'x...x...x...xxxx', snare: '........X...X.X.', hatOpen: 'x...x...x.......', crash: '............x...' };
  t.kit('drums', [...t.drums({ kick: '........x.x.x.x.', snare: '........X...X...', tomLo: '............x.x.', crash: '...............x' }, { bar: I - 1 }), ...bars(t, A, AF, I, 4), ...bars(t, A, AF, I + 4, 4), ...bars(t, B, BF, I + 8, 4), ...bars(t, B, BF, I + 12, 4), ...bars(t, C, CF, I + 16, 4), ...bars(t, A, AF, I + 20, 4), ...bars(t, A, AF, I + 24, 4), ...bars(t, B, BF, I + 28, 4)], { style: { kickClick: 1.3, drive: 0.4, snareTune: 1.08 } });
  const esk = { kick: 'xxxxxxxxxxxxxxxx', china: 'x.......x.......' };
  t.kit('escalation', bars(t, esk, { ...esk, snare: 'x.x.x.x.x.x.x.x.' }, I, 32), { style: { kickClick: 1.3, drive: 0.5 }, gainDb: -4 });
  t.add('electro', glitchSeq(t.at(I + 32) - t.at(I), { seed: 171, stepSamples: Math.round(t.stepSamples), density: 0.2, baseHz: 1109 }), -13, 0.4, t.at(I));
  t.add('electro', renderPad([['C#3', 0], ['A2', 8], ['E3', 16], ['G#2', 24]].map(([n, b]) => ({ at: t.at(I + (b as number)), gate: t.barSamples * 8, freq: noteHz(n as string), vel: 0.6 })), t.length, { seed: 172, attack: 1.2, release: 2, cutoff: 2800 }), -11);
  t.add('electro', drone(t.at(I + 32) - t.at(I), { seed: 173, freq: noteHz('C#1'), cutoff: 160, wobble: 0.4, level: 0.45 }), -11, 0, t.at(I));
  t.add('electro', riser(60 / t.bpm * 8, { seed: 174, freqFrom: 69, freqTo: 277, noise: 0.6 }), -8, 0, 0);
  t.add('drums', impact({ seed: 175, seconds: 2.4, subHz: 38, ring: 180 }), -5, 0, t.at(I));
  return t;
}

export function rustcrown(): Track {
  const t = new Track({ id: 'boss-rustcrown', title: 'Rustcrown (Corvin)', bpm: 160, introBars: 2, loopBars: 32, tailBars: 2, seed: 6401, targetLufs: -12.5 });
  t.stem('drums', STEMS.drums(-2)); t.stem('bass', STEMS.bass(-5)); t.stem('guitars', STEMS.guitars(2)); t.stem('lead', STEMS.lead(-2)); t.stem('electro', STEMS.electro(1, 0)); t.stem('escalation', STEMS.escalation(-6));
  const I = 2;
  // The main-theme riff, corrupted: the b2 (C) and the tritone (F) in place of the D/C# answers.
  const CORRUPT = 'B1m:2 B1m:2 B1m:1 B1m:1 >C2P:2 B1m:2 B1m:2 >F2P:2 B1m:1 B1m:1';
  const CORRUPT_B = 'B1m:2 B1m:2 B1m:1 B1m:1 >F2P:2 B1m:2 >E2P:2 >C2P:2 B1x:1 B1x:1';
  const DUEL = 'B1m:1 B1m:1 B1m:1 B1m:1 >C2P:1 B1m:1 B1m:1 B1m:1 >F2P:1 B1m:1 B1m:1 B1m:1 >E2P:1 B1m:1 >C2P:1 B1m:1';
  const CROWN = '>B1W:8 >F2W:8 | >C2W:8 >E2W:4 >B1W:4';
  const BREAK = '>B1M:3 -:1 >B1M:3 -:1 >B1M:2 -:2 B1x:1 -:1 >F2P:2';
  t.guitar('guitars', [
    ...t.riff(seq(CORRUPT, CORRUPT, CORRUPT, CORRUPT_B, CORRUPT, CORRUPT, CORRUPT, CORRUPT_B), { bar: I }),
    ...t.riff(seq(DUEL, DUEL, DUEL, CORRUPT_B, DUEL, DUEL, DUEL, CORRUPT_B), { bar: I + 8, vel: 0.9 }),
    ...t.riff(seq(BREAK, BREAK, BREAK, '>B1M:3 -:1 >B1M:3 -:1 >G2P:2 >F2P:2 >E2P:2 >C2P:2'), { bar: I + 16, vel: 1 }),
    ...t.riff(seq(CORRUPT, CORRUPT_B, DUEL, DUEL, CORRUPT, CORRUPT_B, DUEL, 'B1m:1 B1m:1 >C2P:2 >D2P:2 >E2P:2 >F2P:2 >E2P:2 >D2P:2 >C2P:2'), { bar: I + 20 }),
    ...t.riff(seq(CROWN, CROWN.replace('>B1W:4', '>B1W:2 B1x:1 B1x:1')), { bar: I + 28, vel: 1 }),
  ], { amp: AMPS.rhythm });
  t.bass('bass', [...t.riff(bassLine(seq(CORRUPT, CORRUPT, CORRUPT, CORRUPT_B, CORRUPT, CORRUPT, CORRUPT, CORRUPT_B, DUEL, DUEL, DUEL, CORRUPT_B, DUEL, DUEL, DUEL, CORRUPT_B, BREAK, BREAK, BREAK, '>B1M:3 -:1 >B1M:3 -:1 >G2P:2 >F2P:2 >E2P:2 >C2P:2', CORRUPT, CORRUPT_B, DUEL, DUEL, CORRUPT, CORRUPT_B, DUEL, 'B1m:1 B1m:1 C2m:2 D2m:2 E2m:2 F2m:2 E2m:2 D2m:2 C2m:2')), { bar: I, vel: 0.95 }), ...t.riff('B1o:8 F2o:8 | C2o:8 E2o:4 B1o:4 | B1o:8 F2o:8 | C2o:8 E2o:4 B1o:2 B1x:1 B1x:1', { bar: I + 28, vel: 1 })], { drive: 3.8, sub: 0.35 });
  const corrupted = 'B3o:2 B3o:2 D4o:2 C4o:2 B3o:2 -:2 F4o:2 B3o:2 | ~F3o:8 E3o:2 F3o:2 G3o:2 F3o:2';
  const corruptedHigh = up8(corrupted);
  t.guitar('lead', [...t.riff(seq(corrupted, motif('B3', 'answer').replace(/C#4/g, 'C4').replace(/F#4/g, 'F4'), corrupted, motif('B3', 'answer').replace(/C#4/g, 'C4').replace(/F#4/g, 'F4')), { bar: I + 8, vel: 0.95 }), ...t.riff(seq(corruptedHigh, up8(motif('B3', 'answer'))), { bar: I + 28, vel: 1 })], { amp: AMPS.lead, lead: true });
  // Harmony a tritone below in the hook: the mirror.
  t.guitar('lead', t.riff(corruptedHigh, { bar: I + 28, vel: 0.75, transpose: -6 }), { amp: AMPS.lead, lead: true, gainDb: -8 });
  t.guitar('escalation', t.riff(seq(...Array(32).fill(DUEL)), { bar: I, vel: 0.85, transpose: 12 }), { amp: AMPS.lead, lead: true, gainDb: -6 });
  const A = { kick: 'x.xxx.xxx.xxx.xx', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.', crash: 'x...............' };
  const AF = { kick: 'x.xxx.xxxxxxxxxx', snare: '....X.......X.XX', hat: 'x.x.x.x.x.x.....', tomHi: '............x...', china: '...............x' };
  const B = { kick: 'xxxxxxxxxxxxxxxx', snare: '....X.......X...', ride: 'x.x.x.x.x.x.x.x.', crash: 'x...............' };
  const BF = { kick: 'xxxxxxxxxxxxxxxx', snare: '....X...X.X.X.XX', ride: 'x.x.x.x.x.x.....', china: '............x...' };
  const C = { slam: 'x...........x...', kick: 'x...x...x...x...', snare: '........X.......', hatOpen: 'x...x...x...x...', china: 'x...............' };
  const CF = { slam: 'x...........x...', kick: 'x...x...x...xxxx', snare: '........X...X.X.', hatOpen: 'x...x...x.......', crash: '............x...' };
  const K = { kick: 'x.x.x.x.x.x.x.x.', snare: '....X.......X...', crash: 'x...............', ride: 'x.x.x.x.x.x.x.x.' };
  const KF = { kick: 'x.x.x.x.xx.xx.xx', snare: '....X...X...X.XX', crash: 'x.......x.......', china: '..............x.' };
  t.kit('drums', [...t.drums({ kick: '........x.x.x.x.', snare: '........X...X...', tomLo: '............x.x.', crash: '...............x' }, { bar: I - 1 }), ...bars(t, A, AF, I, 4), ...bars(t, A, AF, I + 4, 4), ...bars(t, B, BF, I + 8, 4), ...bars(t, B, BF, I + 12, 4), ...bars(t, C, CF, I + 16, 4), ...bars(t, A, AF, I + 20, 4), ...bars(t, B, BF, I + 24, 4), ...bars(t, K, KF, I + 28, 4)], { style: { kickClick: 1.3, drive: 0.45 } });
  // The core phase: a blast layer and a choir-like pad over the whole loop.
  const esk = { kick: 'xxxxxxxxxxxxxxxx', snare: 'x.x.x.x.x.x.x.x.', china: 'x...x...x...x...' };
  t.kit('escalation', bars(t, esk, esk, I, 32), { style: { kickClick: 1.3, drive: 0.5 }, gainDb: -5 });
  t.add('escalation', renderPad([['B2', 0], ['F2', 8], ['C3', 16], ['E2', 24]].map(([n, b]) => ({ at: t.at(I + (b as number)), gate: t.barSamples * 8, freq: noteHz(n as string) * 2, vel: 0.7 })), t.length, { seed: 181, attack: 0.8, release: 1.5, cutoff: 3200 }), -10);
  t.add('electro', drone(t.at(I + 32) - t.at(I), { seed: 182, freq: noteHz('B0'), cutoff: 240, wobble: 0.9, level: 0.6 }), -9, 0, t.at(I));
  t.add('electro', glitchSeq(t.at(I + 32) - t.at(I), { seed: 183, stepSamples: Math.round(t.stepSamples), density: 0.22, baseHz: 247 }), -11, -0.3, t.at(I));
  t.add('electro', machinePulse(t.at(I + 32) - t.at(I), { seed: 184, rate: t.bpm / 60 * 2, freq: 1900, q: 9, level: 0.35, duty: 0.08 }), -13, 0.4, t.at(I));
  t.add('electro', riser(60 / t.bpm * 8, { seed: 185, freqFrom: 62, freqTo: 247, noise: 0.7 }), -8, 0, 0);
  t.add('drums', impact({ seed: 186, seconds: 2.4, subHz: 38, ring: 165 }), -5, 0, t.at(I));
  return t;
}

export function fleetLaunch(): Track {
  const t = new Track({ id: 'fleet-launch', title: 'Council of Embers', bpm: 148, introBars: 2, loopBars: 32, tailBars: 2, seed: 6501, targetLufs: -12.5 });
  t.stem('drums', STEMS.drums(-2)); t.stem('bass', STEMS.bass(-5)); t.stem('guitars', STEMS.guitars(2)); t.stem('lead', STEMS.lead(-2)); t.stem('electro', STEMS.electro(1, 0)); t.stem('escalation', STEMS.escalation(-5));
  const I = 2;
  const HOLD = 'E2m:2 E2m:1 E2m:1 >E2P:2 E2m:1 E2m:1 >G2P:2 >A2P:2 >B2P:2 >A2P:2';
  const HOLD_B = 'E2m:2 E2m:1 E2m:1 >E2P:2 E2m:1 E2m:1 >C3P:2 >B2P:2 >A2P:2 >G2P:2';
  const HYMN = '>E2W:8 >C2W:8 | >G2W:8 >D2W:4 >B1W:4';
  const HYMN_B = '>E2W:8 >C2W:8 | >G2W:8 >D2W:4 E2x:2 -:2';
  const RUSH = 'E2m:1 E2m:1 E2m:1 E2m:1 >G2P:1 E2m:1 E2m:1 E2m:1 >A2P:1 E2m:1 E2m:1 E2m:1 >B2P:1 E2m:1 >A2P:1 >G2P:1';
  t.guitar('guitars', [
    ...t.riff(seq(HOLD, HOLD, HOLD, HOLD_B, HOLD, HOLD, HOLD, HOLD_B), { bar: I }),
    ...t.riff(seq(HYMN, HYMN, HYMN, HYMN_B), { bar: I + 8, vel: 1 }),
    ...t.riff(seq(RUSH, RUSH, RUSH, HOLD_B, RUSH, RUSH, RUSH, 'E2m:1 E2m:1 >G2P:2 >A2P:2 >B2P:2 >C3P:2 >B2P:2 >A2P:2 >G2P:2'), { bar: I + 16 }),
    ...t.riff(seq(HYMN, HYMN, HYMN, HYMN_B), { bar: I + 24, vel: 1 }),
  ], { amp: AMPS.rhythm });
  t.bass('bass', t.riff(bassLine(seq(HOLD, HOLD, HOLD, HOLD_B, HOLD, HOLD, HOLD, HOLD_B, HYMN, HYMN, HYMN, HYMN_B, RUSH, RUSH, RUSH, HOLD_B, RUSH, RUSH, RUSH, 'E2m:1 E2m:1 G2m:2 A2m:2 B2m:2 C3m:2 B2m:2 A2m:2 G2m:2', HYMN, HYMN, HYMN, HYMN_B)), { bar: I, vel: 0.95 }), { drive: 3.6, sub: 0.4 });
  t.guitar('lead', [...t.riff(seq(motif('E4'), motif('E4', 'answer'), motif('E4'), motif('E4', 'answer')), { bar: I + 8, vel: 0.95 }), ...t.riff(seq(motif('E4', 'major'), up8(motif('E4', 'answer')), motif('E4', 'major').replace(/3o/g, '4o').replace(/4o/g, '5o'), up8(motif('E4', 'answer'))), { bar: I + 24, vel: 1 })], { amp: AMPS.lead, lead: true });
  // Stage 3 (escalation): brass-like saw stacks on the hymn and a blast layer.
  const brassIn = synthOf(t, seq('E4o:8 C4o:8 | G4o:8 D4o:4 B3o:4', 'E4o:8 C4o:8 | G4o:8 D4o:4 E4o:4', 'E4o:8 C4o:8 | G4o:8 D4o:4 B3o:4', 'E4o:8 C4o:8 | G4o:8 D4o:4 E4o:4'), I + 8, 0.85);
  t.add('escalation', renderSawLead([...brassIn, ...brassIn.map(e => ({ ...e, at: e.at + t.barSamples * 16 }))], t.length, { seed: 191, voices: 7, detune: 9, cutoff: 2200, resonance: 0.2, drive: 1.2 }), -10, 0);
  const esk = { kick: 'xxxxxxxxxxxxxxxx', china: 'x.......x.......' };
  t.kit('escalation', bars(t, esk, { ...esk, snare: 'x.x.x.x.x.x.x.x.' }, I, 32), { style: { kickClick: 1.3, drive: 0.5 }, gainDb: -4 });
  const A = { kick: 'x..x..x.x..x..x.', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.', crash: 'x...............' };
  const AF = { kick: 'x..x..x.x..xxxxx', snare: '....X.......X.XX', hat: 'x.x.x.x.x.x.....', tomHi: '............x...', crash: '...............x' };
  const B = { kick: 'x...x...x.x.x...', snare: '....X.......X...', crash: 'x.......x.......', ride: 'x.x.x.x.x.x.x.x.' };
  const BF = { kick: 'x...x...x.x.xxxx', snare: '....X...X...X.XX', crash: 'x.......x...x...', china: '............x...' };
  const D = { kick: 'xxxxxxxxxxxxxxxx', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.', ride: 'x...x...x...x...' };
  const DF = { kick: 'xxxxxxxxxxxxxxxx', snare: '....X...X.X.X.XX', hat: 'x.x.x.x.x.x.....', crash: '..............x.' };
  t.kit('drums', [...t.drums({ kick: '........x.x.x.x.', snare: '........X...X...', tomLo: '............x.x.', crash: '...............x' }, { bar: I - 1 }), ...bars(t, A, AF, I, 4), ...bars(t, A, AF, I + 4, 4), ...bars(t, B, BF, I + 8, 4), ...bars(t, B, BF, I + 12, 4), ...bars(t, D, DF, I + 16, 4), ...bars(t, D, DF, I + 20, 4), ...bars(t, B, BF, I + 24, 4), ...bars(t, B, BF, I + 28, 4)], { style: { kickClick: 1.2, drive: 0.4 } });
  t.add('electro', renderPad([['E2', 0], ['C2', 8], ['G2', 16], ['D2', 24]].map(([n, b]) => ({ at: t.at(I + (b as number)), gate: t.barSamples * 8, freq: noteHz(n as string) * 2, vel: 0.6 })), t.length, { seed: 192, attack: 1, release: 2, cutoff: 2600 }), -10);
  t.add('electro', machinePulse(t.at(I + 32) - t.at(I), { seed: 193, rate: t.bpm / 60, freq: 3200, q: 10, level: 0.3, duty: 0.08 }), -14, 0.4, t.at(I));
  t.add('electro', riser(60 / t.bpm * 8, { seed: 194, freqFrom: 82, freqTo: 330, noise: 0.6 }), -8, 0, 0);
  void transposeRiff; void renderPluck; void machinePulse;
  return t;
}
