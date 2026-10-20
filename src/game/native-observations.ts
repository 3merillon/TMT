/** Transport for match-owned sightings, radar and bot knowledge. A live query
 * lease stays inside WASM; analytic fixture callbacks service ordered requests. */
import type { RustTerrainCore } from '../gpu/terrain/rust-core';
import type { MatchSetup } from './api/match';
import type { BotObservation } from './api/bot';
import type { GameSnapshot, TankState, V3, WorldQuery } from './contracts';
import { assembleKit, tankKit, V1_PROXY } from './kit';
import { ROOT_SURFACE_LIFT, SIGHT_TARGET } from './kit/dimensions';

function kit(t: TankState): number[] {
  const k = assembleKit(tankKit(t)), hull = k.proxies[V1_PROXY.hull].box, turret = k.proxies[V1_PROXY.turret].box;
  return [...k.frames.sensor.position, ...hull.center, ...hull.half, ...turret.center, turret.half[1], ...k.frames.turretRing.position];
}
export class NativeObservations {
  constructor(private readonly core: RustTerrainCore, private readonly id: number, private readonly state: GameSnapshot, setup: MatchSetup, radius: number, private readonly origin?: () => number | undefined, private readonly residentMotion?: () => boolean) {
    this.call(16, [1, radius, +setup.rules.fog, setup.seed, ROOT_SURFACE_LIFT, ...SIGHT_TARGET, ...state.tanks.flatMap(kit)]);
  }
  private call(op: number, data: ArrayLike<number> = []): Float64Array { return this.core.matchCommand(this.id, op, data); }
  private poses(): number[] { return this.residentMotion?.() ? [] : this.state.tanks.flatMap(t => [...t.position, ...t.rotation]); }
  refresh(world: WorldQuery): void { this.query(17, world); }
  scan(world: WorldQuery, id: number, serial: boolean): boolean {
    if (!Number.isFinite(id)) return false;
    const origin = this.origin?.();
    return this.query(25, world, [id, +serial, ...(origin === undefined ? [] : [origin])]);
  }
  private query(op: number, world: WorldQuery, args: number[] = []): boolean {
    const query = world.ballisticQuery?.();
    if (query && query.core !== this.core) throw new Error('Observation query belongs to another engine');
    try {
      let w = this.call(op, [query?.kind ?? 0, query?.id ?? 0, query?.range ?? 1, ...args, ...this.poses()]);
      while (w[0]) {
        if (w[0] === 1) {
          const origin: V3 = [w[1], w[2], w[3]], direction: V3 = [w[4], w[5], w[6]];
          const terrain = world as WorldQuery & { blocked?(origin: V3, direction: V3, maximum: number): boolean };
          const hit = terrain.blocked ? terrain.blocked(origin, direction, w[7]) : !!world.raycast(origin, direction, w[7]);
          w = this.call(18, [+hit]);
        } else {
          const hit = world.surface([w[1], w[2], w[3]]); w = this.call(18, hit ? hit.point : []);
        }
      }
      if (w[1]) this.publish();
      return !!w[1];
    } catch (error) { this.call(24); throw error; }
  }
  /** Also the replay of a v20 tick tail's contact record (op 26 words). */
  publish(w: Float64Array = this.call(26)): void {
    const n = this.state.tanks.length, rows = this.state.observations!;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const p = (i * n + j) * 8;
      rows[i][j] = w[p] ? { position: [w[p + 1], w[p + 2], w[p + 3]], observedAt: w[p + 4], source: w[p + 5] ? 'scan' : 'sight', visible: !!w[p + 6] } : null;
    }
    for (let i = 0; i < n; i++) { const target = w[n * n * 8 + i]; this.state.contacts[i] = target < 0 ? null : rows[i][target]; }
  }
  setKit(tank: TankState): void { this.call(23, [tank.id, ...kit(tank)]); }
  sightPoints(tank: TankState): V3[] {
    const w = this.call(22, [tank.id, ...(this.residentMotion?.() ? [] : [...tank.position, ...tank.rotation])]), points: V3[] = [];
    for (let i = 0; i < w.length; i += 3) points.push([w[i], w[i + 1], w[i + 2]]); return points;
  }
  hear(shooter: number, shot: number): void { this.call(20, [shooter, shot, ...this.poses()]); }
  impact(owner: number, position: V3): void { this.call(21, [owner, ...position]); }
  knowledge(id: number): Pick<BotObservation, 'visible' | 'lastKnown' | 'sounds' | 'impacts'> {
    const w = this.call(19, [id, ...this.poses()]), visible: BotObservation['visible'] = [], lastKnown: BotObservation['lastKnown'] = [];
    let p = 1;
    for (let i = 0; i < w[0]; i++, p += 8) {
      const contact = { tank: w[p + 1], team: w[p + 2], position: [w[p + 3], w[p + 4], w[p + 5]] as V3, observedAt: w[p + 6] };
      if (w[p]) visible.push(contact); else lastKnown.push({ ...contact, uncertainty: w[p + 7] });
    }
    const sounds: BotObservation['sounds'] = [], ns = w[p++];
    for (let i = 0; i < ns; i++, p += 2) sounds.push({ bearing: w[p], tick: w[p + 1] });
    const impacts: BotObservation['impacts'] = [], ni = w[p++];
    for (let i = 0; i < ni; i++, p += 4) impacts.push({ tick: w[p], position: [w[p + 1], w[p + 2], w[p + 3]] });
    return { visible, lastKnown, sounds, impacts };
  }
}
