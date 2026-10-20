/** MatchSetup intake (plan §5.2): validation with explicit errors (I3), the legacy option form, and spawn poses.
 * Pure and deterministic; no clocks, no randomness. */
import type { Loadout, Q4, V3, WorldQuery } from '../contracts';
import { add, dot, frame, mul, normalize, rotation, sub, tangent } from '../math';
import { DEFAULT_RULES, practiceSetup, type BotProfileId, type Difficulty, type MatchRules, type MatchSetup, type TankSpawn } from '../api/match';
import { assembleKit, validateKitLoadout } from '../kit';
import { DEFAULT_LOADOUT, validateLoadout } from '../modules';
import { validMunition } from '../munitions';
import { ROOT_SURFACE_LIFT } from '../kit/dimensions';
import { MAX_TERRAIN_BLAST_RADIUS, MIN_TERRAIN_BLAST_RADIUS } from '../terrain-config';
import { MAX_REALTIME_UNITS } from '../realtime/rules';
import { crewBuild } from '../campaign/loadout';

/** The pre-MatchSetup constructor form of GameSimulation (a thin wrapper over practiceSetup). */
export interface SimOptionsV1 { bot?: boolean; seed?: number; loadout?: Loadout; driveTest?: boolean }
export const MAX_TANKS = 8;
export const MAX_CHARGE = 3;
export const DEFAULT_SEED = 1977;
/** Brains implemented in Wave 1 (plan §3 AI: W1 ships 4 personalities plus today's bot). */
export const W1_BRAINS: readonly BotProfileId[] = Object.freeze(['legacy', 'rusty', 'tosser', 'vex', 'cyborg']);
const DIFFICULTIES: readonly Difficulty[] = ['story', 'normal', 'hard', 'ace'];
const MODES: readonly MatchSetup['mode'][] = ['bot', 'local', 'drive', 'skirmish', 'campaign', 'online'];
const PLANETS: readonly MatchSetup['planet']['kind'][] = ['auto', 'temperate', 'glacial', 'dune', 'volcanic'];

export function isMatchSetup(value: unknown): value is MatchSetup {
  return !!value && typeof value === 'object' && Array.isArray((value as MatchSetup).tanks) && !!(value as MatchSetup).rules;
}

