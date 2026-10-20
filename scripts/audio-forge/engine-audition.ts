/** Renders the engine worklet's DSP offline (the processor class with its globals stubbed) through an idle →
 * accelerate → cruise → slip → turret-sweep → stop sequence, so its character can be auditioned and analysed. */
import { join } from 'node:path';
import { SR } from './dsp/core';
import { writeWav } from './dsp/wav';
import { spectrogramPng, stats } from './dsp/analyze';
import { engineParams } from '../../src/audio/sfx/tank-sfx-math';

const g = globalThis as unknown as Record<string, unknown>;
g.sampleRate = SR;
let Processor: new(o?: unknown) => { process(i: Float32Array[][], o: Float32Array[][], p: Record<string, Float32Array>): boolean };
g.registerProcessor = (_name: string, cls: unknown) => { Processor = cls as typeof Processor; };
g.AudioWorkletProcessor = class { constructor(_o?: unknown) { /* stub */ } };
await import('../../src/audio/worklets/engine-processor');
const OUT = process.env.TMT_AUDIO_OUT ?? 'G:/tmt-work/audio';
const seconds = 20, total = seconds * SR, out = new Float32Array(total), block = 128;
const proc = new Processor!({ processorOptions: { seed: 0x9e3779b9 } });
const params = Object.fromEntries(['fundamental', 'load', 'tread', 'slip', 'servo', 'level', 'turn', 'damage'].map(k => [k, new Float32Array(1)])) as Record<string, Float32Array>;
const timeline = (t: number) => {
  // speed (u/s), accel, slip, turretRate over time; then a hard turn at speed (14-16 s) and the misfire mode (17-20 s)
  const speed = t < 2 ? 0 : t < 5 ? (t - 2) / 3 * 3.2 : t < 9 ? 3.2 : t < 11 ? 3.2 - (t - 9) / 2 * 3.2 : t < 14 ? 0 : t < 16.5 ? 2.2 : t < 17 ? 0 : 1.2;
  const accel = t < 2 ? 0 : t < 5 ? 1.1 : t < 9 ? 0 : t < 11 ? -1.6 : t > 14 && t < 14.5 ? 2 : 0;
  const slip = t > 6 && t < 7.5 ? 0.9 : 0;
  const turret = t > 11.5 && t < 13 ? 1.2 : 0;
  const yawRate = t > 14.3 && t < 16.2 ? 1.8 : 0;
  const health = t > 17 ? 0.12 : 1;
  return engineParams({ speed, accel, slip, contact: 1, turretRate: turret, yawRate, health });
};
for (let at = 0; at < total; at += block) {
  const p = timeline(at / SR);
  params.fundamental[0] = p.fundamental; params.load[0] = p.load; params.tread[0] = p.tread; params.slip[0] = p.slip; params.servo[0] = p.servo; params.level[0] = p.level; params.turn[0] = p.turn; params.damage[0] = p.damage;
  const buf = new Float32Array(block);
  proc.process([], [[buf]], params);
  out.set(buf.subarray(0, Math.min(block, total - at)), at);
}
writeWav(join(OUT, 'previews', 'engine-loop-audition.wav'), [out, out], { bits: 16 });
await spectrogramPng(join(OUT, 'analysis', 'engine-loop-spectrogram.png'), [out, out]);
console.log(JSON.stringify(stats([out, out])));
