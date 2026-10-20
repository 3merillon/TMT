import { describe, expect, it } from 'vitest';
import { TankAudioIntegrator } from '../src/audio/integrator';
import { ENGINE_PARAMS } from '../src/audio/worklets/engine-params';
import { soundDelay } from '../src/audio/sfx/tank-sfx-math';
import { FakeAudioContext, FakeBufferSource, FakeGain, FakeOscillator } from '../src/audio/testing/fake-audio-context';
import type { GameSnapshot, ShotEvent, TankState } from '../src/game/contracts';
import type { MatchSetup } from '../src/game/api/match';

type V = [number, number, number];
const camera = { position: [0, 26, 8] as V, target: [0, 18.4, 0] as V, up: [0, 1, 0] as V, fovY: 0.9 };
const focus: V = [0, 18.4, 0];

function tank(i: number, position: V, over: Partial<TankState> = {}): TankState {
  return {
    id: i as 0 | 1, position, rotation: [0, 0, 0, 1], velocity: [0, 0, 0], heading: 0, turretYaw: 0, barrelPitch: 0.3, power: 0.7, health: 100,
    charge: 1, movement: 1, recoil: 0, suspension: [], trackPhase: 0, trackPhases: [0, 0], trackSpeeds: [0, 0], trackGroundSpeeds: [0, 0],
    trackSlip: [0, 0], trackContact: [1, 1], yawVelocity: 0, wheelSuspension: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5], treadContacts: [],
    loadout: { tracks: 'scout', barrel: 'cannon', armor: 'light' }, ...over,
  };
}
function snapshot(tick: number, tanks: TankState[], projectiles: GameSnapshot['projectiles'] = []): GameSnapshot {
  return { tick, time: tick / 60, phase: 'aim', active: 0, turn: 0, phaseTime: 0, tanks, projectiles, contacts: [null, null], winner: null };
}
const setup = { id: 't', seed: 7, mode: 'drive', planet: { kind: 'auto' }, teams: [], tanks: [], objectives: [],
  rules: { moveSeconds: 4, wind: null, fog: true, projectileAge: 8, gravityScale: 1, ammo: {}, radarCost: 3, startCharge: 1, friendlyFire: true,
    commitWindowTicks: 12, turnModel: 'tempo', brace: false, taps: false, overdrive: false, supplyEvery: 0, fallDamage: false } } as unknown as MatchSetup;

function fakeLoops(ctx: FakeAudioContext) {
  return () => {
    const node = ctx.createGain();
    const params = Object.fromEntries([...ENGINE_PARAMS].map(n => [n, ctx.createGain().gain])) as never;
    return { node: node as unknown as AudioNode, params, sources: [], nodes: [node as unknown as AudioNode] };
  };
}
async function rig(o: { worklet?: boolean } = {}) {
  const ctx = new FakeAudioContext();
  await ctx.resume();
  const engine = new TankAudioIntegrator(ctx.asAudioContext(), { dev: true, loopFactory: o.worklet === false ? undefined : fakeLoops(ctx) });
  await engine.start();
  engine.fadeIn();
  engine.onMatchStart(setup);
  return { ctx, engine };
}
const frame = (engine: TankAudioIntegrator, s: GameSnapshot) => engine.onFrame({ realDt: 1 / 60, simDt: 1 / 60, snapshot: s, camera, focus });
const tele = (engine: TankAudioIntegrator) => engine.telemetry() as { state: string; voices: { total: number; buses: Record<string, number> }; played: Record<string, number>;
  busPeaks: Record<string, number>; clipCount: number; nan: number; lastError: string | null; loops: { mode: string; active: number; tanks: number[] }; events: Record<string, number> };

