import { voiceClip } from '../src/audio/campaign-voice';
import { describe, expect, it } from 'vitest';
import type { V3 } from '../src/game/contracts';
import { validateMatchSetup } from '../src/game/rules/setup';
import { distance, normalize } from '../src/game/math';
import { MissionRunner, missionIdOf, missionSetup, missionStructures, siteDirection, UNIT_KINDS, type MissionDef } from '../src/game/campaign/mission';
import { assembleKit, validateKitLoadout } from '../src/game/kit';
import { FIRST_LIGHT, MILLBROOK, OVER_THE_CURVE, PROLOGUE, missionById } from '../src/game/campaign/prologue';
import { Autopilot } from '../src/game/campaign/autopilot';
import { generatePlanetStructures, validateStructures } from '../src/game/terrain-structures';
import { realtimeRun, WARDEN } from './helpers/realtime';

/** Plays a mission like a competent new player: follow the marker, shoot what you see, dig in when told, weave when
 * a ring appears. Returns the runner and the run. */
function autopilot(def: MissionDef, limitSeconds = 900) {
  const runner = new MissionRunner(def);
  const run = realtimeRun(missionSetup(def, WARDEN), { script: runner });
  const m = run.match, pilot = new Autopilot();
  let seen = 0;
  for (let frame = 0; frame < limitSeconds * 60 && !m.finished; frame++) {
    const order = pilot.decide({ state: m.state, observer: 0, beat: runner.beatId, marker: runner.marker, canFire: m.canFire(0),
      events: run.events.slice(seen), solve: selection => m.solveAimTarget(0, selection) });
    seen = run.events.length;
    if (order.repair) m.command(0, { k: 'utility', id: 'repair' });
    if (order.aim) m.command(0, { k: 'aim', ...order.aim });
    if (order.fire) m.command(0, { k: 'fire' });
    run.run(1, order.drive);
  }
  for (const event of run.realtime) if (event.type === 'say') expect(voiceClip(event.speaker, event.text), `${event.speaker}: ${event.text}`).toBeDefined();
  return { runner, run };
}

describe('Prologue missions', () => {
  it('build valid realtime setups with the mission id, the hero bonus and the authored structures', () => {
    for (const def of PROLOGUE) {
      const setup = validateMatchSetup(missionSetup(def, WARDEN));
      expect(setup.rules.turnModel).toBe('realtime');
      expect(missionIdOf(setup)).toBe(def.id);
      expect(missionById(def.id)).toBe(def);
      expect(setup.tanks[0].maxHealth).toBe(260);
    }
    // Every mission's buildings pass the resident terrain's own validation (ids, orthonormal axes, the domain).
    for (const def of PROLOGUE) expect(() => validateStructures(missionStructures(def)), def.id).not.toThrow();
    const p1 = missionStructures(FIRST_LIGHT), generated = generatePlanetStructures(7, undefined, true, 'temperate');
    expect(p1.some(s => s.id === 'mission-p1-wall')).toBe(true);
    expect(p1.length).toBeLessThanOrEqual(generated.length + 1);
    // The wall stands between the flag and the hidden target, on the ground.
    const wall = p1.find(s => s.id === 'mission-p1-wall')!;
    const flag = siteDirection(FIRST_LIGHT.start, FIRST_LIGHT.sites.flag, 18), hidden = siteDirection(FIRST_LIGHT.start, FIRST_LIGHT.sites.hidden, 18);
    const up = normalize(wall.center as V3);
    expect(distance(up, flag) + distance(up, hidden)).toBeLessThan(distance(flag, hidden) * 1.05);
    expect(Math.hypot(...wall.center)).toBeGreaterThan(14);
  });

  it('assembles every unit kind on the real kit sockets', () => {
    for (const [kind, template] of Object.entries(UNIT_KINDS)) expect(() => assembleKit(validateKitLoadout(template.loadout)), kind).not.toThrow();
  });

  it('starts every mission with a title banner, a line and an objective', () => {
    for (const def of PROLOGUE) {
      const runner = new MissionRunner(def), run = realtimeRun(missionSetup(def, WARDEN), { script: runner });
      expect(run.realtime.find(e => e.type === 'banner')).toMatchObject({ title: def.title });
      expect(run.realtime.some(e => e.type === 'say')).toBe(true);
      expect(runner.objectiveList().length).toBeGreaterThan(0);
      expect(runner.beatId).toBe(def.beats[0].id);
    }
  });

  it('First Light can be completed and teaches its beats in order', () => {
    const { runner, run } = autopilot(FIRST_LIGHT);
    expect(runner.outcome, JSON.stringify({ beat: runner.beatId, time: run.match.state.time, tanks: run.match.state.tanks.map(t => ({ name: t.name, hp: t.health, pos: t.position })), last: run.realtime.slice(-3) })).toBe('won');
    expect(run.match.state.winnerTeam).toBe(0);
    const done = runner.objectiveList().filter(o => o.state === 'done').map(o => o.id);
    expect(done).toEqual(['flag', 'targets', 'lob', 'dodge', 'dig', 'mover']);
    expect(run.events.some(e => e.type === 'incoming' && e.tank === 0)).toBe(true);
    expect(run.realtime.at(-1)).toMatchObject({ type: 'mission', status: 'won' });
  }, 180_000);

  it('Over the Curve can be completed', () => {
    const { runner, run } = autopilot(OVER_THE_CURVE);
    expect(runner.outcome, JSON.stringify({ beat: runner.beatId, time: run.match.state.time, tanks: run.match.state.tanks.map(t => ({ name: t.name, hp: t.health, pos: t.position })), last: run.realtime.slice(-3) })).toBe('won');
    expect(run.realtime.some(e => e.type === 'tracer' && e.owner === 0)).toBe(true);
  }, 180_000);

  it('Millbrook can be completed, with Mags fighting alongside', () => {
    const { runner, run } = autopilot(MILLBROOK);
    expect(runner.outcome, JSON.stringify({ beat: runner.beatId, time: run.match.state.time, tanks: run.match.state.tanks.map(t => ({ name: t.name, hp: t.health, pos: t.position })), last: run.realtime.slice(-3) })).toBe('won');
    const mags = run.match.state.tanks.find(t => t.name === 'Mags')!;
    expect(mags.team).toBe(0);
    expect(run.events.some(e => e.type === 'shot' && e.player === mags.id) || run.realtime.some(e => e.type === 'tracer' && e.owner === mags.id)).toBe(true);
  }, 180_000);

  it('fails the mission when the Kestrel is destroyed', () => {
    const runner = new MissionRunner(FIRST_LIGHT), run = realtimeRun(missionSetup(FIRST_LIGHT, WARDEN), { script: runner });
    run.match.state.tanks[0].health = 0;
    run.run(2);
    expect(runner.outcome).toBe('failed');
    expect(run.events.at(-1)).toMatchObject({ type: 'finish', team: 1 });
    expect(run.realtime.some(e => e.type === 'banner' && e.title === 'Mission failed')).toBe(true);
  });
});
