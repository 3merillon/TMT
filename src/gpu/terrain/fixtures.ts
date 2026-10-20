import type { Bounds } from '../../core/types';
import type { SourceBox, SphereCut } from './contracts';
export type FixtureName = 'two-supports' | 'one-support' | 'three-bricks' | 'arch';
export interface ResidentWorldInput { name: string; bounds: Bounds; sources: SourceBox[]; cuts: SphereCut[]; planetCenter: [number, number, number]; staticSurface?: boolean; localConstruction?: boolean; uniformRegions?: boolean }
export interface StructuralFixture extends ResidentWorldInput { name: FixtureName }
export function structuralFixture(name: FixtureName = 'two-supports'): StructuralFixture {
  const supports = name === 'one-support' ? [-4.5] : [-4.5, 4.5];
  return {
    name, bounds: { min: [-12, 0, -9], max: [12, 9, 9] }, planetCenter: [0, -1000, 0],
    sources: [
      { id: 'foundation', material: 1, anchor: 'fixed-foundation', bounds: { min: [-12, 0, -9], max: [12, .75, 9] } },
      ...supports.map((x, i): SourceBox => ({ id: `pillar-${i}`, material: 2, bounds: { min: [x - .75, .75, -.75], max: [x + .75, 6, .75] } })),
      { id: 'slab', material: 3, bounds: { min: [name === 'three-bricks' ? -10.5 : -8.25, 6, -1.5], max: [name === 'three-bricks' ? 10.5 : 8.25, 7.125, 1.5] } },
    ],
    cuts: supports.map((x, i) => ({ id: `cut-${i}`, center: [x, name === 'arch' ? 2.25 + i * .375 : 3 + i * .375, 0], radius: 2.25 })),
  };
}
