import type { KitLoadoutIds, MatchSetup } from '../api/match';
import { missionSetup, type MissionId } from '../campaign/mission';
import { missionById } from '../campaign/catalog';
import { frame, normalize, add, mul } from '../math';
import { defaultSkirmish, skirmishSetup, type SkirmishOptions } from '../ui/skirmish-setup';
import type { OnlineMode } from './protocol';

export function makeOnlineSetup(mode: OnlineMode, capacity: 2 | 3, kit: KitLoadoutIds, options: SkirmishOptions = defaultSkirmish(7), mission: MissionId = 'p1'): MatchSetup {
  const setup = mode === 'coop' ? missionSetup(missionById(mission), kit, options.difficulty)
    : skirmishSetup({ ...options, turnModel: 'tempo', tanks: capacity, teams: 'ffa', opponents: 'local' }, kit);
  if (mode === 'coop') {
    const first = setup.tanks[0], spawn = first.spawn === 'auto' ? { up: [0, 1, 0] as [number, number, number], heading: 0 } : first.spawn;
    const right = frame(spawn.up, spawn.heading).right;
    setup.tanks = Array.from({ length: capacity }, (_, i) => ({ ...structuredClone(first), name: `Player ${i + 1}`,
      spawn: { up: normalize(add(spawn.up, mul(right, i * .11))), heading: spawn.heading } }));
  } else {
    setup.mode = 'online'; setup.id = `online:${mode}:${setup.seed}`;
    setup.rules.turnModel = mode === 'duel' ? 'tempo' : 'realtime';
    if (mode !== 'duel') {
      // Same realtime engine and ballistic weapons, with a wider artillery firing line and no automatic gun.
      setup.rules.autoCoax = mode !== 'artillery';
      delete setup.rules.aimSeconds; delete setup.rules.maxTurns; delete setup.rules.suddenDeathTurn;
      const spread = mode === 'artillery' ? .75 : .3;
      setup.tanks.forEach((t, i) => { t.spawn = { up: normalize([Math.cos(i * Math.PI * 2 / capacity) * spread, 1, Math.sin(i * Math.PI * 2 / capacity) * spread]), heading: -i * Math.PI * 2 / capacity }; });
    }
  }
  setup.online = { kind: mode, seats: Array.from({ length: capacity }, (_, i) => i) };
  return setup;
}
