/** Offline performance score. Generate complete phrases at punctuation boundaries;
 * never cut a continuous voiced sound to force an internal pause. */
import { speechText } from '../src/audio/campaign-voice-key';

export const VOICE_RECIPE = 'kokoro-fp32-whole-phrases-v3';
export interface Cast {
  voiceId: string; rate: number; pitch: number; color: string; direction: string;
  pause: number; maxWpm: number;
  phrasing?: 'sentence';
}
export const CAST: Record<string, Cast> = {
  Narrator: { voiceId: 'bm_lewis', rate: .90, pitch: .96, color: 'equalizer=f=140:t=q:w=1:g=1.5', direction: 'Warm storyteller; let each image land', pause: 1.12, maxWpm: 170 },
  'Sgt. Sprocket': { voiceId: 'am_onyx', rate: .96, pitch: .98, color: 'highpass=f=100,equalizer=f=220:t=q:w=1:g=1,lowpass=f=6800', direction: 'Seasoned field sergeant; dry confidence, connected instructions and firm sentence landings', pause: 1, maxWpm: 185, phrasing: 'sentence' },
  'Marshal Corvin': { voiceId: 'bm_george', rate: .88, pitch: .91, color: 'equalizer=f=180:t=q:w=1:g=2', direction: 'Controlled authority, increasingly weary', pause: 1.15, maxWpm: 170 },
  Mags: { voiceId: 'af_heart', rate: .94, pitch: 1.02, color: 'equalizer=f=3200:t=q:w=1:g=1', direction: 'Bright, practical pilot; conversational, never breathless', pause: .96, maxWpm: 185 },
  Rook: { voiceId: 'am_michael', rate: .92, pitch: .97, color: 'highpass=f=90,equalizer=f=2400:t=q:w=1:g=1', direction: 'Quiet determination; make the decision count', pause: 1.12, maxWpm: 175 },
  Brann: { voiceId: 'am_fenrir', rate: .90, pitch: .84, color: 'equalizer=f=150:t=q:w=1:g=2,lowpass=f=6500', direction: 'Grounded Forge engineer; generous breaths and dry humor', pause: 1.1, maxWpm: 175 },
  Seraphine: { voiceId: 'bf_isabella', rate: .89, pitch: 1.03, color: 'aecho=0.85:0.9:24:0.07,highpass=f=100', direction: 'Calm astronomer; reflective, with a faint crystalline double', pause: 1.18, maxWpm: 170 },
  'Harbor Master': { voiceId: 'bm_daniel', rate: .94, pitch: .97, color: 'highpass=f=110,lowpass=f=6800', direction: 'Brisk officer, proud to join the fleet', pause: 1, maxWpm: 185 },
};

type Delivery = 'clear' | 'warm' | 'urgent' | 'reflective' | 'grave' | 'resolve';
const DELIVERY = {
  clear: { rate: 1, pitch: 1, gain: 1, pause: 1 },
  warm: { rate: .98, pitch: 1.015, gain: 1, pause: 1.05 },
  urgent: { rate: 1.025, pitch: 1.015, gain: 1.04, pause: .88 },
  reflective: { rate: .96, pitch: .995, gain: .96, pause: 1.18 },
  grave: { rate: .96, pitch: .985, gain: .96, pause: 1.15 },
  resolve: { rate: .98, pitch: 1, gain: 1.025, pause: 1.12 },
} as const;
// Authored choices, not sentiment guesses. Sentence cues allow a warning or a
// revelation to land differently from the next instruction in the same line.
const CUES: Record<string, Delivery[]> = {
  'Contacts! Little ones. The planet curves away fast, so things pop over the horizon close. Your machine gun fires on its own at whatever your turret faces.': ['urgent', 'clear', 'clear', 'clear'],
  "My turn. See the red ring? That's where my shell lands. Move!": ['warm', 'clear', 'clear', 'urgent'],
  "Two more, on your left! They've spotted you. Use the ground, a crater, anything!": ['urgent', 'urgent', 'clear'],
  "Something's lobbing at us from behind the curve! Watch the smoke trail. It comes from where the gun is.": ['urgent', 'clear', 'clear'],
  "The pond is boiling... Something's coming up out of it!": ['urgent'],
  "They're coming over the ridge! I've got your flank.": ['urgent', 'resolve'],
  'You saved my forge. You have my tracks, my tools, and my last good rivet.': ['warm', 'warm'],
  "Not bad rookie. Marshal Corvin will want to see you.": ['warm', 'clear'],
  "Mags Holloway, at your service. I'll stick to your flank. Try to keep up.": ['warm', 'warm', 'warm'],
  "Good work, Kestrel. Something's stirring at Millbrook. Get some rest; you ride at dawn.": ['warm', 'grave', 'clear'],
  "Hold your fire, the column's here. Well done, Rook. Better than I'd hoped.": ['clear', 'warm', 'warm'],
  'An archive older than the sun. Imagine what we might learn.': ['reflective', 'reflective'],
  "And what's this... still warm. I'll keep this shard of the core. For study.": ['reflective', 'grave', 'grave'],
  "He took the Key. Rook... the regiment is following him. We're on our own.": ['grave', 'grave', 'grave'],
  "It isn't a plague. The Rust is a recycler. The Wrights built it to remake the worlds.": ['reflective', 'grave', 'grave'],
  'The Lantern is not dying. It is waiting. I can show you another way.': ['reflective', 'reflective', 'warm'],
  'The Ascendancy will stand with you. Even beside the Forge.': ['resolve', 'warm'],
  "All three worlds. One last launch. Let's make it count.": ['reflective', 'grave', 'resolve'],
  'Forge engines hot. Aether shields holding. Launch every ship!': ['resolve', 'resolve', 'urgent'],
  'The Key can rewind the Mainspring. I will not let our worlds die because you are afraid of the price.': ['resolve', 'grave'],
  "I only wanted the light to stay. Don't let it all have been for nothing.": ['grave', 'grave'],
  'We could let the worlds rest. Sail for the Lantern. Make something new.': ['reflective', 'reflective', 'warm'],
  'Or mend what our people built. There is still life in these worlds.': ['resolve', 'warm'],
  "We're with you, Rook. Whatever comes next.": ['warm', 'resolve'],
  'We mend it. Together. Turn the Key.': ['resolve', 'warm', 'resolve'],
  'Let it go. We carry our people forward, not the weight of the past.': ['reflective', 'resolve'],
  'The Lantern burns bright. The worlds turn again. And we will be here to care for them.': ['warm', 'reflective', 'resolve'],
  'The worlds settle gently. Ahead of us, the Lantern. We sail together.': ['reflective', 'reflective', 'warm'],
};
export const directedTexts = Object.keys(CUES);
export interface SpeechPhrase { text: string; pauseAfterMs: number; boundary: 'clause' | 'sentence' }

