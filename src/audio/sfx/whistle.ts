/**
 * Shell whistles: one persistent voice per live projectile (≤ 6, nearest first, with hysteresis), a band-passed noise
 * and sine blend at f0 = 900 + 40·speed Hz with MANUAL doppler (WebAudio removed it from PannerNode):
 * v_r = dot(v_src − v_lis, normalize(p_lis − p_src)), f = f0·c/(c − v_r), c = 60 u/s, clamped to [0.5, 2].
 *
 * A shell whose predicted landing (ballistic extrapolation under the central gravity) falls within 4 u of the
 * listener focus is "incoming": it gets the classic descending glissando f × (0.75 + 0.25·height01) and is louder.
 */
import type { AudioManager } from '../audio-manager';
import { Voice } from './layers';
import { dopplerRatio, incomingPitch, INCOMING_RADIUS, MAX_WHISTLES, whistleBaseHz, whistleGain } from './tank-sfx-math';
import { PRIORITY, selectLoopVoices, type LoopCandidate } from '../voice-select';

type V3 = readonly [number, number, number];
export interface ProjectileLike { id: number; position: V3; velocity: V3 }

/** Whistles are audible out to about this distance (u). */
export const WHISTLE_RANGE = 24;
const FADE_IN = 0.15, RELEASE = 0.06, TAU = 0.03;
const PREDICT_EVERY = 0.1, PREDICT_DT = 1 / 30, PREDICT_MAX_S = 8;

interface Whistle {
  voice: Voice; bp: BiquadFilterNode; osc: OscillatorNode; env: GainNode;
  peakAltitude: number; incoming: boolean; predictedAt: number; landing: [number, number, number] | null;
  last: [f: number, gain: number, pan: number, lowpass: number];
}

/** Where a shell lands: explicit integration under a central gravity `g` (u/s²) until |p| ≤ groundRadius. */
export function predictLanding(p: V3, v: V3, g: number, groundRadius: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] | null {
  let x = p[0], y = p[1], z = p[2], vx = v[0], vy = v[1], vz = v[2];
  if (![x, y, z, vx, vy, vz, g, groundRadius].every(Number.isFinite) || groundRadius <= 0) return null;
  for (let t = 0; t < PREDICT_MAX_S; t += PREDICT_DT) {
    const r = Math.hypot(x, y, z);
    if (r <= groundRadius) { out[0] = x; out[1] = y; out[2] = z; return out; }
    const k = -g / Math.max(1e-6, r);
    vx += x * k * PREDICT_DT; vy += y * k * PREDICT_DT; vz += z * k * PREDICT_DT;
    x += vx * PREDICT_DT; y += vy * PREDICT_DT; z += vz * PREDICT_DT;
  }
  return null;
}

export class ShellWhistles {
  private readonly live = new Map<number, Whistle>();
  private readonly dying: { voice: Voice; at: number }[] = [];
  private readonly selected = new Set<number>();
  private readonly cands: LoopCandidate[] = [];
  /** Central gravity for the landing prediction (u/s²). */
  gravity = 7.5;
  private hintPoint: [number, number, number] | null = null;
  private hintUntil = 0;
  started = 0;

  get count(): number { return this.live.size; }
  get incomingCount(): number { let n = 0; for (const w of this.live.values()) if (w.incoming) n++; return n; }

  /** An `incoming` game event: shells predicted near this point are treated as incoming for a moment. */
  hint(predicted: V3, now: number): void { this.hintPoint = [predicted[0], predicted[1], predicted[2]]; this.hintUntil = now + 1.5; }

