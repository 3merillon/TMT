/** Local artillery setup. AI supports turn-based or realtime combat; pass-and-play always takes turns. */
import { DEFAULT_RULES, type BotProfileId, type Difficulty, type KitLoadoutIds, type MatchRules, type MatchSetup, type TankSpawn } from '../api/match';

export type PlanetChoice = MatchSetup['planet']['kind'];
export type TeamMode = 'ffa' | '2v2';
export type Opponents = 'ai' | 'local';
export interface RuleToggles { wind: boolean; fog: boolean; friendlyFire: boolean; aimTimer: boolean; limitedAmmo: boolean }
export interface SkirmishOptions {
  turnModel: MatchRules['turnModel'];
  planet: PlanetChoice;
  seed: number;
  tanks: number;
  teams: TeamMode;
  opponents: Opponents;
  brain: BotProfileId;
  difficulty: Difficulty;
  rules: RuleToggles;
}

export const PLANET_CHOICES: readonly { id: PlanetChoice; label: string }[] = Object.freeze([
  { id: 'auto', label: 'From the seed' }, { id: 'temperate', label: 'Temperate' }, { id: 'glacial', label: 'Glacial' },
  { id: 'dune', label: 'Dune' }, { id: 'volcanic', label: 'Volcanic' },
]);
/** Turn-based AI profiles. Realtime choices are limited to the profiles supported by its core below. */
export const BRAIN_CHOICES: readonly { id: BotProfileId; label: string; blurb: string }[] = Object.freeze([
  { id: 'legacy', label: 'Classic', blurb: 'The practice bot: steady and fair.' },
  { id: 'rusty', label: 'Rusty', blurb: 'Hesitant, wide shots; forgiving.' },
  { id: 'tosser', label: 'Tosser', blurb: 'Lobs high arcs and zeroes in.' },
  { id: 'vex', label: 'Vex', blurb: 'Relocates to cover and punishes exposure.' },
  { id: 'cyborg', label: 'Cyborg', blurb: 'Cold, precise, relentless.' },
]);
/** Only profiles implemented by the realtime core are offered in simultaneous artillery. */
export const REALTIME_BRAIN_CHOICES: typeof BRAIN_CHOICES = Object.freeze([
  { id: 'rusty', label: 'Rusty', blurb: 'Closes to firing range, then shoots on reload.' },
  { id: 'tosser', label: 'Tosser', blurb: 'Keeps more distance and fires high arcs.' },
  { id: 'vex', label: 'Vex', blurb: 'Keeps a longer firing distance and backs away when crowded.' },
]);
export const skirmishBrains = (turnModel: MatchRules['turnModel']): typeof BRAIN_CHOICES => turnModel === 'realtime' ? REALTIME_BRAIN_CHOICES : BRAIN_CHOICES;
export const DIFFICULTY_CHOICES: readonly { id: Difficulty; label: string }[] = Object.freeze([
  { id: 'story', label: 'Story' }, { id: 'normal', label: 'Normal' }, { id: 'hard', label: 'Hard' }, { id: 'ace', label: 'Ace' },
]);
export const TANK_COUNTS: readonly number[] = Object.freeze([2, 3, 4]);
export const TEAM_NAMES: readonly string[] = Object.freeze(['Brass', 'Rust', 'Teal', 'Ochre']);

/** The rule presets exposed by the local artillery menu. */
const WIND_RULE = Object.freeze({ mean: 1.2, gust: 0.6, period: 6 });
const AIM_SECONDS = 20;
const LIMITED_AMMO = Object.freeze({ heavy: 3, incendiary: 2, nuclear: 1 });

export function randomSeed(random: () => number = Math.random): number { return Math.floor(random() * 0x100000000) >>> 0; }

export function defaultSkirmish(seed: number, difficulty: Difficulty = 'normal'): SkirmishOptions {
  return { turnModel: 'tempo', planet: 'auto', seed, tanks: 2, teams: 'ffa', opponents: 'ai', brain: 'legacy', difficulty,
    rules: { wind: false, fog: DEFAULT_RULES.fog, friendlyFire: DEFAULT_RULES.friendlyFire, aimTimer: false, limitedAmmo: false } };
}

