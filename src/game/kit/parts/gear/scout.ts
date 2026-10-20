/**
 * Scout running gear (W1-KIT): big spoked Christie-style road wheels on torsion trailing arms, no return
 * rollers (the top run rests on the wheels), narrow single-pin links. Fast and light.
 * Physics stations are kit v1's (halfSpacing 0.55, width 0.23, half length 0.59, r 0.19 at y −0.26).
 *
 * The visual tyres are r 0.18 on hubs 1 cm lower (hubDrop), so they meet the ground and the belt where the stations
 * do: with r 0.19 on 0.393 station spacing, the trailing arms' fore–aft travel (L(1 − cos θ), 3.4 cm at full droop)
 * put a fully drooped wheel 8 mm into a half-drooped neighbour (fix round 2); r 0.18 leaves ≥ 11 mm over the whole
 * suspension range (tests/kit-interference.test.ts "neighbouring stations").
 */
import type { GearSpec } from '../types';

const HL = 0.59;
export const SCOUT: GearSpec = {
  id: 'scout', name: 'Scout tracks',
  halfSpacing: 0.55, width: 0.23, halfLength: HL, wheelRadius: 0.19, wheelY0: -0.26,
  wheels: [0, 1, 2, 3].map(station => ({ station, dz: 0, dx: 0, radius: 0.18, width: 0.18 })),
  suspension: 'torsion', armLength: 0.23, rockerHalf: 0,
  sprocket: { z: 0.905, y: -0.15, r: 0.12, width: 0.19, teeth: 11 },
  idler: { z: -0.908, y: -0.16, r: 0.115, width: 0.18 },
  tensioner: { dz: 0.165, dy: 0.05, travel: 0.04 },
  rollers: [],
  linkPitch: 0.07,
  springTop: 0,
  wheelStyle: 'spoked',
  stats: { cost: 2, mass: 2.0, speed: 5.0, fuel: 8.0, climbDeg: 32, traction: 1.3, lateralTraction: 1.0 },
  // Wheels, belt and arms per side (hull frame).
  massBoxes: [
    { center: [0.55, -0.3, 0], half: [0.115, 0.2, 0.95], fraction: 0.5 },
    { center: [-0.55, -0.3, 0], half: [0.115, 0.2, 0.95], fraction: 0.5 },
  ],
};