/** Unlike splitting on '.', this keeps decimals, titles, initials and ellipses intact. */
export function sentences(text: string): string[] {
  const result: string[] = [];
  let start = 0;
  for (const m of text.matchAll(/[.!?]+["')\]]*(?:\s+|$)/g)) {
    const end = m.index! + m[0].trimEnd().length, before = text.slice(start, end);
    if (m[0].startsWith('...')) continue;
    if (m[0][0] === '.' && /\b(?:Mr|Mrs|Ms|Dr|Sgt|Lt|Capt|St|[A-Z])\.$/.test(before)) continue;
    result.push(before.trim()); start = m.index! + m[0].length;
  }
  if (text.slice(start).trim()) result.push(text.slice(start).trim());
  return result;
}

/** The punctuation remains in each model input, including continuation commas.
 * Every join is between complete generated utterances with their own silent pads. */
export function phraseScore(text: string, scale: number, finalPause: number): SpeechPhrase[] {
  const phrases: SpeechPhrase[] = [];
  let start = 0;
  for (const m of text.matchAll(/(?:\.{3}|[,;:]|\s-)["')\]]*\s+/g)) {
    const end = m.index! + m[0].length;
    if (!text.slice(end).trim()) continue;
    const ms = m[0].startsWith('...') ? 580 : m[0][0] === ',' ? 170 : 290;
    phrases.push({ text: text.slice(start, end).trim(), pauseAfterMs: Math.round(ms * scale), boundary: 'clause' }); start = end;
  }
  phrases.push({ text: text.slice(start).trim(), pauseAfterMs: finalPause, boundary: 'sentence' }); return phrases;
}

/** Objective labels have no displayed punctuation, but still need a finished
 * statement at synthesis time. Keep questions and exclamations as authored. */
export function synthesisText(phrase: SpeechPhrase): string {
  return phrase.boundary === 'sentence' && !/[.!?]["')\]]*$/.test(phrase.text) ? `${phrase.text}.` : phrase.text;
}

export function performanceFor(speaker: string, input: string, cast = CAST[speaker]) {
  if (!cast) throw new Error(`Uncast character: ${speaker}`);
  const text = speechText(input);
  return sentences(text).map((sentence, i, all) => {
    const delivery = CUES[text]?.[i] ?? 'clear', mood = DELIVERY[delivery];
    const pauseScale = cast.pause * mood.pause;
    const last = i === all.length - 1;
    // Last pad also supplies the breathing room between narrator and briefing intel.
    const pauseAfterMs = Math.round((last ? 420 : /\?["')\]]*$/.test(sentence) ? 480 : /!["')\]]*$/.test(sentence) ? 360 : 430) * pauseScale);
    // Sprocket's conversational commas are not breath instructions. Give the
    // model the complete sentence so its final cadence has the preceding context.
    const phrases: SpeechPhrase[] = cast.phrasing === 'sentence'
      ? [{ text: sentence, pauseAfterMs, boundary: 'sentence' }]
      : phraseScore(sentence, pauseScale, pauseAfterMs);
    return { text: sentence, phrases, delivery,
      rate: cast.rate * mood.rate, pitch: cast.pitch * mood.pitch, gain: mood.gain,
      maxWpm: cast.maxWpm, pauseAfterMs };
  });
}
