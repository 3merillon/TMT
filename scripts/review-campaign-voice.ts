/** Decode every finished Opus file and measure the directed pauses after mastering.
 * Also writes a local A/B listening page; signal checks cannot judge acting. */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { assemblePhrases } from './campaign-voice-waveform';
import { verifyPronunciation } from './campaign-voice-audit';
const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1] ?? fallback; };
const root = path.resolve(arg('dir', 'public/audio/campaign'));
const out = path.resolve(arg('out', 'artifacts/voice-review'));
const baseline = arg('baseline', '');
const cache = path.resolve(arg('cache', 'artifacts/voice-cache'));
const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const before = baseline ? JSON.parse(readFileSync(path.join(baseline, 'manifest.json'), 'utf8')).clips : {};
if (manifest.version !== 3 || manifest.assembly !== 'whole-phrases' || !manifest.performances) throw new Error('A whole-phrase v3 bake is required');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
if (manifest.pronunciationHash !== hash(readFileSync('scripts/campaign-pronunciation.json'))) throw new Error('Pronunciation dictionary changed; rebuild the voices');
mkdirSync(out, { recursive: true });
const reports: any[] = [];
const sr = 24000;
const vocabulary = new Map<string, { phonemes: Set<string>; clips: Set<string> }>();
const rms = (samples: Float32Array, start: number, end: number) => {
  const from = Math.max(0, Math.ceil(start * sr)), to = Math.min(samples.length, Math.floor(end * sr));
  if (to <= from) throw new Error(`Empty acoustic window ${start}..${end}`);
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (to - from));
};
for (const [id, value] of Object.entries(manifest.clips)) {
  const clip = value as any, timeline = manifest.performances[id];
  if (timeline.map((s: any) => s.text).join(' ') !== clip.text) throw new Error(`Missing sentence ${id}`);
  const controlled: any[] = [];
  let cursor = 0, phrases = 0;
  for (const sentence of timeline) {
    if (sentence.phrases.map((p: any) => p.text).join(' ') !== sentence.text) throw new Error(`Missing phrase ${id}`);
    for (const phrase of sentence.phrases) {
      controlled.push(...verifyPronunciation(phrase, clip.text));
      const pcm = readFileSync(path.join(cache, `${phrase.sourceHash}.f32`));
      if (hash(pcm) !== phrase.sourceHash || pcm.length !== phrase.sourceSamples * 4) throw new Error(`Corrupt source ${id}: ${phrase.text}`);
      const source = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length));
      // Independently check that every recorded join uses complete, quiet-ended
      // source audio, and that the timeline retains its entire sample count.
      assemblePhrases([{ samples: source, pauseAfterMs: phrase.pauseAfterMs }]);
      if (Math.abs(phrase.start * sr - cursor) > .01 || Math.abs((phrase.end - phrase.start) * sr - source.length) > .01) throw new Error(`Cut or repeated source ${id}`);
      cursor += source.length + Math.round(phrase.pauseAfterMs * sr / 1000); phrases++;
      for (const word of phrase.pronunciation) {
        if (!/[A-Za-z]/.test(word.text)) continue;
        const spelling = word.text.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '').toLowerCase();
        const entry = vocabulary.get(spelling) ?? { phonemes: new Set<string>(), clips: new Set<string>() };
        entry.phonemes.add(word.phonemes); entry.clips.add(id); vocabulary.set(spelling, entry);
      }
    }
  }
  const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', path.join(root, clip.file), '-f', 'f32le', '-ar', String(sr), '-ac', '1', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 });
  if (decoded.status !== 0) throw new Error(`Decode ${id}: ${decoded.stderr}`);
  const data = decoded.stdout, samples = new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length));
  let peak = 0;
  for (const sample of samples) { if (!Number.isFinite(sample)) throw new Error(`Invalid sample ${id}`); peak = Math.max(peak, Math.abs(sample)); }
  if (peak > .92 || rms(samples, 0, samples.length / sr) < .015) throw new Error(`Bad level ${id}, peak ${peak}`);
  if (Math.abs(samples.length / sr - clip.seconds) > .035) throw new Error(`Duration mismatch ${id}`);
  const pauses: any[] = [];
  for (const sentence of timeline) {
    if (rms(samples, sentence.start, sentence.end) < .015) throw new Error(`Silent sentence ${id}: ${sentence.text}`);
    const windows = [...sentence.breaths.map((p: any) => ({ ...p, kind: 'clause' })),
      { start: sentence.end, end: sentence.end + sentence.pauseAfterMs / 1000, kind: 'sentence' }];
    for (const window of windows) {
      // Allow the 24 ms character echo, resampling and Opus pre/post-ringing.
      const level = rms(samples, window.start + .06, window.end - .035);
      if (level > .004) throw new Error(`Pause filled with speech ${id} at ${window.start.toFixed(3)}s: rms ${level}`);
      pauses.push({ ...window, rms: level });
    }
  }
  reports.push({ id, ...clip, beforeSeconds: before[id]?.seconds, peak, phrases, controlled, pauses });
}
const relativeUrl = (file: string) => path.relative(out, path.resolve(file)).split(path.sep).map(encodeURIComponent).join('/');
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const featured = ['9c703eb9', '0b1185bd', '7ffb7ca9', '01d7d2e5', '7247a56f', '25123c61'];
const rank = (id: string) => featured.includes(id) ? featured.indexOf(id) : 99;
const rows = reports.sort((a, b) => rank(a.id) - rank(b.id) || a.speaker.localeCompare(b.speaker) || b.text.length - a.text.length).map(clip => `<article><h2>${escape(clip.speaker)}</h2><p>${escape(clip.text)}</p>${clip.controlled.length ? `<p class="notes">${clip.controlled.map((w: any) => `${escape(w.word)}: ${escape(w.reading)}`).join(' · ')}</p>` : ''}<div class="players">${before[clip.id] ? `<label>Before repair · ${before[clip.id].seconds.toFixed(1)} s<audio controls preload="none" src="${relativeUrl(path.join(baseline, before[clip.id].file))}"></audio></label>` : ''}<label>Repaired v3 · ${clip.seconds.toFixed(1)} s<audio controls preload="none" src="${relativeUrl(path.join(root, clip.file))}"></audio></label></div></article>`).join('\n');
writeFileSync(path.join(out, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TMT · Repaired voices v3</title><style>body{background:#151b21;color:#eee;font:17px/1.55 system-ui;max-width:960px;margin:40px auto;padding:20px}h1{color:#f9c361}article{border-top:1px solid #49535e;padding:18px 0}h2{font-size:19px}.players{display:flex;gap:30px;flex-wrap:wrap}label{display:grid;gap:8px;color:#bfcbd4}audio{width:360px;max-width:80vw}.notes{font-size:14px;color:#e4bf7b}input{box-sizing:border-box;width:100%;padding:12px;background:#222b34;color:#fff;border:1px solid #73818c;font:inherit}</style><h1>Tiny Metal Tank · Repaired voices</h1><p>${reports.length} complete performances. Whole phrases preserve speech around pauses; campaign names and ambiguous words have explicit pronunciations. Source integrity, recorded pronunciations and decoded audio were checked throughout. These checks cannot certify every aspect of acting.</p><label>Find a character, line or pronunciation<input type="search" id="search" placeholder="Tidewell, Sprocket, wind…"></label>${rows}<script>document.addEventListener('play',e=>{for(const a of document.querySelectorAll('audio'))if(a!==e.target)a.pause()},true);document.getElementById('search').addEventListener('input',e=>{const q=e.target.value.toLowerCase();for(const row of document.querySelectorAll('article'))row.hidden=!row.textContent.toLowerCase().includes(q)})</script></html>`);
const summary = { clips: reports.length, phrases: reports.reduce((n, r) => n + r.phrases, 0), controlledWords: reports.reduce((n, r) => n + r.controlled.length, 0), vocabulary: vocabulary.size, pauses: reports.reduce((n, r) => n + r.pauses.length, 0), bytes: reports.reduce((n, r) => n + r.bytes, 0), seconds: reports.reduce((n, r) => n + r.seconds, 0) };
writeFileSync(path.join(out, 'pronunciations.json'), JSON.stringify(Object.fromEntries([...vocabulary].sort(([a], [b]) => a.localeCompare(b)).map(([word, v]) => [word, { phonemes: [...v.phonemes].sort(), clips: [...v.clips].sort() }])), null, 2) + '\n');
writeFileSync(path.join(out, 'report.json'), JSON.stringify({ ...summary, clips: reports }, null, 2) + '\n');
console.log(JSON.stringify(summary)); console.log(`Listening page: ${path.join(out, 'index.html')}`);
