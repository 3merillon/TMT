import { describe, expect, it } from 'vitest';
import { Buses, CLIP_LEVEL, DEFAULT_VOLUMES, DUCK, duckGainAt, LIMITER, MASTER_FADE_IN_S, scheduleDuck, volumesFrom } from '../src/audio/buses';
import { AudioManager } from '../src/audio/audio-manager';
import { TankAudioIntegrator } from '../src/audio/integrator';
import { MusicBed } from '../src/audio/music-bed';
import { NoisePools } from '../src/audio/noise-pools';
import { playExplosion } from '../src/audio/sfx/explosion';
import { playArmorHit, playKillAccent, playRubbleSettle } from '../src/audio/sfx/impacts';
import { suspensionThumpRecipe, WEAPON_VOICES, type UiSound } from '../src/audio/sfx/tank-sfx-math';
import { playUi } from '../src/audio/sfx/ui';
import { playWeaponFire } from '../src/audio/sfx/weapons';
import { ShellWhistles } from '../src/audio/sfx/whistle';
import { BUS_NAMES } from '../src/audio/voice-select';
import { FakeLoader, settle, testManifest } from './helpers/score';
import { FakeAnalyser, FakeAudioContext, FakeGain, FakeNode, FakeParam, reachable } from '../src/audio/testing/fake-audio-context';

const camera = { position: [0, 26, 8] as [number, number, number], target: [0, 18.4, 0] as [number, number, number], up: [0, 1, 0] as [number, number, number] };
const focus: [number, number, number] = [0, 18.4, 0];

describe('music ducking envelope', () => {
  const low = 10 ** (DUCK.depthDb / 20);
  it('dips −6 dB in 30 ms, holds 0.25 s, then recovers over 1.2 s', () => {
    expect(DUCK.depthDb).toBe(-6);
    expect(DUCK.hold).toBe(0.25);
    expect(duckGainAt(-0.1)).toBe(1);
    expect(duckGainAt(0)).toBe(1);
    expect(duckGainAt(DUCK.attack)).toBeCloseTo(low, 9);
    expect(duckGainAt(DUCK.attack + DUCK.hold * 0.5)).toBeCloseTo(low, 9);
    expect(duckGainAt(DUCK.attack + DUCK.hold)).toBeCloseTo(low, 9);
    expect(duckGainAt(DUCK.attack + DUCK.hold + DUCK.release * 0.5)).toBeCloseTo((1 + low) / 2, 9);
    expect(duckGainAt(DUCK.attack + DUCK.hold + DUCK.release)).toBe(1);
    expect(duckGainAt(10)).toBe(1);
    let prev = 0;
    for (let t = DUCK.attack + DUCK.hold; t < 2; t += 0.05) { const v = duckGainAt(t); expect(v).toBeGreaterThanOrEqual(prev); prev = v; }
  });

  it('retriggers from the current level and never overshoots', () => {
    expect(duckGainAt(0.01, 0.3)).toBeCloseTo(0.3, 9);
    expect(duckGainAt(0.2, 0.3)).toBeCloseTo(0.3, 9);
    for (let t = 0; t < 2; t += 0.01) expect(duckGainAt(t, 0.8)).toBeLessThanOrEqual(1);
  });

  it('is scheduled on the AudioParam exactly as the pure envelope describes', () => {
    const ctx = new FakeAudioContext();
    const g = ctx.createGain();
    scheduleDuck(g.gain as unknown as AudioParam, 2, 1);
    for (let t = 1.9; t < 4; t += 0.017) expect(g.gain.valueAt(t)).toBeCloseTo(t < 2 ? 1 : duckGainAt(t - 2), 6);
  });
});

