/** Offline directed campaign VO. No synthesis or PCM assembly ships to the browser.
 * npm run bake:voice -- --pipeline ../planets [--workers 2] [--limit 8 | --ids id,id] */
import { Worker } from 'node:worker_threads';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { campaignCorpus } from './campaign-voice-corpus';
import { CAST, performanceFor, synthesisText, VOICE_RECIPE } from './campaign-voice-direction';
import { assemblePhrases, VOICE_SAMPLE_RATE as SR, type PhraseAudio } from './campaign-voice-waveform';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1] ?? fallback; };
const pipeline = path.resolve(arg('pipeline', '../planets'));
const corpus = campaignCorpus(), limit = Number(arg('limit', String(corpus.length))), workers = Number(arg('workers', '2'));
if (!Number.isInteger(limit) || limit < 1 || limit > corpus.length) throw new Error('limit must be between 1 and the corpus size');
if (!Number.isInteger(workers) || workers < 1 || workers > 4) throw new Error('workers must be an integer between 1 and 4');
const ids = arg('ids', '').split(',').filter(Boolean);
for (const id of ids) if (!corpus.some(c => c.id === id)) throw new Error(`Unknown clip ${id}`);
const audition = arg('audition', ''), auditionSpeaker = arg('speaker', 'Sgt. Sprocket');
if (audition && (!/^[ab][mf]_[a-z]+$/.test(audition) || !existsSync(path.join(pipeline, 'public/audio/voice/voices', `${audition}.bin`)))) throw new Error('Unknown audition voice');
if (audition && (!CAST[auditionSpeaker] || !ids.length)) throw new Error('Auditions require a cast --speaker and explicit --ids');
if (audition && corpus.some(c => ids.includes(c.id) && c.speaker !== auditionSpeaker)) throw new Error('Audition IDs must all belong to the selected speaker');
const castProfiles = audition ? { ...CAST, [auditionSpeaker]: { ...CAST[auditionSpeaker], voiceId: audition } } : CAST;
const preview = limit < corpus.length || ids.length > 0 || !!audition;
// A small audition includes the whole cast instead of only alphabetically first Brann.
const interleaved = Object.keys(CAST).map(speaker => corpus.filter(c => c.speaker === speaker));
const jobs = ids.length ? corpus.filter(c => ids.includes(c.id)) : Array.from({ length: Math.max(...interleaved.map(c => c.length)) }, (_, i) => interleaved.flatMap(c => c[i] ? [c[i]] : [])).flat().slice(0, limit);
const output = path.resolve(audition ? `artifacts/voice-auditions/${audition}` : preview ? 'artifacts/voice-preview' : 'public/audio/campaign'), cache = path.resolve('artifacts/voice-cache');
mkdirSync(output, { recursive: true }); mkdirSync(cache, { recursive: true });
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const workerPath = path.resolve('scripts/campaign-voice-worker.mjs'), workerHash = hash(readFileSync(workerPath));
const pronunciationHash = hash(readFileSync('scripts/campaign-pronunciation.json'));
type Clip = { speaker: string; text: string; file: string; seconds: number; bytes: number };
const manifest: Record<string, Clip> = {}, performances: Record<string, unknown> = {};
const pendingRaw = new Map<string, Promise<void>>();
let cursor = 0, completed = 0;
function ffmpeg(input: Buffer, args: string[]): Buffer {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-y', '-loglevel', 'error', ...args], { input, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`ffmpeg: ${String(result.stderr)}`);
  return result.stdout;
}
async function bakeWorker() {
  const worker = new Worker(workerPath, { workerData: { root: pipeline, threads: 3, cacheDir: cache } });
  const receive = () => new Promise<any>((resolve, reject) => {
    const message = (m: unknown) => { cleanup(); resolve(m); }, error = (e: Error) => { cleanup(); reject(e); };
    const exit = (code: number) => error(new Error(`Voice worker exited (${code})`));
    const timeout = setTimeout(() => error(new Error('Voice worker timed out after 180 seconds')), 180000);
    const cleanup = () => { clearTimeout(timeout); worker.off('message', message); worker.off('error', error); worker.off('exit', exit); };
    worker.once('message', message); worker.once('error', error); worker.once('exit', exit);
  });
  try {
    const ready = await receive(); if (!ready.ready) throw new Error('Voice worker did not initialize');
    for (;;) {
      const job = jobs[cursor++]; if (!job) break;
      const cast = castProfiles[job.speaker], score = performanceFor(job.speaker, job.text, cast);
      const phraseAudio: PhraseAudio[] = [], timeline: any[] = [];
      for (const sentence of score) {
        const section: any = { text: sentence.text, delivery: sentence.delivery, pitch: sentence.pitch, phrases: [], pauseAfterMs: sentence.pauseAfterMs };
        for (const phrase of sentence.phrases) {
          const spokenText = synthesisText(phrase);
          const words = phrase.text.match(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
          let speed = sentence.rate / sentence.pitch, pcm!: Buffer, header: any, spokenWpm = 0;
          for (let attempt = 0; attempt < 4; attempt++) {
            const cacheId = hash(JSON.stringify([spokenText, job.text, cast.voiceId, speed, VOICE_RECIPE, workerHash, pronunciationHash])).slice(0, 24);
            const raw = path.join(cache, `${cacheId}.pcmrec`);
            if (!existsSync(raw)) {
              let pending = pendingRaw.get(cacheId);
              if (!pending) {
                pending = (async () => {
                  const response = receive(); worker.postMessage({ id: cacheId, text: spokenText, contextText: job.text, voiceId: cast.voiceId, speed });
                  const result = await response; if (!result.ok) throw new Error(`${job.speaker}: ${result.error}`);
                })();
                pendingRaw.set(cacheId, pending);
              }
              await pending;
            }
            const record = readFileSync(raw), headerLength = record.readUInt32LE(0);
            header = JSON.parse(record.subarray(4, 4 + headerLength).toString()); pcm = record.subarray(4 + headerLength);
            if (header.sampleRate !== SR || pcm.length !== header.samples * 4 || header.text !== spokenText) throw new Error(`Invalid PCM cache ${cacheId}`);
            spokenWpm = words * 60 / (header.samples / SR / sentence.pitch);
            if (words < 5 || spokenWpm <= sentence.maxWpm * 1.02) break;
            if (attempt === 3) throw new Error(`Native speech remains rushed: ${phrase.text}`);
            // Re-synthesize slower. Time-stretching after synthesis can add
            // phasing/repeated transients and invalidates phoneme time offsets.
            speed *= sentence.maxWpm / spokenWpm * .97;
          }
          const processed = ffmpeg(pcm, ['-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', 'pipe:0',
            '-af', `asetrate=${Math.round(SR * sentence.pitch)},aresample=${SR},volume=${sentence.gain}`,
            '-f', 'f32le', '-ar', String(SR), '-ac', '1', 'pipe:1']);
          const samples = new Float32Array(processed.buffer.slice(processed.byteOffset, processed.byteOffset + processed.length));
          const sourceHash = hash(processed);
          writeFileSync(path.join(cache, `${sourceHash}.f32`), processed);
          section.phrases.push({ text: phrase.text, boundary: phrase.boundary, pauseAfterMs: phrase.pauseAfterMs,
            ...(spokenText !== phrase.text ? { synthesisText: spokenText } : {}),
            index: phraseAudio.length, sourceHash, sourceSamples: samples.length, nativeSpeed: speed, spokenWpm,
            phonemes: header.phonemes, pronunciation: header.words });
          phraseAudio.push({ samples, pauseAfterMs: phrase.pauseAfterMs });
        }
        timeline.push(section);
      }
      const assembled = assemblePhrases(phraseAudio);
      for (const section of timeline) {
        for (const phrase of section.phrases) {
          const span = assembled.spans[phrase.index];
          const slice = assembled.samples.subarray(span.start, span.end);
          if (hash(Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength)) !== phrase.sourceHash) throw new Error('Assembly altered speech samples');
          phrase.start = span.start / SR; phrase.end = span.end / SR; delete phrase.index;
        }
        section.start = section.phrases[0].start; section.end = section.phrases.at(-1).end;
        section.breaths = section.phrases.slice(0, -1).map((p: any) => ({ start: p.end, end: p.end + p.pauseAfterMs / 1000 }));
      }
      const colored = ffmpeg(Buffer.from(assembled.samples.buffer), ['-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', 'pipe:0',
        '-af', `highpass=f=65,${cast.color}`, '-f', 'f32le', '-ar', String(SR), '-ac', '1', 'pipe:1']);
      const mastered = new Float32Array(colored.buffer.slice(colored.byteOffset, colored.byteOffset + colored.length));
      let peak = 0, sum = 0, count = 0;
      for (const sample of mastered) { if (!Number.isFinite(sample)) throw new Error('Invalid mastered waveform'); peak = Math.max(peak, Math.abs(sample)); }
      for (const sample of mastered) if (Math.abs(sample) >= peak * .08) { sum += sample * sample; count++; }
      // One constant gain for the whole line. No compressor/loudness gain riding
      // that could pump around the newly added gaps.
      const gain = Math.min(.142 / Math.sqrt(sum / Math.max(1, count)), .79 / peak);
      for (let i = 0; i < mastered.length; i++) mastered[i] *= gain;
      const ogg = ffmpeg(Buffer.from(mastered.buffer), ['-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', 'pipe:0',
        '-ar', String(SR), '-ac', '1', '-c:a', 'libopus', '-b:a', '24k', '-application', 'voip', '-map_metadata', '-1',
        '-fflags', '+bitexact', '-flags:a', '+bitexact', '-f', 'ogg', 'pipe:1']);
      // New performances get new URLs even when their subtitle text is unchanged.
      const file = `${job.id}-${hash(ogg).slice(0, 12)}.ogg`, target = path.join(output, file);
      writeFileSync(`${target}.tmp`, ogg); renameSync(`${target}.tmp`, target);
      // Ogg's final granule can include discard padding. Catalog the decoded
      // duration that Web Audio plays, not the container's rounded duration.
      const decoded = ffmpeg(ogg, ['-i', 'pipe:0', '-f', 'f32le', '-ar', String(SR), '-ac', '1', 'pipe:1']);
      const seconds = decoded.length / 4 / SR;
      if (!(seconds > .1 && seconds < 90)) throw new Error(`Invalid decoded duration ${job.id}: ${seconds}`);
      manifest[job.id] = { speaker: job.speaker, text: job.text, file, seconds, bytes: ogg.length };
      performances[job.id] = timeline;
      console.log(`[${++completed}/${jobs.length}] ${job.speaker}: ${job.text.slice(0, 65)} (${seconds.toFixed(1)}s, ${score.length} sentences)`);
    }
  } finally { await worker.terminate(); }
}
await Promise.all(Array.from({ length: workers }, bakeWorker));
const ordered = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
const atomicJson = (file: string, value: unknown) => { writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n'); renameSync(`${file}.tmp`, file); };
atomicJson(path.join(output, 'manifest.json'), {
  version: 3, recipe: VOICE_RECIPE, codec: 'opus', sampleRate: SR, assembly: 'whole-phrases', pronunciationHash,
  model: { id: 'onnx-community/Kokoro-82M-v1.0-ONNX-timestamped', revision: 'dd4401a9add81ac692d20e240d22ec9dda82cc29', dtype: 'fp32' },
  cast: castProfiles, clips: ordered, performances: Object.fromEntries(Object.keys(ordered).map(id => [id, performances[id]])),
});
// Publish/prune only after success. Preview never changes shipping assets.
if (!preview) {
  atomicJson('src/audio/campaign-voice-manifest.json', ordered);
  const keep = new Set(Object.values(ordered).map(clip => clip.file));
  for (const entry of readdirSync(output, { withFileTypes: true })) if (entry.isFile() && /^[0-9a-f]{8}(?:-[0-9a-f]{12})?\.ogg$/.test(entry.name) && !keep.has(entry.name)) unlinkSync(path.join(output, entry.name));
}
console.log(`Baked ${completed} clips, ${(Object.values(manifest).reduce((n, c) => n + c.bytes, 0) / 1048576).toFixed(2)} MiB`);
