/** Campaign missions on the realtime match (src/game/campaign/README.md). A mission is a planet, a player start,
 * named sites and an ordered list of beats; the runner advances them deterministically with the match tick and turns
 * them into dialogue, objectives, hints, spawns and the result. */
import type { TankState, V3 } from '../contracts';
import type { Difficulty, KitLoadoutIds, MatchSetup, MatchRules } from '../api/match';
import { DEFAULT_RULES } from '../api/match';
import { add, distance, frame, mul, normalize } from '../math';
import type { RealtimeScript, RealtimeUnitSpec, ScriptApi } from '../realtime/match';
import { generatePlanetStructures, type TerrainStructure } from '../terrain-structures';
import { createPlanetSampler } from '../planet-field';
import { TERRAIN_RADIUS } from '../terrain-config';
import { assembleKit, validateKitLoadout } from '../kit';
import type { CrewBuild } from './loadout';
import { CRAWLER_COMPONENTS, componentPoint } from '../realtime/components';
import { SERAPHINE_KIT, BRANN_KIT } from './vehicle-kits';

export const MISSION_IDS = ['p1', 'p2', 'p3', '1-1', '1-2', '1-3', '1-4', '1-5', 't-a', 't-b', 'f-a', 'f-b', 'c-a', 'c-b', 'ii-7', '3-1', '3-2', '3-3'] as const;
export type MissionId = typeof MISSION_IDS[number];
/** A place on the planet: degrees clockwise from the player's starting heading, and surface distance in u. */
export interface SiteDef { bearing: number; distance: number }

export interface MissionDef {
  id: MissionId;
  /** "Prologue · Wind-Up" */
  chapter: string;
  title: string;
  briefing: string;
  planet: { kind: 'temperate' | 'glacial' | 'dune' | 'volcanic'; seed: number };
  start: { up: V3; heading: number };
  fog: boolean;
  worldName?: string;
  intel?: string;
  requires?: readonly MissionId[];
  unlocks?: readonly string[];
  rules?: Partial<MatchRules>;
  /** Fraction of a day, held still during the mission. */
  timeOfDay?: number;
  optional?: { site: string; text: string; reward: string };
  secrets?: readonly string[];
  update?(ctx: MissionContext): void;
  sites: Readonly<Record<string, SiteDef>>;
  /** Authored vehicle routes kept clear of procedural buildings. */
  routes?: readonly (readonly [string, string])[];
  /** Named locations to which the player can assign individual companions. */
  commandPosts?: readonly { site: string; label: string }[];
  beats: readonly Beat[];
  /** The mission's medal challenge, judged at the win. */
  medal: { text: string; earned(ctx: MissionContext): boolean };
  /** The mission after this one, if any. */
  next?: MissionId;
  /** Authored CSG buildings (walls, the mill), added to the planet's own settlements. */
  structures?(place: StructurePlacer): TerrainStructure[];
}

/** Places authored structures on the mission planet before the terrain is built. */
export interface StructurePlacer {
  /** Surface direction of a site. */
  site(name: string, side?: number): V3;
  /** An upright concrete box standing on the ground at `up`: `width` across, `height` above ground, `depth` along
   * the line toward `facing` (a surface direction). */
  block(id: string, up: V3, facing: V3, width: number, height: number, depth: number, material?: 1 | 2 | 3): TerrainStructure;
}

export interface Beat {
  id: string;
  /** Once, when the beat starts. */
  enter?(ctx: MissionContext): void;
  /** Every tick while the beat runs. */
  update?(ctx: MissionContext): void;
  /** Polled every tick; true moves on to the next beat. */
  done(ctx: MissionContext): boolean;
  /** Once, when the beat is done (before the next one starts). */
  exit?(ctx: MissionContext): void;
  /** Shown if the beat is still running this long after it began, and cleared when it ends. */
  hint?: { text: string; after: number };
}

// ---- unit templates -------------------------------------------------------------------------------------------------

export const PLAYER_TEAM = 0, RUST_TEAM = 1, INSTRUCTOR_TEAM = 2;
const kit = (hull: string, runningGear: string, turret: string, weapon: string, armor?: string): KitLoadoutIds =>
  ({ hull, runningGear, turret, weapon, utility: 'antenna', ...(armor ? { armor } : {}) });
