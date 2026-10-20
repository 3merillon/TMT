/** Quiet, original synthesized world beds, sharing the engine's existing noise pools.
 * Two noise readers, one resonant oscillator and one slow LFO; no per-frame allocations. */
import type { PlanetKind } from '../world/sun';
import type { NoisePools } from './noise-pools';

export const WORLD_SOUNDS: Readonly<Record<PlanetKind, { low: number; air: number; tone: number; hz: number; band: number; pulse: number }>> = {
  temperate: { low: .015, air: .013, tone: .001, hz: 392, band: 1800, pulse: .12 },
  glacial: { low: .008, air: .009, tone: .006, hz: 659.25, band: 3900, pulse: .055 },
  dune: { low: .013, air: .021, tone: .003, hz: 164.81, band: 2800, pulse: .085 },
  volcanic: { low: .047, air: .008, tone: .01, hz: 49, band: 680, pulse: .19 },
};

export class WorldSoundscape {
  private nodes: AudioNode[] = [];
  private sources: AudioScheduledSourceNode[] = [];
  private output: GainNode;
  private low: GainNode; private air: GainNode; private tone: GainNode;
  private band: BiquadFilterNode; private rumble: BiquadFilterNode; private oscillator: OscillatorNode; private lfo: OscillatorNode;
  private world: PlanetKind = 'temperate'; private active = false; private started = false; private disposed = false;
  /** `start` false leaves the beds unstarted (before the first user gesture) until start(). */
  constructor(private ctx: BaseAudioContext, destination: AudioNode, private readonly pools: NoisePools, start = true) {
    const own = <T extends AudioNode>(node: T): T => { this.nodes.push(node); return node; };
    const gain = (v: number) => { const n = own(ctx.createGain()); n.gain.value = v; return n; };
    this.output = gain(0);
    this.low = gain(0); this.air = gain(0); this.tone = gain(0);
    this.rumble = own(ctx.createBiquadFilter()); this.rumble.type = 'lowpass'; this.rumble.frequency.value = 200; this.rumble.Q.value = .5;
    this.band = own(ctx.createBiquadFilter()); this.band.type = 'bandpass'; this.band.Q.value = .8;
    this.oscillator = own(ctx.createOscillator()); this.oscillator.type = 'sine'; this.oscillator.connect(this.tone);
    const breath = gain(.18), swell = gain(.8); this.lfo = own(ctx.createOscillator()); this.lfo.frequency.value = .1; this.lfo.connect(breath); breath.connect(swell.gain);
    this.output.connect(swell); swell.connect(destination);
    this.setWorld('temperate');
    if (start) this.start();
  }
  /** Starts the beds (once). The noise readers are made here: a browser may take a pool's contents as soon as a source
   * holds it, and the pools are final only now. Inputs join the output in the order the mix always summed them. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    for (const [buffer, filter, out, pan] of [[this.pools.brown, this.rumble, this.low, -.3], [this.pools.pinkR, this.band, this.air, .35]] as const) {
      const source = this.ctx.createBufferSource(), stereo = this.ctx.createStereoPanner(); this.nodes.push(source, stereo); source.buffer = buffer; source.loop = true; stereo.pan.value = pan;
      source.connect(filter); filter.connect(out); out.connect(stereo); stereo.connect(this.output); source.start(); this.sources.push(source);
    }
    this.tone.connect(this.output); this.oscillator.start(); this.lfo.start(); this.sources.push(this.oscillator, this.lfo);
  }
  setWorld(world: PlanetKind, at = this.ctx.currentTime): void {
    if (this.disposed) return; this.world = world; const p = WORLD_SOUNDS[world];
    for (const [param, value] of [[this.low.gain, p.low], [this.air.gain, p.air], [this.tone.gain, p.tone], [this.oscillator.frequency, p.hz], [this.band.frequency, p.band], [this.lfo.frequency, p.pulse]] as const) {
      param.cancelScheduledValues(at); param.setTargetAtTime(value, at, 1.2);
    }
  }
  setActive(active: boolean, at = this.ctx.currentTime): void { if (this.disposed) return; this.active = active; this.output.gain.cancelScheduledValues(at); this.output.gain.setTargetAtTime(active ? 1 : 0, at, .65); }
  snapshot() { return { world: this.world, active: this.active, voices: this.disposed ? 0 : 4, nodes: this.nodes.length }; }
  dispose(): void { if (this.disposed) return; this.disposed = true; for (const source of this.sources) try { source.stop(); } catch {} for (const node of this.nodes) node.disconnect(); this.sources = []; this.nodes = []; }
}
