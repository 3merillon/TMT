/**
 * Verdant Cradle (temperate machinery): propulsive groove. Combat "Relay Drive" in E minor at 158 BPM; exploration
 * "Lamp Hill" at 118 BPM. Layers: 0 drums+bass(+atmo), 1 guitars+electro, 2 lead, 3 escalation (double-kick riff).
 */
import { Track, seq } from '../sequencer';
import { AMPS } from '../instruments/guitar';
import { machinePulse, riser, renderPluck, renderPad, drone, glitchSeq, renderSawLead } from '../instruments/synth';
import { noteHz } from '../dsp/core';
import { STEMS, bars, motif, bassLine } from './shared';

export function combat(): Track {
  const t = new Track({ id: 'cradle-combat', title: 'Relay Drive', bpm: 158, introBars: 2, loopBars: 32, tailBars: 2, seed: 4101, targetLufs: -12.5 });
  t.stem('drums', STEMS.drums(-2)); t.stem('bass', STEMS.bass(-5)); t.stem('guitars', STEMS.guitars(2)); t.stem('lead', STEMS.lead(-2)); t.stem('electro', STEMS.electro(2)); t.stem('escalation', STEMS.escalation(-7));
  const I = 2;
  // Riffs ------------------------------------------------------------------------------------------------------------------
  const GALLOP = 'E2m:2 E2m:1 E2m:1 E2m:2 E2m:1 E2m:1 >G2P:2 E2m:1 E2m:1 >A2P:2 E2m:1 E2m:1';
  const GALLOP_B = 'E2m:2 E2m:1 E2m:1 >B1M:2 E2m:1 E2m:1 >D2P:2 E2m:1 E2m:1 >C2P:2 >B1M:2';
  const OPEN = '>E2P:4 >G2P:2 >A2P:2 >E2P:4 >D2P:2 >C2P:2';
  const OPEN_B = '>E2P:4 >G2P:2 >A2P:2 >B2P:2 >A2P:2 >G2P:2 >F#2P:2';
  const BREAK = '>E2M:3 -:1 >E2M:3 -:1 >B1M:2 -:2 E2x:1 -:1 >G2P:2';
  const BREAK_B = '>E2M:3 -:1 >E2M:3 -:1 >C2P:2 >B1M:2 >A1M:2 >G1M:2';
  const DRIVE = 'E2m:1 E2m:1 E2m:1 E2m:1 >G2P:1 E2m:1 E2m:1 E2m:1 >A2P:1 E2m:1 E2m:1 E2m:1 >B2P:1 E2m:1 >A2P:1 >G2P:1';
  const g = [
    ...t.riff(seq(GALLOP, GALLOP, GALLOP, GALLOP_B, GALLOP, GALLOP, GALLOP, GALLOP_B), { bar: I }),
    ...t.riff(seq(OPEN, OPEN_B, OPEN, OPEN_B, OPEN, OPEN_B, OPEN, 'E2P:4 D2P:4 C2P:4 B1M:2 B1x:1 B1x:1'), { bar: I + 8, vel: 1 }),
    ...t.riff(seq(BREAK, BREAK, BREAK, BREAK_B), { bar: I + 16, vel: 1 }),
    ...t.riff(seq(GALLOP, GALLOP_B, GALLOP, GALLOP_B, DRIVE, DRIVE, DRIVE, 'E2m:1 E2m:1 >G2P:2 >A2P:2 >B2P:2 >C3P:2 >B2P:2 >A2P:2 >G2P:2'), { bar: I + 20 }),
    ...t.riff(seq(OPEN, OPEN_B, OPEN, 'E2W:4 G2W:4 A2W:4 B2W:2 E2x:1 E2x:1'), { bar: I + 28, vel: 1 }),
  ];
  t.guitar('guitars', g, { amp: AMPS.rhythm });
  // The escalation layer: an octave-up riff doubling with double-kick, present only at top intensity.
  const esc = t.riff(seq(DRIVE, DRIVE, DRIVE, DRIVE, DRIVE, DRIVE, DRIVE, DRIVE, DRIVE, DRIVE, DRIVE, DRIVE, DRIVE, DRIVE, DRIVE, DRIVE), { bar: I, vel: 0.85, transpose: 12 });
  t.guitar('escalation', [...esc, ...t.riff(seq(DRIVE, DRIVE, DRIVE, DRIVE, DRIVE, DRIVE, DRIVE, DRIVE, DRIVE, DRIVE, DRIVE, DRIVE, DRIVE, DRIVE, DRIVE, DRIVE), { bar: I + 16, vel: 0.85, transpose: 12 })], { amp: AMPS.lead, lead: true, gainDb: -6 });
  // Bass --------------------------------------------------------------------------------------------------------------------
  const b = [
    ...t.riff(bassLine(seq(GALLOP, GALLOP, GALLOP, GALLOP_B, GALLOP, GALLOP, GALLOP, GALLOP_B)), { bar: I, vel: 0.95 }),
    ...t.riff('E2o:4 G2o:2 A2o:2 E2o:4 D2o:2 C2o:2 | E2o:4 G2o:2 A2o:2 B2o:2 A2o:2 G2o:2 F#2o:2 | E2o:4 G2o:2 A2o:2 E2o:4 D2o:2 C2o:2 | E2o:4 G2o:2 A2o:2 B2o:2 A2o:2 G2o:2 F#2o:2 | E2m:2 E2m:2 G2o:2 A2o:2 E2m:2 E2m:2 D2o:2 C2o:2 | E2m:2 E2m:2 G2o:2 A2o:2 B2o:2 A2o:2 G2o:2 F#2o:2 | E2o:4 G2o:2 A2o:2 E2o:4 D2o:2 C2o:2 | E2o:4 D2o:4 C2o:4 B1o:2 B1x:1 B1x:1', { bar: I + 8, vel: 1 }),
    ...t.riff(bassLine(seq(BREAK, BREAK, BREAK, BREAK_B)), { bar: I + 16, vel: 1 }),
    ...t.riff(bassLine(seq(GALLOP, GALLOP_B, GALLOP, GALLOP_B, DRIVE, DRIVE, DRIVE, 'E2m:1 E2m:1 G2m:2 A2m:2 B2m:2 C3m:2 B2m:2 A2m:2 G2m:2')), { bar: I + 20, vel: 0.95 }),
    ...t.riff('E2o:4 G2o:2 A2o:2 E2o:4 D2o:2 C2o:2 | E2o:4 G2o:2 A2o:2 B2o:2 A2o:2 G2o:2 F#2o:2 | E2o:4 G2o:2 A2o:2 E2o:4 D2o:2 C2o:2 | E2o:4 G2o:4 A2o:4 B2o:2 E2x:1 E2x:1', { bar: I + 28, vel: 1 }),
  ];
  t.bass('bass', b, { drive: 3.6, sub: 0.35 });
  // Lead: the motif in E minor over the open section, the fast variant in the drive -------------------------------------------
  const lead = [
    ...t.riff(seq(motif('E4'), motif('E4', 'answer'), motif('E4'), motif('E4', 'answer')), { bar: I + 8, vel: 0.95 }),
    ...t.riff(seq(motif('E4', 'fast'), motif('E4', 'fast'), motif('E4', 'high'), motif('E4', 'answer').replace(/(\d)o/g, (_, d) => `${Number(d) + 1}o`)), { bar: I + 24, vel: 0.95 }),
  ];
  t.guitar('lead', lead, { amp: AMPS.lead, lead: true });
  // Drums -------------------------------------------------------------------------------------------------------------------
  const A = { kick: 'x.xxx.xxx.xxx.xx', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.', crash: 'x...............' };
  const AF = { kick: 'x.xxx.xxx.xxx.xx', snare: '....X.......X.XX', hat: 'x.x.x.x.x.x.x...', tomHi: '............x...', tomMid: '.............x..', crash: '...............x' };
  const B = { kick: 'x...x.x.x...x.x.', snare: '....X.......X...', ride: 'x.x.x.x.x.x.x.x.', crash: 'x...............' };
  const BF = { kick: 'x...x.x.x.xxxxxx', snare: '....X.....X.X.XX', ride: 'x.x.x.x.x.x.....', china: '............x...' };
  const C = { slam: 'x...........x...', kick: 'x...x...x...x...', snare: '........X.......', hatOpen: 'x...x...x...x...', china: 'x...............' };
  const CF = { slam: 'x...........x...', kick: 'x...x...x...xxxx', snare: '........X...X.X.', hatOpen: 'x...x...x.......', crash: '............x...' };
  const D = { kick: 'xxxxxxxxxxxxxxxx', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.', ride: 'x...x...x...x...' };
  const DF = { kick: 'xxxxxxxxxxxxxxxx', snare: '....X...X.X.X.XX', hat: 'x.x.x.x.x.x.....', crash: '..............x.' };
  const E = { kick: 'x.x.x.x.x.x.x.x.', snare: '....X.......X...', crash: 'x...............', ride: 'x.x.x.x.x.x.x.x.' };
  const EF = { kick: 'x.x.x.x.xx.xx.xx', snare: '....X...X...X.XX', crash: 'x.......x.......', china: '..............x.' };
  const hits = [
    ...t.drums({ kick: '........x.x.x.x.', snare: '........X...X...', tomLo: '............x.x.', crash: '...............x' }, { bar: I - 1 }),
    ...bars(t, A, AF, I, 4), ...bars(t, A, AF, I + 4, 4),
    ...bars(t, B, BF, I + 8, 4), ...bars(t, B, BF, I + 12, 4),
    ...bars(t, C, CF, I + 16, 4),
    ...bars(t, A, AF, I + 20, 4), ...bars(t, D, DF, I + 24, 4),
    ...bars(t, E, EF, I + 28, 4),
  ];
  t.kit('drums', hits, { style: { kickClick: 1.2, drive: 0.4 } });
  // Escalation drums: a double-kick/blast layer that stacks over the base kit (same seam, same grid).
  const esk = { kick: 'xxxxxxxxxxxxxxxx', china: 'x.......x.......' };
  t.kit('escalation', [...bars(t, esk, { ...esk, snare: 'x.x.x.x.x.x.x.x.' }, I, 16), ...bars(t, esk, { ...esk, snare: 'x.x.x.x.x.x.x.x.' }, I + 20, 12)], { style: { kickClick: 1.3, drive: 0.5 }, gainDb: -4 });
  // Electro: machine pulses in A, an aggressive snarl-bass answer in B, glitches in C, siren-ish lead in D ------------------
  t.add('electro', machinePulse(t.at(I + 8) - t.at(I), { seed: 41, rate: t.bpm / 60 * 2, freq: 2600, q: 9, level: 0.45 }), -8, 0.35, t.at(I));
  t.add('electro', machinePulse(t.at(I + 8) - t.at(I), { seed: 42, rate: t.bpm / 60, freq: 420, q: 5, level: 0.6, duty: 0.25 }), -6, -0.4, t.at(I));
  const snarlPattern = 'E1:2 -:2 E1:1 E1:1 -:2 G1:2 -:2 A1:2 B1:2';
  const snarl = t.riff(seq(...Array(8).fill(snarlPattern)), { bar: I + 8, vel: 0.9 }).map(e => ({ at: e.at, gate: e.gate, freq: e.freq, vel: e.vel, accent: e.vel > 0.9 }));
  t.snarl('electro', snarl, { gainDb: -4, resonance: 0.6, drive: 2.8 });
  t.add('electro', glitchSeq(t.at(I + 20) - t.at(I + 16), { seed: 43, stepSamples: Math.round(t.stepSamples), density: 0.5, baseHz: 330 }), -8, 0.2, t.at(I + 16));
  const siren = t.riff('E5o:4 B4o:4 E5o:4 G5o:4 | F#5o:8 ~E5o:8', { bar: I + 24 }).map(e => ({ at: e.at, gate: e.gate, freq: e.freq, vel: 0.8 }));
  t.add('electro', renderSawLead([...siren, ...siren.map(e => ({ ...e, at: e.at + t.barSamples * 2 }))], t.length, { seed: 44, voices: 3, detune: 14, cutoff: 3200, resonance: 0.45, vibrato: 30 }), -12, 0.3);
  t.add('electro', riser(60 / t.bpm * 4, { seed: 45, freqFrom: 82, freqTo: 330, noise: 0.75 }), -10, 0, t.at(I + 27));
  // Intro: pulse + riser into the downbeat.
  t.add('electro', riser(60 / t.bpm * 8, { seed: 46, freqFrom: 82, freqTo: 330, noise: 0.6 }), -8, 0, 0);
  t.add('electro', drone(t.at(I), { seed: 47, freq: noteHz('E1'), cutoff: 400, wobble: 0.5, level: 0.5 }), -8);
  return t;
}

export function explore(): Track {
  const t = new Track({ id: 'cradle-explore', title: 'Lamp Hill', bpm: 118, introBars: 2, loopBars: 32, tailBars: 2, seed: 4102, targetLufs: -16 });
  t.stem('atmo', STEMS.atmo(-2)); t.stem('drums', STEMS.drums(-6)); t.stem('bass', STEMS.bass(-8)); t.stem('guitars', STEMS.guitars(-4, 1)); t.stem('lead', STEMS.lead(-6, 2));
  const I = 2;
  // A sparse, patient groove: muted gallop fragments with gaps, a crunch guitar on the chords, bells on the motif.
  const PULSE = 'E2m:1 -:1 E2m:1 -:1 E2m:2 -:2 E2m:1 -:1 >G2m:2 -:2 E2m:1 -:1';
  const PULSE_B = 'E2m:1 -:1 E2m:1 -:1 >B1m:2 -:2 E2m:1 -:1 >D2m:2 >C2m:2 >B1m:2';
  const CHORDS = '>E2P:8 >C2P:8 | >D2P:8 >B1M:6 B1x:1 B1x:1';
  t.guitar('guitars', [
    ...t.riff(seq(PULSE, PULSE, PULSE, PULSE_B, PULSE, PULSE, PULSE, PULSE_B), { bar: I, vel: 0.75 }),
    ...t.riff(seq(CHORDS, CHORDS, CHORDS, CHORDS), { bar: I + 16, vel: 0.8, gateScale: 0.97 }),
    ...t.riff(seq(PULSE, PULSE, PULSE, PULSE_B, PULSE, PULSE_B, PULSE, PULSE_B), { bar: I + 24, vel: 0.8 }),
  ], { amp: AMPS.crunch });
  t.bass('bass', t.riff(seq(bassLine(seq(PULSE, PULSE, PULSE, PULSE_B, PULSE, PULSE, PULSE, PULSE_B)), 'E2o:8 C2o:8 | D2o:8 B1o:6 B1x:1 B1x:1 | E2o:8 C2o:8 | D2o:8 B1o:6 B1x:1 B1x:1 | E2o:8 C2o:8 | D2o:8 B1o:6 B1x:1 B1x:1 | E2o:8 C2o:8 | D2o:8 B1o:6 B1x:1 B1x:1', bassLine(seq(PULSE, PULSE, PULSE, PULSE_B, PULSE, PULSE_B, PULSE, PULSE_B))), { bar: I, vel: 0.85 }), { drive: 2.5, sub: 0.4 });
  // Drums: a slow machine groove, mostly kick/rim/hat with the snare arriving in the chord section.
  const A = { kick: 'x.......x.x.....', rim: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.' };
  const AF = { kick: 'x.......x.x...x.', rim: '....x.......x.x.', hat: 'x.x.x.x.x.x.x...', tomLo: '..............x.' };
  const B = { kick: 'x...x...x.x.....', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.', crash: 'x...............' };
  const BF = { kick: 'x...x...x.x.x.x.', snare: '....X.......X.xx', hat: 'x.x.x.x.x.x.....', tomHi: '............x...', tomLo: '..............x.' };
  t.kit('drums', [...bars(t, A, AF, I, 8), ...bars(t, A, AF, I + 8, 8), ...bars(t, B, BF, I + 16, 8), ...bars(t, A, AF, I + 24, 8)], { style: { kickClick: 0.9, drive: 0.25 } });
  // Lead: bells carry the motif, sparse; a quiet lead guitar answers in the second half.
  const bell = t.riff(seq(motif('E4'), motif('E4', 'answer')), { bar: I + 4, vel: 0.7 }).map(e => ({ at: e.at, gate: e.gate, freq: e.freq * 2, vel: e.vel }));
  t.add('lead', renderPluck(bell, t.length, { seed: 51, cutoff: 3800, crush: 10, width: 0.2, decay: 0.45 }), -6, -0.2);
  t.add('lead', renderPluck(bell.map(e => ({ ...e, at: e.at + t.barSamples * 16 })), t.length, { seed: 52, cutoff: 4200, crush: 10, width: 0.2, decay: 0.45 }), -6, 0.2);
  t.guitar('lead', t.riff(seq(motif('E4'), motif('E4', 'answer')), { bar: I + 20, vel: 0.8 }), { amp: AMPS.lead, lead: true, gainDb: -4 });
  // Atmosphere: machinery pulses, a slow pad, distant machine ticks.
  t.add('atmo', drone(t.length, { seed: 53, freq: noteHz('E1'), cutoff: 220, wobble: 0.6, level: 0.5 }), -9);
  t.add('atmo', machinePulse(t.length, { seed: 54, rate: t.bpm / 60 / 2, freq: 1500, q: 12, level: 0.3 }), -14, 0.4);
  t.add('atmo', machinePulse(t.length, { seed: 55, rate: t.bpm / 60 / 4, freq: 240, q: 5, level: 0.5, duty: 0.4 }), -12, -0.4);
  const pad = ['E2', 'C2', 'D2', 'B1', 'E2', 'C2', 'D2', 'B1'].map((n, i) => ({ at: t.at(I + 16 + i * 2), gate: t.barSamples * 2, freq: noteHz(n) * 2, vel: 0.7 }));
  t.add('atmo', renderPad(pad, t.length, { seed: 56, attack: 0.9, release: 1.5, cutoff: 1400, dark: true }), -10);
  return t;
}