/** Every unit kind the Prologue spawns. Health is set per kind for readable time-to-kill. */
export const UNIT_KINDS = {
  target: { team: RUST_TEAM, loadout: kit('warden', 'grip', 'dome', 'cannon'), brain: 'dummy', name: 'Practice target', maxHealth: 40, immobile: true, unarmed: true, coaxProof: true },
  mover: { team: RUST_TEAM, loadout: kit('skiff', 'scout', 'dome', 'cannon'), brain: 'patrol', name: 'Moving target', maxHealth: 60, unarmed: true, coaxProof: true },
  rustling: { team: RUST_TEAM, loadout: kit('skiff', 'scout', 'wedge', 'cannon'), brain: 'rustling', name: 'Rustling', maxHealth: 24, coaxOnly: true, damageScale: 0.3, motionKind: 'swarm', visualKind: 'rustling' },
  rusty: { team: RUST_TEAM, loadout: kit('warden', 'grip', 'dome', 'cannon'), brain: 'rusty', name: 'Rusty', maxHealth: 100, damageScale: 0.7, reloadScale: 1.6 },
  tosser: { team: RUST_TEAM, loadout: kit('warden', 'grip', 'dome', 'mortar'), brain: 'tosser', name: 'Tosser', maxHealth: 90, damageScale: 0.8 },
  spire: { team: RUST_TEAM, loadout: kit('bastion', 'crawler', 'wedge', 'cannon', 'reactive'), brain: 'dummy', name: 'Rust Spire', visualKind: 'spire', maxHealth: 220, immobile: true, coaxOnly: true, damageScale: 0.6 },
  mags: { team: PLAYER_TEAM, loadout: kit('skiff', 'scout', 'dome', 'cannon'), brain: 'ally', name: 'Mags', visualKind: 'dragonfly', maxHealth: 140, motionKind: 'air', altitude: 3.5, noCrater: true },
  hornet: { team: RUST_TEAM, loadout: kit('skiff', 'scout', 'dome', 'cannon'), brain: 'hornet', name: 'Hornet', maxHealth: 55, coaxOnly: true, noCrater: true },
  bulwark: { team: RUST_TEAM, loadout: kit('bastion', 'crawler', 'wedge', 'cannon', 'reactive'), brain: 'bulwark', name: 'Bulwark', maxHealth: 170, damageScale: .7 },
  vex: { team: RUST_TEAM, loadout: kit('skiff', 'scout', 'dome', 'rail'), brain: 'vex', name: 'Vex', maxHealth: 70, noCrater: true, damageScale: .7 },
  relay: { team: PLAYER_TEAM, loadout: kit('bastion', 'crawler', 'dome', 'cannon'), brain: 'dummy', name: 'Lamp relay', visualKind: 'relay', maxHealth: 400, unarmed: true, immobile: true },
  watchtower: { team: RUST_TEAM, loadout: kit('bastion', 'crawler', 'dome', 'cannon'), brain: 'dummy', name: 'Searchlight tower', visualKind: 'watchtower',
    maxHealth: 90, unarmed: true, immobile: true, coaxProof: true, searchlight: { height: 1.8, range: 18, angle: .25, sweep: 1.05, period: 14 } },
  caravan: { team: PLAYER_TEAM, loadout: kit('warden', 'grip', 'dome', 'cannon'), brain: 'patrol', name: 'Caravan', maxHealth: 240, unarmed: true },
  brann: { team: PLAYER_TEAM, loadout: BRANN_KIT, brain: 'ally', name: 'Brann', maxHealth: 220, noCrater: true, supportRepair: 2 },
  seraphine: { team: PLAYER_TEAM, loadout: SERAPHINE_KIT, brain: 'ally', name: 'Seraphine', visualKind: 'skimmer', maxHealth: 150, motionKind: 'air', altitude: .8, noCrater: true },
  crawler: { team: RUST_TEAM, loadout: { hull: 'forge_hull', runningGear: 'forge_tracks', turret: 'forge_casemate', weapon: 'forge_mortar', utility: 'steam_sentinel' },
    brain: 'patrol', name: 'Siege Crawler', components: CRAWLER_COMPONENTS, coaxProof: true, damageScale: .35, driveScale: .35 },
  instructor: { team: INSTRUCTOR_TEAM, loadout: kit('warden', 'grip', 'dome', 'mortar'), brain: 'dummy', name: 'Sgt. Sprocket', maxHealth: 999, immobile: true, unarmed: true, damageScale: 0.12 },
} as const satisfies Record<string, Omit<RealtimeUnitSpec, 'spawn'>>;
export type UnitKind = keyof typeof UNIT_KINDS;
/** Template fields that are balance, not identity or saved state: a restored unit takes their current values. */
const UNIT_TUNING = ['damageScale', 'reloadScale', 'driveScale', 'coaxOnly', 'coaxProof', 'unarmed', 'immobile', 'noCrater', 'supportRepair', 'searchlight', 'altitude'] as const;
const sameKit = (a: KitLoadoutIds, b: KitLoadoutIds) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
/** The template a spawned unit came from (brain, team, look and kit identify it; specs carry no kind), or null. */
export function unitKindOf(spec: Omit<RealtimeUnitSpec, 'spawn'>): UnitKind | null {
  const kinds = (Object.keys(UNIT_KINDS) as UnitKind[]).filter(kind => {
    const t: Omit<RealtimeUnitSpec, 'spawn'> = UNIT_KINDS[kind];
    return t.brain === spec.brain && t.team === spec.team && t.visualKind === spec.visualKind && sameKit(t.loadout, spec.loadout);
  });
  return kinds.length === 1 ? kinds[0] : null;
}
/** `spec` with its template's current tuning; a unit no template matches (the player) is returned as it is. */
export function retuneUnit(spec: RealtimeUnitSpec): RealtimeUnitSpec {
  const kind = unitKindOf(spec);
  if (!kind) return spec;
  const template: Omit<RealtimeUnitSpec, 'spawn'> = UNIT_KINDS[kind], next: Record<string, unknown> = { ...spec };
  for (const key of UNIT_TUNING) { if (template[key] === undefined) delete next[key]; else next[key] = structuredClone(template[key]); }
  return next as unknown as RealtimeUnitSpec;
}
/** The hero tank takes this multiple of its kit's health into a mission (Warcraft III-style hero durability). */
export const HERO_HEALTH = 2;

