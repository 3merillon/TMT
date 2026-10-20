/** The audio built ahead of the first gesture is the audio the gesture would have built: identical noise, impulse
 * response and graph, no source started before the gesture, and nothing synthesised inside it. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoisePools } from '../src/audio/noise-pools';
import { TankAudioIntegrator } from '../src/audio/integrator';
import { FakeAudioBuffer, FakeAudioContext, FakeBufferSource, FakeConstantSource, FakeConvolver, FakeOscillator } from '../src/audio/testing/fake-audio-context';
import type { MatchSetup } from '../src/game/api/match';

type Scheduled = FakeBufferSource | FakeOscillator | FakeConstantSource;
/** A fake context that keeps every scheduled source and convolver it made. */
class Recording extends FakeAudioContext {
  readonly scheduled: Scheduled[] = [];
  readonly convolvers: FakeConvolver[] = [];
  override createBufferSource() { const n = super.createBufferSource(); this.scheduled.push(n); return n; }
  override createOscillator() { const n = super.createOscillator(); this.scheduled.push(n); return n; }
  override createConstantSource() { const n = super.createConstantSource(); this.scheduled.push(n); return n; }
  override createConvolver() { const n = super.createConvolver(); this.convolvers.push(n); return n; }
}
const engines = vi.hoisted(() => [] as unknown[]);
vi.mock('../src/audio/engine-entry', async () => {
  const { TankAudioIntegrator: Engine } = await import('../src/audio/integrator');
  return {
    createAudioEngine: (ctx: AudioContext, o: object = {}) => {
      const engine = new Engine(ctx, { ...o, loopFactory: c => { const node = c.createGain(); return { node, params: Object.fromEntries(['fundamental', 'load', 'tread', 'slip', 'servo', 'level'].map(k => [k, c.createGain().gain])) as never, sources: [], nodes: [node] }; } });
      engines.push(engine); return engine;
    },
    installUi: () => () => {},
  };
});
afterEach(() => { vi.useRealTimers(); for (const engine of engines.splice(0)) (engine as TankAudioIntegrator).dispose(); vi.unstubAllGlobals(); vi.resetModules(); });

const channels = (b: AudioBuffer | FakeAudioBuffer) => Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c));
function expectSameBuffer(a: AudioBuffer | FakeAudioBuffer, b: AudioBuffer | FakeAudioBuffer) {
  expect([a.numberOfChannels, a.length, a.sampleRate]).toEqual([b.numberOfChannels, b.length, b.sampleRate]);
  channels(a).forEach((data, c) => expect(Buffer.from(data.buffer, data.byteOffset, data.byteLength).equals(Buffer.from(channels(b)[c].buffer, channels(b)[c].byteOffset, channels(b)[c].byteLength))).toBe(true));
}
function expectSamePools(a: NoisePools, b: NoisePools) {
  for (const key of ['white', 'brown', 'pinkL', 'pinkR'] as const) expectSameBuffer(a[key], b[key]);
  for (const d of [0.05, 0.4, 1.2, 3]) expect(a.offset(a.white, d)).toBe(b.offset(b.white, d));
}
const setup = (seed: number) => ({ id: 't', seed, mode: 'drive', planet: { kind: 'dune' }, teams: [], tanks: [], objectives: [],
  rules: { moveSeconds: 4, wind: null, fog: true, projectileAge: 8, gravityScale: 1, ammo: {}, radarCost: 3, startCharge: 1, friendlyFire: true,
    commitWindowTicks: 12, turnModel: 'tempo', brace: false, taps: false, overdrive: false, supplyEvery: 0, fallDamage: false } }) as unknown as MatchSetup;

describe('noise pools reseeded in place', () => {
  it('hold exactly the pools of a fresh construction with that seed', () => {
    const ctx = new FakeAudioContext(48000), fresh = new NoisePools(ctx as unknown as BaseAudioContext, 7 ^ 0x9e37);
    const reseeded = new NoisePools(ctx as unknown as BaseAudioContext, 0x7a11 ^ 0x9e37);
    reseeded.reseed(7 ^ 0x9e37);
    expectSamePools(reseeded, fresh);
  });
});