describe('TankAudioIntegrator', () => {
  it('voices a captured launch once even if the event is redelivered after the tank changes', async () => {
    const { engine } = await rig();
    const tanks = [tank(0, [0, 18.4, 0])];
    const s = snapshot(15, tanks);
    frame(engine, s);
    const shot: ShotEvent = { type: 'shot', player: 0, launch: { id: 4, tick: 10, weapon: 'rail', munition: 'heavy', power: .5,
      position: [0, 20, 1], direction: [0, 1, 0], up: [0, 1, 0] } };
    engine.onEvent(shot, s);
    const played = tele(engine).played.weapons;
    tanks[0].loadout.barrel = 'mortar';
    engine.onEvent(structuredClone(shot), s);
    expect(tele(engine).played.weapons).toBe(played);
    engine.onMatchStart(setup);
    engine.onEvent(shot, s);
    expect(tele(engine).played.weapons).toBe(played + 1);
  });

  it('voices the nearest tanks on the vehicles bus while driving, with pitch and tread rate following the tracks', async () => {
    const { ctx, engine } = await rig();
    const tanks = [tank(0, [0, 18.4, 0]), tank(1, [5, 18.4, 3])];
    frame(engine, snapshot(0, tanks));
    expect(tele(engine).voices.buses.vehicles).toBe(2);
    expect(tele(engine).loops.tanks.sort()).toEqual([0, 1]);
    const lastParam = (name: string) => {
      const slot = (engine.loops as unknown as { slots: { tank: number; loop: { params: Record<string, { events: { type: string; value: number }[] }> } }[] }).slots.find(s => s.tank === 0)!;
      return slot.loop.params[name].events.filter(e => e.type === 'target').at(-1)?.value ?? 0;
    };
    const idle = lastParam('fundamental');
    for (let t = 1; t <= 60; t++) {
      tanks[0] = tank(0, [0, 18.4, -t * 0.04], { trackSpeeds: [2.4, 2.4] });
      frame(engine, snapshot(t, tanks));
      ctx.advance(1 / 60);
    }
    expect(lastParam('fundamental')).toBeGreaterThan(idle + 40);
    expect(lastParam('tread')).toBeGreaterThan(20);
    expect(tele(engine).lastError).toBeNull();
  });

  it('plays the shot on the weapons bus and a distance-delayed explosion on the explosions bus', async () => {
    const { ctx, engine } = await rig();
    const tanks = [tank(0, [0, 18.4, 0]), tank(1, [5, 18.4, 3])];
    frame(engine, snapshot(10, tanks));
    engine.onEvent({ type: 'shot', player: 0 }, snapshot(10, tanks, [{ id: 3, owner: 0, position: [0, 19, 0], velocity: [0, 8, -6], age: 0 }]));
    expect(tele(engine).voices.buses.weapons).toBe(1);
    const before = ctx.nodeCount('bufferSource');
    const impactAt: V = [0, 18.3, -24];
    engine.onEvent({ type: 'impact', position: impactAt, normal: [0, 1, 0], radius: 2.25, owner: 0, munition: 'explosive' }, snapshot(90, tanks));
    const t = tele(engine);
    expect(t.voices.buses.explosions).toBe(1);
    expect(t.played.explosions).toBe(1);
    // Every new source starts no earlier than the speed-of-sound delay of the (sphere-correct) path.
    const path = engine.m.spatialize([impactAt[0], impactAt[1] + 0.1, impactAt[2]]).path;
    const created = ctx.nodeCount('bufferSource') - before;
    expect(created).toBeGreaterThan(3);
    const starts = allSources(engine).filter(s => s.started >= 0).map(s => s.started);
    expect(starts.length).toBeGreaterThan(3);
    expect(Math.min(...starts)).toBeGreaterThanOrEqual(ctx.currentTime + soundDelay(path) - 1e-9);
    expect(soundDelay(path)).toBeGreaterThan(0.3);
    expect(t.nan).toBe(0);
    expect(t.lastError).toBeNull();
  });

  it('ducks the music on a big, near boom and not on a small, far one', async () => {
    const { engine } = await rig();
    frame(engine, snapshot(0, [tank(0, [0, 18.4, 0])]));
    const duck = (engine.m.buses.duck as unknown as FakeGain).gain;
    engine.onEvent({ type: 'impact', position: [0, 18.3, -30], normal: [0, 1, 0], radius: 2, owner: 1, munition: 'explosive' }, snapshot(1, [tank(0, [0, 18.4, 0])]));
    expect(duck.events.length).toBe(0);
    engine.onEvent({ type: 'impact', position: [1, 18.3, 1], normal: [0, 1, 0], radius: 4.8, owner: 1, munition: 'nuclear' }, snapshot(2, [tank(0, [0, 18.4, 0])]));
    expect(duck.events.some(e => e.type === 'linear' && Math.abs(e.value - 10 ** (-6 / 20)) < 1e-9)).toBe(true);
  });

  it('clanks tanks caught in a blast (inferred without `hits`) and plays one kill accent per tank', async () => {
    const { engine } = await rig();
    const tanks = [tank(0, [0, 18.4, 0]), tank(1, [3, 18.4, 0], { health: 0 })];
    frame(engine, snapshot(0, tanks));
    engine.onEvent({ type: 'impact', position: [3, 18.3, 0.4], normal: [0, 1, 0], radius: 2.25, owner: 0, munition: 'explosive' }, snapshot(5, tanks));
    expect(tele(engine).played.impacts).toBe(3);        // two clanks + the kill accent
    engine.onEvent({ type: 'kill', tank: 1, by: 0, cause: 'blast' }, snapshot(5, tanks));
    expect(tele(engine).played.impacts).toBe(3);        // deduplicated
    engine.onEvent({ type: 'impact', position: [0, 18.3, 0], normal: [0, 1, 0], radius: 2, owner: 1, munition: 'explosive',
      hits: [{ tank: 0, damage: 40, exposure: 1, direct: true, lethal: false }] }, snapshot(9, tanks));
    expect(tele(engine).played.impacts).toBe(4);        // explicit hits win over inference
  });

  it('chimes turns, plays jingles, settles rubble at committed cuts and handles unknown events', async () => {
    const { engine } = await rig();
    const tanks = [tank(0, [0, 18.4, 0]), tank(1, [6, 18.4, 0])];
    frame(engine, snapshot(0, tanks));
    engine.onEvent({ type: 'turn', player: 0 }, snapshot(1, tanks));
    engine.onEvent({ type: 'turn', player: 1 }, snapshot(2, tanks));
    expect(tele(engine).played.ui).toBe(2);
    engine.onEvent({ type: 'impact', position: [2, 18.3, 0], normal: [0, 1, 0], radius: 2, owner: 0, cut: { id: '3:0:0', center: [2, 18.3, 0], radius: 2.6 } }, snapshot(3, tanks));
    const impactsBefore = tele(engine).played.impacts;
    engine.onEvent({ type: 'terrain-commit', cutIds: ['3:0:0', 'unknown'], version: 2 }, snapshot(15, tanks));
    expect(tele(engine).played.impacts).toBe(impactsBefore + 1);
    engine.onEvent({ type: 'finish', winner: 0 }, snapshot(20, tanks));
    // The result plays the score's victory stinger when the manifest ships one, else the UI jingle.
    const music = (engine.telemetry() as { music: { outcome: string | null; stingers: number } }).music;
    expect(music.outcome).toBe('won');
    expect(tele(engine).played.ui + music.stingers + (engine.music.player.has('stinger-victory') ? 1 : 0)).toBeGreaterThanOrEqual(3);
    engine.onEvent({ type: 'terrain-failed', code: 'x', message: 'y' }, snapshot(21, tanks));
    engine.onEvent({ type: 'incoming', tank: 0, impactTick: 40, predicted: [0, 18.4, 0] }, snapshot(22, tanks));
    expect(tele(engine).events).toMatchObject({ turn: 2, impact: 1, 'terrain-commit': 1, finish: 1, 'terrain-failed': 1, incoming: 1 });
    expect(tele(engine).lastError).toBeNull();
  });

  it('publishes the telemetry the capture checks read', async () => {
    const { engine } = await rig();
    frame(engine, snapshot(0, [tank(0, [0, 18.4, 0])]));
    const t = tele(engine);
    expect(t.state).toBe('running');
    for (const key of ['voices', 'busPeaks', 'clipCount', 'lastError', 'played', 'nan']) expect(t).toHaveProperty(key);
    for (const bus of ['master', 'weapons', 'explosions', 'vehicles', 'music']) expect(Number.isFinite(t.busPeaks[bus])).toBe(true);
    expect(t.clipCount).toBe(0);
    expect(JSON.parse(JSON.stringify(t))).toEqual(t);   // plain JSON (window.__tmtGame is serialised by the capture)
  });

  it('applies tmt:settings volumes', async () => {
    const { ctx, engine } = await rig();
    engine.applySettings({ audio: { master: 0.25, music: 0, sfx: 1, ui: 0.5, voice: 1 } });
    ctx.advance(2);
    expect((engine.m.buses.master as unknown as FakeGain).gain.valueAt(ctx.currentTime)).toBeCloseTo(0.25, 3);
    expect((engine.m.buses.groups.music as unknown as FakeGain).gain.valueAt(ctx.currentTime)).toBeCloseTo(0, 3);
    engine.applySettings(undefined);
    ctx.advance(2);
    expect((engine.m.buses.master as unknown as FakeGain).gain.valueAt(ctx.currentTime)).toBeCloseTo(0.8, 3);
  });

  it('falls back to native loops when the AudioWorklet is unavailable', async () => {
    const { engine } = await rig({ worklet: false });
    expect(engine.loops.mode).toBe('fallback');
    frame(engine, snapshot(0, [tank(0, [0, 18.4, 0], { trackSpeeds: [1.5, 1.5] })]));
    expect(tele(engine).voices.buses.vehicles).toBe(1);
    expect(tele(engine).lastError).toMatch(/AudioWorklet/);
  });
});

function allSources(engine: TankAudioIntegrator): (FakeBufferSource | FakeOscillator)[] {
  const budget = engine.m.budget as unknown as { active: { sources: (FakeBufferSource | FakeOscillator)[]; bus: string }[] };
  return budget.active.filter(v => v.bus === 'explosions').flatMap(v => v.sources);
}