// ---- geometry ---------------------------------------------------------------------------------------------------------

/** The surface direction of a site from the mission start: `bearing` degrees clockwise (to the driver's right) from
 * the starting heading, `distance` u along the surface of a radius-`radius` planet. */
export function siteDirection(start: MissionDef['start'], site: SiteDef, radius: number): V3 {
  const up = normalize(start.up), axes = frame(up, start.heading - site.bearing * Math.PI / 180), angle = site.distance / radius;
  return normalize(add(mul(up, Math.cos(angle)), mul(axes.forward, Math.sin(angle))));
}
/** Heading at `up` that faces `toward` (a surface direction or point). */
export function headingToward(up: V3, toward: V3): number {
  const axes = frame(up, 0), d = normalize(toward);
  const t = add(d, mul(up, -(d[0] * up[0] + d[1] * up[1] + d[2] * up[2])));
  return Math.atan2(t[0] * axes.right[0] + t[1] * axes.right[1] + t[2] * axes.right[2], t[0] * axes.forward[0] + t[1] * axes.forward[1] + t[2] * axes.forward[2]);
}

// ---- setup ----------------------------------------------------------------------------------------------------------

/** The realtime MatchSetup of a mission with the player's build. The setup id names the mission (session lookup). */
export function missionSetup(def: MissionDef, loadout: KitLoadoutIds, difficulty: Difficulty = 'normal', crew?: CrewBuild): MatchSetup {
  return {
    id: `campaign:${def.id}`, seed: def.planet.seed, mode: 'campaign', planet: { kind: def.planet.kind },
    ...(crew ? { crew } : {}),
    teams: [{ id: PLAYER_TEAM, name: 'Wardens', ai: false }, { id: RUST_TEAM, name: 'The Rust', ai: true }, { id: INSTRUCTOR_TEAM, name: 'Range', ai: true }],
    tanks: [{ team: PLAYER_TEAM, loadout: { ...loadout }, spawn: { up: [...def.start.up] as V3, heading: def.start.heading }, name: 'Kestrel', difficulty,
      maxHealth: Math.round(assembleKit(validateKitLoadout(loadout)).stats.hp * HERO_HEALTH) }],
    rules: { ...DEFAULT_RULES, ammo: { nuclear: 0 }, fog: def.fog, friendlyFire: false, turnModel: 'realtime', radarCost: 1, ...def.rules },
    environment: { timeOfDay: def.timeOfDay ?? .08 },
    objectives: [], structures: missionStructures(def),
  };
}

