import { describe, expect, it } from 'vitest';
import { campaignCorpus } from '../scripts/campaign-voice-corpus';
import { CAST, phraseScore, directedTexts, performanceFor, sentences, synthesisText } from '../scripts/campaign-voice-direction';
import { assemblePhrases } from '../scripts/campaign-voice-waveform';

describe('campaign performance score', () => {
  it('preserves every word and punctuation mark in every authored line', () => {
    const corpus = campaignCorpus();
    for (const line of corpus) {
      const score = performanceFor(line.speaker, line.text);
      expect(score.map(s => s.text).join(' ')).toBe(line.text);
      for (const s of score) {
        expect(s.phrases.map(p => p.text).join(' ')).toBe(s.text);
        expect(s.phrases.at(-1)?.pauseAfterMs).toBe(s.pauseAfterMs);
        expect(s.pauseAfterMs).toBeGreaterThanOrEqual(300);
        expect(s.pauseAfterMs).toBeLessThanOrEqual(700);
      }
    }
    for (const text of directedTexts) expect(corpus.some(c => c.text === text), text).toBe(true);
    expect(new Set(corpus.map(c => c.speaker))).toEqual(new Set(Object.keys(CAST)));
  });
  it('keeps abbreviations, decimal numbers, hyphens and hesitation inside the sentence', () => {
    expect(sentences('Sgt. Sprocket checked 2.5 rounds. "Ready?" Yes!')).toEqual(['Sgt. Sprocket checked 2.5 rounds.', '"Ready?"', 'Yes!']);
    const text = "Rook... the far-side battery is down, but we're exposed; move - now!";
    const phrases = phraseScore(text, 1, 420);
    expect(phrases.map(p => p.text).join(' ')).toBe(text);
    expect(phrases.map(p => p.pauseAfterMs)).toEqual([580, 170, 290, 290, 420]);
    expect(phraseScore('We have 1,200 rounds and 2.5 minutes.', 1, 420).map(p => p.text)).toEqual(['We have 1,200 rounds and 2.5 minutes.']);
  });
  it('synthesizes the reported problem words as intact phrases', () => {
    const greeting = campaignCorpus().find(line => line.speaker === 'Sgt. Sprocket' && line.text.startsWith('Morning'))!;
    expect(performanceFor(greeting.speaker, greeting.text)[0].phrases.map(p => p.text)).toEqual(['Morning rookie.']);
    const praise = campaignCorpus().find(line => line.speaker === 'Sgt. Sprocket' && line.text.startsWith('Not bad'))!;
    expect(performanceFor(praise.speaker, praise.text)[0].phrases.map(p => p.text)).toEqual(['Not bad rookie.']);
    expect(performanceFor('Brann', 'You have my tracks, my tools, and my last good rivet.')[0].phrases.map(p => p.text))
      .toEqual(['You have my tracks,', 'my tools,', 'and my last good rivet.']);
  });
  it('keeps the sergeant\'s conversational commas in a single continuous model utterance', () => {
    for (const line of campaignCorpus().filter(c => c.speaker === 'Sgt. Sprocket')) {
      for (const sentence of performanceFor(line.speaker, line.text)) {
        expect(sentence.phrases).toEqual([{ text: sentence.text, pauseAfterMs: sentence.pauseAfterMs, boundary: 'sentence' }]);
      }
    }
  });
  it('gives unpunctuated objective labels a statement ending without rewriting subtitles or questions', () => {
    const phrase = { text: 'Reach the lamp relay', pauseAfterMs: 420, boundary: 'sentence' as const };
    expect(synthesisText(phrase)).toBe('Reach the lamp relay.');
    expect(phrase.text).toBe('Reach the lamp relay');
    expect(synthesisText({ ...phrase, text: 'See the red ring?' })).toBe('See the red ring?');
    expect(synthesisText({ ...phrase, text: 'Move!' })).toBe('Move!');
    expect(synthesisText({ ...phrase, text: 'My tools,', boundary: 'clause' })).toBe('My tools,');
  });
  it('gives a warning urgency but lets its following instruction settle', () => {
    const warning = performanceFor('Sgt. Sprocket', "My turn. See the red ring? That's where my shell lands. Move!");
    expect(warning.map(s => s.delivery)).toEqual(['warm', 'clear', 'clear', 'urgent']);
    expect(warning[1].pauseAfterMs).toBeGreaterThan(warning[0].pauseAfterMs);
    const betrayal = performanceFor('Mags', "He took the Key. Rook... the regiment is following him. We're on our own.");
    expect(betrayal.every(s => s.delivery === 'grave')).toBe(true);
    expect(betrayal[0].rate).toBeLessThan(CAST.Mags.rate);
  });
});

describe('whole-phrase breath assembly', () => {
  const utterance = (length: number, phase = 0) => Float32Array.from({ length }, (_, i) =>
    i < 480 || i >= length - 480 ? 0 : Math.sin(i * .07 + phase) * (i < 720 ? .001 : .2));
  it('preserves every speech sample exactly once, including quiet consonants, around multiple gaps', () => {
    const phrases = [
      { samples: utterance(24000), pauseAfterMs: 170 },
      { samples: utterance(18000, 1), pauseAfterMs: 290 },
      { samples: utterance(12000, 2), pauseAfterMs: 420 },
    ];
    const { samples, spans } = assemblePhrases(phrases);
    expect(samples.length).toBe(75120);
    expect(spans).toHaveLength(3);
    for (const [i, span] of spans.entries()) {
      expect(samples.subarray(span.start, span.end)).toEqual(phrases[i].samples);
      expect(span.pauseEnd - span.end).toBe(phrases[i].pauseAfterMs * 24);
      expect(samples.subarray(span.end, span.pauseEnd).every(s => s === 0)).toBe(true);
      expect(span.start).toBe(i ? spans[i - 1].pauseEnd : 0);
    }
  });
  it('refuses a pause in voiced speech even when that would create the requested silence', () => {
    const continuous = utterance(24000);
    // Regression: the old comma insertion always cut at an estimated timestamp,
    // even when Morning/rookie had no natural silence there.
    expect(() => assemblePhrases([
      { samples: continuous.subarray(0, 12000), pauseAfterMs: 170 },
      { samples: continuous.subarray(12000), pauseAfterMs: 420 },
    ])).toThrow('contains speech');
    expect(() => assemblePhrases([{ samples: continuous.subarray(12000), pauseAfterMs: 420 }])).toThrow('contains speech');
  });
  it('rejects damaged source samples and invalid pause lengths', () => {
    const samples = utterance(24000);
    expect(() => assemblePhrases([{ samples, pauseAfterMs: NaN }])).toThrow();
    expect(() => assemblePhrases([{ samples, pauseAfterMs: -100 }])).toThrow();
    samples[1500] = NaN;
    expect(() => assemblePhrases([{ samples, pauseAfterMs: 420 }])).toThrow('Invalid voice sample');
  });
});
