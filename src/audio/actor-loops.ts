/**
 * Persistent loops that belong to actors other than driving chassis: burning wrecks, the Dragonfly's rotor, the
 * Skimmer's hover, Rustling swarms, the Siege Crawler's furnace, Rust Spires, searchlight towers and shields. Each kind
 * has a bank sprite, an audible range and a slot cap; the nearest candidates get slots with hysteresis (the same
 * selector as the engine loops). Keys include the actor's generation, so a recycled slot never inherits a sound, and a
 * wreck's loop stops when the wreck retires or the key disappears.
 */
import type { AudioManager } from './audio-manager';
import type { SfxBank } from './sfx-bank';
import type { Voice } from './sfx/layers';
import { PRIORITY, selectLoopVoices, type BusName, type LoopCandidate } from './voice-select';

export type ActorLoopKind = 'wreck' | 'rotor' | 'hover' | 'swarm' | 'crawler' | 'spire' | 'searchlight' | 'shield';
export interface ActorLike {
  id: number; generation?: number; retired?: boolean; destroyedAt?: number; health: number; maxHealth?: number;
  position: readonly [number, number, number]; motionKind?: 'chassis' | 'swarm' | 'air'; visualKind?: string;
  components?: readonly unknown[]; shield?: unknown; searchlight?: unknown;
}
interface KindSpec { sprite: string; range: number; max: number; gain: number; bus: BusName; fadeIn: number; fadeOut: number; rateJitter: number }
export const ACTOR_LOOPS: Readonly<Record<ActorLoopKind, KindSpec>> = {
  wreck: { sprite: 'wreck-fire', range: 22, max: 4, gain: 0.8, bus: 'ambience', fadeIn: 0.6, fadeOut: 1.2, rateJitter: 0.06 },
  rotor: { sprite: 'rotor', range: 34, max: 2, gain: 0.7, bus: 'vehicles', fadeIn: 0.3, fadeOut: 0.4, rateJitter: 0.03 },
  hover: { sprite: 'hover', range: 26, max: 2, gain: 0.6, bus: 'vehicles', fadeIn: 0.3, fadeOut: 0.4, rateJitter: 0.03 },
  swarm: { sprite: 'swarm', range: 18, max: 3, gain: 0.55, bus: 'vehicles', fadeIn: 0.2, fadeOut: 0.3, rateJitter: 0.08 },
  crawler: { sprite: 'crawler', range: 40, max: 1, gain: 0.9, bus: 'vehicles', fadeIn: 0.5, fadeOut: 0.8, rateJitter: 0 },
  spire: { sprite: 'spire', range: 24, max: 2, gain: 0.6, bus: 'ambience', fadeIn: 0.8, fadeOut: 1, rateJitter: 0.04 },
  searchlight: { sprite: 'searchlight', range: 20, max: 2, gain: 0.45, bus: 'vehicles', fadeIn: 0.4, fadeOut: 0.5, rateJitter: 0.03 },
  shield: { sprite: 'shield', range: 20, max: 2, gain: 0.5, bus: 'ambience', fadeIn: 0.4, fadeOut: 0.5, rateJitter: 0.02 },
};
/** Wreck lifetime in ticks (realtime rules retire enemy wrecks after this) and the fade before it. */
export const WRECK_TICKS = 60 * 25, WRECK_FADE_TICKS = 120;
const TAU = 0.06;

export function actorLoopKinds(t: ActorLike, tick: number): ActorLoopKind[] {
  if (t.retired) return [];
  const out: ActorLoopKind[] = [];
  if (t.health <= 0) { if (t.destroyedAt !== undefined && tick - t.destroyedAt < WRECK_TICKS) out.push('wreck'); return out; }
  if (t.motionKind === 'air') out.push(t.visualKind === 'skimmer' ? 'hover' : 'rotor');
  else if (t.visualKind === 'skimmer') out.push('hover');
  if (t.motionKind === 'swarm') out.push('swarm');
  if (t.components && t.components.length) out.push('crawler');
  if (t.visualKind === 'spire') out.push('spire');
  if (t.visualKind === 'watchtower' && t.searchlight) out.push('searchlight');
  if (t.shield) out.push('shield');
  return out;
}
interface Slot { key: string; kind: ActorLoopKind; voice: Voice; level: number; target: number; last: [number, number, number]; releaseAt: number }

export class ActorLoops {
  private readonly slots = new Map<string, Slot>();
  private readonly cands = new Map<ActorLoopKind, LoopCandidate[]>();
  private readonly selected = new Set<number>();
  private readonly keyOf = new Map<number, string>();
  started = 0;
  constructor(private readonly m: AudioManager, private readonly bank: SfxBank) {}
  get active(): number { let n = 0; for (const s of this.slots.values()) if (s.releaseAt === Infinity) n++; return n; }
  kinds(): Record<string, number> { const out: Record<string, number> = {}; for (const s of this.slots.values()) if (s.releaseAt === Infinity) out[s.kind] = (out[s.kind] ?? 0) + 1; return out; }

