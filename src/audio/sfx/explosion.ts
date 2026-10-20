/**
 * Explosions: the pre-rendered blast for the munition, crater size and MATERIAL (soil clods, rock chips, concrete slabs,
 * metal shards: chosen from the world set or the hit machine), a near/far pair crossfaded by distance, the stylised
 * speed-of-sound delay (d/60 s, capped) along the sphere-correct path, music ducking on big near booms, a brief 3 kHz
 * ear ring on the biggest near blasts, and the nuclear round's suck-back pre-roll cresting exactly at the boom. Falls
 * back to the thunder recipe without the bank.
 */
import type { AudioManager } from '../audio-manager';
import type { SfxBank } from '../sfx-bank';
import type { Voice } from './layers';
import { blastMagnitude01, explosionKindOf, explosionPlan, NUKE_PRE_ROLL, perceivedMagnitude, soundDelay } from './tank-sfx-math';
import { PRIORITY } from '../voice-select';
import { smoothstep } from './weapons';

/** Music ducks when a boom reads bigger than this at the listener; the ear rings above EAR_RING_MAGNITUDE. */
export const DUCK_MAGNITUDE = 0.4, EAR_RING_MAGNITUDE = 0.8, EAR_RING_GAP_S = 7;
export type BlastMaterial = 'soil' | 'rock' | 'concrete' | 'metal' | 'water';
export interface ExplosionInput { position: readonly [number, number, number]; radius: number; munition?: string; seed: number; noCrater?: boolean; material?: BlastMaterial }

function spriteFor(bank: SfxBank, kind: string, magnitude: number, far: boolean, material: BlastMaterial | undefined): string {
  if (kind === 'nuclear') return 'nuclear';
  if (kind === 'heavy') return far ? 'heavy-far' : 'heavy';
  if (kind === 'incendiary') return far ? 'he-far' : 'incendiary';
  if (far) return 'he-far';
  if (magnitude < 0.3) return 'he-small';
  if (magnitude >= 0.62) return 'he-large';
  const byMaterial = material ? `he-${material}` : null;
  return byMaterial && bank.has(byMaterial) ? byMaterial : 'he';
}
let lastEarRing = -Infinity;
export function playExplosion(m: AudioManager, e: ExplosionInput, bank?: SfxBank): { voice: Voice | null; boomAt: number; ducked: boolean } {
  const s = m.spatialize(e.position), path = s.path, now = m.now();
  const kind = explosionKindOf(e.munition), magnitude = blastMagnitude01(Number.isFinite(e.radius) ? e.radius : 2) * (e.noCrater ? 0.6 : 1);
  if (bank?.ready && bank.has('he')) {
    const delay = soundDelay(path), preRoll = kind === 'nuclear' ? NUKE_PRE_ROLL : 0;
    const at = now + 0.005 + Math.max(0, delay - preRoll), boomAt = at + preRoll;
    const near = 1 - smoothstep(path, 12, 34), far = smoothstep(path, 10, 30);
    const rate = 1 + (((e.seed >>> 3) % 1000) / 1000 - 0.5) * 0.08 * (1.1 - 0.4 * magnitude);
    const level = 0.6 + 0.4 * magnitude;
    let voice: Voice | null = null;
    if (near > 0.06) voice = bank.play(m, spriteFor(bank, kind, magnitude, false, e.material), { bus: 'explosions', priority: PRIORITY.explosion, position: e.position, at, gain: near * level, rate, variant: e.seed, burst: true, minLoudness: 0.002 });
    if (far > 0.06 && kind !== 'nuclear') voice = bank.play(m, spriteFor(bank, kind, magnitude, true, e.material), { bus: 'explosions', priority: PRIORITY.explosion, position: e.position, at, gain: far * level, rate: rate * 0.98, variant: e.seed >> 5, burst: !voice, minLoudness: 0.002 }) ?? voice;
    const perceived = perceivedMagnitude(e.radius, path), ducked = voice !== null && perceived > DUCK_MAGNITUDE;
    if (ducked) m.duck(boomAt);
    if (voice && perceived > EAR_RING_MAGNITUDE && now - lastEarRing > EAR_RING_GAP_S && bank.has('ear-ring')) { lastEarRing = now; bank.play(m, 'ear-ring', { bus: 'impacts', priority: PRIORITY.impact, at: boomAt + 0.02, gain: 0.45 * Math.min(1, perceived), variant: e.seed, minLoudness: 0 }); }
    return { voice, boomAt, ducked };
  }
  const plan = explosionPlan({ munition: e.munition, radius: e.radius, distance: path, seed: e.seed });
  const at = now + plan.start, boomAt = at + plan.preRoll;
  const voice = m.play(plan.recipe, { bus: 'explosions', priority: PRIORITY.explosion, position: e.position, at, burst: true, minLoudness: 0.002 });
  const ducked = voice !== null && perceivedMagnitude(e.radius, path) > DUCK_MAGNITUDE;
  if (ducked) m.duck(boomAt);
  return { voice, boomAt, ducked };
}
