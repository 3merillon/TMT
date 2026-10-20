/** Score registry: id → builder. */
import type { Track } from '../sequencer';
import { build as title } from './title';
import { combat as cradleCombat, explore as cradleExplore } from './cradle';
import { duneExplore, duneCombat, frostExplore, frostCombat, forgeExplore, forgeCombat, haloExplore, haloCombat } from './worlds';
import { crawler, leviathan, titan, rustcrown, fleetLaunch } from './bosses';
import { escape, choice, endingRewind, endingRelease, workshop, stingers } from './finale';

export const SCORES: Record<string, () => Track> = {
  title, workshop,
  'cradle-explore': cradleExplore, 'cradle-combat': cradleCombat,
  'dune-explore': duneExplore, 'dune-combat': duneCombat,
  'frost-explore': frostExplore, 'frost-combat': frostCombat,
  'forge-explore': forgeExplore, 'forge-combat': forgeCombat,
  'halo-explore': haloExplore, 'halo-combat': haloCombat,
  'boss-crawler': crawler, 'boss-leviathan': leviathan, 'boss-titan': titan, 'boss-rustcrown': rustcrown, 'fleet-launch': fleetLaunch,
  'finale-escape': escape, 'finale-choice': choice, 'ending-rewind': endingRewind, 'ending-release': endingRelease,
  ...stingers(),
};
