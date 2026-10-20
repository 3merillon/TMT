/**
 * A minimal, counting fake of the WebAudio API for Node tests (there is no OfflineAudioContext in Node). Test-only:
 * nothing in the runtime imports it, so it never ships.
 *
 * It validates like the real API where it matters for correctness: non-finite values and times throw TypeError,
 * negative times and exponential ramps to ≤ 0 throw RangeError, a source cannot start twice or stop before starting.
 * It counts every created node and every createBuffer call (the no-per-one-shot-allocation test), and records the
 * automation events of every AudioParam so tests can evaluate envelopes.
 */

type Event = { type: 'set' | 'linear' | 'exp' | 'target' | 'cancel'; value: number; time: number; tc?: number };

export class FakeParam {
  readonly events: Event[] = [];
  constructor(public value: number, readonly owner: FakeNode, readonly name: string) {}
  private check(value: number, time: number): void {
    if (!Number.isFinite(value)) throw new TypeError(`${this.owner.kind}.${this.name}: non-finite value ${value}`);
    if (!Number.isFinite(time)) throw new TypeError(`${this.owner.kind}.${this.name}: non-finite time ${time}`);
    if (time < 0) throw new RangeError(`${this.owner.kind}.${this.name}: negative time ${time}`);
    this.owner.ctx.automationCalls++;
  }
  setValueAtTime(value: number, time: number): this { this.check(value, time); this.events.push({ type: 'set', value, time }); return this; }
  linearRampToValueAtTime(value: number, time: number): this { this.check(value, time); this.events.push({ type: 'linear', value, time }); return this; }
  exponentialRampToValueAtTime(value: number, time: number): this {
    this.check(value, time);
    if (!(value > 0)) throw new RangeError(`${this.owner.kind}.${this.name}: exponential ramp to ${value}`);
    this.events.push({ type: 'exp', value, time });
    return this;
  }
  setTargetAtTime(value: number, time: number, tc: number): this {
    this.check(value, time);
    if (!Number.isFinite(tc) || tc < 0) throw new RangeError(`${this.owner.kind}.${this.name}: bad time constant ${tc}`);
    this.events.push({ type: 'target', value, time, tc });
    return this;
  }
  cancelScheduledValues(time: number): this {
    if (!Number.isFinite(time) || time < 0) throw new RangeError(`${this.owner.kind}.${this.name}: bad cancel time ${time}`);
    for (let i = this.events.length - 1; i >= 0; i--) if (this.events[i].time >= time) this.events.splice(i, 1);
    this.events.push({ type: 'cancel', value: NaN, time });
    return this;
  }
  cancelAndHoldAtTime(time: number): this { return this.cancelScheduledValues(time); }
  /** Recorded as a linear segment to the curve's last value (enough for envelope tests). */
  setValueCurveAtTime(values: Float32Array, time: number, duration: number): this {
    this.check(values[0], time);
    if (!(duration > 0) || !values.length) throw new RangeError(`${this.owner.kind}.${this.name}: bad curve`);
    this.events.push({ type: 'set', value: values[0], time }); this.events.push({ type: 'linear', value: values[values.length - 1], time: time + duration });
    return this;
  }
  /** Evaluates the automation at time t (set, linear, exponential and target events; enough for envelope tests). */
  valueAt(t: number): number {
    let v = this.value, prevT = 0, prevV = this.value;
    const events = this.events.filter(e => e.type !== 'cancel').sort((a, b) => a.time - b.time);
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.type === 'set') { if (e.time > t) break; v = prevV = e.value; prevT = e.time; continue; }
      if (e.type === 'target') {
        if (e.time > t) break;
        const next = events[i + 1];
        const end = next ? Math.min(t, next.time) : t;
        v = e.value + (prevV - e.value) * Math.exp(-(end - e.time) / Math.max(1e-9, e.tc ?? 0));
        prevV = v; prevT = end;
        if (next && next.time <= t) continue;
        break;
      }
      if (e.time <= t) { v = prevV = e.value; prevT = e.time; continue; }
      const k = (t - prevT) / Math.max(1e-12, e.time - prevT);
      v = e.type === 'linear' ? prevV + (e.value - prevV) * k : prevV * Math.pow(e.value / prevV, k);
      break;
    }
    return v;
  }
}

