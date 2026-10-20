/** AI personalities and difficulty (Experience §1.15, plan §3). Wave 1 ships Rusty, Tosser, Vex and Cyborg plus
 * today's bot ('legacy'). No dice and no buffs: difficulty only changes aim spread, reaction and search effort. */
import type { BotProfileId, Difficulty } from '../api/match';

export type W1Profile = 'rusty' | 'tosser' | 'vex' | 'cyborg';
const DEG = Math.PI / 180;

export interface ProfileTable {
  /** Seconds before the first shot of a turn. */
  react: number;
  /** Aim spread (1σ): yaw and pitch in degrees, power in percent of the power setting. */
  sigmaYaw: number; sigmaPitch: number; sigmaPower: number;
  /** Fraction of an observed miss corrected on the next shot at the same target. */
  bracket: number;
  /** Coarse (pitch × power) grid size and golden-section refinement stages (8 evaluations each). */
  candidates: number; refine: number;
  /** Allowed elevation band in degrees (the arc preference). */
  arc: [number, number];
  /** Relocation: endpoint distance band (u), cover weight, height weight; random picks ignore both. */
  relocate: { min: number; max: number; cover: number; height: number; random?: boolean };
  /** Forgets a last-known position after this many turns (Rusty's quirk). */
  forgetTurns?: number;
  /** Scans every n own turns when it can (Vex). */
  scanEvery?: number;
}

export const PROFILES: Readonly<Record<W1Profile, ProfileTable>> = Object.freeze({
  rusty: { react: 1.4, sigmaYaw: 6, sigmaPitch: 5, sigmaPower: 8, bracket: .3, candidates: 12, refine: 0, arc: [15, 75],
    relocate: { min: 3, max: 5, cover: 0, height: 0, random: true }, forgetTurns: 2 },
  tosser: { react: 1.1, sigmaYaw: 4, sigmaPitch: 3, sigmaPower: 6, bracket: .5, candidates: 18, refine: 1, arc: [55, 80],
    relocate: { min: 2.5, max: 6, cover: 1.5, height: .1 } },
  vex: { react: .9, sigmaYaw: 1.5, sigmaPitch: 1.5, sigmaPower: 3, bracket: .8, candidates: 24, refine: 2, arc: [3, 30],
    relocate: { min: 2, max: 5, cover: 1, height: .8 }, scanEvery: 3 },
  cyborg: { react: .6, sigmaYaw: .8, sigmaPitch: .8, sigmaPower: 1.5, bracket: 1, candidates: 48, refine: 3, arc: [5, 80],
    relocate: { min: 2.5, max: 7, cover: 1.2, height: .5 } },
});

export interface DifficultyTable { sigma: number; reaction: number; bracket: number; candidates: number }
export const DIFFICULTY: Readonly<Record<Difficulty, DifficultyTable>> = Object.freeze({
  story: { sigma: 2.2, reaction: 1.3, bracket: .5, candidates: .75 },
  normal: { sigma: 1, reaction: 1, bracket: 1, candidates: 1 },
  hard: { sigma: .6, reaction: .9, bracket: 1.2, candidates: 1.25 },
  ace: { sigma: .35, reaction: .8, bracket: 1, candidates: 1.5 },
});

/** The effective parameters of a profile at a difficulty, in radians and fractions. */
export interface BrainParams {
  profile: W1Profile; difficulty: Difficulty;
  reaction: number; sigmaYaw: number; sigmaPitch: number; sigmaPower: number;
  bracket: number; candidates: number; refineEvaluations: number;
  minPitch: number; maxPitch: number;
  relocate: ProfileTable['relocate']; forgetTurns?: number; scanEvery?: number;
}

export function isW1Profile(id: BotProfileId): id is W1Profile { return Object.hasOwn(PROFILES, id); }

export function resolveProfile(profile: W1Profile, difficulty: Difficulty = 'normal'): BrainParams {
  const base = PROFILES[profile], scale = DIFFICULTY[difficulty];
  if (!base || !scale) throw new Error(`Unknown brain ${profile}/${difficulty}`);
  return {
    profile, difficulty,
    reaction: base.react * scale.reaction,
    sigmaYaw: base.sigmaYaw * DEG * scale.sigma, sigmaPitch: base.sigmaPitch * DEG * scale.sigma, sigmaPower: base.sigmaPower / 100 * scale.sigma,
    bracket: Math.min(1, base.bracket * scale.bracket),
    candidates: Math.max(4, Math.round(base.candidates * scale.candidates)),
    refineEvaluations: base.refine * 8,
    minPitch: base.arc[0] * DEG, maxPitch: base.arc[1] * DEG,
    relocate: base.relocate, forgetTurns: base.forgetTurns, scanEvery: base.scanEvery,
  };
}