/** The options form maps onto practiceSetup exactly (bot duel, pass-and-play or drive test). */
export function optionsSetup(options: SimOptionsV1): MatchSetup {
  const loadout = options.loadout ?? DEFAULT_LOADOUT;
  if (!validateLoadout(loadout)) throw new Error('Invalid initial loadout');
  const mode = options.driveTest ? 'drive' : (options.bot ?? true) ? 'bot' : 'local';
  return practiceSetup({ seed: (options.seed ?? DEFAULT_SEED) >>> 0, mode, player: loadout });
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const vector = (value: unknown): value is V3 => Array.isArray(value) && value.length === 3 && value.every(finite);
function fail(message: string): never { throw new Error(`Invalid match setup: ${message}`); }

export function validateRules(rules: MatchRules): MatchRules {
  if (!rules || typeof rules !== 'object') fail('rules must be an object');
  const r = rules as unknown as Record<string, unknown>;
  for (const key of ['moveSeconds', 'projectileAge', 'gravityScale', 'radarCost'] as const) if (!finite(r[key]) || (r[key] as number) < 0) fail(`rules.${key} must be a finite non-negative number`);
  if ((r.projectileAge as number) <= 0 || (r.gravityScale as number) <= 0) fail('rules.projectileAge and rules.gravityScale must be positive');
  if (!integer(r.startCharge, 0, MAX_CHARGE)) fail(`rules.startCharge must be an integer in [0, ${MAX_CHARGE}]`);
  if (!integer(r.commitWindowTicks, 0, 600)) fail('rules.commitWindowTicks must be an integer in [0, 600]');
  if (r.turnModel !== 'tempo' && r.turnModel !== 'realtime') fail(`unknown turn model ${String(r.turnModel)}`);
  if (r.autoCoax !== undefined && typeof r.autoCoax !== 'boolean') fail('rules.autoCoax must be a boolean');
  if (r.aimSeconds !== undefined && (!finite(r.aimSeconds) || (r.aimSeconds as number) <= 0)) fail('rules.aimSeconds must be positive');
  if (r.maxTurns !== undefined && !integer(r.maxTurns, 1)) fail('rules.maxTurns must be a positive integer');
  if (r.suddenDeathTurn !== undefined && !integer(r.suddenDeathTurn, 1)) fail('rules.suddenDeathTurn must be a positive integer');
  if (r.wind !== null) {
    const wind = r.wind as Record<string, unknown> | undefined;
    if (!wind || !finite(wind.mean) || !finite(wind.gust) || !finite(wind.period) || (wind.mean as number) < 0 || (wind.gust as number) < 0 || (wind.period as number) <= 0)
      fail('rules.wind must be null or { mean ≥ 0, gust ≥ 0, period > 0 }');
  }
  if (!r.ammo || typeof r.ammo !== 'object') fail('rules.ammo must be an object');
  for (const [id, count] of Object.entries(r.ammo as Record<string, unknown>)) {
    if (!validMunition(id)) fail(`rules.ammo has an unknown munition ${id}`);
    if (count !== undefined && !integer(count, 0)) fail(`rules.ammo.${id} must be a non-negative integer`);
  }
  for (const key of ['fog', 'friendlyFire', 'brace', 'taps', 'overdrive', 'fallDamage'] as const) if (typeof r[key] !== 'boolean') fail(`rules.${key} must be a boolean`);
  if (!integer(r.supplyEvery, 0)) fail('rules.supplyEvery must be a non-negative integer');
  for (const key of ['brace', 'taps', 'overdrive', 'fallDamage'] as const) if (r[key]) fail(`rules.${key} arrives with W2-GAME2`);
  if ((r.supplyEvery as number) > 0) fail('rules.supplyEvery (supply crates) arrives with W2-GAME2');
  return { ...rules, ammo: { ...rules.ammo }, wind: rules.wind && { ...rules.wind } };
}

/** Returns a validated deep copy. Everything the Wave-1 simulation cannot honour throws with the reason (I3). */
export function validateMatchSetup(input: MatchSetup): MatchSetup {
  if (!isMatchSetup(input)) fail('expected a MatchSetup object');
  const setup = structuredClone(input);
  if (typeof setup.id !== 'string') fail('id must be a string');
  if (!integer(setup.seed, 0)) fail(`seed must be a non-negative integer, got ${setup.seed}`);
  if (!MODES.includes(setup.mode)) fail(`unknown mode ${String(setup.mode)}`);
  if (setup.online && (!['duel', 'realtime', 'artillery', 'coop'].includes(setup.online.kind) || !Array.isArray(setup.online.seats)
    || setup.online.seats.length < 1 || setup.online.seats.length > 3 || new Set(setup.online.seats).size !== setup.online.seats.length
    || setup.online.seats.some(id => !integer(id, 0, setup.tanks.length - 1)))) fail('invalid online seats');
  if (setup.online?.campaignOwnerSeat !== undefined && (setup.online.kind !== 'coop' || !setup.online.seats.includes(setup.online.campaignOwnerSeat))) fail('invalid campaign save owner');
  if (setup.online?.runId !== undefined && (typeof setup.online.runId !== 'string' || !/^[a-z0-9-]{8,64}$/i.test(setup.online.runId))) fail('invalid online run id');
  if (!setup.planet || !PLANETS.includes(setup.planet.kind)) fail('planet.kind is unknown');
  if (!Array.isArray(setup.teams) || !setup.teams.length) fail('at least one team is required');
  const teamIds = new Set<number>();
  for (const team of setup.teams) {
    if (!integer(team?.id, 0) || teamIds.has(team.id)) fail(`team ids must be unique non-negative integers (${JSON.stringify(team?.id)})`);
    if (typeof team.ai !== 'boolean' || typeof team.name !== 'string') fail(`team ${team.id} needs a name and an ai flag`);
    teamIds.add(team.id);
  }
  // A realtime match starts with the player (and any initial units); its script spawns the rest, up to its own cap.
  const realtime = setup.rules?.turnModel === 'realtime';
  if (realtime && setup.mode === 'local') fail('pass-and-play requires turn-based artillery');
  const minTanks = realtime ? 1 : 2, maxTanks = realtime ? MAX_REALTIME_UNITS : MAX_TANKS;
  if (setup.tanks.length < minTanks || setup.tanks.length > maxTanks) fail(`a match has ${minTanks} to ${maxTanks} tanks, got ${setup.tanks.length}`);
  for (const [index, tank] of setup.tanks.entries()) {
    if (!tank || !teamIds.has(tank.team)) fail(`tank ${index} names an unknown team ${JSON.stringify(tank?.team)}`);
    validateKitLoadout(tank.loadout);
    assembleKit(validateKitLoadout(tank.loadout)); // throws for parts that do not assemble yet
    if (tank.spawn !== 'auto' && (!tank.spawn || !vector(tank.spawn.up) || Math.hypot(...tank.spawn.up) < 1e-6 || !finite(tank.spawn.heading))) fail(`tank ${index} has an invalid spawn`);
    if (tank.brain !== undefined && !W1_BRAINS.includes(tank.brain)) fail(`bot brain '${tank.brain}' arrives after Wave 1 (W1: ${W1_BRAINS.join(', ')})`);
    if (tank.difficulty !== undefined && !DIFFICULTIES.includes(tank.difficulty)) fail(`tank ${index} has an unknown difficulty ${String(tank.difficulty)}`);
    if (tank.maxHealth !== undefined && (!finite(tank.maxHealth) || tank.maxHealth <= 0)) fail(`tank ${index} maxHealth must be positive`);
    if (tank.name !== undefined && typeof tank.name !== 'string') fail(`tank ${index} name must be a string`);
  }
  if (!realtime && new Set(setup.tanks.map(tank => tank.team)).size < 2) fail('a match needs tanks on at least two teams');
  setup.rules = validateRules(setup.rules);
  if (setup.crew) setup.crew = crewBuild(setup.crew);
  if (!Array.isArray(setup.objectives) || setup.objectives.some(objective => objective?.kind !== 'eliminate'))
    fail(`objectives ${JSON.stringify(setup.objectives)}: only 'eliminate' exists before W3-CONTENT`);
  for (const cut of setup.initialCuts ?? []) {
    if (typeof cut?.id !== 'string' || !vector(cut.center) || !finite(cut.radius) || cut.radius < MIN_TERRAIN_BLAST_RADIUS || cut.radius > MAX_TERRAIN_BLAST_RADIUS)
      fail(`initial cut ${JSON.stringify(cut)} is invalid`);
  }
  if (setup.environment?.weatherSeed !== undefined && !integer(setup.environment.weatherSeed, 0)) fail('environment.weatherSeed must be a non-negative integer');
  return setup;
}

/** Whether a tank is driven by a brain: an explicit brain, or any tank of an AI team (today's bot by default). */
export function brainOf(setup: MatchSetup, index: number): BotProfileId | null {
  const spawn = setup.tanks[index];
  if (spawn.brain) return spawn.brain;
  return setup.teams.find(team => team.id === spawn.team)?.ai ? 'legacy' : null;
}

/** 'auto' spawns: the legacy duel positions for two tanks; otherwise a ring around +Y with teammates adjacent,
 * every tank facing the ring centre. */
export function spawnPose(world: Pick<WorldQuery, 'surface' | 'radius'>, setup: MatchSetup, index: number): { position: V3; rotation: Q4; heading: number } {
  const spawn: TankSpawn = setup.tanks[index];
  let up: V3, heading: number;
  if (spawn.spawn !== 'auto') { up = normalize(spawn.spawn.up); heading = spawn.spawn.heading; }
  else if (setup.tanks.length === 2) {
    up = normalize([index === 0 ? -0.3 : 0.3, 1, 0]);
    heading = index === 0 ? Math.PI / 2 : -Math.PI / 2;
  } else {
    const order = setup.tanks.map((tank, id) => ({ team: tank.team, id })).sort((a, b) => a.team - b.team || a.id - b.id);
    const slot = order.findIndex(entry => entry.id === index), count = setup.tanks.length;
    const angle = -Math.PI / 2 + 2 * Math.PI * slot / count, spread = 0.3 * Math.max(1, count / 2.4);
    up = normalize([Math.sin(angle) * spread, 1, Math.cos(angle) * spread]);
    const toward = normalize(tangent(sub([0, 1, 0], up), up)), axes = frame(up, 0);
    heading = Math.atan2(dot(toward, axes.right), dot(toward, axes.forward));
  }
  const surface = world.surface(up);
  return { position: add(surface?.point ?? mul(up, world.radius), mul(up, ROOT_SURFACE_LIFT)), rotation: rotation(up, heading), heading };
}

/** The default practice rules with a fresh ammo table (DEFAULT_RULES itself is frozen). */
export function defaultRules(): MatchRules { return { ...DEFAULT_RULES, ammo: { ...DEFAULT_RULES.ammo } }; }
