/** Today's practice bot as an observation-only brain (profile 'legacy'): after half a second it scans when it has no
 * sight, then scores 18 fixed (pitch × power) candidates at its primary contact by the closest approach of each trace,
 * 32 trace steps per tick, fires the best, and scoots along a heading drawn from the match stream. The match stream is
 * injected so the seeded duel stays byte-identical to the pre-brain simulation. */
import type { BallisticTrace, BotBrain, BotDecision, BotObservation } from '../api/bot';
import type { DriveInput, TankState, V3 } from '../contracts';
import { clamp, distance, dot, rotate, segmentDistance, sub, wrapAngle } from '../math';

interface Candidate { yaw: number; pitch: number; power: number }
interface Search { target: V3; candidates: Candidate[]; cursor: number; trace: BallisticTrace | null; closest: number; bestScore: number; best: Candidate }
export interface ContactView { position: V3; observedAt: number; visible: boolean }

/** The simulation's primary contact rule (contacts[observer]): the nearest visible enemy, else the latest sighting. */
export function primaryContact(o: BotObservation): ContactView | null {
  const team = o.self.team;
  const entries = [...o.visible.filter(entry => entry.team !== team).map(entry => ({ tank: entry.tank, contact: { position: entry.position, observedAt: entry.observedAt, visible: true } })),
    ...o.lastKnown.filter(entry => entry.team !== team).map(entry => ({ tank: entry.tank, contact: { position: entry.position, observedAt: entry.observedAt, visible: false } }))]
    .sort((a, b) => a.tank - b.tank);
  let best: ContactView | null = null, bestDistance = Infinity;
  for (const { contact } of entries) {
    const range = distance(contact.position, o.self.position);
    if (!best || (contact.visible && !best.visible) || (contact.visible === best.visible
      && (contact.visible ? range < bestDistance : contact.observedAt > best.observedAt))) { best = contact; bestDistance = range; }
  }
  return best;
}

export class LegacyBrain implements BotBrain {
  readonly profile = 'legacy' as const;
  private search: Search | null = null;
  private moveHeading = 0;
  constructor(private readonly random: () => number) {}

  begin(): void { this.search = null; }

  step(o: BotObservation): BotDecision | null {
    const self = o.self, munition = self.munition ?? 'explosive';
    if ((o.phaseTime ?? 0) < 0.5) return null;
    if (!this.search) {
      const contact = primaryContact(o);
      if ((!contact || !contact.visible) && self.charge >= o.rules.radarCost) return { kind: 'scan' };
      if (!contact) {
        const yaw = this.random() * Math.PI * 2, pitch = 0.65 + this.random() * 0.4, power = 0.4 + this.random() * 0.3;
        this.pickHeading(self);
        return { kind: 'fire', yaw, pitch, power, munition };
      }
      const delta = sub(contact.position, self.position);
      const yaw = Math.atan2(dot(delta, rotate([1, 0, 0], self.rotation)), dot(delta, rotate([0, 0, 1], self.rotation)));
      const candidates: Candidate[] = [];
      for (const pitch of [0.2, 0.4, 0.6, 0.8, 1, 1.2]) for (const power of [0.22, 0.5, 0.78]) candidates.push({ yaw, pitch, power });
      this.search = { target: [...contact.position], candidates, cursor: 0, trace: null, closest: Infinity, bestScore: Infinity, best: candidates[0] };
    }
    const search = this.search;
    // At most 32 trace steps per tick (the simulation's meter may stop it earlier); traces never see a tank.
    for (let steps = 0; steps < 32 && search.cursor < search.candidates.length; steps++) {
      if (!search.trace) { const c = search.candidates[search.cursor]; search.trace = o.trace!(c.yaw, c.pitch, c.power, munition); search.closest = Infinity; }
      const step = search.trace.step();
      if (!step) break;
      search.closest = Math.min(search.closest, segmentDistance(search.target, step.from, step.to));
      if (step.hit || step.expired) {
        const score = search.closest + (step.expired ? 1 : 0);
        if (score < search.bestScore) { search.bestScore = score; search.best = search.candidates[search.cursor]; }
        search.cursor++;
        search.trace = null;
      }
    }
    if (search.cursor < search.candidates.length) return null;
    this.pickHeading(self);
    return { kind: 'fire', ...search.best, munition };
  }

  drive(o: BotObservation): DriveInput {
    return { throttle: 0.85, steer: -clamp(wrapAngle(this.moveHeading - o.self.heading) * 1.8, -1, 1) };
  }

  /** The scoot heading, drawn when the bot fires (two draws from the match stream, as before). */
  private pickHeading(self: TankState): void {
    this.moveHeading = self.heading + (this.random() > 0.5 ? 1 : -1) * (0.8 + this.random() * 0.8);
  }
  /** The heading the bot scoots along after its shot (tests and presentation). */
  get heading(): number { return this.moveHeading; }
}
