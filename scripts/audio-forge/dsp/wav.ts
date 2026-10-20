/** WAV read/write (PCM 16/24 and float 32). */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SR, type Stereo, type Mono } from './core';

export function writeWav(path: string, data: Stereo | Mono, o: { sampleRate?: number; bits?: 16 | 24 | 32 } = {}): void {
  const channels = data instanceof Float32Array ? [data] : data, sr = o.sampleRate ?? SR, bits = o.bits ?? 24, n = channels[0].length, nc = channels.length;
  const bytesPer = bits / 8, dataBytes = n * nc * bytesPer, buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8); buf.write('fmt ', 12); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(bits === 32 ? 3 : 1, 20); buf.writeUInt16LE(nc, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * nc * bytesPer, 28); buf.writeUInt16LE(nc * bytesPer, 32); buf.writeUInt16LE(bits, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataBytes, 40);
  let at = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) {
    const v = Math.max(-1, Math.min(1, channels[c][i]));
    if (bits === 16) { buf.writeInt16LE(Math.round(v * 32767), at); at += 2; }
    else if (bits === 24) { const s = Math.round(v * 8388607); buf.writeUInt8(s & 255, at); buf.writeUInt8((s >> 8) & 255, at + 1); buf.writeUInt8((s >> 16) & 255, at + 2); at += 3; }
    else { buf.writeFloatLE(channels[c][i], at); at += 4; }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
}
export function readWav(path: string): { sampleRate: number; channels: Float32Array[] } {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${path}: not a WAV`);
  let at = 12, fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null, data: Buffer | null = null;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4), size = buf.readUInt32LE(at + 4), body = at + 8;
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    else if (id === 'data') data = buf.subarray(body, Math.min(buf.length, body + size));
    at = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error(`${path}: missing fmt/data`);
  const bytesPer = fmt.bits / 8, frames = Math.floor(data.length / (bytesPer * fmt.channels)), channels = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
  let p = 0;
  for (let i = 0; i < frames; i++) for (let c = 0; c < fmt.channels; c++) {
    let v: number;
    if (fmt.format === 3 && fmt.bits === 32) v = data.readFloatLE(p);
    else if (fmt.bits === 16) v = data.readInt16LE(p) / 32768;
    else if (fmt.bits === 24) { let s = data[p] | (data[p + 1] << 8) | (data[p + 2] << 16); if (s & 0x800000) s |= ~0xffffff; v = s / 8388608; }
    else if (fmt.bits === 32) v = data.readInt32LE(p) / 2147483648;
    else throw new Error(`${path}: unsupported ${fmt.bits}-bit`);
    channels[c][i] = v; p += bytesPer;
  }
  return { sampleRate: fmt.sampleRate, channels };
}
