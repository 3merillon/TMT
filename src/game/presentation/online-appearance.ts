/** Presentation-only online paint. Match snapshots, saves and simulation hashes never own these assets. */
import type { TankAppearance } from '../meta/cosmetics';

export interface OnlineVehicleAppearance { active: boolean; appearance: TankAppearance | null; revision: number }
let active = false, session = '', revision = 0;
const entries = new Map<number, OnlineVehicleAppearance>();
const absent: OnlineVehicleAppearance = { active: false, appearance: null, revision: 0 };

export function configureOnlineAppearances(key: string): void {
  if (active && session === key) return;
  active = true; session = key; entries.clear(); absent.active = true; absent.revision = ++revision;
}
export function publishOnlineAppearance(seat: number, appearance: TankAppearance | null): void {
  if (!active) return;
  entries.set(seat, { active: true, appearance, revision: ++revision });
}
export function clearOnlineAppearances(): void {
  active = false; session = ''; entries.clear(); absent.active = false; absent.revision = ++revision;
}
/** Null while an online asset loads means use normal team paint, including for seat zero. */
export function onlineVehicleAppearance(id: number): OnlineVehicleAppearance { return active ? entries.get(id) ?? absent : absent; }
