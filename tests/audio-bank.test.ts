/** The effects bank (sprites on one buffer), actor loops (wrecks, rotors, swarms with generation-safe keys) and the
 * integrator's realtime-event cues, all on the fake context. */
import { describe, expect, it } from 'vitest';
import { AudioManager } from '../src/audio/audio-manager';
import { SfxBank, type SfxManifest } from '../src/audio/sfx-bank';
import { ActorLoops, actorLoopKinds, ACTOR_LOOPS, WRECK_TICKS } from '../src/audio/actor-loops';
import { TankAudioIntegrator } from '../src/audio/integrator';
import { ENGINE_PARAMS } from '../src/audio/worklets/engine-params';
import { FakeAudioContext, FakeBufferSource } from '../src/audio/testing/fake-audio-context';
import type { GameSnapshot, TankState } from '../src/game/contracts';
import type { MatchSetup } from '../src/game/api/match';
import { FakeLoader, settle, testManifest } from './helpers/score';

type V = [number, number, number];
const camera = { position: [0, 26, 8] as V, target: [0, 18.4, 0] as V, up: [0, 1, 0] as V, fovY: 0.9 };
const focus: V = [0, 18.4, 0];
function tank(i: number, position: V, over: Partial<TankState> = {}): TankState {
  return { id: i, position, rotation: [0, 0, 0, 1], velocity: [0, 0, 0], heading: 0, turretYaw: 0, barrelPitch: 0.3, power: 0.7, health: 100, charge: 1, movement: 1, recoil: 0, suspension: [], trackPhase: 0, trackPhases: [0, 0], trackSpeeds: [0, 0], trackGroundSpeeds: [0, 0], trackSlip: [0, 0], trackContact: [1, 1], yawVelocity: 0, wheelSuspension: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5], treadContacts: [], loadout: { tracks: 'scout', barrel: 'cannon', armor: 'light' }, team: i === 0 ? 0 : 1, ...over };
}
const snapshot = (tick: number, tanks: TankState[]): GameSnapshot => ({ tick, time: tick / 60, phase: 'aim', active: 0, turn: 0, phaseTime: 0, tanks, projectiles: [], contacts: tanks.map(() => null), winner: null });
const bankManifest: SfxManifest = { version: 1, file: 'bank.ogg', sampleRate: 8000, seconds: 10, samples: 80000, bytes: 1, sprites: {
  'wreck-fire': { id: 'wreck-fire', variants: [{ offset: 0, seconds: 2 }], loop: true }, rotor: { id: 'rotor', variants: [{ offset: 2, seconds: 1 }], loop: true }, swarm: { id: 'swarm', variants: [{ offset: 3, seconds: 1 }], loop: true },
  hover: { id: 'hover', variants: [{ offset: 4, seconds: 1 }], loop: true }, crawler: { id: 'crawler', variants: [{ offset: 5, seconds: 1 }], loop: true }, spire: { id: 'spire', variants: [{ offset: 6, seconds: 1 }], loop: true }, searchlight: { id: 'searchlight', variants: [{ offset: 7, seconds: 0.5 }], loop: true }, shield: { id: 'shield', variants: [{ offset: 7.5, seconds: 0.5 }], loop: true },
  cannon: { id: 'cannon', variants: [{ offset: 8, seconds: 0.4 }, { offset: 8.4, seconds: 0.4 }] }, 'coax-burst': { id: 'coax-burst', variants: [{ offset: 8.8, seconds: 0.3 }] }, ricochet: { id: 'ricochet', variants: [{ offset: 9.1, seconds: 0.2 }] },
  'ui-objectiveNew': { id: 'ui-objectiveNew', variants: [{ offset: 9.3, seconds: 0.2 }] }, 'ui-objectiveDone': { id: 'ui-objectiveDone', variants: [{ offset: 9.5, seconds: 0.2 }] }, 'ui-banner': { id: 'ui-banner', variants: [{ offset: 9.7, seconds: 0.2 }] }, 'ui-incoming': { id: 'ui-incoming', variants: [{ offset: 9.9, seconds: 0.1 }] },
} };
/** The same bank plus the sustained-fire loop and its tail (a second bank file), as the shipped manifest has them. */
const twoBankManifest: SfxManifest = { ...bankManifest, banks: [{ file: 'bank.ogg', seconds: 10, samples: 80000, bytes: 1 }, { file: 'bank-heavy.ogg', seconds: 4, samples: 32000, bytes: 1 }], sprites: { ...bankManifest.sprites,
  'coax-loop': { id: 'coax-loop', bank: 1, variants: [{ offset: 0, seconds: 0.7 }], loop: true }, 'coax-tail': { id: 'coax-tail', bank: 1, variants: [{ offset: 0.8, seconds: 1 }] }, snap: { id: 'snap', bank: 1, variants: [{ offset: 2, seconds: 0.15 }] } } };
