/**
 * The music director: a PURE state machine (no WebAudio, no DOM) that decides which score track plays and how loud each
 * layer is, from the scene, the world, the mission, the measured threat and the boss state. Hysteresis and hold times
 * keep layers from flickering; exploration returns only after a cooldown; every choice falls back to a track that exists
 * in the manifest, so partially rendered score sets still play.
 *
 * The threat ladder has four steps above exploration: tier 1 is the HUNT track (stalking: bass pulse, ride, muted
 * chugs), tiers 2-4 are the combat track with its lead and escalation layers. Each world has two combat tracks (A and B)
 * rotated per match (never the same one twice in a row). Boss fights switch to a phase variant loop (`<boss>-p2`) at
 * phase 2 when one exists, with the phase stinger on the change.
 *
 * Layers: 0 core (always), 1 combat body, 2 lead/hook, 3 escalation, 4 bass (combat and boss tracks ship the bass as its
 * own file; its weight follows the core). Weights are 0..1 gains for the player to ramp.
 */
import type { PlanetKind } from '../../world/sun';

export type MusicScene = 'title' | 'menu' | 'workshop' | 'setup' | 'loading' | 'skirmish' | 'pause' | 'results';
export type Outcome = 'won' | 'failed' | null;
export interface BossState { id: string; phase: number }
export interface DirectorInput {
  scene: MusicScene;
  world?: PlanetKind;
  /** Campaign mission id ('p1', '1-5', 'ii-7', '3-3', …) or null for skirmishes. */
  mission?: string | null;
  /** 0..1 measured threat (the integrator's estimate), already smoothed or raw: the director smooths it again. */
  threat: number;
  boss?: BossState | null;
  /** Finale / special phases signalled by the campaign (see docs/audio-continuity.md). */
  phase?: 'duel' | 'core' | 'escape' | 'choice' | null;
  /** Fleet-launch escalation stage 0..3 (pads launched). */
  escalation?: number;
  ending?: 'rewind' | 'release' | null;
  outcome?: Outcome;
  dialogue?: boolean;
  /** Match counter (the integrator passes a per-match number): picks the combat track A/B and the menu variation. */
  match?: number;
}
export type Layers = [number, number, number, number, number];
export interface DirectorPlan {
  track: string | null;
  layers: Layers;
  /** Scene level 0..1 for the music bus (pause/results lower it). */
  level: number;
  /** Start the new track at its intro (true) or at the loop start (false). */
  intro: boolean;
  /** A stinger to fire once (the caller clears it). */
  stinger: string | null;
  tier: number;
  /** Outgoing fade length (s), ending on the boundary where the new track starts, and whether that boundary is the next bar or beat. */
  fade: number;
  quantize: 'bar' | 'beat';
}
const MENU_SCENES: readonly MusicScene[] = ['title', 'menu', 'setup', 'workshop'];
export interface TrackSets { has(id: string): boolean }

/** World set per mission (the planet kind alone cannot tell Frostmere from the Halo). */
export function worldSetOf(world: PlanetKind | undefined, mission: string | null | undefined): string {
  switch (mission) {
    case 'p1': case 'p2': case 'p3': case '1-1': case '1-2': return 'cradle';
    case '1-3': case '1-4': case '1-5': return 'dune';
    case 't-a': case 't-b': case 'ii-7': return 'cradle';
    case 'f-a': case 'f-b': return 'frost';
    case 'c-a': case 'c-b': return 'forge';
    case '3-1': case '3-2': case '3-3': return 'halo';
  }
  return world === 'temperate' ? 'cradle' : world === 'dune' ? 'dune' : world === 'glacial' ? 'frost' : world === 'volcanic' ? 'forge' : 'cradle';
}
/** Boss track per boss id. */
const BOSS_TRACKS: Record<string, string> = { crawler: 'boss-crawler', leviathan: 'boss-leviathan', titan: 'boss-titan', rustcrown: 'boss-rustcrown' };