describe('bus graph', () => {
  it('routes every bus through the master, the 0.6 s fade and the limiter to the destination', () => {
    const ctx = new FakeAudioContext();
    const b = new Buses(ctx as unknown as BaseAudioContext);
    const lim = b.limiter as unknown as { threshold: FakeParam; knee: FakeParam; ratio: FakeParam; attack: FakeParam; release: FakeParam };
    expect(lim.threshold.value).toBe(LIMITER.threshold);
    expect(LIMITER.threshold).toBe(-6);
    expect(lim.ratio.value).toBe(20);
    expect(lim.knee.value).toBe(0);
    expect(lim.attack.value).toBe(0.003);
    expect(lim.release.value).toBe(0.12);
    for (const bus of BUS_NAMES) {
      const path = reachable(b.input[bus] as unknown as FakeNode);
      expect(path.has(b.limiter as unknown as FakeNode), bus).toBe(true);
      expect(path.has(ctx.destination), bus).toBe(true);
      expect(path.has(b.duck as unknown as FakeNode), bus).toBe(bus === 'music');
    }
    // Silent until unlocked; the fade rises 0 → 1 over 0.6 s.
    const fade = (b.fade as unknown as FakeGain).gain;
    expect(fade.value).toBe(0);
    b.fadeIn(5);
    expect(fade.valueAt(5)).toBe(0);
    expect(fade.valueAt(5 + MASTER_FADE_IN_S / 2)).toBeCloseTo(0.5, 9);
    expect(fade.valueAt(5 + MASTER_FADE_IN_S)).toBe(1);
  });

  it('meters peaks per bus, counts clips at the destination, and flags NaN', () => {
    const ctx = new FakeAudioContext();
    const b = new Buses(ctx as unknown as BaseAudioContext);
    const master = [...reachable(b.trim as unknown as FakeNode)].find(n => n instanceof FakeAnalyser) as FakeAnalyser;
    master.level = 0.5;
    b.readMeters(0.1);
    expect(b.peaksDb().master).toBeCloseTo(-6, 0);
    expect(b.clipCount).toBe(0);
    master.level = CLIP_LEVEL;
    b.readMeters(0.2);
    expect(b.clipCount).toBe(1);
    master.level = NaN;
    b.readMeters(0.3);
    expect(b.nanCount).toBe(1);
    expect(b.peakMax).toBeCloseTo(CLIP_LEVEL, 6);   // analysers report float32
    const peaks = b.peaksDb();
    for (const bus of BUS_NAMES) expect(peaks[bus]).toBe(-120);
  });

  it('applies tmt:settings volumes (0..1 or 0..100) and defaults when absent', () => {
    expect(volumesFrom(undefined)).toEqual(DEFAULT_VOLUMES);
    expect(volumesFrom({ master: 0.5, music: 40, sfx: 2, ui: -1, voice: 'x' })).toEqual({ ...DEFAULT_VOLUMES, master: 0.5, music: 0.4, sfx: 0.02, ui: 0 });
    expect(volumesFrom({ sfx: 250 }).sfx).toBe(1);
    const ctx = new FakeAudioContext();
    const b = new Buses(ctx as unknown as BaseAudioContext);
    b.setVolumes({ master: 0.4, music: 0.2, sfx: 0.9, ui: 0.1, voice: 0.3 }, 1);
    expect((b.master as unknown as FakeGain).gain.valueAt(3)).toBeCloseTo(0.4, 3);
    expect((b.groups.music as unknown as FakeGain).gain.valueAt(3)).toBeCloseTo(0.2, 3);
    expect((b.groups.ui as unknown as FakeGain).gain.valueAt(3)).toBeCloseTo(0.1, 3);
  });
});