const bankLoader = (ctx: FakeAudioContext) => ({ load: async () => ctx.createBuffer(1, 80000, 8000) as unknown as AudioBuffer });

describe('effects bank', () => {
  it('decodes once, plays sprites as sub-range sources through the budget, and loops loop sprites', async () => {
    const ctx = new FakeAudioContext(8000); void ctx.resume();
    const m = new AudioManager(ctx.asAudioContext()), bank = new SfxBank(bankManifest);
    expect(bank.play(m, 'cannon', { bus: 'weapons', priority: 6 })).toBeNull();
    await bank.load(bankLoader(ctx)); await bank.load(bankLoader(ctx));
    expect(bank.ready).toBe(true); expect(ctx.buffersCreated).toBe(5); // noise pools 4 + the bank
    const v = bank.play(m, 'cannon', { bus: 'weapons', priority: 6, position: [0, 18.4, 1], variant: 1, rate: 1.03 })!;
    const src = v.sources[0] as unknown as FakeBufferSource;
    expect(src.started).toBeGreaterThan(0); expect(src.loop).toBe(false); expect(src.playbackRate.value).toBeCloseTo(1.03);
    expect(v.endAt).toBeCloseTo(src.started + 0.4 / 1.03 + 0.05, 5);
    const loop = bank.play(m, 'wreck-fire', { bus: 'ambience', priority: 9, position: [0, 18.4, 1], loop: true })!;
    const ls = loop.sources[0] as unknown as FakeBufferSource;
    expect(ls.loop).toBe(true); expect(ls.loopStart).toBe(0); expect(ls.loopEnd).toBe(2); expect(loop.persistent).toBe(true); expect(loop.endAt).toBe(Infinity);
    expect(bank.play(m, 'nope', { bus: 'weapons', priority: 6 })).toBeNull();
    m.dispose();
  });
});

