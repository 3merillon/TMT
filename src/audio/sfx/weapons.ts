/**
 * Weapon fire. With the bank decoded: the weapon's pre-rendered report at the muzzle as a near / mid / far trio
 * crossfaded by listener distance (a distant gun is a muffled thud with a longer tail, not a quiet crack; the mid take
 * covers 8-20 u so the crossfades are smooth), per-shot pitch and layer-gain randomisation, the speed-of-sound delay
 * for guns beyond a few units, and the loader's clunk for guns close enough to hear it. Before the bank arrives (or
 * for a sprite that is missing) the procedural recipe plays, so nothing is ever silent.
 */
import type { AudioManager } from '../audio-manager';
import type { SfxBank } from '../sfx-bank';
import type { Voice } from './layers';
import { RELOAD_CLUNK_AT, soundDelay, weaponFireRecipe, weaponVoiceOf } from './tank-sfx-math';
import { PRIORITY } from '../voice-select';

export interface FireInput { weapon: string | undefined; power: number; seed: number; position: readonly [number, number, number] }
const SPRITE: Record<string, { near: string; mid?: string; far?: string; reload: string; reloadAt: number }> = {
  cannon: { near: 'cannon', mid: 'cannon-mid', far: 'cannon-far', reload: 'reload', reloadAt: RELOAD_CLUNK_AT.cannon },
  mortar: { near: 'mortar', mid: 'mortar-mid', far: 'mortar-far', reload: 'reload-heavy', reloadAt: RELOAD_CLUNK_AT.mortar },
  rail: { near: 'rail', mid: 'rail-mid', far: 'rail-far', reload: 'reload', reloadAt: RELOAD_CLUNK_AT.rail },
  autocannon: { near: 'autocannon', mid: 'autocannon-mid', reload: 'reload', reloadAt: 0.9 },
  arc_cannon: { near: 'arc', mid: 'arc-mid', reload: 'reload', reloadAt: 1.4 },
  forge_mortar: { near: 'forge-mortar', far: 'forge-mortar-far', reload: 'reload-heavy', reloadAt: 1.8 },
};
export const smoothstep = (x: number, a: number, b: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
/** Near/far gains for a report `d` units away (two-take weapons): the near take fades out over 10-32 u, the far take in over 8-28 u. */
export function nearFar(d: number): [number, number] { return [1 - smoothstep(d, 10, 32), smoothstep(d, 8, 28)]; }
/** Near/mid/far gains (three-take weapons): near to 6-14 u, mid 5-12 in and 18-30 out, far from 16-28 u. */
export function nearMidFar(d: number): [number, number, number] { return [1 - smoothstep(d, 6, 14), smoothstep(d, 5, 12) * (1 - smoothstep(d, 18, 30)), smoothstep(d, 16, 28)]; }
const rateOf = (seed: number, spread = 0.04) => 1 + (((seed >>> 3) % 1000) / 1000 - 0.5) * 2 * spread;
/** Per-shot layer-gain randomisation: +/- `spread` (linear) from the seed. */
const gainJitter = (seed: number, spread = 0.12) => 1 + (((seed >>> 9) % 1000) / 1000 - 0.5) * 2 * spread;

export function playWeaponFire(m: AudioManager, f: FireInput, bank?: SfxBank): Voice | null {
  const kind = SPRITE[f.weapon ?? ''] ? f.weapon! : weaponVoiceOf(f.weapon);
  const spec = SPRITE[kind];
  if (bank?.ready && spec && bank.has(spec.near)) {
    const s = m.spatialize(f.position), d = s.path;
    const delay = d > 6 ? soundDelay(d) : 0, at = m.now() + 0.005 + delay, rate = rateOf(f.seed);
    const power = 0.85 + 0.15 * Math.max(0, Math.min(1, f.power));
    const hasMid = !!spec.mid && bank.has(spec.mid), hasFar = !!spec.far && bank.has(spec.far);
    const [near, mid, far] = hasMid ? nearMidFar(d) : [...nearFar(d), 0].length === 3 ? [nearFar(d)[0], 0, nearFar(d)[1]] : [1, 0, 0];
    let voice: Voice | null = null;
    if (near > 0.08) voice = bank.play(m, spec.near, { bus: 'weapons', priority: PRIORITY.weapon, position: f.position, at, gain: near * power * gainJitter(f.seed), rate, variant: f.seed, burst: true });
    if (hasMid && mid > 0.08) voice = bank.play(m, spec.mid!, { bus: 'weapons', priority: PRIORITY.weapon, position: f.position, at, gain: mid * power * gainJitter(f.seed ^ 0x33), rate: rateOf(f.seed ^ 0x19, 0.035), variant: f.seed >> 3, burst: !voice }) ?? voice;
    if (hasFar && far > 0.08) voice = bank.play(m, spec.far!, { bus: 'weapons', priority: PRIORITY.weapon, position: f.position, at, gain: far * power * gainJitter(f.seed ^ 0x55), rate: rateOf(f.seed ^ 0x51, 0.03), variant: f.seed >> 4, burst: !voice }) ?? voice;
    // The loader clunk: only audible on guns near the listener, after the weapon's reload time.
    if (near > 0.3 && bank.has(spec.reload)) bank.play(m, spec.reload, { bus: 'vehicles', priority: PRIORITY.thump, position: f.position, at: at + spec.reloadAt, gain: 0.55 * near, rate: rateOf(f.seed ^ 0x77, 0.05), variant: f.seed >> 6 });
    return voice;
  }
  const recipe = weaponFireRecipe(weaponVoiceOf(f.weapon), f.power, f.seed);
  return m.play(recipe, { bus: 'weapons', priority: PRIORITY.weapon, position: f.position, burst: true });
}
/** The coaxial machine gun: a three-round burst sprite (the fallback when the sustained loop is unavailable). */
export function playCoaxBurst(m: AudioManager, bank: SfxBank, position: readonly [number, number, number], seed: number): Voice | null {
  if (!bank.ready) return null;
  return bank.play(m, 'coax-burst', { bus: 'weapons', priority: PRIORITY.tracer, position, gain: 0.75, rate: rateOf(seed, 0.05), variant: seed, burst: true });
}
export function playCoaxRound(m: AudioManager, bank: SfxBank, position: readonly [number, number, number], seed: number): Voice | null {
  if (!bank.ready) return null;
  return bank.play(m, 'coax', { bus: 'weapons', priority: PRIORITY.tracer, position, gain: 0.7, rate: rateOf(seed, 0.06), variant: seed, burst: true });
}
/** A supersonic snap: a round passing within a couple of units of the listener. */
export function playSnap(m: AudioManager, bank: SfxBank, position: readonly [number, number, number], seed: number): Voice | null {
  if (!bank.has('snap')) return null;
  return bank.play(m, 'snap', { bus: 'weapons', priority: PRIORITY.impact, position, gain: 0.9, rate: rateOf(seed, 0.1), variant: seed, burst: true, minLoudness: 0 });
}
/** Arcs crackling on at an arc cannon's target. */
export function playArcCrackle(m: AudioManager, bank: SfxBank, position: readonly [number, number, number], seed: number, delay = 0): Voice | null {
  if (!bank.has('arc-crackle')) return null;
  return bank.play(m, 'arc-crackle', { bus: 'impacts', priority: PRIORITY.impact, position, at: m.now() + 0.005 + delay, gain: 0.8, rate: rateOf(seed, 0.06), variant: seed, burst: true });
}
