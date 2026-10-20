/**
 * Crawler running gear (W1-KIT): the widest belt, eight visually interleaved road wheels per side (two rows,
 * two wheels on each of four rockers carried by torsion arms), a modestly raised drive sprocket and no return
 * rollers. Physics keeps 4 stations per side (the rocker pivots); the interleaving is visual (brief). Its
 * smaller road wheels (r 0.17) sit 2 cm lower so the belt still meets the ground at y = −0.5.
 */
import type { GearSpec } from '../types';

const HL = 0.6, HALF = HL / 3 / 2, ROW = 0.09, R = 0.17;
export const CRAWLER: GearSpec = {
  id: 'crawler', name: 'Crawler tracks',
  halfSpacing: 0.6, width: 0.36, halfLength: HL, wheelRadius: R, wheelY0: -0.5 + R + 0.05,
  // Rear wheel of each rocker on the outer row, front wheel on the inner row.
  wheels: [0, 1, 2, 3].flatMap(station => [
    { station, dz: -HALF, dx: ROW, radius: R, width: 0.14 },
    { station, dz: HALF, dx: -ROW, radius: R, width: 0.14 },
  ]),
  suspension: 'rocker', armLength: 0.25, rockerHalf: HALF,
  sprocket: { z: 0.97, y: -0.07, r: 0.12, width: 0.3, teeth: 12 },
  idler: { z: -0.99, y: -0.17, r: 0.115, width: 0.29 },
  tensioner: { dz: 0.165, dy: 0.05, travel: 0.04 },
  rollers: [],
  linkPitch: 0.072,
  springTop: 0,
  wheelStyle: 'dished',
  stats: { cost: 4, mass: 4.0, speed: 3.1, fuel: 5.5, climbDeg: 45, traction: 1.6, lateralTraction: 1.3 },
  massBoxes: [
    { center: [0.6, -0.3, 0], half: [0.18, 0.2, 1.05], fraction: 0.5 },
    { center: [-0.6, -0.3, 0], half: [0.18, 0.2, 1.05], fraction: 0.5 },
  ],
};