describe('a standby engine', () => {
  it('starts nothing until start(), then matches an engine built in the gesture: buffers, impulse response and graph', async () => {
    const standbyCtx = new Recording(48000), gestureCtx = new Recording(48000);
    const standby = new TankAudioIntegrator(standbyCtx.asAudioContext(), { seed: 0x7a11, standby: true, music: false, loopFactory: () => ({ node: standbyCtx.createGain() as never, params: {} as never, sources: [], nodes: [] }) });
    expect(standbyCtx.scheduled.length).toBeGreaterThan(0);
    expect(standbyCtx.scheduled.every(s => s.started < 0)).toBe(true);
    const built = standbyCtx.buffersCreated;
    standby.reseed(7);
    expect(standbyCtx.buffersCreated).toBe(built);
    await standbyCtx.resume(); await standby.start();
    await gestureCtx.resume();
    const gesture = new TankAudioIntegrator(gestureCtx.asAudioContext(), { seed: 7, music: false, loopFactory: () => ({ node: gestureCtx.createGain() as never, params: {} as never, sources: [], nodes: [] }) });
    await gesture.start();
    expectSamePools(standby.m.pools, gesture.m.pools);
    expect(standbyCtx.convolvers.length).toBe(1); expect(gestureCtx.convolvers.length).toBe(1);
    expectSameBuffer(standbyCtx.convolvers[0].buffer!, gestureCtx.convolvers[0].buffer!);
    expect(standby.m.rng.next()).toBe(gesture.m.rng.next());
    expect(Object.fromEntries(standbyCtx.counts)).toEqual(Object.fromEntries(gestureCtx.counts));
    // Every bed source runs, from the moment the engine started; each reads the same pool as before.
    expect(standbyCtx.scheduled.map(s => s.started)).toEqual(gestureCtx.scheduled.map(s => s.started));
    const reads = (ctx: Recording, pools: NoisePools) => ctx.scheduled.filter((s): s is FakeBufferSource => s instanceof FakeBufferSource)
      .map(s => (['white', 'brown', 'pinkL', 'pinkR'] as const).find(k => pools[k] as unknown === s.buffer));
    expect(reads(standbyCtx, standby.m.pools).sort()).toEqual(reads(gestureCtx, gesture.m.pools).sort());
    standby.dispose(); gesture.dispose();
  });
});

