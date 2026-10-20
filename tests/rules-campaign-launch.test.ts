import { describe, expect, it } from 'vitest';
import { ACT_II } from '../src/game/campaign/acts';
import { launchDefence, LAUNCH_POSTS } from '../src/game/campaign/launch-defence';
import { MissionRunner, missionSetup } from '../src/game/campaign/mission';
import { realtimeRun, WARDEN, unit } from './helpers/realtime';
import { RealtimeMatch } from '../src/game/realtime/match';
import { normalize } from '../src/game/math';

describe('Council launch pads', () => {
  const fixture = () => {
    const beat = launchDefence(), base = ACT_II.find(m => m.id === 'ii-7')!;
    const def = { ...base, beats: [{ ...beat, enter(c: Parameters<NonNullable<typeof beat.enter>>[0]) {
      for (const name of ['mags', 'brann', 'seraphine'] as const) c.spawn(name, 'start');
      beat.enter!(c);
    } }] };
    const runner = new MissionRunner(def), play = realtimeRun(missionSetup(def, WARDEN), { script: runner });
    return { runner, play, def };
  };
  it('contests only the occupied pad and keeps all three timers independent', () => {
    const { runner, play } = fixture(), pad = play.match.state.tanks.find(t => t.name === 'Forge launch pad')!;
    // A normal unarmed enemy occupies Forge; its mere presence must not pause the other launch crews.
    const enemy = unit(1, normalize(pad.position), { unarmed: true, immobile: true, group: 'test-contester' });
    play.match.dispose();
    const contest = { ...runner.def, beats: [{ ...runner.def.beats[0], enter(c: Parameters<NonNullable<typeof runner.def.beats[0]['enter']>>[0]) {
      runner.def.beats[0].enter!(c); c.api.spawn(enemy);
    } }] };
    const other = new MissionRunner(contest), run = realtimeRun(missionSetup(contest, WARDEN), { script: other });
    run.run(60);
    const flags = other.checkpoint().flags;
    expect(flags['launch:forge-pad']).toBe(0);
    expect(flags['launch:aether-pad']).toBeGreaterThan(.9);
    expect(flags['launch:harbor-pad']).toBeGreaterThan(.9);
    run.match.dispose();
  });
  it('preserves individual orders across checkpoints and rejects invalid assignments', () => {
    const { runner, play, def } = fixture();
    expect(runner.assignCompanion('brann', 'harbor-pad')).toBe(true);
    expect(runner.assignCompanion('brann', 'missing')).toBe(false);
    expect(runner.assignCompanion('relay', 'forge-pad')).toBe(false);
    expect(runner.companionPost('brann')).toBe('harbor-pad');
    const saved = play.match.checkpoint()!, restored = new MissionRunner(def);
    const match = new RealtimeMatch(play.world, play.match.setup, { checkpoint: saved, script: restored });
    expect(restored.companionPost('brann')).toBe('harbor-pad');
    expect(match.checkpoint()!.units.map(u => u.commanded)).toEqual(saved.units.map(u => u.commanded));
    expect(match.command(0, { k: 'utility', id: 'squad-follow' })).toBe(true);
    expect(restored.companionPost('brann')).toBeNull();
    match.dispose(); play.match.dispose();
  });
  it('fails on the loss of any unlaunched pad, while an empty launched pad may be lost', () => {
    for (const launched of [false, true]) {
      const { runner, play, def } = fixture(), saved = play.match.checkpoint()!;
      const script = saved.script as ReturnType<MissionRunner['checkpoint']>;
      script.flags['launched:forge-pad'] = +launched;
      saved.state.tanks.find(t => t.name === 'Forge launch pad')!.health = 0;
      const restored = new MissionRunner(def), match = new RealtimeMatch(play.world, play.match.setup, { checkpoint: saved, script: restored });
      match.step(1 / 60);
      expect(restored.outcome).toBe(launched ? null : 'failed');
      expect(LAUNCH_POSTS).toHaveLength(3);
      match.dispose(); play.match.dispose();
    }
  });
});