/** Threat tier thresholds: [enter, exit] per tier 1..4 (1 = hunt, 2 = combat, 3 = + lead, 4 = + escalation). */
export const TIERS: readonly [number, number][] = [[0.2, 0.11], [0.4, 0.27], [0.62, 0.46], [0.82, 0.62]];
/** Seconds a tier must be held before it can drop, and the cooldown before combat returns to exploration. */
export const TIER_HOLD_S = 4, EXPLORE_COOLDOWN_S = 9, COMBAT_ENTER_S = 1.2;
const SCENE_LEVEL: Record<MusicScene, number> = { title: 1, menu: 0.9, workshop: 0.95, setup: 0.9, loading: 0.85, skirmish: 1, pause: 0.5, results: 0.8 };

export class MusicDirector {
  private tier = 0;
  private tierSince = 0;
  private combatSince = -Infinity;
  private calmSince = -Infinity;
  private threatSmooth = 0;
  private lastTrack: string | null = null;
  private lastOutcome: Outcome = null;
  private lastBossPhase = -1;
  private lastEscalation = -1;
  private pendingStinger: string | null = null;
  private lastNow = 0;
  /** The combat variant for the current match: odd matches play A, even matches B, so no variant repeats. */
  private combatVariant = '';
  constructor(private readonly tracks: TrackSets) {}

  get currentTier(): number { return this.tier; }
  /** Explicit stinger request (mission start, checkpoint, undermined, …). */
  stinger(id: string): void { this.pendingStinger = id; }

  update(input: DirectorInput, now: number): DirectorPlan {
    const dt = Math.max(0, Math.min(0.5, now - this.lastNow)); this.lastNow = now;
    const combatScene = input.scene === 'skirmish';
    // A new match rotates the combat track: odd matches A, even matches B, never the same twice in a row.
    this.combatVariant = Math.abs(input.match ?? 1) % 2 === 1 ? '' : '-b';
    // Threat smoothing (asymmetric: rises fast, falls slowly) and tiering with hysteresis.
    const target = combatScene ? clamp01(input.threat) : 0;
    this.threatSmooth += (target - this.threatSmooth) * (1 - Math.exp(-dt / (target > this.threatSmooth ? 0.35 : 2.2)));
    const t = this.threatSmooth;
    let tier = this.tier;
    if (tier < TIERS.length && t >= TIERS[tier][0]) { if (tier === 0 && this.combatSince === -Infinity) this.combatSince = now; if (tier > 0 || now - this.combatSince >= COMBAT_ENTER_S) { tier++; this.tierSince = now; } }
    else if (tier > 0 && t < TIERS[tier - 1][1] && now - this.tierSince >= TIER_HOLD_S) {
      if (tier === 1) { if (this.calmSince === -Infinity) this.calmSince = now; if (now - this.calmSince >= EXPLORE_COOLDOWN_S) { tier = 0; this.tierSince = now; this.combatSince = -Infinity; } }
      else { tier--; this.tierSince = now; }
    }
    if (t >= TIERS[0][1]) this.calmSince = -Infinity;
    if (t < TIERS[0][0] && tier === 0) this.combatSince = -Infinity;
    if (!combatScene) { tier = 0; this.combatSince = -Infinity; this.calmSince = -Infinity; }
    this.tier = tier;
    // Boss phase and escalation stingers.
    const bossPhase = input.boss?.phase ?? -1;
    if (input.boss && bossPhase !== this.lastBossPhase && this.lastBossPhase >= 0 && bossPhase > this.lastBossPhase) this.pendingStinger ??= 'boss-phase';
    this.lastBossPhase = input.boss ? bossPhase : -1;
    const esc = input.escalation ?? -1;
    if (esc > this.lastEscalation && this.lastEscalation >= 0) this.pendingStinger ??= 'escalation';
    this.lastEscalation = esc;
    if (input.outcome && input.outcome !== this.lastOutcome) this.pendingStinger = input.outcome === 'won' ? 'victory' : 'defeat';
    this.lastOutcome = input.outcome ?? null;
    const plan = this.plan(input, tier);
    plan.stinger = this.pendingStinger && this.tracks.has(`stinger-${this.pendingStinger}`) ? `stinger-${this.pendingStinger}` : null;
    this.pendingStinger = null;
    // A track plays its intro only when music starts from nothing; every other switch resumes the track where it was
    // last heard (menus, loading, returning to exploration, combat re-entries), so nothing "restarts" or drops away.
    plan.intro = plan.track !== this.lastTrack && this.lastTrack === null;
    const menu = MENU_SCENES.includes(input.scene);
    plan.fade = menu ? 0.3 : input.scene === 'loading' || input.scene === 'results' ? 0.5 : 0.4;
    plan.quantize = menu || input.scene === 'results' || input.scene === 'pause' ? 'beat' : 'bar';
    this.lastTrack = plan.track;
    return plan;
  }