  update(actors: readonly ActorLike[], tick: number, now: number): void {
    if (!this.bank.ready) return;
    for (const list of this.cands.values()) list.length = 0;
    this.keyOf.clear();
    let serial = 0;
    for (const t of actors) {
      const kinds = actorLoopKinds(t, tick);
      if (!kinds.length) continue;
      const s = this.m.spatialize(t.position);
      for (const kind of kinds) {
        const key = `${kind}:${t.id}:${t.generation ?? 0}`;
        const id = serial++;
        this.keyOf.set(id, key);
        let list = this.cands.get(kind); if (!list) this.cands.set(kind, list = []);
        list.push({ id, dist: s.path, range: ACTOR_LOOPS[kind].range, live: this.slots.has(key) && this.slots.get(key)!.releaseAt === Infinity });
      }
    }
    const wanted = new Set<string>();
    for (const [kind, list] of this.cands) {
      selectLoopVoices(list, ACTOR_LOOPS[kind].max, this.selected);
      for (const id of this.selected) wanted.add(this.keyOf.get(id)!);
    }
    // Release slots whose key is gone or deselected; start wanted keys that have no slot.
    for (const [key, slot] of this.slots) {
      if (slot.releaseAt !== Infinity) { if (now >= slot.releaseAt) { this.m.releaseLoop(slot.voice); slot.voice.dispose(); this.slots.delete(key); } continue; }
      if (!wanted.has(key)) this.release(slot, now);
    }
    const byKey = new Map<string, ActorLike>();
    for (const t of actors) for (const kind of actorLoopKinds(t, tick)) byKey.set(`${kind}:${t.id}:${t.generation ?? 0}`, t);
    for (const key of wanted) {
      const actor = byKey.get(key); if (!actor) continue;
      const kind = key.split(':')[0] as ActorLoopKind;
      let slot = this.slots.get(key);
      if (!slot || slot.releaseAt !== Infinity) { if (slot) { this.m.releaseLoop(slot.voice); slot.voice.dispose(); this.slots.delete(key); } const made = this.start(key, kind, actor, now); if (!made) continue; slot = made; }
      this.write(slot, actor, kind, tick, now);
    }
  }
  private start(key: string, kind: ActorLoopKind, actor: ActorLike, now: number): Slot | null {
    const spec = ACTOR_LOOPS[kind];
    const h = hash(key);
    const rate = 1 + ((h % 1000) / 1000 - 0.5) * 2 * spec.rateJitter;
    const voice = this.bank.play(this.m, spec.sprite, { bus: spec.bus, priority: PRIORITY.loop, position: actor.position, loop: true, rate, variant: h >> 8, gain: 0.0001, minLoudness: 0 });
    if (!voice) return null;
    const slot: Slot = { key, kind, voice, level: 0, target: 1, last: [NaN, NaN, NaN], releaseAt: Infinity };
    this.slots.set(key, slot);
    this.started++;
    return slot;
  }
  private write(slot: Slot, actor: ActorLike, kind: ActorLoopKind, tick: number, now: number): void {
    const spec = ACTOR_LOOPS[kind], s = this.m.spatialize(actor.position);
    let env = 1;
    if (kind === 'wreck' && actor.destroyedAt !== undefined) { const age = tick - actor.destroyedAt; env = Math.min(1, age / 30) * Math.min(1, Math.max(0, (WRECK_TICKS - age) / WRECK_FADE_TICKS)) * (0.55 + 0.45 * Math.max(0, 1 - age / WRECK_TICKS)); }
    const gain = s.gain * spec.gain * env;
    const L = slot.last;
    const tc = slot.level < 0.5 ? spec.fadeIn / 3 : TAU;
    if (!(Math.abs(gain - L[0]) <= Math.max(1e-4, Math.abs(L[0]) * 0.02))) { slot.voice.out.gain.setTargetAtTime(gain, now, tc); L[0] = gain; }
    if (!(Math.abs(s.pan - L[1]) <= 0.01)) { slot.voice.panner!.pan.setTargetAtTime(s.pan, now, TAU); L[1] = s.pan; }
    if (!(Math.abs(s.lowpass - L[2]) <= Math.abs(L[2]) * 0.02)) { slot.voice.lowpass!.frequency.setTargetAtTime(s.lowpass, now, 0.08); L[2] = s.lowpass; }
    slot.level = 1;
  }
  private release(slot: Slot, now: number): void {
    const spec = ACTOR_LOOPS[slot.kind];
    slot.voice.out.gain.cancelScheduledValues(now); slot.voice.out.gain.setTargetAtTime(0, now, spec.fadeOut / 4);
    slot.releaseAt = now + spec.fadeOut;
  }
  reset(now: number): void { for (const slot of this.slots.values()) if (slot.releaseAt === Infinity) this.release(slot, now); }
  dispose(): void { for (const slot of this.slots.values()) { this.m.releaseLoop(slot.voice); slot.voice.dispose(); } this.slots.clear(); }
}
function hash(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }
