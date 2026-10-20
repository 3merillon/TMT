import { describe, expect, it } from 'vitest';
import { defenseScanPitch, radarScanAngle } from '../src/game/kit/utility-motion';
import { PERISCOPE_RANGE } from '../src/game/kit/parts/utilities/periscope';

describe('cosmetic utility actuators', () => {
  it('scans continuously at bounded speed inside the validated elevation envelope', () => {
    const dt = 1 / 120;
    for (let tick = 0; tick < 2400; tick++) {
      const t = tick * dt, radarSpeed = (radarScanAngle(t + dt) - radarScanAngle(t)) / dt;
      const pitch = defenseScanPitch(t), pitchSpeed = Math.abs(defenseScanPitch(t + dt) - pitch) / dt;
      expect(radarSpeed).toBeGreaterThan(.8); expect(radarSpeed).toBeLessThan(1);
      expect(pitch).toBeGreaterThanOrEqual(PERISCOPE_RANGE[0]); expect(pitch).toBeLessThanOrEqual(PERISCOPE_RANGE[1]);
      expect(pitchSpeed).toBeLessThan(.24);
    }
    expect(defenseScanPitch(.1)).toBe(defenseScanPitch(.2));
    expect(Math.abs(defenseScanPitch(8.2 - .0001) - defenseScanPitch(8.2 + .0001))).toBeLessThan(1e-8);
  });
});
