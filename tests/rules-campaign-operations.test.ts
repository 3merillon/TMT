import { voiceClip } from '../src/audio/campaign-voice';
import { describe, expect, it } from 'vitest';
import { CAMPAIGN } from '../src/game/campaign/catalog';
import { OPERATIONS } from '../src/game/campaign/acts';
import { MissionRunner, missionSetup, MISSION_IDS } from '../src/game/campaign/mission';
import { Autopilot } from '../src/game/campaign/autopilot';
import { campaignReward, missionUnlocked } from '../src/game/campaign/progress';
import { defaultProfile } from '../src/game/meta/profile';
import { validateMatchSetup } from '../src/game/rules/setup';
import { validateStructures } from '../src/game/terrain-structures';
import { realtimeRun, WARDEN } from './helpers/realtime';
import type { DriveInput } from '../src/game/contracts';

describe('The Unwinding operations', () => {
  it('has exactly the eighteen planned missions with valid structures and dependencies', () => {
    expect(CAMPAIGN.map(m => m.id)).toEqual([...MISSION_IDS]);
    for (const def of CAMPAIGN) {
      const setup = validateMatchSetup(missionSetup(def, WARDEN));
      expect(() => validateStructures(setup.structures!), def.id).not.toThrow();
      for (const id of def.requires ?? []) expect(MISSION_IDS).toContain(id);
    }
  });
  it('opens all three Act II branches and requires all three alliances for the convergence', () => {
    const p = defaultProfile(); p.stars['campaign:1-5'] = 1;
    for (const id of ['t-a', 'f-a', 'c-a'] as const) expect(missionUnlocked(p, id)).toBe(true);
    p.stars['campaign:t-b'] = p.stars['campaign:f-b'] = 1;
    expect(missionUnlocked(p, 'ii-7')).toBe(false); p.stars['campaign:c-b'] = 1;
    expect(missionUnlocked(p, 'ii-7')).toBe(true);
  });
  it('awards first clears and improvements once, and preserves both endings', () => {
    const result = { medal: false, optional: false, secrets: 0 };
    const first = campaignReward(defaultProfile(), '3-3', { ...result, ending: 'rewind' });
    const again = campaignReward(first, '3-3', { ...result, ending: 'release' });
    expect(again.xp).toBe(first.xp); expect(again.unlocks).toEqual(expect.arrayContaining(['ending:rewind', 'ending:release']));
    expect(campaignReward(again, '3-3', { ...result, medal: true }).xp).toBe(first.xp + 15);
  });
  it('meets the planned fitting milestones without requiring optional grinding', () => {
    let clear = defaultProfile(), complete = defaultProfile();
    const milestones = new Map([['p3', 3], ['1-5', 6], ['ii-7', 10], ['3-3', 12]]);
    for (const def of CAMPAIGN) {
      clear = campaignReward(clear, def.id, { medal: false, optional: false, secrets: 0 });
      complete = campaignReward(complete, def.id, { medal: true, optional: true, secrets: def.secrets?.length ?? 0 });
      if (milestones.has(def.id)) expect(clear.rank, def.id).toBe(milestones.get(def.id));
    }
    expect(clear.xp).toBe(1100); expect(complete.rank).toBe(16);
  });
  for (const def of OPERATIONS) it(`${def.id}: ${def.title} completes through ordinary player commands`, () => {
    const runner = new MissionRunner(def), pilot = new Autopilot();
    // Construct the real scripted match; no forced kills, teleports or shortened defence clocks.
    const play = realtimeRun(missionSetup(def, WARDEN), { script: runner });
    let seen = 0;
    let drive: DriveInput = { throttle: 0, steer: 0 };
    const decisionTicks = def.id === 'ii-7' ? 6 : 1;
    for (let tick = 0; tick < 1500 * 60 && !play.match.finished; tick++) {
      const m = play.match, own = m.state.tanks[0];
      if (runner.beatId === 'ending-choice') runner.chooseEnding('release');
      if (own.health < (own.maxHealth ?? 1) * .65) m.command(0, { k: 'utility', id: 'repair' });
      // Council's long launch defence samples player decisions at 10 Hz to avoid repeated blocked aim solves.
      // Other missions keep their existing 60 Hz pilot; all simulation clocks and queued events are preserved.
      if (tick % decisionTicks === 0) {
        const order = pilot.decide({ state: m.state, observer: 0, beat: runner.beatId, marker: runner.marker, canFire: m.canFire(0), events: play.events.slice(seen), solve: target => m.solveAimTarget(0, target) });
        seen = play.events.length;
        if (order.repair) m.command(0, { k: 'utility', id: 'repair' });
        if (order.headlights !== undefined && order.headlights !== (own.headlights !== false)) m.command(0, { k: 'utility', id: 'headlights' });
        if (order.aim) m.command(0, { k: 'aim', ...order.aim });
        if (order.fire) m.command(0, { k: 'fire' });
        drive = order.drive;
      }
      play.run(1, drive);
    }
    expect(runner.outcome, JSON.stringify({ beat: runner.beatId, time: play.match.state.time, hull: play.match.state.tanks[0].health,
      vehicles: play.match.state.tanks.filter(t => !t.retired).map(t => ({ id: t.id, name: t.name, health: t.health, machinery: t.machinery, position: t.position })),
      objectives: runner.objectiveList(), last: play.realtime.slice(-4) })).toBe('won');
    for (const event of play.realtime) if (event.type === 'say') expect(voiceClip(event.speaker, event.text), `${event.speaker}: ${event.text}`).toBeDefined();
    expect(play.match.stalledFrames).toBe(0);
    play.match.dispose();
  }, 180_000);
});
