import { describe, expect, it } from 'vitest';
import type { GameEvent, ImpactEvent } from '../src/game/contracts';
import { validateMatchSetup } from '../src/game/rules/setup';
import { DEFAULT_RULES } from '../src/game/api/match';
import { BASE_RELOAD, COAX, reloadTicks } from '../src/game/realtime/rules';
import { assembleKit, validateKitLoadout } from '../src/game/kit';
import { FIXED_DT } from '../src/game/rules/ballistics';
import { add, distance, normalize, rotate } from '../src/game/math';
import { realtimeRun, realtimeSetup, site, SKIFF_MORTAR, unit, WARDEN } from './helpers/realtime';

const impacts = (events: GameEvent[]) => events.filter((e): e is ImpactEvent => e.type === 'impact');

/** Aim the player at a surface point with the match's own solver and return whether a ready arc exists. */
function aimAt(run: ReturnType<typeof realtimeRun>, target: [number, number, number]): boolean {
  const result = run.match.solveAimTarget(0, target);
  if (!result.aim) return false;
  return run.match.command(0, { k: 'aim', ...result.aim });
}

describe('realtime match', () => {
  it('validates realtime setups with a single starting tank and still rejects one-tank duels', () => {
    expect(() => validateMatchSetup(realtimeSetup())).not.toThrow();
    const duel = { ...realtimeSetup(), rules: { ...DEFAULT_RULES, ammo: {} } };
    expect(() => validateMatchSetup(duel)).toThrow(/2 to 8 tanks/);
    const chess = realtimeSetup();
    chess.tanks.push({ ...chess.tanks[0], team: 1 });
    expect(() => validateMatchSetup({ ...chess, rules: { ...chess.rules, turnModel: 'chess' as never } })).toThrow(/turn model/);
  });

  it('moves every tank in the same tick: the player from its input, a brain from its own goal', () => {
    const run = realtimeRun(realtimeSetup(), { units: [unit(1, site(8, 4), { brain: 'patrol', waypoints: [site(8, -6), site(14, 4)], unarmed: true })] });
    const start = run.match.state.tanks.map(t => [...t.position]);
    run.run(60, { throttle: 1, steer: 0 });
    const [player, patrol] = run.match.state.tanks;
    expect(distance(player.position, start[0] as never)).toBeGreaterThan(1);
    expect(distance(patrol.position, start[1] as never)).toBeGreaterThan(1);
    expect(run.match.state.phase).toBe('aim');
    expect(run.match.state.active).toBe(0);
  });

  it('gates the main gun on its reload and keeps several shells in flight', () => {
    const run = realtimeRun(realtimeSetup({ player: SKIFF_MORTAR }));
    run.match.command(0, { k: 'aim', yaw: 0, pitch: 1.35, power: 1 });
    expect(run.match.canFire(0)).toBe(true);
    expect(run.match.command(0, { k: 'fire' })).toBe(true);
    expect(run.match.canFire(0)).toBe(false);
    expect(run.match.command(0, { k: 'fire' })).toBe(false);
    const reload = run.match.reloadOf(0), kit = assembleKit(validateKitLoadout(SKIFF_MORTAR));
    expect(reload.total).toBeCloseTo(reloadTicks(kit) * FIXED_DT, 9);
    expect(reload.total).toBeCloseTo(BASE_RELOAD.mortar * kit.stats.tempo, 1);
    expect(reload.remaining).toBeCloseTo(reload.total, 9);
    run.until(r => r.match.canFire(0), 400);
    expect(run.match.state.projectiles.length).toBe(1);
    expect(run.match.command(0, { k: 'fire' })).toBe(true);
    run.run(1);
    expect(run.match.state.projectiles.length).toBe(2);
    expect(new Set(run.match.state.projectiles.map(p => p.id)).size).toBe(2);
  });

  it('damages and destroys an enemy with a crater committed through the transactions', () => {
    // Beyond coax range, so the main gun does the work.
    const target = site(13.5);
    const run = realtimeRun(realtimeSetup(), { units: [unit(1, target, { maxHealth: 20, unarmed: true })] });
    // Picked like the UI picks a tank: its collider, so the solve aims for a direct hit.
    const center = run.match.state.tanks[1].position;
    const solved = run.match.solveAimTarget(0, { point: center, object: { id: 'tank:1', kind: 'tank', collider: { shape: 'sphere', center, radius: 0.7 } } });
    expect(solved.status).toBe('ready');
    expect(run.match.command(0, { k: 'aim', ...solved.aim! })).toBe(true);
    expect(run.match.command(0, { k: 'fire' })).toBe(true);
    run.until(r => r.events.some(e => e.type === 'terrain-commit'), 600);
    const hit = impacts(run.events)[0];
    expect(hit).toBeDefined();
    expect(hit.hits?.find(h => h.tank === 1)?.damage).toBeGreaterThan(0);
    expect(run.world.craters.length).toBe(1);
    expect(run.events.some(e => e.type === 'kill' && e.tank === 1 && e.by === 0)).toBe(true);
    expect(run.match.state.tanks[1].health).toBe(0);
    // The default result: every enemy down, the player's team wins.
    expect(run.match.finished).toBe(true);
    expect(run.events.at(-1)).toMatchObject({ type: 'finish', team: 0 });
  });

  it('spares allies with friendly fire off but never the shooter', () => {
    const run = realtimeRun(realtimeSetup({ friendlyFire: false }), { units: [
      unit(0, site(4.5, 0.9), { brain: 'dummy', unarmed: true }), unit(1, site(30), { unarmed: true }),
    ] });
    // Shoot the ground between the player and its ally.
    expect(aimAt(run, normalize(site(2.6, 0.5)).map(v => v * 18) as never)).toBe(true);
    run.match.command(0, { k: 'fire' });
    run.until(r => impacts(r.events).length > 0, 300);
    const event = impacts(run.events)[0];
    expect(event.hits?.find(h => h.tank === 1)?.damage ?? 0).toBe(0);
    expect(event.hits?.find(h => h.tank === 0)?.damage ?? 0).toBeGreaterThan(0);
  });

  it('fires the coax automatically inside its arc, never cuts terrain, and overheats', () => {
    const run = realtimeRun(realtimeSetup(), { units: [unit(1, site(7), { maxHealth: 500, unarmed: true })] });
    run.match.command(0, { k: 'aim', yaw: 0, pitch: 0.3, power: 0.5 });
    run.run(9 * 20);
    const tracers = run.realtime.filter(e => e.type === 'tracer');
    expect(tracers.length).toBeGreaterThan(10);
    expect(tracers.every(t => t.type === 'tracer' && t.owner === 0 && t.victim === 1)).toBe(true);
    expect(run.match.state.tanks[1].health).toBeLessThan(500);
    expect(run.events.some(e => e.type === 'impact' || e.type === 'terrain-commit')).toBe(false);
    expect(run.world.craters.length).toBe(0);
    expect(run.match.coaxOf(0).overheated || run.match.coaxOf(0).heat > 0.5).toBe(true);
    // Turned away, the arc no longer covers the target.
    const quiet = realtimeRun(realtimeSetup(), { units: [unit(1, site(7), { maxHealth: 500, unarmed: true })] });
    quiet.match.command(0, { k: 'aim', yaw: Math.PI, pitch: 0.3, power: 0.5 });
    quiet.run(120);
    expect(quiet.realtime.filter(e => e.type === 'tracer').length).toBe(0);
    expect(COAX.range).toBeGreaterThan(7);
  });

  it('launches authored enemy tracers from the rotated gun socket instead of the chassis nose', () => {
    for (const [visualKind, barrel] of [['rustling', .33], ['spire', .57]] as const) {
      const run = realtimeRun(realtimeSetup(), { units: [unit(1, site(0, 7), { maxHealth: 500, unarmed: true })] });
      const own = run.match.state.tanks[0]; own.visualKind = visualKind;
      run.match.command(0, { k: 'aim', yaw: Math.PI / 2, pitch: 0, power: .5 });
      run.run(1);
      const tracer = run.realtime.find(e => e.type === 'tracer');
      expect(tracer?.type).toBe('tracer');
      if (tracer?.type === 'tracer') {
        // At 90 degrees the turret-local barrel points along chassis +X; its bearing remains at Z=-.08.
        const muzzle = add(own.position, rotate([barrel, .55, -.08], own.rotation));
        expect(distance(tracer.from, muzzle)).toBeLessThan(1e-6);
      }
      run.match.dispose();
    }
  });

  it('telegraphs a hostile shell landing near a tank of the other team, and only then', () => {
    let near = false, far = false;
    const run = realtimeRun(realtimeSetup(), {
      units: [unit(1, site(14), { brain: 'dummy', loadout: SKIFF_MORTAR })],
      script: { start() {}, tick(api) {
        if (api.tick === 10) far = api.fireAt(1, normalize(site(14, 9)).map(v => v * 18) as never, true);
        if (api.tick === 400) near = api.fireAt(1, api.state.tanks[0].position, true);
      } },
    });
    run.run(380);
    expect(far).toBe(true);
    expect(run.events.filter(e => e.type === 'incoming')).toHaveLength(0);
    run.run(400);
    expect(near).toBe(true);
    const incoming = run.events.filter(e => e.type === 'incoming');
    expect(incoming).toHaveLength(1);
    expect(incoming[0]).toMatchObject({ type: 'incoming', tank: 0 });
    if (incoming[0].type === 'incoming') {
      const landed = impacts(run.events).at(-1)!;
      expect(distance(incoming[0].predicted, landed.position)).toBeLessThan(1.5);
    }
  });

  it('a rusty brain fires at a visible enemy, and nothing fires without a contact', () => {
    const seen = realtimeRun(realtimeSetup({ fog: true }), { units: [unit(1, site(10), { brain: 'rusty' })] });
    seen.run(60 * 6);
    expect(seen.events.some(e => e.type === 'shot' && e.player === 1)).toBe(true);
    // Far over the horizon: no sight, no shot.
    const hidden = realtimeRun(realtimeSetup({ fog: true }), { units: [unit(1, [0, -1, 0.05], { brain: 'rusty', immobile: true })] });
    hidden.run(60 * 6);
    expect(hidden.events.some(e => e.type === 'shot')).toBe(false);
  });

  it('never stalls on terrain: a later shell landing first waits for its turn in the serial preparer, the match keeps ticking', () => {
    // The resident preparer works one edit at a time. A long lob fired first and a flat shot fired second land out of
    // order; every crater still commits, in impact order, and no tick is ever held back.
    const run = realtimeRun(realtimeSetup(), { serial: true, latency: 20, units: [unit(1, site(30), { brain: 'dummy', loadout: SKIFF_MORTAR, unarmed: true })],
      script: { start() {}, tick(api) {
        if (api.tick === 5) api.fireAt(1, normalize(site(40, 6)).map(v => v * 18) as never, true);
        if (api.tick === 20) api.fireAt(1, normalize(site(24)).map(v => v * 18) as never, false);
      } } });
    const ticks: number[] = [];
    for (let frame = 0; frame < 900; frame++) { run.run(1); ticks.push(run.match.state.tick); }
    expect(run.match.stalledFrames).toBe(0);
    expect(ticks.every((tick, i) => tick === i + 1)).toBe(true);
    const order = impacts(run.events).map(e => e.cut!.id), committed = run.events.filter(e => e.type === 'terrain-commit').flatMap(e => e.type === 'terrain-commit' ? e.cutIds : []);
    expect(order).toHaveLength(2);
    expect(committed).toEqual(order);
    expect(run.world.craters).toHaveLength(2);
  });

  it('is deterministic: the same setup and inputs give the same state hash', () => {
    const play = () => {
      const run = realtimeRun(realtimeSetup({ fog: true, seed: 9 }), { units: [unit(1, site(11, 3), { brain: 'rusty' }), unit(1, site(9, -4), { brain: 'rustling', loadout: { ...WARDEN, hull: 'skiff', runningGear: 'scout' }, coaxOnly: true, maxHealth: 30 })] });
      run.run(90, { throttle: 0.6, steer: 0.2 });
      run.match.command(0, { k: 'aim', yaw: 0.1, pitch: 0.5, power: 0.6 });
      run.match.command(0, { k: 'fire' });
      run.run(240, { throttle: -0.3, steer: -0.4 });
      return run.match.matchHash();
    };
    expect(play()).toBe(play());
  });
});
