/**
 * Chassis force providers (plan §5.5, created by W1-PHY): how later streams add forces to the resident tank chassis
 * without editing resident-tanks.ts. `ResidentTanks.beforeStep` instantiates every factory once and, each tick and
 * for each tank, calls `modifiers` before the drive model and `apply` after the drive model and the assists.
 * Providers must be deterministic (tick state, inputs and world queries only; plan §6 N4).
 *
 * APPEND-ONLY registry (plan §7.3): add one factory per line in FORCE_PROVIDERS, tagged `// <STREAM-ID>`.
 */
import type { TankState, V3 } from '../contracts';
import type { KitAssembly } from '../kit/types';

export interface ChassisForceContext { tank: TankState; kit: KitAssembly; dt: number; tick: number;
  pointVelocity(p: V3): V3; addForceAtPoint(f: V3, p: V3): void; addTorque(t: V3): void /* applied after resetTorques */ }
export interface ChassisForceProvider { readonly id: string; apply(c: ChassisForceContext): void;
  modifiers?(t: TankState): { traction: number; lateral: number; angularDampingAdd: number } }

export const FORCE_PROVIDERS: (() => ChassisForceProvider)[] = [
];