/** The planet's generated settlements (the resident profile's spherical layout) plus the mission's own buildings. */
export function missionStructures(def: MissionDef): TerrainStructure[] {
  let generated = generatePlanetStructures(def.planet.seed, undefined, true, def.planet.kind);
  if (def.routes?.length) {
    const sampleRoute = createPlanetSampler(def.planet.seed, true, def.planet.kind);
    const points: V3[] = [];
    for (const [from, to] of def.routes) {
      const a = siteDirection(def.start, siteOrThrow(def, from), TERRAIN_RADIUS), b = siteDirection(def.start, siteOrThrow(def, to), TERRAIN_RADIUS);
      for (let i = 0; i <= 24; i++) {
        const t = i / 24, up = normalize(add(mul(a, 1 - t), mul(b, t)));
        points.push(mul(up, sampleRoute(up).radius));
      }
    }
    generated = generated.filter(building => points.every(point => distance(point, building.center as V3) > 2.5 + Math.hypot(...building.halfSize)));
  }
  if (!def.structures) return generated;
  const sample = createPlanetSampler(def.planet.seed, true, def.planet.kind);
  const placer: StructurePlacer = {
    site: (name, side = 0) => sideways(def.start, siteDirection(def.start, siteOrThrow(def, name), TERRAIN_RADIUS), side, TERRAIN_RADIUS),
    block: (id, up, facing, width, height, depth, material = 3) => {
      const y = normalize(up), z = normalize(add(normalize(facing), mul(y, -dot3(normalize(facing), y)))), x = cross3(y, z);
      // Sunk 1.3 u like the generated buildings, so a crater at the foot does not float it.
      const half: V3 = [width / 2, (height + 1.3) / 2, depth / 2], radius = sample(y).radius;
      return { id: `mission-${def.id}-${id}`, center: mul(y, radius - 1.3 + half[1]), halfSize: half, axes: [x, y, z], material };
    },
  };
  const authored = def.structures(placer);
  // Generated buildings that overlap an authored one are dropped (the mission's layout wins).
  const clear = generated.filter(g => authored.every(a => distance(g.center as V3, a.center as V3) > Math.hypot(...a.halfSize) + Math.hypot(...g.halfSize)));
  return [...clear, ...authored];
}
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function siteOrThrow(def: MissionDef, name: string): SiteDef {
  const site = def.sites[name];
  if (!site) throw new Error(`Mission ${def.id} has no site '${name}'`);
  return site;
}
/** `up` moved `side` u to the right of the line from the mission start (negative: left). */
function sideways(start: MissionDef['start'], up: V3, side: number, radius: number): V3 {
  if (!side) return up;
  const left = frame(up, headingToward(up, start.up)).right;
  return normalize(add(up, mul(left, -side / radius)));
}
export function missionIdOf(setup: Pick<MatchSetup, 'id' | 'mode'>): MissionId | null {
  const id = setup.id.replace(/^campaign:/, '') as MissionId;
  return setup.mode === 'campaign' && setup.id.startsWith('campaign:') && MISSION_IDS.includes(id) ? id : null;
}

// ---- the runner -------------------------------------------------------------------------------------------------------

/** Objectives as the HUD lists them. */
export interface ObjectiveState { id: string; text: string; state: 'active' | 'done' | 'failed' }