describe('actor loops', () => {
  const rig = async () => { const ctx = new FakeAudioContext(8000); void ctx.resume(); const m = new AudioManager(ctx.asAudioContext()); const bank = new SfxBank(bankManifest); await bank.load(bankLoader(ctx)); m.listener.update(camera, focus, 0); return { ctx, m, bank, loops: new ActorLoops(m, bank) }; };
  it('classifies actors by state', () => {
    expect(actorLoopKinds(tank(1, [0, 18, 0], { health: 0, destroyedAt: 10 }), 20)).toEqual(['wreck']);
    expect(actorLoopKinds(tank(1, [0, 18, 0], { health: 0, destroyedAt: 10 }), 10 + WRECK_TICKS)).toEqual([]);
    expect(actorLoopKinds(tank(1, [0, 18, 0], { health: 0, destroyedAt: 10, retired: true }), 20)).toEqual([]);
    expect(actorLoopKinds(tank(1, [0, 18, 0], { motionKind: 'air', visualKind: 'dragonfly' }), 1)).toEqual(['rotor']);
    expect(actorLoopKinds(tank(1, [0, 18, 0], { motionKind: 'air', visualKind: 'skimmer' }), 1)).toEqual(['hover']);
    expect(actorLoopKinds(tank(1, [0, 18, 0], { motionKind: 'swarm' }), 1)).toEqual(['swarm']);
    expect(actorLoopKinds(tank(1, [0, 18, 0], { components: [{ id: 'c', name: 'c', kind: 'core', offset: [0, 0, 0], radius: 1, stage: 0, health: 1, maxHealth: 1 }], shield: { direction: [0, 1, 0], cosine: -1 } }), 1)).toEqual(['crawler', 'shield']);
  });
  it('starts a wreck loop on death, stops it when the wreck retires, and never lets a recycled slot inherit it', async () => {
    const { ctx, m, loops } = await rig();
    const t = tank(1, [1, 18.4, 0]);
    loops.update([t], 100, ctx.currentTime); expect(loops.active).toBe(0);
    t.health = 0; t.destroyedAt = 100;
    loops.update([t], 101, ctx.currentTime); expect(loops.active).toBe(1); expect(loops.kinds()).toEqual({ wreck: 1 });
    const voice = m.voiceTelemetry().buses.ambience; expect(voice).toBe(1);
    // The slot is recycled with a new generation: the old loop fades out and no loop plays for the live tank.
    const recycled = tank(1, [1, 18.4, 0], { generation: 2 });
    ctx.advance(1); loops.update([recycled], 500, ctx.currentTime); expect(loops.active).toBe(0);
    ctx.advance(ACTOR_LOOPS.wreck.fadeOut + 0.1); loops.update([recycled], 600, ctx.currentTime);
    expect(m.voiceTelemetry().buses.ambience).toBe(0);
    // A new wreck of the recycled generation starts its own loop.
    recycled.health = 0; recycled.destroyedAt = 600; loops.update([recycled], 601, ctx.currentTime); expect(loops.active).toBe(1);
    recycled.retired = true; loops.update([recycled], 602, ctx.currentTime); expect(loops.active).toBe(0);
    loops.dispose(); expect(m.voiceTelemetry().total).toBe(0);
  });
  it('caps loops per kind to the nearest actors with hysteresis', async () => {
    const { ctx, loops } = await rig();
    const wrecks = Array.from({ length: 8 }, (_, i) => tank(i + 1, [i * 2, 18.4, 0], { health: 0, destroyedAt: 0 }));
    loops.update(wrecks, 10, ctx.currentTime); expect(loops.kinds().wreck).toBe(ACTOR_LOOPS.wreck.max);
    const air = Array.from({ length: 5 }, (_, i) => tank(20 + i, [0, 18.4, i * 3], { motionKind: 'air', visualKind: 'dragonfly' }));
    loops.update([...wrecks, ...air], 11, ctx.currentTime); expect(loops.kinds()).toEqual({ wreck: 4, rotor: 2 });
    loops.dispose();
  });
});

