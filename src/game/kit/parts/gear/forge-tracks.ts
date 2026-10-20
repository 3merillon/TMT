/** Broad furnace-rated shoes and reinforced rocker hubs trade speed and range for grip. */
import type { GearSpec } from '../types';
import { CRAWLER } from './crawler';

export const FORGE_TRACKS: GearSpec = {
  ...CRAWLER,
  id: 'forge_tracks', name: 'Forge tracks', wheelStyle: 'forge',
  stats: { cost: 6, mass: 4.8, speed: 3.5, fuel: 6, climbDeg: 50, traction: 2, lateralTraction: 1.55 },
};