export interface MissionContext {
  readonly api: ScriptApi;
  readonly def: MissionDef;
  readonly player: TankState;
  /** Seconds since the mission began, and since the current beat began. */
  readonly elapsed: number;
  readonly beatTime: number;
  /** Lowest player health fraction so far. */
  readonly lowestHealth: number;
  /** Surface point of a site (or of a site offset by `side` u to its right). */
  at(site: string, side?: number): V3;
  near(site: string, radius: number): boolean;
  /** Point the HUD's objective marker at a site, or let it follow a unit (null hides it). */
  mark(site: string | { tank: number; component?: string } | null, label?: string): void;
  spawn(kind: UnitKind, site: string, options?: { group?: string; side?: number; facing?: string; patrol?: readonly string[]; revealed?: boolean; name?: string }): number | null;
  group(name: string): TankState[];
  /** Living members of a group. */
  alive(name: string): number;
  /** The group exists and none of it is alive. */
  cleared(name: string): boolean;
  say(speaker: string, text: string): void;
  objective(id: string, text: string): void;
  complete(id: string): void;
  fail(id: string): void;
  /** Persistent flags for beats that need memory across ticks. */
  readonly flags: Record<string, number>;
  /** Make a tank visible to every enemy team (a spotter marked it, or the Rust spotted the player). */
  reveal(tank: number, on: boolean): void;
  win(): void;
  lose(reason: string): void;
}

export const SPEAKERS = { sprocket: 'Sgt. Sprocket', corvin: 'Marshal Corvin', mags: 'Mags' } as const;

export class MissionRunner implements RealtimeScript {
  private beat = -1;
  private beatStart = 0;
  private hinted = false;
  private lowest = 1;
  private readonly objectives = new Map<string, ObjectiveState>();
  private ctx!: MissionContext;
  private result: 'won' | 'failed' | null = null;
  medalEarned = false;
  optionalCompleted = false;
  readonly secretsFound = new Set<string>();
  ending: 'rewind' | 'release' | null = null;
  /** Where the HUD's objective marker points, if anywhere. */
  marker: V3 | null = null;
  /** The unit the marker follows, if it follows one. */
  markedTank: number | null = null;
  private markedComponent: string | null = null;
  constructor(readonly def: MissionDef) {}

  /** HUD state: objectives in the order they were given. */
  objectiveList(): ObjectiveState[] { return [...this.objectives.values()]; }
  get outcome(): 'won' | 'failed' | null { return this.result; }
  command(api: ScriptApi, tank: number, command: import('../api/session').PlayerCommand): boolean {
    if (command.k !== 'utility' || !(api.players ?? [api.player]).includes(tank)) return false;
    if (command.id === 'ending-rewind' || command.id === 'ending-release') {
      return tank === api.player && this.chooseEnding(command.id === 'ending-rewind' ? 'rewind' : 'release');
    }
    const assignment = /^assign:(mags|brann|seraphine):([a-z0-9-]{1,32})$/.exec(command.id);
    return assignment ? this.assignCompanion(assignment[1], assignment[2]) : false;
  }
  chooseEnding(choice: 'rewind' | 'release'): boolean {
    if (this.beatId !== 'ending-choice' || this.result) return false;
    this.ending = choice; this.ctx.flags.ending = choice === 'rewind' ? 1 : 2;
    this.ctx.api.emit({ type: 'audio', cue: { type: 'ending', choice } });
    this.ctx.say('Rook', choice === 'rewind' ? 'We mend it. Together. Turn the Key.' : 'Let it go. We carry our people forward, not the weight of the past.');
    this.ctx.say('Mags', choice === 'rewind' ? 'The Lantern burns bright. The worlds turn again. And we will be here to care for them.' : 'The worlds settle gently. Ahead of us, the Lantern. We sail together.');
    return true;
  }
  get beatId(): string | null { return this.def.beats[this.beat]?.id ?? null; }
  assignCompanion(name: string, site: string): boolean {
    if (!this.ctx || this.result || !this.def.commandPosts?.some(post => post.site === site)) return false;
    const companion = this.ctx.group(name).find(t => t.health > 0 && t.team === this.ctx.player.team);
    if (!companion || !['mags', 'brann', 'seraphine'].includes(name)) return false;
    this.ctx.api.order(companion.id, this.ctx.at(site));
    this.ctx.flags[`assignment:${name}`] = this.def.commandPosts.findIndex(post => post.site === site);
    return true;
  }
  companionPost(name: string): string | null {
    const companion = this.ctx?.group(name).find(t => t.health > 0), goal = companion && this.ctx.api.orderOf(companion.id);
    if (!goal) return null;
    return this.def.commandPosts?.find(post => distance(normalize(goal), siteDirection(this.def.start, this.def.sites[post.site], this.ctx.api.world.radius)) < 1e-4)?.site ?? null;
  }
  checkpoint() {
    return structuredClone({ beat: this.beat, beatStart: this.beatStart, lowest: this.lowest, hinted: this.hinted, flags: this.ctx.flags,
      objectives: this.objectiveList(), marker: this.marker, markedTank: this.markedTank, markedComponent: this.markedComponent, optionalCompleted: this.optionalCompleted, secrets: [...this.secretsFound],
      result: this.result, medal: this.medalEarned, ending: this.ending });
  }
  migrateUnit(spec: RealtimeUnitSpec): RealtimeUnitSpec { return retuneUnit(spec); }
  restore(api: ScriptApi, data: unknown): void {
    const saved = data as ReturnType<MissionRunner['checkpoint']>;
    this.ctx = this.context(api); this.beat = saved.beat; this.beatStart = saved.beatStart; this.lowest = saved.lowest; this.hinted = saved.hinted;
    Object.assign(this.ctx.flags, saved.flags); this.marker = saved.marker; this.markedTank = saved.markedTank;
    this.markedComponent = saved.markedComponent ?? null;
    this.optionalCompleted = saved.optionalCompleted; saved.secrets.forEach(s => this.secretsFound.add(s));
    this.result = saved.result ?? null; this.medalEarned = saved.medal ?? false; this.ending = saved.ending ?? null;
    for (const o of saved.objectives) { this.objectives.set(o.id, o); api.emit({ type: 'objective', ...o }); }
    api.emit({ type: 'marker', point: this.marker, ...(this.markedTank !== null ? { tank: this.markedTank } : {}), ...(this.markedComponent ? { component: this.markedComponent } : {}) });
    api.emit({ type: 'banner', title: 'Checkpoint restored', subtitle: `${this.def.title} · Pause › Restart mission starts over` });
  }

