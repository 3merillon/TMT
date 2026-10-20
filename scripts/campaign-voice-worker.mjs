/** Offline-only Kokoro adapter. Reuses Planets' pinned model, voicepacks and
 * pronunciation tables without changing that repo. One complete phrase per
 * inference; no synthetic break tokens and no edits inside its voiced waveform. */
import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { root, cacheDir, threads = 3 } = workerData;
const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX-timestamped';
const REVISION = 'dd4401a9add81ac692d20e240d22ec9dda82cc29';
const SR = 24000;
const { StyleTextToSpeech2Model, AutoTokenizer, Tensor } = await import(pathToFileURL(path.join(root, 'tools/voice-runtime/transformers.mjs')).href);
const voiceDir = path.join(root, 'public/audio/voice');
const { Language } = await import(pathToFileURL(path.join(voiceDir, 'modules/language-en-us.mjs')).href);
const language = new Language({ trace: false });
await language.loadDictionary(path.join(voiceDir, 'dictionaries/en-us.txt'));
const pronunciation = JSON.parse(readFileSync(new URL('./campaign-pronunciation.json', import.meta.url), 'utf8'));
for (const [word, entry] of Object.entries({ ...pronunciation.lexicon, ...pronunciation.context })) {
  language.dictionary[word] = [...entry.phonemes];
  language.tableWords.add(word); language.stemWords.add(word);
}
const tokenizer = await AutoTokenizer.from_pretrained(MODEL, { revision: REVISION });
const model = await StyleTextToSpeech2Model.from_pretrained(MODEL, {
  revision: REVISION, dtype: 'fp32', device: 'cpu',
  session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 },
});
const voices = new Map();
function voice(id) {
  if (!voices.has(id)) {
    const b = readFileSync(path.join(voiceDir, 'voices', `${id}.bin`));
    voices.set(id, new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
  }
  return voices.get(id);
}

async function synthesize({ id, text, contextText, voiceId, speed }) {
  const spellings = text.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) ?? [];
  for (const spelling of spellings) {
    const word = spelling.toUpperCase(), sense = pronunciation.context[word];
    if (sense && !new RegExp(sense.accept, 'i').test(contextText)) throw new Error(`Review context for ${word}: ${contextText}`);
    // Known inflections use the existing suffix rules. Everything else must
    // have an explicit dictionary entry; never quietly guess a new lore name.
    const base = word.replace(/'(?:S|LL|RE|VE|D)$/, '').replace(/S$/, '');
    if (!language.dictionary[word] && !language.dictionary[base]) throw new Error(`Unreviewed pronunciation: ${spelling}`);
  }
  const { phonemes, metadata } = language.generate([text]);
  if (metadata.words.join('') !== text) throw new Error(`Phonemiser lost text: ${text}`);
  // The inherited phonemiser retains compound-word hyphens, but Kokoro has no
  // hyphen token. Preserve that word boundary as a space instead of letting the
  // tokenizer silently discard it (for example, "far-side" or "white-hot").
  for (let i = 0; i < phonemes.length; i++) if (phonemes[i] === '-') phonemes[i] = ' ';
  // Never silently truncate the end of an instruction to fit the model context.
  const { input_ids } = tokenizer(phonemes.join(''), { truncation: false });
  if (input_ids.size > 512) throw new Error(`Sentence exceeds Kokoro context (${input_ids.size} tokens): ${text}`);
  if (input_ids.size !== phonemes.length + 2) throw new Error(`Tokenizer dropped phonemes: ${text}`);
  const n = Math.min(Math.max(input_ids.size - 2, 0), 509);
  const { waveform } = await model({ input_ids,
    style: new Tensor('float32', voice(voiceId).slice(n * 256, (n + 1) * 256), [1, 256]),
    speed: new Tensor('float32', [speed], [1]),
  });
  const samples = waveform.data;
  let peak = 0, squares = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample)) throw new Error(`Non-finite waveform: ${text}`);
    peak = Math.max(peak, Math.abs(sample)); squares += sample * sample;
  }
  const rms = Math.sqrt(squares / samples.length);
  if (!(rms > .005)) throw new Error(`Silent synthesis: ${text}`);
  let first = 0, last = samples.length - 1;
  while (first < last && Math.abs(samples[first]) < .001) first++;
  while (last > first && Math.abs(samples[last]) < .001) last--;
  const from = Math.max(0, first - Math.round(.08 * SR));
  const to = Math.min(samples.length, last + 1 + Math.round(.12 * SR));
  const trimmed = Float32Array.from(samples.subarray(from, to));
  // Match Planets' gated-RMS normalization before the final shared mastering pass.
  let sum = 0, count = 0;
  for (const v of trimmed) if (Math.abs(v) >= peak * .08) { sum += v * v; count++; }
  const gain = Math.max(.35, Math.min(3, .142 / Math.sqrt(sum / Math.max(1, count))));
  for (let i = 0; i < trimmed.length; i++) trimmed[i] = Math.max(-.99, Math.min(.99, trimmed[i] * gain));
  const words = metadata.words.map((word, i) => ({ text: word.trim(),
    phonemes: phonemes.slice(metadata.wtimes[i], metadata.wdurations[i]).join('').trim() }));
  const header = Buffer.from(JSON.stringify({ sampleRate: SR, samples: trimmed.length, rms, text, phonemes: phonemes.join(''), words }));
  const record = Buffer.alloc(4 + header.length + trimmed.byteLength);
  record.writeUInt32LE(header.length, 0); header.copy(record, 4);
  Buffer.from(trimmed.buffer).copy(record, 4 + header.length);
  const target = path.join(cacheDir, `${id}.pcmrec`);
  writeFileSync(`${target}.tmp`, record); renameSync(`${target}.tmp`, target);
  return { samples: trimmed.length };
}
parentPort.on('message', async job => {
  try { parentPort.postMessage({ id: job.id, ok: true, ...await synthesize(job) }); }
  catch (error) { parentPort.postMessage({ id: job.id, ok: false, error: String(error?.message ?? error) }); }
});
parentPort.postMessage({ ready: true });
