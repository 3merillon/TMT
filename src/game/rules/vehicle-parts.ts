/** Shared destruction rules for rendered parts and their collision geometry. */
import type { TankState } from '../contracts';
import { vehicleFailureMask } from './vehicle-damage';

export function vehiclePartMissing(tank: TankState, name: string, joint: string, left?: boolean): boolean {
  const dead = tank.health <= 0, mask = dead ? 15 : vehicleFailureMask(tank);
  if (dead && name.startsWith('component:')) return true;
  const component = tank.components?.find(c => name === `component:${c.id}`);
  if (component) return dead || component.health <= 0;
  if (!mask) return false;
  if (name.startsWith('lift-') || name.startsWith('rustling-drive-'))
    return !!(mask & (name.startsWith('lift-1-') || name === 'rustling-drive-1' ? 1 : 2));
  if (left !== undefined && (name === 'links' || name === 'sprockets')) return !!(mask & (left ? 1 : 2));
  if (mask & 8 && (joint === 'barrel' || name.includes('flight-pod') || name.includes('coax') || name.includes('gun')
    || name === 'rustling-cupola' || name === 'spire-defence' || name === 'searchlight-head' || name === 'relay-mast')) return true;
  if (mask & 4 && (name === 'relay-mast' || name.startsWith('flight-engine') || name === 'flight-rotor' || name === 'flight-tail-rotor' || joint === 'hatch')) return true;
  return dead && (name === 'flight-tail' || name === 'head' || joint === 'head');
}
