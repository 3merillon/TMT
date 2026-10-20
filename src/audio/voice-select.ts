// Ported from Pinionfall src/audio/fire-voice-select.ts and the CombatVoiceBudget of src/audio/combat-sfx-math.ts (MIT, same owner)
/**
 * Which sources get a voice. Pure (no DOM, no WebAudio; time is injected), pinned by tests/audio-voice-select and
 * tests/audio-budget.
 *
 * - {@link selectLoopVoices}: nearest-N loop selection with hysteresis (engine/tread loops for the nearest 4 tanks,
 *   shell whistles ≤ 6). Pinionfall's fire selector, generalised: a loop enters inside 1.25× its range, keeps its voice
 *   until 1.4×, and a sounding loop's rank is scaled by 0.85 so a newcomer must be clearly nearer to take its slot.
 * - {@link VoiceBudget}: the hard SFX voice cap ({@link MAX_SFX_VOICES}). When full, a new voice steals the weakest one (lowest
 *   priority, then quietest at the listener); persistent loops are never stolen by one-shots.
 * - {@link LeakyBucket}: a burst cap per bus (Pinionfall's CombatVoiceBudget): tokens refill continuously, so a steady
 *   exchange never starves while a burst is clipped.
 */

export type BusName = 'music' | 'ui' | 'alerts' | 'weapons' | 'explosions' | 'vehicles' | 'impacts' | 'projectiles' | 'ambience' | 'water' | 'voice';
export const BUS_NAMES: readonly BusName[] = ['music', 'ui', 'alerts', 'weapons', 'explosions', 'vehicles', 'impacts', 'projectiles', 'ambience', 'water', 'voice'];

// ---- Loop selection ---------------------------------------------------------------------------------------------------
export const LOOP_ENTER_RANGE_MUL = 1.25;
export const LOOP_KEEP_RANGE_MUL = 1.4;
export const LOOP_LIVE_RANK_BIAS = 0.85;

export interface LoopCandidate {
  id: number;
  /** Listener → source distance (u). */
  dist: number;
  /** The source's audible range (u), a loudness proxy: a louder source carries further. */
  range: number;
  /** Currently sounding: earns the keep range and the rank bias. */
  live: boolean;
}

/** The ids that should sound: the in-range candidates ranked by distance as a fraction of their range, nearest first,
 * at most `cap`. Ties break by id so the result never depends on input order. NaN distances are never voiced. */
export function selectLoopVoices(cands: readonly LoopCandidate[], cap: number, out: Set<number> = new Set()): Set<number> {
  out.clear();
  const eligible: { id: number; rank: number }[] = [];
  for (const c of cands) {
    if (!(c.dist >= 0) || !(c.range > 0)) continue;
    const limit = c.range * (c.live ? LOOP_KEEP_RANGE_MUL : LOOP_ENTER_RANGE_MUL);
    if (c.dist > limit) continue;
    eligible.push({ id: c.id, rank: (c.dist / c.range) * (c.live ? LOOP_LIVE_RANK_BIAS : 1) });
  }
  eligible.sort((a, b) => a.rank - b.rank || a.id - b.id);
  for (let i = 0; i < eligible.length && i < cap; i++) out.add(eligible[i].id);
  return out;
}

// ---- Voice budget -----------------------------------------------------------------------------------------------------
/** The SFX voice cap (the score's layer sources are budgeted by the score player, not here). */
export const MAX_SFX_VOICES = 56;

/** Voice priorities (higher survives). Loops are persistent and never stolen by one-shots. */
export const PRIORITY = { tick: 1, tracer: 2, ui: 3, thump: 3, impact: 5, weapon: 6, explosion: 7, kill: 8, alert: 8, loop: 9 } as const;

export interface BudgetVoice {
  readonly bus: BusName;
  readonly priority: number;
  /** Linear gain at the listener (0..~1): the quieter of two equal-priority voices is stolen first. */
  readonly loudness: number;
  /** Context time the voice ends; Infinity for a loop until it is released. */
  endAt: number;
  /** Loops: never stolen by one-shots. */
  readonly persistent: boolean;
  /** Fade out fast from `now` (a steal); the budget disposes the voice once it is silent. */
  stop(now: number): void;
  /** Disconnect every node. Called exactly once. */
  dispose(): void;
}

