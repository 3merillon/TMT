/**
 * Impacts on machines and terrain. A hit's sound follows its physical outcome: a glancing or absorbed hit RICOCHETS
 * (bright zing, sparks), a damaging hit PENETRATES (heavy clank, thud, loose-rivet rattle), a heavy direct hit tears
 * metal; a lethal hit becomes a destruction burst; shields shimmer; EMP crackles and winds the machine down; committed
 * craters settle their rubble. The recipes remain as the fallback before the bank decodes.
 */
import type { AudioManager } from '../audio-manager';
import type { SfxBank } from '../sfx-bank';
import type { Voice } from './layers';
import { armorClankRecipe, killAccentRecipe, rubbleSettleRecipe } from './tank-sfx-math';
import { PRIORITY } from '../voice-select';

type P = readonly [number, number, number];
export interface ArmorHit { damage01: number; direct: boolean; lethal?: boolean; section?: string; reactiveSpent?: boolean; shielded?: boolean; heavy?: boolean }
const rateOf = (seed: number, spread: number) => 1 + (((seed >>> 3) % 1000) / 1000 - 0.5) * 2 * spread;

export function playArmorHit(m: AudioManager, position: P, hit: ArmorHit, seed: number, delay = 0, bank?: SfxBank): Voice | null {
  const t = Math.max(0, Math.min(1, hit.damage01)), at = m.now() + 0.005 + delay;
  if (bank?.ready && bank.sprite('penetrate')) {
    if (hit.shielded) return bank.play(m, 'shield-hit', { bus: 'impacts', priority: PRIORITY.impact, position, at, gain: 0.7 + 0.3 * t, rate: rateOf(seed, 0.05), variant: seed, burst: true });
    const ricochet = !hit.direct && t < 0.22 && !hit.reactiveSpent;
    if (ricochet) return bank.play(m, 'ricochet', { bus: 'impacts', priority: PRIORITY.impact, position, at, gain: 0.6 + 0.4 * t / 0.22, rate: rateOf(seed, 0.07), variant: seed, burst: true });
    const heavy = (hit.direct && t > 0.55) || hit.heavy || hit.reactiveSpent;
    const voice = bank.play(m, heavy ? 'penetrate-heavy' : 'penetrate', { bus: 'impacts', priority: PRIORITY.impact, position, at, gain: 0.55 + 0.45 * t, rate: rateOf(seed, 0.05), variant: seed, burst: true });
    // Reactive armour spends a section with a small blast of its own.
    if (hit.reactiveSpent && bank.sprite('he-small')) bank.play(m, 'he-small', { bus: 'explosions', priority: PRIORITY.impact, position, at: at + 0.01, gain: 0.5, rate: 1.12, variant: seed >> 3, burst: true });
    return voice;
  }
  return m.play(armorClankRecipe(t, hit.direct, seed), { bus: 'impacts', priority: PRIORITY.impact, position, at, burst: true });
}
export function playKillAccent(m: AudioManager, position: P, seed: number, delay = 0, bank?: SfxBank, big = false): Voice | null {
  const at = m.now() + 0.005 + delay;
  if (bank?.ready && bank.sprite('destruction')) return bank.play(m, big ? 'destruction-big' : 'destruction', { bus: 'impacts', priority: PRIORITY.kill, position, at, gain: 1, rate: rateOf(seed, 0.04), variant: seed });
  return m.play(killAccentRecipe(seed), { bus: 'impacts', priority: PRIORITY.kill, position, at });
}
export function playRubbleSettle(m: AudioManager, position: P, radius: number, seed: number, bank?: SfxBank): Voice | null {
  if (bank?.ready && bank.sprite('rubble')) return bank.play(m, radius > 3 ? 'rubble-large' : 'rubble', { bus: 'impacts', priority: PRIORITY.tick, position, gain: 0.5 + 0.5 * Math.min(1, radius / 4), rate: rateOf(seed, 0.06), variant: seed, burst: true });
  return m.play(rubbleSettleRecipe(radius, seed), { bus: 'impacts', priority: PRIORITY.tick, position, burst: true });
}
export function playEmp(m: AudioManager, bank: SfxBank, position: P, seed: number): Voice | null {
  if (!bank.ready) return null;
  return bank.play(m, 'emp', { bus: 'impacts', priority: PRIORITY.impact, position, gain: 0.9, rate: rateOf(seed, 0.04), variant: seed, burst: true });
}
export function playMetalCreak(m: AudioManager, bank: SfxBank, position: P, seed: number): Voice | null {
  if (!bank.ready) return null;
  return bank.play(m, 'metal-creak', { bus: 'ambience', priority: PRIORITY.tick, position, gain: 0.5, rate: rateOf(seed, 0.08), variant: seed, burst: true });
}
export type PingMaterial = 'metal' | 'rock' | 'concrete' | 'soil' | 'water';
/** A round striking something: the armour ping, or the material's own impact (rock chips, a dusty concrete thwack, a soil thud, a water plunk). */
export function playRicochetPing(m: AudioManager, bank: SfxBank, position: P, seed: number, material: PingMaterial = 'metal'): Voice | null {
  if (!bank.ready) return null;
  const id = material === 'metal' || !bank.has(`ric-${material}`) ? 'ricochet' : `ric-${material}`;
  return bank.play(m, id, { bus: 'impacts', priority: PRIORITY.tracer, position, gain: material === 'metal' ? 0.45 : 0.55, rate: rateOf(seed, 0.1) * (material === 'metal' ? 1.08 : 1), variant: seed, burst: true });
}
/** The stages after a kill: the turret ring-out at +0.5 s and secondary pops (ammunition cooking off) from +1.1 s. */
export function playWreckStages(m: AudioManager, bank: SfxBank, position: P, seed: number, delay = 0, big = false): void {
  if (!bank.ready) return;
  const at = m.now() + 0.005 + delay;
  if (bank.has('turret-ring')) bank.play(m, 'turret-ring', { bus: 'vehicles', priority: PRIORITY.impact, position, at: at + 0.5, gain: big ? 0.9 : 0.7, rate: rateOf(seed ^ 0x3a, 0.08) * (big ? 0.9 : 1), variant: seed >> 2 });
  if (bank.has('wreck-pops')) bank.play(m, 'wreck-pops', { bus: 'explosions', priority: PRIORITY.impact, position, at: at + 1.1, gain: big ? 0.75 : 0.6, rate: rateOf(seed ^ 0x5c, 0.06), variant: seed >> 4 });
}
export function playLanding(m: AudioManager, bank: SfxBank, position: P, seed: number, intensity: number): Voice | null {
  if (!bank.ready) return null;
  return bank.play(m, 'landing', { bus: 'vehicles', priority: PRIORITY.thump, position, gain: 0.5 + 0.5 * intensity, rate: rateOf(seed, 0.05), variant: seed, burst: true });
}
export function playThump(m: AudioManager, bank: SfxBank, position: P, seed: number, intensity: number): Voice | null {
  if (!bank.ready) return null;
  return bank.play(m, intensity > 0.6 ? 'thump-hard' : 'thump', { bus: 'vehicles', priority: PRIORITY.thump, position, gain: 0.4 + 0.6 * intensity, rate: rateOf(seed, 0.07), variant: seed, burst: true });
}
