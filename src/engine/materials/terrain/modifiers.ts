/**
 * APPEND-ONLY terrain modifier registry (plan §4.10, §5.4, §7.3). The terrain FS calls `tmod_<name>` for each entry in
 * this order (vertex hooks too). Add one line per modifier, tagged `// <STREAM-ID>`; conflicts resolve by union.
 * Contract: ./modifier-types.ts.
 */
import type { TerrainModifier } from './modifier-types';
import { pendingCraterModifier } from './modifiers/pending-crater.wgsl';
import { tracksModifier } from './modifiers/tracks.wgsl';

export type { TerrainModifier } from './modifier-types';

export const TERRAIN_MODIFIERS: TerrainModifier[] = [
  tracksModifier, // W1-ENG-SCENE
  pendingCraterModifier, // W1-ENG-SCENE
  /* append-only */
];