/** Apply menu choices together so pass-and-play, team count and available AI profiles cannot disagree. */
export function updateSkirmishOptions(current: SkirmishOptions, patch: Partial<SkirmishOptions>): SkirmishOptions {
  const next = { ...current, ...patch };
  if (patch.teams === '2v2') next.tanks = 4;
  if (patch.tanks !== undefined && patch.tanks !== 4 && next.teams === '2v2') next.teams = 'ffa';
  if (next.opponents === 'local') next.turnModel = 'tempo';
  const brains = skirmishBrains(next.turnModel);
  if (!brains.some(brain => brain.id === next.brain)) next.brain = brains[0].id;
  return next;
}

/** Why the options cannot build a setup, or null. */
export function skirmishProblem(o: SkirmishOptions): string | null {
  if (o.turnModel !== 'tempo' && o.turnModel !== 'realtime') return 'Choose turn-based or realtime artillery.';
  if (o.opponents === 'local' && o.turnModel === 'realtime') return 'Pass-and-play requires turn-based artillery.';
  if (!skirmishBrains(o.turnModel).some(brain => brain.id === o.brain)) return 'Choose an AI profile available for this combat mode.';
  if (!Number.isSafeInteger(o.seed) || o.seed < 0 || o.seed > 0xffffffff) return 'The seed is a whole number from 0 to 4294967295.';
  if (!TANK_COUNTS.includes(o.tanks)) return 'A skirmish has 2 to 4 tanks.';
  if (o.teams === '2v2' && o.tanks !== 4) return 'Teams of two need 4 tanks.';
  return null;
}

export function skirmishMode(o: SkirmishOptions): MatchSetup['mode'] { return o.opponents === 'local' ? 'local' : 'skirmish'; }

export function skirmishRules(t: RuleToggles, turnModel: MatchRules['turnModel'] = 'tempo'): MatchRules {
  return {
    ...DEFAULT_RULES, ammo: t.limitedAmmo ? { ...LIMITED_AMMO } : { ...DEFAULT_RULES.ammo },
    wind: t.wind ? { ...WIND_RULE } : null, fog: t.fog, friendlyFire: t.friendlyFire,
    turnModel, ...(turnModel === 'realtime' ? { autoCoax: false } : t.aimTimer ? { aimSeconds: AIM_SECONDS } : {}),
  };
}

/** The MatchSetup for these options. Tank 0 is the player; in 2v2 the teams alternate (0, 1, 0, 1). Throws on a problem. */
export function skirmishSetup(o: SkirmishOptions, player: KitLoadoutIds): MatchSetup {
  const problem = skirmishProblem(o);
  if (problem) throw new Error(problem);
  const local = o.opponents === 'local';
  const teamOf = (index: number) => o.teams === '2v2' ? index % 2 : index;
  const teamCount = o.teams === '2v2' ? 2 : o.tanks;
  const brainName = BRAIN_CHOICES.find(b => b.id === o.brain)?.label ?? o.brain;
  const tanks: TankSpawn[] = Array.from({ length: o.tanks }, (_, index): TankSpawn => {
    const ai = !local && index > 0;
    const name = index === 0 ? (local ? 'Player 1' : 'You') : local ? `Player ${index + 1}` : o.tanks === 2 ? brainName : `${brainName} ${index}`;
    return { team: teamOf(index), loadout: { ...player }, spawn: 'auto', name, ...(ai ? { brain: o.brain, difficulty: o.difficulty } : {}) };
  });
  const teams = Array.from({ length: teamCount }, (_, id) => ({
    id, name: o.teams === 'ffa' ? tanks[id].name! : `${TEAM_NAMES[id]} team`, ai: tanks.every((tank, index) => tank.team !== id || (!local && index > 0)),
  }));
  return {
    id: `skirmish:${o.seed}:${o.tanks}${o.teams}:${o.opponents}${o.turnModel === 'realtime' ? ':realtime' : ''}`, seed: o.seed, mode: skirmishMode(o), planet: { kind: o.planet },
    teams, tanks, rules: skirmishRules(o.rules, o.turnModel), objectives: [{ kind: 'eliminate' }],
  };
}