  private pick(...ids: (string | null | undefined)[]): string | null { for (const id of ids) if (id && this.tracks.has(id)) return id; return null; }

  private plan(input: DirectorInput, tier: number): DirectorPlan {
    const level = SCENE_LEVEL[input.scene] * (input.dialogue ? 0.75 : 1);
    const set = worldSetOf(input.world, input.mission);
    const explore = this.pick(`${set}-explore`, 'cradle-explore');
    const combat = this.pick(`${set}-combat${this.combatVariant}`, `${set}-combat`, 'cradle-combat');
    const hunt = this.pick(`${set}-hunt`, 'cradle-hunt');
    const base = (track: string | null, l: [number, number, number, number], intro = true): DirectorPlan => ({ track, layers: [l[0], l[1], l[2], l[3], l[0]], level, intro, stinger: null, tier, fade: 0.4, quantize: 'bar' });
    const menuTrack = this.pick(['workshop', 'workshop-b', 'workshop-c'][Math.abs(input.match ?? 0) % 3], 'workshop', 'title');
    switch (input.scene) {
      // The title screen has the theme; every menu, the setup and the workshop share ONE groove (one of three
      // variations per session), so moving between menus only moves layer weights and never changes the track.
      case 'title': return base(this.pick('title'), [1, 1, 1, 0]);
      case 'menu': case 'setup': return base(menuTrack, [1, 1, 0.6, 0]);
      case 'workshop': return base(menuTrack, [1, 1, 0.45, 0]);
      case 'loading': return base(explore, [1, 0.25, 0, 0]);
      case 'results': {
        if (input.ending) return base(this.pick(`ending-${input.ending}`, explore), [1, 1, 1, 0]);
        if (input.outcome === 'won' && input.mission === '3-3') return base(this.pick('title-full', this.lastTrack ?? explore), [1, 1, 1, 0]);
        return base(this.lastTrack ?? explore, input.outcome === 'won' ? [1, 0.3, 0, 0] : [0.9, 0, 0, 0]);
      }
      case 'pause': return base(this.lastTrack ?? explore, [1, 0.35, 0, 0]);
      case 'skirmish': {
        if (input.ending) return base(this.pick(`ending-${input.ending}`, explore), [1, 1, 1, 0]);
        if (input.phase === 'escape') return base(this.pick('finale-escape', combat), [1, 1, 1, 1]);
        if (input.phase === 'choice') return base(this.pick('finale-choice', explore), [1, 0.4, 0, 0]);
        if (input.boss) {
          const p = Math.max(0, input.boss.phase), id0 = BOSS_TRACKS[input.boss.id] ?? null;
          const id = this.pick(p >= 2 ? `${id0}-p2` : null, id0, combat);
          return base(id, [1, 1, p >= 1 ? 1 : 0.35, p >= 2 ? 1 : 0]);
        }
        if (input.mission === 'ii-7' && input.escalation !== undefined && input.escalation >= 0) {
          const s = input.escalation;
          return base(this.pick('fleet-launch', combat), [1, s >= 1 ? 1 : 0.6, s >= 2 ? 1 : 0.3, s >= 3 ? 1 : tier >= 4 ? 1 : 0]);
        }
        if (input.phase === 'duel') return base(this.pick('boss-rustcrown', combat), [1, 1, 1, tier >= 4 ? 1 : 0]);
        if (input.phase === 'core') return base(this.pick('boss-rustcrown-p2', 'boss-rustcrown', combat), [1, 1, 1, 1]);
        if (tier === 0) return base(explore, [1, input.threat > 0.12 ? 0.6 : 0.2, 0, 0]);
        if (tier === 1 && hunt) return base(hunt, [1, 1, input.threat > 0.3 ? 1 : 0.5, 0], false);
        return base(combat, [1, 1, tier >= 3 ? 1 : 0, tier >= 4 ? 1 : 0], false);
      }
    }
  }
}
const clamp01 = (v: number) => Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
