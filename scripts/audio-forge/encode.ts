/** ffmpeg encoding (Opus for shipping, AAC fallback) and file helpers. Requires ffmpeg on PATH (C:\FFMPEG\bin here). */
import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/** Runs ffmpeg; a failure to open the output (Windows: an indexer or scanner holding a just-written file) is retried. */
export function ffmpeg(args: string[]): void {
  let last = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
    if (r.status === 0) return;
    last = r.stderr || r.stdout;
    if (!/Error opening output|Permission denied|Invalid argument/.test(last)) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400 + attempt * 600);
  }
  throw new Error(`ffmpeg failed: ${last}`);
}
export function encodeOpus(wav: string, out: string, kbps = 64, o: { mono?: boolean } = {}): number {
  mkdirSync(dirname(out), { recursive: true });
  ffmpeg(['-i', wav, ...(o.mono ? ['-ac', '1'] : []), '-c:a', 'libopus', '-b:a', `${kbps}k`, '-vbr', 'on', '-application', 'audio', '-frame_duration', '20', '-compression_level', '10', out]);
  return statSync(out).size;
}
export function encodeAac(wav: string, out: string, kbps = 96, o: { mono?: boolean } = {}): number {
  mkdirSync(dirname(out), { recursive: true });
  ffmpeg(['-i', wav, ...(o.mono ? ['-ac', '1'] : []), '-c:a', 'aac', '-b:a', `${kbps}k`, '-movflags', '+faststart', out]);
  return statSync(out).size;
}
export const ffmpegVersion = (): string => { const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }); return (r.stdout || '').split('\n')[0]; };