describe('integrator realtime cues', () => {
  const setup = { id: 'campaign:ii-7', seed: 7, mode: 'campaign', planet: { kind: 'temperate' }, teams: [], tanks: [], objectives: [], rules: { moveSeconds: 4, wind: null, fog: true, projectileAge: 8, gravityScale: 1, ammo: {}, radarCost: 3, startCharge: 1, friendlyFire: false, commitWindowTicks: 12, turnModel: 'realtime', brace: false, taps: false, overdrive: false, supplyEvery: 0, fallDamage: false } } as unknown as MatchSetup;
  async function rig() {
    const ctx = new FakeAudioContext(8000); await ctx.resume();
    const manifest = testManifest();
    const engine = new TankAudioIntegrator(ctx.asAudioContext(), { dev: true, bank: bankLoader(ctx), musicOptions: { manifest, loader: new FakeLoader(ctx, manifest) }, loopFactory: () => { const node = ctx.createGain(); return { node: node as unknown as AudioNode, params: Object.fromEntries([...ENGINE_PARAMS].map(n => [n, ctx.createGain().gain])) as never, sources: [], nodes: [node as unknown as AudioNode] }; } });
    await engine.start(); await settle(); engine.fadeIn(); engine.setObserver(0); engine.onMatchStart(setup); await settle();
    return { ctx, engine };
  }
  it('streams a gun as one sustained loop that stops with a tail, and snaps rounds passing the listener', async () => {
    const ctx = new FakeAudioContext(8000); await ctx.resume();
    const manifest = testManifest();
    const engine = new TankAudioIntegrator(ctx.asAudioContext(), { dev: true, bank: { load: async (file: string) => ctx.createBuffer(1, file === 'bank-heavy.ogg' ? 32000 : 80000, 8000) as unknown as AudioBuffer }, musicOptions: { manifest, loader: new FakeLoader(ctx, manifest) }, loopFactory: () => { const node = ctx.createGain(); return { node: node as unknown as AudioNode, params: Object.fromEntries([...ENGINE_PARAMS].map(n => [n, ctx.createGain().gain])) as never, sources: [], nodes: [node as unknown as AudioNode] }; } });
    (engine.bank as unknown as { manifest: SfxManifest }).manifest = twoBankManifest;
    (engine.bank as unknown as { buffers: (AudioBuffer | null)[] }).buffers.push(null);
    await engine.start(); await settle(); engine.fadeIn(); engine.setObserver(0); engine.onMatchStart(setup); await settle();
    expect(engine.bank.has('coax-loop')).toBe(true);
    const s = snapshot(10, [tank(0, [0, 18.4, 0]), tank(1, [8, 18.4, 0])]);
    engine.onFrame({ realDt: 1 / 60, simDt: 1 / 60, snapshot: s, camera, focus });
    const tele = () => engine.telemetry() as { played: Record<string, number>; guns: { active: number; started: number; stopped: number }; voices: { buses: Record<string, number> } };
    // Six tracers in a burst: ONE loop voice on the weapons bus, following the gun; a round passing the focus snaps.
    for (let i = 0; i < 6; i++) { ctx.advance(0.01); engine.onRealtimeEvent({ type: 'tracer', owner: 1, from: [8, 18.9, 0], to: [-2, 18.9, 0.5], victim: null }, s); }
    expect(tele().guns).toMatchObject({ active: 1, started: 1, stopped: 0 });
    expect(tele().voices.buses.weapons).toBe(2);                    // the loop + one snap
    // The gun stops: after the release gap a frame releases the loop and the tail plays on the vehicles bus.
    const vehicles0 = tele().played.vehicles;
    ctx.advance(0.4); engine.onFrame({ realDt: 0.4, simDt: 0.4, snapshot: s, camera, focus });
    expect(tele().guns).toMatchObject({ active: 0, stopped: 1 });
    expect(tele().played.vehicles).toBe(vehicles0 + 1);
    engine.dispose();
  });
  it('rate-limits coax bursts per gun, pings the target, and cues objectives once per state change', async () => {
    const { ctx, engine } = await rig();
    const s = snapshot(10, [tank(0, [0, 18.4, 0]), tank(1, [3, 18.4, 0])]);
    engine.onFrame({ realDt: 1 / 60, simDt: 1 / 60, snapshot: s, camera, focus });
    const played = () => (engine.telemetry() as { played: Record<string, number> }).played;
    for (let i = 0; i < 6; i++) engine.onRealtimeEvent({ type: 'tracer', owner: 1, from: [3, 18.9, 0], to: [0, 18.9, 0], victim: 0 }, s);
    expect(played().weapons).toBe(1);
    ctx.advance(0.5); engine.onRealtimeEvent({ type: 'tracer', owner: 1, from: [3, 18.9, 0], to: [0, 18.9, 0], victim: 0 }, s);
    expect(played().weapons).toBe(2);
    const ui0 = played().ui;
    engine.onRealtimeEvent({ type: 'objective', id: 'forge-pad', text: 'Forge', state: 'active' });
    engine.onRealtimeEvent({ type: 'objective', id: 'forge-pad', text: 'Forge · 10 s', state: 'active' });
    engine.onRealtimeEvent({ type: 'objective', id: 'forge-pad', text: 'Forge', state: 'done' });
    expect(played().ui - ui0).toBe(2);
    expect((engine.telemetry() as { music: { escalation: number } }).music.escalation).toBe(1);
    engine.onRealtimeEvent({ type: 'banner', title: 'FORGE FLEET AWAY' });
    expect(played().ui - ui0).toBe(3);
    engine.onRealtimeEvent({ type: 'mission', status: 'won' });
    expect((engine.telemetry() as { music: { outcome: string } }).music.outcome).toBe('won');
    engine.dispose();
  });
  it('applies audio cues carried by realtime events: boss phases take precedence over the derived state, ui cues play', async () => {
    const { engine } = await rig();
    const music = () => (engine.telemetry() as { music: { boss: { id: string; phase: number } | null; phase: string | null; escalation: number; ending: string | null } }).music;
    const played = () => (engine.telemetry() as { played: Record<string, number> }).played;
    engine.onRealtimeEvent({ type: 'audio', cue: { type: 'boss', id: 'leviathan', phase: 0 } });
    expect(music().boss).toEqual({ id: 'leviathan', phase: 0 });
    engine.onRealtimeEvent({ type: 'audio', cue: { type: 'boss', id: 'leviathan', phase: 1 } });
    expect(music().boss).toEqual({ id: 'leviathan', phase: 1 });
    // A Crawler in the snapshot no longer overrides the explicit boss while a cue is set.
    const boss = snapshot(30, [tank(0, [0, 18.4, 0]), tank(1, [5, 18.4, 0], { components: [{ id: 'c', name: 'c', kind: 'core', offset: [0, 0, 0], radius: 1, stage: 2, health: 5, maxHealth: 5 }] })]);
    engine.onFrame({ realDt: 0.3, simDt: 0.3, snapshot: boss, camera, focus });
    expect(music().boss).toEqual({ id: 'leviathan', phase: 1 });
    engine.onRealtimeEvent({ type: 'audio', cue: { type: 'boss-end' } });
    expect(music().boss).toBeNull();
    engine.onRealtimeEvent({ type: 'audio', cue: { type: 'finale', phase: 'escape' } }); expect(music().phase).toBe('escape');
    engine.onRealtimeEvent({ type: 'audio', cue: { type: 'escalation', stage: 2 } }); expect(music().escalation).toBe(2);
    engine.onRealtimeEvent({ type: 'audio', cue: { type: 'ending', choice: 'release' } }); expect(music().ending).toBe('release');
    const ui0 = played().ui, alerts0 = played().alerts;
    engine.onRealtimeEvent({ type: 'audio', cue: { type: 'ui', sound: 'depot-ping' } });
    engine.onRealtimeEvent({ type: 'audio', cue: { type: 'ui', sound: 'alarm' } });
    expect(played().ui - ui0).toBe(1); expect(played().alerts - alerts0).toBe(1);
    engine.dispose();
  });
  it('derives threat from hostiles, projectiles and incoming fire, and the Crawler phase from its components', async () => {
    const { ctx, engine } = await rig();
    const far = snapshot(10, [tank(0, [0, 18.4, 0]), tank(1, [0, -18.4, 0])]);
    for (let i = 0; i < 4; i++) { ctx.advance(0.25); engine.onFrame({ realDt: 0.25, simDt: 0.25, snapshot: far, camera, focus }); }
    const threat = () => (engine.telemetry() as { threat: { value: number } }).threat.value;
    expect(threat()).toBeLessThan(0.1);
    const near = snapshot(20, [tank(0, [0, 18.4, 0]), tank(1, [4, 18.4, 0]), tank(2, [6, 18.4, 0])]);
    near.observations = [[null, { position: [4, 18.4, 0], observedAt: 20, source: 'sight', visible: true }, { position: [6, 18.4, 0], observedAt: 20, source: 'sight', visible: true }], [], []];
    engine.onEvent({ type: 'incoming', tank: 0, impactTick: 80, predicted: [0, 18.4, 1] }, near);
    for (let i = 0; i < 4; i++) { ctx.advance(0.25); engine.onFrame({ realDt: 0.25, simDt: 0.25, snapshot: near, camera, focus }); }
    expect(threat()).toBeGreaterThan(0.6);
    const boss = snapshot(30, [tank(0, [0, 18.4, 0]), tank(1, [5, 18.4, 0], { components: [{ id: 'd', name: 'd', kind: 'drive', offset: [0, 0, 0], radius: 1, stage: 0, health: 0, maxHealth: 1 }, { id: 'p', name: 'p', kind: 'weapon', offset: [0, 0, 0], radius: 1, stage: 1, health: 5, maxHealth: 5 }] })]);
    ctx.advance(0.3); engine.onFrame({ realDt: 0.3, simDt: 0.3, snapshot: boss, camera, focus });
    expect((engine.telemetry() as { music: { boss: { id: string; phase: number } } }).music.boss).toEqual({ id: 'crawler', phase: 1 });
    engine.dispose();
  });
});
