import { describe, expect, it } from 'vitest';
import { sweepTrack, type TrackContact } from '../src/game/presentation/track-stamps';

const contact: TrackContact = { center: [0, 18, 0], forward: [0, 0, 1], halfLength: 0.7, halfWidth: 0.14, load: 1 };
describe('loaded tread footprints', () => {
  it('sweeps sideways with the full belt length and preserves the grouser orientation', () => {
    const first = sweepTrack(contact, null, 0.15);
    const slide = sweepTrack({ ...contact, center: [0.4, 18, 0] }, first.trail, 0.15);
    expect(slide.stamps.length).toBeGreaterThan(4);
    for (const stamp of slide.stamps) {
      expect(stamp.forward).toEqual([0, 0, 1]);
      expect(stamp.halfLength).toBe(0.7);
      expect(stamp.scrub).toBeCloseTo(1);
      expect(stamp.tread).toEqual(first.stamps[0].tread);
    }
  });
  it('anchors tread phase to the ground in forward and reverse motion', () => {
    const first = sweepTrack(contact, null, 0.15);
    const forward = sweepTrack({ ...contact, center: [0, 18, 0.3] }, first.trail, 0.15);
    const reverse = sweepTrack(contact, forward.trail, 0.15);
    expect(forward.trail.ground).toBeCloseTo(0.3);
    expect(reverse.trail.ground).toBeCloseTo(0);
    expect(reverse.stamps.at(-1)!.tread).toEqual(first.stamps[0].tread);
    expect(forward.stamps.at(-1)!.scrub).toBe(0);
  });
  it('keeps parked contact to hold grass down, but never bridges a teleport', () => {
    const first = sweepTrack(contact, null, 0.15);
    expect(sweepTrack(contact, first.trail, 0.15).stamps).toHaveLength(1);
    expect(sweepTrack({ ...contact, center: [4, 18, 0] }, first.trail, 0.15).stamps).toHaveLength(0);
  });
});