  start(api: ScriptApi): void {
    this.ctx = this.context(api);
    api.emit({ type: 'banner', title: this.def.title, subtitle: this.def.chapter });
    this.ctx.say('Narrator', this.def.briefing);
    this.advance(api);
    if (this.def.optional) this.ctx.objective('optional', `Optional: ${this.def.optional.text}`);
  }

  tick(api: ScriptApi): void {
    if (this.result) return;
    const player = api.state.tanks[api.player];
    this.lowest = Math.min(this.lowest, player.health / (player.maxHealth ?? player.health));
    if (player.health <= 0) { this.ctx.lose('The Kestrel was destroyed.'); return; }
    this.def.update?.(this.ctx);
    const optional = this.def.optional;
    if (optional && !this.optionalCompleted && this.ctx.near(optional.site, 2.5)) {
      this.optionalCompleted = true; this.ctx.complete('optional');
      this.ctx.say('Sgt. Sprocket', `Recovered ${optional.reward}. Good detour, Rook.`);
    }
    for (const site of this.def.secrets ?? []) if (!this.secretsFound.has(site) && this.ctx.near(site, 2)) {
      this.secretsFound.add(site); api.emit({ type: 'banner', title: 'Tin Toy recovered', subtitle: `${this.secretsFound.size}/${this.def.secrets?.length}` });
    }
    if (api.crew.gadgets.includes('lantern-shard') && api.tick % 300 === 0) {
      const nearby = this.def.secrets?.find(site => !this.secretsFound.has(site) && this.ctx.near(site, 10));
      if (nearby) api.emit({ type: 'hint', text: 'The Lantern Shard glows: a Tin Toy is within ten metres.' });
    }
    if (this.markedTank !== null) {
      const marked = api.state.tanks[this.markedTank];
      const component = marked?.components?.find(c => c.id === this.markedComponent);
      if (marked && marked.health > 0) this.marker = component ? componentPoint(marked, component) : [...marked.position]; else { this.markedTank = null; this.marker = null; api.emit({ type: 'marker', point: null }); }
    }
    const beat = this.def.beats[this.beat];
    if (!beat) return;
    beat.update?.(this.ctx);
    if (this.result) return;
    if (beat.done(this.ctx)) { if (this.hinted) api.emit({ type: 'hint', text: null }); beat.exit?.(this.ctx); if (!this.result) this.advance(api); return; }
    if (beat.hint && !this.hinted && this.ctx.beatTime >= beat.hint.after) { this.hinted = true; api.emit({ type: 'hint', text: beat.hint.text }); }
  }

