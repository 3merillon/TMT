/** Tempo timeline core (plan §3, Experience §1.7). The living unit with the lowest `readyAt` acts next; ties go to
 * the player team (a team with `ai: false`), then to the lower tank id. After an action, `readyAt += cost × tempo`.
 * With equal tempo this is exactly today's strict alternation. W2-GAME2 adds the full action-cost table and volleys;
 * in Wave 1 every turn-ending action costs a fire's 100 TU. Pure and deterministic. */
export type TempoAction = 'fire' | 'hold';
export const ACTION_COST: Readonly<Record<TempoAction, number>> = Object.freeze({ fire: 100, hold: 100 });

export interface TimelineUnit { readonly id: number; readonly readyAt: number; readonly alive: boolean; readonly playerTeam: boolean }

/** The id of the next unit to act, or null when nobody is alive. */
export function nextActor(units: readonly TimelineUnit[]): number | null {
  let best: TimelineUnit | null = null;
  for (const unit of units) {
    if (!unit.alive) continue;
    if (!best || unit.readyAt < best.readyAt
      || (unit.readyAt === best.readyAt && (unit.playerTeam && !best.playerTeam || (unit.playerTeam === best.playerTeam && unit.id < best.id)))) best = unit;
  }
  return best ? best.id : null;
}

/** `readyAt` after an action (tempo is the kit's product of part multipliers; 1 for every Wave-0 part). */
export function advanceReady(readyAt: number, action: TempoAction, tempo: number): number {
  if (!Number.isFinite(tempo) || tempo <= 0) throw new Error(`Tempo must be a positive finite multiplier, got ${tempo}`);
  return readyAt + ACTION_COST[action] * tempo;
}

/** The next `count` actors, simulating that each one takes `action` (the HUD's timeline rail). */
export function previewTimeline(units: readonly TimelineUnit[], tempo: (id: number) => number, count: number, action: TempoAction = 'fire'): number[] {
  const working = units.map(unit => ({ ...unit })), order: number[] = [];
  for (let i = 0; i < count; i++) {
    const next = nextActor(working);
    if (next === null) break;
    order.push(next);
    const unit = working.find(entry => entry.id === next)!;
    unit.readyAt = advanceReady(unit.readyAt, action, tempo(next));
  }
  return order;
}