describe('the first gesture', () => {
  async function boot() {
    const contexts: Recording[] = [], idle: (() => void)[] = [], listeners = new Map<string, (() => void)[]>();
    vi.stubGlobal('window', {
      AudioContext: class extends Recording { constructor() { super(8000); contexts.push(this); } },
      addEventListener: (type: string, listener: () => void) => listeners.set(type, [...listeners.get(type) ?? [], listener]),
    });
    vi.stubGlobal('document', { hidden: false, addEventListener: () => {} });
    vi.stubGlobal('requestIdleCallback', (run: () => void) => idle.push(run));
    const hooks = await import('../src/game/app/hooks');
    await import('../src/audio/index');
    const runIdle = () => { for (const run of idle.splice(0)) run(); };
    const settle = async () => { for (let i = 0; i < 12; i++) { await new Promise(r => setTimeout(r, 0)); runIdle(); } };
    const audio = () => hooks.collectTelemetry().audio as { state: string; unlocked: boolean };
    return { contexts, listeners, hooks, settle, runIdle, audio, gesture: () => { for (const listener of listeners.get('keydown') ?? []) listener(); } };
  }

  it('only resumes and starts what idle time built before it', async () => {
    const page = await boot();
    await page.settle();
    expect(page.contexts.length).toBe(1);
    const ctx = page.contexts[0];
    expect(ctx.state).toBe('suspended');
    expect(page.audio()).toMatchObject({ state: 'locked', unlocked: false });
    expect(engines.length).toBe(1);
    expect(ctx.scheduled.every(s => s.started < 0)).toBe(true);
    const buffers = ctx.buffersCreated, reseed = vi.spyOn((engines[0] as TankAudioIntegrator).m.pools, 'reseed');
    page.gesture();
    expect(ctx.state).toBe('running');
    await page.settle();
    expect(engines.length).toBe(1);
    expect(ctx.buffersCreated).toBe(buffers);
    expect(reseed).not.toHaveBeenCalled();
    expect(page.audio()).toMatchObject({ state: 'running', unlocked: true });
    expect(ctx.scheduled.every(s => s.started >= 0)).toBe(true);
    expectSamePools((engines[0] as TankAudioIntegrator).m.pools, new NoisePools(new FakeAudioContext(8000) as unknown as BaseAudioContext, 0x7a11 ^ 0x9e37));
  });

  it('takes the seed of a match that started before it, after the match\'s first second and outside the gesture', async () => {
    const page = await boot();
    await page.settle();
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const reseed = vi.spyOn((engines[0] as TankAudioIntegrator).m.pools, 'reseed');
    page.hooks.dispatchMatchStart(setup(7));
    vi.advanceTimersByTime(999); page.runIdle();
    expect(reseed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); page.runIdle();
    expect(reseed).toHaveBeenCalledOnce();
    vi.useRealTimers();
    page.gesture();
    await page.settle();
    expect(reseed).toHaveBeenCalledOnce();
    expect(engines.length).toBe(1);
    expectSamePools((engines[0] as TankAudioIntegrator).m.pools, new NoisePools(new FakeAudioContext(8000) as unknown as BaseAudioContext, 7 ^ 0x9e37));
  });

  it('reseeds inside the gesture when it comes during the match\'s first second', async () => {
    const page = await boot();
    await page.settle();
    page.hooks.dispatchMatchStart(setup(7));
    page.gesture();
    await page.settle();
    expect(engines.length).toBe(1);
    expectSamePools((engines[0] as TankAudioIntegrator).m.pools, new NoisePools(new FakeAudioContext(8000) as unknown as BaseAudioContext, 7 ^ 0x9e37));
  });

  it('replays the latest state cues that arrived before the gesture into the engine it activates', async () => {
    const page = await boot();
    await page.settle();
    const cue = (detail: unknown) => { for (const listener of page.listeners.get('tmt:audio-cue') ?? []) (listener as unknown as (e: unknown) => void)({ detail }); };
    cue({ type: 'boss', id: 'crawler', phase: 0 }); cue({ type: 'boss', id: 'crawler', phase: 1 }); cue({ type: 'stinger', id: 'undermined' }); cue({ type: 'escalation', stage: 2 });
    page.hooks.dispatchMatchStart(setup(7));
    for (const listener of page.listeners.get('tmt:audio-scene') ?? []) (listener as unknown as (e: unknown) => void)({ detail: { scene: 'skirmish', world: 'dune' } });
    cue({ type: 'boss', id: 'crawler', phase: 2 });
    page.gesture();
    await page.settle();
    const music = (engines[0] as TankAudioIntegrator).telemetry().music as { boss: unknown; escalation: number; stingers: number };
    expect(music.boss).toEqual({ id: 'crawler', phase: 2 });
    expect(music.escalation).toBe(-1); // the match start discarded cues from before it; the stinger was never queued
    expect((page.audio() as unknown as { cues: number }).cues).toBe(5);
  });

  it('still builds everything itself when it comes before idle time did', async () => {
    const page = await boot();
    page.gesture();
    await page.settle();
    expect(page.contexts.length).toBe(1);
    expect(engines.length).toBe(1);
    expect(page.audio()).toMatchObject({ state: 'running', unlocked: true });
    expect(page.contexts[0].scheduled.every(s => s.started >= 0)).toBe(true);
  });
});
