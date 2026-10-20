/**
 * Sustained machine-gun fire. A gun that is streaming tracers gets ONE looping voice (the bank's `coax-loop` sprite, a
 * seamless burst bed with varied round timing and a mechanical rattle) that follows the gun's position; when the
 * tracers stop for MG_RELEASE_S the loop fades out and the stop tail plays (bolt clatter, hot-barrel ticks, link
 * rattle). Before the bank has the loop, the integrator's rate-limited three-round bursts remain the fallback.
 */
import type { AudioManager } from '../audio-manager';
import type { SfxBank } from '../sfx-bank';
import type { Voice } from './layers';
import { PRIORITY } from '../voice-select';

type P = readonly [number, number, number];
export const MG_RELEASE_S = 0.18;
const TAU = 0.05, FADE_OUT_S = 0.06;
const rateOf = (seed: number, spread: number) => 1 + (((seed >>> 3) % 1000) / 1000 - 0.5) * 2 * spread;
interface Gun { voice: Voice; last: number; pos: [number, number, number]; gain: number; pan: number; lowpass: number }
interface Retiring { voice: Voice; at: number }

export class MachineGuns {
  private readonly guns = new Map<number, Gun>();
  private readonly retiring: Retiring[] = [];
  started = 0; stopped = 0;
  constructor(private readonly m: AudioManager, private readonly bank: SfxBank) {}
  get active(): number { return this.guns.size; }
  /** A tracer from `owner` at `from`: starts or continues that gun's loop. Returns false when the loop sprite is unavailable. */
  tracer(owner: number, from: P, now: number, seed: number): boolean {
    const gun = this.guns.get(owner);
    if (gun && now - gun.last > MG_RELEASE_S) this.stop(owner, now);
    const live = this.guns.get(owner);
    if (live) { live.last = now; this.follow(live, from, now); return true; }
    if (!this.bank.has('coax-loop')) return false;
    const s = this.m.spatialize(from);
    const voice = this.bank.play(this.m, 'coax-loop', { bus: 'weapons', priority: PRIORITY.tracer, position: from, loop: true, rate: rateOf(seed, 0.05), variant: seed, gain: 0.0001, minLoudness: 0 });
    if (!voice) return false;
    const g: Gun = { voice, last: now, pos: [from[0], from[1], from[2]], gain: s.gain * 0.8, pan: s.pan, lowpass: s.lowpass };
    voice.out.gain.setTargetAtTime(g.gain, now, 0.012);
    this.guns.set(owner, g); this.started++;
    return true;
  }
  private follow(g: Gun, from: P, now: number): void {
    g.pos[0] = from[0]; g.pos[1] = from[1]; g.pos[2] = from[2];
    const s = this.m.spatialize(from), gain = s.gain * 0.8;
    if (Math.abs(gain - g.gain) > Math.max(1e-4, g.gain * 0.03)) { g.voice.out.gain.setTargetAtTime(gain, now, TAU); g.gain = gain; }
    if (g.voice.panner && Math.abs(s.pan - g.pan) > 0.01) { g.voice.panner.pan.setTargetAtTime(s.pan, now, TAU); g.pan = s.pan; }
    if (g.voice.lowpass && Math.abs(s.lowpass - g.lowpass) > g.lowpass * 0.03) { g.voice.lowpass.frequency.setTargetAtTime(s.lowpass, now, 0.08); g.lowpass = s.lowpass; }
  }
  /** Stops a gun: fades the loop, plays the tail at its last position. */
  private stop(owner: number, now: number): void {
    const g = this.guns.get(owner); if (!g) return;
    this.guns.delete(owner); this.stopped++;
    g.voice.out.gain.cancelScheduledValues(now); g.voice.out.gain.setTargetAtTime(0, now, FADE_OUT_S / 3);
    this.retiring.push({ voice: g.voice, at: now + FADE_OUT_S + 0.05 });
    if (this.bank.has('coax-tail')) this.bank.play(this.m, 'coax-tail', { bus: 'vehicles', priority: PRIORITY.thump, position: g.pos, gain: 0.6, rate: rateOf(owner * 7919 + Math.round(now * 13), 0.06), variant: owner + Math.round(now * 3), burst: true });
  }
  /** Per frame: release guns that stopped firing and dispose faded loops. */
  update(now: number): void {
    for (const [owner, g] of this.guns) if (now - g.last > MG_RELEASE_S) this.stop(owner, now);
    for (let i = this.retiring.length - 1; i >= 0; i--) { const r = this.retiring[i]; if (now >= r.at) { this.m.releaseLoop(r.voice); r.voice.dispose(); this.retiring.splice(i, 1); } }
  }
  reset(now: number): void { for (const owner of [...this.guns.keys()]) this.stop(owner, now); }
  dispose(): void { for (const g of this.guns.values()) { this.m.releaseLoop(g.voice); g.voice.dispose(); } this.guns.clear(); for (const r of this.retiring) { this.m.releaseLoop(r.voice); r.voice.dispose(); } this.retiring.length = 0; }
}
/** Distance from point `p` to the segment a-b. */
export function segmentDistance(p: P, a: P, b: P): number {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2], apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2];
  const l2 = abx * abx + aby * aby + abz * abz;
  const t = l2 > 1e-9 ? Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / l2)) : 0;
  return Math.hypot(apx - abx * t, apy - aby * t, apz - abz * t);
}