export class FakeNode {
  readonly outputs = new Set<FakeNode | FakeParam>();
  readonly params: FakeParam[] = [];
  disconnected = false;
  constructor(readonly ctx: FakeAudioContext, readonly kind: string) { ctx.count(kind); }
  protected param(name: string, value: number): FakeParam { const p = new FakeParam(value, this, name); this.params.push(p); return p; }
  connect<T extends FakeNode | FakeParam>(dest: T): T {
    if (!(dest instanceof FakeNode) && !(dest instanceof FakeParam)) throw new TypeError(`${this.kind}.connect: not a node or param`);
    this.outputs.add(dest);
    return dest;
  }
  disconnect(): void { this.outputs.clear(); this.disconnected = true; }
}

class FakeScheduled extends FakeNode {
  started = -1; stopped = -1;
  onended: (() => void) | null = null;
  start(when = 0, _offset?: number, duration?: number): void {
    if (this.started >= 0) throw new Error(`${this.kind}: start() called twice`);
    for (const v of [when, _offset ?? 0, duration ?? 0]) if (!Number.isFinite(v) || v < 0) throw new RangeError(`${this.kind}.start: bad argument ${v}`);
    this.started = when;
  }
  stop(when = 0): void {
    if (this.started < 0) throw new Error(`${this.kind}: stop() before start()`);
    if (!Number.isFinite(when) || when < 0) throw new RangeError(`${this.kind}.stop: bad time ${when}`);
    this.stopped = when;
  }
}

export class FakeAudioBuffer {
  private readonly channels: Float32Array[];
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  get duration(): number { return this.length / this.sampleRate; }
  getChannelData(channel: number): Float32Array { return this.channels[channel]; }
}

export class FakeGain extends FakeNode { readonly gain = this.param('gain', 1); constructor(c: FakeAudioContext) { super(c, 'gain'); } }
export class FakeBiquad extends FakeNode {
  type = 'lowpass';
  readonly frequency = this.param('frequency', 350); readonly Q = this.param('Q', 1); readonly gain = this.param('gain', 0); readonly detune = this.param('detune', 0);
  constructor(c: FakeAudioContext) { super(c, 'biquad'); }
}
export class FakeBufferSource extends FakeScheduled {
  buffer: FakeAudioBuffer | null = null; loop = false; loopStart = 0; loopEnd = 0;
  readonly playbackRate = this.param('playbackRate', 1); readonly detune = this.param('detune', 0);
  constructor(c: FakeAudioContext) { super(c, 'bufferSource'); }
  override start(when = 0, offset?: number, duration?: number): void {
    if (!this.buffer) throw new Error('bufferSource.start without a buffer');
    super.start(when, offset, duration);
  }
}
export class FakeOscillator extends FakeScheduled {
  type = 'sine';
  readonly frequency = this.param('frequency', 440); readonly detune = this.param('detune', 0);
  constructor(c: FakeAudioContext) { super(c, 'oscillator'); }
}
export class FakeConstantSource extends FakeScheduled { readonly offset = this.param('offset', 1); constructor(c: FakeAudioContext) { super(c, 'constantSource'); } }
export class FakeStereoPanner extends FakeNode { readonly pan = this.param('pan', 0); constructor(c: FakeAudioContext) { super(c, 'stereoPanner'); } }
export class FakeCompressor extends FakeNode {
  readonly threshold = this.param('threshold', -24); readonly knee = this.param('knee', 30); readonly ratio = this.param('ratio', 12);
  readonly attack = this.param('attack', 0.003); readonly release = this.param('release', 0.25); reduction = 0;
  constructor(c: FakeAudioContext) { super(c, 'compressor'); }
}
export class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  /** What getFloatTimeDomainData reports (a constant level; tests set it to probe the meters). */
  level = 0;
  constructor(c: FakeAudioContext) { super(c, 'analyser'); }
  getFloatTimeDomainData(out: Float32Array): void { out.fill(this.level); }
}
export class FakeDelay extends FakeNode { readonly delayTime = this.param('delayTime', 0); constructor(c: FakeAudioContext) { super(c, 'delay'); } }
export class FakeConvolver extends FakeNode { buffer: FakeAudioBuffer | null = null; normalize = true; constructor(c: FakeAudioContext) { super(c, 'convolver'); } }
export class FakeWaveShaper extends FakeNode { curve: Float32Array | null = null; oversample = 'none'; constructor(c: FakeAudioContext) { super(c, 'waveShaper'); } }
export class FakeWorkletNode extends FakeNode {
  readonly parameters = new Map<string, FakeParam>();
  constructor(c: FakeAudioContext, readonly name: string, names: readonly string[]) {
    super(c, 'worklet');
    for (const n of names) this.parameters.set(n, this.param(n, 0));
  }
}

