/** Shared original industrial electro score and synthesis; caller owns context, bus and clock. */
import { WORLD_COMPOSITIONS, worldScoreStep, type Arrangement } from './arrangements';
export interface ElectroMusicOptions { mode?: 'workshop' | 'skirmish'; arrangement?: Arrangement; seed?: number; offline?: boolean; noise?: AudioBuffer; maxVoices?: number }
type Drum = 'kick' | 'snare' | 'hat';
interface Voice { sources: AudioScheduledSourceNode[]; nodes: AudioNode[]; end: number; bus: 'music' }
export const MUSIC_STEP_SECONDS = 60 / 96 / 4;
const STEP = MUSIC_STEP_SECONDS;
/** Original "Copper Circuit": 96 BPM, a two-bar hook, four-bar answer and sixteen-bar arrangement. */
export function electroScoreStep(step: number) {
  const bar = Math.floor(step / 16) % 16, beat = step % 16, phrase = bar % 8, breakdown = bar === 12 || bar === 13;
  const chords = [[53, 57, 64], [53, 60, 64], [53, 57, 62], [55, 60, 64], [53, 57, 64], [57, 60, 64], [55, 58, 62], [55, 61, 64]];
  const roots = [38, 38, 34, 36, 38, 41, 43, 33];
  // [sixteenth, pitch, gate]: recognizable rhythm is retained through harmonic changes.
  const hooks = [
    [[0, 62, 2], [3, 69, 1], [6, 72, 2], [9, 74, 2], [12, 72, 1], [14, 69, 2]],
    [[1, 65, 2], [4, 64, 1], [7, 62, 3], [12, 57, 2], [15, 60, 1]],
    [[0, 62, 2], [3, 65, 1], [6, 69, 2], [9, 72, 2], [12, 69, 1], [14, 65, 2]],
    [[1, 67, 2], [4, 64, 1], [7, 62, 2], [10, 60, 2], [14, 64, 2]],
    [[0, 74, 3], [4, 72, 2], [7, 69, 2], [11, 65, 2], [14, 69, 2]],
    [[1, 72, 2], [4, 69, 2], [7, 67, 2], [10, 65, 3], [14, 64, 2]],
    [[0, 67, 3], [4, 69, 2], [7, 70, 2], [10, 74, 3], [14, 72, 2]],
    [[0, 73, 2], [3, 69, 1], [6, 64, 2], [10, 61, 2], [14, 64, 2]],
  ];
  const melody = hooks[phrase].find(n => n[0] === beat), bassStep = [0, 3, 6, 8, 11, 14].indexOf(beat);
  const drums: Drum[] = [];
  if ((breakdown ? [0, 8] : [0, 6, 8, bar % 2 ? 14 : 11]).includes(beat)) drums.push('kick');
  if (!breakdown && (beat === 4 || beat === 12 || (bar === 15 && beat === 15))) drums.push('snare');
  if ((breakdown ? [2, 10] : [2, 6, 10, 14]).includes(beat) || (bar > 7 && !breakdown && [7, 15].includes(beat))) drums.push('hat');
  return { notes: beat === 0 ? chords[phrase] : [],
    bass: bassStep >= 0 && (!breakdown || beat % 4 === 0) ? roots[phrase] + [0, 0, 12, 0, 7, 10][bassStep] : undefined,
    lead: melody && (!breakdown || beat < 8) ? melody[1] : undefined, gate: melody?.[2] ?? 1,
    accent: beat % 4 === 0 ? 1 : .78, brightness: breakdown ? .68 : bar > 7 ? 1.16 : 1, drums };
}
export class ElectroMusic {
  private readonly nodes = new Set<AudioNode>(); private readonly voices = new Set<Voice>();
  private readonly musicEcho: GainNode; private readonly noise: AudioBuffer; private readonly mode: 'workshop' | 'skirmish';
  private intensity = .15; private enabled = true; private disposed = false;
  private nextNote: number; private musicStep = 0; private noteCount = 0; private skippedCount = 0;
  private arrangement: Arrangement; private pendingArrangement: Arrangement | null = null;
  private arrangementStart = 0; private transitions = 0; private droppedCount = 0;
  private deck: GainNode; private retired: { node: GainNode; end: number }[] = [];
  constructor(private readonly context: BaseAudioContext, private readonly output: AudioNode, private readonly options: ElectroMusicOptions = {}) {
    this.mode = options.mode ?? 'workshop'; this.nextNote = context.currentTime + .08; this.musicStep = ((options.seed ?? 0) >>> 0) % 2 * 128;
    this.arrangement = options.arrangement ?? 'copper'; this.arrangementStart = this.musicStep;
    this.deck = this.own(context.createGain()); this.deck.connect(output);
    this.noise = options.noise ?? context.createBuffer(1, context.sampleRate, context.sampleRate);
    if (!options.noise) { const data = this.noise.getChannelData(0); let seed = 87291; for (let i = 0; i < data.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; data[i] = seed / 2147483648 - 1; } }
    this.musicEcho = this.own(context.createGain()); this.musicEcho.gain.value = .23;
    for (const side of [-1, 1]) {
      const delay = this.own(context.createDelay(1)), repeat = this.own(context.createGain()), tone = this.own(context.createBiquadFilter()), stereo = this.own(context.createStereoPanner());
      delay.delayTime.value = STEP * (side < 0 ? 3 : 5); repeat.gain.value = .27; tone.type = 'lowpass'; tone.frequency.value = 2150; stereo.pan.value = side * .6;
      this.musicEcho.connect(delay); delay.connect(tone); tone.connect(stereo); stereo.connect(output); tone.connect(repeat); repeat.connect(delay);
    }
  }
  get liveVoices() { return this.voices.size; }
  get notes() { return this.noteCount; }
  get skipped() { return this.skippedCount; }
  get nodeCount() { return this.nodes.size; }
  setIntensity(value: number) { this.intensity = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; }
  setEnabled(enabled: boolean) { this.enabled = enabled; }
  /** Latest request wins; only the arrangement changes, never the transport or effects clock. */
  setArrangement(arrangement: Arrangement) { this.pendingArrangement = arrangement === this.arrangement ? null : arrangement; }
  private changeArrangement(at: number) {
    if (!this.pendingArrangement) return;
    this.arrangement = this.pendingArrangement; this.pendingArrangement = null; this.arrangementStart = this.musicStep; this.transitions++;
    // Old voices finish through a fading deck. One new score is scheduled, with a bar-aligned entrance.
    this.deck.gain.setValueAtTime(1, at); this.deck.gain.linearRampToValueAtTime(0, at + .65);
    this.retired.push({ node: this.deck, end: at + 3 });
    this.deck = this.own(this.context.createGain()); this.deck.gain.value = 0;
    this.deck.gain.setValueAtTime(0, at); this.deck.gain.linearRampToValueAtTime(1, at + .65); this.deck.connect(this.output);
  }
  private own<T extends AudioNode>(node: T): T { this.nodes.add(node); return node; }
  private forget(nodes: AudioNode[]) { for (const node of nodes) { try { node.disconnect(); } catch {} this.nodes.delete(node); } }
  private release(voice: Voice) { if (!this.voices.delete(voice)) return; for (const source of voice.sources) { source.onended = null; try { source.stop(); } catch {} } this.forget(voice.nodes); }
  private admit(voice: Voice) { this.voices.add(voice); voice.sources.at(-1)!.onended = () => this.release(voice); }
  private hasRoom(at: number): boolean {
    // Budget simultaneous audible voices, including voices already queued in the lookahead.
    // Offline renders use the same budget; ended nodes remain connected until rendering finishes.
    let active = 0; for (const voice of this.voices) if (voice.end > at) active++;
    if (active < (this.options.maxVoices ?? 16)) return true;
    this.droppedCount++; return false;
  }
  update() {
    if (this.disposed) return;
    for (const voice of [...this.voices]) if (voice.end <= this.context.currentTime) this.release(voice);
    this.retired = this.retired.filter(deck => { if (deck.end > this.context.currentTime) return true; this.forget([deck.node]); return false; });
    if (!this.options.offline && this.context.state !== 'running') return;
    this.scheduleUntil(this.context.currentTime + .35);
  }
  private note(midi: number, timbre: 'pad' | 'bass' | 'lead', at: number, panValue: number, gate = 1, accent = 1, brightness = 1): void {
    if (!this.hasRoom(this.options.offline ? at : this.context.currentTime)) return;
    const c = this.context, hz = 440 * 2 ** ((midi - 69) / 12), duration = timbre === 'pad' ? STEP * 15 : timbre === 'bass' ? STEP * 1.8 : STEP * gate + .13;
    const gain = this.own(c.createGain()), pan = this.own(c.createStereoPanner()), filter = this.own(c.createBiquadFilter()); filter.type = 'lowpass'; filter.Q.value = timbre === 'lead' ? 1.9 : .65;
    const cutoff = timbre === 'pad' ? 750 : timbre === 'bass' ? 720 : 2600 * brightness * (this.mode === 'skirmish' ? .85 + this.intensity * .55 : 1);
    filter.frequency.setValueAtTime(cutoff * .65, at); filter.frequency.linearRampToValueAtTime(cutoff, at + .018); filter.frequency.exponentialRampToValueAtTime(timbre === 'pad' ? 430 : timbre === 'bass' ? 170 : 650, at + duration);
    const peak = (timbre === 'pad' ? .018 : timbre === 'bass' ? .11 : .078) * accent * (this.mode === 'skirmish' ? .86 + this.intensity * .24 : 1), attack = timbre === 'pad' ? .28 : .008;
    gain.gain.setValueAtTime(.00001, at); gain.gain.linearRampToValueAtTime(peak, at + attack);
    if (timbre === 'lead') gain.gain.exponentialRampToValueAtTime(peak * .34, at + duration * .55);
    gain.gain.exponentialRampToValueAtTime(.00001, at + duration); pan.pan.value = panValue;
    filter.connect(gain); gain.connect(pan); pan.connect(this.deck); if (timbre === 'lead') pan.connect(this.musicEcho!);
    const sources: OscillatorNode[] = [], nodes: AudioNode[] = [gain, pan, filter], ratios = timbre === 'pad' ? [1, 1.004] : timbre === 'bass' ? [1, .5] : [1, 2.001];
    for (const [i, ratio] of ratios.entries()) {
      const oscillator = this.own(c.createOscillator()), partial = this.own(c.createGain()); oscillator.type = timbre === 'pad' ? 'triangle' : timbre === 'bass' && i === 1 ? 'sine' : timbre === 'lead' && this.arrangement !== 'copper' ? WORLD_COMPOSITIONS[this.arrangement].lead : 'sawtooth'; oscillator.frequency.setValueAtTime(hz * ratio * (timbre === 'lead' ? 1.006 : 1), at); oscillator.frequency.exponentialRampToValueAtTime(hz * ratio, at + .045);
      partial.gain.value = i === 0 ? 1 : timbre === 'bass' ? .45 : .2; oscillator.connect(partial); partial.connect(filter); oscillator.start(at); oscillator.stop(at + duration + .015); sources.push(oscillator); nodes.push(oscillator, partial);
    }
    this.admit({ sources, nodes, end: at + duration + .02, bus: 'music' }); this.noteCount++;
  }
  private drum(kind: Drum, at: number, accent: number): void {
    if (!this.hasRoom(this.options.offline ? at : this.context.currentTime)) return;
    const c = this.context, duration = kind === 'kick' ? .27 : kind === 'snare' ? .18 : .075;
    const gain = this.own(c.createGain()), filter = this.own(c.createBiquadFilter()), pan = this.own(c.createStereoPanner());
    const drive = this.mode === 'skirmish' ? .82 + this.intensity * .58 : .82;
    const peak = (kind === 'kick' ? .11 : kind === 'snare' ? .038 : .018) * accent * drive;
    gain.gain.setValueAtTime(.00001, at); gain.gain.linearRampToValueAtTime(peak, at + .002); gain.gain.exponentialRampToValueAtTime(.00001, at + duration);
    filter.type = kind === 'hat' ? 'highpass' : 'lowpass'; filter.frequency.value = kind === 'kick' ? 1000 : kind === 'snare' ? 4400 : 5600; filter.Q.value = .55;
    pan.pan.value = kind === 'hat' ? .28 : kind === 'snare' ? -.14 : 0; filter.connect(gain); gain.connect(pan); pan.connect(this.deck);
    let source: AudioBufferSourceNode | OscillatorNode;
    if (kind === 'kick') { const oscillator = this.own(c.createOscillator()); oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(137, at); oscillator.frequency.exponentialRampToValueAtTime(48, at + .065); oscillator.frequency.exponentialRampToValueAtTime(43, at + duration); source = oscillator; }
    else { const noise = this.own(c.createBufferSource()); noise.buffer = this.noise; noise.loop = true; source = noise; }
    source.connect(filter); source.start(at); source.stop(at + duration + .005);
    this.admit({ sources: [source], nodes: [source, gain, filter, pan], end: at + duration + .02, bus: 'music' }); this.noteCount++;
  }
  /** Normal runtime uses a short lookahead; OfflineAudioContext can schedule an entire audition. */
  scheduleUntil(until: number): void {
    const c = this.context; if (this.disposed) return;
    if (this.nextNote < c.currentTime - .05) { const skipped = Math.ceil((c.currentTime - this.nextNote) / STEP); this.skippedCount += skipped; this.musicStep += skipped; this.nextNote += skipped * STEP; }
    while (this.nextNote < until) {
      const at = this.nextNote + (this.musicStep % 2 ? .009 : 0);
      if (this.musicStep % 16 === 0) this.changeArrangement(at);
      // Muting advances the clock but creates no voices. Unmuting joins the current phrase.
      if (!this.enabled) { this.musicStep++; this.nextNote += STEP; continue; }
      const step = this.musicStep - this.arrangementStart;
      const score = this.arrangement === 'copper' ? electroScoreStep(step) : worldScoreStep(step, this.arrangement);
      score.notes.forEach((note, i) => this.note(note, 'pad', at + i * .018, (i - 1) * .35));
      if (score.bass !== undefined) this.note(score.bass, 'bass', at, 0, 1, score.accent);
      if (score.lead !== undefined) this.note(score.lead, 'lead', at, Math.floor(this.musicStep / 16) % 2 ? .12 : -.12, score.gate, score.accent, score.brightness);
      if (this.mode === 'skirmish' && this.intensity > .55 && this.musicStep % 4 === 0 && !score.drums.includes('hat')) score.drums.push('hat');
      score.drums.forEach(kind => this.drum(kind, at, kind === 'hat' && this.musicStep % 4 !== 2 ? .55 : .85));
      this.musicStep++; this.nextNote += STEP;
    }
  }
  snapshot() { return { mode: this.mode, arrangement: this.arrangement, title: this.arrangement === 'copper' ? 'Copper Circuit' : WORLD_COMPOSITIONS[this.arrangement].title, pendingArrangement: this.pendingArrangement, transitions: this.transitions, intensity: this.intensity, enabled: this.enabled, disposed: this.disposed, voices: this.liveVoices, nodes: this.nodeCount, notes: this.notes, skipped: this.skipped, dropped: this.droppedCount, step: this.musicStep, bar: Math.floor((this.musicStep - this.arrangementStart) / 16) % 32 }; }
  dispose() { if (this.disposed) return; this.disposed = true; for (const voice of [...this.voices]) this.release(voice); this.forget([...this.nodes]); }
}
