/** Checks the phonemes actually supplied to synthesis, not just dictionary intent. */
import pronunciation from './campaign-pronunciation.json';

interface Word { text: string; phonemes: string }
interface Phrase { text: string; pronunciation: Word[] }
interface Entry { phonemes: string; reading?: string; accept?: string; sense?: string }
const entries: Record<string, Entry> = { ...pronunciation.lexicon, ...pronunciation.context };
const spellings = (text: string) => text.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) ?? [];
const sound = (text: string) => text.replace(/[\s.,!?;:"'()\[\]-]/g, '');

export function verifyPronunciation(phrase: Phrase, context: string) {
  const source = spellings(phrase.text), recorded = phrase.pronunciation.flatMap(w => spellings(w.text));
  if (source.join('|') !== recorded.join('|')) throw new Error(`Pronunciation record lost words: ${phrase.text}`);
  const controlled: { word: string; phonemes: string; reading: string }[] = [];
  for (const word of phrase.pronunciation) {
    const tokens = spellings(word.text);
    if (tokens.length && !sound(word.phonemes)) throw new Error(`Unvoiced word: ${word.text}`);
    for (const token of tokens) {
      const upper = token.toUpperCase();
      const base = entries[upper] ? upper : upper.replace(/'S$|S$/, ''), entry = entries[base];
      if (!entry) continue;
      if (entry.accept && !new RegExp(entry.accept, 'i').test(context)) throw new Error(`Unreviewed context: ${token} in ${context}`);
      const actual = sound(word.phonemes), expected = sound(entry.phonemes);
      const inflected = upper !== base;
      if (!(inflected ? [expected + 'z', expected + 's', expected + 'ᵻz'].includes(actual) : actual === expected)) {
        throw new Error(`Wrong pronunciation for ${token}: ${word.phonemes}; expected ${entry.phonemes}`);
      }
      controlled.push({ word: token, phonemes: word.phonemes, reading: entry.reading ?? entry.sense! });
    }
  }
  return controlled;
}