export class FakeAudioContext {
  currentTime = 0;
  readonly sampleRate: number;
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  readonly destination: FakeNode;
  readonly counts = new Map<string, number>();
  buffersCreated = 0;
  automationCalls = 0;
  readonly workletModules: string[] = [];
  readonly audioWorklet = { addModule: async (url: string | URL) => { this.workletModules.push(String(url)); } };
  onstatechange: (() => void) | null = null;

  constructor(sampleRate = 8000) {
    // A low default sample rate keeps pool generation fast in tests; the graph logic does not depend on it.
    this.sampleRate = sampleRate;
    this.destination = new FakeNode(this, 'destination');
  }
  count(kind: string): void { this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1); }
  nodeCount(kind?: string): number {
    if (kind) return this.counts.get(kind) ?? 0;
    let n = 0; for (const [k, v] of this.counts) if (k !== 'destination') n += v; return n;
  }
  createBuffer(channels: number, length: number, sampleRate: number): FakeAudioBuffer {
    if (!(channels >= 1) || !(length >= 1) || !(sampleRate > 0)) throw new RangeError(`createBuffer(${channels}, ${length}, ${sampleRate})`);
    this.buffersCreated++;
    return new FakeAudioBuffer(channels, length, sampleRate);
  }
  createGain() { return new FakeGain(this); }
  createBiquadFilter() { return new FakeBiquad(this); }
  createBufferSource() { return new FakeBufferSource(this); }
  createOscillator() { return new FakeOscillator(this); }
  createConstantSource() { return new FakeConstantSource(this); }
  createStereoPanner() { return new FakeStereoPanner(this); }
  createDynamicsCompressor() { return new FakeCompressor(this); }
  createAnalyser() { return new FakeAnalyser(this); }
  createDelay() { return new FakeDelay(this); }
  createConvolver() { return new FakeConvolver(this); }
  createWaveShaper() { return new FakeWaveShaper(this); }
  createChannelMerger() { return new FakeNode(this, 'merger'); }
  createChannelSplitter() { return new FakeNode(this, 'splitter'); }
  async resume(): Promise<void> { this.state = 'running'; this.onstatechange?.(); }
  async suspend(): Promise<void> { this.state = 'suspended'; this.onstatechange?.(); }
  async close(): Promise<void> { this.state = 'closed'; this.onstatechange?.(); }
  /** Advances the clock. */
  advance(seconds: number): void { this.currentTime += seconds; }
  /** The fake as the DOM type the runtime code expects. */
  asAudioContext(): AudioContext { return this as unknown as AudioContext; }
}

/** Every node reachable from `from` (a graph walk over outputs). */
export function reachable(from: FakeNode): Set<FakeNode> {
  const seen = new Set<FakeNode>(), stack: FakeNode[] = [from];
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const o of n.outputs) if (o instanceof FakeNode) stack.push(o);
  }
  return seen;
}
