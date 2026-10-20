/**
 * Engine and tread loops for the nearest 4 tanks. Four slots, each a persistent AudioWorkletNode (engine-processor)
 * behind a spatial head on the vehicles bus, created once; tanks are assigned to slots by the hysteretic loop selector,
 * so walking along the edge of the range never rebuilds anything. Per frame the main thread writes six k-rate params
 * and the head's gain, pan and low-pass, each behind a deadband.
 *
 * If the worklet cannot load, a native-node fallback (sawtooth + sub, a load low-pass, AM tread noise) keeps the
 * tanks audible.
 */
import type { AudioManager } from './audio-manager';
import { Voice } from './sfx/layers';
import { engineParams } from './sfx/tank-sfx-math';
import { PRIORITY, selectLoopVoices, type LoopCandidate } from './voice-select';
import { ENGINE_PARAMS, ENGINE_PROCESSOR, type EngineParamName } from './worklets/engine-params';
import { turretMotionRate, type TurretPose } from './turret-motion';

export interface LoopTank extends TurretPose {
  trackSpeeds?: readonly number[];
  trackSlip?: readonly number[];
  trackContact?: readonly number[];
  health?: number;
  maxHealth?: number;
  yawVelocity?: number;
  /** Only driving chassis get an engine loop: swarms and air units have their own loops (actor-loops.ts). */
  motionKind?: 'chassis' | 'swarm' | 'air';
  retired?: boolean;
}

export const MAX_ENGINE_LOOPS = 4;
/** Engine loops are audible out to about this distance (u). */
export const ENGINE_RANGE = 30;
const FADE_IN = 0.2, FADE_OUT = 0.3, TAU = 0.05;
const SIM_HZ = 60;

/** A node with named AudioParams: the AudioWorkletNode, or the fallback's adapter. */
export interface LoopNode { node: AudioNode; params: Record<EngineParamName, AudioParam>; sources: AudioScheduledSourceNode[]; nodes: AudioNode[] }
export type LoopNodeFactory = (ctx: BaseAudioContext, seed: number) => LoopNode;
interface FallbackParams { sub: AudioParam; treadGain: AudioParam; lowpass: AudioParam }

interface Slot {
  loop: LoopNode;
  voice: Voice;
  tank: number;
  admitted: boolean;
  fadeUntil: number;
  last: Float64Array;           // eight engine params + gain + pan + low-pass
}
interface TankMotion extends TurretPose { tick: number; speed: number; accel: number; turretRate: number }

export const workletLoopNode: LoopNodeFactory = (ctx, seed) => {
  const node = new AudioWorkletNode(ctx, ENGINE_PROCESSOR, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { seed } });
  const params = {} as Record<EngineParamName, AudioParam>;
  // AudioParamMap is maplike; the TS lib (without DOM.Iterable) omits get().
  const map = node.parameters as unknown as ReadonlyMap<string, AudioParam>;
  for (const name of ENGINE_PARAMS) {
    const p = map.get(name);
    if (!p) throw new Error(`engine worklet has no '${name}' parameter`);
    params[name] = p;
  }
  return { node, params, sources: [], nodes: [node] };
};

/** Native fallback: sawtooth + sub through a load low-pass, plus AM band noise for the treads. */
export function fallbackLoopNodeFor(pools: { white: AudioBuffer }): LoopNodeFactory {
  return (ctx) => {
    const out = ctx.createGain();
    const saw = ctx.createOscillator(), sub = ctx.createOscillator(), lp = ctx.createBiquadFilter(), engineGain = ctx.createGain();
    saw.type = 'sawtooth'; sub.type = 'sine';
    lp.type = 'lowpass'; lp.Q.value = 0.7; lp.frequency.value = 900;
    engineGain.gain.value = 0.25;
    saw.connect(lp); sub.connect(lp); lp.connect(engineGain); engineGain.connect(out);
    const noise = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), am = ctx.createGain(), amOsc = ctx.createOscillator(), treadGain = ctx.createGain();
    noise.buffer = pools.white; noise.loop = true;
    bp.type = 'bandpass'; bp.frequency.value = 1700; bp.Q.value = 1.5;
    am.gain.value = 0.5; amOsc.type = 'square'; amOsc.frequency.value = 1;
    const amDepth = ctx.createGain(); amDepth.gain.value = 0.5;
    amOsc.connect(amDepth); amDepth.connect(am.gain);
    treadGain.gain.value = 0;
    noise.connect(bp); bp.connect(am); am.connect(treadGain); treadGain.connect(out);
    // Params with a one-to-one native target map directly; slip and servo have no fallback voice (unconnected gains).
    const level = ctx.createGain(); level.gain.value = 0;
    out.connect(level);
    for (const s of [saw, sub, noise, amOsc]) s.start();
    const dummy = () => ctx.createGain().gain;
    const params: Record<EngineParamName, AudioParam> = {
      fundamental: saw.frequency, load: dummy(), tread: amOsc.frequency, slip: dummy(), servo: dummy(), level: level.gain, turn: dummy(), damage: dummy(),
    };
    return { node: level, params, sources: [saw, sub, noise, amOsc], nodes: [out, saw, sub, lp, engineGain, noise, bp, am, amOsc, amDepth, treadGain, level],
      // The fallback maps some params itself (see TankLoops.write).
      fallback: { sub: sub.frequency, treadGain: treadGain.gain, lowpass: lp.frequency } } as LoopNode & { fallback: FallbackParams };
  };
}

