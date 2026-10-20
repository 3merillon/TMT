/**
 * Grip running gear (W1-KIT): two bogies per side (two wheels each) on volute springs, three return rollers
 * under a raised top run, wide rubber-padded links. Stable and sure-footed.
 * Physics stations are kit v1's (halfSpacing 0.55, width 0.31, half length 0.62, r 0.19 at y −0.26).
 */
import type { GearSpec } from '../types';

const HL = 0.62, BOGIE = HL * 2 / 3 / 2;
export const GRIP: GearSpec = {
  id: 'grip', name: 'Grip tracks',
  halfSpacing: 0.55, width: 0.31, halfLength: HL, wheelRadius: 0.19, wheelY0: -0.26,
  wheels: [0, 1, 2, 3].map(station => ({ station, dz: 0, dx: 0, radius: 0.19, width: 0.25 })),
  suspension: 'bogie', armLength: 0, rockerHalf: BOGIE,
  sprocket: { z: 0.92, y: -0.15, r: 0.12, width: 0.26, teeth: 11 },
  idler: { z: -0.938, y: -0.16, r: 0.115, width: 0.25 },
  tensioner: { dz: 0.165, dy: 0.05, travel: 0.04 },
  rollers: [-HL + BOGIE, 0, HL - BOGIE].map(z => ({ z, y: -0.02, r: 0.07, width: 0.2 })),
  linkPitch: 0.07,
  springTop: -0.12,
  wheelStyle: 'disc',
  stats: { cost: 3, mass: 3.0, speed: 3.9, fuel: 6.5, climbDeg: 38, traction: 1.6, lateralTraction: 1.25 },
  massBoxes: [
    { center: [0.55, -0.3, 0], half: [0.155, 0.2, 0.98], fraction: 0.5 },
    { center: [-0.55, -0.3, 0], half: [0.155, 0.2, 0.98], fraction: 0.5 },
  ],
};