const score = (v: { priority: number; loudness: number }) => v.priority + Math.min(0.99, Math.max(0, v.loudness));
/** How long a stolen voice keeps fading before it is disposed (s). */
export const STEAL_FADE_S = 0.04;

export class VoiceBudget {
  private readonly active: BudgetVoice[] = [];
  private readonly dying: BudgetVoice[] = [];
  private stolenCount = 0;
  private rejectedCount = 0;

  constructor(readonly max = MAX_SFX_VOICES) {}

  /** Live voices (≤ max): voices scheduled in the future count from the moment they are admitted. */
  get size(): number { return this.active.length; }
  get stolen(): number { return this.stolenCount; }
  get rejected(): number { return this.rejectedCount; }

  /** Disposes every voice whose end time has passed. */
  prune(now: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const v = this.active[i];
      if (v.endAt <= now) { this.active.splice(i, 1); v.dispose(); }
    }
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const v = this.dying[i];
      if (v.endAt <= now) { this.dying.splice(i, 1); v.dispose(); }
    }
  }

  /** Admits a voice, stealing the weakest non-persistent voice when full. False = the caller must not play it (every
   * active voice outranks it, or only persistent voices remain). */
  admit(v: BudgetVoice, now: number): boolean {
    this.prune(now);
    if (this.active.length < this.max) { this.active.push(v); return true; }
    let victim = -1, victimScore = Infinity;
    for (let i = 0; i < this.active.length; i++) {
      const a = this.active[i];
      if (a.persistent) continue;
      const s = score(a);
      if (s < victimScore) { victimScore = s; victim = i; }
    }
    if (victim < 0 || (!v.persistent && victimScore >= score(v))) { this.rejectedCount++; return false; }
    const [gone] = this.active.splice(victim, 1);
    gone.stop(now);
    gone.endAt = Math.min(gone.endAt, now + STEAL_FADE_S);
    this.dying.push(gone);
    this.stolenCount++;
    this.active.push(v);
    return true;
  }

  /** Removes a voice without disposing it (a loop released by its owner, which disposes it itself). */
  release(v: BudgetVoice): void {
    const i = this.active.indexOf(v);
    if (i >= 0) this.active.splice(i, 1);
  }

  /** Live voice counts per bus (written into `out`, which is zeroed first). */
  countByBus(out: Record<BusName, number>): Record<BusName, number> {
    for (const bus of BUS_NAMES) out[bus] = 0;
    for (const v of this.active) out[v.bus]++;
    return out;
  }

  /** Stops and disposes everything (match end, context close). */
  clear(now: number): void {
    for (const v of this.active) { v.stop(now); v.dispose(); }
    for (const v of this.dying) v.dispose();
    this.active.length = 0;
    this.dying.length = 0;
  }
}

// ---- Burst cap --------------------------------------------------------------------------------------------------------
/** A leaky-bucket cap on one-shots. Pure and time-injected so a test can drive it deterministically. */
export class LeakyBucket {
  private tokens: number;
  private last = -Infinity;
  constructor(readonly capacity = 10, readonly refillPerSec = 14) { this.tokens = capacity; }
  /** Spends one token at `now` (seconds). False = drop the voice. */
  tryTake(now: number): boolean {
    if (this.last === -Infinity) this.last = now;
    const dt = Math.max(0, now - this.last);
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + dt * this.refillPerSec);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
  get available(): number { return this.tokens; }
  reset(): void { this.tokens = this.capacity; this.last = -Infinity; }
}

/** Burst caps per bus (the portmap's hygiene table): explosions 6 at 4/s, impacts 10 at 14/s. */
export const BUS_BURST: Partial<Record<BusName, readonly [capacity: number, refillPerSec: number]>> = {
  explosions: [6, 4], impacts: [10, 14], weapons: [8, 8], ui: [12, 20], vehicles: [8, 10], alerts: [3, 1.5],
};
