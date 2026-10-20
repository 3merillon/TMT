/** Saved campaign checkpoints take the current unit balance: a save keeps its units, not the tuning they spawned with. */
import { describe, expect, it } from 'vitest';
import { OVER_THE_CURVE } from '../src/game/campaign/prologue';
import { MissionRunner, missionSetup, retuneUnit, UNIT_KINDS, unitKindOf, type UnitKind } from '../src/game/campaign/mission';
import { RealtimeMatch, type RealtimeCheckpoint } from '../src/game/realtime/match';
import { realtimeRun, WARDEN } from './helpers/realtime';

describe('campaign unit retuning', () => {
  it('identifies every unit template from its spec alone', () => {
    for (const kind of Object.keys(UNIT_KINDS) as UnitKind[]) expect(unitKindOf(UNIT_KINDS[kind])).toBe(kind);
  });

  it('restores an old ambush save with the current Rusty reload and an ended reveal', () => {
    const def = { ...OVER_THE_CURVE, beats: OVER_THE_CURVE.beats.filter(b => b.id === 'ambush') };
    const play = realtimeRun(missionSetup(def, WARDEN), { script: new MissionRunner(def) });
    play.run(60);
    const rusties = play.match.state.tanks.filter(t => play.match.unitSpec(t.id)?.brain === 'rusty').map(t => t.id);
    expect(rusties).toHaveLength(2);
    const reload = play.match.reloadOf(rusties[0]).total;
    let saved: RealtimeCheckpoint | null = null;
    play.until(() => (saved = play.match.checkpoint()) !== null, 600);
    // A save from before the change: full-rate Rustys, a permanently revealed player and no reveal timer.
    const old = structuredClone(saved!);
    for (const u of old.units) delete (u.spec as { reloadScale?: number }).reloadScale;
    old.units[0].revealed = true;
    delete (old.script as { flags: Record<string, number> }).flags.lostSight;
    expect(retuneUnit(old.units[rusties[0]].spec).reloadScale).toBe(UNIT_KINDS.rusty.reloadScale);
    const restored = new RealtimeMatch(play.world, play.match.setup, { checkpoint: old, script: new MissionRunner(def) });
    expect(restored.reloadOf(rusties[0]).total).toBeCloseTo(reload, 6);
    expect(restored.unitSpec(0)?.reloadScale).toBeUndefined();
    // The beat's first five seconds still reveal the Kestrel; after them the save drops the reveal like a new game.
    for (let i = 0; i < 6 * 60; i++) restored.step(1 / 60);
    let later: RealtimeCheckpoint | null = null;
    for (let i = 0; i < 600 && !later; i++) { restored.step(1 / 60); later = restored.checkpoint(); }
    expect(later!.units[0].revealed).toBe(false);
  });
});
