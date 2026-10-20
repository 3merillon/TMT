import type { RustTerrainCore } from '../gpu/terrain/rust-core';
import type { MatchSetup } from './api/match';
import type { TerrainHit, V3 } from './contracts';
import type { Flight } from './rules/ballistics';
import type { WindState } from '../world/weather';
import type { NativeMatch } from './native-match';

export function readFlightStep(w: Float64Array, flight: Flight): { hit: TerrainHit | null; stepped: boolean; expired: boolean; direction: V3; extent: number } {
  if (w[7]) { flight.position = [w[0], w[1], w[2]]; flight.vx = w[3]; flight.vy = w[4]; flight.vz = w[5]; flight.age = w[6]; }
  return { hit: w.length === 21 ? { distance: w[13], point: [w[14], w[15], w[16]], normal: [w[17], w[18], w[19]], material: w[20] } : null,
    stepped: !!w[7], expired: !!w[8], direction: [w[9], w[10], w[11]], extent: w[12] };
}

/** A lease on the currently committed scene; never cache it across a terrain commit. */
export interface BallisticQuery { readonly core: RustTerrainCore; readonly id: number; readonly kind: 1 | 2; readonly range: number }
export class NativeBallistics {
  private context: number;
  private readonly flights = new WeakMap<Flight, number>();
  constructor(private readonly core: RustTerrainCore, setup: MatchSetup, gravity: number, radius: number) {
    const w = setup.rules.wind;
    this.context = core.createFlights([1, gravity, radius, setup.rules.projectileAge, (setup.environment?.weatherSeed ?? setup.seed) >>> 0,
      +!!w, w?.mean ?? 0, w?.gust ?? 0, w?.period ?? 1]);
  }
  windAt(tick: number): WindState | null {
    const w = this.call(0, 0, [tick]);
    return w.length ? { tick: w[0], strength: w[1], bars: w[2], heading: w[3], axis: [w[4], w[5], w[6]] } : null;
  }
  bind(match: NativeMatch): void { match.admitShots(this.core, this.context); }
  advance(flight: Flight, barrelLength: number, windFactor: number, query?: BallisticQuery): { hit: TerrainHit | null; stepped: boolean; expired: boolean; direction: V3; extent: number } {
    if (query && query.core !== this.core) throw new Error('Flight query belongs to another engine');
    let id = this.flights.get(flight);
    if (!id) {
      id = this.call(1, 0, [...flight.position, flight.vx, flight.vy, flight.vz, flight.age, flight.launchTick ?? 0, barrelLength, windFactor])[0];
      this.flights.set(flight, id);
    }
    const w = this.call(2, id, [query?.kind ?? 0, query?.id ?? 0, query?.range ?? 1]);
    return readFlightStep(w, flight);
  }
  release(flight: Flight): void {
    const id = this.flights.get(flight); if (id === undefined) return;
    if (this.context) this.call(3, id); this.flights.delete(flight);
  }
  retainedFlights(): number { return this.call(5)[0]; }
  dispose(): void { if (this.context) { this.core.disposeFlights(this.context); this.context = 0; } }
  private call(op: number, id = 0, data: ArrayLike<number> = []): Float64Array {
    if (!this.context) throw new Error('Resident ballistics is disposed');
    return this.core.flightCommand(this.context, op, id, data);
  }
}