  update(m: AudioManager, projectiles: readonly ProjectileLike[], focus: V3, now: number): void {
    for (let i = this.dying.length - 1; i >= 0; i--) if (this.dying[i].at <= now) { this.dying[i].voice.dispose(); this.dying.splice(i, 1); }
    const cands = this.cands;
    cands.length = 0;
    for (const p of projectiles) {
      const s = m.spatialize(p.position);
      cands.push({ id: p.id, dist: s.path, range: WHISTLE_RANGE, live: this.live.has(p.id) });
    }
    selectLoopVoices(cands, MAX_WHISTLES, this.selected);
    for (const [id, w] of this.live) if (!this.selected.has(id)) this.release(m, id, w, now);
    const lis = m.listener, ground = lis.planetRadius > 0 ? lis.planetRadius : Math.hypot(focus[0], focus[1], focus[2]) - 0.3;
    for (const p of projectiles) {
      if (!this.selected.has(p.id)) continue;
      let w = this.live.get(p.id);
      if (!w) { const made = this.start(m, p, now); if (!made) continue; w = made; }
      const altitude = Math.hypot(p.position[0], p.position[1], p.position[2]) - ground;
      if (altitude > w.peakAltitude) w.peakAltitude = altitude;
      if (now >= w.predictedAt) {
        w.predictedAt = now + PREDICT_EVERY;
        w.landing = predictLanding(p.position, p.velocity, this.gravity, ground, w.landing ?? [0, 0, 0]);
        const near = (q: V3 | null, r: number) => !!q && Math.hypot(q[0] - focus[0], q[1] - focus[1], q[2] - focus[2]) < r;
        const hinted = !!this.hintPoint && now < this.hintUntil && !!w.landing
          && Math.hypot(w.landing[0] - this.hintPoint[0], w.landing[1] - this.hintPoint[1], w.landing[2] - this.hintPoint[2]) < 1.5;
        w.incoming = near(w.landing, INCOMING_RADIUS) || hinted;
      }
      const s = m.spatialize(p.position);
      const speed = Math.hypot(p.velocity[0], p.velocity[1], p.velocity[2]);
      const height01 = w.peakAltitude > 0.5 ? altitude / w.peakAltitude : 1;
      const f = whistleBaseHz(speed) * (w.incoming ? incomingPitch(height01) : 1) * dopplerRatio(p.position, p.velocity, lis.position, lis.velocity);
      const gain = whistleGain(s.path) * (w.incoming ? 1.4 : 1) * (1 - 0.6 * s.occlusion);
      if (!Number.isFinite(f) || !Number.isFinite(gain)) { m.nanRejected++; continue; }
      const last = w.last;
      if (Math.abs(f - last[0]) > last[0] * 0.002) { w.bp.frequency.setTargetAtTime(f, now, TAU); w.osc.frequency.setTargetAtTime(f, now, TAU); last[0] = f; }
      if (Math.abs(gain - last[1]) > 0.002) { w.voice.out.gain.setTargetAtTime(gain, now, TAU); last[1] = gain; }
      if (Math.abs(s.pan - last[2]) > 0.01) { w.voice.panner!.pan.setTargetAtTime(s.pan, now, TAU); last[2] = s.pan; }
      if (Math.abs(s.lowpass - last[3]) > last[3] * 0.02) { w.voice.lowpass!.frequency.setTargetAtTime(s.lowpass, now, 0.05); last[3] = s.lowpass; }
    }
  }

  private start(m: AudioManager, p: ProjectileLike, now: number): Whistle | null {
    const ctx = m.ctx, s = m.spatialize(p.position);
    const voice = new Voice(ctx, m.buses.input.projectiles, { bus: 'projectiles', priority: PRIORITY.loop, persistent: true,
      spatial: { gain: whistleGain(s.path), pan: s.pan, lowpass: s.lowpass } });
    if (!m.admitLoop(voice)) { voice.dispose(); return null; }
    const f = whistleBaseHz(Math.hypot(p.velocity[0], p.velocity[1], p.velocity[2]));
    const src = ctx.createBufferSource();
    src.buffer = m.pools.white;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 14; bp.frequency.value = f;
    const noiseGain = ctx.createGain(); noiseGain.gain.value = 3.2;
    const osc = ctx.createOscillator(); osc.frequency.value = f;
    const toneGain = ctx.createGain(); toneGain.gain.value = 0.12;
    const env = ctx.createGain();
    env.gain.value = 0;
    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(1, now + FADE_IN);
    src.connect(bp); bp.connect(noiseGain); noiseGain.connect(env);
    osc.connect(toneGain); toneGain.connect(env);
    env.connect(voice.out);
    src.start(now, m.pools.offset(m.pools.white, 0.5));
    osc.start(now);
    voice.sources.push(src, osc);
    voice.nodes.push(src, bp, noiseGain, osc, toneGain, env);
    const w: Whistle = { voice, bp, osc, env, peakAltitude: 0, incoming: false, predictedAt: now, landing: null, last: [f, whistleGain(s.path), s.pan, s.lowpass] };
    this.live.set(p.id, w);
    this.started++;
    return w;
  }

  private release(m: AudioManager, id: number, w: Whistle, now: number): void {
    this.live.delete(id);
    m.releaseLoop(w.voice);
    const g = w.env.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + RELEASE);
    this.dying.push({ voice: w.voice, at: now + RELEASE + 0.05 });
  }

  clear(m: AudioManager, now: number): void {
    for (const [id, w] of this.live) this.release(m, id, w, now);
  }
  dispose(): void {
    for (const w of this.live.values()) w.voice.dispose();
    for (const d of this.dying) d.voice.dispose();
    this.live.clear(); this.dying.length = 0;
  }
}