describe('no per-one-shot allocation', () => {
  it('builds the noise pools once and never allocates a buffer for a one-shot, a whistle or a music layer', async () => {
    const ctx = new FakeAudioContext();
    void ctx.resume();
    const m = new AudioManager(ctx.asAudioContext(), { dev: true });
    m.listener.update(camera, focus, 1 / 60);
    expect(ctx.buffersCreated).toBe(4);               // white, brown and the pink pair
    const whistles = new ShellWhistles();
    const manifest = testManifest(), music = new MusicBed(m, { manifest, loader: new FakeLoader(ctx, manifest) });
    music.start(7); await settle(); music.tick();
    const afterInit = ctx.buffersCreated;             // + the three decoded title layers, decoded once
    expect(afterInit).toBe(7);
    let played = 0;
    const count = (v: unknown) => { if (v) played++; };
    for (let round = 0; round < 40; round++) {
      const p: [number, number, number] = [Math.sin(round) * 5, 18.6, Math.cos(round) * 5];
      for (const weapon of WEAPON_VOICES) count(playWeaponFire(m, { weapon, power: (round % 5) / 4, seed: round * 3 + weapon.length, position: p }));
      for (const munition of ['explosive', 'heavy', 'incendiary', 'nuclear']) count(playExplosion(m, { position: p, radius: 1.5 + (round % 4), munition, seed: round }).voice);
      count(playArmorHit(m, p, { damage01: (round % 3) / 2, direct: round % 2 === 0 }, round));
      count(playKillAccent(m, p, round));
      count(playRubbleSettle(m, p, 2, round));
      count(m.play(suspensionThumpRecipe((round % 4) / 3, round), { bus: 'vehicles', priority: 3, position: p }));
      for (const kind of ['click', 'confirm', 'aim', 'turn', 'victory'] as UiSound[]) count(playUi(m, kind, 0.3, round));
      whistles.update(m, [{ id: round, position: [p[0], 21, p[2]], velocity: [3, -2, 1] }], focus, ctx.currentTime);
      music.tick();
      ctx.advance(0.25);
      m.update();
    }
    expect(played).toBeGreaterThan(200);
    expect(m.lastError).toBeNull();
    expect(m.nanRejected).toBe(0);
    expect(ctx.buffersCreated).toBe(afterInit);
    expect(music.snapshot().track).toBe('title');
    music.dispose();
  });

  it('shares one pool per noise colour and offsets reads deterministically', () => {
    const ctx = new FakeAudioContext();
    const a = new NoisePools(ctx as unknown as BaseAudioContext, 5), b = new NoisePools(ctx as unknown as BaseAudioContext, 5);
    expect(a.get('white')).toBe(a.white);
    expect(a.get('brown')).toBe(a.brown);
    expect(a.get('pink')).toBe(a.pinkL);
    const offsets = [0.1, 0.5, 1].map(d => a.offset(a.white, d));
    expect(offsets).toEqual([0.1, 0.5, 1].map(d => b.offset(b.white, d)));
    for (const [i, d] of [0.1, 0.5, 1].entries()) expect(offsets[i] + d).toBeLessThanOrEqual(a.white.duration);
    const data = a.brown.getChannelData(0);
    expect(data.every(v => Number.isFinite(v) && Math.abs(v) <= 1)).toBe(true);
  });

  it('keeps the whole integrator allocation-free per event after start', async () => {
    const ctx = new FakeAudioContext();
    void ctx.resume();
    const engine = new TankAudioIntegrator(ctx.asAudioContext(), { dev: true, loopFactory: fakeLoops(ctx) });
    await engine.start();
    const afterInit = ctx.buffersCreated;
    expect(afterInit).toBe(5);                        // the pools + the wind impulse response
    const snap = { tick: 0, time: 0, phase: 'aim', active: 0, turn: 0, phaseTime: 0, projectiles: [], contacts: [], winner: null,
      tanks: [0, 1].map(i => ({ id: i, position: [i * 6, 18.4, 0], velocity: [0, 0, 0], power: 0.6, health: 100, loadout: { tracks: 'scout', barrel: 'cannon', armor: 'light' },
        trackSpeeds: [0, 0], trackSlip: [0, 0], trackContact: [1, 1], turretYaw: 0, barrelPitch: 0, wheelSuspension: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5] })) } as never;
    for (let i = 0; i < 30; i++) {
      engine.onEvent({ type: 'shot', player: 0 }, snap);
      engine.onEvent({ type: 'impact', position: [3, 18.2, 0], normal: [0, 1, 0], radius: 2.25, owner: 0, munition: 'explosive' }, snap);
      engine.onFrame({ realDt: 1 / 60, simDt: 1 / 60, snapshot: snap, camera: { ...camera, fovY: 0.9 }, focus });
      ctx.advance(0.1);
    }
    expect(ctx.buffersCreated).toBe(afterInit);
    engine.dispose();
  });
});

/** Loop nodes without an AudioWorklet (a gain per slot with the six params). */
function fakeLoops(ctx: FakeAudioContext) {
  return () => {
    const node = ctx.createGain();
    const params = Object.fromEntries(['fundamental', 'load', 'tread', 'slip', 'servo', 'level'].map(n => [n, ctx.createGain().gain])) as never;
    return { node: node as unknown as AudioNode, params, sources: [], nodes: [node as unknown as AudioNode] };
  };
}
