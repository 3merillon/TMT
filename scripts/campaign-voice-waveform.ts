/** Whole-utterance assembly. Every source sample is retained in order, exactly
 * once. Only the silent space BETWEEN complete model outputs may be extended. */
export const VOICE_SAMPLE_RATE = 24000;
export interface PhraseAudio { samples: Float32Array; pauseAfterMs: number }
export function assemblePhrases(phrases: readonly PhraseAudio[], rate = VOICE_SAMPLE_RATE) {
  const edge = Math.round(rate * .01);
  for (const phrase of phrases) {
    if (!Number.isFinite(phrase.pauseAfterMs) || phrase.pauseAfterMs < 0 || phrase.samples.length < edge * 2) throw new Error('Invalid phrase');
    let head = 0, tail = 0;
    for (const sample of phrase.samples) if (!Number.isFinite(sample)) throw new Error('Invalid voice sample');
    for (let i = 0; i < edge; i++) { head += phrase.samples[i] ** 2; tail += phrase.samples[phrase.samples.length - 1 - i] ** 2; }
    if (Math.sqrt(Math.max(head, tail) / edge) > .002) throw new Error('Phrase boundary contains speech; refusing to splice');
  }
  const output = new Float32Array(phrases.reduce((n, p) => n + p.samples.length + Math.round(p.pauseAfterMs * rate / 1000), 0));
  const spans: { start: number; end: number; pauseEnd: number }[] = [];
  let cursor = 0;
  for (const phrase of phrases) {
    const start = cursor;
    output.set(phrase.samples, cursor); cursor += phrase.samples.length;
    const end = cursor; cursor += Math.round(phrase.pauseAfterMs * rate / 1000);
    spans.push({ start, end, pauseEnd: cursor });
  }
  return { samples: output, spans };
}
