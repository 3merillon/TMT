/** Insulated bogie drive: low unsprung mass, fast electric response and long range. */
import type { GearSpec } from '../types';
import { GRIP } from './grip';

export const AETHER_DRIVE: GearSpec = {
  ...GRIP,
  id: 'aether_drive', name: 'Aether drive', wheelStyle: 'aether',
  stats: { cost: 5, mass: 2.6, speed: 4.8, fuel: 8.5, climbDeg: 41, traction: 1.7, lateralTraction: 1.3 },
};