  private advance(api: ScriptApi): void {
    for (;;) {
      this.beat++; this.beatStart = api.tick; this.hinted = false;
      const beat = this.def.beats[this.beat];
      if (!beat) { this.ctx.win(); return; }
      beat.enter?.(this.ctx);
      if (this.result || !beat.done(this.ctx)) return;
      beat.exit?.(this.ctx);
      if (this.result) return;
    }
  }

  private context(api: ScriptApi): MissionContext {
    const runner = this, def = this.def, flags: Record<string, number> = {};
    const siteOf = (name: string, side = 0): V3 => sideways(def.start, siteDirection(def.start, siteOrThrow(def, name), api.world.radius), side, api.world.radius);
    const surface = (up: V3): V3 => api.world.surface(up)?.point ?? mul(up, api.world.radius);
    const say = (speaker: string, text: string) => api.emit({ type: 'say', speaker, text, seconds: 3.5 + 0.05 * text.length });
    const setObjective = (id: string, text: string, state: ObjectiveState['state']) => {
      this.objectives.set(id, { id, text, state });
      api.emit({ type: 'objective', id, text, state });
    };
    return {
      api, def, flags,
      get player() { return api.state.tanks[api.player]; },
      get elapsed() { return api.time; },
      get beatTime() { return (api.tick - runner.beatStart) / 60; },
      get lowestHealth() { return runner.lowest; },
      at: (site, side) => surface(siteOf(site, side)),
      near: (site, radius) => (api.players ?? [api.player]).some(id => api.state.tanks[id]?.health > 0 && distance(api.state.tanks[id].position, surface(siteOf(site))) <= radius),
      mark: (site, label) => {
        runner.markedTank = site && typeof site === 'object' ? site.tank : null;
        runner.markedComponent = site && typeof site === 'object' ? site.component ?? null : null;
        const tank = runner.markedTank !== null ? api.state.tanks[runner.markedTank] : undefined;
        const component = tank?.components?.find(c => c.id === runner.markedComponent);
        runner.marker = site === null ? null : typeof site === 'object' ? component ? componentPoint(tank!, component) : [...tank!.position] : surface(siteOf(site));
        api.emit({ type: 'marker', point: runner.marker, ...(runner.markedTank !== null ? { tank: runner.markedTank } : {}), ...(runner.markedComponent ? { component: runner.markedComponent } : {}), ...(label ? { label } : {}) });
      },
      spawn: (kind, site, options = {}) => {
        const template = UNIT_KINDS[kind], up = siteOf(site, options.side ?? 0);
        const facing = options.facing ? siteOf(options.facing) : normalize(def.start.up);
        return api.spawn({ ...template, spawn: { up, heading: headingToward(up, facing) }, group: options.group ?? kind,
          ...(options.patrol ? { waypoints: options.patrol.map(name => siteOf(name)) } : {}),
          ...(options.revealed ? { revealed: true } : {}), ...(options.name ? { name: options.name } : {}) });
      },
      group: name => api.group(name),
      reveal: (tank, on) => api.setRevealed(tank, on),
      alive: name => api.group(name).filter(t => t.health > 0).length,
      cleared: name => { const members = api.group(name); return members.length > 0 && members.every(t => t.health <= 0); },
      say,
      objective: (id, text) => setObjective(id, text, 'active'),
      complete: id => { const o = this.objectives.get(id); if (o && o.state === 'active') setObjective(id, o.text, 'done'); },
      fail: id => { const o = this.objectives.get(id); if (o && o.state === 'active') setObjective(id, o.text, 'failed'); },
      win: () => {
        if (runner.result) return;
        runner.result = 'won';
        runner.medalEarned = def.medal.earned(runner.ctx);
        api.emit({ type: 'banner', title: 'Mission complete', subtitle: runner.medalEarned ? `Medal earned: ${def.medal.text}` : def.title });
        api.finish(PLAYER_TEAM);
      },
      lose: reason => {
        if (runner.result) return;
        runner.result = 'failed';
        for (const o of this.objectives.values()) if (o.state === 'active') setObjective(o.id, o.text, 'failed');
        api.emit({ type: 'banner', title: 'Mission failed', subtitle: reason });
        api.finish(RUST_TEAM, reason);
      },
    };
  }
}
