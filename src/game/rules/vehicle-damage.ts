import type { DriveInput, TankState, V3 } from '../contracts';
import { rotate, sub } from '../math';

export type VehicleModule = 'leftTrack' | 'rightTrack' | 'engine' | 'weapon';
export const VEHICLE_MODULES: readonly VehicleModule[] = ['leftTrack', 'rightTrack', 'engine', 'weapon'];
/** Repairs must restore a useful amount of machinery before it can carry a load again. */
export const MODULE_DISABLED = .15;
export function localImpact(tank: TankState, point: V3): V3 {
  const [x, y, z, w] = tank.rotation;
  return rotate(sub(point, tank.position), [-x, -y, -z, w]);
}
/** +X is the driver's left. Machinery is selected in the vehicle frame, never world axes. */
export function impactModule(tank: TankState, point: V3): VehicleModule {
  const p = localImpact(tank, point);
  if (tank.visualKind === 'dragonfly') {
    // Outboard rocket pods extend aft of the cockpit; they are not part of the powerplant.
    if (Math.abs(p[0]) > .44 && p[1] < .20) return 'weapon';
    if (Math.abs(p[0]) > .19 && p[1] > .26 && p[2] < .10) return 'engine';
    return p[1] > .65 || p[2] < -.28 ? 'engine' : 'weapon';
  }
  if (tank.visualKind === 'skimmer' && Math.abs(p[0]) > .38) return p[0] > 0 ? 'leftTrack' : 'rightTrack';
  if (tank.visualKind === 'rustling' && Math.abs(p[0]) > .25 && p[1] < .1) return p[0] > 0 ? 'leftTrack' : 'rightTrack';
  if (p[1] > .28) return 'weapon';
  if (Math.abs(p[0]) > .38 && tank.motionKind !== 'air' && !tank.visualKind) return p[0] > 0 ? 'leftTrack' : 'rightTrack';
  return 'engine';
}
/** Hull health remains authoritative; machinery is a consequence of damage that actually penetrated armour. */
export function damageVehicle(tank: TankState, point: V3, damage: number, direct: boolean): void {
  if (!(damage > 0) || !Number.isFinite(damage) || tank.components) return;
  const m = tank.machinery ??= { leftTrack: 1, rightTrack: 1, engine: 1, weapon: 1, impact: [0, .3, -.4] };
  const part = impactModule(tank, point), p = localImpact(tank, point);
  m.impact = [Math.max(-.85, Math.min(.85, p[0])), Math.max(-.15, Math.min(.7, p[1])), Math.max(-.8, Math.min(.8, p[2]))];
  const capacity = (tank.maxHealth ?? 130) * (part === 'weapon' ? .48 : part === 'engine' ? .55 : .32);
  m[part] = Math.max(0, m[part] - damage * (direct ? 1 : .35) / Math.max(1, capacity));
}
export function repairVehicle(tank: TankState, amount: number): void {
  if (!tank.machinery || !(amount > 0)) return;
  for (const part of VEHICLE_MODULES) tank.machinery[part] = Math.min(1, tank.machinery[part] + amount / Math.max(1, (tank.maxHealth ?? 130) * .5));
}
export function weaponOperational(tank: TankState): boolean { return (tank.machinery?.weapon ?? 1) > MODULE_DISABLED; }
export function vehicleFailureMask(tank: TankState): number {
  return VEHICLE_MODULES.reduce((mask, part, i) => mask | ((tank.machinery?.[part] ?? 1) <= MODULE_DISABLED ? 1 << i : 0), 0);
}
export function vehicleDamageLabel(tank: TankState): string {
  const m = tank.machinery;
  if (!m) return '';
  if (m.engine <= MODULE_DISABLED) return 'ENGINE DISABLED';
  if (m.leftTrack <= MODULE_DISABLED && m.rightTrack <= MODULE_DISABLED) return 'DRIVE DISABLED';
  if (m.leftTrack <= MODULE_DISABLED || m.rightTrack <= MODULE_DISABLED) return tank.visualKind === 'skimmer' ? 'LIFT DAMAGED' : `${m.leftTrack <= MODULE_DISABLED ? 'LEFT' : 'RIGHT'} TRACK BROKEN`;
  return !weaponOperational(tank) ? 'WEAPON DISABLED' : '';
}
/** Mix into left/right torque and remove failed drive torque. One broken belt pulls to that side. */
export function damagedDrive(tank: TankState, input: DriveInput): DriveInput {
  const m = tank.machinery;
  if (!m) return input;
  // Superficial wear does not continuously pull an otherwise healthy vehicle off course.
  // Below half integrity damaged machinery loses torque; a severed belt contributes none.
  const torque = (health: number) => health <= MODULE_DISABLED ? 0 : Math.min(1, .5 + health);
  const power = torque(m.engine);
  const left = (input.throttle + input.steer) * torque(m.leftTrack) * power;
  const right = (input.throttle - input.steer) * torque(m.rightTrack) * power;
  return { ...input, throttle: Math.max(-1, Math.min(1, (left + right) * .5)), steer: Math.max(-1, Math.min(1, (left - right) * .5)) };
}
export function validMachinery(value: TankState['machinery']): boolean {
  return value === undefined || !!value && VEHICLE_MODULES.every(p => Number.isFinite(value[p]) && value[p] >= 0 && value[p] <= 1)
    && Array.isArray(value.impact) && value.impact.length === 3 && value.impact.every(Number.isFinite);
}