export class TankLoops {
  private readonly slots: Slot[] = [];
  private readonly motion = new Map<number, TankMotion>();
  private readonly cands: LoopCandidate[] = [];
  private readonly selected = new Set<number>();
  mode: 'off' | 'pending' | 'worklet' | 'fallback' = 'off';
  error: string | null = null;

  constructor(private readonly m: AudioManager) {}

  /** Loads the worklet (or falls back) and builds the four slots. `factory` overrides node creation (tests). */
  async init(workletUrl: string | null, factory?: LoopNodeFactory): Promise<void> {
    this.mode = 'pending';
    let make = factory;
    if (!make) {
      try {
        const ctx = this.m.ctx as BaseAudioContext & { audioWorklet?: AudioWorklet };
        if (!workletUrl || !ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') throw new Error('AudioWorklet is unavailable');
        await ctx.audioWorklet.addModule(workletUrl);
        make = workletLoopNode;
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        make = fallbackLoopNodeFor(this.m.pools);
      }
    }
    for (let i = 0; i < MAX_ENGINE_LOOPS; i++) {
      const loop = make(this.m.ctx, 0x9e3779b9 ^ (i * 0x85ebca6b));
      const voice = new Voice(this.m.ctx, this.m.buses.input.vehicles, { bus: 'vehicles', priority: PRIORITY.loop, persistent: true, spatial: { gain: 0, pan: 0, lowpass: 18000 } });
      loop.node.connect(voice.out);
      voice.sources.push(...loop.sources);
      voice.nodes.push(...loop.nodes);
      this.slots.push({ loop, voice, tank: -1, admitted: false, fadeUntil: 0, last: new Float64Array(11).fill(NaN) });
    }
    this.mode = factory ? 'worklet' : make === workletLoopNode ? 'worklet' : 'fallback';
  }

  get active(): number { let n = 0; for (const s of this.slots) if (s.tank >= 0) n++; return n; }
  tanks(): number[] { return this.slots.filter(s => s.tank >= 0).map(s => s.tank); }

  reset(now: number): void {
    for (const s of this.slots) if (s.tank >= 0) this.unassign(s, now);
    this.motion.clear();
  }

  update(tanks: readonly LoopTank[], tick: number, now: number): void {
    if (!this.slots.length) return;
    // Retire slots whose fade-out has finished.
    for (const s of this.slots) if (s.tank < 0 && s.admitted && now >= s.fadeUntil) { this.m.releaseLoop(s.voice); s.admitted = false; }
    const cands = this.cands;
    cands.length = 0;
    for (let i = 0; i < tanks.length; i++) {
      const t = tanks[i];
      if ((t.health ?? 1) <= 0 || t.retired || (t.motionKind !== undefined && t.motionKind !== 'chassis')) continue;
      const s = this.m.spatialize(t.position);
      cands.push({ id: i, dist: s.path, range: ENGINE_RANGE, live: this.slots.some(slot => slot.tank === i) });
    }
    selectLoopVoices(cands, MAX_ENGINE_LOOPS, this.selected);
    for (const s of this.slots) if (s.tank >= 0 && !this.selected.has(s.tank)) this.unassign(s, now);
    for (const id of this.selected) {
      if (this.slots.some(s => s.tank === id)) continue;
      const free = this.slots.find(s => s.tank < 0 && !s.admitted) ?? this.slots.find(s => s.tank < 0);
      if (free) this.assign(free, id, now);
    }
    for (const s of this.slots) {
      if (s.tank < 0) continue;
      const t = tanks[s.tank];
      if (!t) { this.unassign(s, now); continue; }
      this.write(s, t, s.tank, tick, now);
    }
  }

  private assign(s: Slot, tank: number, now: number): void {
    if (!s.admitted) {
      if (!this.m.admitLoop(s.voice)) return;
      s.admitted = true;
    }
    s.tank = tank;
    s.last.fill(NaN);
    const level = s.loop.params.level;
    level.cancelScheduledValues(now);
    level.setValueAtTime(0, now);
    this.motion.delete(tank);
    s.fadeUntil = now + FADE_IN;
  }

  private unassign(s: Slot, now: number): void {
    const level = s.loop.params.level;
    level.cancelScheduledValues(now);
    level.setTargetAtTime(0, now, FADE_OUT / 4);
    s.tank = -1;
    s.fadeUntil = now + FADE_OUT;
  }

  private write(s: Slot, t: LoopTank, id: number, tick: number, now: number): void {
    const left = t.trackSpeeds?.[0] ?? 0, right = t.trackSpeeds?.[1] ?? 0;
    const speed = (Math.abs(left) + Math.abs(right)) * 0.5;
    let mo = this.motion.get(id);
    if (!mo) {
      mo = { tick, speed, accel: 0, position: [...t.position], rotation: [...t.rotation],
        turretYaw: t.turretYaw, barrelPitch: t.barrelPitch, turretRate: 0 };
      this.motion.set(id, mo);
    }
    else if (tick !== mo.tick) {
      const dt = Math.max(1, tick - mo.tick) / SIM_HZ;
      const accel = (speed - mo.speed) / dt;
      mo.turretRate = tick > mo.tick ? turretMotionRate(mo, t, dt) : 0;
      // Light smoothing: the sim updates at 60 Hz, the display may not.
      mo.accel += (accel - mo.accel) * 0.3;
      mo.tick = tick; mo.speed = speed; mo.turretYaw = t.turretYaw; mo.barrelPitch = t.barrelPitch;
      // Copy the values: the simulation can update its pose arrays in place.
      for (let i = 0; i < 3; i++) mo.position[i] = t.position[i];
      for (let i = 0; i < 4; i++) mo.rotation[i] = t.rotation[i];
    }
    const slip = Math.max(Math.abs(t.trackSlip?.[0] ?? 0), Math.abs(t.trackSlip?.[1] ?? 0));
    const contact = Math.max(t.trackContact?.[0] ?? 1, t.trackContact?.[1] ?? 1);
    const p = engineParams({ speed, accel: mo.accel, slip, contact, turretRate: mo.turretRate, yawRate: t.yawVelocity, health: t.health !== undefined ? t.health / Math.max(1, t.maxHealth ?? 100) : 1 });
    const sp = this.m.spatialize(t.position);
    const L = s.last, P = s.loop.params;
    const put = (i: number, param: AudioParam, v: number, rel: number, tau = TAU) => {
      if (!Number.isFinite(v)) { this.m.nanRejected++; return; }
      if (L[i] === L[i] && Math.abs(v - L[i]) <= Math.max(1e-4, Math.abs(L[i]) * rel)) return;
      param.setTargetAtTime(v, now, tau);
      L[i] = v;
    };
    put(0, P.fundamental, p.fundamental, 0.004);
    put(1, P.load, p.load, 0.01);
    put(2, P.tread, p.tread, 0.01);
    put(3, P.slip, p.slip, 0.02);
    // A short attack keeps deliberate adjustment responsive; release becomes inaudible within ~150 ms.
    put(4, P.servo, p.servo, 0.02, p.servo > L[4] ? .022 : .045);
    put(5, P.level, p.level, 0.01, now < s.fadeUntil ? FADE_IN / 3 : TAU);
    put(6, s.voice.out.gain, sp.gain, 0.01);
    put(7, s.voice.panner!.pan, sp.pan, 0.01);
    put(8, s.voice.lowpass!.frequency, sp.lowpass, 0.02, 0.08);
    if (P.turn) put(9, P.turn, p.turn, 0.02);
    if (P.damage) put(10, P.damage, p.damage, 0.02);
    const fb = (s.loop as LoopNode & { fallback?: FallbackParams }).fallback;
    if (fb) {
      fb.sub.setTargetAtTime(p.fundamental * 0.5, now, TAU);
      fb.treadGain.setTargetAtTime(Math.min(1, p.tread / 20) * 0.4, now, TAU);
      fb.lowpass.setTargetAtTime(600 + 2900 * p.load, now, TAU);
    }
  }

  dispose(): void {
    for (const s of this.slots) { if (s.admitted) this.m.releaseLoop(s.voice); s.voice.dispose(); }
    this.slots.length = 0;
  }
}
